import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace, decodeFile, HttpError } from './workspace.mjs';
import { createArtifactStore } from './artifacts.mjs';
import { createOwnerOperations } from './owner-operations.mjs';
import { createController } from './controller.mjs';
import { createGuestRuntime } from './runtime.mjs';
import { createRemoteRuntime } from './remote-runtime.mjs';
import { createResponsesModel, ModelError } from './model.mjs';
import { createDshAcpExecutor } from './acp.mjs';
import { AgentError } from './agent.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'pc_session';
const JSON_LIMIT = 7 * 1024 * 1024 + 4096;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8' };
const FIXTURE_SCRIPT = `document.querySelector('#demo-form').addEventListener('submit',event=>{event.preventDefault();document.querySelector('#result').textContent='已提交：'+document.querySelector('#project').value+' — '+document.querySelector('#note').value;document.querySelector('#result').focus();});`;
const FIXTURE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>私人云电脑 P0 本地演示</title><link rel="stylesheet" href="/fixture.css"></head><body><main><p>P0 · 本地固定演示 · 无模型调用</p><h1>同一台真实电脑，随时人工接管</h1><p>自动化会在这个有界面的 Chromium 中填写表单，并将报告保存在工作区。</p><form id="demo-form"><label>项目名称<input id="project" name="project" required autocomplete="off"></label><label>演示备注<textarea id="note" name="note" required></textarea></label><button type="submit">提交本地演示</button></form><output id="result" tabindex="-1" aria-live="polite">等待填写表单</output></main><script src="/fixture.js"></script></body></html>`;
const FIXTURE_CSS = 'body{font:20px system-ui,sans-serif;background:#eef2f6;color:#142036;margin:0}main{max-width:820px;margin:50px auto;padding:40px;background:white;border-radius:18px}h1{font-size:36px}label{display:block;margin:24px 0}input,textarea{display:block;box-sizing:border-box;width:100%;padding:12px;font:inherit;border:1px solid #8a9ab0;border-radius:6px}button{padding:14px 24px;background:#164fc5;color:white;font:inherit;border:0;border-radius:6px}output{display:block;padding:22px;margin-top:26px;background:#e4f5eb;min-height:28px}';
const hash = value => createHash('sha256').update(value).digest();

function safeHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}
function json(res, status, value) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function bodyJson(req, limit = JSON_LIMIT) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Content-Type must be application/json.');
  const declared = req.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new HttpError(413, 'Request body is too large.');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON.'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new HttpError(400, 'JSON body must be an object.');
  return value;
}
async function readPassword(file) {
  if (!file) throw new Error('OWNER_PASSWORD_FILE is required; no default password exists.');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4096) throw new Error('Password file must be a regular file of at most 4096 bytes.');
    const password = (await handle.readFile('utf8')).replace(/\r?\n$/, '');
    if (Buffer.byteLength(password) < 12 || password.includes('\n') || password.includes('\r')) throw new Error('Owner password must be one line of at least 12 bytes.');
    return hash(password);
  } finally { await handle.close(); }
}
function createOriginPolicy(origin) {
  const primary = new URL(origin);
  if (!['http:', 'https:'].includes(primary.protocol) || primary.username || primary.password || primary.pathname !== '/' || primary.search || primary.hash) throw new Error('APP_ORIGIN must be a complete HTTP(S) origin.');
  const origins = new Set([primary.origin]);
  if (['localhost', '127.0.0.1'].includes(primary.hostname)) {
    for (const hostname of ['localhost', '127.0.0.1']) { const alias = new URL(primary); alias.hostname = hostname; origins.add(alias.origin); }
  }
  const hosts = new Set([...origins].map(value => new URL(value).host));
  const internalFixtureHost = process.env.INTERNAL_CONTROL_ORIGIN ? new URL(process.env.INTERNAL_CONTROL_ORIGIN).host : null;
  return {
    secureCookie: primary.protocol === 'https:',
    check(req, { mutation = false, websocket = false, localFixture = false } = {}) {
      const host = req.headers.host;
      const localHost = `127.0.0.1:${req.socket.localPort}`;
      const localAlias = `localhost:${req.socket.localPort}`;
      if (!host || (!hosts.has(host.toLowerCase()) && !(localFixture && [localHost, localAlias, internalFixtureHost].includes(host.toLowerCase())))) throw new HttpError(403, 'Host is not allowed.');
      const source = req.headers.origin;
      if ((source && !origins.has(source)) || ((mutation || websocket) && !source)) throw new HttpError(403, 'A trusted same-origin request is required.');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed.');
    },
  };
}
function sessionToken(req) {
  const cookies = (req.headers.cookie ?? '').split(';').map(value => value.trim());
  const matches = cookies.filter(value => value.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
async function staticFile(root, relative, res) {
  // realpath is intentional: Debian noVNC distributions can contain internal symlinks.
  // Both the lexical and canonical target must remain inside the resource root.
  if (relative.includes('\0') || relative.includes('\\') || relative.split('/').some(part => part === '..' || part.startsWith('.'))) throw new HttpError(400, 'Invalid resource path.');
  const resolvedRoot = await realpath(root).catch(() => { throw new HttpError(404, 'Resource not installed.'); });
  const candidate = path.resolve(resolvedRoot, relative);
  if (!candidate.startsWith(resolvedRoot + path.sep)) throw new HttpError(403, 'Resource is outside its root.');
  let canonical;
  try { canonical = await realpath(candidate); } catch { throw new HttpError(404, 'Resource not found.'); }
  if (!canonical.startsWith(resolvedRoot + path.sep)) throw new HttpError(403, 'Resource is outside its root.');
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new HttpError(404, 'Resource not found.');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(canonical)] ?? 'application/octet-stream', 'Content-Length': info.size });
    await new Promise((resolve, reject) => {
      const stream = handle.createReadStream({ autoClose: false });
      stream.on('error', reject); res.on('close', () => { stream.destroy(); resolve(); }); stream.on('end', resolve); stream.pipe(res);
    });
  } finally { await handle.close(); }
}

/**
 * Usage: const server = await createServer({passwordFile, workspaceDir, dataDir, runtime?});
 * server.listen(port, host); await server.shutdown();
 * createApp exposes {handler, upgrade, controller, close} for embedding/tests.
 * Runtime injection contract is documented beside createController in controller.mjs.
 */
export async function createApp(options = {}) {
  const port = Number(options.port ?? process.env.APP_PORT ?? 3180);
  const origin = options.origin ?? process.env.APP_ORIGIN ?? `http://localhost:${port}`;
  const policy = createOriginPolicy(origin);
  const passwordHash = await readPassword(options.passwordFile ?? process.env.OWNER_PASSWORD_FILE);
  const dataDir = options.dataDir ?? process.env.DATA_DIR ?? '/home/desktop/.private-computer';
  const workspace = await createWorkspace(options.workspaceDir ?? process.env.WORKSPACE_DIR ?? '/home/desktop/Workspace');
  const artifacts = await createArtifactStore({ workspace, dataDir });
  const ownerOperations = await createOwnerOperations({ dataDir });
  const runtime = options.runtime ?? (process.env.DESKTOP_RUNNER_URL ? await createRemoteRuntime() : createGuestRuntime(options.runtimeOptions));
  const model = options.model ?? (process.env.MODEL_ENABLED === '1' ? (process.env.MODEL_EXECUTOR === 'dsh-acp' ? await createDshAcpExecutor() : await createResponsesModel()) : undefined);
  const controller = await createController({
    runtime, workspace, artifacts, model, agentLimits: options.agentLimits, dataDir,
    fixtureUrl: options.fixtureUrl ?? new URL('/fixture', process.env.INTERNAL_CONTROL_ORIGIN || `http://127.0.0.1:${port}`).href,
    stepDelayMs: options.stepDelayMs ?? 2000,
  });
  let modelTesting = false;
  let startingRun = false;
  const webDir = options.webDir ?? path.resolve(HERE, '../../web');
  const novncDir = options.novncDir ?? process.env.NOVNC_DIR ?? '/usr/share/novnc';
  const upstreamPort = options.vncWsPort ?? Number(process.env.VNC_WS_PORT ?? 6081);
  const upstreamHost = options.vncWsHost ?? process.env.DESKTOP_VNC_HOST ?? '127.0.0.1';
  const now = options.now ?? Date.now;
  const sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60 * 1000;
  const sessions = new Map();
  const throttles = new Map();
  const sseClients = new Set();
  const wsClients = new Set();
  let closed = false;
  function authenticate(req) {
    const token = sessionToken(req);
    const session = token && sessions.get(token);
    if (!session || session.expiresAt <= now()) {
      if (token) sessions.delete(token);
      throw new HttpError(401, 'Login required.');
    }
    return { token, session };
  }
  function invalidate(token) {
    sessions.delete(token);
    for (const client of sseClients) if (client.token === token) client.res.end();
    for (const client of wsClients) if (client.token === token) client.close();
  }
  const expiryTimer = setInterval(() => {
    for (const [token, session] of sessions) if (session.expiresAt <= now()) invalidate(token);
    for (const [key, value] of throttles) if (now() - value.start > 60000) throttles.delete(key);
  }, Math.min(sessionTtlMs, 15000));
  expiryTimer.unref();
  let broadcasting = false;
  let again = false;
  async function broadcast() {
    if (broadcasting) { again = true; return; }
    broadcasting = true;
    try {
      do {
        again = false;
        if (sseClients.size) {
          const payload = `event: state\ndata: ${JSON.stringify(await controller.status())}\n\n`;
          for (const client of sseClients) {
            if (client.session.expiresAt <= now()) { client.res.end(); continue; }
            if (!client.res.write(payload)) client.res.end();
          }
        }
      } while (again && !closed);
    } catch { for (const client of sseClients) client.res.end(); }
    finally { broadcasting = false; }
  }
  controller.events.on('change', broadcast);
  const closeDesktop = () => { for (const client of wsClients) client.close(); };
  controller.events.on('input-revoked', closeDesktop);

  function assertFields(value, fields) {
    if (Object.keys(value).some(key => !fields.includes(key))) throw new HttpError(400, 'Unknown request setting.');
  }
  async function launch(res, operation) {
    if (modelTesting || startingRun) throw new HttpError(409, 'Another model operation is active.');
    startingRun = true;
    try { return json(res, 202, await operation()); }
    finally { startingRun = false; }
  }
  function attachment(res, name, content) {
    const encoded = encodeURIComponent(name).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': content.length, 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encoded}` });
    return res.end(content);
  }
  async function handler(req, res) {
    safeHeaders(res);
    try {
      const url = new URL(req.url, origin);
      const pathname = decodeURIComponent(url.pathname);
      const localFixture = ['/fixture', '/fixture.js', '/fixture.css'].includes(pathname);
      policy.check(req, { mutation: !['GET', 'HEAD'].includes(req.method), localFixture: localFixture || pathname === '/healthz' });
      if (closed) throw new HttpError(503, 'Control service is closing.');
      if (pathname === '/healthz' && req.method === 'GET') return json(res, 200, { ok: true, phase: model ? 'mvp' : 'p0' });
      if (localFixture && req.method === 'GET') {
        const data = pathname === '/fixture' ? FIXTURE : pathname === '/fixture.js' ? FIXTURE_SCRIPT : FIXTURE_CSS;
        res.writeHead(200, { 'Content-Type': pathname === '/fixture' ? TYPES['.html'] : pathname.endsWith('.js') ? TYPES['.js'] : TYPES['.css'] });
        return res.end(data);
      }
      if (pathname === '/api/login' && req.method === 'POST') {
        const key = req.socket.remoteAddress;
        let attempts = throttles.get(key);
        if (!attempts || now() - attempts.start >= 60000) { attempts = { start: now(), count: 0 }; throttles.set(key, attempts); }
        if (attempts.count >= 5) { res.setHeader('Retry-After', '60'); throw new HttpError(429, 'Too many login attempts. Try again in one minute.'); }
        attempts.count++;
        const body = await bodyJson(req, 8192);
        const valid = typeof body.password === 'string' && Buffer.byteLength(body.password) <= 4096 && timingSafeEqual(hash(body.password), passwordHash);
        if (!valid) throw new HttpError(401, 'Invalid password.');
        throttles.delete(key);
        const previous = sessionToken(req); if (previous) invalidate(previous);
        for (const [token, session] of sessions) if (session.expiresAt <= now()) invalidate(token);
        if (sessions.size >= 128) invalidate(sessions.keys().next().value);
        const token = randomBytes(32).toString('hex');
        sessions.set(token, { expiresAt: now() + sessionTtlMs });
        res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}${policy.secureCookie ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }
      let authentication;
      if (pathname.startsWith('/api/') || pathname.startsWith('/vendor/novnc/') || pathname === '/desktop') authentication = authenticate(req);
      if (pathname === '/api/logout' && req.method === 'POST') {
        await bodyJson(req, 8192);
        invalidate(authentication.token);
        res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${policy.secureCookie ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }
      if (pathname === '/api/status' && req.method === 'GET') return json(res, 200, await controller.status());
      if (pathname === '/api/tasks' && req.method === 'GET') return json(res, 200, { runs: await controller.listRuns({ limit: Number(url.searchParams.get('limit') || 20) }) });
      if (pathname === '/api/tasks' && req.method === 'POST') {
        const value = await bodyJson(req, 20000);
        assertFields(value, ['goal', 'allowDesktop', 'observe']);
        return await launch(res, () => controller.startTask(value));
      }
      const runRoute = /^\/api\/tasks\/([^/]+)(?:\/(approval))?$/.exec(pathname);
      if (runRoute && req.method === 'GET' && !runRoute[2]) return json(res, 200, { run: await controller.getRun(runRoute[1]) });
      if (runRoute?.[2] === 'approval' && req.method === 'POST') {
        const value = await bodyJson(req, 8192);
        assertFields(value, ['approvalId', 'decision']);
        return json(res, 200, await controller.decideApproval(runRoute[1], value));
      }
      if (pathname === '/api/works' && req.method === 'GET') return json(res, 200, { works: controller.listWorks() });
      const workRoute = /^\/api\/works\/([^/]+)(?:\/(redelegate|usage))?$/.exec(pathname);
      if (workRoute) {
        const [, id, action] = workRoute;
        if (!action && req.method === 'GET') return json(res, 200, { work: controller.getWork(id) });
        if (action === 'redelegate' && req.method === 'POST') {
          const value = await bodyJson(req, 20000);
          assertFields(value, ['revision', 'context', 'observe', 'allowDesktop', 'externalResult', 'extraTokens', 'extraSteps', 'extraDurationMs']);
          return await launch(res, () => controller.redelegate(id, value));
        }
        if (action === 'usage' && req.method === 'POST') {
          const value = await bodyJson(req, 8192);
          assertFields(value, ['revision', 'runId', 'totalTokens']);
          return json(res, 200, { work: await controller.reconcile(id, value) });
        }
      }
      const artifactRoute = /^\/api\/tasks\/([^/]+)\/artifacts(?:\/([^/]+)\/(diff|download|accept))?$/.exec(pathname);
      if (artifactRoute) {
        const [, id, name, action] = artifactRoute;
        const run = await controller.getRun(id);
        if (!action && req.method === 'GET') return json(res, 200, { artifacts: await artifacts.list(id) });
        if (action === 'diff' && req.method === 'GET') return json(res, 200, { diff: await artifacts.diff(id, name) });
        if (action === 'download' && req.method === 'GET') return attachment(res, name, await artifacts.download(id, name));
        if (action === 'accept' && req.method === 'POST') {
          const value = await bodyJson(req, 8192);
          assertFields(value, ['expectedVersion']);
          if (typeof value.expectedVersion !== 'string' || !value.expectedVersion) throw new HttpError(400, 'A reviewed artifact version is required.');
          if (['running', 'awaiting_approval', 'finishing'].includes(run.status)) throw new HttpError(409, 'Wait for this attempt to settle before accepting its files.');
          const artifact = await artifacts.accept(id, name, value);
          controller.notify();
          return json(res, 200, { artifact });
        }
      }
      if (pathname === '/api/recovery' && req.method === 'GET') return json(res, 200, { recovery: await artifacts.listRecovery() });
      const recoveryRoute = /^\/api\/recovery\/([^/]+)\/restore$/.exec(pathname);
      if (recoveryRoute && req.method === 'POST') {
        assertFields(await bodyJson(req, 8192), []);
        const recovery = await artifacts.restore(recoveryRoute[1]);
        controller.notify();
        return json(res, 200, { recovery });
      }
      if (pathname === '/api/model/test' && req.method === 'POST') {
        const value = await bodyJson(req, 8192);
        if (Object.keys(value).length) throw new HttpError(400, 'Connection test accepts no configuration overrides.');
        if (!model?.metadata().configured) throw new HttpError(503, 'Model credential is not configured.');
        if (modelTesting || startingRun) throw new HttpError(409, 'Another model operation is active.');
        modelTesting = true;
        const started = Date.now(); const abort = new AbortController(); res.on('close', () => abort.abort());
        try {
          const current = await controller.status();
          if (!current.canStart) throw new HttpError(409, 'A task is active.');
          const testSignal = AbortSignal.any([abort.signal, AbortSignal.timeout(110000)]);
          const result = typeof model.test === 'function' ? await model.test({ signal: testSignal }) : await model.respond({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply exactly READY. This is an owner-requested connection test.' }] }], tools: [], signal: testSignal, maxOutputTokens: 1024 });
          return json(res, 200, { ok: true, model: model.metadata().model, reasoningEffort: model.metadata().reasoningEffort, usage: result.usage, elapsedMs: Date.now() - started });
        } catch (error) {
          if (error instanceof HttpError) throw error;
          const known = error instanceof ModelError || error instanceof AgentError;
          return json(res, 502, { error: known ? error.message : '模型连接测试失败；未输出原始响应或凭据。', code: known ? error.code : 'model_test_failed' });
        } finally { modelTesting = false; controller.notify(); }
      }
      if (pathname === '/api/demo' && req.method === 'POST') {
        assertFields(await bodyJson(req, 8192), []);
        return await launch(res, () => controller.startDemo());
      }
      if (req.method === 'POST' && ['/api/control/takeover', '/api/control/pause', '/api/run/cancel'].includes(pathname)) {
        const value = await bodyJson(req, 8192);
        assertFields(value, ['runId']);
        if (value.runId !== undefined && typeof value.runId !== 'string') throw new HttpError(400, 'runId must be a string.');
        if (pathname === '/api/control/pause' && !value.runId) throw new HttpError(400, 'Pause requires the current runId.');
        const action = pathname === '/api/control/takeover' ? controller.takeover : pathname === '/api/control/pause' ? controller.pause : controller.cancel;
        return json(res, 200, await action(value.runId));
      }
      if (pathname === '/api/files' && req.method === 'GET') return json(res, 200, { files: await workspace.list() });
      if (pathname === '/api/files' && req.method === 'POST') {
        const body = await bodyJson(req);
        assertFields(body, ['name', 'contentBase64']);
        await artifacts.ownerWrite(body.name, decodeFile(body.contentBase64));
        controller.notify();
        return json(res, 201, { files: await workspace.list() });
      }
      if (pathname === '/api/files/download' && req.method === 'GET') {
        const name = url.searchParams.get('name');
        return attachment(res, name, await workspace.download(name));
      }
      if (pathname === '/api/desktop/screenshot' && req.method === 'GET') {
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        const content = await runtime.capture({ signal: abort.signal });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': content.length }); return res.end(content);
      }
      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 2000\n\n');
        const client = { res, token: authentication.token, session: authentication.session };
        sseClients.add(client);
        const heartbeat = setInterval(() => { if (client.session.expiresAt <= now() || !res.write(': heartbeat\n\n')) res.end(); }, 15000);
        heartbeat.unref();
        res.on('close', () => { clearInterval(heartbeat); sseClients.delete(client); });
        await broadcast(); return;
      }
      if (pathname.startsWith('/vendor/novnc/') && req.method === 'GET') return await staticFile(novncDir, pathname.slice('/vendor/novnc/'.length), res);
      if (pathname.startsWith('/api/')) throw new HttpError(404, 'Unknown API endpoint.');
      if (pathname === '/desktop') throw new HttpError(426, 'WebSocket upgrade required.');
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      await staticFile(webDir, pathname === '/' ? 'index.html' : pathname.slice(1), res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : error instanceof URIError ? 400 : 500;
      json(res, status, { error: status === 500 ? 'Internal control service error.' : error.message });
    }
  }
  function upgrade(req, socket, head) {
    let upstream;
    let proxy;
    let client;
    let timer;
    let finished = false;
    function close() { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); upstream?.destroy(); proxy?.destroy(); if (client) wsClients.delete(client); }
    function reject(status, message) { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`); upstream?.destroy(); proxy?.destroy(); }
    try {
      const pathname = new URL(req.url, origin).pathname;
      policy.check(req, { websocket: true });
      if (pathname !== '/desktop' || closed) throw new HttpError(404, 'Not found.');
      const authentication = authenticate(req);
      if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key'] ?? '')) throw new HttpError(400, 'Invalid websocket upgrade.');
      if (!controller.desktopConnectable() || wsClients.size) throw new HttpError(409, 'Desktop input is changing or another owner tab is connected.');
      const headers = { Host: `${upstreamHost}:${upstreamPort}`, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': req.headers['sec-websocket-key'], 'Sec-WebSocket-Version': '13' };
      if (req.headers['sec-websocket-protocol']) headers['Sec-WebSocket-Protocol'] = req.headers['sec-websocket-protocol'];
      proxy = http.request({ host: upstreamHost, port: upstreamPort, path: '/', method: 'GET', headers });
      client = { token: authentication.token, close };
      wsClients.add(client);
      timer = setTimeout(close, Math.max(1, authentication.session.expiresAt - now())); timer.unref();
      socket.on('error', close); socket.on('close', close);
      proxy.on('error', () => { if (!upstream) reject(502, 'Desktop unavailable.'); close(); });
      proxy.setTimeout(4000, () => { reject(502, 'Desktop unavailable.'); close(); });
      proxy.on('response', response => { response.resume(); reject(502, 'Desktop unavailable.'); close(); });
      proxy.on('upgrade', (response, upstreamSocket, upstreamHead) => {
        if (finished || !controller.desktopConnectable() || authentication.session.expiresAt <= now() || !sessions.has(authentication.token)) {
          upstreamSocket.destroy();
          close();
          return;
        }
        upstream = upstreamSocket;
        proxy.setTimeout(0);
        const responseHeaders = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade'];
        for (const name of ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) if (response.headers[name]) responseHeaders.push(`${name}: ${response.headers[name]}`);
        socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');
        upstream.on('error', close); upstream.on('close', close);
        if (head.length) upstream.write(head);
        if (upstreamHead.length) socket.write(upstreamHead);
        socket.pipe(upstream).pipe(socket);
      });
      proxy.end();
    } catch (error) { reject(error instanceof HttpError ? error.status : 400, error instanceof HttpError ? error.message : 'Invalid upgrade.'); }
  }
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(expiryTimer);
    for (const client of sseClients) client.res.end();
    closeDesktop();
    controller.events.off('input-revoked', closeDesktop);
    controller.events.off('change', broadcast);
    await controller.close();
    sessions.clear();
  }
  return { handler, upgrade, controller, close };
}
export async function createServer(options = {}) {
  const app = await createApp(options);
  const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 16384 }, app.handler);
  server.on('upgrade', app.upgrade);
  server.app = app;
  server.shutdown = async () => { await app.close(); await new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())); };
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = await createServer();
    const port = Number(process.env.APP_PORT ?? 3180);
    const host = process.env.APP_HOST ?? '0.0.0.0';
    server.listen(port, host, () => console.log(`Private computer P0 control listening on ${host}:${port}`));
    let stopping = false;
    const shutdown = async () => { if (stopping) return; stopping = true; await server.shutdown(); };
    process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
    server.on('error', () => { console.error('Control server failed to listen.'); process.exitCode = 1; });
  } catch { console.error('Control startup failed. Check the required password file, paths, origin, and runtime configuration.'); process.exitCode = 1; }
}
