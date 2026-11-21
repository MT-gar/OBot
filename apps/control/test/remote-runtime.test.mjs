import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRunnerServer } from '../../desktop/server.mjs';
import { createRemoteRuntime } from '../src/remote-runtime.mjs';
import { createGuestRuntime } from '../src/runtime.mjs';

test('guest runtime waits for admitted fixture browser work before confirming owner input', async t => {
  const { createServer } = await import('node:http');
  const waiting = Promise.withResolvers();
  const acknowledge = Promise.withResolvers();
  const cdp = createServer(async (request, response) => {
    assert.equal(request.method, 'PUT');
    assert.equal(request.url, '/json/new?about:blank');
    waiting.resolve();
    await acknowledge.promise;
    response.end(JSON.stringify({ id: 'fixture' }));
  });
  await new Promise(resolve => cdp.listen(0, '127.0.0.1', resolve));
  t.after(() => { acknowledge.resolve(); cdp.closeAllConnections(); cdp.close(); });
  const modes = [];
  const guest = createGuestRuntime({
    cdpUrl: `http://127.0.0.1:${cdp.address().port}`,
    async runDesktopCommand(command, args) { assert.equal(command, 'x11vnc'); modes.push(args.at(-1)); },
  });
  assert.deepEqual(await guest.setViewOnly(false), { stopped: true, generation: 1 });
  assert.deepEqual(await guest.setObservation(true), { enabled: true, generation: 1 });
  assert.deepEqual(await guest.setViewOnly(true), { generation: 2 });
  const operation = guest.openFixture({ url: 'http://127.0.0.1:3180/fixture' });
  const rejected = assert.rejects(operation, { name: 'AbortError' });
  await waiting.promise;
  const stop = guest.setViewOnly(false);
  assert.deepEqual(modes, ['noviewonly', 'viewonly']);
  acknowledge.resolve();
  await rejected;
  assert.deepEqual(await stop, { stopped: true, generation: 3 });
  assert.deepEqual(modes, ['noviewonly', 'viewonly', 'noviewonly']);
  await guest.close();
});

async function fixture(t, leaseTtlMs) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pc-runner-'));
  const token = 'runner-test-token-not-a-real-credential-123456789'; const tokenFile = path.join(directory, 'token');
  await writeFile(tokenFile, token, { mode: 0o600 });
  const runtime = { locks: [], inputs: [], async inspect() { return { ready: true, browserReady: true, sandboxEnabled: true }; }, async setViewOnly(value) { this.locks.push(value); }, async openFixture({ assertLease }) { assertLease(); this.inputs.push('fixture'); }, async fillAndSubmit({ assertLease }) { assertLease(); this.inputs.push('fill'); }, async capture() { return Buffer.from('FAKE_PNG'); } };
  const tools = { async performTool(name, _args, { signal, assertLease }) { if (name === 'desktop_click') { await delay(100, null, { signal }); assertLease(); runtime.inputs.push('click'); } return { ok: true }; } };
  const server = await createRunnerServer({ token, runtime, tools, fixtureOrigin: 'http://control:3180', leaseTtlMs });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await server.shutdown(); await rm(directory, { recursive: true, force: true }); });
  return { runtime, server, token, tokenFile, baseUrl };
}
test('private runner rejects unauthenticated requests and unknown tools', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.baseUrl + '/healthz')).status, 200);
  assert.equal((await fetch(f.baseUrl + '/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const response = await fetch(f.baseUrl + '/tool', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.token}` }, body: JSON.stringify({ name: 'arbitrary_shell', args: { command: 'id' } }) });
  assert.equal(response.status, 400); assert.equal(f.runtime.inputs.length, 0);
});
test('remote Adapter preserves P0 Interface and requires a private input lease', async t => {
  const f = await fixture(t); const remote = await createRemoteRuntime(f);
  assert.equal((await remote.inspect()).sandboxEnabled, true);
  await assert.rejects(remote.openFixture({ url: 'http://control:3180/fixture' }), /lease/);
  await remote.setViewOnly(true); await remote.openFixture({ url: 'http://control:3180/fixture', assertLease() {} }); await remote.fillAndSubmit({ assertLease() {} });
  assert.deepEqual(f.runtime.inputs, ['fixture', 'fill']); assert.deepEqual(await remote.capture(), Buffer.from('FAKE_PNG'));
  await remote.setViewOnly(false); await assert.rejects(remote.fillAndSubmit({}), /lease/); await remote.close();
});
test('revoking the worker lease aborts in-flight input before its effect', async t => {
  const f = await fixture(t); const remote = await createRemoteRuntime(f); await remote.setViewOnly(true);
  const input = remote.performTool('desktop_click', { x: 1, y: 2, button: 'left' }, { assertLease() {} });
  const rejected = assert.rejects(input);
  await delay(25); await remote.setViewOnly(false); await rejected;
  assert.equal(f.runtime.inputs.length, 0); await remote.close();
});
test('remote observation has its own grant and owner capture stays available', async t => {
  const f = await fixture(t);
  const remote = await createRemoteRuntime(f);
  await assert.rejects(remote.performTool('browser_snapshot', {}), /observation/i);
  const grant = await remote.setObservation(true);
  assert.equal(grant.enabled, true);
  assert.deepEqual(await remote.performTool('browser_snapshot', {}), { ok: true });
  await assert.rejects(remote.fillAndSubmit({}), /lease/);
  await remote.setViewOnly(true);
  const stop = await remote.setViewOnly(false);
  assert.equal(stop.stopped, true);
  assert.ok(Number.isSafeInteger(stop.generation));
  assert.deepEqual(await remote.performTool('desktop_screenshot', {}), { ok: true });
  await remote.setObservation(false);
  await assert.rejects(remote.performTool('desktop_screenshot', {}), /observation/i);
  assert.deepEqual(await remote.capture(), Buffer.from('FAKE_PNG'));
  await remote.close();
});

test('old private leases and non-fixture internal paths are rejected', async t => {
  const f = await fixture(t);
  const invoke = (route, value, lease) => fetch(f.baseUrl + route, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json', ...(lease ? { 'X-Desktop-Lease': lease } : {}) }, body: JSON.stringify(value) });
  const old = await (await invoke('/view-only', { value: true })).json();
  await invoke('/view-only', { value: false });
  assert.equal((await invoke('/fixture/fill', {}, old.lease)).status, 409);
  const current = await (await invoke('/view-only', { value: true })).json();
  assert.equal((await invoke('/fixture/open', { url: 'http://control:3180/api/status' }, current.lease)).status, 400);
  assert.equal(f.runtime.inputs.length, 0);
});

function watchRenewals(server) {
  const first = Promise.withResolvers();
  let count = 0;
  server.on('request', (request, response) => {
    if (request.url !== '/view-only/renew') return;
    count++;
    response.once('finish', () => first.resolve(response.statusCode));
  });
  return { first: first.promise, count: () => count };
}

test('remote renews a live lease and stops scheduling renewal when closed', { timeout: 6000 }, async t => {
  const f = await fixture(t, 1200);
  const renewals = watchRenewals(f.server);
  const remote = await createRemoteRuntime(f);
  t.after(() => remote.close());
  await remote.setViewOnly(true);
  assert.equal(await renewals.first, 200);
  await remote.fillAndSubmit();
  await remote.close();
  const count = renewals.count();
  await delay(600);
  assert.equal(renewals.count(), count);
  await assert.rejects(remote.fillAndSubmit(), /closed/);
});

test('a disconnected runner drops the remote lease and cannot confirm an explicit stop', { timeout: 6000 }, async t => {
  const f = await fixture(t, 1200);
  const renewals = watchRenewals(f.server);
  const lost = Promise.withResolvers();
  const remote = await createRemoteRuntime(f);
  t.after(() => remote.close());
  await remote.setViewOnly(true, { onLeaseLost: lost.resolve });
  assert.equal(await renewals.first, 200);
  await f.server.shutdown();
  await lost.promise;
  await assert.rejects(remote.fillAndSubmit(), /lease/);
  await assert.rejects(remote.setViewOnly(false));
});
