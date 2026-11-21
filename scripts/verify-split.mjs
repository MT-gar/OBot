#!/usr/bin/env node
// Offline split-runtime rehearsal. Never invokes a model, starts a stack, or reads
// desktop/egress credentials. See --help; the shell wrapper alone can recreate.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICES = ['computer', 'desktop', 'egress'];
const SOURCES = {
  computer: ['apps/control/src/server.mjs', 'apps/control/src/controller.mjs', 'apps/control/src/remote-runtime.mjs', 'apps/control/src/runtime.mjs', 'apps/control/src/workspace.mjs', 'apps/control/src/artifacts.mjs', 'apps/control/src/works.mjs', 'apps/control/src/agent.mjs', 'apps/control/src/acp.mjs', 'apps/control/src/acp-bridge.mjs', 'apps/control/src/acp-rpc.mjs', 'apps/control/src/model.mjs', 'runtime/acp/budget.mjs'],
  desktop: ['apps/desktop/server.mjs', 'apps/desktop/tools.mjs', 'apps/desktop/network-policy.mjs', 'apps/control/src/runtime.mjs'],
  egress: ['apps/desktop/egress.mjs', 'apps/desktop/network-policy.mjs'],
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const requireThat = (value, message) => { if (!value) throw new Error(message); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HELP = `Usage (Linux/WSL, existing isolated offline split stack):
  node scripts/verify-split.mjs --project NAME --port PORT --phase smoke|persistence|isolation|prepare-restart --owner-password-file PATH --evidence-dir PATH
  node scripts/verify-split.mjs --self-test
  bash scripts/verify-split.sh smoke|persistence|isolation|recreate|recreate-interrupted

Require explicit COMPOSE_PROJECT_NAME, BOT_PORT, BOT_SECRET_DIR for the wrapper.
Project must include check/test/smoke/verify and cannot be private-computer-p0;
port 3180 is forbidden. MODEL_ENABLED=0 must be true in the existing control.
smoke writes synthetic sentinels and runs only /api/demo. persistence requires
smoke's manifest and replacement control/desktop IDs with identical volumes,
images and source. prepare-restart deliberately leaves one owned demo active;
recreate-interrupted explicitly SIGKILLs that isolated control before recreation.
The wrapper never builds, pulls, initializes credentials, removes volumes, or
operates on the default project. No public/provider request is supported.
Evidence separates live offline runtime checks from local instrumented fixtures;
real ACP tools, paid usage, approvals and external egress remain unverified.\n`;

export function selection(argv) {
  if (argv.length === 1 && argv[0] === '--self-test') return { selfTest: true };
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const value = {};
  for (let i = 0; i < argv.length; i += 2) {
    requireThat(['--project', '--port', '--phase', '--owner-password-file', '--evidence-dir'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--') && value[argv[i]] === undefined, 'Use the explicit options shown by --help.');
    value[argv[i]] = argv[i + 1];
  }
  const project = value['--project']; const port = Number(value['--port']);
  requireThat(typeof project === 'string' && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(project) && /(?:check|test|smoke|verify)/.test(project) && project !== 'private-computer-p0', 'An explicit isolated verification project is required.');
  requireThat(/^\d+$/.test(value['--port'] || '') && Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 3180, 'Choose an explicit non-default localhost port (1024-65535, excluding 3180).');
  requireThat(['smoke', 'persistence', 'isolation', 'prepare-restart'].includes(value['--phase']), 'Choose smoke, persistence, isolation or prepare-restart.');
  requireThat(value['--owner-password-file'] && path.isAbsolute(value['--owner-password-file']), 'An explicit absolute isolated owner password file is required.');
  const ownerFile = path.resolve(value['--owner-password-file']);
  requireThat(path.basename(ownerFile) === 'owner-password' && path.basename(path.dirname(ownerFile)) === project, 'Owner password must belong to the explicitly named isolated project directory.');
  requireThat(value['--evidence-dir'], 'Choose an explicit evidence directory.');
  return { project, port, phase: value['--phase'], ownerFile, evidenceDir: path.resolve(value['--evidence-dir']), origin: `http://localhost:${port}` };
}

async function command(commandName, args, { input, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, { cwd: root, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0; let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('A bounded local diagnostic timed out.')); }, timeoutMs);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) { child.kill(); finish(new Error('Local diagnostic exceeded its output limit.')); } else chunks.push(chunk); });
    child.stderr.on('data', () => {}); // Never print raw Docker/configuration diagnostics.
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new Error('Could not launch the required local diagnostic.')));
    child.on('close', code => finish(code === 0 ? null : new Error('Local diagnostic failed; raw output was withheld.'), Buffer.concat(chunks).toString('utf8')));
    child.stdin.end(input);
  });
}
function parseJson(text) { try { return JSON.parse(text); } catch { throw new Error('Local diagnostic returned invalid JSON.'); } }
async function dockerJson(args, options) { return parseJson(await command('docker', args, options)); }
const composeArgs = config => ['compose', '--project-directory', root, '--project-name', config.project, '-f', path.join(root, 'deploy/compose/compose.yaml')];

export function validateContainers(rows, config) {
  const result = {};
  for (const service of SERVICES) {
    const row = rows.find(item => item.Config?.Labels?.['com.docker.compose.service'] === service);
    requireThat(row && rows.filter(item => item.Config?.Labels?.['com.docker.compose.service'] === service).length === 1 && row.State?.Running === true && row.Config.Labels['com.docker.compose.project'] === config.project, 'Expected exactly one running container per isolated split role.');
    const env = Object.fromEntries((row.Config.Env || []).map(item => { const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)]; }));
    requireThat(env.APP_ROLE === (service === 'computer' ? 'control' : service), 'A container has an unexpected role.');
    requireThat(!Object.keys(env).some(name => /(?:API_KEY|PASSWORD|TOKEN)$/.test(name)), 'Credentials must not be stored in environment values.');
    if (service === 'computer') requireThat(env.MODEL_ENABLED === '0' && env.MODEL_EXECUTOR === 'dsh-acp', 'Smoke requires the split ACP image with MODEL_ENABLED=0; no provider is invoked.');
    else requireThat(!Object.keys(env).some(name => /^(?:MODEL_|DSH_|OWNER_|OPENAI_|ANTHROPIC_|XINGCHI_|PRIVATE_COMPUTER_POLICY_)/.test(name)), 'Desktop/egress inherited owner, model or ACP environment.');
    const mounts = row.Mounts || [];
    requireThat(!mounts.some(item => /docker\.sock/.test(item.Source + item.Destination)), 'Docker sockets must not be mounted.');
    const secrets = mounts.filter(item => item.Destination.startsWith('/run/secrets/')).map(item => path.posix.basename(item.Destination)).sort();
    requireThat(equal(secrets, service === 'computer' ? ['model-key', 'owner-password', 'runner-token'] : service === 'desktop' ? ['runner-token'] : []), 'A role has unexpected credential mounts.');
    const bindings = row.HostConfig?.PortBindings || {};
    if (service === 'computer') {
      requireThat(Object.keys(bindings).length === 1 && bindings['3180/tcp']?.length === 1 && bindings['3180/tcp'][0].HostIp === '127.0.0.1' && bindings['3180/tcp'][0].HostPort === String(config.port), 'Only the chosen loopback owner port may be published.');
      const ownerMount = mounts.find(item => item.Destination === '/run/secrets/owner-password');
      requireThat(path.resolve(ownerMount.Source) === config.ownerFile, 'The supplied owner credential does not belong to this isolated control container.');
    } else requireThat(Object.keys(bindings).length === 0, 'Desktop and egress must not publish ports.');
    const dataMounts = mounts.filter(item => item.Type === 'volume').map(item => ({ destination: item.Destination, volume: item.Name, subpath: item.SubPath || item.Subpath || null })).sort((a, b) => a.destination.localeCompare(b.destination));
    for (const mount of dataMounts) requireThat([`${config.project}_computer-home`, `${config.project}_control-state`].includes(mount.volume), 'A verification role mounted another project data volume.');
    requireThat(service === 'computer' ? dataMounts.some(item => item.destination === '/workspace') && dataMounts.some(item => item.destination === '/var/lib/private-computer') : service === 'desktop' ? dataMounts.some(item => item.destination === '/home/desktop') : dataMounts.length === 0, 'Required isolated data volumes are missing.');
    result[service] = { id: row.Id, image: row.Config.Image, imageId: row.Image, dataMounts };
  }
  requireThat(rows.length === 3, 'The selected project must contain exactly three split containers.');
  return result;
}
async function inspect(config) {
  const ids = (await command('docker', [...composeArgs(config), 'ps', '--all', '-q'])).trim().split(/\s+/);
  requireThat(ids.length === 3 && ids.every(id => /^[a-f0-9]{12,64}$/.test(id)), 'Expected three existing isolated split containers.');
  const rows = await dockerJson(['inspect', ...ids]);
  const result = validateContainers(rows, config);
  for (const row of rows) {
    const service = row.Config.Labels['com.docker.compose.service'];
    const networks = Object.keys(row.NetworkSettings?.Networks || {}).sort();
    const expected = [`${config.project}_desktop-net`, ...(service === 'desktop' ? [] : [`${config.project}_internet-net`])].sort();
    requireThat(equal(networks, expected), 'A role is attached to an unexpected network.');
  }
  const [network] = await dockerJson(['network', 'inspect', `${config.project}_desktop-net`]);
  requireThat(network.Internal === true && network.Labels?.['com.docker.compose.project'] === config.project, 'The actual desktop network is not an isolated internal network.');
  return result;
}

// Serialized into docker exec stdin. Inputs contain only synthetic data and source
// paths. It never reads owner/model credentials or runner tokens in any role.
async function roleProbe(input) {
  const { access, readFile, writeFile, mkdir, readdir, lstat } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { pathToFileURL } = await import('node:url');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const ok = (value, message) => { if (!value) throw new Error(message); };
  const readable = async file => { try { await access(file, constants.R_OK); return true; } catch { return false; } };
  const exists = async file => { try { await lstat(file); return true; } catch { return false; } };
  const moduleAt = relative => import(pathToFileURL((input.root || '/opt/private-computer') + '/' + relative).href);
  if (input.operation === 'identity') {
    const sources = {};
    for (const file of input.files) {
      const installed = file.startsWith('runtime/desktop/') ? '/usr/local/lib/private-computer/' + file.split('/').at(-1) : '/opt/private-computer/' + file;
      sources[file] = hash(await readFile(installed));
    }
    const processModule = input.role === 'computer' ? '/opt/private-computer/apps/control/src/server.mjs' : '/opt/private-computer/apps/desktop/' + (input.role === 'desktop' ? 'server.mjs' : 'egress.mjs');
    const serverProcesses = [];
    for (const pid of (await readdir('/proc')).filter(value => /^\d+$/.test(value))) {
      const argv = (await readFile('/proc/' + pid + '/cmdline', 'utf8').catch(() => '')).split('\0');
      if (!argv.includes(processModule)) continue;
      const status = await readFile('/proc/' + pid + '/status', 'utf8');
      const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
      ok(uid === (input.role === 'desktop' ? 1200 : 1100), 'A service process is running under an unexpected identity.');
      serverProcesses.push({ pid: Number(pid), uid });
    }
    ok(serverProcesses.length === 1, 'Expected one actual server process for the role.');
    const credentials = {};
    for (const name of ['owner-password', 'model-key', 'runner-token']) credentials[name] = await exists('/run/secrets/' + name);
    const desktopTokenReadable = await readable('/run/private-runner/token') || await readable('/run/secrets/runner-token');
    const leakedEnvironment = Object.keys(process.env).some(name => /^(?:MODEL_|DSH_|OWNER_|OPENAI_|ANTHROPIC_|XINGCHI_|PRIVATE_COMPUTER_POLICY_)/.test(name));
    ok(process.platform === 'linux' && process.getuid() === 1100, 'Probe must run as the unprivileged desktop identity.');
    if (input.role !== 'computer') ok(!credentials['owner-password'] && !credentials['model-key'] && !leakedEnvironment, 'A non-control role has owner/model access.');
    if (input.role === 'desktop') ok(!desktopTokenReadable, 'The desktop user can read the runner credential.');
    if (input.role === 'egress') ok(!credentials['runner-token'], 'Egress has a runner credential.');
    ok(!await exists('/var/run/docker.sock'), 'A role has a Docker socket.');
    let acp;
    if (input.role === 'computer') {
      const pkg = JSON.parse(await readFile('/opt/dsh/node_modules/@deepseek-ai/dsh/package.json', 'utf8'));
      const { execFile } = await import('node:child_process');
      const pinnedNode = await new Promise((resolve, reject) => execFile('/opt/private-node/node_modules/node/bin/node', ['--version'], { timeout: 3000 }, (error, stdout) => error ? reject(new Error('Pinned Node missing.')) : resolve(stdout.trim())));
      ok(pkg.version === '0.2.2-rc.3' && pinnedNode === 'v24.22.3', 'Pinned ACP versions do not match.');
      await access('/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js');
      await access('/opt/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml');
      const entries = await readdir('/run/private-computer/acp').catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      ok(entries.length === 0, 'ACP temporary work directories remain in this offline rehearsal.');
      let acpProcesses = 0;
      for (const pid of (await readdir('/proc')).filter(value => /^\d+$/.test(value))) {
        const cmd = await readFile('/proc/' + pid + '/cmdline', 'utf8').catch(() => '');
        if (cmd.includes('/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')) acpProcesses++;
      }
      ok(acpProcesses === 0, 'An unexpected ACP child is running during the offline smoke.');
      acp = { node: pinnedNode, dsh: pkg.version, temporaryDirectories: entries.length, runningChildren: acpProcesses };
    }
    return { role: input.role, node: process.version, architecture: process.arch, platform: process.platform, uid: process.getuid(), serverProcesses, credentials, desktopTokenReadable, sources, ...(acp ? { acp } : {}) };
  }
  if (input.operation === 'runner-fence') {
    const statuses = [];
    for (const route of ['/inspect', '/screenshot', '/view-only', '/tool']) {
      const response = await fetch('http://127.0.0.1:3181' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2500), redirect: 'error' });
      ok(response.status === 401, 'A private runner endpoint accepted an unauthenticated request.');
      await response.arrayBuffer(); statuses.push({ route, status: response.status });
    }
    return { statuses, credentialRead: false };
  }
  if (input.operation === 'pointer') {
    const { runCommand } = await moduleAt('apps/control/src/runtime.mjs');
    const text = (await runCommand('xdotool', ['getmouselocation', '--shell'], { env: { ...process.env, DISPLAY: ':99' }, maxBytes: 8192, timeoutMs: 2500 })).toString('utf8');
    const x = /^X=(\d+)$/m.exec(text), y = /^Y=(\d+)$/m.exec(text);
    ok(x && y, 'Could not inspect the isolated Xvfb pointer.'); return { x: Number(x[1]), y: Number(y[1]) };
  }
  if (['browser', 'browser-write', 'browser-check'].includes(input.operation)) {
    const base = 'http://127.0.0.1:9222';
    const response = await fetch(base + '/json/list', { signal: AbortSignal.timeout(2500), redirect: 'error' });
    ok(response.ok, 'Desktop CDP is unavailable.');
    const pages = (await response.json()).filter(item => item.type === 'page');
    const fixtures = pages.filter(item => item.url === 'http://control:3180/fixture');
    const target = input.tabId ? fixtures.find(item => item.id === input.tabId) : fixtures.at(-1);
    ok(target, 'The expected local fixture tab does not exist.');
    const endpoint = new URL(target.webSocketDebuggerUrl);
    ok(endpoint.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname) && endpoint.port === '9222', 'Unexpected CDP target.');
    const { cdpConnection } = await moduleAt('apps/control/src/runtime.mjs');
    const cdp = await cdpConnection(endpoint.href);
    try {
      const expression = input.operation === 'browser-write'
        ? `(()=>{if(location.href!=='http://control:3180/fixture')throw Error('fixture');localStorage.setItem('split-smoke-sentinel',${JSON.stringify(input.marker)});return {marker:localStorage.getItem('split-smoke-sentinel')};})()`
        : `({project:document.querySelector('#project')?.value,result:document.querySelector('#result')?.textContent,marker:localStorage.getItem('split-smoke-sentinel')})`;
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
      ok(!result.exceptionDetails && result.result?.value, 'The fixed browser inspection failed.');
      const value = result.result.value;
      if (input.operation === 'browser-write' || input.operation === 'browser-check') ok(value.marker === input.marker, 'Persistent browser localStorage sentinel differs.');
      if (input.operation === 'browser-write') {
        await mkdir('/home/desktop/.config/chromium', { recursive: true });
        const markerFile = '/home/desktop/.config/chromium/split-smoke-' + input.marker + '.txt';
        await writeFile(markerFile, input.marker + '\n', { flag: 'wx', mode: 0o600 });
        await new Promise(resolve => setTimeout(resolve, 2200)); // Allow Chromium's local storage commit.
      }
      if (input.operation === 'browser-check') ok(await readFile('/home/desktop/.config/chromium/split-smoke-' + input.marker + '.txt', 'utf8') === input.marker + '\n', 'Persistent profile file differs.');
      return { tabId: target.id, pages: pages.map(item => ({ id: item.id, fixture: item.url === 'http://control:3180/fixture' })), ...value };
    } finally { cdp.close(); }
  }
  if (input.operation === 'egress-fixture') {
    // This runs in the real egress role and imports the image's policy/proxy.
    // Replace every upstream dial before issuing private-address test requests.
    const http = (await import('node:http')).default;
    const net = (await import('node:net')).default;
    const { createEgressProxy } = await moduleAt('apps/desktop/egress.mjs');
    const { publicTarget } = await moduleAt('apps/desktop/network-policy.mjs');
    const originalRequest = http.request, originalConnect = net.connect;
    let upstreamDials = 0, resolutions = 0;
    http.request = () => { upstreamDials++; throw new Error('Upstream dial disabled by local fixture.'); };
    net.connect = () => { upstreamDials++; throw new Error('Upstream dial disabled by local fixture.'); };
    const proxy = createEgressProxy({ resolveTarget: value => publicTarget(value, { resolve: async () => { resolutions++; throw new Error('DNS disabled by local fixture.'); } }) });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const port = proxy.address().port;
    const targets = ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1/', 'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.0.1/', 'http://[::1]/', 'http://localhost/', 'http://control:3180/api/status'];
    const results = [];
    try {
      for (const target of targets) {
        const status = await new Promise((resolve, reject) => {
          const req = originalRequest({ host: '127.0.0.1', port, path: target, agent: false }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
          req.setTimeout(2000, () => req.destroy(new Error('Fixture timed out.'))); req.on('error', reject); req.end();
        });
        ok(status === 403, 'A private HTTP destination was not blocked.'); results.push({ target, status });
      }
      const status = await new Promise((resolve, reject) => {
        const req = originalRequest({ host: '127.0.0.1', port, method: 'CONNECT', path: '169.254.169.254:443', agent: false });
        req.setTimeout(2000, () => req.destroy(new Error('Fixture timed out.')));
        req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); }); req.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end();
      });
      ok(status === 403 && upstreamDials === 0 && resolutions === 0, 'Private probes attempted a DNS lookup or upstream connection.');
      return { boundary: 'instrumented proxy fixture in actual egress container', results, metadataConnectStatus: status, upstreamDials, dnsLookups: resolutions, publicEgressTested: false };
    } finally { http.request = originalRequest; net.connect = originalConnect; proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  }
  throw new Error('Unknown bounded role probe.');
}
async function probe(container, role, operation, extra = {}) {
  const input = { role, operation, ...extra };
  const source = `try { const result = await (${roleProbe.toString()})(${JSON.stringify(input)}); console.log(JSON.stringify(result)); } catch { console.error('Bounded split role probe failed.'); process.exitCode=1; }`;
  return dockerJson(['exec', '-i', '--user', 'desktop', container.id, 'node', '--input-type=module'], { input: source });
}
async function identities(containers) {
  const result = {};
  for (const role of SERVICES) {
    const files = [...SOURCES[role], 'runtime/desktop/entrypoint.sh', 'runtime/desktop/session.sh'];
    const local = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(path.join(root, file)))])));
    const observed = await probe(containers[role], role, 'identity', { files });
    requireThat(equal(local, observed.sources), 'A running role has stale source; rebuild and recreate the isolated project.');
    result[role] = observed;
  }
  return result;
}

export function ownerClient({ port, origin = `http://localhost:${port}` }) {
  let cookie; let password;
  const ownRuns = new Set();
  function request(route, { method = 'GET', body, auth = true, requestOrigin = origin, host = new URL(origin).host, headers = {} } = {}) {
    requireThat(route.startsWith('/') && !route.startsWith('//'), 'Owner request must use a local application path.');
    requireThat(!/^\/api\/(?:tasks|works)(?:\/|$)/.test(route) || method === 'GET', 'The offline verifier cannot dispatch model tasks or approvals.');
    requireThat(route !== '/api/model/test', 'The offline verifier cannot invoke a provider.');
    return new Promise((resolve, reject) => {
      const content = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { Host: host, ...(requestOrigin === null ? {} : { Origin: requestOrigin }), ...(auth && cookie ? { Cookie: cookie } : {}), ...(content ? { 'Content-Type': 'application/json', 'Content-Length': content.length } : {}), ...headers } }, res => {
        const chunks = []; let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) res.destroy(); else chunks.push(chunk); });
        res.on('error', () => reject(new Error('Owner HTTP response failed.')));
        res.on('end', () => { const buffer = Buffer.concat(chunks); let json; try { json = JSON.parse(buffer.toString('utf8')); } catch {} resolve({ status: res.statusCode, headers: res.headers, buffer, json }); });
      });
      req.setTimeout(8000, () => req.destroy()); req.on('error', () => reject(new Error('Owner localhost request failed or timed out.'))); req.end(content);
    });
  }
  async function login(file) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const info = await handle.stat(); requireThat(info.isFile() && info.size >= 12 && info.size <= 4096, 'Isolated owner credential must be a bounded regular file.'); password = (await handle.readFile('utf8')).replace(/\r?\n$/, ''); }
    finally { await handle.close(); }
    try {
      const response = await request('/api/login', { method: 'POST', auth: false, body: { password } });
      requireThat(response.status === 200, 'Isolated owner login failed.');
      const header = response.headers['set-cookie']?.[0];
      requireThat(header && /HttpOnly/i.test(header) && /SameSite=Strict/i.test(header), 'Owner session cookie flags are missing.');
      cookie = header.split(';')[0];
    } finally { password = undefined; }
  }
  async function status() { const response = await request('/api/status'); requireThat(response.status === 200 && response.json, 'Authenticated status failed.'); return response.json; }
  async function startDemo() { const result = await request('/api/demo', { method: 'POST', body: {} }); requireThat(result.status === 202 && UUID.test(result.json?.id), 'Fixed offline demo did not start.'); ownRuns.add(result.json.id); return result.json.id; }
  function upgrade({ auth = true, requestOrigin = origin } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/desktop', headers: { Host: new URL(origin).host, Origin: requestOrigin, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Protocol': 'binary', ...(auth && cookie ? { Cookie: cookie } : {}) } });
      req.setTimeout(5000, () => req.destroy());
      req.on('upgrade', (res, socket, head) => { socket.setTimeout(0); resolve({ status: res.statusCode, socket, head }); });
      req.on('response', res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
      req.on('error', () => reject(new Error('Owner RFB upgrade failed or timed out.'))); req.end();
    });
  }
  async function cleanup(leaveRun = false) {
    if (!cookie) return;
    try { const value = await status(); if (!leaveRun && ownRuns.has(value.run?.id) && ['running', 'finishing'].includes(value.run.status)) await request('/api/run/cancel', { method: 'POST', body: { runId: value.run.id } }); } catch {}
    try { await request('/api/logout', { method: 'POST', body: {} }); } catch {}
    cookie = undefined;
  }
  return { request, login, status, startDemo, upgrade, cleanup };
}
async function poll(operation, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { const value = await operation(); if (value) return value; await delay(120); }
  throw new Error('A bounded verification condition did not become true.');
}

// A bounded raw RFB client proves actual framebuffer bytes and input fencing.
// noVNC's separately verified module graph is not claimed as a rendered UI test.
async function rfbClient(client) {
  const opened = await client.upgrade(); requireThat(opened.status === 101, 'Authenticated desktop websocket did not upgrade.');
  const { socket } = opened; let wire = Buffer.alloc(0), stream = Buffer.alloc(0), closed = false, waiting;
  const wake = () => { waiting?.(); waiting = undefined; };
  function send(payload, opcode = 2) {
    requireThat(!closed, 'RFB connection closed.');
    const mask = randomBytes(4); let header;
    if (payload.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    else { requireThat(payload.length <= 65535, 'RFB client frame too large.'); header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0xfe; header.writeUInt16BE(payload.length, 2); }
    const encoded = Buffer.from(payload); for (let i = 0; i < encoded.length; i++) encoded[i] ^= mask[i % 4];
    socket.write(Buffer.concat([header, mask, encoded]));
  }
  function consume(chunk) {
    wire = Buffer.concat([wire, chunk]); requireThat(wire.length <= 20 * 1024 * 1024, 'RFB websocket buffer exceeded its limit.');
    while (wire.length >= 2) {
      const opcode = wire[0] & 15, masked = Boolean(wire[1] & 128); let size = wire[1] & 127, at = 2;
      if (size === 126) { if (wire.length < 4) return; size = wire.readUInt16BE(2); at = 4; }
      else if (size === 127) { if (wire.length < 10) return; requireThat(wire.readUInt32BE(2) === 0, 'RFB frame exceeded its bound.'); size = wire.readUInt32BE(6); at = 10; }
      requireThat(size <= 16 * 1024 * 1024 && !masked, 'Unexpected server websocket frame.');
      if (wire.length < at + size) return;
      const data = wire.subarray(at, at + size); wire = wire.subarray(at + size);
      if (opcode === 8) { closed = true; socket.destroy(); }
      else if (opcode === 9) send(data, 10);
      else if (opcode === 0 || opcode === 2) stream = Buffer.concat([stream, data]);
      requireThat(stream.length <= 16 * 1024 * 1024, 'RFB stream exceeded its bound.'); wake();
    }
  }
  socket.on('data', chunk => { try { consume(chunk); } catch { closed = true; socket.destroy(); wake(); } });
  socket.on('close', () => { closed = true; wake(); }); socket.on('error', () => { closed = true; wake(); });
  if (opened.head.length) consume(opened.head);
  async function take(size) {
    const until = Date.now() + 6000;
    while (stream.length < size) {
      requireThat(!closed && Date.now() < until, 'RFB stream closed or timed out.');
      await new Promise(resolve => { const timer = setTimeout(() => { waiting = undefined; resolve(); }, Math.min(200, until - Date.now())); waiting = () => { clearTimeout(timer); resolve(); }; });
    }
    const result = stream.subarray(0, size); stream = stream.subarray(size); return result;
  }
  try {
    requireThat((await take(12)).toString('ascii') === 'RFB 003.008\n', 'Expected RFB 3.8.'); send(Buffer.from('RFB 003.008\n'));
    const count = (await take(1))[0]; requireThat(count > 0 && (await take(count)).includes(1), 'Expected private RFB SecurityType None behind owner auth.');
    send(Buffer.from([1])); requireThat((await take(4)).readUInt32BE(0) === 0, 'RFB security negotiation failed.'); send(Buffer.from([1]));
    const init = await take(24); const width = init.readUInt16BE(0), height = init.readUInt16BE(2); const nameBytes = init.readUInt32BE(20);
    requireThat(width > 0 && height > 0 && width * height <= 2 * 1024 * 1024 && nameBytes <= 8192, 'RFB dimensions/name exceeded the fixture bounds.'); await take(nameBytes);
    const format = Buffer.alloc(20); format[4] = 32; format[5] = 24; format[7] = 1; format.writeUInt16BE(255, 8); format.writeUInt16BE(255, 10); format.writeUInt16BE(255, 12); format[14] = 16; format[15] = 8; send(format);
    send(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]));
    const update = Buffer.alloc(10); update[0] = 3; update.writeUInt16BE(width, 6); update.writeUInt16BE(height, 8); send(update);
    let pixels = 0; const colors = new Set();
    while (!pixels) {
      const type = (await take(1))[0];
      if (type === 2) continue;
      if (type === 3) { const header = await take(7); const length = header.readUInt32BE(3); requireThat(length <= 65536, 'RFB clipboard exceeded the fixture bound.'); await take(length); continue; }
      requireThat(type === 0, 'Unexpected RFB server message.'); const rectangles = (await take(3)).readUInt16BE(1); requireThat(rectangles <= 1024, 'Too many RFB rectangles.');
      for (let i = 0; i < rectangles; i++) {
        const header = await take(12), w = header.readUInt16BE(4), h = header.readUInt16BE(6), encoding = header.readInt32BE(8);
        requireThat(encoding === 0 && w * h <= width * height, 'Expected bounded raw RFB framebuffer.');
        const data = await take(w * h * 4); pixels += w * h;
        for (let offset = 0; offset < data.length; offset += Math.max(4, Math.floor(data.length / 4096 / 4) * 4)) colors.add(data.subarray(offset, offset + 3).toString('hex'));
      }
    }
    requireThat(colors.size >= 4, 'RFB framebuffer does not contain a varied real desktop.');
    return { frame: { protocol: 'RFB 3.8', width, height, rawPixels: pixels, sampledColors: colors.size }, pointer(point) { const buffer = Buffer.alloc(6); buffer[0] = 5; buffer.writeUInt16BE(point.x, 2); buffer.writeUInt16BE(point.y, 4); send(buffer); }, close() { closed = true; socket.destroy(); } };
  } catch (error) { socket.destroy(); throw error; }
}

export async function ownerChecks(client, check) {
  await check('owner-auth-and-origin', async () => {
    requireThat((await client.request('/healthz', { auth: false, requestOrigin: null })).status === 200, 'Health endpoint unavailable.');
    for (const route of ['/api/status', '/api/files', '/api/desktop/screenshot', '/api/events', '/vendor/novnc/core/rfb.js']) requireThat((await client.request(route, { auth: false })).status === 401, 'A private owner endpoint accepted an unauthenticated request.');
    requireThat((await client.request('/api/demo', { method: 'POST', requestOrigin: null, body: {} })).status === 403, 'A mutation accepted a missing Origin.');
    requireThat((await client.request('/api/status', { requestOrigin: 'https://invalid.example' })).status === 403, 'Hostile Origin accepted.');
    requireThat((await client.request('/healthz', { host: 'invalid.example' })).status === 403, 'Unknown Host accepted.');
    requireThat((await client.upgrade({ auth: false })).status === 401, 'Unauthenticated RFB upgrade accepted.');
    requireThat((await client.upgrade({ requestOrigin: 'https://invalid.example' })).status === 403, 'Hostile RFB Origin accepted.');
    return { ownerOnly: true, originRequired: true };
  });
  await check('authenticated-novnc-module-graph', async () => {
    const pending = ['/vendor/novnc/core/rfb.js'], seen = new Set();
    while (pending.length) {
      const route = pending.shift(); if (seen.has(route)) continue; seen.add(route);
      requireThat(seen.size <= 100, 'noVNC module graph exceeded its bound.');
      const result = await client.request(route); requireThat(result.status === 200 && /javascript/.test(result.headers['content-type']), 'A noVNC module failed to load.');
      for (const match of result.buffer.toString('utf8').matchAll(/\b(?:import|export)\s+(?:[^;'\"]*?\s+from\s*)?['\"]([^'\"]+)['\"]/g)) {
        if (!match[1].startsWith('.')) continue;
        const target = new URL(match[1], 'http://local.invalid' + route);
        requireThat(target.pathname.startsWith('/vendor/novnc/'), 'A noVNC import escaped its prefix.');
        if (target.pathname.endsWith('.js')) pending.push(target.pathname);
      }
    }
    return { modules: seen.size, renderedBrowserUi: false };
  });
  await check('offline-desktop-screenshot', async () => {
    const value = await poll(async () => { const status = await client.status(); return status.desktop?.ready && status.desktop.browserReady && status.canStart && status; });
    requireThat(value.phase === 'p0' && !value.model && value.control.owner === 'human' && value.sandbox?.enabled === true && value.workspacePersistent === true, 'Expected idle, sandboxed, explicitly offline split runtime.');
    const result = await client.request('/api/desktop/screenshot');
    requireThat(result.status === 200 && result.headers['content-type'] === 'image/png' && result.buffer.length > 24 && result.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Owner screenshot did not return a real PNG.');
    return { bytes: result.buffer.length, sha256: sha(result.buffer), width: result.buffer.readUInt32BE(16), height: result.buffer.readUInt32BE(20), sandboxEnabled: true };
  });
}
async function smoke(config, containers, identity, client, check) {
  await ownerChecks(client, check);
  const marker = randomUUID(), fileName = `split-smoke-${marker}.txt`, bytes = Buffer.from(`private-computer split smoke ${marker}\n`);
  const witness = { version: 1, project: config.project, port: config.port, marker, fileName, fileSha256: sha(bytes), containers, identity, limitations: ['Offline demo only: real ACP tool/approval/usage paths are not certified.', 'noVNC modules and raw RFB framebuffer verified; rendered owner web UI is a separate check.', 'Private egress tests use an instrumented local proxy; no external egress request is made.'] };
  await check('workspace-synthetic-sentinel', async () => {
    requireThat((await client.request('/api/files', { method: 'POST', body: { name: fileName, contentBase64: bytes.toString('base64') } })).status === 201, 'Synthetic workspace upload failed.');
    const result = await client.request('/api/files/download?name=' + fileName); requireThat(result.status === 200 && sha(result.buffer) === witness.fileSha256, 'Synthetic workspace checksum differs.');
    requireThat((await client.request('/api/files/download?name=..%2Fowner-password')).status === 400, 'Workspace traversal was accepted.');
    return { fileName, bytes: bytes.length, sha256: witness.fileSha256 };
  });
  await check('fixed-demo-visible-form-and-report', async () => {
    const before = await probe(containers.desktop, 'desktop', 'browser');
    const id = await client.startDemo(); witness.completedRun = id;
    const opened = await poll(async () => { const value = await client.status(); requireThat(value.run?.id === id, 'Demo run identity changed.'); return value.run.steps?.[0]?.status === 'succeeded' && value; });
    requireThat(opened.control.owner === 'automation', 'Demo lost desktop ownership.');
    const tab = await probe(containers.desktop, 'desktop', 'browser');
    const newlyOpened = tab.pages.filter(item => !before.pages.some(old => old.id === item.id));
    requireThat(newlyOpened.length === 1 && newlyOpened[0].fixture, 'Demo must create exactly one fixture tab in the existing Chromium.');
    tab.tabId = newlyOpened[0].id;
    const done = await poll(async () => { const value = await client.status(); requireThat(value.run?.id === id && !['failed', 'cancelled', 'interrupted'].includes(value.run.status), 'Fixed demo failed.'); return value.run.status === 'succeeded' && value.canStart && value; });
    requireThat(done.run.steps.length === 3 && done.run.steps.every(item => item.status === 'succeeded') && done.control.owner === 'human' && done.control.stop?.confirmed === true, 'Fixed demo steps or runner stop confirmation failed.');
    const visible = await probe(containers.desktop, 'desktop', 'browser', { tabId: tab.tabId });
    requireThat(visible.project === '私人云电脑 P0' && visible.result?.includes('已提交') && visible.result.includes('人工接管'), 'The same visible tab did not contain the submitted local form.');
    witness.reportName = `demo-${id}.md`; const report = await client.request('/api/files/download?name=' + witness.reportName);
    requireThat(report.status === 200 && report.buffer.toString('utf8').includes(id), 'Fixed demo report missing or from another run.'); witness.reportSha256 = sha(report.buffer);
    witness.completedRunSha256 = sha(JSON.stringify((await client.request('/api/tasks/' + id)).json.run));
    return { runId: id, tabId: tab.tabId, newTabs: 1, sameTabAtCompletion: true, reportName: witness.reportName, reportSha256: witness.reportSha256, stop: done.control.stop };
  });
  await check('owner-rfb-single-tab-and-takeover', async () => {
    const original = await probe(containers.desktop, 'desktop', 'pointer');
    let viewer; const anchor = { x: 43, y: 47 }, blocked = { x: 345, y: 349 }, after = { x: 449, y: 143 };
    try {
      viewer = await rfbClient(client); const frame = viewer.frame;
      requireThat((await client.upgrade()).status === 409, 'A second owner desktop tab was accepted.');
      viewer.pointer(anchor); await poll(async () => equal(await probe(containers.desktop, 'desktop', 'pointer'), anchor), 4000); viewer.close(); viewer = undefined; await delay(150);
      const id = await client.startDemo(); witness.cancelledRun = id;
      const locked = await client.status(); requireThat(locked.control.owner === 'automation', 'Demo input fence requires active automation ownership.');
      viewer = await rfbClient(client); viewer.pointer(blocked); await delay(250);
      requireThat(equal(await probe(containers.desktop, 'desktop', 'pointer'), anchor), 'RFB human input passed through during automation ownership.');
      requireThat((await client.status()).control.owner === 'automation', 'Automation ended before input blocking was checked.');
      const started = Date.now(); const response = await client.request('/api/control/takeover', { method: 'POST', body: { runId: id } });
      const takeoverResponseMs = Date.now() - started;
      requireThat(response.status === 200, 'Owner takeover request failed.');
      const value = await poll(async () => { const state = await client.status(); return state.run?.id === id && state.run.status === 'cancelled' && state.canStart && state; });
      requireThat(value.control.owner === 'human' && value.control.generation > locked.control.generation && value.control.stop?.confirmed === true && value.control.stop.input === true && Number.isInteger(value.control.stop.runnerGeneration), 'Takeover lacks executing-runner stop evidence.');
      viewer.close(); viewer = undefined; await delay(150); viewer = await rfbClient(client); viewer.pointer(after);
      await poll(async () => equal(await probe(containers.desktop, 'desktop', 'pointer'), after), 4000);
      const steps = value.run.steps.filter(item => item.status === 'succeeded').length; await delay(2200);
      const settled = await client.status(); requireThat(settled.run.id === id && settled.run.status === 'cancelled' && settled.run.steps.filter(item => item.status === 'succeeded').length === steps, 'Revoked demo completed a later step.');
      witness.cancelledRunSha256 = sha(JSON.stringify((await client.request('/api/tasks/' + id)).json.run));
      viewer.pointer(original);
      return { frame, secondOwnerTabStatus: 409, blockedDuringAutomation: true, restoredAfterTakeover: true, ownerReconnectedAfterRevocation: true, takeoverResponseMs, stop: value.control.stop };
    } finally { if (viewer) { try { viewer.pointer(original); } catch {} viewer.close(); } }
  });
  await check('browser-profile-persistence-sentinel', async () => {
    const value = await probe(containers.desktop, 'desktop', 'browser-write', { marker });
    return { localStorageWritten: value.marker === marker, profileFileWritten: true, tabId: value.tabId };
  });
  await check('desktop-role-unauthenticated-runner-fence', () => probe(containers.desktop, 'desktop', 'runner-fence'));
  await check('egress-local-defensive-fixture', () => probe(containers.egress, 'egress', 'egress-fixture'));
  return witness;
}
async function persistence(config, containers, identity, client, check, witness) {
  requireThat(witness.version === 1 && witness.project === config.project && witness.port === config.port, 'Persistence witness belongs to another project or version.');
  await check('same-volume-replacement-identities', async () => {
    for (const role of SERVICES) {
      const before = witness.containers[role], after = containers[role];
      requireThat(before.imageId === after.imageId && equal(before.dataMounts, after.dataMounts) && equal(witness.identity[role].sources, identity[role].sources), 'Recreation changed image/source identity or data volumes.');
      if (role !== 'egress') requireThat(before.id !== after.id, 'Persistence requires actual replacement control and desktop containers.');
    }
    return { controlReplaced: true, desktopReplaced: true, imageAndSourceUnchanged: true, sameDataVolumes: true };
  });
  await check('workspace-and-report-checksums-after-recreation', async () => {
    for (const [name, expected] of [[witness.fileName, witness.fileSha256], [witness.reportName, witness.reportSha256]]) {
      const result = await client.request('/api/files/download?name=' + encodeURIComponent(name)); requireThat(result.status === 200 && sha(result.buffer) === expected, 'A persisted workspace/report checksum differs.');
    }
    return { workspaceSha256: witness.fileSha256, reportSha256: witness.reportSha256, rewritten: false };
  });
  await check('terminal-history-survives-control-recreation', async () => {
    for (const [id, hash] of [[witness.completedRun, witness.completedRunSha256], [witness.cancelledRun, witness.cancelledRunSha256]]) {
      const result = await client.request('/api/tasks/' + id); requireThat(result.status === 200 && sha(JSON.stringify(result.json.run)) === hash, 'Persisted terminal run history changed.');
    }
    return { succeededRun: witness.completedRun, cancelledRun: witness.cancelledRun, exactHistoryChecksums: true, approvalsAndModelUsage: 'not exercised by offline demo' };
  });
  await check('browser-profile-survives-desktop-recreation', async () => {
    const value = await probe(containers.desktop, 'desktop', 'browser-check', { marker: witness.marker });
    return { localStoragePreserved: value.marker === witness.marker, profileFilePreserved: true, rewritten: false };
  });
  if (witness.interruptedRun) await check('unfinished-demo-restarts-interrupted-without-replay', async () => {
    const result = await client.request('/api/tasks/' + witness.interruptedRun);
    requireThat(result.status === 200 && result.json.run?.status === 'interrupted' && !result.json.run.approval, 'Abruptly stopped demo was not marked interrupted with old approvals removed.');
    const value = await client.status(); requireThat(value.canStart && value.control.owner === 'human' && value.control.private === true && value.control.stop?.confirmed === true, 'Restart did not settle in confirmed private human control.');
    const resultFile = await client.request('/api/files/download?name=demo-' + witness.interruptedRun + '.md'); requireThat(resultFile.status === 404, 'Interrupted demo replayed report generation.');
    return { runId: witness.interruptedRun, status: 'interrupted', approvalAbsent: true, reportNotReplayed: true, stop: value.control.stop };
  });
}

export async function selfTest() {
  const { createServer } = await import('../apps/control/src/server.mjs');
  const { createEgressProxy } = await import('../apps/desktop/egress.mjs');
  const { publicTarget } = await import('../apps/desktop/network-policy.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'split-smoke-fixture-')); const checks = [];
  let server; let client;
  const check = async (name, operation) => { await operation(); checks.push(name); };
  try {
    const ownerFile = path.join(directory, 'owner-password'); await writeFile(ownerFile, 'synthetic-owner-fixture-password\n', { mode: 0o600 });
    for (const argv of [[], ['--project', 'private-computer-p0'], ['--self-test', '--phase', 'smoke']]) assert.throws(() => selection(argv)); checks.push('unsafe-selection-rejected');
    const parsed = selection(['--project', 'private-computer-p1-check', '--port', '3187', '--phase', 'smoke', '--owner-password-file', path.join(directory, 'private-computer-p1-check', 'owner-password'), '--evidence-dir', directory]); assert.equal(parsed.port, 3187); checks.push('explicit-selection-accepted');
    await check('container-selection-and-credential-fence-fixtures', async () => {
      const rows = SERVICES.map((service, index) => ({
        Id: String(index + 1).repeat(64), Image: 'sha256:' + String(index + 4).repeat(64), State: { Running: true },
        Config: { Image: service === 'computer' ? 'fixture:acp' : 'fixture:base', Labels: { 'com.docker.compose.project': parsed.project, 'com.docker.compose.service': service }, Env: ['APP_ROLE=' + (service === 'computer' ? 'control' : service), ...(service === 'computer' ? ['MODEL_ENABLED=0', 'MODEL_EXECUTOR=dsh-acp'] : [])] },
        HostConfig: { PortBindings: service === 'computer' ? { '3180/tcp': [{ HostIp: '127.0.0.1', HostPort: String(parsed.port) }] } : {} },
        Mounts: [
          ...(service === 'computer' ? ['owner-password', 'model-key', 'runner-token'] : service === 'desktop' ? ['runner-token'] : []).map(name => ({ Type: 'bind', Source: name === 'owner-password' ? parsed.ownerFile : '/fixture/' + name, Destination: '/run/secrets/' + name })),
          ...(service === 'computer' ? [{ Type: 'volume', Name: parsed.project + '_computer-home', Destination: '/workspace' }, { Type: 'volume', Name: parsed.project + '_control-state', Destination: '/var/lib/private-computer' }] : service === 'desktop' ? [{ Type: 'volume', Name: parsed.project + '_computer-home', Destination: '/home/desktop' }] : []),
        ],
      }));
      assert.equal(Object.keys(validateContainers(rows, parsed)).length, 3);
      const changes = [
        value => { value[0].Config.Labels['com.docker.compose.project'] = 'active-project'; },
        value => { value[0].Config.Env.push('MODEL_ENABLED=1'); },
        value => { value[0].HostConfig.PortBindings['3180/tcp'][0].HostIp = '0.0.0.0'; },
        value => { value[1].Config.Env.push('MODEL_API_KEY=synthetic-fixture'); },
        value => { value[1].Mounts.push({ Source: '/fixture/owner-password', Destination: '/run/secrets/owner-password' }); },
        value => { value[1].Mounts.at(-1).Name = 'active-project_computer-home'; },
        value => { value[0].Mounts[0].Source = '/another-project/owner-password'; },
      ];
      for (const change of changes) { const value = structuredClone(rows); change(value); assert.throws(() => validateContainers(value, parsed)); }
    });
    const runtime = { async inspect() { return { ready: true, browserReady: true, sandboxEnabled: true }; }, async setViewOnly() { return { stopped: true, generation: 1 }; }, async setObservation(enabled) { return { enabled, generation: 1 }; }, async openFixture() {}, async fillAndSubmit() {}, async capture() { const bytes = Buffer.alloc(32); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.writeUInt32BE(1280, 16); bytes.writeUInt32BE(800, 20); return bytes; }, async close() {} };
    const options = { passwordFile: ownerFile, workspaceDir: path.join(directory, 'workspace'), dataDir: path.join(directory, 'control'), runtime, stepDelayMs: 70 };
    const start = async () => { server = await createServer({ ...options, origin: 'http://localhost:3187' }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); client = ownerClient({ port: server.address().port, origin: 'http://localhost:3187' }); await client.login(ownerFile); };
    await start();
    await check('actual-owner-routes-auth-origin', async () => {
      assert.equal((await client.request('/api/status', { auth: false })).status, 401);
      assert.equal((await client.request('/api/demo', { method: 'POST', requestOrigin: null, body: {} })).status, 403);
      assert.equal((await client.upgrade({ auth: false })).status, 401);
      assert.throws(() => client.request('/api/model/test', { method: 'POST', body: {} }));
      assert.throws(() => client.request('/api/tasks', { method: 'POST', body: {} }));
    });
    let id, historyHash, reportHash;
    await check('actual-offline-demo-report-and-history', async () => {
      id = await client.startDemo();
      await poll(async () => { const state = await client.status(); return state.run.status === 'succeeded' && state.canStart; });
      const report = await client.request('/api/files/download?name=demo-' + id + '.md'); assert.equal(report.status, 200); reportHash = sha(report.buffer);
      historyHash = sha(JSON.stringify((await client.request('/api/tasks/' + id)).json.run));
    });
    await check('immediate-next-demo-and-stop-proof', async () => {
      const next = await client.startDemo(); const result = await client.request('/api/control/takeover', { method: 'POST', body: { runId: next } }); assert.equal(result.status, 200);
      const state = await poll(async () => { const value = await client.status(); return value.run.status === 'cancelled' && value.canStart && value; }); assert.equal(state.control.stop.confirmed, true);
    });
    await client.cleanup(); await server.shutdown(); server = undefined;
    await start();
    await check('actual-file-history-process-restart', async () => {
      assert.equal(sha((await client.request('/api/files/download?name=demo-' + id + '.md')).buffer), reportHash);
      assert.equal(sha(JSON.stringify((await client.request('/api/tasks/' + id)).json.run)), historyHash);
    });
    await check('raw-rfb-parser-and-masked-pointer-fixture', async () => {
      const sockets = new Set(); let pointer;
      const fixture = http.createServer();
      fixture.on('upgrade', (request, socket) => {
        sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
        const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        const init = Buffer.alloc(24); init.writeUInt16BE(4, 0); init.writeUInt16BE(2, 2);
        const rectangle = Buffer.alloc(12); rectangle.writeUInt16BE(4, 4); rectangle.writeUInt16BE(2, 6);
        const pixels = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 19) % 256));
        const bytes = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1]), Buffer.alloc(4), init, Buffer.from([0, 0, 0, 1]), rectangle, pixels]);
        // Fragment the RFB byte stream across websocket frames, as websockify can.
        socket.write(Buffer.concat([Buffer.from([0x02, 7]), bytes.subarray(0, 7), Buffer.from([0x80, bytes.length - 7]), bytes.subarray(7)]));
        let received = Buffer.alloc(0);
        socket.on('data', chunk => {
          received = Buffer.concat([received, chunk]);
          while (received.length >= 6) {
            const length = received[1] & 127; if (length >= 126 || received.length < length + 6) return;
            const payload = Buffer.from(received.subarray(6, 6 + length)), mask = received.subarray(2, 6);
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
            if ((received[1] & 128) && payload.length === 6 && payload[0] === 5) pointer = { x: payload.readUInt16BE(2), y: payload.readUInt16BE(4) };
            received = received.subarray(6 + length);
          }
        });
      });
      await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
      let viewer;
      try {
        viewer = await rfbClient(ownerClient({ port: fixture.address().port }));
        assert.equal(viewer.frame.rawPixels, 8); assert.equal(viewer.frame.sampledColors, 8);
        viewer.pointer({ x: 1, y: 1 }); await poll(() => pointer, 2000); assert.deepEqual(pointer, { x: 1, y: 1 });
      } finally { viewer?.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => fixture.close(resolve)); }
    });
    await check('exact-role-egress-fixture-no-outbound-dials', async () => {
      const value = await roleProbe({ operation: 'egress-fixture', root });
      assert.equal(value.upstreamDials, 0); assert.equal(value.dnsLookups, 0); assert.equal(value.results.length, 8); assert.equal(value.metadataConnectStatus, 403);
    });
    await check('private-policy-zero-dns-fixture', async () => {
      let dns = 0;
      for (const target of ['http://169.254.169.254/', 'http://10.0.0.1/', 'http://[::1]/', 'http://127.0.0.1/']) await assert.rejects(publicTarget(target, { resolve: async () => { dns++; throw new Error('DNS must not run.'); } }));
      assert.equal(dns, 0);
      const proxy = createEgressProxy(); await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
      try { const result = await new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port: proxy.address().port, path: 'http://127.0.0.1/' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end(); }); assert.equal(result, 403); }
      finally { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
    });
    return { ok: true, phase: 'local-fixture', checks, modelRequests: 0, limitation: 'Injected desktop runtime and local proxy; not live containers, Chromium, noVNC or RFB.' };
  } finally { if (client) await client.cleanup(); if (server) await server.shutdown(); await rm(directory, { recursive: true, force: true }); }
}

async function main() {
  const config = selection(process.argv.slice(2));
  if (config.help) { process.stdout.write(HELP); return; }
  if (config.selfTest) { console.log(JSON.stringify(await selfTest(), null, 2)); return; }
  const checks = []; let stage = 'isolated-container-identity', client, failure, witness, leaveRun = false;
  const check = async (name, operation) => { stage = name; const started = Date.now(); const detail = await operation(); checks.push({ name, ok: true, elapsedMs: Date.now() - started, ...(detail ? { detail } : {}) }); return detail; };
  let containers, identity;
  try {
    containers = await check('isolated-container-identity', () => inspect(config));
    identity = await check('source-version-and-role-identity', () => identities(containers));
    await mkdir(config.evidenceDir, { recursive: true, mode: 0o700 });
    client = ownerClient(config); stage = 'isolated-owner-login'; await client.login(config.ownerFile);
    if (config.phase === 'smoke') {
      witness = await smoke(config, containers, identity, client, check);
      await writeFile(path.join(config.evidenceDir, 'split-witness.json'), JSON.stringify(witness, null, 2) + '\n', { mode: 0o600 });
    } else if (config.phase === 'persistence' || config.phase === 'prepare-restart') {
      witness = parseJson(await readFile(path.join(config.evidenceDir, 'split-witness.json'), 'utf8'));
      requireThat(witness.project === config.project && witness.port === config.port, 'Witness belongs to another isolated project.');
      if (config.phase === 'persistence') await persistence(config, containers, identity, client, check, witness);
      else {
        requireThat(equal(containers, witness.containers), 'Prepare-restart requires the exact smoke containers.');
        const state = await client.status(); requireThat(state.canStart && state.control.owner === 'human' && state.control.private === false, 'Isolated desktop must be idle before the interruption rehearsal.');
        await check('prepare-owned-unfinished-demo', async () => { witness.interruptedRun = await client.startDemo(); await writeFile(path.join(config.evidenceDir, 'split-witness.json'), JSON.stringify(witness, null, 2) + '\n', { mode: 0o600 }); leaveRun = true; return { runId: witness.interruptedRun, deliberatelyLeftRunning: true }; });
      }
    } else {
      await check('desktop-role-unauthenticated-runner-fence', () => probe(containers.desktop, 'desktop', 'runner-fence'));
      await check('egress-local-defensive-fixture', () => probe(containers.egress, 'egress', 'egress-fixture'));
    }
  } catch (error) { failure = { stage, message: error instanceof assert.AssertionError ? 'A fixed verifier assertion failed.' : error.message }; process.exitCode = 1; }
  finally { await client?.cleanup(leaveRun); }
  const report = { ok: !failure, phase: config.phase, project: config.project, port: config.port, at: new Date().toISOString(), verifierSha256: sha(await readFile(fileURLToPath(import.meta.url))), checks, modelRequests: 0, externalRequests: 0, limitations: witness?.limitations || ['Offline fixed demo only; real ACP, approvals, model usage, rendered owner UI and public egress need separate explicit acceptance.'], ...(failure ? { error: failure } : {}) };
  if (identity) await writeFile(path.join(config.evidenceDir, `split-${config.phase}.json`), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }).catch(() => {});
  console.log(JSON.stringify(report, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch { console.error(JSON.stringify({ ok: false, phase: 'configuration', error: 'Invalid verifier selection or unavailable local fixture; use --help. No raw configuration or credentials were printed.' })); process.exitCode = 1; }
}
