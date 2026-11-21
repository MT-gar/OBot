#!/usr/bin/env node
// Synthetic-only proof. Creates an independent temporary source/bundle/fresh instance;
// does not read .local, deployment secrets, Docker, providers, or any daily instance.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm, cp, symlink, link, chmod, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createBackup, verifyBackup, restoreBackup, restoreVolumes } from './backup.mjs';
import { createWorkspace } from '../apps/control/src/workspace.mjs';
import { createController } from '../apps/control/src/controller.mjs';
import { createOwnerOperations } from '../apps/control/src/owner-operations.mjs';

const checks = []; const skipped = [];
const options = { writersStopped: true, profileKeyPolicy: 'external-relogin', privateRootAck: true, sourceVersion: 'synthetic-backup-proof-v1', project: 'pc-backup-test-local' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
async function check(name, fn) { await fn(); checks.push(name); }
async function exists(file) { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'pc-backup-proof-')); const absoluteRoot = path.resolve(root);
  const home = path.join(root, 'source', 'home'); const control = path.join(root, 'source', 'control');
  const backups = path.join(root, 'private-backups'); const restores = path.join(root, 'restores'); const attacks = path.join(root, 'adversarial');
  const bundle = path.join(backups, 'synthetic-bundle'); const destination = path.join(restores, 'fresh-instance');
  const completedId = '11111111-1111-4111-8111-111111111111'; const activeId = '22222222-2222-4222-8222-222222222222';
  const workspaceBytes = Buffer.from('Synthetic evidence only. 工作文件保留。\n'); const blobBytes = Buffer.from('Synthetic accepted original version.\n');
  let created;
  try {
    for (const folder of [path.join(home, 'Workspace', 'nested'), path.join(home, '.config', 'chromium', 'Default', 'Network'), path.join(home, '.ssh'), path.join(control, 'runs'), path.join(control, 'artifacts', 'blobs'), path.join(control, 'artifacts', 'recovery'), backups, restores, attacks, path.join(root, 'external-secrets')]) await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(path.join(home, 'Workspace', 'evidence.txt'), workspaceBytes);
    await writeFile(path.join(home, 'Workspace', 'nested', 'empty.txt'), '');
    await writeFile(path.join(home, 'Workspace', 'binary.bin'), Buffer.from([0, 1, 2, 255]));
    await writeFile(path.join(home, '.ssh', 'id_ed25519'), 'SYNTHETIC_PRIVATE_KEY_NOT_TO_BACKUP');
    await writeFile(path.join(home, '.config', 'chromium', 'Local State'), encode({ browser: { enabled_labs_experiments: ['synthetic-setting'] }, profile: { last_used: 'Default', last_active_profiles: ['Default'], info_cache: { Default: { user_name: 'synthetic@example.invalid' } } }, os_crypt: { encrypted_key: 'SYNTHETIC_PROFILE_KEY' }, signin: { token: 'SYNTHETIC_ACCOUNT_TOKEN' } }));
    await writeFile(path.join(home, '.config', 'chromium', 'Default', 'Preferences'), encode({ browser: { show_home_button: true }, homepage: 'http://example.invalid/synthetic', account_info: [{ token: 'SYNTHETIC_TOKEN' }], extensions: { settings: { synthetic: { password: 'SYNTHETIC_EXTENSION_SECRET' } } }, signin: { allowed: true } }));
    await writeFile(path.join(home, '.config', 'chromium', 'Default', 'Bookmarks'), encode({ roots: { bookmark_bar: { children: [{ name: 'Synthetic fixture', url: 'http://example.invalid/fixture' }] } }, version: 1 }));
    await writeFile(path.join(home, '.config', 'chromium', 'Default', 'Network', 'Cookies'), 'SYNTHETIC_COOKIE_STORE');
    await writeFile(path.join(home, '.config', 'chromium', 'Default', 'Login Data'), 'SYNTHETIC_PASSWORD_STORE');
    await writeFile(path.join(home, '.config', 'chromium', 'Default', 'Sessions'), 'SYNTHETIC_SESSION_DATA');
    await writeFile(path.join(root, 'external-secrets', 'model-key'), 'SYNTHETIC_PROVIDER_KEY');
    const completed = { id: completedId, kind: 'agent', status: 'succeeded', steps: [], startedAt: '2026-01-01T00:00:00.000Z', usage: { inputTokens: 13, outputTokens: 7, totalTokens: 20, reasoningTokens: 0, unknown: false }, output: 'Synthetic prior result.' };
    const active = { id: activeId, kind: 'agent', status: 'awaiting_approval', steps: [{ status: 'pending' }], approval: { id: 'synthetic-old-approval' }, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, unknown: false } };
    await writeFile(path.join(control, 'state.json'), encode({ version: 1, generation: 8, events: [{ type: 'synthetic.backup.fixture' }], run: active }));
    await writeFile(path.join(control, 'runs', `${completedId}.json`), encode(completed));
    await writeFile(path.join(control, 'runs', `${activeId}.json`), encode(active));
    await writeFile(path.join(control, 'artifacts', 'blobs', digest(blobBytes)), blobBytes);
    await writeFile(path.join(control, 'artifacts', 'recovery', 'synthetic.json'), encode({ format: 1, fixture: true, sha256: digest(blobBytes) }));
    const owner = await createOwnerOperations({ dataDir: control });
    const template = await owner.saveTemplate({ name: 'Synthetic weekly summary', work: { id: 'synthetic-template-work', status: 'succeeded', goal: 'Prepare a synthetic weekly summary. 模板目标保留。', token: 'SYNTHETIC_WORK_CREDENTIAL', approval: 'SYNTHETIC_WORK_APPROVAL', steps: [{ transcript: 'SYNTHETIC_WORK_TRANSCRIPT' }], budget: { maxTokens: 999 } } });
    const templateFile = path.join(control, 'owner-operations', 'templates.json');
    const templateBytes = await readFile(templateFile); const templateStore = JSON.parse(templateBytes);
    const pendingTemplate = '.pending-33333333-3333-4333-8333-333333333333';
    await writeFile(path.join(control, 'owner-operations', pendingTemplate), 'SYNTHETIC_UNCOMMITTED_TEMPLATE_SECRET');
    const input = { ...options, home, control };
    await check('explicit stopped-writer and key/private-root policy required', async () => {
      for (const override of [{ writersStopped: false }, { profileKeyPolicy: undefined }, { privateRootAck: false }]) await assert.rejects(createBackup({ ...input, ...override, destination: path.join(backups, 'refused-policy') }), /Explicit/);
    });
    await check('source version and independent destination required', async () => {
      await assert.rejects(createBackup({ ...input, sourceVersion: '', destination: path.join(backups, 'refused-version') }), /sourceVersion/);
      await assert.rejects(createBackup({ ...input, destination: path.join(home, 'inside-source') }), /independent/);
      assert.equal(await exists(path.join(home, 'inside-source')), false);
    });
    await check('private external bundle created with v1 manifest and SHA-256', async () => {
      created = await createBackup({ ...input, destination: bundle }); const verified = await verifyBackup({ backup: bundle });
      assert.equal(verified.manifest.version, 1); assert.equal(verified.manifest.consistency.sourceRechecked, true); assert.equal(verified.manifestSha256, created.manifestSha256);
      assert.equal(verified.manifest.schemas.controlState, 1); assert.ok(verified.manifest.entries.length > 10);
      if (process.platform !== 'win32') { assert.equal(Number((await lstat(bundle)).mode) & 0o077, 0); assert.equal(Number((await lstat(path.join(bundle, 'manifest.json'))).mode) & 0o077, 0); }
    });
    await check('owner goal-only templates retained; generated pending files and authorization metadata excluded', async () => {
      assert.deepEqual(await readFile(path.join(bundle, 'payload', 'control', 'owner-operations', 'templates.json')), templateBytes);
      assert.deepEqual(await readdir(path.join(bundle, 'payload', 'control', 'owner-operations')), ['templates.json']);
      const verified = await verifyBackup({ backup: bundle }); assert.equal(verified.manifest.schemas.ownerTemplates, 1);
      assert.equal(verified.manifest.entries.some(entry => entry.path.endsWith(`/${pendingTemplate}`)), false);
      assert.doesNotMatch(templateBytes.toString('utf8'), /SYNTHETIC_WORK_|approval|budget|transcript|maxTokens/);
    });
    await check('necessary browser configuration retained; keys/auth/session excluded', async () => {
      const local = JSON.parse(await readFile(path.join(bundle, 'payload', 'home', '.config', 'chromium', 'Local State')));
      const preferences = JSON.parse(await readFile(path.join(bundle, 'payload', 'home', '.config', 'chromium', 'Default', 'Preferences')));
      assert.equal(local.profile.last_used, 'Default'); assert.equal(preferences.browser.show_home_button, true);
      assert.equal(local.os_crypt, undefined); assert.equal(local.signin, undefined); assert.equal(local.profile.info_cache, undefined); assert.equal(preferences.account_info, undefined); assert.equal(preferences.extensions, undefined);
      const verified = await verifyBackup({ backup: bundle }); const paths = verified.manifest.entries.map(entry => entry.path);
      for (const forbidden of ['Cookies', 'Login Data', 'Sessions', 'id_ed25519', 'model-key', 'runner-token', 'owner-password']) assert.equal(paths.some(name => name.endsWith(`/${forbidden}`)), false);
      assert.equal(await readFile(path.join(root, 'external-secrets', 'model-key'), 'utf8'), 'SYNTHETIC_PROVIDER_KEY');
    });
    await check('atomic restore to an absent independent fresh instance', async () => {
      const receipt = await restoreBackup({ ...options, backup: bundle, destination }); assert.equal(receipt.manifestSha256, created.manifestSha256);
      assert.deepEqual(await readFile(path.join(destination, 'home', 'Workspace', 'evidence.txt')), workspaceBytes);
      assert.deepEqual(await readFile(path.join(destination, 'home', 'Workspace', 'binary.bin')), Buffer.from([0, 1, 2, 255]));
      assert.equal((await lstat(path.join(destination, 'home', 'Workspace', 'nested', 'empty.txt'))).size, 0);
      assert.deepEqual(await readFile(path.join(destination, 'control', 'artifacts', 'blobs', digest(blobBytes))), blobBytes);
      assert.deepEqual(JSON.parse(await readFile(path.join(destination, 'control', 'runs', `${completedId}.json`))), completed);
      assert.deepEqual(await readFile(path.join(destination, 'control', 'owner-operations', 'templates.json')), templateBytes);
      const restoredOwner = await createOwnerOperations({ dataDir: path.join(destination, 'control') }); assert.deepEqual(await restoredOwner.listTemplates(), [template]);
      assert.deepEqual((await readdir(restores)).sort(), ['fresh-instance']);
    });
    await check('existing restore data and backup destinations never overwritten', async () => {
      await assert.rejects(restoreBackup({ ...options, backup: bundle, destination }), /already exists/);
      await assert.rejects(createBackup({ ...input, destination: bundle }), /already exists/);
      assert.deepEqual(await readFile(path.join(destination, 'home', 'Workspace', 'evidence.txt')), workspaceBytes);
    });
    async function attack(name, mutate, pattern) {
      const candidate = path.join(attacks, name); await cp(bundle, candidate, { recursive: true, errorOnExist: true, force: false }); await mutate(candidate);
      const out = path.join(restores, `refused-${name}`);
      await assert.rejects(restoreBackup({ ...options, backup: candidate, destination: out }), pattern); assert.equal(await exists(out), false);
    }
    async function rewrite(candidate, mutate) {
      const file = path.join(candidate, 'manifest.json'); const value = JSON.parse(await readFile(file, 'utf8')); mutate(value); const bytes = encode(value);
      await writeFile(file, bytes); await writeFile(path.join(candidate, 'manifest.sha256'), `${digest(bytes)}  manifest.json\n`);
    }
    const invalidTemplateStores = [
      ['format', encode({ ...templateStore, format: 2 })],
      ['root-field', encode({ ...templateStore, token: 'SYNTHETIC_FORGED_CREDENTIAL' })],
      ['entry-field', encode({ format: 1, templates: [{ ...template, token: 'SYNTHETIC_FORGED_CREDENTIAL' }] })],
      ['id', encode({ format: 1, templates: [{ ...template, id: '../not-a-template-id' }] })],
      ['untrimmed-name', encode({ format: 1, templates: [{ ...template, name: ` ${template.name}` }] })],
      ['control-name', encode({ format: 1, templates: [{ ...template, name: 'bad\nname' }] })],
      ['long-name', encode({ format: 1, templates: [{ ...template, name: 'x'.repeat(81) }] })],
      ['empty-goal', encode({ format: 1, templates: [{ ...template, goal: '' }] })],
      ['untrimmed-goal', encode({ format: 1, templates: [{ ...template, goal: `${template.goal} ` }] })],
      ['long-goal', encode({ format: 1, templates: [{ ...template, goal: 'x'.repeat(4001) }] })],
      ['timestamp', encode({ format: 1, templates: [{ ...template, createdAt: 'not-a-date' }] })],
      ['duplicate-id', encode({ format: 1, templates: [template, { ...template, name: 'Different synthetic name' }] })],
      ['duplicate-name', encode({ format: 1, templates: [template, { ...template, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: template.name.toUpperCase() }] })],
      ['count', encode({ format: 1, templates: Array.from({ length: 101 }, () => template) })],
      ['utf8', Buffer.from([0xff])], ['json', '{'], ['size', Buffer.alloc(2 * 1024 * 1024 + 1, 32)],
    ];
    await check('invalid or credential-bearing source templates rejected without publication', async () => {
      try {
        for (const [name, bytes] of invalidTemplateStores) {
          await writeFile(templateFile, bytes); const out = path.join(backups, `refused-template-${name}`);
          await assert.rejects(createBackup({ ...input, destination: out }), /owner template|metadata/); assert.equal(await exists(out), false);
        }
      } finally { await writeFile(templateFile, templateBytes); }
    });
    await check('unknown owner-operation source files rejected without reading credentials', async () => {
      const secret = path.join(control, 'owner-operations', 'owner-password'); await writeFile(secret, 'SYNTHETIC_EXTERNAL_CREDENTIAL');
      try {
        const out = path.join(backups, 'refused-owner-layout'); await assert.rejects(createBackup({ ...input, destination: out }), /owner template layout/);
        assert.equal(await exists(out), false); assert.equal(await readFile(secret, 'utf8'), 'SYNTHETIC_EXTERNAL_CREDENTIAL');
      } finally { await rm(secret); }
    });
    await check('corrupt payload rejected before destination publication', () => attack('checksum', candidate => writeFile(path.join(candidate, 'payload', 'home', 'Workspace', 'evidence.txt'), 'synthetic corruption'), /checksum/));
    await check('manifest checksum rejected', () => attack('manifest-hash', candidate => writeFile(path.join(candidate, 'manifest.sha256'), `${'0'.repeat(64)}  manifest.json\n`), /checksum/));
    await check('rehashed unsupported bundle version rejected', () => attack('version', candidate => rewrite(candidate, value => { value.version = 999; }), /version/));
    await check('rehashed unsupported state schema rejected', () => attack('schema', candidate => rewrite(candidate, value => { value.schemas.controlState = 999; }), /schema/));
    await check('traversal and absolute/Windows paths rejected even if rehashed', async () => {
      for (const [index, value] of ['../escaped', '/absolute', 'home/Workspace/../escape', 'home/Workspace/C:\\escape', 'home/Workspace/NUL.txt'].entries()) await attack(`traversal-${index}`, candidate => rewrite(candidate, manifest => { manifest.entries.find(entry => entry.type === 'file').path = value; }), /path/);
      assert.equal(await exists(path.join(root, 'escaped')), false);
    });
    await check('duplicate and case-folded manifest paths rejected', async () => {
      await attack('duplicate', candidate => rewrite(candidate, manifest => { manifest.entries.push(manifest.entries[0]); }), /Duplicate/);
      await attack('case-collision', candidate => rewrite(candidate, manifest => { const entry = manifest.entries.find(item => item.path === 'home/Workspace/evidence.txt'); manifest.entries.push({ ...entry, path: 'home/Workspace/EVIDENCE.txt' }); }), /Duplicate/);
    });
    await check('unmanifested payload and unrecognized bundle files rejected', async () => {
      await attack('extra-payload', candidate => writeFile(path.join(candidate, 'payload', 'unexpected.txt'), 'synthetic'), /inventory/);
      await attack('extra-top', candidate => writeFile(path.join(candidate, 'unexpected.txt'), 'synthetic'), /Unexpected/);
    });
    await check('browser key material rejected even with recomputed checksums', async () => {
      await attack('browser-key', async candidate => {
        const rel = 'home/.config/chromium/Local State'; const file = path.join(candidate, 'payload', ...rel.split('/')); const data = encode({ os_crypt: { encrypted_key: 'SYNTHETIC_FORGED_KEY' } }); await writeFile(file, data);
        await rewrite(candidate, manifest => { const entry = manifest.entries.find(item => item.path === rel); manifest.totalBytes += Buffer.byteLength(data) - entry.bytes; entry.bytes = Buffer.byteLength(data); entry.sha256 = digest(data); });
      }, /key material/);
    });
    await check('rehashed invalid owner-template formats, fields and limits rejected before restore', async () => {
      for (const [name, bytes] of invalidTemplateStores) await attack(`template-${name}`, async candidate => {
        const logical = 'control/owner-operations/templates.json'; await writeFile(path.join(candidate, 'payload', ...logical.split('/')), bytes);
        await rewrite(candidate, manifest => { const entry = manifest.entries.find(item => item.path === logical); manifest.totalBytes += Buffer.byteLength(bytes) - entry.bytes; entry.bytes = Buffer.byteLength(bytes); entry.sha256 = digest(bytes); });
      }, /owner template/);
      await attack('template-schema', candidate => rewrite(candidate, manifest => { manifest.schemas.ownerTemplates = 2; }), /schema/);
      await attack('template-schema-missing', candidate => rewrite(candidate, manifest => { delete manifest.schemas.ownerTemplates; }), /schema/);
    });
    await check('unknown owner-operation payload files and pending files rejected even if manifested', async () => {
      for (const filename of ['owner-password', pendingTemplate, 'templates.json.tmp']) await attack(`owner-layout-${filename}`, async candidate => {
        const logical = `control/owner-operations/${filename}`; const bytes = Buffer.from('SYNTHETIC_CREDENTIAL_OR_PENDING'); await writeFile(path.join(candidate, 'payload', ...logical.split('/')), bytes);
        await rewrite(candidate, manifest => { manifest.entries.push({ path: logical, type: 'file', mode: 0o600, bytes: bytes.length, sha256: digest(bytes) }); manifest.totalBytes += bytes.length; });
      }, /out-of-scope/);
    });
    await check('legacy v1 bundles and empty optional owner-template stores remain restorable', async () => {
      const legacy = path.join(attacks, 'legacy-no-owner'); await cp(bundle, legacy, { recursive: true, errorOnExist: true, force: false });
      await rm(path.join(legacy, 'payload', 'control', 'owner-operations'), { recursive: true });
      await rewrite(legacy, manifest => { const removed = manifest.entries.filter(entry => entry.path === 'control/owner-operations' || entry.path.startsWith('control/owner-operations/')); manifest.totalBytes -= removed.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0); manifest.entries = manifest.entries.filter(entry => !removed.includes(entry)); delete manifest.schemas.ownerTemplates; });
      const out = path.join(restores, 'legacy-fresh'); await restoreBackup({ ...options, backup: legacy, destination: out });
      const legacyOwner = await createOwnerOperations({ dataDir: path.join(out, 'control') }); assert.deepEqual(await legacyOwner.listTemplates(), []);
      const empty = path.join(attacks, 'empty-owner'); await cp(bundle, empty, { recursive: true, errorOnExist: true, force: false });
      await rm(path.join(empty, 'payload', 'control', 'owner-operations', 'templates.json'));
      await rewrite(empty, manifest => { const file = manifest.entries.find(entry => entry.path === 'control/owner-operations/templates.json'); manifest.totalBytes -= file.bytes; manifest.entries = manifest.entries.filter(entry => entry !== file); });
      const emptyOut = path.join(restores, 'empty-owner-fresh'); await restoreBackup({ ...options, backup: empty, destination: emptyOut });
      const emptyOwner = await createOwnerOperations({ dataDir: path.join(emptyOut, 'control') }); assert.deepEqual(await emptyOwner.listTemplates(), []);
    });
    await check('hardlinked payload refused', async () => {
      await attack('hardlink', async candidate => { const file = path.join(candidate, 'payload', 'home', 'Workspace', 'evidence.txt'); await link(file, path.join(candidate, 'payload', 'home', 'Workspace', 'hardlink.txt')); }, /hardlink/);
    });
    if (process.platform === 'win32') skipped.push('symlink fixture requires Windows Developer Mode/admin; covered by WSL run');
    else await check('symlink payload and symlink source refused', async () => {
      await attack('symlink', candidate => symlink(path.join(root, 'external-secrets', 'model-key'), path.join(candidate, 'payload', 'home', 'Workspace', 'link.txt')), /symlink/);
      const sourceLink = path.join(home, 'Workspace', 'link.txt'); await symlink(path.join(root, 'external-secrets', 'model-key'), sourceLink);
      await assert.rejects(createBackup({ ...input, destination: path.join(backups, 'refused-source-link') }), /symlink/); await rm(sourceLink);
    });
    await check('source hardlink refused without changing original data', async () => {
      const sourceLink = path.join(home, 'Workspace', 'hardlink.txt'); await link(path.join(home, 'Workspace', 'evidence.txt'), sourceLink);
      await assert.rejects(createBackup({ ...input, destination: path.join(backups, 'refused-source-hardlink') }), /hardlink/); await rm(sourceLink);
      assert.deepEqual(await readFile(path.join(home, 'Workspace', 'evidence.txt')), workspaceBytes);
    });
    if (process.platform !== 'win32') await check('permissive backup parent rejected', async () => {
      const folder = path.join(root, 'public-backups'); await mkdir(folder, { mode: 0o755 }); await chmod(folder, 0o755);
      await assert.rejects(createBackup({ ...input, destination: path.join(folder, 'refused') }), /private/);
    }); else skipped.push('POSIX mode enforcement is inapplicable; Windows private-root acknowledgement is required');
    await check('active source mutation aborts and removes unpublished staging', async () => {
      const file = path.join(home, 'Workspace', 'mutation.bin'); await writeFile(file, Buffer.alloc(16 * 1024 * 1024, 7)); let pending = Promise.resolve();
      const timer = setInterval(() => { pending = pending.then(() => utimes(file, new Date(), new Date())); }, 1);
      try { await assert.rejects(createBackup({ ...input, destination: path.join(backups, 'refused-mutating') }), /changed/); }
      finally { clearInterval(timer); await pending; await rm(file); }
      assert.equal(await exists(path.join(backups, 'refused-mutating')), false);
      assert.deepEqual((await readdir(backups)).sort(), ['synthetic-bundle']);
    });
    await check('fresh empty two-volume restore and matching completion markers', async () => {
      const emptyHome = path.join(root, 'fresh-volumes', 'home'); const emptyControl = path.join(root, 'fresh-volumes', 'control');
      for (const folder of [emptyHome, emptyControl]) await mkdir(folder, { recursive: true, mode: 0o700 });
      const receipt = await restoreVolumes({ ...options, backup: bundle, home: emptyHome, control: emptyControl });
      const first = JSON.parse(await readFile(path.join(emptyHome, '.restore-complete.json'))); const second = JSON.parse(await readFile(path.join(emptyControl, '.restore-complete.json')));
      assert.deepEqual(first, second); assert.equal(first.transaction, receipt.transaction); assert.equal(first.manifestSha256, created.manifestSha256);
      const volumeOwner = await createOwnerOperations({ dataDir: emptyControl }); assert.deepEqual(await volumeOwner.listTemplates(), [template]);
      await assert.rejects(restoreVolumes({ ...options, backup: bundle, home: emptyHome, control: emptyControl }), /empty/);
    });
    await check('fresh application instance retains history, invalidates old approval and completes a new synthetic task', async () => {
      const workspace = await createWorkspace(path.join(destination, 'home', 'Workspace'));
      const model = { metadata: () => ({ configured: true, model: 'synthetic-local', protocol: 'responses' }), async respond() { return { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fresh restored synthetic task complete.' }] }], usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } }; } };
      const runtime = { async setViewOnly() {}, async inspect() { return { ready: true, browserReady: true }; } };
      const controller = await createController({ runtime, workspace, dataDir: path.join(destination, 'control'), fixtureUrl: 'http://example.invalid/fixture', model });
      try {
        const old = await controller.getRun(activeId); assert.equal(old.status, 'interrupted'); assert.equal(old.approval, undefined); assert.equal(old.usage.unknown, true);
        assert.equal((await controller.getRun(completedId)).usage.totalTokens, 20);
        const { id } = await controller.startTask({ goal: 'Complete a synthetic task after a clean restore.', allowDesktop: false, observe: { workspace: true, desktop: false } });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { cleanup(); reject(new Error('Fresh restored task timed out.')); }, 5000);
          const listener = async () => { try { const state = await controller.status(); if (state.canStart && state.run?.id === id) { cleanup(); resolve(); } } catch (error) { cleanup(); reject(error); } };
          const cleanup = () => { clearTimeout(timer); controller.events.off('change', listener); };
          controller.events.on('change', listener); void listener();
        });
        const run = await controller.getRun(id); assert.equal(run.status, 'succeeded', JSON.stringify({ status: run.status, error: run.error, errorCode: run.errorCode })); assert.equal(run.output, 'Fresh restored synthetic task complete.'); assert.equal(run.usage.totalTokens, 7);
        assert.equal((await controller.listRuns()).some(item => item.id === completedId), true);
      } finally { await controller.close(); }
    });
    return { passed: checks.length, checks, skipped, evidence: { syntheticOnly: true, sourceAndBackupIndependent: true, freshLocalApplicationTask: 'succeeded', ownerTemplatesRestored: true, ownerTemplatesSchema: 1, manifestVersion: 1, manifestSha256: created.manifestSha256, entries: created.entries, bytes: created.bytes, node: process.version, platform: process.platform, docker: 'not exercised by this script', authentication: 'relogin-required', crossHostDisasterRecovery: 'not proven' } };
  } finally {
    // Deletion is bounded to the exact temporary directory created by this proof.
    assert.equal(path.dirname(absoluteRoot), path.resolve(tmpdir())); assert.ok(path.basename(absoluteRoot).startsWith('pc-backup-proof-'));
    await rm(absoluteRoot, { recursive: true, force: true });
  }
}
main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(JSON.stringify({ passedBeforeFailure: checks.length, checks, skipped, error: error.stack }, null, 2)); process.exitCode = 1; });
