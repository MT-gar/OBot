import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { publicTarget } from './network-policy.mjs';

/** Public HTTP(S) egress only. Resolve once and dial the validated address. */
export function createEgressProxy({ resolveTarget = publicTarget } = {}) {
  const server = http.createServer({ requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (req, res) => {
    let upstream;
    try {
      const target = await resolveTarget(req.url);
      if (target.url.protocol !== 'http:' || target.fixture) throw new Error('Not a public HTTP destination.');
      const headers = { ...req.headers, host: target.url.host };
      for (const name of ['proxy-authorization', 'proxy-connection', 'connection', 'upgrade']) delete headers[name];
      upstream = http.request({ hostname: target.address, family: target.family, port: target.port, method: req.method, path: target.url.pathname + target.url.search, headers }, response => {
        const responseHeaders = { ...response.headers }; delete responseHeaders['proxy-authenticate'];
        res.writeHead(response.statusCode || 502, responseHeaders); response.pipe(res);
      });
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Public egress request failed.'); });
      req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy());
      let received = 0;
      req.on('data', chunk => { received += chunk.length; if (received > 16 * 1024 * 1024) { upstream.destroy(); res.destroy(); } });
      req.pipe(upstream);
    } catch { upstream?.destroy(); res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Private or unsupported destination blocked.'); }
  });
  server.on('connect', async (req, socket, head) => {
    let upstream;
    socket.on('error', () => upstream?.destroy());
    try {
      if (!/^[a-zA-Z0-9.[\]:-]{1,300}$/.test(req.url || '')) throw new Error('Invalid CONNECT authority.');
      const target = await resolveTarget(`https://${req.url}`);
      if (target.port !== 443 || target.fixture) throw new Error('Only public TLS port 443 is supported.');
      upstream = net.connect({ host: target.address, family: target.family, port: target.port });
      const timer = setTimeout(() => { upstream.destroy(); socket.destroy(); }, 10000);
      upstream.once('connect', () => {
        clearTimeout(timer); socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(socket).pipe(upstream);
      });
      upstream.setTimeout(120000, () => upstream.destroy()); socket.setTimeout(120000, () => socket.destroy());
      upstream.on('error', () => { clearTimeout(timer); socket.destroy(); }); upstream.on('close', () => socket.destroy()); socket.on('close', () => { clearTimeout(timer); upstream.destroy(); });
    } catch { upstream?.destroy(); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
  });
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createEgressProxy();
  server.listen(Number(process.env.EGRESS_PORT || 3128), '0.0.0.0', () => console.log('Public-only browser egress proxy started.'));
  process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
}
