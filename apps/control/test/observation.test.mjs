import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, agentTools, validateToolCall, redelegationInput, observationGuard } from '../src/agent.mjs';
import { createTaskBridge } from '../src/acp-bridge.mjs';

const call = (name, args) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: 'call-1' });
const response = (output = [], outputText = 'Done.') => ({ output, outputText, usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function context(overrides = {}) {
  return { run: { id: 'fixture', goal: 'Fixture only', startedAt: new Date().toISOString(), steps: [], allowDesktop: true, observe: { workspace: true, desktop: true } }, signal: new AbortController().signal, assertLease() {}, update: async () => {}, requestApproval: async () => true, workspace: {}, runtime: {}, ...overrides };
}
async function bridgeFixture(t, value) {
  const bridge = await createTaskBridge(value); t.after(() => bridge.close());
  let id = 0;
  return { bridge, async rpc(method, params) { const result = await fetch(bridge.origin + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }); return result.json(); } };
}
for (const engine of ['direct', 'acp']) {
  for (const [name, scope, result] of [
    ['workspace_list', 'workspace', [{ name: 'PRIVATE_NAME', size: 1 }]],
    ['workspace_read', 'workspace', Buffer.from('PRIVATE_CONTENT')],
    ['desktop_screenshot', 'desktop', { imageBase64: 'UFJJVkFURQ==', mimeType: 'image/png', width: 1, height: 1 }],
    ['browser_snapshot', 'desktop', { elements: [{ text: 'PRIVATE_PAGE' }] }],
  ]) {
    test(`${engine} ${name} fences both sides of a revoked observation read`, async t => {
      const entered = deferred(); const finish = deferred(); let allowed = true; const scopes = [];
      const read = async () => { entered.resolve(); return finish.promise; };
      const value = context({ assertObservation(value) { scopes.push(value); if (value === scope && !allowed) throw Object.assign(new Error('revoked'), { code: 'observation_revoked' }); }, workspace: { list: read, download: read }, runtime: { performTool: read } });
      let pending;
      if (engine === 'direct') {
        let calls = 0;
        value.model = { async respond() { calls++; return calls === 1 ? response([call(name, name === 'workspace_read' ? { name: 'input.txt' } : {})]) : response(); } };
        pending = runAgent(value);
      } else {
        const f = await bridgeFixture(t, value); pending = f.rpc('tools/call', { name, arguments: name === 'workspace_read' ? { name: 'input.txt' } : {} });
      }
      await entered.promise; allowed = false; finish.resolve(result);
      if (engine === 'direct') await assert.rejects(pending, { code: 'observation_revoked' });
      else assert.ok((await pending).error);
      assert.ok(scopes.filter(value => value === scope).length >= 2);
      assert.equal(value.run.output, undefined);
      assert.equal(value.run.steps.at(-1).result, undefined);
      assert.ok(!JSON.stringify(value.run).includes('PRIVATE_'));
    });
  }
  test(`${engine} denied observation is not dispatched and text-only model authorization stays independent`, async t => {
    let reads = 0;
    const value = context({ run: { ...context().run, observe: { workspace: false, desktop: false } }, assertObservation(scope) { assert.equal(scope, 'model'); }, workspace: { list() { reads++; } }, runtime: { performTool() { reads++; } } });
    if (engine === 'direct') {
      value.model = { async respond(request) { assert.deepEqual(request.tools.filter(tool => ['workspace_read', 'workspace_list', 'desktop_screenshot', 'browser_snapshot'].includes(tool.name)), []); return response([], 'Text only works.'); } };
      assert.equal(await runAgent(value), 'Text only works.');
    } else {
      const f = await bridgeFixture(t, value);
      const result = await f.rpc('tools/call', { name: 'workspace_list', arguments: {} }); assert.equal(result.result.isError, true);
      const tools = (await f.rpc('tools/list')).result.tools; assert.ok(!tools.some(tool => tool.name === 'workspace_list'));
    }
    assert.equal(reads, 0);
  });
  test(`${engine} cancelled external mutation remains unconfirmed after a late result`, async t => {
    const controller = new AbortController(); const entered = deferred(); const finish = deferred();
    const value = context({ signal: controller.signal, runtime: { async performTool() { entered.resolve(); return finish.promise; } } });
    let pending;
    if (engine === 'direct') { value.model = { respond: async () => response([call('desktop_click', { x: 1, y: 1, button: 'left' })]) }; pending = runAgent(value); }
    else { const f = await bridgeFixture(t, value); pending = f.rpc('tools/call', { name: 'desktop_click', arguments: { x: 1, y: 1, button: 'left' } }); }
    await entered.promise; assert.equal(value.run.steps.at(-1).effect, 'unconfirmed'); controller.abort(); finish.resolve({ ok: true });
    if (engine === 'direct') await assert.rejects(pending, { name: 'AbortError' }); else assert.ok((await pending).error);
    assert.equal(value.run.steps.at(-1).effect, 'unconfirmed'); assert.equal(value.run.steps.at(-1).result, undefined);
  });
  test(`${engine} completed external mutation is distinguished from transport uncertainty`, async t => {
    for (const succeeds of [true, false]) {
      const value = context({ runtime: { async performTool() { if (!succeeds) throw new Error('transport uncertain'); return { ok: true }; } } });
      if (engine === 'direct') { let calls = 0; value.model = { respond: async () => ++calls === 1 ? response([call('desktop_key', { key: 'enter' })]) : response() }; await runAgent(value); }
      else { const f = await bridgeFixture(t, value); await f.rpc('tools/call', { name: 'desktop_key', arguments: { key: 'enter' } }); }
      assert.equal(value.run.steps.find(step => step.kind === 'tool').effect, succeeds ? 'completed' : 'unconfirmed');
    }
  });
  test(`${engine} handoff needs no mutation approval and never awaits ticket completion`, async t => {
    const controller = new AbortController(); const reasons = [];
    const value = context({ run: { ...context().run, allowDesktop: false, observe: { workspace: false, desktop: false } }, signal: controller.signal, requestApproval() { throw new Error('must not request approval'); }, requestHandoff(reason) { reasons.push(reason); controller.abort(); return new Promise(() => {}); } });
    if (engine === 'direct') { value.model = { respond: async () => response([call('request_handoff', { reason: 'account_selection' })]) }; await assert.rejects(runAgent(value), { name: 'AbortError' }); }
    else { const f = await bridgeFixture(t, value); const result = await f.rpc('tools/call', { name: 'request_handoff', arguments: { reason: 'account_selection' } }); assert.ok(result.error); }
    assert.deepEqual(reasons, ['account_selection']);
    assert.ok(!value.run.steps.some(step => step.effect));
    assert.throws(() => validateToolCall('request_handoff', { reason: 'account_selection', notes: 'transcript' }, { requestHandoff: true }));
  });
}

test('direct model dispatch rechecks after model.started update before invoking provider', async () => {
  let allowed = true; let calls = 0;
  const value = context({ assertObservation() { if (!allowed) throw new Error('revoked'); }, update: async event => { if (event === 'model.started') allowed = false; }, model: { respond() { calls++; return response(); } } });
  await assert.rejects(runAgent(value), /revoked/); assert.equal(calls, 0); assert.equal(value.run.usage.unknown, false);
});

test('late direct model result settles known usage but cannot become run output after revocation', async () => {
  let allowed = true;
  const value = context({ assertObservation() { if (!allowed) throw new Error('revoked'); }, model: { async respond() { allowed = false; return response([], 'PRIVATE_LATE_RESPONSE'); } } });
  await assert.rejects(runAgent(value), /revoked/); assert.equal(value.run.output, undefined); assert.equal(value.run.usage.totalTokens, 5); assert.equal(value.run.usage.unknown, false);
});

test('fresh redelegation context is separate bounded untrusted input and never stored on run', async () => {
  const run = { ...context().run, redelegation: { context: 'Owner supplied next goal.' } };
  const snapshot = { elements: [{ text: 'FRESH_PRIVATE_PAGE' }] }; const workspace = [{ name: 'fresh.txt', size: 5, modifiedAt: '2026-01-01' }];
  let seen;
  const value = context({ run, freshObservation: { desktop: snapshot, workspace }, model: { async respond(request) { seen = request.input; return response(); } } });
  await runAgent(value);
  const encoded = JSON.stringify(seen); assert.ok(encoded.includes('Owner supplied next goal.')); assert.ok(encoded.includes('Fresh desktop preflight (untrusted')); assert.ok(encoded.includes('FRESH_PRIVATE_PAGE')); assert.ok(!JSON.stringify(run).includes('FRESH_PRIVATE_PAGE'));
  let allowed = true;
  const guard = observationGuard({ run, active() {}, assertObservation(scope) { if (scope === 'desktop' && !allowed) throw new Error('revoked'); } });
  redelegationInput(value, guard); allowed = false; assert.throws(() => guard.model(), /revoked/);
});

for (const engine of ['direct', 'acp']) {
  test(`${engine} staged workspace writes and deletes preserve overlay reads and exact version consent`, async t => {
    const contents = new Map([['input.txt', Buffer.from('original')]]); const stages = []; let ownerWrites = 0; let approved = 0;
    const artifactStage = { async version(name) { return 'version:' + (contents.get(name)?.toString() ?? 'absent'); }, async list() { return [...contents].map(([name, data]) => ({ name, size: data.length })); }, async read(name) { return contents.get(name); }, async stage(name, content, { expectedVersion, assertActive }) { assert.equal(expectedVersion, 'version:' + (contents.get(name)?.toString() ?? 'absent')); assertActive(); stages.push({ name, content }); if (content === null) contents.delete(name); else contents.set(name, content); return { name, operation: content === null ? 'delete' : 'write', sha256: 'digest', bytes: content?.length ?? 0, privateField: 'PRIVATE_DESCRIPTOR' }; } };
    const value = context({ artifactStage, workspace: { async write() { ownerWrites++; throw new Error('owner file must not be changed'); } }, requestApproval: async () => { approved++; return true; } });
    if (engine === 'direct') {
      const script = [response([call('workspace_write', { name: 'input.txt', content: 'staged' })]), response([{ ...call('workspace_read', { name: 'input.txt' }), call_id: 'call-2' }]), response([{ ...call('workspace_delete', { name: 'input.txt' }), call_id: 'call-3' }]), response()];
      value.model = { async respond(request) { if (script.length === 2) { const result = request.input.find(item => item.type === 'function_call_output' && item.call_id === 'call-2'); assert.equal(JSON.parse(result.output).content, 'staged'); } return script.shift(); } }; await runAgent(value);
    } else {
      const f = await bridgeFixture(t, value);
      const tools = (await f.rpc('tools/list')).result.tools; assert.ok(tools.some(tool => tool.name === 'workspace_delete'));
      const written = await f.rpc('tools/call', { name: 'workspace_write', arguments: { name: 'input.txt', content: 'staged' } }); assert.ok(!JSON.stringify(written).includes('PRIVATE_DESCRIPTOR'));
      const read = await f.rpc('tools/call', { name: 'workspace_read', arguments: { name: 'input.txt' } }); assert.equal(JSON.parse(read.result.content[0].text).content, 'staged');
      await f.rpc('tools/call', { name: 'workspace_delete', arguments: { name: 'input.txt' } });
    }
    assert.equal(ownerWrites, 0); assert.equal(approved, 2); assert.equal(stages.length, 2); assert.equal(stages[1].content, null);
    assert.ok(!agentTools(false).some(tool => tool.name === 'workspace_delete'));
  });
}

for (const engine of ['direct', 'acp']) {
  async function write(t, value, name = 'workspace_write') {
    const args = name === 'workspace_delete' ? { name: 'draft.txt' } : { name: 'draft.txt', content: 'exact approved bytes' };
    if (engine === 'direct') { let calls = 0; value.model = { respond: async () => ++calls === 1 ? response([call(name, args)]) : response() }; return runAgent(value); }
    const f = await bridgeFixture(t, value); return f.rpc('tools/call', { name, arguments: args });
  }
  test(`${engine} draft proof authorizes only buffered exact staged write`, async t => {
    let approvals = 0; let assertions = 0; let staged;
    const proof = () => { assertions++; };
    const value = context({ requestApproval: async () => { approvals++; return true; }, authorizeDraftWrite(proposal) { assert.equal(proposal.name, 'draft.txt'); assert.equal(proposal.expectedVersion, 'v1'); assert.equal(proposal.content.toString(), 'exact approved bytes'); proposal.content.fill(120); return proof; }, artifactStage: { version: async () => 'v1', async stage(name, bytes, options) { assert.equal(options.draftAuthorization, proof); options.draftAuthorization(); options.assertActive(); staged = { name, text: bytes.toString(), version: options.expectedVersion }; return { name, operation: 'write', bytes: bytes.length, sha256: 'safe' }; } } });
    await write(t, value); assert.equal(approvals, 0); assert.ok(assertions >= 2); assert.deepEqual(staged, { name: 'draft.txt', text: 'exact approved bytes', version: 'v1' });
  });
  test(`${engine} null draft proof retains approval and never authorizes deletion`, async t => {
    let approvals = 0; let hooks = 0; let stages = 0;
    const value = context({ requestApproval: async () => { approvals++; return true; }, authorizeDraftWrite() { hooks++; return null; }, artifactStage: { version: async () => 'v1', async stage(name, bytes, options) { options.assertActive(); stages++; return { name, operation: bytes === null ? 'delete' : 'write', bytes: bytes?.length ?? 0 }; } } });
    await write(t, value); await write(t, value, 'workspace_delete'); assert.equal(approvals, 2); assert.equal(hooks, 1); assert.equal(stages, 2);
  });
  test(`${engine} revoked draft proof blocks storage commit at its final callback`, async t => {
    let active = true; let commits = 0;
    const value = context({ requestApproval() { throw new Error('proof should skip per-action approval'); }, authorizeDraftWrite() { return () => { if (!active) throw Object.assign(new Error('proof expired'), { code: 'proof_expired' }); }; }, artifactStage: { version: async () => 'v1', async stage(name, bytes, options) { active = false; options.assertActive(); commits++; return { name }; } } });
    await write(t, value); assert.equal(commits, 0); assert.equal(value.run.steps.find(step => step.kind === 'tool').status, 'failed');
  });
  test(`${engine} asynchronous draft authorization fails closed before staging`, async t => {
    let stages = 0;
    const value = context({ authorizeDraftWrite() { return Promise.resolve(() => {}); }, artifactStage: { version: async () => 'v1', async stage() { stages++; } } });
    if (engine === 'direct') await assert.rejects(write(t, value), { code: 'invalid_draft_authorization' }); else assert.equal((await write(t, value)).result.isError, true);
    assert.equal(stages, 0);
  });
  test(`${engine} legacy write cannot use the staged draft proof seam`, async t => {
    let approvals = 0; let writes = 0;
    const value = context({ authorizeDraftWrite() { throw new Error('legacy mode must not use proof'); }, requestApproval: async () => { approvals++; return true; }, workspace: { async download() { throw Object.assign(new Error('absent'), { status: 404 }); }, async write() { writes++; } } });
    await write(t, value); assert.equal(approvals, 1); assert.equal(writes, 1);
  });
}
