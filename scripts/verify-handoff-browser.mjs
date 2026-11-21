// Local contract fixture: no model calls, external sites, real desktop input, or owner credentials.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const p2b = process.argv.includes('--p2b');
const p2bTests = [];
let narrowP2B;
let blockEvents = false;
let savedTemplates = [];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(tmpdir(), 'bot-handoff-ui-'));
const streams = new Set();
const sockets = new Set();
const commands = new Map();
const exceptions = [];
const calls = [];
const clone = value => structuredClone(value);
let nextId = 1;
let browser;
let ws;
let stage = 'launch';
let holdStatus = false;
let heldStatus = null;
let holdDiff = false;
let heldDiff = null;
let holdCreate = false;
let heldCreate = null;
let acceptConflict = true;
let fixture = {
  phase: 'mvp', canStart: true,
  model: { configured: true, verified: true, model: 'fixture-only', executionProtocol: 'acp', reasoningEffort: 'high' },
  desktop: { ready: true, browserReady: true }, control: { owner: 'human', private: true, generation: 1 },
  run: { id: 'run-2', kind: 'agent', status: 'paused', goal: '核对交接', steps: [], budget: { maxTokens: 1000, stepsUsed: 2, maxSteps: 10, elapsedMs: 1000 }, usage: { totalTokens: 20, unknown: true } },
  work: { id: 'work-1', goal: '核对交接', status: 'paused', revision: 1, latestRunId: 'run-2', runIds: ['run-1', 'run-2'], attempts: [{ id: 'run-1', totalTokens: 0, usageUnknown: false, finishedAt: '2026-01-01T00:00:00Z' }, { id: 'run-2', totalTokens: 20, usageUnknown: true, finishedAt: '2026-01-01T00:00:01Z' }], budget: { maxTokens: 1000, tokensUsed: 20, remainingTokens: 980, maxSteps: 10, stepsUsed: 2, remainingSteps: 8, maxDurationMs: 60000, elapsedMs: 1000, remainingDurationMs: 59000, usageUnknown: true }, handoff: { reason: 'paused', goal: '核对交接', completed: [{ kind: 'file', title: '生成报告', status: 'staged' }], artifacts: [{ name: 'report.md', status: 'staged' }], notExecuted: [{ kind: 'desktop', title: '尚未提交表单' }], unconfirmed: [{ kind: 'external', title: '外部效果待核对', effect: 'unknown' }] } },
  files: [], workspacePersistent: true, sandbox: { enabled: true },
};
let artifact = { name: 'report.md', operation: 'modified', status: 'staged', sha256: 'fixture-hash', bytes: 20, baseVersion: 'workspace-1', version: 'staged-1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
let recovery = [];
if (p2b) fixture.ownerOnline = true;
function grantView(value) { return value ? { ...value, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + value.ttlMs).toISOString(), usedWrites: 0, usedBytes: 0, remainingWrites: value.maxWrites, remainingBytes: value.maxBytes, revoked: false, expired: false, status: 'active' } : undefined; }
const rfbSource = `export default class RFB extends EventTarget {
  constructor(target) { super(); this.viewOnly = true; this.disconnected = false; (window.__vncClients ||= []).push(this); target.append(document.createElement('canvas')); setTimeout(() => { if (!this.disconnected) this.dispatchEvent(new Event('connect')); }, 10); }
  disconnect() { if (this.disconnected) return; this.disconnected = true; this.dispatchEvent(new Event('disconnect')); }
}`;
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
function push(value = fixture) { for (const res of streams) res.write(`event: state\ndata: ${JSON.stringify(value)}\n\n`); }
async function body(req) { const data = []; for await (const chunk of req) data.push(chunk); return data.length ? JSON.parse(Buffer.concat(data)) : {}; }
function paused(owner = 'human') {
  fixture.canStart = owner === 'human'; fixture.control = { owner, private: owner === 'human', generation: fixture.control.generation + 1, ...(owner === 'unconfirmed' ? { stop: { confirmed: false, input: true, observation: false, elapsedMs: 30 } } : {}) };
  fixture.run.status = 'paused'; fixture.work.status = 'paused'; fixture.work.revision++; push();
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1'); const route = url.pathname;
    if (route === '/api/events' && blockEvents) return json(res, 503, { error: 'Fixture event stream offline.' });
    if (route === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); streams.add(res); req.on('close', () => streams.delete(res)); res.write(`event: state\ndata: ${JSON.stringify(fixture)}\n\n`); return; }
    if (route === '/api/status') { const snapshot = clone(fixture); if (holdStatus) { holdStatus = false; heldStatus = () => json(res, 200, snapshot); return; } return json(res, 200, snapshot); }
    if (route === '/vendor/novnc/core/rfb.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(rfbSource); }
    if (p2b && route === '/api/inbox') return json(res, 200, { items: [
      { id: 'approval', kind: 'approval', title: '需要人工决定', runId: fixture.run.id, workId: fixture.work.id },
      { id: 'handoff', kind: 'handoff', title: '工作已交接', workId: fixture.work.id },
      { id: 'usage', kind: 'usage', title: '服务商用量待核对', workId: fixture.work.id },
      { id: 'artifacts', kind: 'artifacts', title: '文件待接受', runId: fixture.run.id, workId: fixture.work.id, count: 2 },
      { id: 'failure', kind: 'failure', title: '上次执行失败', detail: '<img src=x onerror=alert(1)> 安全纯文本' },
      { id: 'backup', kind: 'backup', title: '备份检查', detail: '机器级备份检查不可用；尚未验证主机快照。' }
    ] });
    if (p2b && route === '/api/templates' && req.method === 'GET') return json(res, 200, { templates: savedTemplates });
    if (p2b && route.startsWith('/api/templates/') && req.method === 'DELETE') { const id = route.split('/').at(-1); calls.push({ route, body: null, method: 'DELETE' }); savedTemplates = savedTemplates.filter(item => item.id !== id); return json(res, 200, { ok: true }); }
    if (route === '/api/works') return json(res, 200, { works: [fixture.work] });
    if (route === '/api/works/work-1') return json(res, 200, { work: fixture.work });
    if (route === '/api/tasks' && req.method === 'GET') return json(res, 200, { runs: [fixture.run] });
    if (/^\/api\/tasks\/[^/]+$/.test(route) && req.method === 'GET') return json(res, 200, { run: fixture.run });
    if (route === '/api/recovery') return json(res, 200, { recovery });
    if (/^\/api\/tasks\/[^/]+\/artifacts$/.test(route)) return json(res, 200, { artifacts: route.includes('run-2') ? [artifact] : [] });
    if (route.endsWith('/artifacts/report.md/diff')) {
      const diff = { name: artifact.name, operation: artifact.operation, binary: false, truncated: false, text: `--- report.md\n+++ report.md\n-old\n+new <script>fixture</script> ${artifact.version}`, beforeSha256: 'before', afterSha256: artifact.sha256 };
      if (holdDiff) { holdDiff = false; heldDiff = () => json(res, 200, { diff }); return; }
      return json(res, 200, { diff });
    }
    if (route.endsWith('/artifacts/report.md/download')) { calls.push({ route, body: null }); res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end('fixture artifact'); }
    if (req.method === 'POST') {
      const value = await body(req); calls.push({ route, body: value });
      if (p2b && route === '/api/templates') {
        assert.deepEqual(Object.keys(value).sort(), ['name', 'workId']); assert.equal(value.workId, fixture.work.id);
        if (savedTemplates.some(item => item.name.toLowerCase() === value.name.trim().toLowerCase())) return json(res, 409, { error: 'Template name already exists.' });
        const template = { id: 'template-1', name: value.name.trim(), goal: fixture.work.goal, createdAt: new Date().toISOString(), observe: { workspace: true, desktop: true }, allowDesktop: true, offlinePolicy: 'stop', draftGrant: { names: ['do-not-copy.txt'] } }; savedTemplates.push(template); return json(res, 201, { template });
      }
      if (p2b && route.endsWith('/grant/revoke')) { assert.deepEqual(value, {}); const grant = fixture.run.draftGrant ?? fixture.run.grant; grant.revoked = true; grant.status = 'revoked'; push(); return json(res, 200, { run: fixture.run }); }
      if (route === '/api/works/work-1/usage') {
        assert.equal(value.revision, fixture.work.revision); assert.equal(value.runId, 'run-2');
        fixture.work.revision++; fixture.work.budget.tokensUsed = value.totalTokens; fixture.work.budget.remainingTokens = 1000 - value.totalTokens; fixture.work.budget.usageUnknown = false; fixture.work.attempts[1].reconciliation = { totalTokens: value.totalTokens }; fixture.run.usage = { totalTokens: value.totalTokens, unknown: false }; push(); return json(res, 200, { work: fixture.work });
      }
      if (route.endsWith('/redelegate')) {
        assert.equal(value.revision, fixture.work.revision); if (p2b) { fixture.run.offlinePolicy = value.offlinePolicy || 'continue'; fixture.run.draftGrant = grantView(value.draftGrant); } fixture.work.revision++; fixture.work.status = 'running'; fixture.work.handoff.unconfirmed = []; fixture.run.status = 'running'; fixture.canStart = false; fixture.control = { owner: 'automation', private: false, generation: fixture.control.generation + 1 }; push(); return json(res, 202, { run: fixture.run, work: fixture.work });
      }
      if (route === '/api/control/pause') { assert.equal(value.runId, fixture.run.id); paused('stopping'); await delay(30); paused('unconfirmed'); return json(res, 200, fixture); }
      if (route === '/api/control/takeover') { assert.equal(value.runId, fixture.run.id); paused(); return json(res, 200, fixture); }
      if (route === '/api/tasks') {
        const finish = () => { if (p2b) { fixture.run.offlinePolicy = value.offlinePolicy || 'continue'; fixture.run.draftGrant = grantView(value.draftGrant); fixture.run.goal = value.goal; fixture.work.goal = value.goal; } fixture.run.status = 'running'; fixture.work.status = 'running'; fixture.work.revision++; fixture.canStart = false; fixture.control = { owner: value.allowDesktop ? 'automation' : 'human', private: false, generation: fixture.control.generation + 1 }; push(); return json(res, 202, { run: fixture.run }); };
        if (holdCreate) { holdCreate = false; heldCreate = finish; return; }
        return finish();
      }
      if (route === '/api/run/cancel') { assert.equal(value.runId, fixture.run.id); paused(); fixture.run.status = 'cancelled'; push(); return json(res, 200, fixture); }
      if (route.endsWith('/artifacts/report.md/accept')) {
        assert.equal(value.expectedVersion, artifact.version);
        if (acceptConflict) { acceptConflict = false; artifact.version = 'staged-2'; return json(res, 409, { error: 'file changed', code: 'file_changed' }); }
        artifact.status = 'accepted'; recovery = [{ id: 'recovery-1', name: 'report.md', operation: 'modified', createdAt: new Date().toISOString(), status: 'available', bytes: 3, sha256: 'before', expectedVersion: 'workspace-2', runId: 'run-2' }]; return json(res, 200, { artifact });
      }
      if (route === '/api/recovery/recovery-1/restore') { assert.deepEqual(value, {}); recovery[0].status = 'restored'; return json(res, 200, { recovery: recovery[0] }); }
      if (route === '/api/demo') { fixture.run = { id: 'p0-demo', kind: 'demo', status: 'succeeded', steps: [{ title: '本地演示', status: 'succeeded' }] }; fixture.control = { owner: 'human', generation: fixture.control.generation + 1 }; push(); return json(res, 202, fixture); }
      if (route === '/api/logout') return json(res, 200, { ok: true });
      return json(res, 500, { error: `Unexpected fixture mutation: ${route}` });
    }
    const name = route === '/' ? 'index.html' : route.slice(1);
    if (!['index.html', 'app.js', 'mvp.js', 'handoff.js', 'styles.css', 'mvp.css', 'handoff.css', 'owner.js', 'owner.css'].includes(name)) return json(res, 404, { error: 'Not found.' });
    res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(await readFile(path.join(root, 'apps/web', name)));
  } catch (error) { json(res, 500, { error: error.message }); }
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
function send(method, params = {}) {
  return new Promise((resolve, reject) => { const id = nextId++; const timer = setTimeout(() => { commands.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000); commands.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) { const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text); return value.result?.value; }
async function until(operation, timeout = 12000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const result = await operation(); if (result) return result; await delay(40); } throw new Error(`Browser condition timed out at ${stage}.`); }
const check = expression => until(() => evaluate(expression));
async function input(id, value) { await evaluate(`(() => { const e=document.getElementById(${JSON.stringify(id)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`); }
async function click(id) { await evaluate(`document.getElementById(${JSON.stringify(id)}).click();true`); }
const liveVnc = "(window.__vncClients || []).filter(c => !c.disconnected)";
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const candidates = [process.env.BROWSER_BIN, process.env.CHROME_BIN, ...(process.platform === 'win32' ? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'])].filter(Boolean);
  let executable;
  for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
  assert.ok(executable, 'Set BROWSER_BIN to a local Chromium/Edge executable.');
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-dev-shm-usage', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'];
  if (process.env.ALLOW_UNSANDBOXED_BROWSER === '1') args.unshift('--no-sandbox');
  browser = spawn(executable, args, { shell: false, stdio: 'ignore' }); browser.on('error', () => {});
  const port = await until(async () => { try { return Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { return null; } });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find(item => item.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', event => { const data = JSON.parse(event.data); if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params?.exceptionDetails?.exception?.description || data.params?.exceptionDetails?.text); const item = commands.get(data.id); if (!item) return; clearTimeout(item.timer); commands.delete(data.id); if (data.error) item.reject(new Error(data.error.message)); else item.resolve(data.result || {}); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Browser.setDownloadBehavior', { behavior: 'deny' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: origin });
  stage = 'initial-current-human';
  await check("!document.querySelector('#workspace-view').hidden && document.querySelector('#desktop-status').textContent==='桌面已连接' && document.querySelector('#work-goal').textContent==='核对交接'");
  assert.equal(await evaluate(`${liveVnc}.length === 1 && ${liveVnc}[0].viewOnly === false`), true);
  assert.equal(await evaluate("['agent-observe-workspace','agent-observe-desktop','agent-allow-desktop','work-scope-none','work-scope-current'].every(id=>!document.getElementById(id).checked)"), true);
  assert.equal(await evaluate("document.querySelector('#handoff-facts').textContent.includes('生成报告') && !document.querySelector('#handoff-facts').textContent.includes('[object Object]')"), true);
  stage = 'unknown-usage-gate';
  await click('work-scope-none'); assert.equal(await evaluate("document.querySelector('#redelegate-submit').disabled"), true);
  assert.equal(await evaluate("document.querySelector('#usage-run').options.length===1 && document.querySelector('#usage-run').value==='run-2'"), true);
  await input('usage-total', '19'); assert.equal(await evaluate("document.querySelector('#usage-submit').disabled"), true);
  await input('usage-total', '80'); await click('usage-submit');
  await check("document.querySelector('#usage-form').hidden && document.querySelector('#work-budget').textContent.includes('80') && !document.querySelector('#work-scope-current').disabled");
  assert.deepEqual(calls.find(item => item.route.endsWith('/usage')).body, { revision: 1, runId: 'run-2', totalTokens: 80 });
  stage = 'fresh-scoped-redelegation';
  await click('work-scope-current'); assert.equal(await evaluate("document.querySelector('#redelegate-submit').disabled"), true);
  await click('work-observe-workspace'); await click('external-confirmed'); await input('work-context', 'OWNER EXPLICIT CONTEXT');
  await check("!document.querySelector('#redelegate-submit').disabled"); await click('redelegate-submit');
  await check("document.querySelector('#control-owner').textContent.includes('自动化')");
  assert.deepEqual(calls.find(item => item.route.endsWith('/redelegate')).body, { revision: 2, context: 'OWNER EXPLICIT CONTEXT', observe: { workspace: true, desktop: false }, allowDesktop: false, externalResult: 'confirmed' });
  assert.equal(await evaluate(`${liveVnc}.every(c=>c.viewOnly)`), true);
  stage = 'pause-unconfirmed-stop-and-retry';
  await check("!document.querySelector('#pause-button').disabled"); await click('pause-button'); await check("document.querySelector('#control-owner').textContent.includes('停止未确认')");
  assert.equal(await evaluate(`${liveVnc}.length`), 0);
  assert.equal(await evaluate("document.querySelector('#redelegate-submit').disabled && document.querySelector('#takeover-button').textContent.includes('重试')"), true);
  await click('takeover-button'); await check(`${liveVnc}.length===1 && ${liveVnc}[0].viewOnly===false && document.querySelector('#control-owner').textContent.includes('私人')`);
  assert.equal(await evaluate("!document.querySelector('#work-scope-current').checked && !document.querySelector('#work-scope-none').checked && document.querySelector('#work-context').value===''"), true);
  stage = 'same-generation-old-http-response';
  holdStatus = true; await evaluate("window.dispatchEvent(new Event('pc-refresh'));true"); await until(() => heldStatus);
  fixture.control.owner = 'stopping'; fixture.canStart = false; fixture.run.status = 'finishing'; push();
  await check("document.querySelector('#control-owner').textContent.includes('正在停止')"); heldStatus(); heldStatus = null;
  await delay(100);
  assert.equal(await evaluate("document.querySelector('#control-owner').textContent.includes('正在停止') && document.querySelector('#agent-submit').disabled"), true);
  assert.equal(await evaluate(`${liveVnc}.length`), 0);
  paused(); await check(`${liveVnc}.length===1 && ${liveVnc}[0].viewOnly===false`);
  stage = 'old-generation-sse';
  const old = clone(fixture); old.control.generation--; old.control.owner = 'automation'; push(old); await delay(100);
  assert.equal(await evaluate("document.querySelector('#control-owner').textContent.includes('人工')"), true);
  stage = 'sse-disconnect-input-fence';
  holdStatus = true; for (const res of streams) res.end(); await until(() => heldStatus);
  assert.equal(await evaluate(`${liveVnc}.every(c=>c.viewOnly)`), true);
  heldStatus(); heldStatus = null; await check(`${liveVnc}.length===1 && ${liveVnc}[0].viewOnly===false`);
  stage = 'vnc-transport-auto-reconnect';
  const vncCount = await evaluate('window.__vncClients.length');
  await evaluate(`${liveVnc}[0].dispatchEvent(new Event('disconnect'));true`);
  await check(`window.__vncClients.length>${vncCount} && ${liveVnc}.length===1 && ${liveVnc}[0].viewOnly===false`);
  stage = 'artifact-diff-conflict-review-and-download';
  await check("document.querySelector('#artifact-list button')");
  await evaluate("document.querySelector('#artifact-list button').click();true"); await check("!document.querySelector('#artifact-review').hidden && !document.querySelector('#artifact-accept').disabled");
  assert.equal(await evaluate("document.querySelector('#artifact-diff').textContent.includes('<script>fixture</script>') && !document.querySelector('#artifact-diff script')"), true);
  await click('artifact-accept'); await check("document.querySelector('#artifact-message').textContent.includes('版本已变化') && document.querySelector('#artifact-review').hidden");
  assert.equal(await evaluate("document.querySelector('#artifact-accept').disabled"), true);
  await evaluate("document.querySelectorAll('#artifact-list button')[1].click();true"); await until(() => calls.some(item => item.route.endsWith('/download')));
  await evaluate("document.querySelector('#artifact-list button').click();true"); await check("document.querySelector('#artifact-diff').textContent.includes('staged-2') && !document.querySelector('#artifact-accept').disabled");
  await click('artifact-accept'); await check("document.querySelector('#artifact-list').textContent.includes('已接受') && document.querySelector('#recovery-list button')");
  assert.deepEqual(calls.filter(item => item.route.endsWith('/accept')).map(item => item.body), [{ expectedVersion: 'staged-1' }, { expectedVersion: 'staged-2' }]);
  stage = 'restore-accepted-file';
  await evaluate("document.querySelector('#recovery-list button').click();true"); await check("document.querySelector('#recovery-list').textContent.includes('已恢复')");
  stage = 'old-diff-response-after-run-selection';
  holdDiff = true; await evaluate("document.querySelector('#artifact-list button').click();true"); await until(() => heldDiff);
  await evaluate("const e=document.querySelector('#artifact-run');e.value='run-1';e.dispatchEvent(new Event('change'));true");
  heldDiff(); heldDiff = null; await delay(100);
  assert.equal(await evaluate("document.querySelector('#artifact-review').hidden && document.querySelector('#artifact-accept').disabled"), true);
  stage = 'create-form-scope-and-cancel';
  holdCreate = true; const beforeCreate = clone(fixture);
  await input('agent-goal', '新的隔离任务'); await click('agent-submit');
  await until(() => heldCreate); push(beforeCreate); await delay(80);
  assert.equal(await evaluate(`${liveVnc}.every(c=>c.viewOnly) && document.querySelector('#redelegate-submit').disabled`), true);
  heldCreate(); heldCreate = null;
  assert.deepEqual(calls.find(item => item.route === '/api/tasks').body, { goal: '新的隔离任务', allowDesktop: false, observe: { workspace: false, desktop: false } });
  await check(`document.querySelector('#run-status').textContent==='运行中' && !document.querySelector('#cancel-button').disabled && ${liveVnc}.some(c=>!c.viewOnly)`); await click('cancel-button'); await check("document.querySelector('#run-status').textContent==='已取消'");
  assert.equal(await evaluate("document.querySelector('#agent-goal').value==='' && !document.querySelector('#agent-observe-workspace').checked && !document.querySelector('#agent-allow-desktop').checked"), true);
  stage = 'budget-exhaustion-fresh-choice';
  fixture.work.revision++; fixture.work.budget.remainingTokens = 0; fixture.work.budget.maxTokens = fixture.work.budget.tokensUsed; push();
  await check(`document.querySelector('#work-status').textContent.includes('版本 ${fixture.work.revision} ·') && !document.querySelector('#work-scope-none').checked`); await click('work-scope-none'); assert.equal(await evaluate("document.querySelector('#redelegate-submit').disabled"), true);
  await input('extra-tokens', '100'); await check("!document.querySelector('#redelegate-submit').disabled");
  stage = 'only-paused-work-can-redelegate';
  fixture.work.status = 'succeeded'; fixture.work.revision++; push();
  await check(`document.querySelector('#work-status').textContent.includes('版本 ${fixture.work.revision} ·')`);
  await click('work-scope-none'); await input('extra-tokens', '100');
  assert.equal(await evaluate("document.querySelector('#redelegate-submit').disabled && document.querySelector('#redelegate-help').textContent.includes('只有已暂停')"), true);
  if (p2b) {
    stage = 'p2b-inbox-safe-detail-and-backup';
    await check("document.querySelector('#inbox-list').children.length===6 && document.querySelector('#inbox-list').textContent.includes('机器级备份检查不可用')");
    assert.equal(await evaluate("document.querySelector('#inbox-list').textContent.includes('<img src=x onerror=alert(1)>') && !document.querySelector('#inbox-list img')"), true);
    p2bTests.push('inbox-six-kinds-safe-text', 'backup-check-unavailable');
    stage = 'p2b-offline-policy-requires-sse';
    await input('agent-goal', 'P2B 新任务目标'); await input('agent-offline-policy', 'stop');
    await check("!document.querySelector('#agent-submit').disabled");
    blockEvents = true; for (const res of streams) res.end();
    await check("document.querySelector('#state-connection').textContent.includes('中断') && !document.querySelector('#demo-button').disabled && document.querySelector('#agent-submit').disabled && document.querySelector('#agent-options-help').textContent.includes('状态推送')");
    await input('agent-offline-policy', 'continue'); await check("!document.querySelector('#agent-submit').disabled");
    blockEvents = false; await click('state-reconnect');
    await check("document.querySelector('#state-connection').textContent==='状态已连接'");
    await input('agent-offline-policy', 'pause_at_approval'); await check("!document.querySelector('#agent-submit').disabled");
    fixture.ownerOnline = false; push(); await check("document.querySelector('#agent-submit').disabled");
    fixture.ownerOnline = true; push(); await check("!document.querySelector('#agent-submit').disabled");
    p2bTests.push('offline-policy-live-sse-gate', 'owner-online-gate', 'continue-compatible-offline');
    stage = 'p2b-draft-grant-bounds';
    await click('agent-grant-enabled'); assert.equal(await evaluate("document.querySelector('#agent-submit').disabled && document.querySelector('#agent-options-help').textContent.includes('当前工作区')"), true); await click('agent-observe-workspace');
    await input('agent-grant-names', '../outside.md'); await input('agent-grant-writes', '2'); await input('agent-grant-bytes', '4096'); await input('agent-grant-minutes', '2');
    assert.equal(await evaluate("document.querySelector('#agent-submit').disabled"), true);
    await input('agent-grant-names', Array.from({ length: 129 }, (_, index) => `file-${index}.txt`).join('\n'));
    assert.equal(await evaluate("document.querySelector('#agent-submit').disabled"), true);
    await input('agent-grant-names', 'report.md\nsummary.txt');
    await input('agent-grant-writes', '101'); assert.equal(await evaluate("document.querySelector('#agent-submit').disabled"), true); await input('agent-grant-writes', '2');
    await input('agent-grant-bytes', '10485761'); assert.equal(await evaluate("document.querySelector('#agent-submit').disabled"), true); await input('agent-grant-bytes', '4096');
    await input('agent-grant-minutes', '61'); assert.equal(await evaluate("document.querySelector('#agent-submit').disabled"), true); await input('agent-grant-minutes', '2');
    await check("!document.querySelector('#agent-submit').disabled");
    const createsBefore = calls.filter(item => item.route === '/api/tasks').length;
    await click('agent-submit');
    await check("document.querySelector('#run-status').textContent==='运行中' && !document.querySelector('#current-run-options').hidden && document.querySelector('#run-draft-grant').textContent.includes('report.md') && !document.querySelector('#grant-revoke').disabled");
    const created = calls.filter(item => item.route === '/api/tasks')[createsBefore];
    assert.deepEqual(created.body, { goal: 'P2B 新任务目标', observe: { workspace: true, desktop: false }, allowDesktop: false, offlinePolicy: 'pause_at_approval', draftGrant: { names: ['report.md', 'summary.txt'], maxWrites: 2, maxBytes: 4096, ttlMs: 120000 } });
    assert.equal(await evaluate("document.querySelector('#agent-offline-policy').value==='' && !document.querySelector('#agent-grant-enabled').checked && document.querySelector('#agent-grant-names').value===''"), true);
    p2bTests.push('draft-grant-exact-names-and-limits', 'scoped-p2b-create-body', 'create-options-reset');
    stage = 'p2b-grant-live-usage-revoke-expiry';
    fixture.run.grant = fixture.run.draftGrant; delete fixture.run.draftGrant; fixture.run.grant.usedWrites = 1; fixture.run.grant.usedBytes = 128; fixture.run.grant.remainingWrites = 1; fixture.run.grant.remainingBytes = 3968; push();
    await check("document.querySelector('#run-draft-grant').textContent.includes('已写 1 / 2 次') && document.querySelector('#run-draft-grant').textContent.includes('128 / 4096 字节')");
    await click('grant-revoke'); await check("document.querySelector('#run-draft-grant').textContent.includes('已撤销') && document.querySelector('#grant-revoke').disabled");
    assert.deepEqual(calls.find(item => item.route.endsWith('/grant/revoke')).body, {});
    fixture.run.grant.revoked = false; fixture.run.grant.expired = true; fixture.run.grant.expiresAt = new Date(Date.now() - 1000).toISOString(); push();
    await check("document.querySelector('#run-draft-grant').textContent.includes('已到期') && document.querySelector('#grant-revoke').disabled");
    await click('cancel-button'); await check("document.querySelector('#run-status').textContent==='已取消' && !document.querySelector('#work-scope-none').disabled");
    p2bTests.push('grant-live-accounting', 'live-grant-field-compatible', 'grant-revoke', 'grant-expiry');
    stage = 'p2b-fresh-redelegate-settings';
    assert.equal(await evaluate("document.querySelector('#work-offline-policy').value==='' && !document.querySelector('#work-grant-enabled').checked && document.querySelector('#work-grant-names').value===''"), true);
    fixture.work.budget.remainingTokens = 500; fixture.work.budget.maxTokens = fixture.work.budget.tokensUsed + 500; fixture.work.revision++; push();
    await check(`document.querySelector('#work-status').textContent.includes('版本 ${fixture.work.revision} ·')`);
    await click('work-scope-current'); await click('work-observe-workspace'); await input('work-context', 'P2B 明确交接'); await input('work-offline-policy', 'continue'); await click('work-grant-enabled');
    await input('work-grant-names', 'new.md'); await input('work-grant-writes', '1'); await input('work-grant-bytes', '512'); await input('work-grant-minutes', '1');
    await check("!document.querySelector('#redelegate-submit').disabled");
    const revision = fixture.work.revision; await click('redelegate-submit');
    await check("document.querySelector('#run-status').textContent==='运行中' && !document.querySelector('#cancel-button').disabled");
    assert.deepEqual(calls.filter(item => item.route.endsWith('/redelegate')).at(-1).body, { revision, context: 'P2B 明确交接', observe: { workspace: true, desktop: false }, allowDesktop: false, offlinePolicy: 'continue', draftGrant: { names: ['new.md'], maxWrites: 1, maxBytes: 512, ttlMs: 60000 } });
    await click('cancel-button'); await check("document.querySelector('#run-status').textContent==='已取消' && !document.querySelector('#work-scope-none').disabled");
    assert.equal(await evaluate("['agent','work'].every(prefix=>document.getElementById(prefix+'-offline-policy').value==='' && !document.getElementById(prefix+'-grant-enabled').checked && document.getElementById(prefix+'-grant-names').value==='')"), true);
    p2bTests.push('fresh-p2b-redelegate-body', 'private-handoff-options-reset');
    stage = 'p2b-template-save-name-and-no-auto-launch';
    await input('template-name', 'x'.repeat(81)); assert.equal(await evaluate("document.querySelector('#template-save').disabled"), true);
    await input('template-name', '安全目标模板'); await check("!document.querySelector('#template-save').disabled"); await click('template-save');
    await check("document.querySelector('#template-list').children.length===1 && document.querySelector('#templates-message').textContent.includes('已保存') && !document.querySelector('#template-name').disabled");
    assert.deepEqual(calls.find(item => item.route === '/api/templates').body, { workId: 'work-1', name: '安全目标模板' });
    await input('template-name', '安全目标模板'); await click('template-save');
    await check("document.querySelector('#templates-message').textContent.includes('名称已存在') && !document.querySelector('#template-name').disabled");
    await click('agent-observe-workspace'); await click('agent-observe-desktop'); await click('agent-allow-desktop'); await input('agent-offline-policy', 'stop'); await click('agent-grant-enabled');
    await input('agent-grant-names', 'must-clear.md'); await input('agent-grant-writes', '1'); await input('agent-grant-bytes', '100'); await input('agent-grant-minutes', '1');
    const beforeLoad = calls.filter(item => item.route === '/api/tasks').length;
    await evaluate("document.querySelector('#template-list button').click();true");
    assert.equal(await evaluate("document.querySelector('#agent-goal').value==='P2B 新任务目标' && ['agent-observe-workspace','agent-observe-desktop','agent-allow-desktop','agent-grant-enabled'].every(id=>!document.getElementById(id).checked) && document.querySelector('#agent-offline-policy').value==='' && ['names','writes','bytes','minutes'].every(key=>document.getElementById('agent-grant-'+key).value==='')"), true);
    assert.equal(calls.filter(item => item.route === '/api/tasks').length, beforeLoad);
    p2bTests.push('template-name-limit-and-duplicate', 'template-goal-only-save', 'template-load-fresh-permissions', 'template-never-auto-launches');
    stage = 'p2b-visible-390px-layout';
    await evaluate("document.querySelector('#agent-options-details').open=true;document.querySelector('#work-options-details').open=true;true");
    await click('agent-grant-enabled'); await click('work-grant-enabled');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    narrowP2B = await evaluate('({width:innerWidth,pageWidth:document.documentElement.scrollWidth})'); assert.ok(narrowP2B.pageWidth <= narrowP2B.width + 2);
    stage = 'p2b-template-delete';
    await evaluate("document.querySelectorAll('#template-list button')[1].click();true"); await check("document.querySelector('#template-list').children.length===0 && document.querySelector('#templates-message').textContent.includes('已删除')");
    assert.equal(calls.some(item => item.route === '/api/templates/template-1' && item.method === 'DELETE'), true);
    p2bTests.push('p2b-390px-visible-layout', 'template-delete');
  }
  stage = 'p0-compatibility-and-layout';
  fixture.phase = 'p0'; fixture.work = undefined; fixture.run = null; fixture.canStart = true; fixture.control = { owner: 'human', generation: fixture.control.generation + 1 }; push();
  await check("document.querySelector('#mvp-panel').hidden && document.querySelector('#handoff-panel').hidden && !document.querySelector('#demo-button').disabled");
  await click('demo-button'); await check("document.querySelector('#run-status').textContent==='已完成'");
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  const narrow = await evaluate('({width:innerWidth,pageWidth:document.documentElement.scrollWidth})'); assert.ok(narrow.pageWidth <= narrow.width + 2);
  await click('logout-button'); await check("!document.querySelector('#login-view').hidden");
  assert.equal(await evaluate(`${liveVnc}.length`), 0); assert.equal(exceptions.length, 0);
  assert.equal(calls.some(item => item.route === '/api/model/test'), false);
  console.log(JSON.stringify({ ok: true, check: p2b ? 'owner-p2b-browser-contract-fixture' : 'handoff-browser-contract-fixture', tests: ['current-human-vnc', 'unknown-usage-gate', 'explicit-fresh-scope', 'fact-objects', 'pause-unconfirmed-retry', 'same-generation-old-http', 'old-generation-sse', 'sse-disconnect-input-fence', 'vnc-auto-reconnect', 'artifact-version-conflict', 'artifact-download', 'recovery-restore', 'stale-diff-selection', 'pending-create-old-sse-fence', 'scoped-task-create-cancel', 'exhausted-budget-topup', 'only-paused-redelegate', 'p0-compatibility', 'narrow-layout', 'logout-clears-vnc', ...p2bTests], mutations: calls.filter(item => item.body !== null).length, modelRequests: 0, exceptions: exceptions.length, narrow, ...(narrowP2B ? { narrowP2B } : {}) }));
} catch (error) {
  let diagnostics;
  try { diagnostics = ws?.readyState === 1 ? await evaluate("({owner:document.querySelector('#control-owner')?.textContent,run:document.querySelector('#run-status')?.textContent,global:document.querySelector('#global-message')?.textContent,handoff:document.querySelector('#handoff-message')?.textContent,help:document.querySelector('#redelegate-help')?.textContent,artifact:document.querySelector('#artifact-message')?.textContent,work:document.querySelector('#work-status')?.textContent,templateName:document.querySelector('#template-name')?.value,templateSource:document.querySelector('#template-source')?.textContent,templateDisabled:document.querySelector('#template-save')?.disabled,templateMessage:document.querySelector('#templates-message')?.textContent,templateCount:document.querySelector('#template-list')?.children.length})") : null; } catch {}
  console.error(JSON.stringify({ ok: false, check: 'handoff-browser-contract-fixture', stage, error: error.message, diagnostics, exceptions })); process.exitCode = 1;
} finally {
  for (const item of commands.values()) { clearTimeout(item.timer); item.reject(new Error('Browser check closed.')); } commands.clear();
  ws?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(2000)]); if (browser.exitCode === null) browser.kill('SIGKILL'); }
  for (const res of streams) res.end(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  // Delete only this invocation's verified mkdtemp-created browser profile.
  if (path.dirname(profile) === tmpdir() && path.basename(profile).startsWith('bot-handoff-ui-')) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
