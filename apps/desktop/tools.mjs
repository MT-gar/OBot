import { randomBytes } from 'node:crypto';
import { cdpConnection, createBrowserTab, runCommand } from '../control/src/runtime.mjs';
import { publicTarget } from './network-policy.mjs';

export function createDesktopTools(runtime, options = {}) {
  const display = options.display || process.env.DISPLAY || ':99';
  const base = new URL(options.cdpUrl || process.env.BROWSER_CDP_URL || 'http://127.0.0.1:9222');
  const fixtureOrigin = options.fixtureOrigin || process.env.INTERNAL_CONTROL_ORIGIN || 'http://control:3180';
  const run = options.runDesktopCommand || runCommand;
  const namespace = randomBytes(8).toString('hex');
  let pageId;
  let snapshot;
  let nextVersion = 0;
  let referenceEpoch = 0;

  function invalidateRefs() { referenceEpoch++; snapshot = null; }
  function resetBrowserRefs() { invalidateRefs(); pageId = undefined; }
  function check(settings) {
    if (settings.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    settings.assertLease?.();
    settings.assertObservation?.();
  }
  function command(args, settings) {
    check(settings);
    return run('xdotool', args, { ...settings, env: { ...process.env, DISPLAY: display } });
  }
  async function pages(signal) {
    const response = await fetch(new URL('/json/list', base), {
      signal: AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]), redirect: 'error',
    });
    if (!response.ok) throw new Error('Browser is unavailable.');
    return response.json();
  }
  async function page(settings, create = false) {
    check(settings);
    const all = await pages(settings.signal);
    let target = all.find(item => item.type === 'page' && item.id === pageId) || all.find(item => item.type === 'page');
    if (!target && create) target = await createBrowserTab(base, settings);
    if (!target) throw new Error('No browser page is available.');
    check(settings);
    pageId = target.id;
    const endpoint = new URL(target.webSocketDebuggerUrl);
    if (endpoint.protocol !== 'ws:' || !['localhost', '127.0.0.1'].includes(endpoint.hostname) || endpoint.port !== base.port || endpoint.username || endpoint.password) throw new Error('Invalid private browser endpoint.');
    return { target, cdp: await cdpConnection(endpoint.href, settings.signal, settings.markInputUncertain) };
  }
  async function world(cdp, settings) {
    const guard = () => check(settings);
    const tree = await cdp.send('Page.getFrameTree', {}, guard);
    return (await cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: `private-computer-tools-${namespace}` }, guard)).executionContextId;
  }
  async function evaluate(cdp, expression, contextId, settings, input = false) {
    const send = input ? cdp.sendInput : cdp.send;
    const value = await send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true }, () => check(settings));
    if (value.exceptionDetails) throw new Error('The current page or reference changed. Observe it again.');
    return value.result?.value;
  }
  function browserTarget(url) {
    return publicTarget(url, { fixtureOrigin, syntaxOnly: Boolean(process.env.BROWSER_PROXY_URL) });
  }

  return {
    resetBrowserRefs,
    async performTool(name, args = {}, settings = {}) {
      check(settings);
      if (name === 'desktop_screenshot') {
        const bytes = await runtime.capture(settings);
        check(settings);
        if (bytes.length < 24 || bytes.toString('ascii', 1, 4) !== 'PNG') throw new Error('Invalid desktop screenshot.');
        return { imageBase64: bytes.toString('base64'), mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
      }
      if (name === 'desktop_click') {
        if (!Number.isInteger(args.x) || !Number.isInteger(args.y) || args.x < 0 || args.y < 0 || args.x >= 1280 || args.y >= 800 || !['left', 'right', 'double'].includes(args.button)) throw new Error('Click is outside the fixed desktop.');
        await command(['mousemove', '--sync', String(args.x), String(args.y)], settings);
        await command(['click', ...(args.button === 'double' ? ['--repeat', '2', '--delay', '80'] : []), args.button === 'right' ? '3' : '1'], settings);
        return { ok: true };
      }
      if (name === 'desktop_type') {
        if (typeof args.text !== 'string' || !args.text.length || args.text.length > 4096 || args.text.includes('\0')) throw new Error('Invalid text input.');
        await command(['type', '--clearmodifiers', '--delay', '1', '--', args.text], settings);
        return { ok: true };
      }
      if (name === 'desktop_key') {
        if (typeof args.key !== 'string' || !/^(?:(?:ctrl|alt|shift)\+){0,3}(?:[a-z0-9]|enter|return|tab|esc|escape|backspace|delete|space|up|down|left|right|home|end|pageup|pagedown|f[1-9]|f1[0-2])$/i.test(args.key)) throw new Error('Unsupported key.');
        const names = { enter: 'Return', return: 'Return', tab: 'Tab', esc: 'Escape', escape: 'Escape', backspace: 'BackSpace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next' };
        const chord = args.key.toLowerCase().split('+').map(key => names[key] || (/^f\d+$/.test(key) ? key.toUpperCase() : key)).join('+');
        await command(['key', '--clearmodifiers', chord], settings);
        return { ok: true };
      }
      if (name === 'desktop_scroll') {
        if (!['up', 'down'].includes(args.direction) || !Number.isInteger(args.amount) || args.amount < 1 || args.amount > 10) throw new Error('Invalid scroll.');
        await command(['click', '--repeat', String(args.amount), '--delay', '80', args.direction === 'up' ? '4' : '5'], settings);
        return { ok: true };
      }
      if (!['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type'].includes(name)) throw new Error('Unknown desktop tool.');
      if (name === 'browser_navigate') {
        const destination = await browserTarget(args.url);
        const { cdp } = await page(settings, true);
        try {
          const guard = () => check(settings);
          await cdp.send('Page.enable', {}, guard);
          await cdp.sendInput('Page.bringToFront', {}, guard);
          invalidateRefs();
          const result = await cdp.sendInput('Page.navigate', { url: destination.url.href }, guard);
          if (result.errorText) throw new Error('Browser navigation failed.');
          return { ok: true, url: destination.url.href };
        } finally { cdp.close(); }
      }
      const scope = referenceEpoch;
      const version = name === 'browser_snapshot' ? ++nextVersion : null;
      const selected = snapshot;
      const { target, cdp } = await page(settings);
      try {
        await browserTarget(target.url);
        check(settings);
        if (name === 'browser_snapshot') {
          const contextId = await world(cdp, settings);
          const prefix = `r${namespace}-${version}-`;
          const result = await evaluate(cdp, `(() => {
            const version = ${version};
            const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')].filter(e => {
              const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0;
            }).slice(0, 100);
            const refs = new Map();
            const elements = nodes.map((e, i) => {
              const ref = ${JSON.stringify(prefix)} + i;
              refs.set(ref, e);
              return { ref, tag: e.tagName.toLowerCase(), text: (e.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').slice(0, 200), type: e.getAttribute('type') || '', label: (e.labels?.[0]?.innerText || '').slice(0, 200), href: e.tagName === 'A' ? e.href : undefined };
            });
            if ((globalThis.__privateComputerElements?.version ?? 0) < version) globalThis.__privateComputerElements = { version, refs };
            return { url: location.href, title: document.title.slice(0, 300), text: (document.body?.innerText || '').slice(0, 16000), elements };
          })()`, contextId, settings);
          check(settings);
          if (scope !== referenceEpoch || (snapshot && snapshot.version >= version) || result?.url !== target.url) throw new Error('A fresh page snapshot is required.');
          snapshot = { contextId, pageId: target.id, url: target.url, version, refs: new Set(result.elements.map(element => element.ref)) };
          return result;
        }
        const assertReference = () => {
          if (!selected || selected !== snapshot || selected.pageId !== target.id || selected.url !== target.url || !selected.refs.has(args.ref)) throw new Error('A fresh page snapshot is required.');
          settings.assertLease?.();
        };
        assertReference();
        if (name === 'browser_type' && (typeof args.text !== 'string' || args.text.length > 4096 || args.text.includes('\0'))) throw new Error('Invalid field typing.');
        const ref = JSON.stringify(args.ref);
        const bounds = await evaluate(cdp, `(() => { const map=globalThis.__privateComputerElements; const e=map?.version===${selected.version}?map.refs.get(${ref}):null; if(!e?.isConnected)throw Error('stale'); if(${name === 'browser_type'}&&e.type==='password')throw Error('password'); e.scrollIntoView({block:'center',inline:'center',behavior:'instant'});const r=e.getBoundingClientRect();if(r.width<=0||r.height<=0)throw Error('hidden');e.focus();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`, selected.contextId, { ...settings, assertLease: assertReference }, true);
        if (name === 'browser_click') {
          await cdp.sendInput('Input.dispatchMouseEvent', { type: 'mousePressed', x: bounds.x, y: bounds.y, button: 'left', clickCount: 1 }, assertReference);
          try {
            await cdp.sendInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bounds.x, y: bounds.y, button: 'left', clickCount: 1 }, assertReference);
          } catch (error) {
            // An acknowledged press without a confirmed release can leave the button down.
            settings.markInputUncertain?.();
            throw error;
          }
        } else {
          await cdp.sendInput('Input.insertText', { text: args.text }, assertReference);
        }
        return { ok: true };
      } finally { cdp.close(); }
    },
  };
}
