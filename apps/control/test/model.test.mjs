import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createResponsesModel, responsesEndpoint } from '../src/model.mjs';

async function fixture(t, handler) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pc-model-test-'));
  const key = 'test-only-not-a-real-provider-key-123456789';
  const keyFile = path.join(dir, 'key'); await writeFile(keyFile, key, { mode: 0o600 });
  const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { key, keyFile, baseUrl: `http://127.0.0.1:${server.address().port}`, allowInsecureLocalhost: true };
}
const complete = (output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'READY' }] }]) => ({ id: 'resp_test', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 7, total_tokens: 17, output_tokens_details: { reasoning_tokens: 3 } } });

test('normalizes Responses endpoints and rejects unsafe configuration', () => {
  assert.equal(responsesEndpoint('https://provider.example').pathname, '/v1/responses');
  assert.equal(responsesEndpoint('https://provider.example/v1/').pathname, '/v1/responses');
  assert.equal(responsesEndpoint('https://provider.example/v1/responses').pathname, '/v1/responses');
  for (const url of ['http://provider.example', 'https://key@provider.example', 'https://provider.example?key=secret']) assert.throws(() => responsesEndpoint(url));
});
test('missing credential is configured=false and never makes a provider request', async () => {
  const model = await createResponsesModel({ baseUrl: 'https://provider.example', keyFile: '/nonexistent-private-computer-test-key' });
  assert.equal(model.metadata().configured, false);
  await assert.rejects(model.respond({ input: [] }), { code: 'model_not_configured' });
});
test('sends Responses-native tools, store=false and exact max effort without downgrade', async t => {
  let body;
  const config = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(complete()));
  });
  const model = await createResponsesModel(config);
  const result = await model.respond({ input: [{ role: 'user', content: 'connection test' }], tools: [{ type: 'function', name: 'workspace_list', parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: true }], maxOutputTokens: 256 });
  assert.equal(body.model, 'gpt-6.1-sol'); assert.equal(body.reasoning.effort, 'max'); assert.equal(body.store, false); assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.tools[0].type, 'function'); assert.equal(body.max_output_tokens, 256);
  assert.equal(result.outputText, 'READY'); assert.equal(result.usage.totalTokens, 17); assert.equal(model.metadata().verified, true);
  assert.ok(!JSON.stringify(model.metadata()).includes(config.key));
});
test('parses split SSE completed response and preserves opaque output only in return value', async t => {
  const opaque = { type: 'reasoning', id: 'rs_test', encrypted_content: 'opaque-test-value', summary: [] };
  const config = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: response.completed\r\ndata: ');
    res.end(JSON.stringify({ type: 'response.completed', response: complete([opaque, { type: 'function_call', call_id: 'call_test', name: 'workspace_list', arguments: '{}' }]) }) + '\r\n\r\ndata: [DONE]\r\n\r\n');
  });
  const model = await createResponsesModel(config); const result = await model.respond({ input: [] });
  assert.equal(result.output[0].encrypted_content, 'opaque-test-value'); assert.equal(result.outputText, '');
});
test('provider access restriction is surfaced safely, with no retry or raw body leak', async t => {
  let requests = 0;
  const config = await fixture(t, (_req, res) => { requests++; res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'client_not_allowed', message: 'PRIVATE-DIAGNOSTIC-MUST-NOT-LEAK' } })); });
  const model = await createResponsesModel(config);
  await assert.rejects(model.respond({ input: [] }), error => error.code === 'client_not_allowed' && error.status === 403 && !error.message.includes('PRIVATE-DIAGNOSTIC'));
  assert.equal(requests, 1); assert.equal(model.metadata().verified, false); assert.equal(model.metadata().lastErrorCode, 'client_not_allowed');
});
test('blocks sensitive echoes, incomplete output and broken streams', async t => {
  const config = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(complete([{ type: 'message', content: [{ type: 'output_text', text: 'test-only-not-a-real-provider-key-123456789' }] }]))); });
  const model = await createResponsesModel(config); await assert.rejects(model.respond({ input: [] }), { code: 'provider_sensitive_response' });
  const incomplete = await createResponsesModel({ ...config, fetchImpl: async () => new Response(JSON.stringify({ ...complete(), status: 'incomplete' }), { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(incomplete.respond({ input: [] }), { code: 'model_response_incomplete' });
  const interrupted = await createResponsesModel({ ...config, fetchImpl: async () => new Response('data: {"type":"response.created"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) });
  await assert.rejects(interrupted.respond({ input: [] }), { code: 'provider_stream_interrupted' });
});
test('cancellation aborts the in-flight model request and does not retry', async t => {
  let requests = 0;
  const config = await fixture(t, (_req, _res) => { requests++; });
  const model = await createResponsesModel(config); const abort = new AbortController();
  const result = model.respond({ input: [], signal: abort.signal }); setTimeout(() => abort.abort(), 40);
  await assert.rejects(result, error => error.name === 'AbortError' && error.code === 'model_cancelled'); assert.equal(requests, 1);
});
