import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, readdir, rename, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HttpError, MAX_FILE_BYTES, validateName, sha256, fileContent, fileChanged, syncDirectory } from './workspace.mjs';

const storeLocks = new Map();
function exclusive(key, operation) {
  const previous = storeLocks.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(() => {}, () => {});
  storeLocks.set(key, settled);
  settled.then(() => { if (storeLocks.get(key) === settled) storeLocks.delete(key); });
  return result;
}
function runKey(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)) throw new HttpError(400, 'Invalid run id.');
  return sha256(runId);
}
function recoveryKey(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(400, 'Invalid recovery id.');
  return id;
}
function inside(root, candidate) { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function descriptor(entry) {
  const { name, operation, status, sha256: hash, bytes, baseVersion, version, createdAt, updatedAt, acceptedAt, recoveryId, conflict } = entry;
  return { name, operation, status, sha256: hash, bytes, baseVersion, version, createdAt, updatedAt, ...(acceptedAt ? { acceptedAt } : {}), ...(recoveryId ? { recoveryId } : {}), ...(conflict ? { conflict: true } : {}) };
}
function recoveryDescriptor(entry) {
  const { id, name, operation, createdAt, status, bytes, sha256: hash, expectedVersion, runId, restoredAt } = entry;
  return { id, name, operation, createdAt, status, bytes, sha256: hash, expectedVersion, ...(runId ? { runId } : {}), ...(restoredAt ? { restoredAt } : {}) };
}
function previewVersion(runId, name, live, entry) { return `preview:${sha256(JSON.stringify([runId, name, live.version, entry?.version ?? null]))}`; }
function changeType(before, after) { return before === null ? 'added' : after === null ? 'deleted' : 'modified'; }

// All persistent content is private to control. Filenames are generated hashes/UUIDs;
// user names only occur in validated metadata, never in a private filesystem path.
export async function createArtifactStore({ workspace, dataDir }) {
  if (!workspace?.snapshot || !workspace?.compareAndSwap) throw new TypeError('Artifact store requires a versioned workspace.');
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('Artifact store requires a private data directory.');
  const requested = path.resolve(dataDir);
  if (inside(workspace.root, requested)) throw new Error('Artifact data directory must be outside the workspace.');
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const dataStat = await lstat(requested);
  if (!dataStat.isDirectory() || dataStat.isSymbolicLink()) throw new Error('Artifact data directory must be a real directory.');
  const privateData = await realpath(requested);
  if (inside(workspace.root, privateData)) throw new Error('Artifact data directory must be outside the workspace.');
  const root = path.join(privateData, 'artifacts');
  const runsDir = path.join(root, 'runs'); const blobsDir = path.join(root, 'blobs'); const recoveryDir = path.join(root, 'recovery');
  const identities = new Map();
  for (const directory of [root, runsDir, blobsDir, recoveryDir]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const st = await lstat(directory);
    if (!st.isDirectory() || st.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Artifact directories must be real private directories.');
    identities.set(directory, `${st.dev}:${st.ino}`);
  }
  const lockKey = process.platform === 'win32' ? root.toLowerCase() : root;
  const locked = operation => exclusive(lockKey, operation);
  async function assertDirectory(directory) {
    for (const dir of [root, directory]) {
      const st = await lstat(dir);
      if (!st.isDirectory() || st.isSymbolicLink() || `${st.dev}:${st.ino}` !== identities.get(dir) || await realpath(dir) !== dir) throw new HttpError(409, 'Artifact directory changed.');
    }
  }
  async function readPrivate(filename, max = MAX_FILE_BYTES) {
    let handle;
    try {
      await assertDirectory(path.dirname(filename));
      const before = await lstat(filename, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(max)) throw new HttpError(500, 'Invalid artifact data.');
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat({ bigint: true });
      const signature = st => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
      if (signature(opened) !== signature(before)) throw new HttpError(409, 'Artifact data changed.');
      const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
      while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) throw new HttpError(409, 'Artifact data changed.'); offset += bytesRead; }
      const after = await handle.stat({ bigint: true }); const atPath = await lstat(filename, { bigint: true });
      if (signature(after) !== signature(opened) || signature(atPath) !== signature(opened) || atPath.isSymbolicLink()) throw new HttpError(409, 'Artifact data changed.');
      return bytes;
    } catch (error) { if (error.code === 'ENOENT' && !handle) return null; if (['ELOOP', 'EISDIR', 'ENXIO'].includes(error.code)) throw new HttpError(500, 'Invalid artifact data.'); throw error; }
    finally { await handle?.close(); }
  }
  async function atomicPrivate(filename, bytes, { assertActive = () => {}, noClobber = false } = {}) {
    const directory = path.dirname(filename); await assertDirectory(directory);
    const temporary = path.join(directory, `.pending-${randomUUID()}`);
    let exists = false;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); exists = true;
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await assertActive(); await assertDirectory(directory);
      if (noClobber) { try { await link(temporary, filename); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
      else await rename(temporary, filename);
      if (noClobber) await unlink(temporary);
      exists = false; await syncDirectory(directory);
    } finally { if (exists) await unlink(temporary).catch(() => {}); }
  }
  async function putBlob(content) {
    if (content === null) return null;
    const hash = sha256(content); const filename = path.join(blobsDir, hash);
    await atomicPrivate(filename, content, { noClobber: true });
    const saved = await readPrivate(filename);
    if (!saved || sha256(saved) !== hash) throw new HttpError(500, 'Artifact checksum mismatch.');
    return hash;
  }
  async function blob(hash) {
    if (hash === null) return null;
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new HttpError(500, 'Invalid artifact checksum.');
    const content = await readPrivate(path.join(blobsDir, hash));
    if (content === null || sha256(content) !== hash) throw new HttpError(500, 'Artifact checksum mismatch.');
    return content;
  }
  async function readJson(filename) {
    const bytes = await readPrivate(filename, 2 * 1024 * 1024);
    if (bytes === null) return null;
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw new HttpError(500, 'Invalid artifact journal.'); }
  }
  const saveJson = (filename, value, options) => atomicPrivate(filename, Buffer.from(JSON.stringify(value)), options);
  async function manifest(runId) {
    const value = await readJson(path.join(runsDir, `${runKey(runId)}.json`));
    if (value === null) return { format: 1, runId, files: {} };
    if (value.format !== 1 || value.runId !== runId || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw new HttpError(500, 'Invalid artifact journal.');
    for (const [name, entry] of Object.entries(value.files)) {
      if (validateName(name) !== entry?.name || !['added', 'modified', 'deleted'].includes(entry.operation) || !['staged', 'accepted'].includes(entry.status) || typeof entry.baseVersion !== 'string' || typeof entry.version !== 'string'
          || (entry.sha256 !== null && !/^[a-f0-9]{64}$/.test(entry.sha256)) || (entry.baseSha256 !== null && !/^[a-f0-9]{64}$/.test(entry.baseSha256)) || !Number.isInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES) throw new HttpError(500, 'Invalid artifact journal.');
    }
    return value;
  }
  const saveManifest = (value, options) => saveJson(path.join(runsDir, `${runKey(value.runId)}.json`), value, options);
  function findEntry(value, name) { const entry = Object.hasOwn(value.files, validateName(name)) ? value.files[name] : null; if (!entry) throw new HttpError(404, 'Artifact not found.'); return entry; }
  async function version(runId, name) { return locked(async () => { const value = await manifest(runId); const live = await workspace.snapshot(name); return previewVersion(runId, name, live, Object.hasOwn(value.files, name) ? value.files[name] : null); }); }
  async function stage(runId, name, content, { expectedVersion, assertActive = () => {} } = {}) {
    validateName(name); runKey(runId); const bytes = content === null ? null : fileContent(content);
    if (typeof expectedVersion !== 'string') throw new HttpError(428, 'An approved file version is required.');
    return locked(async () => {
      await assertActive(); const value = await manifest(runId); const live = await workspace.snapshot(name);
      const previous = Object.hasOwn(value.files, name) ? value.files[name] : null;
      if (previewVersion(runId, name, live, previous) !== expectedVersion) throw fileChanged();
      if (!previous && live.content === null && bytes === null) throw new HttpError(404, 'File not found.');
      const reuse = previous?.status === 'staged';
      const baseSha256 = reuse ? previous.baseSha256 : await putBlob(live.content);
      const hash = await putBlob(bytes); const now = new Date().toISOString();
      const entry = { name, operation: changeType(baseSha256, hash), status: 'staged', sha256: hash, baseSha256, bytes: bytes?.length ?? 0, baseVersion: reuse ? previous.baseVersion : live.version, version: `artifact:${randomUUID()}`, createdAt: reuse ? previous.createdAt : now, updatedAt: now };
      await assertActive();
      if (previewVersion(runId, name, await workspace.snapshot(name), previous) !== expectedVersion) throw fileChanged();
      value.files[name] = entry;
      await saveManifest(value, { assertActive });
      return descriptor(entry);
    });
  }
  async function list(runId) { return locked(async () => Object.values((await manifest(runId)).files).map(descriptor).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); }
  async function download(runId, name) { return locked(async () => { const entry = findEntry(await manifest(runId), name); if (entry.sha256 === null) throw new HttpError(404, 'Artifact is a deletion.'); return blob(entry.sha256); }); }
  async function listWorkspace(runId) {
    return locked(async () => {
      const value = await manifest(runId); const files = new Map((await workspace.list()).map(file => [file.name, file]));
      for (const entry of Object.values(value.files)) {
        if (entry.status !== 'staged') continue;
        if (entry.sha256 === null) files.delete(entry.name);
        else files.set(entry.name, { name: entry.name, size: entry.bytes, sha256: entry.sha256, modifiedAt: entry.updatedAt, version: entry.version, staged: true });
      }
      return [...files.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });
  }
  async function readWorkspace(runId, name) {
    return locked(async () => {
      const value = await manifest(runId); const entry = Object.hasOwn(value.files, validateName(name)) ? value.files[name] : null;
      if (entry?.status === 'staged') { if (entry.sha256 === null) throw new HttpError(404, 'File not found.'); return blob(entry.sha256); }
      return workspace.download(name);
    });
  }
  async function diff(runId, name) {
    return locked(async () => {
      const entry = findEntry(await manifest(runId), name); const before = await blob(entry.baseSha256); const after = await blob(entry.sha256);
      const result = textDiff(name, before, after);
      return { name, operation: entry.operation, beforeSha256: entry.baseSha256, afterSha256: entry.sha256, ...result };
    });
  }
  async function recovery(id) {
    const value = await readJson(path.join(recoveryDir, `${recoveryKey(id)}.json`));
    if (value === null) throw new HttpError(404, 'Recovery point not found.');
    if (value.id !== id || validateName(value.name) !== value.name || !['pending', 'available', 'restored', 'conflict'].includes(value.status) || (value.sha256 !== null && !/^[a-f0-9]{64}$/.test(value.sha256)) || (value.expectedVersion !== null && typeof value.expectedVersion !== 'string')) throw new HttpError(500, 'Invalid recovery journal.');
    return value;
  }
  const saveRecovery = value => saveJson(path.join(recoveryDir, `${recoveryKey(value.id)}.json`), value);
  async function newRecovery(before, { runId, operation, status = 'pending', expectedVersion = null } = {}) {
    const hash = await putBlob(before.content);
    const value = { id: randomUUID(), name: before.name, operation, createdAt: new Date().toISOString(), status, bytes: before.bytes, sha256: hash, expectedVersion, originalVersion: before.version, ...(runId ? { runId } : {}) };
    await saveRecovery(value); return value;
  }
  async function apply(name, content, { expectedVersion, assertActive = () => {}, runId, operation } = {}) {
    let point;
    try {
      const applied = await workspace.compareAndSwap(name, content, {
        expectedVersion, assertActive,
        beforeChange: async before => { point = await newRecovery(before, { runId, operation }); },
        onDisplaced: async (before, { expectedVersion: displacedVersion } = {}) => {
          await newRecovery(before, { runId, operation: 'concurrent-change', status: displacedVersion ? 'available' : 'conflict', expectedVersion: displacedVersion ?? null });
        },
      });
      point.status = 'available'; point.expectedVersion = applied.version; await saveRecovery(point);
      return { applied, point };
    } catch (error) {
      if (point) { point.status = 'conflict'; await saveRecovery(point); }
      throw error;
    }
  }
  async function accept(runId, name, { expectedVersion, assertActive = () => {} } = {}) {
    return locked(async () => {
      await assertActive(); const value = await manifest(runId); const entry = findEntry(value, name);
      if (expectedVersion !== undefined && expectedVersion !== entry.version) throw fileChanged('Artifact changed since it was reviewed.');
      if (entry.status === 'accepted') return descriptor(entry);
      try {
        const { point } = await apply(name, await blob(entry.sha256), { expectedVersion: entry.baseVersion, assertActive, runId, operation: 'accept' });
        entry.status = 'accepted'; entry.acceptedAt = new Date().toISOString(); entry.updatedAt = entry.acceptedAt; entry.recoveryId = point.id;
        await saveManifest(value); return descriptor(entry);
      } catch (error) { if (error.code === 'file_changed') { entry.conflict = true; await saveManifest(value); } throw error; }
    });
  }
  async function ownerWrite(name, content, { expectedVersion, assertActive = () => {} } = {}) {
    const bytes = fileContent(content);
    return locked(async () => {
      const { applied, point } = await apply(validateName(name), bytes, { expectedVersion, assertActive, operation: 'owner-write' });
      return { name, bytes: applied.bytes, sha256: applied.sha256, version: applied.version, recoveryId: point.id };
    });
  }
  async function listRecovery() {
    return locked(async () => {
      await assertDirectory(recoveryDir); const points = [];
      for (const filename of await readdir(recoveryDir)) if (/^[a-f0-9-]{36}\.json$/.test(filename)) points.push(recoveryDescriptor(await recovery(filename.slice(0, -5))));
      return points.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    });
  }
  async function restore(id, { assertActive = () => {} } = {}) {
    return locked(async () => {
      await assertActive(); const point = await recovery(id);
      if (point.status !== 'available' || typeof point.expectedVersion !== 'string') throw fileChanged('This recovery point cannot be applied automatically.');
      const { point: undo } = await apply(point.name, await blob(point.sha256), { expectedVersion: point.expectedVersion, assertActive, operation: 'restore' });
      point.status = 'restored'; point.restoredAt = new Date().toISOString(); await saveRecovery(point);
      return { recoveryId: id, name: point.name, restored: true, undoRecoveryId: undo.id };
    });
  }
  return { version, stage, list, diff, download, accept, listWorkspace, readWorkspace, ownerWrite, listRecovery, restore };
}

// A bounded whole-region unified diff: deterministic, linear memory and no LCS
// quadratic blow-up. Unchanged prefix/suffix are elided with three context lines.
function textDiff(name, before, after) {
  const decode = bytes => {
    if (bytes === null) return '';
    if (bytes.includes(0)) return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  };
  const oldText = decode(before); const newText = decode(after);
  if (before !== null && after !== null && before.equals(after)) return { binary: oldText === null, truncated: false, text: '' };
  if (oldText === null || newText === null) return { binary: true, truncated: false, text: 'Binary files differ. Download the staged file to inspect it.' };
  const limit = 64 * 1024; const marker = '\n[Diff truncated at 64 KiB.]\n';
  const lines = text => {
    if (!text) return [];
    const parts = text.split('\n');
    const last = parts.pop(); const result = parts.map(line => line + '\n');
    if (last) result.push(last);
    return result;
  };
  const oldLines = lines(oldText); const newLines = lines(newText);
  if (oldText === newText) return { binary: false, truncated: false, text: '' };
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
  const start = Math.max(0, prefix - 3); const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3); const newEnd = Math.min(newLines.length, newLines.length - suffix + 3);
  const oldCount = oldEnd - start; const newCount = newEnd - start;
  let text = `--- ${before === null ? '/dev/null' : `a/${name}`}\n+++ ${after === null ? '/dev/null' : `b/${name}`}\n@@ -${oldCount ? start + 1 : 0},${oldCount} +${newCount ? start + 1 : 0},${newCount} @@\n`;
  let truncated = false; let usedBytes = Buffer.byteLength(text);
  function append(mark, line) {
    const next = `${mark}${line}${line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n'}`;
    const nextBytes = Buffer.from(next);
    const remaining = limit - Buffer.byteLength(marker) - usedBytes;
    if (nextBytes.length > remaining) {
      // stream:true omits a split final UTF-8 code point instead of emitting U+FFFD.
      text += new TextDecoder().decode(nextBytes.subarray(0, Math.max(0, remaining)), { stream: true });
      truncated = true; return false;
    }
    text += next; usedBytes += nextBytes.length; return true;
  }
  for (let i = start; i < prefix; i++) if (!append(' ', oldLines[i])) break;
  if (!truncated) for (let i = prefix; i < oldLines.length - suffix; i++) if (!append('-', oldLines[i])) break;
  if (!truncated) for (let i = prefix; i < newLines.length - suffix; i++) if (!append('+', newLines[i])) break;
  if (!truncated) for (let i = oldLines.length - suffix; i < oldEnd; i++) if (!append(' ', oldLines[i])) break;
  if (truncated) text += marker;
  return { binary: false, truncated, text };
}
