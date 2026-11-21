import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, symlink, link, open, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace } from '../src/workspace.mjs';
import { createArtifactStore } from '../src/artifacts.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'private-artifacts-'));
  const workspace = await createWorkspace(path.join(root, 'workspace'));
  const dataDir = path.join(root, 'private');
  const store = await createArtifactStore({ workspace, dataDir });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, dataDir, store };
}

test('staged outputs overlay the run, stay out of owner workspace, and accept one file', async t => {
  const { workspace, store } = await fixture(t);
  await workspace.write('report.md', Buffer.from('original\n'));
  const token = await store.version('run-1', 'report.md');
  const report = await store.stage('run-1', 'report.md', 'reviewed\n', { expectedVersion: token });
  await store.stage('run-1', 'new.md', 'new file\n', { expectedVersion: await store.version('run-1', 'new.md') });
  assert.equal(report.operation, 'modified');
  assert.equal(report.status, 'staged');
  assert.match(report.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await workspace.download('report.md')).toString(), 'original\n');
  assert.equal((await store.readWorkspace('run-1', 'report.md')).toString(), 'reviewed\n');
  assert.deepEqual((await store.listWorkspace('run-1')).map(file => file.name), ['new.md', 'report.md']);
  assert.equal((await store.listWorkspace('run-2')).length, 1);
  const diff = await store.diff('run-1', 'report.md');
  assert.match(diff.text, /-original\n\+reviewed/);
  assert.equal((await store.download('run-1', 'report.md')).toString(), 'reviewed\n');
  const accepted = await store.accept('run-1', 'report.md');
  assert.equal(accepted.status, 'accepted');
  assert.ok(accepted.recoveryId);
  assert.equal((await workspace.download('report.md')).toString(), 'reviewed\n');
  await assert.rejects(workspace.download('new.md'), { status: 404 });
});

test('approval tokens reject owner writes, external writes and competing staged revisions without losing either side', async t => {
  const { workspace, store } = await fixture(t);
  await workspace.write('notes.txt', 'base');
  const ownerToken = await store.version('run-1', 'notes.txt');
  await workspace.write('notes.txt', 'owner changed');
  await assert.rejects(store.stage('run-1', 'notes.txt', 'AI', { expectedVersion: ownerToken }), { status: 409, code: 'file_changed' });
  assert.equal((await store.list('run-1')).length, 0);
  const externalToken = await store.version('run-1', 'notes.txt');
  await writeFile(path.join(workspace.root, 'notes.txt'), 'external change');
  await assert.rejects(store.stage('run-1', 'notes.txt', 'AI', { expectedVersion: externalToken }), { status: 409 });
  const first = await store.stage('run-1', 'notes.txt', 'AI v1', { expectedVersion: await store.version('run-1', 'notes.txt') });
  const staleStageToken = await store.version('run-1', 'notes.txt');
  await store.stage('run-1', 'notes.txt', 'AI v2', { expectedVersion: staleStageToken });
  await assert.rejects(store.stage('run-1', 'notes.txt', 'AI stale', { expectedVersion: staleStageToken }), { status: 409 });
  await assert.rejects(store.accept('run-1', 'notes.txt', { expectedVersion: first.version }), { status: 409 });
  await writeFile(path.join(workspace.root, 'notes.txt'), 'human last word');
  await assert.rejects(store.accept('run-1', 'notes.txt'), { status: 409, code: 'file_changed' });
  assert.equal((await workspace.download('notes.txt')).toString(), 'human last word');
  assert.equal((await store.download('run-1', 'notes.txt')).toString(), 'AI v2');
  assert.equal((await store.list('run-1'))[0].conflict, true);
});

test('accept and restore are durable and recovery refuses a concurrent user change', async t => {
  const { workspace, store, dataDir } = await fixture(t);
  await workspace.write('notes.txt', 'before acceptance');
  await store.stage('run-1', 'notes.txt', 'accepted', { expectedVersion: await store.version('run-1', 'notes.txt') });
  const accepted = await store.accept('run-1', 'notes.txt');
  const restarted = await createArtifactStore({ workspace: await createWorkspace(workspace.root), dataDir });
  assert.equal((await restarted.list('run-1'))[0].status, 'accepted');
  assert.equal((await restarted.listRecovery()).find(point => point.id === accepted.recoveryId).status, 'available');
  const result = await restarted.restore(accepted.recoveryId);
  assert.equal(result.restored, true);
  assert.equal((await workspace.download('notes.txt')).toString(), 'before acceptance');
  await restarted.restore(result.undoRecoveryId);
  assert.equal((await workspace.download('notes.txt')).toString(), 'accepted');
  const ownerWrite = await restarted.ownerWrite('notes.txt', Buffer.from('owner upload'));
  await writeFile(path.join(workspace.root, 'notes.txt'), 'concurrent user change');
  await assert.rejects(restarted.restore(ownerWrite.recoveryId), { status: 409, code: 'file_changed' });
  assert.equal((await workspace.download('notes.txt')).toString(), 'concurrent user change');
  await assert.rejects(restarted.restore(accepted.recoveryId), { status: 409 });
});

test('added and deleted files report checksums, overlay deletion and recover their prior state', async t => {
  const { workspace, store } = await fixture(t);
  await workspace.write('remove.txt', 'keep for recovery\n');
  const removed = await store.stage('run-delete', 'remove.txt', null, { expectedVersion: await store.version('run-delete', 'remove.txt') });
  assert.equal(removed.operation, 'deleted'); assert.equal(removed.sha256, null); assert.equal(removed.bytes, 0);
  assert.equal((await store.listWorkspace('run-delete')).length, 0);
  await assert.rejects(store.readWorkspace('run-delete', 'remove.txt'), { status: 404 });
  await assert.rejects(store.download('run-delete', 'remove.txt'), { status: 404 });
  const deleted = await store.accept('run-delete', 'remove.txt');
  await assert.rejects(workspace.download('remove.txt'), { status: 404 });
  await store.restore(deleted.recoveryId);
  assert.equal((await workspace.download('remove.txt')).toString(), 'keep for recovery\n');
  const added = await store.stage('run-add', 'abc.txt', 'abc', { expectedVersion: await store.version('run-add', 'abc.txt') });
  assert.equal(added.operation, 'added');
  assert.equal(added.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(added.bytes, 3);
  const accepted = await store.accept('run-add', 'abc.txt');
  assert.equal((await store.accept('run-add', 'abc.txt')).recoveryId, accepted.recoveryId);
  await store.restore(accepted.recoveryId);
  await assert.rejects(workspace.download('abc.txt'), { status: 404 });
});

test('missing approval preconditions and revoked assertions prevent stage, accept and restore', async t => {
  const { workspace, store } = await fixture(t);
  await assert.rejects(store.stage('run-1', 'file.txt', 'unsafe'), { status: 428 });
  const expectedVersion = await store.version('run-1', 'file.txt');
  let active = true;
  const assertActive = () => { if (!active) { const error = new Error('revoked'); error.status = 409; throw error; } queueMicrotask(() => { active = false; }); };
  await assert.rejects(store.stage('run-1', 'file.txt', 'unsafe', { expectedVersion, assertActive }), /revoked/);
  assert.equal((await store.list('run-1')).length, 0);
  await store.stage('run-1', 'file.txt', 'safe', { expectedVersion: await store.version('run-1', 'file.txt') });
  const deny = () => { throw new Error('not authorized'); };
  await assert.rejects(store.accept('run-1', 'file.txt', { assertActive: deny }), /not authorized/);
  await assert.rejects(workspace.download('file.txt'), { status: 404 });
  const accepted = await store.accept('run-1', 'file.txt');
  await assert.rejects(store.restore(accepted.recoveryId, { assertActive: deny }), /not authorized/);
  assert.equal((await workspace.download('file.txt')).toString(), 'safe');
});

test('workspace keeps whole versions and only one competing compare-and-swap can win', async t => {
  const { workspace } = await fixture(t);
  await workspace.write('file.txt', 'original');
  const expectedVersion = await workspace.version('file.txt');
  const results = await Promise.allSettled([
    workspace.compareAndSwap('file.txt', 'first', { expectedVersion }),
    workspace.compareAndSwap('file.txt', 'second', { expectedVersion }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'file_changed');
  assert.equal((await workspace.download('file.txt')).toString(), 'first');
  const before = await workspace.version('file.txt');
  await assert.rejects(workspace.compareAndSwap('file.txt', 'losing write', {
    expectedVersion: before,
    beforeChange: async () => { await writeFile(path.join(workspace.root, 'file.txt'), 'outside change while backing up'); },
  }), { status: 409 });
  assert.equal((await workspace.download('file.txt')).toString(), 'outside change while backing up');
});

test('an external create during acceptance wins without clobbering or losing the staged side', async t => {
  const { workspace, store } = await fixture(t);
  await workspace.write('file.txt', 'old user data');
  await store.stage('run-1', 'file.txt', 'AI proposed', { expectedVersion: await store.version('run-1', 'file.txt') });
  let injected = false;
  const assertActive = async () => {
    if (injected) return;
    try { await readFile(path.join(workspace.root, 'file.txt')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(path.join(workspace.root, 'file.txt'), 'new concurrent user data'); injected = true; }
  };
  await assert.rejects(store.accept('run-1', 'file.txt', { assertActive }), { status: 409, code: 'file_changed' });
  assert.equal(injected, true);
  assert.equal((await workspace.download('file.txt')).toString(), 'new concurrent user data');
  assert.equal((await store.download('run-1', 'file.txt')).toString(), 'AI proposed');
  const points = await store.listRecovery();
  assert.ok(points.some(point => point.status === 'conflict' && point.bytes === 13));
  for (const point of points) await assert.rejects(store.restore(point.id), { status: 409 });
});

test('private storage, safe names, symlinks and hard links cannot expose or modify outside files', async t => {
  const { root, workspace, store } = await fixture(t);
  await assert.rejects(createArtifactStore({ workspace, dataDir: path.join(workspace.root, 'private') }), /outside the workspace/);
  for (const name of ['../secret', 'a/b', 'a\\b', 'a..b', '.hidden', 'nul.txt', 'CON', 'report.']) {
    await assert.rejects(store.version('run-1', name), { status: 400 });
    await assert.rejects(store.stage('run-1', name, 'bad', { expectedVersion: 'missing' }), { status: 400 });
  }
  const outside = path.join(root, 'outside.txt'); await writeFile(outside, 'private outside data');
  await symlink(outside, path.join(workspace.root, 'symbolic.txt'));
  await link(outside, path.join(workspace.root, 'hard.txt'));
  for (const name of ['symbolic.txt', 'hard.txt']) {
    await assert.rejects(workspace.download(name), { status: 400 });
    await assert.rejects(workspace.write(name, 'bad'), { status: 400 });
    await assert.rejects(store.version('run-1', name), { status: 400 });
  }
  assert.equal((await workspace.list()).length, 0);
  assert.equal(await readFile(outside, 'utf8'), 'private outside data');
  await symlink(workspace.root, path.join(root, 'data-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createArtifactStore({ workspace, dataDir: path.join(root, 'data-link') }), /real directory|outside the workspace/);
});

test('text diffs are deterministic and bounded, with explicit binary and newline handling', async t => {
  const { workspace, store } = await fixture(t);
  await store.stage('run-1', 'new.txt', 'one\n', { expectedVersion: await store.version('run-1', 'new.txt') });
  const added = await store.diff('run-1', 'new.txt');
  assert.equal(added.text, '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+one\n');
  assert.equal(added.binary, false);
  await workspace.write('newline.txt', 'line');
  await store.stage('run-1', 'newline.txt', 'line\n', { expectedVersion: await store.version('run-1', 'newline.txt') });
  assert.match((await store.diff('run-1', 'newline.txt')).text, /No newline at end of file/);
  await store.stage('run-1', 'binary.bin', Buffer.from([0, 255, 1]), { expectedVersion: await store.version('run-1', 'binary.bin') });
  assert.equal((await store.diff('run-1', 'binary.bin')).binary, true);
  await store.stage('run-1', 'long.txt', '汉字'.repeat(100000), { expectedVersion: await store.version('run-1', 'long.txt') });
  const long = await store.diff('run-1', 'long.txt');
  assert.equal(long.truncated, true);
  assert.ok(Buffer.byteLength(long.text, 'utf8') <= 64 * 1024);
  assert.deepEqual(await store.diff('run-1', 'long.txt'), long);
});

test('owner upload preconditions reject stale versions and every overwrite can be restored', async t => {
  const { workspace, store } = await fixture(t);
  const initial = await store.ownerWrite('file.txt', 'first');
  const listed = (await workspace.list())[0];
  assert.equal(listed.version, initial.version);
  const second = await store.ownerWrite('file.txt', 'second', { expectedVersion: listed.version });
  await assert.rejects(store.ownerWrite('file.txt', 'stale third', { expectedVersion: listed.version }), { status: 409, code: 'file_changed' });
  assert.equal((await workspace.download('file.txt')).toString(), 'second');
  await store.restore(second.recoveryId);
  assert.equal((await workspace.download('file.txt')).toString(), 'first');
});

test('an external writer holding the displaced inode is retained as a protected recovery version', async t => {
  const { workspace, store } = await fixture(t);
  await workspace.write('file.txt', 'before');
  await store.stage('run-1', 'file.txt', 'AI output', { expectedVersion: await store.version('run-1', 'file.txt') });
  const external = await open(path.join(workspace.root, 'file.txt'), 'r+');
  let written = false;
  try {
    const assertActive = async () => {
      if (written) return;
      try { await readFile(path.join(workspace.root, 'file.txt')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await external.truncate(0); await external.writeFile('late user edit'); await external.sync(); written = true;
      }
    };
    await assert.rejects(store.accept('run-1', 'file.txt', { assertActive }), { status: 409, code: 'file_changed' });
  } finally { await external.close(); }
  assert.equal(written, true);
  assert.equal((await store.download('run-1', 'file.txt')).toString(), 'AI output');
  const retained = (await store.listRecovery()).find(point => point.operation === 'concurrent-change' && point.status === 'available');
  assert.ok(retained);
  await store.restore(retained.id);
  assert.equal((await workspace.download('file.txt')).toString(), 'late user edit');
});

test('a failed durable backup leaves displaced concurrent bytes on disk', async t => {
  const { workspace } = await fixture(t);
  await workspace.write('file.txt', 'before');
  const external = await open(path.join(workspace.root, 'file.txt'), 'r+');
  let written = false;
  try {
    await assert.rejects(workspace.compareAndSwap('file.txt', 'new value', {
      expectedVersion: await workspace.version('file.txt'),
      onDisplaced: async () => { throw new Error('backup unavailable'); },
      assertActive: async () => {
        if (written) return;
        try { await readFile(path.join(workspace.root, 'file.txt')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; await external.truncate(0); await external.writeFile('unbacked user edit'); await external.sync(); written = true; }
      },
    }), /backup unavailable/);
  } finally { await external.close(); }
  assert.equal(written, true);
  const contents = await Promise.all((await readdir(workspace.root)).map(name => readFile(path.join(workspace.root, name), 'utf8')));
  assert.ok(contents.includes('unbacked user edit'));
});
