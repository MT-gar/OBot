#!/usr/bin/env node
// Portable, uncompressed directory bundles; no shell, tar, Docker or third-party dependency.
import { constants } from 'node:fs';
import { mkdir, lstat, realpath, readdir, open, rename, rm, rmdir, chmod, chown } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const BACKUP_VERSION = 1;
const FORMAT = 'private-computer-backup';
const MAX_ENTRIES = 100000;
const MAX_JSON = 16 * 1024 * 1024;
const MAX_FILE = 2 * 1024 ** 3;
const MAX_TOTAL = 100 * 1024 ** 3;
const OWNER_ROOT = 'control/owner-operations';
const OWNER_TEMPLATES = `${OWNER_ROOT}/templates.json`;
const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;
const ROOTS = ['home', 'control'];
const BROWSER_FILES = new Set(['Preferences', 'Bookmarks', 'Bookmarks.bak', 'Custom Dictionary']);
const PREF_KEYS = ['browser', 'bookmark_bar', 'homepage', 'homepage_is_newtabpage', 'intl', 'translate', 'download', 'printing', 'webkit', 'session'];
const profileName = value => /^(Default|Profile [1-9][0-9]*)$/.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const signature = st => `${st.dev}:${st.ino}:${st.mode}:${st.nlink}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
const fail = message => { throw new Error(message); };
async function stat(file) { try { return await lstat(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function inside(root, value) { const rel = path.relative(root, value); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); }
function disjoint(a, b) { if (inside(a, b) || inside(b, a)) fail('Backup, source and restore paths must be independent (not equal or nested).'); }
function component(value) {
  if (!value || value === '.' || value === '..' || /[\\/:\x00-\x1f\x7f<>"|?*]/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) fail('A path is not a portable relative path.');
}
function relative(value) { if (typeof value !== 'string' || Buffer.byteLength(value) > 2048) fail('Invalid manifest path.'); for (const part of value.split('/')) component(part); return value; }
function allowed(value, type) {
  if (ROOTS.includes(value)) return type === 'directory';
  if (value === 'home/Workspace') return type === 'directory';
  if (value.startsWith('home/Workspace/')) return true;
  if (value === 'home/.config' || value === 'home/.config/chromium') return type === 'directory';
  if (value === 'home/.config/chromium/Local State') return type === 'file';
  const parts = value.split('/');
  if (parts.slice(0, 3).join('/') === 'home/.config/chromium' && profileName(parts[3])) return parts.length === 4 ? type === 'directory' : parts.length === 5 && type === 'file' && BROWSER_FILES.has(parts[4]);
  if (value === 'control/state.json' || value === OWNER_TEMPLATES) return type === 'file';
  if (value === OWNER_ROOT) return type === 'directory';
  return ['runs', 'artifacts'].some(name => value === `control/${name}` ? type === 'directory' : value.startsWith(`control/${name}/`));
}
// Keep this portable validator aligned with owner-operations.mjs decodeTemplates.
// The helper mounts only this module, so it cannot depend on the application tree.
function validateOwnerTemplates(bytes) {
  try {
    if (bytes.length > MAX_TEMPLATE_BYTES) throw new Error();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const object = item => item !== null && typeof item === 'object' && !Array.isArray(item);
    if (!object(value) || Object.keys(value).length !== 2 || value.format !== 1 || !Array.isArray(value.templates) || value.templates.length > 100) throw new Error();
    const ids = new Set(); const names = new Set();
    for (const entry of value.templates) {
      if (!object(entry) || Object.keys(entry).length !== 4 || typeof entry.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.id)
          || typeof entry.name !== 'string' || !entry.name || entry.name.trim() !== entry.name || entry.name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(entry.name)
          || typeof entry.goal !== 'string' || !entry.goal || entry.goal.trim() !== entry.goal || entry.goal.length > 4000 || Buffer.byteLength(entry.goal) > 16000
          || typeof entry.createdAt !== 'string' || new Date(entry.createdAt).toISOString() !== entry.createdAt
          || ids.has(entry.id) || names.has(entry.name.toLowerCase())) throw new Error();
      ids.add(entry.id); names.add(entry.name.toLowerCase());
    }
  } catch { fail('Invalid owner template storage.'); }
}
function transformFor(value) { return value === 'home/.config/chromium/Local State' ? 'local-state' : /^home\/\.config\/chromium\/(Default|Profile [1-9][0-9]*)\/Preferences$/.test(value) ? 'preferences' : null; }
function sanitizeBrowser(bytes, kind) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid browser configuration JSON.');
  if (kind === 'preferences') return json(Object.fromEntries(PREF_KEYS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])));
  const result = {};
  if (Object.hasOwn(value, 'browser')) result.browser = value.browser;
  if (value.profile && typeof value.profile === 'object' && !Array.isArray(value.profile)) result.profile = Object.fromEntries(['last_used', 'last_active_profiles'].filter(key => Object.hasOwn(value.profile, key)).map(key => [key, value.profile[key]]));
  return json(result);
}
function attested(options) {
  if (options.writersStopped !== true) fail('Explicit stopped-writers attestation is required; stop control and desktop/browser first.');
  if (options.profileKeyPolicy !== 'external-relogin') fail('Explicit profileKeyPolicy external-relogin is required; credentials/OS keyring stay external.');
  if (options.privateRootAck !== true) fail('Explicit private-root acknowledgement is required (on Windows, restrict the directory ACL).');
}
async function directory(input, privateRoot = false) {
  if (typeof input !== 'string' || !input) fail('An explicit directory path is required.');
  const absolute = path.resolve(input); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const info = await stat(current);
    if (!info?.isDirectory() || info.isSymbolicLink()) fail('Directory paths must exist and have no symlink components.');
  }
  const resolved = await realpath(absolute); const info = await stat(resolved);
  if (privateRoot && process.platform !== 'win32' && (info.mode & 0o077n) !== 0n) fail('Backup/restore parent must be private (chmod 700).');
  return resolved;
}
async function syncDirectory(value) {
  let handle; try { handle = await open(value, constants.O_RDONLY); await handle.sync(); }
  catch (error) { if (!['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}
async function writePrivate(file, bytes) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
// The descriptor and pathname must retain the same identity throughout each read.
async function readStable(source, { destination, expected, transform, maxBytes = MAX_FILE } = {}) {
  const before = await stat(source);
  if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxBytes)) fail('Only bounded, regular, unlinked files may be copied.');
  if (expected && !transform && before.size !== BigInt(expected.bytes)) fail('Payload checksum/size mismatch.');
  let input; let output; const digest = createHash('sha256'); let bytes = 0;
  try {
    input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (signature(await input.stat({ bigint: true })) !== signature(before)) fail('Source changed while opening.');
    if (destination) output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, (before.mode & 0o100n) ? 0o700 : 0o600);
    async function consume(chunk) {
      bytes += chunk.length; if (bytes > maxBytes) fail('Source exceeds the supported file size.'); digest.update(chunk);
      if (output) { let offset = 0; while (offset < chunk.length) { const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset); if (!bytesWritten) fail('Incomplete destination write.'); offset += bytesWritten; } }
    }
    if (transform) {
      if (before.size > BigInt(MAX_JSON)) fail('Browser JSON exceeds the supported size.');
      await consume(sanitizeBrowser(await input.readFile(), transform));
    } else {
      const buffer = Buffer.alloc(1024 * 1024);
      while (true) { const { bytesRead } = await input.read(buffer, 0, buffer.length); if (!bytesRead) break; await consume(buffer.subarray(0, bytesRead)); }
    }
    if (signature(await input.stat({ bigint: true })) !== signature(before) || signature(await stat(source) ?? {}) !== signature(before)) fail('Source changed during the snapshot.');
    const sha256 = digest.digest('hex');
    if (expected && (expected.bytes !== bytes || expected.sha256 !== sha256)) fail('Payload checksum/size mismatch.');
    if (output) { await output.chmod(expected?.mode ?? ((before.mode & 0o100n) ? 0o700 : 0o600)); await output.sync(); }
    return { bytes, sha256 };
  } finally { await output?.close(); await input?.close(); }
}
async function smallFile(file, maxBytes = MAX_JSON) {
  const info = await stat(file); if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > BigInt(maxBytes)) fail('Invalid metadata file.');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const bytes = await handle.readFile(); if (signature(await handle.stat({ bigint: true })) !== signature(info) || signature(await stat(file) ?? {}) !== signature(info)) fail('Metadata changed while reading.'); return bytes; }
  finally { await handle.close(); }
}
async function sourceEntries(home, control) {
  const entries = []; const names = new Set();
  async function add(source, logical, recursive = false) {
    relative(logical); const info = await stat(source);
    if (!info || info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1n)) fail('Selected source contains a symlink, hardlink or special file.');
    const key = logical.toLowerCase().normalize('NFC');
    if (names.has(key)) fail('Source paths collide on a case-insensitive filesystem.'); names.add(key);
    if (entries.length >= MAX_ENTRIES) fail('Too many backup entries.');
    entries.push({ source, path: logical, type: info.isDirectory() ? 'directory' : 'file', mode: info.isDirectory() ? 0o700 : (info.mode & 0o100n) ? 0o700 : 0o600, signature: signature(info) });
    if (recursive && info.isDirectory()) for (const name of (await readdir(source)).sort()) {
      const controllerTemporary = logical === 'control/runs' && /^[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp$/i.test(name);
      const artifactTemporary = logical.startsWith('control/artifacts/') && /^\.pending-[0-9a-f-]{36}$/i.test(name);
      if (controllerTemporary || artifactTemporary) continue;
      await add(path.join(source, name), `${logical}/${name}`, true);
    }
  }
  await add(home, 'home'); await add(path.join(home, 'Workspace'), 'home/Workspace', true);
  const config = path.join(home, '.config'); const browser = path.join(config, 'chromium');
  await add(config, 'home/.config'); await add(browser, 'home/.config/chromium');
  for (const name of (await readdir(browser)).sort()) {
    if (name === 'Local State') await add(path.join(browser, name), `home/.config/chromium/${name}`);
    else if (profileName(name)) {
      const profile = path.join(browser, name); await add(profile, `home/.config/chromium/${name}`);
      for (const filename of (await readdir(profile)).sort()) if (BROWSER_FILES.has(filename)) await add(path.join(profile, filename), `home/.config/chromium/${name}/${filename}`);
    }
  }
  await add(control, 'control');
  for (const name of (await readdir(control)).sort()) {
    if (name === '.restore-complete.json' || /^state\.json\.[0-9a-f-]{36}\.tmp$/i.test(name)) continue;
    if (!['state.json', 'runs', 'artifacts', 'owner-operations'].includes(name)) fail('Unsupported control layout; keep credentials and temporary runtime data outside control-state.');
    if (name === 'owner-operations') {
      const root = path.join(control, name);
      if (!(await stat(root))?.isDirectory()) fail('Unsupported owner template layout.');
      await add(root, OWNER_ROOT);
      for (const filename of (await readdir(root)).sort()) {
        if (/^\.pending-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(filename)) continue;
        if (filename !== 'templates.json') fail('Unsupported owner template layout; only templates.json is persistent.');
        const source = path.join(root, filename); await add(source, OWNER_TEMPLATES);
        validateOwnerTemplates(await smallFile(source, MAX_TEMPLATE_BYTES));
      }
    } else await add(path.join(control, name), `control/${name}`, true);
  }
  const state = JSON.parse((await smallFile(path.join(control, 'state.json'))).toString('utf8'));
  if (state.version !== 1) fail('Unsupported control-state version; migrate with the matching application before backup.');
  return entries;
}
async function unchanged(entries) { for (const entry of entries) if (signature(await stat(entry.source) ?? {}) !== entry.signature) fail('A source changed during the stopped-writer snapshot; no bundle was published.'); }
async function reserve(destination, independentOf = []) {
  if (typeof destination !== 'string' || !destination) fail('An explicit destination directory is required.');
  const absolute = path.resolve(destination); component(path.basename(absolute)); const parent = await directory(path.dirname(absolute), true);
  const target = path.join(parent, path.basename(absolute)); for (const other of independentOf) disjoint(target, other);
  if (await stat(target)) fail('Destination already exists; overwrites are forbidden.');
  const lock = path.join(parent, `.${path.basename(target)}.lock`); await mkdir(lock, { mode: 0o700 });
  const stage = path.join(parent, `.${path.basename(target)}.pending-${randomUUID()}`);
  try { if (await stat(target)) fail('Destination already exists.'); await mkdir(stage, { mode: 0o700 }); }
  catch (error) { await rmdir(lock); throw error; }
  return { target, stage, parent, lock };
}
async function discard(reservation) {
  // Only the generated, same-parent staging path owned by this operation is removable.
  if (path.dirname(reservation.stage) !== reservation.parent || !path.basename(reservation.stage).startsWith(`.${path.basename(reservation.target)}.pending-`)) fail('Invalid staging cleanup path.');
  await rm(reservation.stage, { recursive: true, force: true }); await rmdir(reservation.lock);
}
async function publish(reservation) {
  if (await stat(reservation.target)) fail('Destination appeared before publish; refusing overwrite.');
  await syncDirectory(reservation.stage); await rename(reservation.stage, reservation.target); await syncDirectory(reservation.parent);
}
export async function createBackup(options) {
  attested(options);
  const home = await directory(options.home); const control = await directory(options.control); disjoint(home, control);
  const sourceVersion = options.sourceVersion;
  if (typeof sourceVersion !== 'string' || !sourceVersion.trim() || sourceVersion.length > 200 || /[\r\n]/.test(sourceVersion)) fail('An explicit sourceVersion (revision/build identity) is required.');
  const startedAt = new Date().toISOString(); const entries = await sourceEntries(home, control);
  const reserved = await reserve(options.destination, [home, control]);
  try {
    const payload = path.join(reserved.stage, 'payload'); await mkdir(payload, { mode: 0o700 }); const manifestEntries = []; let total = 0;
    for (const entry of entries) {
      const target = path.join(payload, ...entry.path.split('/'));
      if (entry.type === 'directory') { await mkdir(target, { mode: 0o700 }); manifestEntries.push({ path: entry.path, type: entry.type, mode: 0o700 }); }
      else { const checked = await readStable(entry.source, { destination: target, transform: transformFor(entry.path) }); total += checked.bytes; if (total > MAX_TOTAL) fail('Backup size limit exceeded.'); manifestEntries.push({ path: entry.path, type: entry.type, mode: entry.mode, ...checked }); }
    }
    await unchanged(entries);
    const manifest = { format: FORMAT, version: BACKUP_VERSION, createdAt: new Date().toISOString(), source: { version: sourceVersion, project: options.project ?? null, node: process.version }, schemas: { controlState: 1, browserConfig: 1, ownerTemplates: 1 }, consistency: { strategy: 'stopped-writers', startedAt, completedAt: new Date().toISOString(), sourceRechecked: true }, policy: { profileKeys: 'external-relogin', applicationCredentials: 'external-not-included', browserAuthentication: 'excluded-relogin', browserConfiguration: 'allowlisted-settings-bookmarks-v1' }, totalBytes: total, entries: manifestEntries };
    validateManifest(manifest);
    const bytes = json(manifest); if (bytes.length > MAX_JSON) fail('Manifest size limit exceeded.');
    await writePrivate(path.join(reserved.stage, 'manifest.json'), bytes);
    await writePrivate(path.join(reserved.stage, 'manifest.sha256'), Buffer.from(`${hash(bytes)}  manifest.json\n`));
    for (const entry of [...manifestEntries].reverse()) if (entry.type === 'directory') await syncDirectory(path.join(payload, ...entry.path.split('/')));
    await syncDirectory(payload);
    await verifyBackup({ backup: reserved.stage }); await unchanged(entries);
    if (options.uid !== undefined || options.gid !== undefined) {
      const uid = Number(options.uid); const gid = Number(options.gid);
      if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 0 || gid < 0 || process.platform === 'win32') fail('Invalid backup ownership.');
      for (const entry of [...manifestEntries].reverse()) await chown(path.join(payload, ...entry.path.split('/')), uid, gid);
      for (const target of [path.join(reserved.stage, 'manifest.json'), path.join(reserved.stage, 'manifest.sha256'), payload, reserved.stage]) await chown(target, uid, gid);
    }
    await publish(reserved);
    return { backup: reserved.target, manifestSha256: hash(bytes), entries: manifestEntries.length, bytes: total };
  } finally { await discard(reserved); }
}
function validateManifest(value) {
  if (value?.format !== FORMAT || value.version !== BACKUP_VERSION) fail('Unsupported backup format/version.');
  if (value.schemas?.controlState !== 1 || value.schemas?.browserConfig !== 1 || (value.schemas.ownerTemplates !== undefined && value.schemas.ownerTemplates !== 1)) fail('Unsupported backup data schema.');
  if (value.consistency?.strategy !== 'stopped-writers' || value.consistency.sourceRechecked !== true || value.policy?.profileKeys !== 'external-relogin' || value.policy.browserAuthentication !== 'excluded-relogin' || value.policy.applicationCredentials !== 'external-not-included' || value.policy.browserConfiguration !== 'allowlisted-settings-bookmarks-v1') fail('Unsupported consistency or credential policy.');
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) fail('Invalid backup entry list.');
  const paths = new Map(); const folded = new Set(); let total = 0;
  for (const entry of value.entries) {
    relative(entry.path); const key = entry.path.toLowerCase().normalize('NFC');
    if (folded.has(key) || !['file', 'directory'].includes(entry.type) || !allowed(entry.path, entry.type)) fail('Duplicate, conflicting or out-of-scope manifest path.');
    folded.add(key); paths.set(entry.path, entry);
    if (entry.type === 'directory') { if (entry.mode !== 0o700) fail('Invalid directory permissions.'); }
    else {
      if (![0o600, 0o700].includes(entry.mode) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail('Invalid file metadata.');
      if (entry.path === OWNER_TEMPLATES && entry.bytes > MAX_TEMPLATE_BYTES) fail('Invalid owner template storage.');
      total += entry.bytes; if (total > MAX_TOTAL) fail('Backup size limit exceeded.');
    }
  }
  for (const entry of value.entries) { const parent = path.posix.dirname(entry.path); if (parent !== '.' && paths.get(parent)?.type !== 'directory') fail('Manifest is missing a directory parent.'); }
  if (paths.has(OWNER_ROOT) && value.schemas.ownerTemplates !== 1) fail('Unsupported owner template schema.');
  for (const name of ['home', 'home/Workspace', 'home/.config', 'home/.config/chromium', 'control', 'control/state.json']) if (!paths.has(name)) fail('Backup is missing a required root/state.');
  if (total !== value.totalBytes) fail('Manifest total size mismatch.');
}
async function inventory(root) {
  const result = new Map();
  async function walk(directoryName, prefix = '') {
    for (const name of (await readdir(directoryName)).sort()) {
      const logical = prefix ? `${prefix}/${name}` : name; relative(logical); const absolute = path.join(directoryName, name); const info = await stat(absolute);
      if (!info || info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1n)) fail('Payload contains a symlink, hardlink or special file.');
      if (result.size >= MAX_ENTRIES) fail('Too many payload entries.'); result.set(logical, { absolute, type: info.isDirectory() ? 'directory' : 'file' });
      if (info.isDirectory()) await walk(absolute, logical);
    }
  }
  await walk(root); return result;
}
export async function verifyBackup({ backup }) {
  const root = await directory(backup);
  const top = (await readdir(root)).sort(); if (top.join('|') !== 'manifest.json|manifest.sha256|payload') fail('Unexpected or incomplete bundle contents.');
  const bytes = await smallFile(path.join(root, 'manifest.json')); const manifestSha256 = hash(bytes);
  if ((await smallFile(path.join(root, 'manifest.sha256'))).toString('utf8') !== `${manifestSha256}  manifest.json\n`) fail('Manifest checksum mismatch.');
  const manifest = JSON.parse(bytes.toString('utf8')); validateManifest(manifest);
  const payload = await directory(path.join(root, 'payload')); const actual = await inventory(payload);
  if (actual.size !== manifest.entries.length) fail('Payload inventory mismatch.');
  for (const entry of manifest.entries) {
    const item = actual.get(entry.path); if (item?.type !== entry.type) fail('Missing or mismatched payload entry.');
    if (entry.type === 'file') {
      await readStable(item.absolute, { expected: entry });
      const transform = transformFor(entry.path);
      if (transform) { const data = await smallFile(item.absolute); if (!data.equals(sanitizeBrowser(data, transform))) fail('Browser payload contains unsupported settings or key material.'); }
      if (entry.path === OWNER_TEMPLATES) validateOwnerTemplates(await smallFile(item.absolute, MAX_TEMPLATE_BYTES));
    }
  }
  const state = JSON.parse((await smallFile(path.join(payload, 'control', 'state.json'))).toString('utf8')); if (state.version !== 1) fail('Unsupported restored control-state version.');
  return { root, manifest, manifestSha256 };
}
async function extract(verified, roots, ownership) {
  const directories = verified.manifest.entries.filter(entry => entry.type === 'directory').sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  const targetFor = value => { const [root, ...parts] = value.split('/'); return path.join(roots[root], ...parts); };
  for (const entry of directories) { const target = targetFor(entry.path); if (!ROOTS.includes(entry.path)) await mkdir(target, { mode: 0o700 }); else await chmod(target, 0o700); }
  for (const entry of verified.manifest.entries.filter(item => item.type === 'file')) await readStable(path.join(verified.root, 'payload', ...entry.path.split('/')), { destination: targetFor(entry.path), expected: entry });
  if (ownership) for (const entry of [...verified.manifest.entries].reverse()) await chown(targetFor(entry.path), ownership.uid, ownership.gid);
  for (const entry of directories.reverse()) await syncDirectory(targetFor(entry.path));
  if (hash(await smallFile(path.join(verified.root, 'manifest.json'))) !== verified.manifestSha256) fail('Backup manifest changed during restore.');
}
export async function restoreBackup(options) {
  attested(options); const verified = await verifyBackup({ backup: options.backup });
  const reserved = await reserve(options.destination, [verified.root]);
  try {
    const roots = Object.fromEntries(ROOTS.map(name => [name, path.join(reserved.stage, name)])); for (const value of Object.values(roots)) await mkdir(value, { mode: 0o700 });
    await extract(verified, roots);
    const receipt = { format: 'private-computer-restore', version: 1, manifestSha256: verified.manifestSha256, completedAt: new Date().toISOString(), authentication: 'relogin-required', resumedOperations: false };
    await writePrivate(path.join(reserved.stage, 'restore-receipt.json'), json(receipt)); await publish(reserved);
    return { destination: reserved.target, ...receipt };
  } finally { await discard(reserved); }
}
// Docker volume mount roots cannot be renamed. Only empty, unused volumes are accepted;
// both completion markers are written after the entire pair is verified and copied.
export async function restoreVolumes(options) {
  attested(options); const verified = await verifyBackup({ backup: options.backup });
  const home = await directory(options.home); const control = await directory(options.control); disjoint(home, control); disjoint(home, verified.root); disjoint(control, verified.root);
  if ((await readdir(home)).length || (await readdir(control)).length) fail('Volume restore requires two empty target roots.');
  let ownership;
  if (options.uid !== undefined || options.gid !== undefined) {
    const uid = Number(options.uid); const gid = Number(options.gid);
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 0 || gid < 0 || process.platform === 'win32') fail('Invalid restore ownership.'); ownership = { uid, gid };
  }
  await extract(verified, { home, control }, ownership);
  const receipt = { format: 'private-computer-volume-restore', version: 1, transaction: randomUUID(), manifestSha256: verified.manifestSha256, completedAt: new Date().toISOString(), authentication: 'relogin-required', resumedOperations: false };
  for (const root of [home, control]) { const marker = path.join(root, '.restore-complete.json'); await writePrivate(marker, json(receipt)); if (ownership) await chown(marker, ownership.uid, ownership.gid); await syncDirectory(root); }
  return receipt;
}
const HELP = `Usage (Node 22+, no default paths):
  node scripts/backup.mjs create --home DIR --control DIR --destination NEW_DIR --source-version REVISION --writers-stopped --profile-key-policy external-relogin --private-root-ack
  node scripts/backup.mjs verify --backup BUNDLE_DIR
  node scripts/backup.mjs restore --backup BUNDLE_DIR --destination NEW_DIR --writers-stopped --profile-key-policy external-relogin --private-root-ack
  node scripts/backup.mjs restore-volumes --backup BUNDLE_DIR --home EMPTY_DIR --control EMPTY_DIR --writers-stopped --profile-key-policy external-relogin --private-root-ack [--uid 1100 --gid 1100]
Backup and restore parents must already exist, be private, and be independent of source/bundle paths.
Browser settings/bookmarks are preserved; OS keys, account/session/password stores are excluded. Re-login is required.
Stopped-writers is an operator attestation in this portable CLI; backup-compose.sh enforces stopped Docker users.
`;
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { home: { type: 'string' }, control: { type: 'string' }, destination: { type: 'string' }, backup: { type: 'string' }, project: { type: 'string' }, 'source-version': { type: 'string' }, 'writers-stopped': { type: 'boolean' }, 'profile-key-policy': { type: 'string' }, 'private-root-ack': { type: 'boolean' }, uid: { type: 'string' }, gid: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help || !positionals.length) { console.log(HELP); return; }
  if (positionals.length !== 1) fail('Exactly one command is required.');
  const options = { ...values, sourceVersion: values['source-version'], writersStopped: values['writers-stopped'], profileKeyPolicy: values['profile-key-policy'], privateRootAck: values['private-root-ack'] };
  const commands = { create: createBackup, verify: verifyBackup, restore: restoreBackup, 'restore-volumes': restoreVolumes };
  if (!commands[positionals[0]]) fail('Unknown command; use --help.');
  const result = await commands[positionals[0]](options);
  console.log(JSON.stringify(positionals[0] === 'verify' ? { valid: true, version: result.manifest.version, manifestSha256: result.manifestSha256, entries: result.manifest.entries.length, bytes: result.manifest.totalBytes } : result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(`Backup error: ${error.message}`); process.exitCode = 1; });
