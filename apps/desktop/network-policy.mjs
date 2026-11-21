import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && [0, 2].includes(c)))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?::|0{1,4}:|db8:|0{0,2}1[0-9a-f]:)/i.test(address) && !/^2002:/i.test(address);
  return false;
}
export async function publicTarget(value, { fixtureOrigin, resolve = lookup, syntaxOnly = false } = {}) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Only credential-free HTTP(S) destinations are allowed.');
  if (fixtureOrigin && url.origin === new URL(fixtureOrigin).origin) {
    if (url.pathname !== '/fixture' || url.search) throw new Error('Only the exact internal fixture is allowed.');
    return { url, fixture: true };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (![80, 443].includes(port) || hostname === 'localhost' || /\.(?:localhost|local|internal)$/i.test(hostname) || (!isIP(hostname) && !hostname.includes('.'))) throw new Error('Private destinations or unsupported ports are forbidden.');
  // An isolated desktop has no direct public route; its proxy performs pinned DNS validation.
  if (syntaxOnly && !isIP(hostname)) return { url, hostname, port, proxyRequired: true };
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Destination resolved to a non-public address.');
  return { url, hostname, port, address: addresses.find(item => item.family === 4)?.address || addresses[0].address, family: addresses.find(item => item.family === 4)?.family || addresses[0].family };
}
