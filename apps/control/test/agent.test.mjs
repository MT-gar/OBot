import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createController } from '../src/controller.mjs';
import { createWorkspace } from '../src/workspace.mjs';
import { agentTools, validateToolCall, agentLimits } from '../src/agent.mjs';
const call = (name, args, id = 'call-1') => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
const answer = (text = 'Done.', output = [], tokens = 5) => ({ output, outputText: text, usage: { inputTokens: tokens - 1, outputTokens: 1, totalTokens: tokens, reasoningTokens: 0 } });
async function until(operation, timeout = 2500) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await operation(); if (value) return value; await delay(5); } throw new Error('Expected test condition was not observed.'); }
async function fixture(t, script = [answer()], options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pc-agent-'));
  const workspace = await createWorkspace(path.join(root, 'workspace')); const dataDir = path.join(root, 'state');
  const runtime = {
    locks: [], inputs: [], ready: true, generation: 0,
    async inspect() { return { ready: this.ready, browserReady: this.ready, sandboxEnabled: true }; },
    async setViewOnly(enabled) { this.locks.push(enabled); return { generation: ++this.generation, ...(!enabled ? { stopped: true } : {}) }; },
    async setObservation(enabled) { return { enabled, generation: ++this.generation }; },
    async openFixture({ assertLease }) { assertLease(); },
    async fillAndSubmit({ assertLease }) { assertLease(); },
    async performTool(name, args, { assertLease }) {
      assertLease();
      this.inputs.push(name);
      return name === 'desktop_screenshot' ? { imageBase64: Buffer.from('FAKE_ONLY_SCREENSHOT').toString('base64'), mimeType: 'image/png', width: 2, height: 2 } : { ok: true };
    },
    async close() {},
  };
  const model = { calls: [], metadata: () => ({ configured: true, model: 'fake', protocol: 'responses', reasoningEffort: 'max', baseUrl: 'https://provider.example', verified: false, secret: 'DO_NOT_EXPOSE' }), async respond(request) { this.calls.push(structuredClone({ input: request.input, tools: request.tools, maxOutputTokens: request.maxOutputTokens })); const item = script.shift(); if (item === undefined) throw new Error('Fake script exhausted.'); return typeof item === 'function' ? item(request) : item; } };
  const controller = await createController({ runtime, workspace, dataDir, model, fixtureUrl: 'http://control:3180/fixture', stepDelayMs: 5, ...options });
  t.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  const finished = () => until(async () => { const state = await controller.status(); return state.run && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state.run.status) && state.control.owner === 'human' && state; });
  const pending = () => until(async () => { const state = await controller.status(); return state.run?.status === 'awaiting_approval' && state; });
  const persisted = async () => (await readFile(path.join(dataDir, 'state.json'), 'utf8')) + (await Promise.all((await readdir(path.join(dataDir, 'runs'))).filter(name => name.endsWith('.json')).map(name => readFile(path.join(dataDir, 'runs', name), 'utf8')))).join('\n');
  return { root, dataDir, workspace, runtime, model, controller, finished, pending, persisted };
}
test('Responses tools are strict; no desktop without consent; hostile paths and URLs rejected', () => {
  assert.deepEqual(agentTools().map(tool => tool.name), ['workspace_list', 'workspace_read', 'workspace_write']);
  for (const tool of agentTools(true)) { assert.equal(tool.type, 'function'); assert.equal(tool.strict, true); assert.equal(tool.parameters.additionalProperties, false); }
  assert.throws(() => validateToolCall('desktop_screenshot', {})); assert.throws(() => validateToolCall('workspace_list', { shell: 'x' }));
  assert.throws(() => validateToolCall('workspace_read', { name: '../secret' }));
  for (const url of ['file:///etc/passwd', 'http://127.0.0.1', 'http://169.254.169.254', 'http://control:3180/api/status']) assert.throws(() => validateToolCall('browser_navigate', { url }, { allowDesktop: true, fixtureUrl: 'http://control:3180/fixture' }));
  assert.equal(agentLimits({ maxTokens: 999999 }).maxTokens, 50000);
});
test('file-only task keeps desktop human-owned and publishes only safe metadata', async t => {
  const f = await fixture(t, [answer('Finished.')]); f.runtime.ready = false;
  await f.controller.startTask({ goal: 'Summarize the request.' }); const state = await f.finished();
  assert.equal(state.phase, 'mvp'); assert.equal(state.run.output, 'Finished.'); assert.equal(state.model.secret, undefined);
  assert.equal(f.runtime.locks.includes(true), false); assert.equal(state.run.usage.totalTokens, 5);
});
test('file writes wait for concrete approval; private preview and content never enter history', async t => {
  const content = 'PRIVATE_CONTENT_MUST_NOT_PERSIST';
  const f = await fixture(t, [answer('', [call('workspace_write', { name: 'result.md', content })]), answer('Saved.')]);
  const { id } = await f.controller.startTask({ goal: 'Write result.md.' }); const state = await f.pending();
  assert.equal(state.control.owner, 'human'); assert.equal((await f.workspace.list()).length, 0);
  assert.equal(state.run.approval.args.content, undefined); assert.equal(state.run.approval.preview.content, content);
  await assert.rejects(f.controller.decideApproval(id, { approvalId: 'wrong', decision: 'approve' }), { status: 409 });
  await f.controller.decideApproval(id, { approvalId: state.run.approval.id, decision: 'approve' }); assert.equal((await f.finished()).run.status, 'succeeded');
  assert.equal((await f.workspace.download('result.md')).toString(), content); assert.ok(!(await f.persisted()).includes(content));
  await assert.rejects(f.controller.decideApproval(id, { approvalId: state.run.approval.id, decision: 'approve' }), { status: 409 });
});
test('a changed file after approval request is not overwritten', async t => {
  const f = await fixture(t, [answer('', [call('workspace_write', { name: 'existing.txt', content: 'model update' })]), answer('The file changed; no overwrite.')]);
  await f.workspace.write('existing.txt', Buffer.from('original'));
  const { id } = await f.controller.startTask({ goal: 'Update existing.txt.' }); const waiting = await f.pending();
  assert.equal(waiting.run.approval.args.overwrite, true); await f.workspace.write('existing.txt', Buffer.from('human change'));
  await f.controller.decideApproval(id, { approvalId: waiting.run.approval.id, decision: 'approve' }); const state = await f.finished();
  assert.equal((await f.workspace.download('existing.txt')).toString(), 'human change'); assert.ok(state.run.steps.some(step => step.result?.code === 'file_changed'));
});
test('denied and expired approvals execute no mutation', async t => {
  const f = await fixture(t, [answer('', [call('workspace_write', { name: 'denied.txt', content: 'no' })]), answer('Denied.')]);
  const { id } = await f.controller.startTask({ goal: 'Write denied.txt.' }); const waiting = await f.pending();
  await f.controller.decideApproval(id, { approvalId: waiting.run.approval.id, decision: 'deny' }); await f.finished(); assert.equal((await f.workspace.list()).length, 0);
  const late = await fixture(t, [answer('', [call('workspace_write', { name: 'expired.txt', content: 'no' })])], { agentLimits: { approvalTtlMs: 40 } });
  await late.controller.startTask({ goal: 'Write later.' }); assert.equal((await late.finished()).run.errorCode, 'approval_expired'); assert.equal((await late.workspace.list()).length, 0);
});
test('opaque reasoning, read content and screenshots stay in memory only', async t => {
  const f = await fixture(t, [answer('', [{ type: 'reasoning', id: 'rs_private', encrypted_content: 'OPAQUE_NOT_IN_HISTORY' }, call('desktop_screenshot', {})]), request => { assert.ok(request.input.some(item => item.type === 'reasoning')); assert.ok(request.input.some(item => item.content?.some?.(part => part.type === 'input_image'))); return answer('Observed.'); }]);
  await f.controller.startTask({ goal: 'Observe the desktop.', allowDesktop: true }); assert.equal((await f.finished()).run.status, 'succeeded');
  const log = await f.persisted(); assert.ok(!log.includes('OPAQUE_NOT_IN_HISTORY')); assert.ok(!log.includes('imageBase64')); assert.ok(!log.includes(Buffer.from('FAKE_ONLY_SCREENSHOT').toString('base64')));
});
test('takeover revokes pending approval and prevents subsequent desktop inputs', async t => {
  const f = await fixture(t, [answer('', [call('desktop_type', { text: 'secret typed text' })]), answer('Must not run.')]);
  const { id } = await f.controller.startTask({ goal: 'Type after approval.', allowDesktop: true }); const waiting = await f.pending();
  assert.ok(f.runtime.locks.includes(true)); await f.controller.takeover();
  await assert.rejects(f.controller.decideApproval(id, { approvalId: waiting.run.approval.id, decision: 'approve' }), { status: 409 });
  assert.equal(f.runtime.inputs.length, 0);
  assert.equal(f.model.calls.length, 1);
  const state = await f.controller.status();
  assert.equal(state.run.status, 'paused');
  assert.equal(state.control.private, true);
  assert.equal(state.work.handoff.reason, 'owner_requested');
});
test('unacknowledged runner stop withholds human input until both gates confirm', async t => {
  const f = await fixture(t, [() => new Promise(() => {})]);
  const observe = f.runtime.setObservation.bind(f.runtime);
  const input = f.runtime.setViewOnly.bind(f.runtime);
  f.runtime.setViewOnly = async value => value ? input(value) : undefined;
  f.runtime.setObservation = async value => value ? observe(value) : undefined;
  const { id } = await f.controller.startTask({ goal: 'Exercise stop evidence.', allowDesktop: true });
  await until(() => f.model.calls.length);
  const paused = await f.controller.pause(id);
  assert.equal(paused.control.owner, 'unconfirmed');
  assert.deepEqual([paused.control.stop.input, paused.control.stop.observation], [false, false]);
  assert.equal(f.controller.desktopConnectable(), false);
  f.runtime.setViewOnly = input;
  assert.equal((await f.controller.takeover(id)).control.owner, 'unconfirmed');
  f.runtime.setObservation = observe;
  const confirmed = await f.controller.takeover(id);
  assert.equal(confirmed.control.owner, 'human');
  assert.ok(confirmed.control.stop.runnerGeneration > 0);
  assert.equal(f.controller.desktopConnectable(), true);
});
test('cancelling an uncooperative model stops promptly and marks unknown accounting', async t => {
  const f = await fixture(t, [() => new Promise(() => {})]); await f.controller.startTask({ goal: 'A slow request.' }); await until(() => f.model.calls.length);
  const started = Date.now(); const state = await f.controller.cancel(); assert.ok(Date.now() - started < 1000); assert.equal(state.run.status, 'cancelled'); assert.equal(state.run.usage.unknown, true);
});
test('provider client restriction is a failed run and cannot leak raw provider messages', async t => {
  const f = await fixture(t, [() => { throw Object.assign(new Error('RAW_PROVIDER_SECRET'), { status: 403, code: 'client_not_allowed' }); }]);
  await f.controller.startTask({ goal: 'Try the configured provider.' }); const state = await f.finished();
  assert.equal(state.run.status, 'failed'); assert.equal(state.run.errorCode, 'client_not_allowed'); assert.ok(!(await f.persisted()).includes('RAW_PROVIDER_SECRET')); assert.equal(f.model.calls.length, 1);
});
test('step, token and time budgets stop dispatch without automatic retries', async t => {
  const f = await fixture(t, [answer('', [call('workspace_list', {})]), answer('', [call('workspace_list', {}, 'call-2')])], { agentLimits: { maxSteps: 3 } });
  await f.controller.startTask({ goal: 'List repeatedly.' }); assert.equal((await f.finished()).run.errorCode, 'budget_steps'); assert.equal(f.model.calls.length, 2);
  const over = await fixture(t, [answer('', [call('workspace_write', { name: 'no.txt', content: 'no' })], 11)], { agentLimits: { maxTokens: 10 } });
  await over.controller.startTask({ goal: 'An over-budget response.' }); assert.equal((await over.finished()).run.errorCode, 'budget_tokens'); assert.equal((await over.workspace.list()).length, 0);
  const slow = await fixture(t, [() => new Promise(() => {})], { agentLimits: { maxDurationMs: 100 } }); await slow.controller.startTask({ goal: 'Wait.' }); assert.equal((await slow.finished()).run.errorCode, 'budget_time');
});
test('desktop cleanup is visible before a terminal run frees the execution slot', async t => {
  const f = await fixture(t, [answer('First'), answer('Second')]);
  const setViewOnly = f.runtime.setViewOnly.bind(f.runtime);
  let allowStop;
  let stopping = false;
  const stopped = new Promise(resolve => { allowStop = resolve; });
  f.runtime.setViewOnly = async value => {
    if (!value) { stopping = true; await stopped; }
    return setViewOnly(value);
  };
  try {
    const first = await f.controller.startTask({ goal: 'First desktop task.', allowDesktop: true });
    await until(() => stopping);
    const state = await f.controller.status();
    assert.equal(state.run.status, 'finishing');
    assert.equal(state.canStart, false);
    assert.equal(state.control.owner, 'stopping');
    assert.equal((await f.controller.getRun(first.id)).status, 'finishing');
    await assert.rejects(f.controller.startTask({ goal: 'Too soon.' }), { status: 409 });
    allowStop();
    const done = await f.finished();
    assert.equal(done.canStart, true);
    await f.controller.startTask({ goal: 'Next task.' });
    assert.equal((await f.finished()).run.output, 'Second');
  } finally { allowStop(); }
});

test('missing accounting stops further requests; consecutive tasks keep separate history', async t => {
  const bad = await fixture(t, [{ output: [], outputText: 'No accounting.' }]); await bad.controller.startTask({ goal: 'Check accounting.' }); const failed = await bad.finished(); assert.equal(failed.run.errorCode, 'usage_unknown'); assert.equal(failed.run.usage.unknown, true);
  const f = await fixture(t, [answer('First'), answer('Second')]); const first = await f.controller.startTask({ goal: 'First goal.' }); await f.finished(); await f.controller.startTask({ goal: 'Second goal.' }); await f.finished();
  assert.equal((await f.controller.listRuns()).length, 2); assert.equal((await f.controller.getRun(first.id)).output, 'First');
  await assert.rejects(f.controller.getRun('../secret'), { status: 400 });
});
test('unfinished approvals recover interrupted without retaining live authorization', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pc-agent-recover-')); let controller;
  t.after(async () => { await controller?.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = await createWorkspace(path.join(root, 'workspace')); const stateDir = path.join(root, 'state'); await mkdir(stateDir);
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify({ version: 1, generation: 2, events: [], run: { id: '11111111-1111-4111-8111-111111111111', kind: 'agent', status: 'awaiting_approval', steps: [], usage: { unknown: false }, approval: { id: 'old' } } }));
  controller = await createController({ runtime: { async setViewOnly() {}, async inspect() { return {}; } }, workspace, dataDir: stateDir, model: { metadata: () => ({ configured: true }) } });
  const state = await controller.status(); assert.equal(state.run.status, 'interrupted'); assert.equal(state.run.approval, undefined); assert.equal(state.run.usage.unknown, true);
});
