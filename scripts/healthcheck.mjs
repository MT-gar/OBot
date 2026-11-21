import { connect } from 'node:net';
function ready(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(700, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}
async function get(url, headers = {}) { const response = await fetch(url, { headers, signal: AbortSignal.timeout(1800) }); return response.ok; }
try {
  const role = process.env.APP_ROLE || 'p0';
  let ok;
  if (role === 'egress') ok = await ready(3128);
  else if (role === 'desktop') ok = await get('http://127.0.0.1:3181/healthz');
  else if (role === 'control') {
    const origin = new URL(process.env.APP_ORIGIN || 'http://localhost:3180');
    ok = (await Promise.all([get('http://127.0.0.1:3180/healthz', { host: origin.host }), get(new URL('/healthz', process.env.DESKTOP_RUNNER_URL || 'http://desktop:3181'))])).every(Boolean);
  } else {
    const origin = new URL(process.env.APP_ORIGIN || 'http://localhost:3180');
    ok = (await Promise.all([get('http://127.0.0.1:3180/healthz', { host: origin.host }), get('http://127.0.0.1:9222/json/version'), ready(5900), ready(6081)])).every(Boolean);
  }
  process.exitCode = ok ? 0 : 1;
} catch { process.exitCode = 1; }
