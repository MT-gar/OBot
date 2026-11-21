import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../../../runtime/acp/budget.mjs';
import { createTaskBridge } from '../src/acp-bridge.mjs';

const usage = { inputTokens: 10, outputTokens: 3, totalTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2 };
async function fixture(t, options = {}) {
  const run = { startedAt: new Date().toISOString(), steps: [], allowDesktop: false };
  const bridge = await createTaskBridge({ run, signal: new AbortController().signal, assertLease() {}, update: async () => {}, runtime: {}, workspace: {}, requestApproval: async () => false, ...options });
  const listeners = new Map();
  const cancellations = [];
  const ctx = { on(name, listener) { listeners.set(name, listener); }, agents: { get: () => ({ cancel: value => cancellations.push(value) }) } };
  const names = ['PRIVATE_COMPUTER_POLICY_URL', 'PRIVATE_COMPUTER_POLICY_TOKEN', 'PRIVATE_COMPUTER_MAX_OUTPUT_TOKENS'];
  const previous = names.map(name => process.env[name]);
  try {
    process.env.PRIVATE_COMPUTER_POLICY_URL = bridge.origin + '/policy';
    process.env.PRIVATE_COMPUTER_POLICY_TOKEN = bridge.token;
    process.env.PRIVATE_COMPUTER_MAX_OUTPUT_TOKENS = '2048';
    apply(ctx);
  } finally {
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
  }
  t.after(async () => { await listeners.get('dispose')(); await bridge.close(); });
  let dispatches = 0;
  const agent = { options: {} };
  const prepare = () => listeners.get('agent/pre-step')({ agent, step: dispatches + 1 }, () => {});
  const dispatch = async (stream = async function* () {}) => {
    const result = [];
    for await (const chunk of listeners.get('llm/stream')({ maxTokens: agent.options.maxTokens }, () => { dispatches++; return stream(); })) result.push(chunk);
    return result;
  };
  return {
    run, bridge, cancellations, agent, prepare, dispatch,
    get dispatches() { return dispatches; },
    step: async () => { await prepare(); return dispatch(); },
    emit: event => listeners.get('session/event')({ header: { id: 'usage-test' } }, event),
    flush: () => listeners.get('dispose')(),
  };
}

test('DSH message accounting comes from event.data.usage, including disjoint cache input', async t => {
  const f = await fixture(t);
  await f.step();
  f.emit({ type: 'assistant/message', seq: 1, usage: { inputTokens: 9999, outputTokens: 9999 }, data: { turn: 1, step: 1, usage, stream: [] } });
  await f.step();
  assert.equal(f.dispatches, 2);
  assert.equal(f.run.usage.inputTokens, 17);
  assert.equal(f.run.usage.outputTokens, 3);
  assert.equal(f.run.usage.totalTokens, 20);
  assert.equal(f.run.usage.unknown, false);
  f.emit({ type: 'assistant/message', seq: 2, data: { usage } });
  await f.flush();
  assert.equal(f.run.usage.totalTokens, 40);
});

for (const [name, event] of [
  ['top-level usage only', { usage, data: {} }],
  ['absent usage', { data: {} }],
  ['incomplete nested usage', { data: { usage: { inputTokens: 10 } } }],
  ['inconsistent total', { data: { usage: { ...usage, totalTokens: 1 } } }],
]) {
  test(name + ' fails closed before another DSH request', async t => {
    const f = await fixture(t);
    await f.step();
    f.emit({ type: 'assistant/message', seq: 1, ...event });
    await assert.rejects(f.step());
    assert.equal(f.dispatches, 1);
    assert.equal(f.run.budget.modelTurns, 1);
    assert.equal(f.run.usage.unknown, true);
    assert.equal(f.bridge.failure.code, 'usage_unknown');
  });
}

test('an unsettled DSH request blocks the next dispatch even if no usage event arrives', async t => {
  const f = await fixture(t);
  await f.step();
  await assert.rejects(f.step());
  assert.equal(f.dispatches, 1);
  assert.equal(f.run.budget.modelTurns, 1);
  assert.equal(f.run.usage.unknown, true);
  assert.equal(f.bridge.failure.code, 'usage_unknown');
});

test('a failed DSH attempt keeps accounting unknown and preserves the safe transport failure', async t => {
  const f = await fixture(t);
  await f.step();
  f.emit({ type: 'assistant/attempt', seq: 1, data: { turn: 1, step: 1, stream: [
    { type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } },
    { type: 'chunk', time: 1, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'PRIVATE_PROVIDER_DETAILS' } } } },
  ] } });
  await assert.rejects(f.step());
  assert.equal(f.dispatches, 1);
  assert.equal(f.run.usage.unknown, true);
  assert.equal(f.bridge.failure.code, 'provider_transport_failed');
  assert.ok(!f.bridge.failure.message.includes('PRIVATE_PROVIDER_DETAILS'));
  assert.equal(f.run.usage.totalTokens, 0);
});

test('late host dispatch fence rejects revocation after pre-step without a provider call', async t => {
  let allowed = true;
  const f = await fixture(t, { assertObservation(scope) { assert.equal(scope, 'model'); if (!allowed) throw new Error('revoked'); } });
  await f.prepare(); allowed = false;
  await assert.rejects(f.dispatch());
  assert.equal(f.dispatches, 0);
  assert.equal(f.run.budget.modelTurns, 0);
  assert.equal(f.bridge.inFlight, false);
});

test('remaining total budget caps each newly prepared output request', async t => {
  const f = await fixture(t, { limits: { maxTokens: 25 } });
  await f.step();
  assert.equal(f.agent.options.maxTokens, 25);
  f.emit({ type: 'assistant/message', seq: 1, data: { usage } });
  await f.prepare();
  assert.equal(f.agent.options.maxTokens, 5);
  await f.dispatch();
  assert.equal(f.dispatches, 2);
});

test('late host fence rejects absent or stale prepared output caps without dispatching', async t => {
  const f = await fixture(t, { limits: { maxTokens: 25 } });
  for (const maxOutputTokens of [undefined, 0, 26]) {
    const result = await fetch(f.bridge.origin + '/policy', { method: 'POST', headers: { Authorization: 'Bearer ' + f.bridge.token }, body: JSON.stringify({ type: 'before-model', maxOutputTokens }) });
    assert.equal(result.status, 409);
  }
  assert.equal(f.run.budget.modelTurns, 0); assert.equal(f.bridge.inFlight, false);
});

test('revoked result egress drops chunks and leaves unsettled accounting honest', async t => {
  let allowed = true;
  const f = await fixture(t, { assertObservation() { if (!allowed) throw new Error('revoked'); } });
  await f.prepare();
  await assert.rejects(f.dispatch(async function* () { allowed = false; yield { type: 'text', text: 'LATE_PRIVATE' }; }));
  assert.equal(f.dispatches, 1);
  assert.equal(f.bridge.inFlight, true);
  await f.bridge.close({ cancelled: true });
  assert.equal(f.run.usage.unknown, true);
  assert.equal(f.run.usage.unknownReason, 'cancelled_in_flight');
});

test('repeated message notification is counted once', async t => {
  const f = await fixture(t);
  await f.step();
  const event = { type: 'assistant/message', seq: 1, data: { usage } };
  f.emit(event);
  f.emit(event);
  await f.flush();
  assert.equal(f.run.usage.totalTokens, 20);
  assert.equal(f.bridge.failure, null);
});
