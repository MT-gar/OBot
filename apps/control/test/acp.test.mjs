import test from 'node:test';
import assert from 'node:assert/strict';
import { acpProviderEndpoint } from '../src/acp.mjs';

for (const [input, expected] of [
  ['https://provider.example', 'https://provider.example/v1'],
  ['https://provider.example/', 'https://provider.example/v1'],
  ['https://provider.example///', 'https://provider.example/v1'],
  ['https://provider.example/v1', 'https://provider.example/v1'],
  ['https://provider.example/v1/', 'https://provider.example/v1'],
  ['https://provider.example/gateway/', 'https://provider.example/gateway/v1'],
]) {
  test('ACP provider base URL normalizes ' + input, () => {
    const endpoint = acpProviderEndpoint(input);
    assert.equal(endpoint.href, expected);
    assert.equal(endpoint.href + '/responses', expected + '/responses');
  });
}

test('ACP provider URL rejects credentials, query strings and insecure protocols', () => {
  for (const input of ['http://provider.example', 'https://user:secret@provider.example', 'https://provider.example?key=secret', 'https://provider.example#fragment']) {
    assert.throws(() => acpProviderEndpoint(input));
  }
});
