#!/usr/bin/env node
// Run inside the desktop container with Node 22; never invokes the host desktop.
// Full check: node scripts/verify-runtime.mjs
// After recreating the container with the same workspace volume:
// node scripts/verify-runtime.mjs --check-persistence
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const MARKER_NAME = 'p0-persistence-marker.txt';
const MARKER = Buffer.from('private-computer-p0-persistent-workspace-v1\n');
const argv = process.argv.slice(2);
const persistenceOnly = argv.includes('--check-persistence');
const checks = [];
const ownRuns = new Set();
let stage = 'configuration';
let cookie;
let rfb;
let originalPointer;
let controlUrl;
let appOrigin;
let password;
let failure;
const evidence = {};
const display = process.env.DISPLAY ?? ':99';

function requireThat(condition, message) { assert.ok(condition, message); }
async function check(name, operation) {
  stage = name;
  const started = Date.now();
  const detail = await operation();
  checks.push({ name, ok: true, elapsedMs: Date.now() - started, ...(detail === undefined ? {} : { detail }) });
  return detail;
}
function request(route, { method = 'GET', body, auth = true, origin = appOrigin.origin, host = appOrigin.host, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const content = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: controlUrl.hostname, port: controlUrl.port, path: route, method,
      headers: { Host: host, ...(origin === null ? {} : { Origin: origin }), ...(auth && cookie ? { Cookie: cookie } : {}), ...(content ? { 'Content-Type': 'application/json', 'Content-Length': content.length } : {}), ...headers },
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 16 * 1024 * 1024) { res.destroy(); reject(new Error('HTTP response exceeded the verification limit.')); } else chunks.push(chunk); });
      res.on('error', () => reject(new Error('HTTP response failed.')));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json; try { json = JSON.parse(buffer.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, buffer, json });
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error('HTTP request timed out.')));
    req.on('error', () => reject(new Error('HTTP request failed or timed out.')));
    req.end(content);
  });
}
async function status() {
  const result = await request('/api/status');
  assert.equal(result.status, 200, 'Authenticated status must return 200.');
  return result.json;
}
async function poll(operation, timeoutMs = 30000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const result = await operation(); if (result) return result; await delay(intervalMs); }
  throw new Error('Verification condition did not become true before its deadline.');
}
function xdotool(args) {
  requireThat(display === ':99', 'Verification is restricted to the configured Xvfb display :99.');
  return new Promise((resolve, reject) => {
    const child = spawn('xdotool', args, { shell: false, env: { ...process.env, DISPLAY: ':99' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 2500);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 8192) child.kill('SIGKILL'); else chunks.push(chunk); });
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timeout); reject(new Error('Could not run xdotool against Xvfb.')); });
    child.on('close', code => { clearTimeout(timeout); if (code !== 0) reject(new Error('Xvfb pointer probe failed or timed out.')); else resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}
async function getPointer() {
  const output = await xdotool(['getmouselocation', '--shell']);
  const x = /^X=(\d+)$/m.exec(output); const y = /^Y=(\d+)$/m.exec(output);
  requireThat(x && y, 'xdotool did not return Xvfb pointer coordinates.');
  return { x: Number(x[1]), y: Number(y[1]) };
}
async function setPointer(point) { await xdotool(['mousemove', '--sync', String(point.x), String(point.y)]); }
const samePoint = (a, b) => a.x === b.x && a.y === b.y;
async function expectPointer(point, label) {
  stage = `existing-rfb-client-viewonly-and-human-takeover.${label}`;
  let observed;
  try { return await poll(async () => { observed = await getPointer(); return samePoint(observed, point); }, 2400, 60); }
  catch { throw new Error(`RFB ${label}: expected Xvfb pointer (${point.x},${point.y}), observed (${observed?.x ?? 'unknown'},${observed?.y ?? 'unknown'}).`); }
}

async function connectNoVnc() {
  // An actual apt noVNC viewer removes protocol-implementation ambiguity from the input proof.
  // Its viewOnly remains false even while automation owns the desktop.
  const profile = await mkdtemp(path.join(tmpdir(), 'private-computer-rfb-'));
  let browser; let ws; let nextId = 1; let lastStats = { transport: 'apt-noVNC', connected: false };
  const pending = new Map();
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('noVNC probe CDP command timed out.')); }, 5000);
      pending.set(id, { resolve, reject, timeout }); ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error('noVNC probe browser evaluation failed.');
    return result.result?.value;
  }
  async function close() {
    try { if (ws?.readyState === 1) await evaluate('window.__probeRfb?.disconnect();true'); } catch {}
    ws?.close();
    for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(new Error('noVNC probe closed.')); } pending.clear();
    if (browser && browser.exitCode === null) {
      browser.kill('SIGTERM');
      await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(1500)]);
      if (browser.exitCode === null) { browser.kill('SIGKILL'); await delay(200); }
    }
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  try {
    const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9224', `--user-data-dir=${profile}`, 'about:blank'];
    if (process.env.ALLOW_UNSANDBOXED_BROWSER === '1') args.unshift('--no-sandbox');
    browser = spawn('chromium', args, { shell: false, stdio: 'ignore' }); browser.on('error', () => {});
    const targets = await poll(async () => { try { const response = await fetch('http://127.0.0.1:9224/json/list', { signal: AbortSignal.timeout(800) }); return response.ok && await response.json(); } catch { return false; } }, 12000);
    const target = targets.find(value => value.type === 'page'); requireThat(target, 'The independent noVNC probe browser did not create a page.');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    ws.addEventListener('message', event => {
      let value; try { value = JSON.parse(event.data); } catch { return; }
      const item = pending.get(value.id); if (!item) return; pending.delete(value.id); clearTimeout(item.timeout);
      if (value.error) item.reject(new Error('noVNC probe CDP command failed.')); else item.resolve(value.result ?? {});
    });
    await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('noVNC probe CDP connection timed out.')), 4000); ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true }); ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('noVNC probe CDP connection failed.')); }, { once: true }); });
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const split = cookie.indexOf('=');
    await send('Network.setCookie', { name: cookie.slice(0, split), value: cookie.slice(split + 1), url: appOrigin.origin, path: '/', httpOnly: true, sameSite: 'Strict' });
    await send('Page.navigate', { url: new URL('/fixture', appOrigin).href });
    await poll(() => evaluate("document.readyState === 'complete' && location.pathname === '/fixture'"), 10000);
    await evaluate(`(async()=>{const {default:RFB}=await import('/vendor/novnc/core/rfb.js');document.body.textContent='';const screen=document.createElement('div');screen.style.cssText='position:fixed;inset:0;background:#000';document.body.append(screen);window.__probeConnected=0;window.__probeDisconnected=0;window.__probeRfb=new RFB(screen,(location.protocol==='https:'?'wss://':'ws://')+location.host+'/desktop');window.__probeRfb.viewOnly=false;window.__probeRfb.scaleViewport=false;window.__probeRfb.resizeSession=false;window.__probeRfb.addEventListener('connect',()=>window.__probeConnected++);window.__probeRfb.addEventListener('disconnect',()=>window.__probeDisconnected++);return true;})()`);
    const dimensions = await poll(() => evaluate(`(()=>{const canvas=document.querySelector('canvas');if(window.__probeConnected!==1||window.__probeDisconnected||!canvas?.width||!canvas?.height)return null;const context=canvas.getContext('2d');const colors=new Set();for(let y=0;y<canvas.height;y+=Math.max(1,Math.floor(canvas.height/8)))for(let x=0;x<canvas.width;x+=Math.max(1,Math.floor(canvas.width/8))){const p=context.getImageData(x,y,1,1).data;colors.add(p[0]+','+p[1]+','+p[2]);}return colors.size>=4?{width:canvas.width,height:canvas.height,sampledColors:colors.size}:null;})()`), 15000);
    lastStats = { ...lastStats, ...dimensions, connected: true, connectionEvents: 1, viewOnly: false };
    return {
      width: dimensions.width, height: dimensions.height,
      stats() { return lastStats; },
      async isConnected() { const result = await evaluate('({connections:window.__probeConnected,disconnections:window.__probeDisconnected,viewOnly:window.__probeRfb.viewOnly})'); lastStats = { ...lastStats, connectionEvents: result.connections, disconnectEvents: result.disconnections, viewOnly: result.viewOnly, connected: result.connections === 1 && result.disconnections === 0 }; return lastStats.connected; },
      async pointer(point) {
        // Explicitly defeat the frontend view-only convenience setting. Only the backend may block this input.
        const bounds = await evaluate(`(()=>{window.__probeRfb.viewOnly=false;const c=document.querySelector('canvas'),r=c.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,nativeWidth:c.width,nativeHeight:c.height,connections:window.__probeConnected,disconnections:window.__probeDisconnected};})()`);
        requireThat(bounds.connections === 1 && bounds.disconnections === 0, 'The original noVNC connection must remain established.');
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bounds.left + point.x * bounds.width / bounds.nativeWidth, y: bounds.top + point.y * bounds.height / bounds.nativeHeight, button: 'none', buttons: 0 });
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}
async function websocketProbe({ auth = true, origin = appOrigin.origin } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: controlUrl.hostname, port: controlUrl.port, path: '/desktop', headers: {
      Host: appOrigin.host, Origin: origin, Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Protocol': 'binary', ...(auth && cookie ? { Cookie: cookie } : {}),
    } });
    const timer = setTimeout(() => { req.destroy(); reject(new Error('Desktop WebSocket handshake timed out.')); }, 4000);
    req.on('upgrade', (res, socket) => { clearTimeout(timer); socket.on('error', () => {}); socket.destroy(); resolve(res.statusCode); });
    req.on('response', res => { res.resume(); res.on('end', () => { clearTimeout(timer); resolve(res.statusCode); }); });
    req.on('error', () => { clearTimeout(timer); reject(new Error('Desktop WebSocket handshake failed.')); }); req.end();
  });
}
async function checkNoVncModules() {
  const queue = ['/vendor/novnc/core/rfb.js']; const seen = new Set();
  while (queue.length) {
    const route = queue.shift(); if (seen.has(route)) continue; seen.add(route);
    requireThat(seen.size <= 100, 'noVNC dependency graph exceeded its verification bound.');
    const result = await request(route);
    assert.equal(result.status, 200, `noVNC module must be served: ${route}`);
    requireThat(/javascript/.test(result.headers['content-type'] ?? ''), 'noVNC modules must use a JavaScript content type.');
    const source = result.buffer.toString('utf8');
    const imports = source.matchAll(/\b(?:import|export)\s+(?:[^;'\"]*?\s+from\s*)?['\"]([^'\"]+)['\"]/g);
    for (const match of imports) {
      if (!match[1].startsWith('.')) continue;
      const target = new URL(match[1], `http://internal.invalid${route}`);
      requireThat(target.pathname.startsWith('/vendor/novnc/'), 'noVNC import escaped its resource prefix.');
      if (target.pathname.endsWith('.js')) queue.push(target.pathname);
    }
  }
  return { modules: seen.size, includesVendor: [...seen].some(route => route.includes('/vendor/novnc/vendor/')) };
}
async function readVisibleFixture() {
  const base = new URL(process.env.BROWSER_CDP_URL ?? 'http://127.0.0.1:9222');
  requireThat(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname), 'CDP verification must stay on loopback.');
  const response = await fetch(new URL('/json/list', base), { signal: AbortSignal.timeout(4000) });
  requireThat(response.ok, 'Could not list real Chromium targets.');
  const targets = await response.json();
  const target = targets.find(item => { try { const url = new URL(item.url); return item.type === 'page' && url.pathname === '/fixture' && ['127.0.0.1', 'localhost'].includes(url.hostname); } catch { return false; } });
  requireThat(target, 'The fixed demo must leave its visible Chromium fixture tab open.');
  const wsUrl = new URL(target.webSocketDebuggerUrl);
  requireThat(wsUrl.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(wsUrl.hostname) && wsUrl.port === base.port, 'CDP target must use the configured loopback endpoint.');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('Visible Chromium fixture inspection timed out.')); }, 5000);
    function finish(error, value) { clearTimeout(timer); ws.close(); if (error) reject(error); else resolve(value); }
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `JSON.stringify({ title: document.title, result: document.querySelector('#result')?.textContent, project: document.querySelector('#project')?.value })`, returnByValue: true } })));
    ws.addEventListener('message', event => {
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.id !== 1) return;
      if (message.error || message.result?.exceptionDetails) return finish(new Error('Visible Chromium fixture inspection failed.'));
      try { finish(null, JSON.parse(message.result.result.value)); } catch { finish(new Error('Visible Chromium fixture returned an unexpected result.')); }
    });
    ws.addEventListener('error', () => finish(new Error('CDP inspection connection failed.')));
  });
}

try {
  requireThat(argv.every(arg => arg === '--check-persistence'), 'Only --check-persistence is supported.');
  requireThat(process.versions.node.split('.')[0] >= 22, 'Node 22 or later is required.');
  requireThat(display === ':99', 'This script operates only on Xvfb DISPLAY=:99.');
  controlUrl = new URL(process.env.VERIFY_CONTROL_URL ?? `http://127.0.0.1:${process.env.APP_PORT ?? 3180}`);
  requireThat(controlUrl.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(controlUrl.hostname) && !controlUrl.username && !controlUrl.password, 'Control verification must use a loopback HTTP URL.');
  appOrigin = new URL(process.env.APP_ORIGIN ?? `http://localhost:${process.env.APP_PORT ?? 3180}`);
  requireThat(process.env.OWNER_PASSWORD_FILE, 'OWNER_PASSWORD_FILE is required.');
  password = (await readFile(process.env.OWNER_PASSWORD_FILE, 'utf8')).replace(/\r?\n$/, '');
  requireThat(password.length > 0, 'Owner password file is empty.');

  await check('login-with-secret-file', async () => {
    const response = await request('/api/login', { method: 'POST', auth: false, body: { password } });
    assert.equal(response.status, 200, 'Owner login must succeed.');
    const setCookie = response.headers['set-cookie']?.[0];
    requireThat(setCookie && /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), 'Owner cookie must be HttpOnly and SameSite=Strict.');
    cookie = setCookie.split(';')[0]; password = undefined;
  });

  if (persistenceOnly) {
    await check('workspace-marker-survives-container-recreation', async () => {
      const result = await request(`/api/files/download?name=${MARKER_NAME}`);
      assert.equal(result.status, 200, 'The pre-existing persistent marker must still be downloadable.');
      assert.deepEqual(result.buffer, MARKER, 'The persistent marker contents must be unchanged.');
      const listed = await request('/api/files');
      requireThat(listed.json?.files?.some(file => file.name === MARKER_NAME && file.size === MARKER.length), 'The persistent marker must remain in the file listing.');
      return { name: MARKER_NAME, bytes: MARKER.length, rewritten: false };
    });
  } else {
    await check('http-authentication-and-origin', async () => {
      assert.equal((await request('/healthz', { auth: false, origin: null })).status, 200);
      for (const route of ['/api/status', '/api/files', '/api/desktop/screenshot', '/api/events', '/vendor/novnc/core/rfb.js']) assert.equal((await request(route, { auth: false })).status, 401, 'Private endpoints must reject unauthenticated access.');
      assert.equal((await request('/api/login', { auth: false, method: 'POST', origin: 'https://invalid.example', body: { password: 'not-the-owner-password' } })).status, 403, 'Login must reject hostile Origin.');
      assert.equal((await request('/api/demo', { method: 'POST', origin: null, body: {} })).status, 403, 'Mutations must require Origin.');
      assert.equal((await request('/api/status', { origin: 'https://invalid.example' })).status, 403, 'Authenticated requests must reject hostile Origin.');
      assert.equal((await request('/healthz', { host: 'invalid.example' })).status, 403, 'Host validation must reject unknown hosts.');
    });
    await check('desktop-websocket-authentication', async () => {
      assert.equal(await websocketProbe({ auth: false }), 401);
      assert.equal(await websocketProbe({ origin: 'https://invalid.example' }), 403);
      assert.equal(await websocketProbe(), 101);
    });
    await check('authenticated-novnc-module-graph', checkNoVncModules);
    await check('persistent-workspace-file-round-trip', async () => {
      const upload = await request('/api/files', { method: 'POST', body: { name: MARKER_NAME, contentBase64: MARKER.toString('base64') } });
      assert.equal(upload.status, 201, 'Persistent marker upload must succeed.');
      const download = await request(`/api/files/download?name=${MARKER_NAME}`);
      assert.equal(download.status, 200); assert.deepEqual(download.buffer, MARKER);
      const disk = await readFile(path.join(process.env.WORKSPACE_DIR ?? '/home/desktop/Workspace', MARKER_NAME));
      assert.deepEqual(disk, MARKER, 'The downloaded marker must be a real file in the mounted workspace.');
      assert.equal((await request('/api/files/download?name=..%2Fowner-password')).status, 400);
      return { name: MARKER_NAME, bytes: MARKER.length };
    });
    await check('desktop-browser-and-screenshot-ready', async () => {
      const current = await poll(async () => { const value = await status(); return value.desktop?.ready && value.desktop?.browserReady && value; });
      requireThat(current.phase === 'p0' && current.workspacePersistent === true, 'Status must disclose the P0 and persistent-workspace contract.');
      requireThat(current.sandbox?.enabled === true, 'The real Chromium renderer sandbox must be enabled and positively verified.');
      requireThat(current.run?.status !== 'running', 'A different run is already active; use an idle test container.');
      const screenshot = await request('/api/desktop/screenshot');
      assert.equal(screenshot.status, 200); assert.equal(screenshot.headers['content-type'], 'image/png');
      requireThat(screenshot.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Screenshot must contain an actual PNG.');
      return { sandboxEnabled: current.sandbox?.enabled === true, screenshotBytes: screenshot.buffer.length };
    });
    await check('real-fixed-demo-and-markdown-report', async () => {
      const started = await request('/api/demo', { method: 'POST', body: {} });
      assert.equal(started.status, 202, 'Ready desktop demo must be accepted.');
      requireThat(typeof started.json?.id === 'string', 'Demo must return a run id.'); ownRuns.add(started.json.id);
      const completed = await poll(async () => {
        const current = await status();
        requireThat(current.run?.id === started.json.id, 'The active run unexpectedly changed.');
        if (['failed', 'cancelled', 'interrupted'].includes(current.run.status)) throw new Error('The real fixed demo did not succeed.');
        return current.run.status === 'succeeded' && current.control.owner === 'human' && current;
      });
      requireThat(completed.run.steps.length === 3 && completed.run.steps.every(step => step.status === 'succeeded'), 'All three real demo steps must succeed.');
      requireThat(!completed.run.error, 'A succeeded run must not retain a desktop-input restoration error.');
      const reportName = `demo-${started.json.id}.md`;
      requireThat(completed.files.some(file => file.name === reportName), 'Demo report must appear in the workspace listing.');
      const report = await request('/api/files/download?name=' + encodeURIComponent(reportName));
      assert.equal(report.status, 200); requireThat(report.buffer.toString('utf8').includes(started.json.id), 'The generated report must identify this run.');
      const visible = await readVisibleFixture();
      assert.equal(visible.project, '私人云电脑 P0'); requireThat(visible.result?.includes('已提交') && visible.result.includes('人工接管'), 'The real headed Chromium must display the submitted fixture form.');
      evidence.demoRunId = started.json.id; evidence.report = reportName;
      return { id: started.json.id, steps: completed.run.steps.length, report: reportName, visibleFormSubmitted: true };
    });
    await check('existing-rfb-client-viewonly-and-human-takeover', async () => {
      originalPointer = await getPointer();
      rfb = await connectNoVnc();
      const point = (x, y) => ({ x: Math.round((rfb.width - 1) * x), y: Math.round((rfb.height - 1) * y) });
      const anchor = point(0.1, 0.1); const humanBefore = point(0.25, 0.3); const blocked = point(0.7, 0.7); const humanAfter = point(0.6, 0.2);
      stage = 'existing-rfb-client-viewonly-and-human-takeover.human-before';
      await setPointer(anchor); await rfb.pointer(humanBefore); await expectPointer(humanBefore, 'human-before');
      const started = await request('/api/demo', { method: 'POST', body: {} }); assert.equal(started.status, 202); ownRuns.add(started.json.id);
      const locked = await status(); assert.equal(locked.control.owner, 'automation', 'The VNC input test must run during automation ownership.');
      const oldGeneration = locked.control.generation;
      stage = 'existing-rfb-client-viewonly-and-human-takeover.automation-blocked';
      await setPointer(anchor); await rfb.pointer(blocked); await delay(250);
      const during = await getPointer();
      assert.deepEqual(during, anchor, 'Existing RFB PointerEvent must be blocked by server-side viewonly.');
      const stillLocked = await status(); assert.equal(stillLocked.control.owner, 'automation', 'Automation must still hold control during the blocked-input observation.');
      const taken = await request('/api/control/takeover', { method: 'POST', body: {} }); assert.equal(taken.status, 200);
      assert.equal(taken.json.control.owner, 'human'); requireThat(taken.json.control.generation > oldGeneration, 'Takeover must revoke the old control generation.');
      assert.equal(taken.json.run.id, started.json.id); assert.equal(taken.json.run.status, 'cancelled');
      stage = 'existing-rfb-client-viewonly-and-human-takeover.human-after';
      await rfb.pointer(humanAfter); await expectPointer(humanAfter, 'human-after');
      const succeededBefore = taken.json.run.steps.filter(step => step.status === 'succeeded').length;
      await delay(2200);
      const settled = await status(); assert.equal(settled.run.id, started.json.id); assert.equal(settled.run.status, 'cancelled');
      assert.equal(settled.run.steps.filter(step => step.status === 'succeeded').length, succeededBefore, 'Revoked automation must not complete later steps.');
      requireThat(await rfb.isConnected(), 'The identical noVNC RFB connection must survive before, during, and after takeover.');
      return { protocol: 'apt noVNC / RFB 3.8 / SecurityType None', sameTcpConnection: true, frontendViewOnlyForcedFalse: true, inputWorkedBefore: true, inputBlockedDuring: true, inputWorkedAfter: true, generationBefore: oldGeneration, generationAfter: taken.json.control.generation, cancelledRun: started.json.id, client: rfb.stats() };
    });
  }
} catch (error) {
  // Only fixed assertion messages reach stdout: never dump HTTP bodies, cookie headers, environment or errors containing credentials.
  const message = error instanceof assert.AssertionError ? error.message.split('\n')[0] : error.message;
  failure = { stage, message: String(message ?? 'Runtime verification failed.').replaceAll(cookie ?? '\u0000', '[redacted]').replaceAll(password || '\u0000', '[redacted]') };
  process.exitCode = 1;
} finally {
  if (rfb) { evidence.rfbClient = rfb.stats(); await rfb.close(); }
  if (originalPointer && display === ':99') { try { await setPointer(originalPointer); } catch { /* The test already records the primary failure. */ } }
  if (cookie && controlUrl && appOrigin) {
    try { const current = await status(); if (current.run?.status === 'running' && ownRuns.has(current.run.id)) await request('/api/run/cancel', { method: 'POST', body: {} }); } catch {}
    try { await request('/api/logout', { method: 'POST', body: {} }); } catch {}
  }
  password = undefined; cookie = undefined;
  process.stdout.write(JSON.stringify({ ok: !failure, phase: 'p0', mode: persistenceOnly ? 'check-persistence' : 'full', checks, ...evidence, ...(failure ? { error: failure } : {}) }, null, 2) + '\n');
}
