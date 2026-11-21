import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, mkdir, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../src/server.mjs';
import { MAX_FILE_BYTES } from '../src/workspace.mjs';

const PASSWORD = 'test-owner-password-1234';
const ORIGIN = 'http://localhost:3180';
class FakeRuntime {
  calls = [];
  ready = true;
  browserReady = true;
  failLock = false;
  actionDelayMs = 0;
  async inspect() { return { ready: this.ready, browserReady: this.browserReady, sandboxEnabled: true }; }
  generation = 0;
  async setViewOnly(value, { signal } = {}) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    this.calls.push(`viewonly:${value}`);
    if (value && this.failLock) throw new Error('remote failed');
    return { generation: ++this.generation, ...(!value ? { stopped: true } : {}) };
  }
  async setObservation(enabled) { return { enabled, generation: ++this.generation }; }
  async openFixture({ url, signal, assertLease }) { if (this.actionDelayMs) await delay(this.actionDelayMs, null, { signal }); assertLease(); this.calls.push(`open:${url}`); }
  async fillAndSubmit({ signal, assertLease }) { if (this.actionDelayMs) await delay(this.actionDelayMs, null, { signal }); assertLease(); this.calls.push('submit'); }
  async capture() { return Buffer.from([137, 80, 78, 71]); }
  async close() {}
}
async function harness(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'private-control-test-'));
  const workspaceDir = path.join(root, 'Workspace');
  const dataDir = path.join(root, 'data');
  const webDir = path.join(root, 'web');
  const novncDir = path.join(root, 'novnc');
  const passwordFile = path.join(root, 'owner-password');
  await mkdir(webDir); await mkdir(novncDir); await mkdir(path.join(novncDir, 'core'));
  await writeFile(path.join(webDir, 'index.html'), '<h1>Private computer P0</h1>');
  await writeFile(path.join(novncDir, 'core', 'rfb.js'), 'export default class RFB {}');
  await writeFile(passwordFile, PASSWORD + '\n');
  const runtime = overrides.runtime ?? new FakeRuntime();
  const settings = { passwordFile, workspaceDir, dataDir, webDir, novncDir, runtime, stepDelayMs: 10, ...overrides };
  let server = await createServer(settings);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await server.shutdown(); await rm(root, { recursive: true, force: true }); });
  const request = (route, options = {}) => new Promise((resolve, reject) => {
    const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const headers = { Host: 'localhost:3180', ...(options.origin === null ? {} : { Origin: options.origin ?? ORIGIN }), ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.cookie ? { Cookie: options.cookie } : {}), ...options.headers };
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method: options.method ?? 'GET', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const buffer = Buffer.concat(chunks); let body; try { body = JSON.parse(buffer.toString()); } catch {} resolve({ status: res.statusCode, headers: res.headers, body, buffer }); });
    });
    req.on('error', reject); req.end(payload);
  });
  async function login() {
    const response = await request('/api/login', { method: 'POST', body: { password: PASSWORD } });
    assert.equal(response.status, 200);
    return response.headers['set-cookie'][0].split(';')[0];
  }
  async function restart() {
    for (const socket of sockets) socket.destroy();
    await server.shutdown();
    server = await createServer(settings); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  }
  return { root, workspaceDir, dataDir, webDir, novncDir, passwordFile, runtime, request, login, restart, get server() { return server; } };
}
async function until(fn, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { const value = await fn(); if (value) return value; await delay(5); }
  throw new Error('Expected state was not observed.');
}

test('password file is mandatory and weak/empty credentials fail closed', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'private-password-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(createServer({ passwordFile: path.join(root, 'missing') }), /ENOENT/);
  await writeFile(path.join(root, 'empty'), '');
  await assert.rejects(createServer({ passwordFile: path.join(root, 'empty') }), /at least 12/);
});
test('public health/UI/fixture contain no secrets; API and noVNC need login', async t => {
  const h = await harness(t);
  assert.deepEqual((await h.request('/healthz', { origin: null })).body, { ok: true, phase: 'p0' });
  assert.equal((await h.request('/')).status, 200);
  assert.match((await h.request('/fixture')).buffer.toString(), /demo-form/);
  for (const route of ['/api/status', '/api/files', '/api/desktop/screenshot', '/api/events', '/vendor/novnc/core/rfb.js', '/api/unknown']) assert.equal((await h.request(route)).status, 401, route);
  const health = (await h.request('/healthz')).buffer.toString();
  assert.ok(!health.includes(PASSWORD)); assert.ok(!health.includes(h.root));
});
test('strict Origin, Host and CSRF checks reject hostile and missing origins', async t => {
  const h = await harness(t);
  for (const origin of ['http://evil.example', 'null', 'http://localhost:9999']) {
    assert.equal((await h.request('/api/login', { method: 'POST', body: { password: PASSWORD }, origin })).status, 403);
  }
  assert.equal((await h.request('/api/login', { method: 'POST', body: { password: PASSWORD }, origin: null })).status, 403);
  assert.equal((await h.request('/healthz', { headers: { Host: 'evil.example:3180' } })).status, 403);
  assert.equal((await h.request('/healthz', { headers: { Host: 'localhost:3180.evil.example' } })).status, 403);
  assert.equal((await h.request('/api/login', { method: 'POST', body: { password: PASSWORD }, origin: 'http://127.0.0.1:3180', headers: { Host: '127.0.0.1:3180' } })).status, 200);
  const cookie = await h.login();
  assert.equal((await h.request('/api/demo', { method: 'POST', cookie, body: {}, origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.request('/api/demo', { method: 'POST', cookie, body: {}, origin: null })).status, 403);
  assert.equal((await h.request('/api/status', { cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});
test('configured deployment origin works and sets Secure session cookie', async t => {
  const h = await harness(t, { origin: 'https://computer.example' });
  const response = await h.request('/api/login', { method: 'POST', origin: 'https://computer.example', headers: { Host: 'computer.example' }, body: { password: PASSWORD } });
  assert.equal(response.status, 200); assert.match(response.headers['set-cookie'][0], /; Secure/);
  assert.equal((await h.request('/api/status', { cookie: response.headers['set-cookie'][0].split(';')[0], origin: 'https://computer.example', headers: { Host: 'computer.example' } })).status, 200);
});
test('passwords, random sessions, throttling, logout, expiry and restart invalidation', async t => {
  let now = Date.now();
  const h = await harness(t, { now: () => now, sessionTtlMs: 1000 });
  const bad = await h.request('/api/login', { method: 'POST', body: { password: 'wrong' } });
  assert.equal(bad.status, 401); assert.ok(!bad.buffer.toString().includes(PASSWORD));
  for (let i = 0; i < 4; i++) assert.equal((await h.request('/api/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  assert.equal((await h.request('/api/login', { method: 'POST', body: { password: PASSWORD } })).status, 429);
  now += 61000;
  const login = await h.request('/api/login', { method: 'POST', body: { password: PASSWORD } });
  assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.match(cookie, /^pc_session=[a-f0-9]{64}$/);
  assert.equal((await h.request('/api/status', { cookie })).status, 200);
  now += 1001; assert.equal((await h.request('/api/status', { cookie })).status, 401);
  const cookie2 = await h.login(); assert.notEqual(cookie, cookie2);
  assert.equal((await h.request('/api/logout', { method: 'POST', body: {}, cookie: cookie2 })).status, 200);
  assert.equal((await h.request('/api/status', { cookie: cookie2 })).status, 401);
  const cookie3 = await h.login();
  await h.restart(); assert.equal((await h.request('/api/status', { cookie: cookie3 })).status, 401);
});
test('JSON content type, malformed body and request limits are enforced', async t => {
  const h = await harness(t); const cookie = await h.login();
  assert.equal((await h.request('/api/demo', { method: 'POST', cookie, raw: '{' })).status, 400);
  assert.equal((await h.request('/api/demo', { method: 'POST', cookie, body: [], headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await h.request('/api/demo', { method: 'POST', cookie, raw: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await h.request('/api/login', { method: 'POST', raw: JSON.stringify({ password: 'a'.repeat(9000) }) })).status, 413);
});
test('workspace upload, list and descriptor-based download round trip', async t => {
  const h = await harness(t); const cookie = await h.login();
  const content = Buffer.from('持久工作文件\n');
  assert.equal((await h.request('/api/files', { method: 'POST', cookie, body: { name: '测试-report.md', contentBase64: content.toString('base64') } })).status, 201);
  const files = (await h.request('/api/files', { cookie })).body.files;
  assert.equal(files.length, 1); assert.equal(files[0].size, content.length); assert.ok(files[0].modifiedAt);
  assert.deepEqual((await h.request('/api/files/download?name=' + encodeURIComponent(files[0].name), { cookie })).buffer, content);
  const status = (await h.request('/api/status', { cookie })).body;
  assert.equal(status.phase, 'p0'); assert.equal(status.workspacePersistent, true); assert.equal(status.sandbox.enabled, true);
  await h.restart(); const cookie2 = await h.login(); assert.equal((await h.request('/api/files', { cookie: cookie2 })).body.files.length, 1);
});
test('file traversal, malformed base64, oversize and symlinks are rejected', async t => {
  const h = await harness(t); const cookie = await h.login();
  for (const name of ['../secret', '..', 'a..b', 'a/b', 'a\\b', '.hidden', '/etc/passwd', 'a\u0000b', 'report.']) {
    assert.equal((await h.request('/api/files', { method: 'POST', cookie, body: { name, contentBase64: 'YQ==' } })).status, 400, name);
    assert.equal((await h.request('/api/files/download?name=' + encodeURIComponent(name), { cookie })).status, 400, name);
  }
  assert.equal((await h.request('/api/files', { method: 'POST', cookie, body: { name: 'bad.txt', contentBase64: '%%%bad' } })).status, 400);
  assert.equal((await h.request('/api/files', { method: 'POST', cookie, body: { name: 'big.txt', contentBase64: Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64') } })).status, 413);
  const outside = path.join(h.root, 'outside.txt'); await writeFile(outside, 'outside-secret');
  await symlink(outside, path.join(h.workspaceDir, 'linked.txt'));
  assert.equal((await h.request('/api/files/download?name=linked.txt', { cookie })).status, 400);
  assert.equal((await h.request('/api/files', { method: 'POST', cookie, body: { name: 'linked.txt', contentBase64: 'YQ==' } })).status, 400);
  assert.equal(await readFile(outside, 'utf8'), 'outside-secret');
  assert.ok(!(await h.request('/api/files', { cookie })).body.files.some(file => file.name === 'linked.txt'));
});
test('noVNC static resources are authenticated and canonical paths cannot escape', async t => {
  const h = await harness(t); const cookie = await h.login();
  assert.equal((await h.request('/vendor/novnc/core/rfb.js', { cookie })).status, 200);
  assert.equal((await h.request('/vendor/novnc/%2e%2e%2fowner-password', { cookie })).status, 400);
  assert.equal((await h.request('/vendor/novnc/core%5crfb.js', { cookie })).status, 400);
  await symlink(h.passwordFile, path.join(h.novncDir, 'secret.js'));
  assert.equal((await h.request('/vendor/novnc/secret.js', { cookie })).status, 403);
  assert.equal((await h.request('/api/desktop/screenshot', { cookie })).headers['content-type'], 'image/png');
});
test('demo requires ready desktop and enforced VNC viewonly before any action', async t => {
  const h = await harness(t); const cookie = await h.login();
  h.runtime.ready = false; assert.equal((await h.request('/api/demo', { method: 'POST', body: {}, cookie })).status, 503);
  h.runtime.ready = true; h.runtime.failLock = true;
  assert.equal((await h.request('/api/demo', { method: 'POST', body: {}, cookie })).status, 503);
  assert.ok(!h.runtime.calls.some(call => call.startsWith('open:') || call === 'submit'));
  assert.equal((await h.request('/api/status', { cookie })).body.run.status, 'failed');
});
test('fixed demo completes three steps, saves report and records run events', async t => {
  const h = await harness(t); const cookie = await h.login();
  const result = await h.request('/api/demo', { method: 'POST', body: {}, cookie }); assert.equal(result.status, 202);
  assert.equal((await h.request('/api/demo', { method: 'POST', body: {}, cookie })).status, 409);
  const state = await until(async () => { const state = (await h.request('/api/status', { cookie })).body; return state.run?.status === 'succeeded' && state.control.owner === 'human' && state; });
  assert.equal(state.run.steps.length, 3); assert.ok(state.run.steps.every(step => step.status === 'succeeded'));
  assert.ok(h.runtime.calls.indexOf('viewonly:true') < h.runtime.calls.findIndex(call => call.startsWith('open:')));
  assert.ok(h.runtime.calls.includes('submit')); assert.equal(h.runtime.calls.at(-1), 'viewonly:false');
  assert.equal(state.files.length, 1); assert.match(await readFile(path.join(h.workspaceDir, state.files[0].name), 'utf8'), /没有调用模型/);
  const persisted = JSON.parse(await readFile(path.join(h.dataDir, 'state.json'), 'utf8'));
  assert.equal(persisted.run.id, result.body.id); assert.ok(persisted.events.some(event => event.type === 'step.succeeded'));
});
test('takeover revokes generation, aborts queued actions and prevents later inputs', async t => {
  const h = await harness(t, { stepDelayMs: 80 }); const cookie = await h.login();
  await h.request('/api/demo', { method: 'POST', body: {}, cookie });
  const before = (await h.request('/api/status', { cookie })).body.control.generation;
  const result = await h.request('/api/control/takeover', { method: 'POST', body: {}, cookie });
  assert.equal(result.status, 200); assert.equal(result.body.control.owner, 'human'); assert.ok(result.body.control.generation > before);
  const calls = [...h.runtime.calls]; await delay(150); assert.deepEqual(h.runtime.calls, calls);
  assert.ok(!calls.some(call => call.startsWith('open:') || call === 'submit'));
  assert.equal(result.body.run.status, 'cancelled'); assert.equal(result.body.files.length, 0);
});
test('takeover during a cancellable in-flight action prevents its input and subsequent steps', async t => {
  const runtime = new FakeRuntime(); runtime.actionDelayMs = 300;
  const h = await harness(t, { runtime }); const cookie = await h.login();
  await h.request('/api/demo', { method: 'POST', body: {}, cookie });
  await delay(30);
  assert.equal((await h.request('/api/control/takeover', { method: 'POST', body: {}, cookie })).status, 200);
  await delay(30);
  assert.ok(!runtime.calls.some(call => call.startsWith('open:') || call === 'submit'));
});
test('cancel uses the same revocation path and restores human input', async t => {
  const h = await harness(t, { stepDelayMs: 100 }); const cookie = await h.login();
  await h.request('/api/demo', { method: 'POST', body: {}, cookie });
  const response = await h.request('/api/run/cancel', { method: 'POST', body: {}, cookie });
  assert.equal(response.status, 200); assert.equal(response.body.run.status, 'cancelled'); assert.equal(response.body.control.owner, 'human');
});
test('startup converts saved running into interrupted and never resumes actions', async t => {
  const h = await harness(t); await h.server.shutdown();
  const id = '11111111-1111-4111-8111-111111111111';
  await writeFile(path.join(h.dataDir, 'state.json'), JSON.stringify({ version: 1, generation: 4, events: [], run: { id, status: 'running', steps: [{ title: 'old action', status: 'running' }] } }));
  await h.restart(); const cookie = await h.login();
  const state = (await h.request('/api/status', { cookie })).body;
  assert.equal(state.run.status, 'interrupted'); assert.equal(state.run.steps[0].status, 'cancelled'); assert.equal(state.control.owner, 'human');
  assert.ok(!h.runtime.calls.some(call => call.startsWith('open:')));
  assert.equal(JSON.parse(await readFile(path.join(h.dataDir, 'state.json'), 'utf8')).run.status, 'interrupted');
});
test('authenticated SSE emits state and logout closes the stream', async t => {
  const h = await harness(t); const cookie = await h.login();
  const connection = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: h.server.address().port, path: '/api/events', headers: { Host: 'localhost:3180', Origin: ORIGIN, Cookie: cookie } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; if (text.includes('event: state') && text.includes('"phase":"p0"')) resolve({ res, req, text }); });
    }); req.on('error', reject);
  });
  assert.equal(connection.res.statusCode, 200);
  const ended = once(connection.res, 'end');
  await h.request('/api/logout', { method: 'POST', cookie, body: {} }); await ended;
});
function upgradeRequest(h, { cookie, origin = ORIGIN } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.server.address().port, path: '/desktop', headers: { Host: 'localhost:3180', Origin: origin, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Protocol': 'binary', ...(cookie ? { Cookie: cookie } : {}) } });
    req.on('upgrade', (res, socket, head) => resolve({ status: res.statusCode, socket, head }));
    req.on('response', res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', reject); req.end();
  });
}
test('desktop WebSocket rejects missing auth and hostile Origin', async t => {
  const h = await harness(t); assert.equal((await upgradeRequest(h)).status, 401);
  const cookie = await h.login(); assert.equal((await upgradeRequest(h, { cookie, origin: 'http://evil.example' })).status, 403);
});
test('desktop WebSocket transparently preserves binary frames and logout closes it', async t => {
  const upstream = http.createServer();
  const upstreamSockets = new Set();
  upstream.on('upgrade', (req, socket) => {
    upstreamSockets.add(socket); socket.on('close', () => upstreamSockets.delete(socket)); socket.on('error', () => {});
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: binary\r\n\r\n`);
    socket.on('data', chunk => socket.write(chunk));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(async () => { for (const socket of upstreamSockets) socket.destroy(); await new Promise(resolve => upstream.close(resolve)); });
  const h = await harness(t, { vncWsPort: upstream.address().port }); const cookie = await h.login();
  const connection = await upgradeRequest(h, { cookie }); assert.equal(connection.status, 101);
  const competingCookie = await h.login();
  assert.equal((await upgradeRequest(h, { cookie: competingCookie })).status, 409);
  const frame = Buffer.from([0x82, 0x84, 1, 2, 3, 4, 0, 255, 0, 250]);
  const echoed = once(connection.socket, 'data'); connection.socket.write(frame); assert.deepEqual((await echoed)[0], frame);
  const closed = once(connection.socket, 'close'); await h.request('/api/logout', { method: 'POST', cookie, body: {} }); await closed;
  const next = await upgradeRequest(h, { cookie: competingCookie }); assert.equal(next.status, 101); next.socket.destroy();
});

const responseUsage = { inputTokens: 3, outputTokens: 2, totalTokens: 5, reasoningTokens: 0 };
const finishResponse = { output: [], outputText: 'Done.', usage: responseUsage };
const toolResponse = (name, args, call_id) => ({
  output: [{ type: 'function_call', call_id, name, arguments: JSON.stringify(args) }], usage: responseUsage,
});

function scriptedModel(responses) {
  return {
    calls: [],
    metadata: () => ({ configured: true, model: 'fixture-model' }),
    async respond(request) {
      this.calls.push(structuredClone(request.input));
      const next = responses.shift();
      if (typeof next === 'function') return next(request);
      if (!next) throw new Error('Fixture exhausted.');
      return next;
    },
  };
}

function connectOwnerEvents(h, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: h.server.address().port, path: '/api/events', headers: { Host: 'localhost:3180', Origin: ORIGIN, Cookie: cookie } }, res => {
      res.on('error', reject);
      res.resume();
      resolve({ req, res });
    });
    req.on('error', reject);
  });
}

for (const policy of ['pause_at_approval', 'stop']) {
  test(`offline ${policy} follows the last authenticated owner event stream`, async t => {
    const model = scriptedModel([toolResponse('workspace_write', { name: 'pending.md', content: 'PRIVATE_PREVIEW' }, 'pending')]);
    const h = await harness(t, { model, offlineGraceMs: 30 });
    const cookie = await h.login();
    const get = route => h.request(route, { cookie });
    const post = (route, body) => h.request(route, { method: 'POST', cookie, body });
    const state = async () => (await get('/api/status')).body;
    const task = { goal: 'Leave a draft.', offlinePolicy: policy };
    assert.equal((await post('/api/tasks', task)).status, 409);
    assert.equal(model.calls.length, 0);
    const first = await connectOwnerEvents(h, cookie);
    const second = await connectOwnerEvents(h, await h.login());
    assert.equal(first.res.statusCode, 200);
    assert.equal(second.res.statusCode, 200);
    assert.equal((await state()).ownerOnline, true);
    const launch = await post('/api/tasks', task);
    assert.equal(launch.status, 202);
    const waiting = await until(async () => (await state()).run?.approval);
    const inbox = (await get('/api/inbox')).body.items;
    assert.ok(inbox.some(item => item.kind === 'approval' && item.runId === launch.body.id));
    assert.doesNotMatch(JSON.stringify(inbox), /PRIVATE_PREVIEW|pending\.md/);
    first.req.destroy();
    await delay(60);
    assert.equal((await state()).ownerOnline, true);
    assert.equal((await state()).run.status, 'awaiting_approval');
    second.req.destroy();
    const expected = policy === 'stop' ? 'cancelled' : 'paused';
    const settled = await until(async () => { const current = await state(); return current.canStart && current.run?.status === expected && current; });
    assert.equal(settled.ownerOnline, false);
    assert.equal(settled.control.private, policy === 'pause_at_approval');
    assert.equal((await post(`/api/tasks/${launch.body.id}/approval`, { approvalId: waiting.id, decision: 'approve' })).status, 409);
    assert.deepEqual((await get(`/api/tasks/${launch.body.id}/artifacts`)).body.artifacts, []);
    assert.equal(model.calls.length, 1);
  });
}

test('draft grant stages exact names, revokes explicitly, and leaves a new attempt ungranted', async t => {
  const waitingForOwner = Promise.withResolvers();
  const model = scriptedModel([
    toolResponse('workspace_write', { name: 'granted.txt', content: 'Private draft' }, 'granted'),
    () => waitingForOwner.promise,
    finishResponse,
  ]);
  const h = await harness(t, { model });
  const cookie = await h.login();
  const get = route => h.request(route, { cookie });
  const post = (route, body) => h.request(route, { method: 'POST', cookie, body });
  const draftGrant = { names: ['granted.txt'], maxWrites: 2, maxBytes: 100, ttlMs: 30000 };
  assert.equal((await post('/api/tasks', { goal: 'Scope required.', draftGrant, observe: { workspace: false, desktop: false } })).status, 400);
  const launch = await post('/api/tasks', { goal: 'Stage the chosen files.', draftGrant, observe: { workspace: true, desktop: false } });
  assert.equal(launch.status, 202);
  const route = `/api/tasks/${launch.body.id}`;
  await until(async () => model.calls.length === 2);
  const grant = (await get('/api/status')).body.run.draftGrant;
  assert.equal(grant.usedWrites, 1);
  assert.equal(grant.remainingBytes, 87);
  assert.equal((await get('/api/files/download?name=granted.txt')).status, 404);
  const revoked = await post(`${route}/grant/revoke`, {});
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.draftGrant.status, 'revoked');
  waitingForOwner.resolve(toolResponse('workspace_write', { name: 'granted.txt', content: 'Review this' }, 'after-revoke'));
  const pending = await until(async () => (await get('/api/status')).body.run?.approval);
  assert.equal(pending.preview.content, 'Review this');
  assert.equal((await post(`${route}/approval`, { decision: 'approve', approvalId: pending.id })).status, 200);
  await until(async () => (await get('/api/status')).body.run?.status === 'succeeded');
  assert.equal((await get(`${route}/artifacts/granted.txt/download`)).buffer.toString(), 'Review this');
  assert.equal((await post(`${route}/grant/revoke`, {})).status, 409);
});

test('owner templates and inbox preserve only scoped information across unrelated runs and restarts', async t => {
  const model = scriptedModel([
    toolResponse('workspace_write', { name: 'older.txt', content: 'OLDER_PRIVATE_DRAFT' }, 'old'),
    finishResponse, finishResponse,
  ]);
  const h = await harness(t, { model });
  let cookie = await h.login();
  const get = route => h.request(route, { cookie });
  const post = (route, body) => h.request(route, { method: 'POST', cookie, body });
  assert.equal((await h.request('/api/templates')).status, 401);
  const launch = await post('/api/tasks', { goal: 'Reusable goal', offlinePolicy: 'continue', observe: { workspace: true, desktop: false } });
  assert.equal(launch.status, 202);
  const approval = await until(async () => (await get('/api/status')).body.run?.approval);
  assert.equal((await post('/api/templates', { name: 'Too early', workId: launch.body.workId })).status, 409);
  assert.equal((await post(`/api/tasks/${launch.body.id}/approval`, { decision: 'approve', approvalId: approval.id })).status, 200);
  await until(async () => (await get('/api/status')).body.run?.status === 'succeeded');
  const template = await post('/api/templates', { name: '  Weekly draft  ', workId: launch.body.workId });
  assert.equal(template.status, 201);
  assert.deepEqual(Object.keys(template.body.template).sort(), ['createdAt', 'goal', 'id', 'name']);
  assert.equal(template.body.template.goal, 'Reusable goal');
  assert.equal((await post('/api/templates', { name: 'weekly draft', workId: launch.body.workId })).status, 409);
  const second = await post('/api/tasks', { goal: 'Unrelated second run' });
  assert.equal(second.status, 202);
  await until(async () => (await get('/api/status')).body.run?.status === 'succeeded');
  const inbox = (await get('/api/inbox')).body.items;
  assert.ok(inbox.some(item => item.kind === 'artifacts' && item.runId === launch.body.id && item.count === 1));
  assert.ok(inbox.some(item => item.kind === 'backup'));
  assert.doesNotMatch(JSON.stringify(inbox), /OLDER_PRIVATE_DRAFT|older\.txt|Reusable goal/);
  await h.restart(); cookie = await h.login();
  assert.deepEqual((await get('/api/templates')).body.templates, [template.body.template]);
  assert.equal((await h.request(`/api/templates/${template.body.template.id}`, { method: 'DELETE', cookie })).status, 200);
  assert.deepEqual((await get('/api/templates')).body.templates, []);
});

test('owner HTTP moves paused work into a new run with fresh scopes and cumulative usage', async t => {
  const model = scriptedModel([
    toolResponse('workspace_write', { name: 'old.md', content: 'stale suggestion' }, 'pending-write'),
    finishResponse,
  ]);
  const h = await harness(t, { model });
  const cookie = await h.login();
  const post = (route, body) => h.request(route, { method: 'POST', cookie, body });
  const state = async () => (await h.request('/api/status', { cookie })).body;
  const first = await post('/api/tasks', { goal: 'Prepare the report.', observe: { workspace: true, desktop: false } });
  assert.equal(first.status, 202);
  const waiting = await until(async () => { const current = await state(); return current.run?.approval && current; });
  const paused = await post('/api/control/pause', { runId: first.body.id });
  assert.equal(paused.status, 200);
  const { work, control } = paused.body;
  assert.equal(paused.body.run.status, 'paused');
  assert.equal(control.private, true);
  assert.equal(work.handoff.notExecuted[0].tool, 'workspace_write');
  assert.equal((await post(`/api/tasks/${first.body.id}/approval`, { approvalId: waiting.run.approval.id, decision: 'approve' })).status, 409);
  assert.equal((await post('/api/tasks', { goal: 'No implicit scope while private.' })).status, 400);
  assert.equal((await post(`/api/works/${work.id}/redelegate`, { revision: work.revision - 1, observe: { workspace: true, desktop: false } })).status, 409);
  await post('/api/files', { name: 'changed.md', contentBase64: Buffer.from('OWNER_ONLY_FRESH_FILE').toString('base64') });
  const next = await post(`/api/works/${work.id}/redelegate`, { revision: work.revision, context: 'OWNER_CONTEXT_DELTA', observe: { workspace: true, desktop: false } });
  assert.equal(next.status, 202);
  assert.notEqual(next.body.id, first.body.id);
  assert.equal(next.body.workId, first.body.workId);
  const done = await until(async () => { const current = await state(); return current.run?.status === 'succeeded' && current.canStart && current; });
  assert.deepEqual(done.work.runIds, [first.body.id, next.body.id]);
  assert.equal(done.work.budget.tokensUsed, 10);
  assert.match(JSON.stringify(model.calls[1]), /OWNER_CONTEXT_DELTA/);
  assert.match(JSON.stringify(model.calls[1]), /changed\.md/);
  assert.doesNotMatch(JSON.stringify(model.calls[1]), /stale suggestion|OWNER_ONLY_FRESH_FILE/);
  assert.deepEqual((await h.request('/api/works', { cookie })).body.works.map(item => item.id), [work.id]);
  await h.restart();
  const newCookie = await h.login();
  const restored = (await h.request(`/api/works/${work.id}`, { cookie: newCookie })).body.work;
  assert.equal(restored.budget.tokensUsed, 10);
  assert.doesNotMatch(await readFile(path.join(h.dataDir, 'state.json'), 'utf8'), /OWNER_CONTEXT_DELTA|OWNER_ONLY_FRESH_FILE/);
});

test('owner HTTP reviews staged modifications by version and restores selected files', async t => {
  const model = scriptedModel([
    toolResponse('workspace_write', { name: 'report.md', content: 'Draft report.\n' }, 'stage-report'),
    toolResponse('workspace_write', { name: 'note.txt', content: 'Draft note.\n' }, 'stage-note'),
    finishResponse,
  ]);
  const h = await harness(t, { model });
  const cookie = await h.login();
  const get = route => h.request(route, { cookie });
  const post = (route, body) => h.request(route, { method: 'POST', cookie, body });
  await post('/api/files', { name: 'report.md', contentBase64: Buffer.from('Owner report.\n').toString('base64') });
  const started = await post('/api/tasks', { goal: 'Draft two files.' });
  assert.equal(started.status, 202);
  const base = `/api/tasks/${started.body.id}`;
  for (const name of ['report.md', 'note.txt']) {
    const approval = await until(async () => {
      const current = (await get('/api/status')).body;
      return current.run?.approval?.args?.name === name && current.run.approval;
    });
    assert.equal((await post(`${base}/approval`, { approvalId: approval.id, decision: 'approve' })).status, 200);
  }
  await until(async () => (await get('/api/status')).body.run.status === 'succeeded');
  assert.equal((await get('/api/files/download?name=report.md')).buffer.toString(), 'Owner report.\n');
  assert.equal((await get('/api/files/download?name=note.txt')).status, 404);
  assert.equal((await h.request(`${base}/artifacts`)).status, 401);
  const { artifacts } = (await get(`${base}/artifacts`)).body;
  assert.equal(artifacts.length, 2);
  const draft = artifacts.find(item => item.name === 'report.md');
  const diff = await get(`${base}/artifacts/report.md/diff`);
  assert.match(diff.body.diff.text, /-Owner report\.\n\+Draft report\./);
  assert.equal((await get(`${base}/artifacts/report.md/download`)).buffer.toString(), 'Draft report.\n');
  assert.equal((await post(`${base}/artifacts/report.md/accept`, {})).status, 400);
  assert.equal((await post(`${base}/artifacts/report.md/accept`, { expectedVersion: 'stale' })).status, 409);
  assert.equal((await post(`${base}/artifacts/report.md/accept`, { expectedVersion: draft.version })).status, 200);
  assert.equal((await get('/api/files/download?name=report.md')).buffer.toString(), 'Draft report.\n');
  assert.equal((await get('/api/files/download?name=note.txt')).status, 404);
  const recovery = (await get('/api/recovery')).body.recovery.find(item => item.name === 'report.md' && item.runId === started.body.id);
  assert.equal((await post(`/api/recovery/${recovery.id}/restore`, {})).status, 200);
  assert.equal((await get('/api/files/download?name=report.md')).buffer.toString(), 'Owner report.\n');
});
