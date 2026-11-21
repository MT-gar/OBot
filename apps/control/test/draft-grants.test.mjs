import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FILE_BYTES } from '../src/workspace.mjs';
import {
  DRAFT_GRANT_LIMITS, createDraftGrant, inspectDraftGrant, revokeDraftGrant, approveDraftWrite, assertDraftWrite,
} from '../src/draft-grants.mjs';

const digest = 'a'.repeat(64);
const write = (values = {}) => ({ name: 'report.md', bytes: 4, argumentsDigest: digest, ...values });
const settings = (values = {}) => ({ names: ['report.md'], maxWrites: 3, maxBytes: 12, ttlMs: 100, ...values });
const invalid = { status: 400, code: 'invalid_draft_grant' };
const denied = { status: 409, code: 'draft_grant_denied' };
function fixture(values = {}) {
  let now = 1000;
  const grant = createDraftGrant(settings(values), { now: () => now });
  return { grant, at(value) { now = value; }, view: () => inspectDraftGrant(grant) };
}

test('grant handles are opaque, optional and ephemeral; only the inspection view serializes', () => {
  assert.equal(createDraftGrant(), null);
  assert.equal(createDraftGrant(null), null);
  const input = settings();
  const grant = createDraftGrant(input, { now: () => 1000 });
  assert.equal(Object.isFrozen(grant), true);
  assert.equal(Object.getPrototypeOf(grant), null);
  assert.equal(JSON.stringify(grant), '{}');
  assert.deepEqual(inspectDraftGrant(grant), {
    names: ['report.md'], maxWrites: 3, maxBytes: 12, ttlMs: 100,
    createdAt: '1970-01-01T00:00:01.000Z', expiresAt: '1970-01-01T00:00:01.100Z',
    usedWrites: 0, usedBytes: 0, remainingWrites: 3, remainingBytes: 12,
    revoked: false, expired: false, status: 'active',
  });
  input.names.push('other.md'); input.maxBytes = 1000;
  const view = inspectDraftGrant(grant);
  view.names.push('another.md'); view.remainingBytes = 1000;
  assert.deepEqual(inspectDraftGrant(grant).names, ['report.md']);
  assert.equal(inspectDraftGrant(grant).maxBytes, 12);
  assert.equal(approveDraftWrite(grant, write({ name: 'other.md' })), false);
  for (const copy of [JSON.parse(JSON.stringify(grant)), structuredClone(grant), JSON.parse(JSON.stringify(view))]) {
    assert.equal(inspectDraftGrant(copy), null);
    assert.equal(approveDraftWrite(copy, write()), false);
  }
});

test('configuration requires a closed exact schema and finite positive budgets', () => {
  for (const value of [false, true, 1, 'all', [], {}, { ...settings(), desktop: true }, { ...settings(), operation: 'delete' }, { ...settings(), prefix: 'report' }, { ...settings(), [Symbol('scope')]: true }]) {
    assert.throws(() => createDraftGrant(value), invalid);
  }
  for (const key of ['maxWrites', 'maxBytes', 'ttlMs']) {
    for (const value of [undefined, null, false, 0, -1, 0.5, NaN, Infinity, -Infinity, '10', 1n, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => createDraftGrant(settings({ [key]: value })), invalid);
    }
    const missing = settings(); delete missing[key];
    assert.throws(() => createDraftGrant(missing), invalid);
  }
  const inherited = Object.create(settings());
  assert.throws(() => createDraftGrant(inherited), invalid);
  const accessor = settings();
  Object.defineProperty(accessor, 'maxBytes', { enumerable: true, get() { throw new Error('must not read accessor'); } });
  assert.throws(() => createDraftGrant(accessor), invalid);
  assert.throws(() => createDraftGrant(settings({ ttlMs: Number.MAX_SAFE_INTEGER }), { now: () => 1000 }), invalid);
  assert.throws(() => createDraftGrant(settings(), { now: () => Infinity }), TypeError);
});

test('grant caps accept exact limits and reject any over-limit value', () => {
  assert.equal(Object.isFrozen(DRAFT_GRANT_LIMITS), true);
  const grant = createDraftGrant(settings({
    names: Array.from({ length: DRAFT_GRANT_LIMITS.maxNames }, (_, index) => `file-${index}.md`),
    maxWrites: DRAFT_GRANT_LIMITS.maxWrites, maxBytes: DRAFT_GRANT_LIMITS.maxBytes, ttlMs: DRAFT_GRANT_LIMITS.ttlMs,
  }), { now: () => 1000 });
  const view = inspectDraftGrant(grant);
  assert.equal(view.names.length, DRAFT_GRANT_LIMITS.maxNames);
  for (const key of ['maxWrites', 'maxBytes', 'ttlMs']) {
    assert.equal(view[key], DRAFT_GRANT_LIMITS[key]);
    assert.throws(() => createDraftGrant(settings({ [key]: DRAFT_GRANT_LIMITS[key] + 1 })), invalid);
  }
  assert.throws(() => createDraftGrant(settings(), { now: () => 8640000000000000 }), invalid);
});

test('names are bounded unique exact resource basenames without paths or patterns', () => {
  const invalidNames = [undefined, null, [], 'report.md', ['report.md', 'report.md'], Array(1),
    ['*'], ['report*'], ['../secret'], ['a/b'], ['a\\b'], ['a..b'], ['.hidden'],
    ['nul.txt'], ['CON'], ['report.'], ['report '], [1], ['a'.repeat(129)],
    Array.from({ length: 129 }, (_, index) => `file-${index}.md`)];
  for (const names of invalidNames) assert.throws(() => createDraftGrant(settings({ names })), invalid);
  const accessor = ['report.md'];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { throw new Error('must not read name accessor'); } });
  assert.throws(() => createDraftGrant(settings({ names: accessor })), invalid);
  const withExtra = ['report.md']; withExtra.all = true;
  assert.throws(() => createDraftGrant(settings({ names: withExtra })), invalid);
  const { grant } = fixture({ names: ['Report.md', '报告.md'], maxWrites: 4, maxBytes: 16 });
  for (const name of ['report.md', 'REPORT.MD', 'other.md', 'Report.md/other', '*']) {
    assert.equal(approveDraftWrite(grant, write({ name })), false);
  }
  assert.ok(approveDraftWrite(grant, write({ name: 'Report.md' })));
  assert.ok(approveDraftWrite(grant, write({ name: '报告.md' })));
  const boundary = createDraftGrant(settings({ names: Array.from({ length: 128 }, (_, index) => `file-${index}.md`) }));
  assert.equal(inspectDraftGrant(boundary).names.length, 128);
});

test('nonmatching, scope-like and malformed mutations fail closed without spending quota', () => {
  const { grant, view } = fixture();
  for (const value of [undefined, null, true, 4, [], {}, { name: 'report.md', bytes: 4 },
    { ...write(), toolName: 'workspace_delete' }, { ...write(), operation: 'delete' },
    { ...write(), content: null }, { ...write(), export: true }, { ...write(), desktop: true },
    { ...write(), [Symbol('scope')]: true }, Object.create(write())]) {
    assert.equal(approveDraftWrite(grant, value), false);
  }
  for (const bytes of [-1, 0.1, NaN, Infinity, null, undefined, '4', MAX_FILE_BYTES + 1]) {
    assert.equal(approveDraftWrite(grant, write({ bytes })), false);
  }
  for (const argumentsDigest of ['', 'abc', 'g'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), undefined, null, 4]) {
    assert.equal(approveDraftWrite(grant, write({ argumentsDigest })), false);
  }
  const accessor = write();
  Object.defineProperty(accessor, 'bytes', { enumerable: true, get() { throw new Error('must not read mutation accessor'); } });
  assert.equal(approveDraftWrite(grant, accessor), false);
  for (const fake of [undefined, null, false, 'grant', {}, view()]) {
    assert.equal(inspectDraftGrant(fake), null);
    assert.equal(revokeDraftGrant(fake), null);
    assert.equal(approveDraftWrite(fake, write()), false);
    assert.throws(() => assertDraftWrite(fake, write(), {}), denied);
  }
  assert.equal(view().usedWrites, 0);
  assert.equal(view().usedBytes, 0);
});

test('reservation spends total bytes and count synchronously and exactly at each boundary', () => {
  const count = fixture({ maxWrites: 2, maxBytes: 20 });
  assert.ok(approveDraftWrite(count.grant, write()));
  assert.ok(approveDraftWrite(count.grant, write()));
  assert.equal(approveDraftWrite(count.grant, write()), false);
  assert.equal(count.view().usedWrites, 2);
  assert.equal(count.view().remainingWrites, 0);
  assert.equal(count.view().status, 'exhausted');
  const bytes = fixture({ maxWrites: 4, maxBytes: 10 });
  assert.ok(approveDraftWrite(bytes.grant, write()));
  assert.equal(approveDraftWrite(bytes.grant, write({ bytes: 7 })), false);
  assert.ok(approveDraftWrite(bytes.grant, write({ bytes: 6 })));
  assert.equal(bytes.view().usedBytes, 10);
  assert.equal(bytes.view().remainingBytes, 0);
  assert.equal(approveDraftWrite(bytes.grant, write({ bytes: 1 })), false);
  assert.ok(approveDraftWrite(bytes.grant, write({ bytes: 0 })));
  assert.equal(bytes.view().usedWrites, 3);
  assert.equal(bytes.view().usedBytes, 10);
});

test('simultaneous reservations cannot overdraw either quota', async () => {
  for (const values of [{ maxWrites: 2, maxBytes: 20 }, { maxWrites: 20, maxBytes: 8 }]) {
    const { grant, view } = fixture(values);
    const attempts = await Promise.all(Array.from({ length: 32 }, () => Promise.resolve().then(() => approveDraftWrite(grant, write()))));
    assert.equal(attempts.filter(Boolean).length, 2);
    assert.equal(view().usedWrites, 2);
    assert.equal(view().usedBytes, 8);
    assert.equal(approveDraftWrite(grant, write()), false);
  }
});

test('failed and abandoned attempts never refund approval consumption', () => {
  const { grant, view } = fixture({ maxWrites: 2 });
  const abandoned = approveDraftWrite(grant, write());
  assert.ok(abandoned);
  const attempted = approveDraftWrite(grant, write());
  const assertActive = assertDraftWrite(grant, write(), attempted);
  assert.throws(() => { assertActive(); throw new Error('staged write failed'); }, /staged write failed/);
  assert.equal(approveDraftWrite(grant, write()), false);
  assert.equal(view().usedWrites, 2);
  assert.equal(view().usedBytes, 8);
  assert.equal(view().remainingBytes, 4);
});

test('tickets bind exact name, byte count and concrete arguments, including same-size mutations', () => {
  for (const change of [{ name: 'other.md' }, { bytes: 3 }, { argumentsDigest: 'b'.repeat(64) }, { operation: 'delete' }]) {
    const { grant, view } = fixture({ names: ['report.md', 'other.md'], maxWrites: 1 });
    const ticket = approveDraftWrite(grant, write());
    assert.throws(() => assertDraftWrite(grant, write(change), ticket), denied);
    assert.throws(() => assertDraftWrite(grant, write(), ticket), denied);
    assert.equal(view().usedWrites, 1);
    assert.equal(view().usedBytes, 4);
  }
  const { grant } = fixture();
  const descriptor = write();
  const ticket = approveDraftWrite(grant, descriptor);
  descriptor.bytes = 1;
  assert.throws(() => assertDraftWrite(grant, descriptor, ticket), denied);
});

test('an opaque ticket starts one dispatch and cannot be cloned, transferred or replayed', () => {
  const first = fixture({ maxWrites: 1 });
  const second = fixture({ maxWrites: 1 });
  const descriptor = write();
  const ticket = approveDraftWrite(first.grant, descriptor);
  assert.equal(Object.isFrozen(ticket), true);
  assert.equal(JSON.stringify(ticket), '{}');
  for (const fake of [undefined, null, false, {}, { ...ticket }, structuredClone(ticket)]) {
    assert.throws(() => assertDraftWrite(first.grant, descriptor, fake), denied);
  }
  assert.throws(() => assertDraftWrite(second.grant, descriptor, ticket), denied);
  const assertActive = assertDraftWrite(first.grant, { argumentsDigest: digest, bytes: 4, name: 'report.md' }, ticket);
  assert.doesNotThrow(assertActive);
  assert.doesNotThrow(assertActive);
  assert.throws(() => assertDraftWrite(first.grant, descriptor, ticket), denied);
  assert.equal(approveDraftWrite(first.grant, descriptor), false);
});

test('mutation descriptors changing after dispatch fail the repeated atomic guard', () => {
  const { grant } = fixture();
  const descriptor = write();
  const ticket = approveDraftWrite(grant, descriptor);
  const assertActive = assertDraftWrite(grant, descriptor, ticket);
  assertActive();
  descriptor.argumentsDigest = 'b'.repeat(64);
  assert.throws(assertActive, denied);
});

test('expiry blocks new reservations and tickets exactly at the deadline', () => {
  const { grant, at, view } = fixture();
  const ticket = approveDraftWrite(grant, write());
  at(1099);
  assert.equal(view().expired, false);
  const assertActive = assertDraftWrite(grant, write(), ticket);
  assertActive();
  at(1100);
  assert.equal(approveDraftWrite(grant, write()), false);
  assert.throws(assertActive, denied);
  assert.equal(view().expired, true);
  assert.equal(view().status, 'expired');
  at(1001);
  assert.equal(approveDraftWrite(grant, write()), false);
  assert.throws(assertActive, denied);
  assert.equal(view().expired, true);
  const pending = fixture();
  const unstarted = approveDraftWrite(pending.grant, write());
  pending.at(1100);
  assert.throws(() => assertDraftWrite(pending.grant, write(), unstarted), denied);
  assert.equal(pending.view().usedWrites, 1);
});

test('revocation is idempotent and blocks pending approvals and atomic dispatch guards', () => {
  const pending = fixture();
  const ticket = approveDraftWrite(pending.grant, write());
  const before = pending.view();
  assert.equal(revokeDraftGrant(pending.grant).status, 'revoked');
  assert.deepEqual(revokeDraftGrant(pending.grant), pending.view());
  assert.equal(before.revoked, false);
  assert.equal(approveDraftWrite(pending.grant, write()), false);
  assert.throws(() => assertDraftWrite(pending.grant, write(), ticket), denied);
  assert.equal(pending.view().usedWrites, 1);
  const dispatched = fixture();
  const active = assertDraftWrite(dispatched.grant, write(), approveDraftWrite(dispatched.grant, write()));
  active();
  revokeDraftGrant(dispatched.grant);
  assert.throws(active, denied);
  assert.equal(dispatched.view().usedBytes, 4);
});

test('grants from separate runs have independent quotas and revocation', () => {
  const first = fixture({ maxWrites: 1 });
  const second = fixture({ maxWrites: 1 });
  const ticket = approveDraftWrite(first.grant, write());
  revokeDraftGrant(first.grant);
  assert.throws(() => assertDraftWrite(first.grant, write(), ticket), denied);
  assert.equal(second.view().usedWrites, 0);
  assert.ok(approveDraftWrite(second.grant, write()));
  assert.equal(second.view().status, 'exhausted');
  assert.equal(second.view().revoked, false);
});
