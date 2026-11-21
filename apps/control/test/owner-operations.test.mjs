import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, rename, symlink, link, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOwnerOperations } from '../src/owner-operations.mjs';
import { createWork, recordAttempt, viewWork } from '../src/works.mjs';

const succeeded = (id = 'work-1', goal = 'Write a weekly report') => ({ id, goal, status: 'succeeded', currentRunId: 'run-1' });
const idle = (extra = {}) => ({ canStart: true, control: { owner: 'human', stop: { confirmed: true } }, files: [], ...extra });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owner-operations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'private');
  const owner = await createOwnerOperations({ dataDir });
  return { root, dataDir, owner, storeDir: path.join(dataDir, 'owner-operations'), filename: path.join(dataDir, 'owner-operations', 'templates.json') };
}

async function createLink(t, target, destination, directory = false) {
  try { await symlink(target, destination, directory && process.platform === 'win32' ? 'junction' : directory ? 'dir' : 'file'); return true; }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('File symlinks are unavailable without Windows developer mode; hard-link and directory-junction checks still run.'); return false; }
    throw error;
  }
}

test('templates persist only goal metadata and survive independent instances and deletion', async t => {
  const { owner, dataDir, filename, storeDir } = await fixture(t);
  assert.deepEqual(await owner.listTemplates(), []);
  const entry = await owner.saveTemplate({ name: '  Weekly report  ', work: { ...succeeded(), goal: '  Write a weekly report  ', approvals: ['secret approval'], token: 'secret credential', steps: [{ content: 'secret transcript' }], budget: { maxTokens: 999 } } });
  assert.deepEqual(Object.keys(entry), ['id', 'name', 'goal', 'createdAt']);
  assert.match(entry.id, /^[a-f0-9-]{36}$/);
  assert.equal(entry.name, 'Weekly report'); assert.equal(entry.goal, 'Write a weekly report');
  assert.equal(new Date(entry.createdAt).toISOString(), entry.createdAt);
  const persisted = await readFile(filename, 'utf8');
  assert.doesNotMatch(persisted, /secret|currentRunId|maxTokens|work-1|run-1/);
  assert.deepEqual(JSON.parse(persisted), { format: 1, templates: [entry] });
  assert.deepEqual(await readdir(storeDir), ['templates.json']);
  if (process.platform !== 'win32') assert.equal((await lstat(filename)).mode & 0o777, 0o600);
  const restarted = await createOwnerOperations({ dataDir });
  assert.deepEqual(await restarted.listTemplates(), [entry]);
  entry.name = 'mutated';
  const listed = await owner.listTemplates(); listed[0].goal = 'mutated';
  assert.equal((await restarted.listTemplates())[0].name, 'Weekly report');
  assert.equal((await restarted.listTemplates())[0].goal, 'Write a weekly report');
  assert.deepEqual(await restarted.deleteTemplate(entry.id), { id: entry.id, deleted: true });
  assert.deepEqual(await owner.listTemplates(), []);
  await assert.rejects(owner.deleteTemplate(entry.id), { status: 404 });
});

test('template names, successful public work and goal size are validated before saving', async t => {
  const { owner } = await fixture(t);
  for (const name of ['', ' ', 'a'.repeat(81), 'bad\nname', 'bad\u0000name', null]) {
    await assert.rejects(owner.saveTemplate({ name, work: succeeded() }), { status: 400 });
  }
  for (const status of ['running', 'awaiting_approval', 'finishing', 'paused', 'failed', 'interrupted', 'cancelled']) {
    await assert.rejects(owner.saveTemplate({ name: 'Report', work: { ...succeeded(), status } }), { status: 409 });
  }
  for (const goal of ['', '   ', 'a'.repeat(4001), null]) await assert.rejects(owner.saveTemplate({ name: 'Report', work: succeeded('work-1', goal) }), { status: 400 });
  for (const work of [null, [], {}, { ...succeeded(), id: '../private' }]) await assert.rejects(owner.saveTemplate({ name: 'Report', work }), { status: 400 });
  await owner.saveTemplate({ name: 'a'.repeat(80), work: succeeded('work-1', '文'.repeat(4000)) });
  await owner.saveTemplate({ name: 'Weekly', work: succeeded() });
  await assert.rejects(owner.saveTemplate({ name: '  wEEKLY  ', work: succeeded() }), { status: 409 });
  assert.equal((await owner.listTemplates()).length, 2);
});

test('concurrent service instances serialize read-modify-write, duplicate names and the 100-template cap', async t => {
  const { owner, dataDir, storeDir } = await fixture(t);
  const other = await createOwnerOperations({ dataDir });
  const duplicates = await Promise.allSettled([owner.saveTemplate({ name: 'Same', work: succeeded() }), other.saveTemplate({ name: 'same', work: succeeded() })]);
  assert.equal(duplicates.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(duplicates.find(result => result.status === 'rejected').reason.status, 409);
  await Promise.all(Array.from({ length: 99 }, (_, index) => (index % 2 ? owner : other).saveTemplate({ name: `Template ${index}`, work: succeeded(`work-${index}`) })));
  assert.equal((await owner.listTemplates()).length, 100);
  await assert.rejects(other.saveTemplate({ name: 'Too many', work: succeeded() }), { status: 409 });
  assert.deepEqual(await readdir(storeDir), ['templates.json']);
  const first = (await owner.listTemplates())[0]; await other.deleteTemplate(first.id);
  await owner.saveTemplate({ name: 'Room again', work: succeeded() });
  assert.equal((await other.listTemplates()).length, 100);
});

test('deletion never derives a filesystem path from an id', async t => {
  const { root, owner, filename } = await fixture(t);
  const outside = path.join(root, 'outside.json'); await writeFile(outside, 'private outside data');
  await owner.saveTemplate({ name: '../name is metadata', work: succeeded() });
  const before = await readFile(filename, 'utf8');
  for (const id of ['missing', '../outside.json', '..\\outside.json', outside]) await assert.rejects(owner.deleteTemplate(id), { status: 404 });
  for (const id of [null, '', {}, 'x'.repeat(129)]) await assert.rejects(owner.deleteTemplate(id), { status: 400 });
  assert.equal(await readFile(outside, 'utf8'), 'private outside data');
  assert.equal(await readFile(filename, 'utf8'), before);
});

test('invalid, oversized and unexpected persistent JSON fails closed without overwriting it', async t => {
  const { owner, dataDir, filename } = await fixture(t);
  const entry = await owner.saveTemplate({ name: 'Weekly', work: succeeded() });
  const valid = { format: 1, templates: [entry] };
  const invalid = [
    '{', Buffer.from([0xff]), JSON.stringify(null), JSON.stringify([]), JSON.stringify({ ...valid, extra: true }),
    JSON.stringify({ format: 2, templates: [] }), JSON.stringify({ format: 1, templates: [{ ...entry, token: 'secret' }] }),
    JSON.stringify({ format: 1, templates: [entry, { ...entry, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'weekly' }] }),
    JSON.stringify({ format: 1, templates: [{ ...entry, createdAt: 'not a date' }] }),
    JSON.stringify({ format: 1, templates: Array.from({ length: 101 }, () => entry) }), Buffer.alloc(2 * 1024 * 1024 + 1, 32),
  ];
  for (const bytes of invalid) {
    await writeFile(filename, bytes);
    await assert.rejects(owner.listTemplates(), { status: 500 });
    await assert.rejects(owner.saveTemplate({ name: 'Do not overwrite', work: succeeded() }), { status: 500 });
    await assert.rejects(owner.deleteTemplate(entry.id), { status: 500 });
    await assert.rejects(createOwnerOperations({ dataDir }), { status: 500 });
    assert.deepEqual(await readFile(filename), Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  }
});

test('hard links, symlinks, special destinations and replaced private directories are rejected', async t => {
  const { root, owner, dataDir, storeDir, filename } = await fixture(t);
  const outside = path.join(root, 'outside.json'); await writeFile(outside, '{"private":"do not read"}');
  await link(outside, filename);
  await assert.rejects(owner.listTemplates(), { status: 500 });
  await assert.rejects(owner.saveTemplate({ name: 'Report', work: succeeded() }), { status: 500 });
  await rm(filename);
  if (await createLink(t, outside, filename)) {
    await assert.rejects(owner.listTemplates(), { status: 500 });
    await assert.rejects(owner.saveTemplate({ name: 'Report', work: succeeded() }), { status: 500 });
    await rm(filename);
  }
  await mkdir(filename);
  await assert.rejects(owner.listTemplates(), { status: 500 });
  await rm(filename, { recursive: true });
  await rename(storeDir, path.join(dataDir, 'old-owner-operations'));
  await mkdir(storeDir);
  await assert.rejects(owner.listTemplates(), { status: 409 });
  await assert.rejects(owner.saveTemplate({ name: 'Report', work: succeeded() }), { status: 409 });
  const linkedData = path.join(root, 'linked-data');
  if (await createLink(t, dataDir, linkedData, true)) await assert.rejects(createOwnerOperations({ dataDir: linkedData }), /real directory/);
  const realData = path.join(root, 'real-data'); await mkdir(realData);
  if (await createLink(t, path.join(dataDir, 'old-owner-operations'), path.join(realData, 'owner-operations'), true)) {
    await assert.rejects(createOwnerOperations({ dataDir: realData }), /real directory/);
  }
  assert.equal(await readFile(outside, 'utf8'), '{"private":"do not read"}');
});

test('inbox derives all six kinds from public work/run flags without retaining private content', async t => {
  const { owner } = await fixture(t);
  const secret = 'RAW_SECRET <script> credential transcript filename.txt';
  const works = [
    { id: 'paused-work', latestRunId: 'paused-run', goal: secret, status: 'paused', handoff: { reason: 'human_action_required', goal: secret, completed: [{ title: secret }] } },
    { id: 'unknown-work', latestRunId: 'unknown-run', status: 'interrupted', goal: secret, error: secret, budget: { usageUnknown: true }, attempts: [{ id: 'unknown-run', usageUnknown: true, totalTokens: 123 }] },
    { id: 'failed-work', latestRunId: 'failed-run', status: 'failed', error: secret },
  ];
  const status = idle({ run: { id: 'current-run', workId: 'current-work', status: 'awaiting_approval', approval: { id: 'approval-1', runId: 'current-run', expiresAt: new Date(Date.now() + 60000).toISOString(), title: secret, preview: { content: secret } } }, files: [{ name: secret, content: secret }] });
  const args = { status, works, artifacts: [{ name: secret, status: 'staged', content: secret }, { status: 'staged', content: secret }, { status: 'accepted' }], recovery: [{ status: 'available', content: secret }], backup: { error: secret } };
  const before = structuredClone(args);
  const items = await owner.inbox(args);
  assert.deepEqual([...new Set(items.map(item => item.kind))].sort(), ['approval', 'artifacts', 'failure', 'handoff', 'usage']);
  assert.equal(items.find(item => item.kind === 'approval').runId, 'current-run');
  assert.equal(items.find(item => item.kind === 'handoff').workId, 'paused-work');
  assert.match(items.find(item => item.kind === 'handoff').detail, /login or manual/);
  assert.equal(items.find(item => item.kind === 'usage').runId, 'unknown-run');
  assert.equal(items.find(item => item.kind === 'artifacts').count, 2);
  assert.equal(items.filter(item => item.kind === 'failure').length, 2);
  assert.doesNotMatch(JSON.stringify(items), /RAW_SECRET|script|credential|transcript|filename\.txt|123/);
  assert.deepEqual(args, before);
  for (const item of items) {
    assert.ok(Object.keys(item).every(key => ['id', 'kind', 'title', 'runId', 'workId', 'count', 'detail'].includes(key)));
    assert.equal(typeof item.id, 'string'); assert.equal(typeof item.title, 'string'); assert.equal(typeof item.detail, 'string');
  }
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
  assert.deepEqual(await owner.inbox(args), items);
  const backup = await owner.inbox({ status: idle({ files: [{ name: secret }] }) });
  assert.deepEqual(backup.map(item => item.kind), ['backup']);
  assert.doesNotMatch(JSON.stringify(backup), /RAW_SECRET/);
});

test('expired/stale approvals, resolved handoffs, accepted artifacts and reconciled usage disappear', async t => {
  const { owner } = await fixture(t);
  const baseRun = { id: 'run-1', workId: 'work-1', status: 'awaiting_approval', approval: { id: 'approval-1' } };
  for (const approval of [undefined, { id: 'approval-1', expiresAt: new Date(0).toISOString() }, { id: 'approval-1', expiresAt: 'invalid' }, { id: 'approval-1', runId: 'other-run' }, { id: 'approval-1', settled: true }, { id: '<script>' }]) {
    assert.equal((await owner.inbox({ status: { run: { ...baseRun, approval } } })).some(item => item.kind === 'approval'), false);
  }
  for (const status of ['running', 'finishing', 'paused', 'succeeded', 'failed', 'interrupted']) {
    assert.equal((await owner.inbox({ status: { run: { ...baseRun, status } } })).some(item => item.kind === 'approval'), false);
  }
  const work = { id: 'work-1', latestRunId: 'run-1', status: 'succeeded', budget: { usageUnknown: false }, attempts: [{ id: 'run-1', usageUnknown: true, reconciliation: { totalTokens: 42 } }], handoff: { reason: 'account_selection' } };
  const items = await owner.inbox({ status: { run: { id: 'run-1', workId: 'work-1', status: 'succeeded', usage: { unknown: true } }, work }, works: [work], artifacts: [{ status: 'accepted' }] });
  assert.deepEqual(items, []);
});

test('inbox handles current-run fallbacks, prototype-like reasons and unsafe identifiers with fixed text', async t => {
  const { owner } = await fixture(t);
  for (const reason of ['account_selection', 'external_result_confirmation', 'owner_requested', 'input_lease_lost', '__proto__', 'constructor', '<raw>']) {
    const items = await owner.inbox({ status: { run: { id: 'run-1', workId: 'work-1', status: 'paused', handoff: { reason }, usage: { unknown: true }, error: '<raw>' } } });
    assert.deepEqual(items.map(item => item.kind), ['handoff', 'usage']);
    assert.equal(typeof items[0].detail, 'string'); assert.doesNotMatch(JSON.stringify(items), /<raw>|__proto__|constructor/);
  }
  const items = await owner.inbox({ status: { run: { id: 'run-1', status: 'interrupted', error: 'secret raw provider error', usage: { unknown: true } } } });
  assert.deepEqual(items.map(item => item.kind), ['usage', 'failure']);
  assert.doesNotMatch(JSON.stringify(items), /secret raw provider/);
  assert.deepEqual(await owner.inbox({ status: { run: { id: '<raw>', workId: '../unsafe', status: 'paused' } }, works: [{ id: '<raw>', status: 'failed' }] }), []);
  assert.deepEqual(await owner.inbox(), []);
  assert.deepEqual(await owner.inbox({ status: null, works: null, artifacts: null, recovery: null }), []);
});

test('backup reminder requires eligible idle data and verified independent evidence; recovery is not backup', async t => {
  const { owner } = await fixture(t);
  const status = idle();
  assert.deepEqual(await owner.inbox({ status }), []);
  for (const recovery of [1, [{ status: 'available' }], [{ status: 'pending' }], [{ status: 'conflict' }]]) {
    assert.deepEqual((await owner.inbox({ status, recovery })).map(item => item.kind), ['backup']);
  }
  for (const recovery of [0, -1, NaN, '1', [{ status: 'restored' }]]) assert.deepEqual(await owner.inbox({ status, recovery }), []);
  assert.deepEqual(await owner.inbox({ status, recovery: 1, backup: { verified: true } }), []);
  for (const backup of [undefined, true, {}, { available: true }, { verified: false }, { verified: true, stale: true }, { verified: true, status: 'missing' }, { verified: true, status: 'failed' }]) {
    assert.deepEqual((await owner.inbox({ status, recovery: 1, backup })).map(item => item.kind), ['backup']);
  }
  for (const control of [{ owner: 'automation', stop: { confirmed: true } }, { owner: 'unconfirmed' }, { owner: 'human', stop: { confirmed: false } }]) {
    assert.deepEqual(await owner.inbox({ status: idle({ control }), recovery: 1 }), []);
  }
  assert.deepEqual(await owner.inbox({ status: idle({ canStart: false }), recovery: 1 }), []);
});

test('actual works.mjs public views identify unknown accounting and the latest attempt', async t => {
  const { owner } = await fixture(t);
  const work = createWork('Private goal does not appear in inbox', { maxSteps: 10, maxDurationMs: 1000, maxTokens: 100 });
  recordAttempt(work, { id: 'run-real', status: 'paused', startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(), usage: { unknown: true }, handoff: { reason: 'human_action_required' } });
  const view = viewWork(work);
  const items = await owner.inbox({ works: [view] });
  assert.deepEqual(items.map(item => item.kind), ['handoff', 'usage']);
  for (const item of items) { assert.equal(item.workId, work.id); assert.equal(item.runId, 'run-real'); }
  assert.doesNotMatch(JSON.stringify(items), /Private goal/);
});
