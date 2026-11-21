// End-to-end UI check inside the Linux container; uses a separate temporary
// browser profile for verification, never the persistent user browser profile.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const profile = await mkdtemp(join(tmpdir(), 'private-computer-ui-'));
const origin = process.env.APP_ORIGIN || 'http://localhost:3180';
const output = process.env.UI_SCREENSHOT || join(process.env.DATA_DIR || '/home/desktop/.private-computer', 'p0-ui.png');
let browser;
let ws;
let password;
let stage = 'launch-headless-browser';
const pending = new Map();
const exceptions = [];
let nextId = 1;
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 6000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const data = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (data.exceptionDetails) throw new Error('Browser evaluation failed.');
  return data.result?.value;
}
async function until(operation, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await operation(); if (result) return result; await delay(100); }
  throw new Error('Browser condition timed out.');
}
try {
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9223',
    `--user-data-dir=${profile}`, 'about:blank'];
  // Match only an explicitly selected test-only runtime mode; never silently opt out.
  if (process.env.ALLOW_UNSANDBOXED_BROWSER === '1') args.unshift('--no-sandbox');
  browser = spawn('chromium', args, { shell: false, stdio: 'ignore' });
  browser.on('error', () => {});
  const targets = await until(async () => {
    try {
      const r = await fetch('http://127.0.0.1:9223/json/list', { signal: AbortSignal.timeout(800) });
      return r.ok && await r.json();
    } catch { return null; }
  });
  const target = targets.find(item => item.type === 'page');
  assert.ok(target);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('UI CDP connection failed.')), { once: true }); });
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.method === 'Runtime.exceptionThrown') exceptions.push('Browser JavaScript exception');
    const item = pending.get(data.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(data.id);
    if (data.error) item.reject(new Error('UI CDP command failed.')); else item.resolve(data.result || {});
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: origin });
  stage = 'login-page-ready';
  await until(() => evaluate("document.readyState === 'complete' && document.querySelector('#initial-status')?.hidden && document.querySelector('#login-view') && !document.querySelector('#login-view').hidden && !document.querySelector('#login-button').disabled"));
  password = (await readFile(process.env.OWNER_PASSWORD_FILE, 'utf8')).trimEnd();
  await evaluate(`document.querySelector('#password').value=${JSON.stringify(password)};document.querySelector('#login-form').requestSubmit();true`);
  password = undefined;
  stage = 'workspace-visible';
  await until(() => evaluate("document.querySelector('#workspace-view') && !document.querySelector('#workspace-view').hidden"));
  stage = 'novnc-connected';
  await until(() => evaluate("document.querySelector('#desktop-status')?.textContent === '桌面已连接'"), 20000);
  stage = 'first-real-frame';
  const frame = await until(() => evaluate(`(() => { const c=document.querySelector('#vnc-screen canvas'); if(!c?.width || !c?.height) return null; const x=c.getContext('2d'); if(!x) return null; const colors=new Set(); let lit=0; for(let y=0;y<c.height;y+=Math.max(1,Math.floor(c.height/16))) for(let i=0;i<c.width;i+=Math.max(1,Math.floor(c.width/20))){const p=x.getImageData(i,y,1,1).data; colors.add(p[0]+','+p[1]+','+p[2]); if(p[0]+p[1]+p[2]>90)lit++;} return colors.size>=8 && lit>=8 ? {sampledColors:colors.size,litPixels:lit} : null; })()`), 20000);
  stage = 'run-demo-from-web-interface';
  await evaluate("document.querySelector('#demo-button').click();true");
  await until(() => evaluate("document.querySelector('#run-status')?.textContent === '已完成' && document.querySelector('#run-error')?.hidden && document.querySelector('#control-owner')?.textContent.includes('人工')"), 20000);
  const layout = await evaluate(`(() => { const canvas=document.querySelector('#vnc-screen canvas'); const r=canvas?.getBoundingClientRect(); return { connected:document.querySelector('#desktop-status').textContent, canvasWidth:canvas?.width, canvasHeight:canvas?.height, renderedWidth:r?.width, renderedHeight:r?.height, renderedTop:r?.top, renderedBottom:r?.bottom, viewportHeight:innerHeight, pageWidth:document.documentElement.scrollWidth, viewport:innerWidth, passwordCleared:document.querySelector('#password').value==='' }; })()`);
  assert.ok(layout.canvasWidth > 0 && layout.canvasHeight > 0 && layout.renderedWidth > 300);
  assert.ok(layout.renderedBottom <= layout.viewportHeight + 2, 'Desktop canvas should remain inside the desktop viewport.');
  assert.equal(layout.passwordCleared, true);
  assert.equal(exceptions.length, 0);
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(output, Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
  // Verify the narrow layout can still reach the main controls without overflow.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  const narrow = await evaluate('({width:innerWidth,pageWidth:document.documentElement.scrollWidth})');
  assert.ok(narrow.pageWidth <= narrow.width + 2, 'Narrow viewport should not overflow horizontally.');
  await evaluate("document.querySelector('#logout-button').click();true");
  await until(() => evaluate("!document.querySelector('#login-view').hidden"));
  console.log(JSON.stringify({ ok: true, phase: 'p0', check: 'real-browser-login-novnc-layout-logout', frame, layout, narrow, screenshot: output }));
} catch (error) {
  let diagnostics;
  if (ws?.readyState === 1) {
    try {
      diagnostics = await evaluate("({location:location.pathname,ready:document.readyState,loginError:document.querySelector('#login-error')?.textContent,desktopStatus:document.querySelector('#desktop-status')?.textContent,desktopError:document.querySelector('#desktop-message')?.textContent})");
      const failureImage = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(output.replace(/\.png$/, '-failure.png'), Buffer.from(failureImage.data, 'base64'), { mode: 0o600 });
    } catch { /* Keep the original check failure. */ }
  }
  console.error(JSON.stringify({ ok: false, check: 'real-browser-ui', stage, diagnostics, exceptions, error: String(error.message).replaceAll(password || '\u0000', '[redacted]') }));
  process.exitCode = 1;
} finally {
  password = undefined;
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('UI check closed.')); }
  pending.clear();
  ws?.close();
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(1500)]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
  }
  // Only our mkdtemp-created directory is removed, after its browser has stopped.
  if (profile.startsWith(join(tmpdir(), 'private-computer-ui-'))) await rm(profile, { recursive: true, force: true });
}
