import http from 'node:http';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createGuestRuntime } from '../control/src/runtime.mjs';
import { createDesktopTools } from './tools.mjs';

const digest = value => createHash('sha256').update(value).digest();
const INPUTS = new Set(['desktop_click', 'desktop_type', 'desktop_key', 'desktop_scroll', 'browser_navigate', 'browser_click', 'browser_type']);
const OBSERVATIONS = new Set(['desktop_screenshot', 'browser_snapshot']);
async function credential(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat(); if (!info.isFile() || info.size > 4096) throw new Error('Invalid private runner credential.');
    const token = (await handle.readFile('utf8')).trim(); if (token.length < 24 || /\s/.test(token)) throw new Error('Invalid private runner credential.');
    return token;
  } finally { await handle.close(); }
}
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new Error('Invalid request.');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 32768) throw new Error('Request too large.'); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.');
  return value;
}
export async function createRunnerServer(options = {}) {
  const token = options.token || await credential(options.tokenFile || process.env.RUNNER_TOKEN_FILE);
  const fixtureOrigin = options.fixtureOrigin || process.env.INTERNAL_CONTROL_ORIGIN || 'http://control:3180';
  const runtime = options.runtime || createGuestRuntime({ fixtureOrigin, cdpUrl: options.cdpUrl });
  const tools = options.tools || createDesktopTools(runtime, { fixtureOrigin, cdpUrl: options.cdpUrl });
  const fixture = new URL('/fixture', fixtureOrigin).href;
  const ttlMs = options.leaseTtlMs ?? 5000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 30000) throw new Error('Invalid desktop lease TTL.');
  let generation = 0;
  let lease = null;
  let observation = null;
  let observationGeneration = 0;
  let changes = Promise.resolve();
  let closing = false;
  let uncertainInput = false;
  const inFlight = new Set();

  function changeObservation(enabled) {
    const generation = ++observationGeneration;
    observation?.abort.abort();
    tools.resetBrowserRefs?.();
    observation = enabled ? { token: randomBytes(32).toString('hex'), abort: new AbortController() } : null;
    return { observation: observation?.token ?? null, generation };
  }

  function activeLease() {
    if (lease && performance.now() >= lease.expires) changeInputMode(false).catch(() => {});
    return lease;
  }
  function extend(current) {
    clearTimeout(current.timer);
    current.expires = performance.now() + ttlMs;
    const expire = () => {
      if (lease !== current || !activeLease()) return;
      current.timer = setTimeout(expire, Math.ceil(current.expires - performance.now()));
      current.timer.unref();
    };
    current.timer = setTimeout(expire, ttlMs);
    current.timer.unref();
  }
  function changeInputMode(enabled, signal) {
    const epoch = ++generation;
    const old = lease;
    lease = null;
    // A fresh snapshot taken while the owner had input is eligible for the next grant.
    // Snapshots taken during a previous input lease cannot cross its revocation.
    if (old || !enabled) tools.resetBrowserRefs?.();
    if (old) {
      clearTimeout(old.timer);
      old.abort.abort();
    }
    const operation = changes.then(async () => {
      await Promise.allSettled(inFlight);
      if (uncertainInput) throw new Error('Old desktop input could not be confirmed stopped.');
      if (epoch !== generation) return null;
      if (enabled && (closing || signal?.aborted)) return null;
      await runtime.setViewOnly(enabled);
      if (epoch !== generation) return null;
      if (!enabled) return { stopped: true, generation: epoch };
      if (closing || signal?.aborted) {
        changeInputMode(false).catch(() => {});
        return null;
      }
      lease = { token: randomBytes(32).toString('hex'), generation: epoch, abort: new AbortController() };
      extend(lease);
      return { lease: lease.token, generation: epoch, ttlMs };
    });
    changes = operation.catch(() => {});
    return operation;
  }

  function valid(req) {
    const value = req.headers.authorization || '';
    return value.startsWith('Bearer ') && value.length <= 5000 && timingSafeEqual(digest(value.slice(7)), digest(token));
  }
  const send = (res, status, value) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); } };
  const server = http.createServer({ requestTimeout: 20000, headersTimeout: 10000, maxHeaderSize: 8192 }, async (req, res) => {
    const requestAbort = new AbortController();
    res.on('close', () => requestAbort.abort());
    try {
      const url = new URL(req.url, 'http://desktop');
      if (url.pathname === '/healthz' && req.method === 'GET') {
        const state = await runtime.inspect(); return send(res, state.ready && state.browserReady ? 200 : 503, { ok: state.ready && state.browserReady });
      }
      if (!valid(req)) return send(res, 401, { error: 'Private runner authentication required.' });
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
      const value = await body(req);
      if (closing || requestAbort.signal.aborted) return send(res, 409, { error: 'Control changed.' });
      if (url.pathname === '/inspect') return send(res, 200, await runtime.inspect());
      if (url.pathname === '/observation') {
        if (typeof value.enabled !== 'boolean') return send(res, 400, { error: 'A boolean observation mode is required.' });
        return send(res, 200, changeObservation(value.enabled));
      }
      if (url.pathname === '/view-only') {
        if (typeof value.value !== 'boolean') return send(res, 400, { error: 'A boolean mode is required.' });
        try {
          const result = await changeInputMode(value.value, requestAbort.signal);
          return result ? send(res, 200, result) : send(res, 409, { error: 'Control changed.' });
        } catch { return send(res, 503, { error: 'Desktop input state could not be confirmed.' }); }
      }
      if (url.pathname === '/view-only/renew') {
        const current = activeLease();
        if (!current || req.headers['x-desktop-lease'] !== current.token || value.generation !== current.generation) return send(res, 409, { error: 'Active desktop lease required.' });
        extend(current);
        return send(res, 200, { generation: current.generation, ttlMs });
      }
      const input = url.pathname.startsWith('/fixture/') || (url.pathname === '/tool' && INPUTS.has(value.name));
      const read = url.pathname === '/tool' && OBSERVATIONS.has(value.name);
      const expected = input ? activeLease() : read ? observation : null;
      function assertGrant() {
        const current = input ? activeLease() : observation;
        const header = input ? 'x-desktop-lease' : 'x-desktop-observation';
        if (!expected || current !== expected || req.headers[header] !== expected.token || requestAbort.signal.aborted) {
          throw new DOMException('Control revoked.', 'AbortError');
        }
      }
      if (input || read) assertGrant();
      const signal = expected ? AbortSignal.any([requestAbort.signal, expected.abort.signal]) : requestAbort.signal;
      function markInputUncertain() {
        if (uncertainInput) return;
        uncertainInput = true;
        changeInputMode(false).catch(() => {});
      }
      const settings = input ? { signal, assertLease: assertGrant, markInputUncertain }
        : read ? { signal, assertObservation: assertGrant } : { signal };
      async function dispatch(action) {
        if (!input) {
          const result = await action();
          if (read) assertGrant();
          return result;
        }
        const operation = Promise.resolve().then(() => { assertGrant(); return action(); });
        inFlight.add(operation);
        try { const result = await operation; assertGrant(); return result; }
        finally { inFlight.delete(operation); }
      }
      if (url.pathname === '/fixture/open') {
        if (value.url !== fixture) return send(res, 400, { error: 'Only the fixed internal fixture is allowed.' });
        await dispatch(() => runtime.openFixture({ url: fixture, ...settings }));
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/fixture/fill') {
        await dispatch(() => runtime.fillAndSubmit(settings));
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/screenshot') {
        const bytes = await runtime.capture(settings); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); return res.end(bytes);
      }
      if (url.pathname === '/tool') {
        if (!input && !read) return send(res, 400, { error: 'Unknown tool.' });
        const result = await dispatch(() => tools.performTool(value.name, value.args, settings));
        return send(res, 200, result);
      }
      send(res, 404, { error: 'Not found.' });
    } catch (error) {
      send(res, error.name === 'AbortError' || requestAbort.signal.aborted ? 409 : 400, { error: 'Desktop operation failed or control was revoked.' });
    }
  });
  server.shutdown = async () => {
    closing = true;
    changeObservation(false);
    const stop = changeInputMode(false).catch(() => {});
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await Promise.all([stop, closed]);
  };
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = await createRunnerServer();
    server.listen(Number(process.env.RUNNER_PORT || 3181), process.env.RUNNER_HOST || '0.0.0.0', () => console.log('Private desktop runner started.'));
    let stopping = false;
    const stop = async () => { if (!stopping) { stopping = true; await server.shutdown(); } };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } catch { console.error('Private runner could not start; check its local credential and runtime configuration.'); process.exitCode = 1; }
}
