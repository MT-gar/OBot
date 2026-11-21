import { constants } from 'node:fs';
import { mkdir, open, readdir, lstat, realpath, rename, unlink, link } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function fileChanged(message = 'File changed since the operation was approved.') {
  const error = new HttpError(409, message); error.code = 'file_changed'; return error;
}
export function validateName(name) {
  if (typeof name !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}_. -]{0,127}$/u.test(name)
      || name.includes('..') || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new HttpError(400, 'Use a single simple file name without path separators or consecutive dots.');
  }
  return name;
}
export function decodeFile(contentBase64) {
  if (typeof contentBase64 !== 'string' || contentBase64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) {
    throw new HttpError(413, 'File exceeds 5 MiB.');
  }
  const paddingAt = contentBase64.indexOf('=');
  if (contentBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(contentBase64)
      || (paddingAt !== -1 && (paddingAt < contentBase64.length - 2 || !/^={1,2}$/.test(contentBase64.slice(paddingAt))))) {
    throw new HttpError(400, 'contentBase64 must be canonical base64.');
  }
  const content = Buffer.from(contentBase64, 'base64');
  if (content.length > MAX_FILE_BYTES) throw new HttpError(413, 'File exceeds 5 MiB.');
  if (content.toString('base64') !== contentBase64) throw new HttpError(400, 'Invalid base64.');
  return content;
}
export function sha256(content) { return createHash('sha256').update(content).digest('hex'); }
export function fileContent(content) {
  const bytes = Buffer.from(content);
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, 'File exceeds 5 MiB.');
  return bytes;
}
const locks = new Map();
function serialized(root, operation) {
  const prior = locks.get(root) ?? Promise.resolve();
  const result = prior.then(operation, operation);
  const settled = result.then(() => {}, () => {});
  locks.set(root, settled);
  settled.then(() => { if (locks.get(root) === settled) locks.delete(root); });
  return result;
}
function identity(st) { return `${st.dev}:${st.ino}`; }
function signature(st) { return `${identity(st)}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`; }
function safeFile(st) {
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1n) throw new HttpError(400, 'Symbolic links, hard links and special files are not allowed.');
}
function mapFileError(error) {
  if (['ELOOP', 'EISDIR', 'ENXIO', 'ENOTDIR'].includes(error.code)) return new HttpError(400, 'Symbolic links and special files are not allowed.');
  return error;
}
// Directory fsync is supported on Linux. Windows rejects opening/syncing a directory;
// file fsync + atomic directory-entry operations still apply there.
export async function syncDirectory(directory) {
  let handle;
  try { handle = await open(directory, constants.O_RDONLY); await handle.sync(); }
  catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EACCES', 'EINVAL'].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}

export async function createWorkspace(directory) {
  const requested = path.resolve(directory);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const initial = await lstat(requested, { bigint: true });
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error('Workspace must be a real directory.');
  const root = await realpath(requested);
  const initialIdentity = identity(initial);
  const lockKey = process.platform === 'win32' ? root.toLowerCase() : root;
  function target(name) { return path.join(root, validateName(name)); }
  async function assertRoot() {
    const current = await lstat(root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || identity(current) !== initialIdentity || await realpath(root) !== root) throw fileChanged('Workspace directory changed.');
  }
  async function readAt(filename, name, { missing = true } = {}) {
    let handle;
    try {
      const before = await lstat(filename, { bigint: true }); safeFile(before);
      if (before.size > BigInt(MAX_FILE_BYTES)) throw new HttpError(413, 'File exceeds 5 MiB.');
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat({ bigint: true }); safeFile(opened);
      if (signature(before) !== signature(opened)) throw fileChanged();
      const content = Buffer.alloc(Number(opened.size));
      let offset = 0;
      while (offset < content.length) {
        const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
        if (!bytesRead) throw fileChanged();
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const atPath = await lstat(filename, { bigint: true }); safeFile(atPath);
      if (signature(opened) !== signature(after) || signature(after) !== signature(atPath)) throw fileChanged();
      const hash = sha256(content);
      return { name, content, sha256: hash, bytes: content.length, size: content.length, modifiedAt: new Date(Number(after.mtimeMs)).toISOString(), version: `sha256:${hash}:${sha256(signature(after))}`, identity: identity(after), mtimeNs: String(after.mtimeNs) };
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (handle) throw fileChanged();
        if (missing) return { name, content: null, sha256: null, bytes: 0, size: 0, version: 'missing' };
        throw new HttpError(404, 'File not found.');
      }
      throw mapFileError(error);
    } finally { await handle?.close(); }
  }
  async function snapshotUnlocked(name) { await assertRoot(); return readAt(target(name), name); }
  async function snapshot(name) { validateName(name); return serialized(lockKey, () => snapshotUnlocked(name)); }
  async function list() {
    return serialized(lockKey, async () => {
      await assertRoot();
      const files = [];
      for (const name of await readdir(root)) {
        try {
          validateName(name);
          const st = await lstat(target(name));
          if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) continue;
          // Keep the legacy owner listing usable for files larger than the tool limit.
          if (st.size > MAX_FILE_BYTES) { files.push({ name, size: st.size, modifiedAt: st.mtime.toISOString() }); continue; }
          const item = await readAt(target(name), name);
          if (item.content !== null) files.push({ name, size: item.bytes, modifiedAt: item.modifiedAt, version: item.version, sha256: item.sha256 });
        } catch (error) { if (!['ENOENT', 'ELOOP'].includes(error.code) && !(error instanceof HttpError && [400, 409].includes(error.status))) throw error; }
      }
      return files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });
  }
  async function compareAndSwap(name, content, { expectedVersion, assertActive = () => {}, beforeChange = async () => {}, onDisplaced = async () => { throw fileChanged('Concurrent file is retained in the workspace for recovery.'); } } = {}) {
    validateName(name); const bytes = content === null ? null : fileContent(content);
    return serialized(lockKey, async () => {
      await assertActive();
      const before = await snapshotUnlocked(name);
      if (expectedVersion !== undefined && before.version !== expectedVersion) throw fileChanged();
      await beforeChange(before);
      await assertActive();
      const checked = await snapshotUnlocked(name);
      if (checked.version !== before.version) throw fileChanged();
      const suffix = randomUUID();
      const temporary = path.join(root, `.pending-${suffix}`);
      const displaced = path.join(root, `.displaced-${suffix}`);
      const destination = target(name);
      let temporaryExists = false; let displacedExists = false; let committed = false; let prepared; let displacedRetained = false;
      try {
        if (bytes !== null) {
          const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          temporaryExists = true;
          try { await handle.writeFile(bytes); await handle.sync(); prepared = await handle.stat({ bigint: true }); } finally { await handle.close(); }
        }
        await assertActive(); await assertRoot();
        if (before.content !== null) {
          // Moving aside first prevents a path swap from destroying either side. Verify
          // the captured inode + content because external writers do not use our lock.
          await rename(destination, displaced); displacedExists = true;
          let captured;
          try { captured = await readAt(displaced, name, { missing: false }); }
          catch (error) { throw fileChanged('File changed during acceptance; displaced data is retained for recovery.'); }
          if (captured.sha256 !== before.sha256 || captured.identity !== before.identity || captured.mtimeNs !== before.mtimeNs) {
            await onDisplaced(captured);
            throw fileChanged('File changed during acceptance; both versions are retained.');
          }
        }
        await assertActive(); await assertRoot();
        if (bytes !== null) {
          // link() is an atomic no-clobber installation on the same filesystem. A
          // concurrent external create produces EEXIST instead of an overwrite.
          try { await link(temporary, destination); } catch (error) { if (error.code === 'EEXIST') throw fileChanged(); throw error; }
          await unlink(temporary); temporaryExists = false;
        } else {
          try { await lstat(destination); throw fileChanged(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        committed = true;
        await syncDirectory(root);
        const applied = await snapshotUnlocked(name);
        if (bytes === null ? applied.content !== null : applied.sha256 !== sha256(bytes) || applied.identity !== identity(prepared) || applied.mtimeNs !== String(prepared.mtimeNs)) throw fileChanged('File changed during the workspace operation.');
        if (displacedExists) {
          const retained = await readAt(displaced, name, { missing: false });
          if (retained.sha256 !== before.sha256 || retained.mtimeNs !== before.mtimeNs) {
            await onDisplaced(retained, { expectedVersion: applied.version });
            displacedRetained = true;
            throw fileChanged('An external writer changed the displaced file; its version is retained for recovery.');
          }
          displacedRetained = true;
        }
        return applied;
      } catch (error) {
        if (displacedExists && !committed) {
          // Restore only into a vacant name. If someone created a new file, keep
          // it and retain the displaced version through the recovery callback.
          try { await link(displaced, destination); await unlink(displaced); displacedExists = false; }
          catch (restoreError) {
            if (restoreError.code !== 'EEXIST') throw restoreError;
            try { await onDisplaced(await readAt(displaced, name, { missing: false })); await unlink(displaced); displacedExists = false; }
            catch { /* Leave the hidden displaced file intact if durable retention fails. */ }
          }
          await syncDirectory(root);
        }
        throw mapFileError(error);
      } finally {
        if (temporaryExists) await unlink(temporary).catch(() => {});
        if (displacedExists && committed && displacedRetained) await unlink(displaced);
        if (committed) await syncDirectory(root);
      }
    });
  }
  async function write(name, content) { await compareAndSwap(name, content); }
  async function download(name) {
    const result = await snapshot(name);
    if (result.content === null) throw new HttpError(404, 'File not found.');
    return result.content;
  }
  return { root, list, write, download, snapshot, version: async name => (await snapshot(name)).version, compareAndSwap };
}
