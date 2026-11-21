import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createContext, runInContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { createRunnerServer } from '../server.mjs';

async function fixture(t, { runtime: overrides, tools, leaseTtlMs = 2000, ...options } = {}) {
  const token = 'local-fixture-runner-credential-123456789';
  const calls = [];
  const runtime = {
    async setViewOnly(value) { calls.push(value); },
    async fillAndSubmit({ assertLease }) { assertLease(); calls.push('fill'); },
    async capture() { return Buffer.from('fixture owner screenshot'); },
    ...overrides,
  };
  const server = await createRunnerServer({ token, runtime, tools, leaseTtlMs, fixtureOrigin: 'http://127.0.0.1:3180', ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.shutdown());
  async function post(route, value, { lease, observation, signal } = {}) {
    return fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: 'POST', signal,
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        ...(lease ? { 'X-Desktop-Lease': lease } : {}),
        ...(observation ? { 'X-Desktop-Observation': observation } : {}),
      },
      body: JSON.stringify(value),
    });
  }
  return { calls, post };
}

test('only the current, unexpired input lease can renew, and expiry aborts input', async t => {
  const admitted = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  const { post } = await fixture(t, { leaseTtlMs: 400, runtime: {
    async fillAndSubmit({ signal, assertLease }) {
      assertLease();
      admitted.resolve();
      try { await delay(2000, null, { signal }); }
      finally { stopped.resolve(signal.aborted); }
    },
  } });
  const grant = await post('/view-only', { value: true });
  assert.equal(grant.status, 200);
  const { lease, generation, ttlMs } = await grant.json();
  assert.equal(ttlMs, 400);
  assert.equal((await post('/view-only/renew', { generation })).status, 409);
  assert.equal((await post('/view-only/renew', { generation: generation + 1 }, { lease })).status, 409);
  const renewed = await post('/view-only/renew', { generation }, { lease });
  assert.equal(renewed.status, 200);
  assert.deepEqual(await renewed.json(), { generation, ttlMs: 400 });
  const input = post('/fixture/fill', {}, { lease });
  await admitted.promise;
  assert.equal(await stopped.promise, true);
  assert.equal((await input).status, 409);
  assert.equal((await post('/view-only/renew', { generation }, { lease })).status, 409);
  assert.equal((await post('/fixture/fill', {}, { lease })).status, 409);
  const fresh = await (await post('/view-only', { value: true })).json();
  assert.notEqual(fresh.lease, lease);
  assert.ok(fresh.generation > generation);
  assert.equal((await post('/fixture/fill', {}, { lease })).status, 409);
});

test('stop proof waits for admitted work and rejects queued input during revocation', async t => {
  const admitted = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const drained = Promise.withResolvers();
  const allowDrain = Promise.withResolvers();
  t.after(() => allowDrain.resolve());
  const { post, calls } = await fixture(t, { runtime: {
    async fillAndSubmit({ signal, assertLease }) {
      assertLease();
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      admitted.resolve();
      await allowDrain.promise;
      drained.resolve();
      assertLease();
    },
  } });
  const { lease, generation } = await (await post('/view-only', { value: true })).json();
  const input = post('/fixture/fill', {}, { lease });
  await admitted.promise;
  const stop = post('/view-only', { value: false });
  await aborted.promise;
  assert.equal((await post('/fixture/fill', {}, { lease })).status, 409);
  assert.deepEqual(calls, [true]);
  allowDrain.resolve();
  await drained.promise;
  assert.equal((await input).status, 409);
  const response = await stop;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { stopped: true, generation: generation + 1 });
  assert.deepEqual(calls, [true, false]);
});

test('inability to confirm an admitted input keeps both new input and stop proof unavailable', async t => {
  const { post, calls } = await fixture(t, { runtime: {
    async fillAndSubmit({ markInputUncertain }) {
      markInputUncertain();
      throw new Error('Fixture action did not acknowledge its result.');
    },
  } });
  const { lease } = await (await post('/view-only', { value: true })).json();
  assert.equal((await post('/fixture/fill', {}, { lease })).ok, false);
  assert.equal((await post('/view-only', { value: false })).status, 503);
  assert.equal((await post('/view-only', { value: true })).status, 503);
  assert.deepEqual(calls, [true]);
});

test('observation permits reads before input and drops late results across private handoff', async t => {
  const entered = Promise.withResolvers();
  const allowRead = Promise.withResolvers();
  t.after(() => allowRead.resolve());
  const { post } = await fixture(t, { tools: {
    async performTool(name, args, { signal }) {
      if (args.wait) { entered.resolve(signal); await allowRead.promise; }
      return { name };
    },
  } });
  const read = (observation, wait = false) => post('/tool', { name: 'browser_snapshot', args: { wait } }, { observation });
  assert.equal((await read()).status, 409);
  const grant = await post('/observation', { enabled: true });
  assert.equal(grant.status, 200);
  const { observation, generation } = await grant.json();
  assert.deepEqual(await (await read(observation)).json(), { name: 'browser_snapshot' });
  const late = read(observation, true);
  const signal = await entered.promise;
  assert.equal((await post('/observation', { enabled: false })).status, 200);
  assert.equal(signal.aborted, true);
  assert.equal((await read(observation)).status, 409);
  assert.equal(await (await post('/screenshot', {})).text(), 'fixture owner screenshot');
  const newer = await (await post('/observation', { enabled: true })).json();
  assert.notEqual(newer.observation, observation);
  assert.ok(newer.generation > generation);
  assert.deepEqual(await (await read(newer.observation)).json(), { name: 'browser_snapshot' });
  allowRead.resolve();
  assert.equal((await late).status, 409);
});

async function browserFixture(t, onInput) {
  const url = 'http://127.0.0.1:3180/fixture';
  const field = {
    tagName: 'INPUT', type: 'text', isConnected: true,
    getBoundingClientRect: () => ({ x: 1, y: 2, width: 20, height: 10 }),
    getAttribute: name => name === 'placeholder' ? 'Project' : '',
    scrollIntoView() {}, focus() {},
  };
  const world = createContext({
    location: { href: url },
    document: { title: 'Fixed fixture', body: { innerText: 'Fixed fixture' }, querySelectorAll: () => [field] },
  });
  const sockets = new Set();
  const server = createServer((request, response) => {
    assert.equal(request.url, '/json/list');
    response.end(JSON.stringify([{ type: 'page', id: 'fixture', url, webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/fixture` }]));
  });
  async function answer({ method, params }, socket) {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'fixture' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method === 'Runtime.evaluate') return { result: { value: runInContext(params.expression, world, { timeout: 1000 }) } };
    assert.equal(method, 'Input.insertText');
    await onInput(params.text, socket);
    return {};
  }
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const key = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 6) {
        const type = buffer[0] & 15;
        let size = buffer[1] & 127;
        const offset = size === 126 ? 4 : 2;
        if (buffer.length < offset + 4) return;
        if (offset === 4) size = buffer.readUInt16BE(2);
        if (buffer.length < offset + 4 + size) return;
        if (type === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        assert.equal(type, 1);
        const text = Buffer.from(buffer.subarray(offset + 4, offset + 4 + size));
        for (let i = 0; i < text.length; i++) text[i] ^= buffer[offset + i % 4];
        buffer = buffer.subarray(offset + 4 + size);
        const message = JSON.parse(text);
        answer(message, socket).then(result => {
          if (socket.destroyed) return;
          const bytes = Buffer.from(JSON.stringify({ id: message.id, result }));
          const header = Buffer.from([0x81, 126, 0, 0]);
          header.writeUInt16BE(bytes.length, 2);
          socket.write(Buffer.concat([header, bytes]));
        }).catch(error => { t.diagnostic(String(error)); socket.destroy(); });
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('a fresh browser reference survives its first grant and revocation waits for sent browser input', { timeout: 8000 }, async t => {
  const inputReached = Promise.withResolvers();
  const acknowledge = Promise.withResolvers();
  t.after(() => acknowledge.resolve());
  const cdpUrl = await browserFixture(t, async text => { inputReached.resolve(text); await acknowledge.promise; });
  const { post, calls } = await fixture(t, { cdpUrl, leaseTtlMs: 5000 });
  const grantObservation = async () => (await (await post('/observation', { enabled: true })).json()).observation;
  const observe = async observation => {
    const response = await post('/tool', { name: 'browser_snapshot' }, { observation });
    assert.equal(response.status, 200);
    return (await response.json()).elements[0].ref;
  };
  const old = await observe(await grantObservation());
  await post('/observation', { enabled: false });
  const fresh = await observe(await grantObservation());
  assert.notEqual(fresh, old);
  const { lease } = await (await post('/view-only', { value: true })).json();
  const caller = new AbortController();
  const type = ref => post('/tool', { name: 'browser_type', args: { ref, text: 'fixed fixture input' } }, { lease, signal: caller.signal });
  assert.equal((await type(old)).status, 400);
  const input = assert.rejects(type(fresh), { name: 'AbortError' });
  assert.equal(await inputReached.promise, 'fixed fixture input');
  // Browser input has already been sent and remains in flight after the caller disconnects.
  caller.abort();
  await input;
  const stop = post('/view-only', { value: false });
  assert.equal(await Promise.race([stop.then(() => 'early'), delay(40, 'waiting')]), 'waiting');
  assert.deepEqual(calls, [true]);
  acknowledge.resolve();
  assert.equal((await (await stop).json()).stopped, true);
  assert.deepEqual(calls, [true, false]);
});
