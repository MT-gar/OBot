import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { readFile, readdir } from 'node:fs/promises';

function aborted() { const error = new Error('Operation cancelled.'); error.name = 'AbortError'; return error; }
function assertActive(signal, assertLease) { if (signal?.aborted) throw aborted(); assertLease?.(); }

// Internal commands only. There is deliberately no HTTP endpoint for commands or CDP evaluation.
export function runCommand(command, args, { signal, assertLease, markInputUncertain, timeoutMs = 5000, maxBytes = 2 * 1024 * 1024, env = process.env } = {}) {
  assertActive(signal, assertLease);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, detached: process.platform !== 'win32', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let size = 0;
    let failure;
    let killTimer;
    const chunks = [];
    function kill() {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {}
      killTimer ??= setTimeout(() => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} }, 300);
      killTimer.unref();
    }
    function onAbort() { failure = aborted(); kill(); }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => { failure = new Error('Desktop command timed out.'); kill(); }, timeoutMs);
    timer.unref();
    child.stdout.on('data', chunk => { size += chunk.length; if (size > maxBytes) { failure = new Error('Desktop command output limit exceeded.'); kill(); } else chunks.push(chunk); });
    child.stderr.on('data', chunk => { size += chunk.length; if (size > maxBytes) { failure = new Error('Desktop command output limit exceeded.'); kill(); } });
    function cleanup() { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', onAbort); }
    child.on('error', error => { failure ??= error; });
    child.on('close', code => {
      cleanup();
      // A killed X input process may have left requests buffered in the server.
      // Process exit by itself does not confirm those requests were consumed.
      if (child.pid && code !== 0) markInputUncertain?.();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error('Desktop command failed.'));
      else resolve(Buffer.concat(chunks));
    });
  });
}
function portReady(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(600, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
async function sandboxEnabled() {
  // Report true only with evidence from an actual renderer. Unknown is false.
  try {
    const entries = await readdir('/proc');
    let rendererSandbox = false;
    let unsafeFlag = false;
    for (const pid of entries.filter(name => /^\d+$/.test(name))) {
      try {
        // Chromium may rewrite its process title into argv[0], including spaces.
        const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
        if (!/(?:^|\/)chromium(?=$|[\s/-])/.test(command)) continue;
        if (/(?:^|\s)--(?:no-sandbox|disable-seccomp-filter-sandbox|disable-namespace-sandbox)(?=\s|$)/.test(command)) unsafeFlag = true;
        if (/(?:^|\s)--type=renderer(?=\s|$)/.test(command)) {
          const status = await readFile(`/proc/${pid}/status`, 'utf8');
          const filters = /^Seccomp_filters:\s+(\d+)$/m.exec(status);
          // Require a renderer filter in addition to the container's filter.
          if (/^NoNewPrivs:\s+1$/m.test(status) && /^Seccomp:\s+2$/m.test(status) && Number(filters?.[1]) >= 2) rendererSandbox = true;
        }
      } catch { /* Process may have exited. */ }
    }
    return rendererSandbox && !unsafeFlag;
  } catch { return false; }
}

export function cdpConnection(url, signal, markInputUncertain) {
  assertActive(signal);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    let established = false;
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Browser connection timed out.')); }, 4000);
    timeout.unref();

    function settle(id, error, result, unknown = false) {
      const item = pending.get(id);
      if (!item) return;
      pending.delete(id);
      clearTimeout(item.timer);
      if (unknown && item.input) markInputUncertain?.();
      if (error) item.reject(error);
      else item.resolve(result);
    }
    const abort = () => {
      // A sent CDP input can still execute after local cancellation. Keep its
      // connection alive until the browser acknowledges it or reports failure.
      for (const [id, item] of pending) if (!item.input) settle(id, aborted());
      if (!pending.size) ws.close();
      if (!established) reject(aborted());
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    ws.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      settle(message.id, message.error ? new Error('Browser rejected a fixed action.') : null, message.result ?? {});
    });
    ws.addEventListener('error', () => { if (!established) reject(new Error('Browser connection failed.')); });
    ws.addEventListener('close', () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      for (const id of pending.keys()) settle(id, new Error('Browser connection closed.'), undefined, true);
      if (!established) reject(new Error('Browser connection closed.'));
    });
    function send(method, params, assertLease, input) {
      assertActive(signal, assertLease);
      return new Promise((res, rej) => {
        const id = nextId++;
        const timer = setTimeout(() => settle(id, new Error('Browser action timed out.'), undefined, true), 5000);
        timer.unref();
        pending.set(id, { resolve: res, reject: rej, timer, input });
        try { ws.send(JSON.stringify({ id, method, params })); }
        catch (error) { settle(id, error, undefined, true); }
      });
    }
    ws.addEventListener('open', () => {
      established = true;
      clearTimeout(timeout);
      resolve({
        send: (method, params = {}, assertLease) => send(method, params, assertLease, false),
        sendInput: (method, params = {}, assertLease) => send(method, params, assertLease, true),
        close() { signal?.removeEventListener('abort', abort); ws.close(); },
      });
    }, { once: true });
  });
}

export async function createBrowserTab(base, { signal, assertLease, markInputUncertain } = {}) {
  assertActive(signal, assertLease);
  let target;
  try {
    // Chromium can create a tab after the caller disconnects. Wait for its reply.
    const response = await fetch(new URL('/json/new?about:blank', base), {
      method: 'PUT', signal: AbortSignal.timeout(2500), redirect: 'error',
    });
    if (!response.ok) throw new Error('Could not open the browser tab.');
    target = await response.json();
    if (typeof target?.id !== 'string') throw new Error('Browser tab creation was not confirmed.');
  } catch (error) {
    markInputUncertain?.();
    throw error;
  }
  assertActive(signal, assertLease);
  return target;
}

export function createGuestRuntime({
  display = process.env.DISPLAY ?? ':99',
  cdpUrl = process.env.BROWSER_CDP_URL ?? 'http://127.0.0.1:9222',
  vncWsPort = Number(process.env.VNC_WS_PORT ?? 6081),
  fixtureOrigin = process.env.INTERNAL_CONTROL_ORIGIN,
  runDesktopCommand = runCommand,
} = {}) {
  if (!/^:\d+(?:\.\d+)?$/.test(display)) throw new Error('DISPLAY must identify a local X display.');
  const base = new URL(cdpUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.username || base.password) throw new Error('CDP must use an HTTP loopback address.');
  if (!Number.isInteger(vncWsPort) || vncWsPort < 1 || vncWsPort > 65535) throw new Error('Invalid VNC websocket port.');
  let pageId;
  let lastInspection = { at: 0, value: null };
  let input = null;
  let observation = null;
  let generation = 0;
  let observationGeneration = 0;
  let inputChanges = Promise.resolve();
  let uncertainInput = false;
  let closing;
  let desktopTools;
  const inFlight = new Set();

  function changeInput(enabled, { signal } = {}) {
    const epoch = ++generation;
    const old = input;
    input = null;
    if (old || !enabled) desktopTools?.resetBrowserRefs();
    old?.abort();
    const operation = inputChanges.then(async () => {
      await Promise.allSettled(inFlight);
      if (uncertainInput) throw new Error('Old desktop input could not be confirmed stopped.');
      if (epoch !== generation || (enabled && closing)) throw aborted();
      if (enabled) assertActive(signal);
      await runDesktopCommand('x11vnc', ['-display', display, '-sync', '-remote', enabled ? 'viewonly' : 'noviewonly'], { timeoutMs: 4000 });
      if (epoch !== generation) throw aborted();
      if (!enabled) return { stopped: true, generation: epoch };
      if (signal?.aborted) {
        changeInput(false).catch(() => {});
        throw aborted();
      }
      const grant = new AbortController();
      input = grant;
      signal?.addEventListener('abort', () => {
        if (input === grant) changeInput(false).catch(() => {});
      }, { once: true, signal: grant.signal });
      return { generation: epoch };
    });
    inputChanges = operation.catch(() => {});
    return operation;
  }

  async function withInput(settings, action) {
    const current = input;
    function assertLease() {
      if (!current || current !== input || closing) throw aborted();
      assertActive(settings.signal, settings.assertLease);
    }
    assertLease();
    const signal = AbortSignal.any([current.signal, ...(settings.signal ? [settings.signal] : [])]);
    const markInputUncertain = () => {
      if (!uncertainInput) {
        uncertainInput = true;
        changeInput(false).catch(() => {});
      }
      settings.markInputUncertain?.();
    };
    const operation = Promise.resolve().then(() => {
      assertLease();
      return action({ ...settings, signal, assertLease, markInputUncertain });
    });
    inFlight.add(operation);
    try { const result = await operation; assertLease(); return result; }
    finally { inFlight.delete(operation); }
  }

  function changeObservation(enabled) {
    observation?.abort();
    desktopTools?.resetBrowserRefs();
    observation = enabled ? new AbortController() : null;
    return { enabled, generation: ++observationGeneration };
  }

  async function cdpJson(route, { signal } = {}) {
    assertActive(signal);
    const response = await fetch(new URL(route, base), { signal: AbortSignal.any([AbortSignal.timeout(2500), ...(signal ? [signal] : [])]), redirect: 'error' });
    if (!response.ok) throw new Error('Browser is unavailable.');
    return response.json();
  }
  function validateWs(value) {
    const url = new URL(value);
    if (url.protocol !== 'ws:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== base.port || url.username || url.password) throw new Error('Unexpected browser endpoint.');
    return url.href;
  }
  async function pageConnection(signal, markInputUncertain) {
    const pages = await cdpJson('/json/list', { signal });
    const target = pages.find(page => page.type === 'page' && page.id === pageId);
    if (!target) throw new Error('The demo browser tab is no longer available.');
    return cdpConnection(validateWs(target.webSocketDebuggerUrl), signal, markInputUncertain);
  }
  const adapter = {
    async inspect() {
      if (Date.now() - lastInspection.at < 750 && lastInspection.value) return lastInspection.value;
      const [ready, browserReady, sandbox] = await Promise.all([
        Promise.all([portReady(vncWsPort), portReady(5900)]).then(ports => ports.every(Boolean)),
        cdpJson('/json/version').then(info => Boolean(info.webSocketDebuggerUrl)).catch(() => false),
        sandboxEnabled(),
      ]);
      const value = { ready, browserReady, sandboxEnabled: sandbox };
      lastInspection = { at: Date.now(), value };
      return value;
    },
    async setViewOnly(enabled, settings) {
      if (closing) throw aborted();
      return changeInput(enabled, settings);
    },
    async setObservation(enabled, { signal } = {}) {
      if (closing) throw aborted();
      if (enabled) assertActive(signal);
      return changeObservation(enabled);
    },
    async openFixture({ url, ...settings }) {
      return withInput(settings, async active => {
        const { signal, assertLease, markInputUncertain } = active;
        // Create a tab in the existing headed Chromium.
        const created = await createBrowserTab(base, active);
        pageId = created.id;
        const cdp = await cdpConnection(validateWs(created.webSocketDebuggerUrl), signal, markInputUncertain);
        try {
          await cdp.send('Page.enable', {}, assertLease);
          await cdp.sendInput('Page.bringToFront', {}, assertLease);
          const result = await cdp.sendInput('Page.navigate', { url }, assertLease);
          if (result.errorText) throw new Error('Fixture navigation failed.');
        } finally { cdp.close(); }
      });
    },
    async fillAndSubmit(settings = {}) {
      return withInput(settings, async ({ signal, assertLease, markInputUncertain }) => {
        const cdp = await pageConnection(signal, markInputUncertain);
        try {
          // Constant local fixture expression.
          const origins = fixtureOrigin ? [new URL(fixtureOrigin).origin] : ['http://localhost:3180', 'http://127.0.0.1:3180'];
          const expression = `(() => { if (location.pathname !== '/fixture' || !${JSON.stringify(origins)}.includes(location.origin)) throw new Error('Not the local fixture'); const name = document.querySelector('#project'); const note = document.querySelector('#note'); const form = document.querySelector('#demo-form'); if (!name || !note || !form) throw new Error('Fixture not ready'); name.value = '私人云电脑 P0'; name.dispatchEvent(new Event('input', {bubbles:true})); note.value = '人工接管可随时中止后续步骤'; note.dispatchEvent(new Event('input', {bubbles:true})); form.requestSubmit(); return document.querySelector('#result').textContent; })()`;
          const result = await cdp.sendInput('Runtime.evaluate', { expression, returnByValue: true }, assertLease);
          if (result.exceptionDetails || !result.result?.value?.includes('已提交')) throw new Error('Fixture form did not complete.');
        } finally { cdp.close(); }
      });
    },
    async capture({ signal } = {}) {
      return runDesktopCommand('import', ['-display', display, '-window', 'root', 'png:-'], { signal, maxBytes: 12 * 1024 * 1024, timeoutMs: 5000 });
    },
    async performTool(name, args, settings = {}) {
      async function dispatch(active) {
        if (!desktopTools) {
          const { createDesktopTools } = await import('../../desktop/tools.mjs');
          const origin = fixtureOrigin ?? `http://127.0.0.1:${process.env.APP_PORT || 3180}`;
          desktopTools ??= createDesktopTools(adapter, { display, cdpUrl, fixtureOrigin: origin, runDesktopCommand });
        }
        return desktopTools.performTool(name, args, active);
      }
      if (name !== 'desktop_screenshot' && name !== 'browser_snapshot') return withInput(settings, dispatch);
      const current = observation;
      const assertObservation = () => {
        if (!current || observation !== current || closing) throw aborted();
        assertActive(settings.signal, settings.assertLease);
        settings.assertObservation?.('desktop');
      };
      assertObservation();
      const signal = AbortSignal.any([current.signal, ...(settings.signal ? [settings.signal] : [])]);
      const result = await dispatch({ signal, assertObservation });
      assertObservation();
      return result;
    },
    async close() {
      if (!closing) {
        changeObservation(false);
        closing = changeInput(false).catch(() => {});
      }
      await closing;
    },
  };
  return adapter;
}
