import { performance } from 'node:perf_hooks';
import { HttpError, MAX_FILE_BYTES, validateName } from './workspace.mjs';

const grants = new WeakMap();
const reservations = new WeakMap();
const GRANT_KEYS = ['names', 'maxWrites', 'maxBytes', 'ttlMs'];
const WRITE_KEYS = ['name', 'bytes', 'argumentsDigest'];
export const DRAFT_GRANT_LIMITS = Object.freeze({ maxNames: 128, maxWrites: 100, maxBytes: 10 * 1024 * 1024, ttlMs: 60 * 60 * 1000 });
const MAX_DATE_MS = 8640000000000000;
const epochNow = () => Math.floor(performance.timeOrigin + performance.now());
const opaque = () => Object.freeze(Object.create(null));

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every(key => keys.includes(key)) && keys.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field?.enumerable === true && Object.hasOwn(field, 'value');
  });
}
function simpleName(value) {
  try { return validateName(value) === value; } catch { return false; }
}
function exactNames(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < 1 || value.length > DRAFT_GRANT_LIMITS.maxNames || Reflect.ownKeys(value).length !== value.length + 1) return null;
  const names = [];
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, 'value') || !simpleName(field.value)) return null;
    names.push(field.value);
  }
  return new Set(names).size === names.length ? names : null;
}
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function clock(state) {
  const value = state.now();
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) throw new TypeError('Draft grant clock must return valid integer epoch milliseconds.');
  // An injected clock moving backwards cannot revive an already expired grant.
  state.lastNow = Math.max(state.lastNow, value);
  return state.lastNow;
}
function invalidGrant() {
  const error = new HttpError(400, 'Draft grants require exact file names, a positive total byte limit, write count and TTL.');
  error.code = 'invalid_draft_grant';
  return error;
}
function denied(message = 'The draft write grant is unavailable or no longer permits this mutation.') {
  const error = new HttpError(409, message);
  error.code = 'draft_grant_denied';
  return error;
}
function mutation(value) {
  if (!exactRecord(value, WRITE_KEYS) || !simpleName(value.name) || !Number.isSafeInteger(value.bytes)
      || value.bytes < 0 || value.bytes > MAX_FILE_BYTES || typeof value.argumentsDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.argumentsDigest)) return null;
  return { name: value.name, bytes: value.bytes, argumentsDigest: value.argumentsDigest };
}
function sameMutation(left, right) {
  return left !== null && left.name === right.name && left.bytes === right.bytes && left.argumentsDigest === right.argumentsDigest;
}
function assertCurrent(state) {
  if (state.revoked || clock(state) >= state.expiresAt) throw denied();
}

/**
 * Create one in-memory capability for one run. The caller retains the opaque handle
 * on its active run ticket, never in persisted history or an HTTP response. Only
 * inspectDraftGrant's view is serializable; recreating that view grants nothing.
 *
 * Input is exactly { names, maxWrites, maxBytes, ttlMs }. maxBytes is the TOTAL
 * allowance across all reservations, including failed/abandoned writes. Names
 * are 1..128 unique, case-sensitive workspace basenames; no globs or paths.
 * Budgets are capped by DRAFT_GRANT_LIMITS at 100 writes, 10 MiB and one hour;
 * requests exceeding a cap are rejected, never silently enlarged or clamped.
 * Null/undefined means no grant. The optional clock is for deterministic tests.
 */
export function createDraftGrant(value, { now = epochNow } = {}) {
  if (value === null || value === undefined) return null;
  if (!exactRecord(value, GRANT_KEYS)) throw invalidGrant();
  const names = exactNames(value.names);
  if (!names || !positive(value.maxWrites) || !positive(value.maxBytes) || !positive(value.ttlMs)
      || value.maxWrites > DRAFT_GRANT_LIMITS.maxWrites || value.maxBytes > DRAFT_GRANT_LIMITS.maxBytes
      || value.ttlMs > DRAFT_GRANT_LIMITS.ttlMs) throw invalidGrant();
  if (typeof now !== 'function') throw new TypeError('Draft grant clock must be a function.');
  const state = {
    names, allowedNames: new Set(names), maxWrites: value.maxWrites, maxBytes: value.maxBytes,
    ttlMs: value.ttlMs, usedWrites: 0, usedBytes: 0, revoked: false, now, lastNow: 0,
  };
  state.createdAt = clock(state);
  state.expiresAt = state.createdAt + state.ttlMs;
  if (!Number.isSafeInteger(state.expiresAt) || state.expiresAt > MAX_DATE_MS) throw invalidGrant();
  const handle = opaque();
  grants.set(handle, state);
  return handle;
}

export function inspectDraftGrant(grant) {
  const state = grants.get(grant);
  if (!state) return null;
  const expired = clock(state) >= state.expiresAt;
  const remainingWrites = state.maxWrites - state.usedWrites;
  return {
    names: [...state.names], maxWrites: state.maxWrites, maxBytes: state.maxBytes, ttlMs: state.ttlMs,
    createdAt: new Date(state.createdAt).toISOString(), expiresAt: new Date(state.expiresAt).toISOString(),
    usedWrites: state.usedWrites, usedBytes: state.usedBytes, remainingWrites,
    remainingBytes: state.maxBytes - state.usedBytes, revoked: state.revoked, expired,
    status: state.revoked ? 'revoked' : expired ? 'expired' : remainingWrites === 0 ? 'exhausted' : 'active',
  };
}

export function revokeDraftGrant(grant) {
  const state = grants.get(grant);
  if (!state) return null;
  state.revoked = true;
  return inspectDraftGrant(grant);
}

/**
 * Reserve ONLY a staged workspace_write, after the caller has validated its tool
 * and version precondition. The descriptor is exactly { name, bytes,
 * argumentsDigest }; the digest must bind the actual content and precondition.
 * This synchronous operation returns an opaque reservation or false. It spends
 * count and total bytes immediately; no completion path or refund exists.
 */
export function approveDraftWrite(grant, value) {
  const state = grants.get(grant);
  const write = mutation(value);
  if (!state || !write || !state.allowedNames.has(write.name) || state.revoked || clock(state) >= state.expiresAt
      || state.usedWrites >= state.maxWrites || write.bytes > state.maxBytes - state.usedBytes) return false;
  state.usedWrites++;
  state.usedBytes += write.bytes;
  const ticket = opaque();
  reservations.set(ticket, { state, write, dispatched: false });
  return ticket;
}

/**
 * Begin exactly one dispatch using a reservation. Recompute the descriptor from
 * the concrete staged mutation here, including its argument digest. A mismatched,
 * revoked, expired or reused ticket throws a 409 draft_grant_denied error.
 *
 * Returns a repeatable assertActive() guard. Combine it with the run/observation
 * guard and supply it to artifacts.stage's atomic mutation boundary. Each call
 * rechecks expiry, revocation and the descriptor. The guard is for this one stage
 * operation; it does not authorize delete, accept/export, desktop or a second
 * dispatch. Keep the reservation and returned guard private to that dispatch.
 */
export function assertDraftWrite(grant, value, ticket) {
  const state = grants.get(grant);
  const reservation = reservations.get(ticket);
  if (!state || !reservation || reservation.state !== state || reservation.dispatched) throw denied();
  reservation.dispatched = true;
  if (!sameMutation(mutation(value), reservation.write)) throw denied('The staged mutation changed after draft grant approval.');
  assertCurrent(state);
  return () => {
    if (!sameMutation(mutation(value), reservation.write)) throw denied('The staged mutation changed after draft grant approval.');
    assertCurrent(state);
  };
}
