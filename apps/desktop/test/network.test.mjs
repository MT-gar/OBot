import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { publicAddress, publicTarget } from '../network-policy.mjs';
import { createEgressProxy } from '../egress.mjs';

test('network policy blocks private, mapped, metadata and non-web targets', async () => {
  for (const value of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(publicAddress(value), false, value);
  assert.equal(publicAddress('1.1.1.1'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const value of ['file:///etc/passwd', 'http://localhost', 'http://2130706433', 'https://user:pass@example.com', 'https://example.com:22']) await assert.rejects(publicTarget(value));
  await assert.rejects(publicTarget('https://public.example', { resolve: async () => [{ address: '169.254.169.254', family: 4 }] }));
  const target = await publicTarget('https://public.example/path', { resolve: async () => [{ address: '1.1.1.1', family: 4 }] }); assert.equal(target.address, '1.1.1.1');
});
test('only exact fixed fixture is exempted; syntax-only is reserved for proxy-isolated workers', async () => {
  assert.equal((await publicTarget('http://control:3180/fixture', { fixtureOrigin: 'http://control:3180' })).fixture, true);
  await assert.rejects(publicTarget('http://control:3180/api/status', { fixtureOrigin: 'http://control:3180' }));
  assert.equal((await publicTarget('https://public.example', { syntaxOnly: true, resolve: () => { throw Error('must not resolve here'); } })).proxyRequired, true);
  await assert.rejects(publicTarget('http://127.0.0.1', { syntaxOnly: true }));
});
test('egress proxy rejects private HTTP and CONNECT before opening a socket', async t => {
  const proxy = createEgressProxy(); await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  const port = proxy.address().port;
  const status = await new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, path: 'http://169.254.169.254/latest', headers: { Host: '169.254.169.254' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(status, 403);
  const connectStatus = await new Promise((resolve, reject) => { const socket = net.connect(port, '127.0.0.1', () => socket.write('CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n')); socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('proxy timeout')); }); socket.on('error', reject); socket.once('data', bytes => { resolve(bytes.toString('utf8').split('\r\n')[0]); socket.destroy(); }); });
  assert.match(connectStatus, /403/);
});
