import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, rename, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HttpError, syncDirectory } from './workspace.mjs';

const MAX_TEMPLATES = 100;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const locks = new Map();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = stat => `${stat.dev}:${stat.ino}`;
const signature = stat => `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
const changed = () => new HttpError(409, 'Owner operations storage changed.');
const invalidStore = () => new HttpError(500, 'Invalid owner template storage.');

function exclusive(key, operation) {
  const previous = locks.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(() => {}, () => {});
  locks.set(key, settled);
  settled.then(() => { if (locks.get(key) === settled) locks.delete(key); });
  return result;
}
function templateName(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Provide a template name of 1 to 80 characters.');
  const name = value.trim();
  if (!name || name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new HttpError(400, 'Provide a plain template name of 1 to 80 characters.');
  return name;
}
function goalText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000 || Buffer.byteLength(value) > 16000) {
    throw new HttpError(400, 'Provide a non-empty work goal of at most 4000 characters.');
  }
  return value.trim();
}
const templateView = ({ id, name, goal, createdAt }) => ({ id, name, goal, createdAt });
function decodeTemplates(bytes) {
  if (bytes === null) return [];
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(value) || Object.keys(value).length !== 2 || value.format !== 1 || !Array.isArray(value.templates) || value.templates.length > MAX_TEMPLATES) throw invalidStore();
    const ids = new Set(); const names = new Set();
    for (const entry of value.templates) {
      if (!object(entry) || Object.keys(entry).length !== 4 || typeof entry.id !== 'string' || !UUID.test(entry.id)
          || templateName(entry.name) !== entry.name || goalText(entry.goal) !== entry.goal || typeof entry.createdAt !== 'string'
          || new Date(entry.createdAt).toISOString() !== entry.createdAt || ids.has(entry.id) || names.has(entry.name.toLowerCase())) throw invalidStore();
      ids.add(entry.id); names.add(entry.name.toLowerCase());
    }
    return value.templates.map(templateView);
  } catch { throw invalidStore(); }
}

/** Goal-only templates and an owner inbox; no execution or authorization is retained. */
export async function createOwnerOperations({ dataDir } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new TypeError('Owner operations require a private data directory.');
  const requested = path.resolve(dataDir);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const initial = await lstat(requested, { bigint: true });
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error('Owner data directory must be a real directory.');
  const privateData = await realpath(requested);
  const root = path.join(privateData, 'owner-operations');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const identities = new Map([[privateData, identity(initial)]]);
  const rootStat = await lstat(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) throw new Error('Owner operations directory must be a real directory.');
  identities.set(root, identity(rootStat));
  const filename = path.join(root, 'templates.json');
  const lockKey = process.platform === 'win32' ? root.toLowerCase() : root;
  const locked = operation => exclusive(lockKey, operation);

  async function assertDirectories() {
    try {
      for (const directory of [privateData, root]) {
        const stat = await lstat(directory, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== identities.get(directory) || await realpath(directory) !== directory) throw changed();
      }
    } catch (error) { if (error instanceof HttpError) throw error; throw changed(); }
  }
  function assertFile(stat) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(MAX_STORE_BYTES)) throw invalidStore();
  }
  async function snapshot() {
    await assertDirectories();
    let handle;
    try {
      const before = await lstat(filename, { bigint: true }); assertFile(before);
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat({ bigint: true }); assertFile(opened);
      if (signature(before) !== signature(opened)) throw changed();
      const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw changed();
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true }); const atPath = await lstat(filename, { bigint: true });
      assertFile(after); assertFile(atPath); await assertDirectories();
      if (signature(opened) !== signature(after) || signature(opened) !== signature(atPath)) throw changed();
      return { bytes, signature: signature(after) };
    } catch (error) {
      if (error.code === 'ENOENT') {
        await assertDirectories();
        if (!handle) return { bytes: null, signature: null };
        throw changed();
      }
      if (['ELOOP', 'EISDIR', 'ENXIO', 'ENOTDIR'].includes(error.code)) throw invalidStore();
      throw error;
    } finally { await handle?.close(); }
  }
  async function readTemplates() {
    const saved = await snapshot();
    return { templates: decodeTemplates(saved.bytes), signature: saved.signature };
  }
  async function persist(templates, expectedSignature) {
    const bytes = Buffer.from(JSON.stringify({ format: 1, templates: templates.map(templateView) }) + '\n');
    if (bytes.length > MAX_STORE_BYTES) throw new HttpError(413, 'Template storage exceeds its size limit.');
    await assertDirectories();
    const temporary = path.join(root, `.pending-${randomUUID()}`);
    let pending = false;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      pending = true; let prepared;
      try { await handle.writeFile(bytes); await handle.sync(); prepared = await handle.stat({ bigint: true }); } finally { await handle.close(); }
      const current = await snapshot();
      if (current.signature !== expectedSignature) throw changed();
      const atTemporary = await lstat(temporary, { bigint: true }); assertFile(atTemporary);
      if (signature(prepared) !== signature(atTemporary)) throw changed();
      await assertDirectories();
      if (expectedSignature === null) {
        try { await link(temporary, filename); } catch (error) { if (error.code === 'EEXIST') throw changed(); throw error; }
        await unlink(temporary);
      } else await rename(temporary, filename);
      pending = false;
      await syncDirectory(root);
    } finally {
      if (pending) {
        // Never follow a replaced parent directory while cleaning our own temporary.
        await assertDirectories();
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
  }
  await locked(readTemplates);

  async function listTemplates() { return locked(async () => (await readTemplates()).templates.map(templateView)); }
  async function saveTemplate({ name, work } = {}) {
    const cleanName = templateName(name);
    if (!object(work) || !safeId(work.id)) throw new HttpError(400, 'A public work record is required.');
    if (work.status !== 'succeeded') throw new HttpError(409, 'Only succeeded work can be saved as a template.');
    const goal = goalText(work.goal);
    return locked(async () => {
      const saved = await readTemplates();
      if (saved.templates.some(entry => entry.name.toLowerCase() === cleanName.toLowerCase())) throw new HttpError(409, 'A template with that name already exists.');
      if (saved.templates.length >= MAX_TEMPLATES) throw new HttpError(409, 'The limit of 100 templates has been reached.');
      const entry = { id: randomUUID(), name: cleanName, goal, createdAt: new Date().toISOString() };
      await persist([...saved.templates, entry], saved.signature);
      return templateView(entry);
    });
  }
  async function deleteTemplate(id) {
    if (typeof id !== 'string' || !id || id.length > 128) throw new HttpError(400, 'A template id is required.');
    return locked(async () => {
      const saved = await readTemplates();
      if (!saved.templates.some(entry => entry.id === id)) throw new HttpError(404, 'Template not found.');
      await persist(saved.templates.filter(entry => entry.id !== id), saved.signature);
      return { id, deleted: true };
    });
  }
  return { listTemplates, saveTemplate, deleteTemplate, inbox };
}

const active = status => ['running', 'awaiting_approval', 'finishing'].includes(status);
const needsHandoff = status => ['paused', 'login_required', 'manual_required'].includes(status);
const failed = status => ['failed', 'interrupted'].includes(status);
const handoffDetails = new Map(Object.entries({
  owner_requested: 'Review the paused work before delegating it again.',
  human_action_required: 'Complete the required login or manual step, then review the work before delegating it again.',
  account_selection: 'Choose the required account, then review the work before delegating it again.',
  external_result_confirmation: 'Confirm the previous external action outcome before delegating the work again.',
  input_lease_lost: 'Review the interrupted control session before delegating the work again.',
}));
function reference(work, run) {
  const workId = safeId(work?.id) ?? safeId(run?.workId);
  const runId = safeId(work?.latestRunId) ?? safeId(work?.currentRunId) ?? (workId === safeId(run?.workId) ? safeId(run?.id) : undefined);
  return { ...(runId ? { runId } : {}), ...(workId ? { workId } : {}) };
}
function recoveryCount(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  return Array.isArray(value) ? value.filter(point => object(point) && ['pending', 'available', 'conflict'].includes(point.status)).length : 0;
}

// Summaries are selected from fixed text. No goals, previews, errors, filenames,
// login details, tool arguments or transcript content enter this response.
async function inbox({ status = {}, works = [], artifacts = [], recovery = 0, backup } = {}) {
  const state = object(status) ? status : {};
  const run = object(state.run) ? state.run : {};
  const runId = safeId(run.id);
  const workId = safeId(run.workId);
  const records = new Map();
  for (const work of Array.isArray(works) ? works : []) if (object(work) && safeId(work.id)) records.set(work.id, work);
  if (object(state.work) && safeId(state.work.id) && !records.has(state.work.id)) records.set(state.work.id, state.work);
  const items = []; const seen = new Set();
  function add(kind, key, title, refs, detail, count) {
    const id = `${kind}:${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    items.push({ id, kind, title, ...refs, ...(Number.isSafeInteger(count) && count > 0 ? { count } : {}), ...(detail ? { detail } : {}) });
  }
  const approval = run.approval;
  if (runId && run.status === 'awaiting_approval' && object(approval) && safeId(approval.id) && approval.settled !== true
      && (approval.runId === undefined || approval.runId === runId)
      && (approval.expiresAt === undefined || (typeof approval.expiresAt === 'string' && Date.parse(approval.expiresAt) > Date.now()))) {
    add('approval', `${runId}:${approval.id}`, 'An action needs approval', { runId, ...(workId ? { workId } : {}) }, 'Review the current action and its scope before approving it.');
  }
  for (const work of records.values()) {
    const refs = reference(work, run);
    if (needsHandoff(work.status)) add('handoff', work.id, 'Work needs your attention', refs,
      handoffDetails.get(work.handoff?.reason) ?? 'Review the paused work and any required manual steps before delegating it again.');
    const attempts = Array.isArray(work.attempts) ? work.attempts : [];
    const unsettled = attempts.filter(attempt => object(attempt) && attempt.usageUnknown === true && !attempt.reconciliation);
    const usageUnknown = typeof work.budget?.usageUnknown === 'boolean' ? work.budget.usageUnknown : unsettled.length > 0;
    if (usageUnknown) add('usage', work.id, 'Work usage needs reconciliation', { ...refs, ...(safeId(unsettled.at(-1)?.id) ? { runId: unsettled.at(-1).id } : {}) },
      'Verify and reconcile unreported usage before delegating this work again.', unsettled.length || 1);
    if (failed(work.status)) add('failure', work.id, work.status === 'interrupted' ? 'Interrupted work needs review' : 'Failed work needs review', refs,
      'Review the saved work and confirm control is safe before starting another attempt.');
  }
  const currentWork = records.get(workId);
  const refs = { ...(runId ? { runId } : {}), ...(workId ? { workId } : {}) };
  if (runId && needsHandoff(run.status) && !currentWork) add('handoff', workId ?? runId, 'Work needs your attention', refs,
    handoffDetails.get(run.handoff?.reason) ?? 'Review the paused work and any required manual steps before delegating it again.');
  if (runId && run.usage?.unknown === true && (!currentWork || currentWork.budget?.usageUnknown !== false)) {
    add('usage', workId ?? runId, 'Work usage needs reconciliation', refs, 'Verify and reconcile unreported usage before delegating this work again.', 1);
  }
  if (runId && failed(run.status) && !currentWork) add('failure', workId ?? runId, run.status === 'interrupted' ? 'Interrupted work needs review' : 'Failed work needs review', refs,
    'Review the saved work and confirm control is safe before starting another attempt.');
  const staged = Array.isArray(artifacts) ? artifacts.filter(entry => object(entry) && entry.status === 'staged').length : 0;
  if (staged) add('artifacts', runId ?? 'current', 'Draft files need review', refs,
    active(run.status) ? 'Draft files are staged. Wait for this attempt to settle before accepting them.' : 'Review the staged file changes before accepting them.', staged);
  const hasData = records.size > 0 || Boolean(runId) || (Array.isArray(state.files) && state.files.length > 0) || staged > 0 || recoveryCount(recovery) > 0;
  const safeToBackup = state.canStart === true && state.control?.owner === 'human' && state.control?.stop?.confirmed === true && !active(run.status);
  const verifiedBackup = object(backup) && backup.verified === true && backup.stale !== true && !['missing', 'failed'].includes(backup.status);
  if (hasData && safeToBackup && !verifiedBackup) add('backup', 'missing', 'Verify an independent backup', {},
    'No verified independent backup is recorded. Keep a verified copy outside this computer; local recovery points do not replace it.');
  return items;
}
