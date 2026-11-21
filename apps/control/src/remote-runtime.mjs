import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const READ_TOOLS = new Set(['desktop_screenshot', 'browser_snapshot']);
const validCapability = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validGeneration = value => Number.isSafeInteger(value) && value > 0;
const validTtl = value => Number.isSafeInteger(value) && value > 0 && value <= 30000;
const revoked = () => new DOMException('Desktop control was revoked.', 'AbortError');

export async function createRemoteRuntime(options = {}) {
  const base = new URL(options.baseUrl || process.env.DESKTOP_RUNNER_URL || 'http://desktop:3181');
  if (base.protocol !== 'http:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Invalid private runner URL.');
  const keyFile = options.tokenFile || process.env.RUNNER_TOKEN_FILE;
  if (!keyFile) throw new Error('RUNNER_TOKEN_FILE is required.');
  const handle = await open(keyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let token;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4096) throw new Error('Invalid runner credential.');
    token = (await handle.readFile('utf8')).trim();
  } finally { await handle.close(); }
  if (token.length < 24 || /\s/.test(token)) throw new Error('Invalid runner credential.');

  let input = null;
  let observation = null;
  let inputEpoch = 0;
  let observationEpoch = 0;
  let inputChanges = Promise.resolve();
  let observationChanges = Promise.resolve();
  let closing;

  async function request(route, body, { signal, assertLease, assertObservation, binary = false, lease, observe } = {}) {
    if (signal?.aborted) throw revoked();
    assertLease?.();
    if (observe) assertObservation?.('desktop');
    const response = await fetch(new URL(route, base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        ...(lease ? { 'X-Desktop-Lease': lease } : {}), ...(observe ? { 'X-Desktop-Observation': observe } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      if (response.status === 409) throw revoked();
      throw new Error('The private desktop runner rejected an operation.');
    }
    const result = binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
    if (binary && result.length > 12 * 1024 * 1024) throw new Error('Desktop image exceeded its limit.');
    if (signal?.aborted) throw revoked();
    assertLease?.();
    if (observe) assertObservation?.('desktop');
    return result;
  }

  function dropInput() {
    const old = input;
    input = null;
    clearTimeout(old?.timer);
    old?.signal?.removeEventListener('abort', old.onAbort);
    old?.abort.abort();
  }
  function loseInput(current) {
    if (input !== current) return;
    dropInput();
    current.onLeaseLost?.();
  }
  function dropObservation() {
    const old = observation;
    observation = null;
    old?.abort.abort();
  }
  function keepAlive(current) {
    const remaining = current.expires - performance.now();
    const delay = Math.max(1, Math.floor(Math.min(current.ttlMs, remaining) / 3));
    current.timer = setTimeout(async () => {
      if (closing || input !== current) return;
      const started = performance.now();
      if (started >= current.expires) { loseInput(current); return; }
      try {
        const signal = AbortSignal.any([current.abort.signal, AbortSignal.timeout(Math.max(1, Math.ceil(current.expires - started)))]);
        const proof = await request('/view-only/renew', { generation: current.generation }, { signal, lease: current.token });
        if (closing || input !== current) return;
        if (proof.generation !== current.generation || !validTtl(proof.ttlMs)) throw revoked();
        current.ttlMs = proof.ttlMs;
        current.expires = started + proof.ttlMs;
        keepAlive(current);
      } catch { loseInput(current); }
    }, delay);
    current.timer.unref();
  }

  function changeInput(enabled, settings = {}) {
    const epoch = ++inputEpoch;
    dropInput();
    const change = inputChanges.then(async () => {
      if (enabled && (epoch !== inputEpoch || settings.signal?.aborted)) throw revoked();
      const started = performance.now();
      const proof = await request('/view-only', { value: enabled }, { signal: enabled ? settings.signal : undefined });
      if (epoch !== inputEpoch || !validGeneration(proof.generation)) throw revoked();
      if (!enabled) {
        if (proof.stopped !== true) throw new Error('Desktop runner did not confirm that old input stopped.');
        return { stopped: true, generation: proof.generation };
      }
      if (!validCapability(proof.lease) || !validTtl(proof.ttlMs)) throw new Error('Desktop runner did not grant a control lease.');
      const expires = started + proof.ttlMs;
      if (settings.signal?.aborted || performance.now() >= expires) throw revoked();
      const current = {
        token: proof.lease, generation: proof.generation, ttlMs: proof.ttlMs,
        expires, abort: new AbortController(),
        signal: settings.signal, onLeaseLost: settings.onLeaseLost,
        onAbort: () => { if (input === current) dropInput(); },
      };
      input = current;
      current.signal?.addEventListener('abort', current.onAbort, { once: true });
      keepAlive(current);
      return { generation: proof.generation };
    });
    inputChanges = change.catch(() => {});
    return change;
  }

  function changeObservation(enabled, settings = {}) {
    const epoch = ++observationEpoch;
    dropObservation();
    const change = observationChanges.then(async () => {
      if (enabled && epoch !== observationEpoch) throw revoked();
      const proof = await request('/observation', { enabled }, { signal: enabled ? settings.signal : undefined });
      if (epoch !== observationEpoch || !validGeneration(proof.generation)) throw revoked();
      if (enabled) {
        if (!validCapability(proof.observation)) throw new Error('Desktop runner did not grant observation.');
        observation = { token: proof.observation, abort: new AbortController() };
      } else if (proof.observation !== null) {
        throw new Error('Desktop runner did not confirm observation revocation.');
      }
      return { enabled, generation: epoch };
    });
    observationChanges = change.catch(() => {});
    return change;
  }

  function checkOpen() { if (closing) throw new Error('Desktop connection is closed.'); }
  async function inputRequest(route, body, settings = {}) {
    checkOpen();
    if (input && performance.now() >= input.expires) loseInput(input);
    const current = input;
    if (!current) throw new Error('Desktop input lease is missing.');
    const signal = AbortSignal.any([current.abort.signal, ...(settings.signal ? [settings.signal] : [])]);
    try { return await request(route, body, { ...settings, signal, lease: current.token }); }
    catch (error) {
      if (error.name === 'AbortError' && !signal.aborted) loseInput(current);
      throw error;
    }
  }

  return {
    async inspect() {
      try { checkOpen(); return await request('/inspect', {}); }
      catch { return { ready: false, browserReady: false, sandboxEnabled: false }; }
    },
    async setViewOnly(enabled, settings) { checkOpen(); return changeInput(enabled, settings); },
    async setObservation(enabled, settings) { checkOpen(); return changeObservation(enabled, settings); },
    async openFixture({ url, ...settings }) { return inputRequest('/fixture/open', { url }, settings); },
    async fillAndSubmit(settings) { return inputRequest('/fixture/fill', {}, settings); },
    async capture({ signal } = {}) { checkOpen(); return request('/screenshot', {}, { signal, binary: true }); },
    async performTool(name, args, settings = {}) {
      checkOpen();
      if (!READ_TOOLS.has(name)) return inputRequest('/tool', { name, args }, settings);
      const current = observation;
      if (!current) throw new Error('Desktop observation grant is missing.');
      const signal = AbortSignal.any([current.abort.signal, ...(settings.signal ? [settings.signal] : [])]);
      return request('/tool', { name, args }, { ...settings, signal, observe: current.token });
    },
    async close() {
      closing ??= Promise.allSettled([changeInput(false), changeObservation(false)]);
      await closing;
    },
  };
}
