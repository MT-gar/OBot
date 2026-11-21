import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export class ModelError extends Error {
  constructor(code, message, status) { super(message); this.name = 'ModelError'; this.code = code; if (status) this.status = status; }
}
export function responsesEndpoint(baseUrl, allowInsecureLocalhost = false) {
  const url = new URL(baseUrl);
  const localTest = allowInsecureLocalhost && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if ((!localTest && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) throw new Error('Provider configuration requires a credential-free HTTPS URL.');
  let pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/responses')) pathname += pathname.endsWith('/v1') ? '/responses' : '/v1/responses';
  url.pathname = pathname;
  return url;
}
async function readKey(file) {
  if (!file) return null;
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4096) throw new Error('Invalid provider credential file.');
    const value = (await handle.readFile('utf8')).trim();
    if (!value) return null;
    if (value.length < 20 || /\s/.test(value)) throw new Error('Invalid provider credential format.');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Provider credential configuration could not be read.'); }
  finally { await handle?.close(); }
}
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function usageOf(value) {
  const inputTokens = integer(value?.input_tokens);
  const outputTokens = integer(value?.output_tokens);
  const totalTokens = integer(value?.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  return { inputTokens, outputTokens, totalTokens, reasoningTokens: integer(value?.output_tokens_details?.reasoning_tokens), usageIncomplete: inputTokens === null || outputTokens === null || totalTokens === null };
}
function providerError(status, value) {
  const upstreamCode = /^[a-z_]{1,64}$/.test(value?.error?.code || '') ? value.error.code : null;
  if (status === 403 && upstreamCode === 'client_not_allowed') return new ModelError('client_not_allowed', '模型网关未授权当前应用客户端（403 client_not_allowed）；请在服务商侧开放标准 Responses 自定义应用访问。', 403);
  if (status === 401) return new ModelError('provider_authentication_failed', '模型服务拒绝了凭据，请在本地私密配置中检查密钥。', 401);
  if (status === 429) return new ModelError('provider_rate_limited', '模型服务限流或额度不足；本次请求没有自动重试。', 429);
  return new ModelError(upstreamCode || 'provider_request_rejected', `模型服务拒绝请求（HTTP ${status}）；未输出上游原始错误或凭据。`, status);
}
async function readBody(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw new ModelError('provider_empty_response', '模型服务返回了空响应。');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw new ModelError('provider_response_too_large', '模型服务响应超过本地大小上限。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}
function decodeResponse(text, contentType) {
  if (!contentType.includes('text/event-stream')) {
    try { return JSON.parse(text); } catch { throw new ModelError('provider_invalid_json', '模型服务返回了无效的 Responses JSON。'); }
  }
  let finalResponse;
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data.trim() === '[DONE]') continue;
    let event;
    try { event = JSON.parse(data); } catch { throw new ModelError('provider_invalid_stream', '模型事件流包含无效数据。'); }
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) finalResponse = event.response;
    if (event.type === 'error') throw new ModelError('provider_stream_error', '模型事件流报告错误；本次执行已停止。');
  }
  if (!finalResponse) throw new ModelError('provider_stream_interrupted', '模型事件流未完整结束；不会执行不完整工具调用。');
  return finalResponse;
}

/** A small Responses-native Interface. Credentials remain private to this closure. */
export async function createResponsesModel(config = {}) {
  const endpoint = responsesEndpoint(config.baseUrl || process.env.MODEL_BASE_URL || 'https://api.xingchiapi.com', config.allowInsecureLocalhost === true);
  const model = config.model || process.env.MODEL_NAME || 'gpt-6.1-sol';
  const reasoningEffort = config.reasoningEffort || process.env.MODEL_EFFORT || 'max';
  if (!/^[a-zA-Z0-9_.:/-]{1,120}$/.test(model) || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) throw new Error('Invalid model configuration.');
  const key = await readKey(config.keyFile || process.env.MODEL_API_KEY_FILE);
  const requestTimeoutMs = config.requestTimeoutMs ?? 120000;
  const fetchImpl = config.fetchImpl || fetch;
  let verified = false;
  let lastErrorCode = null;
  return {
    metadata() { return { configured: Boolean(key), protocol: 'responses', model, reasoningEffort, baseUrl: endpoint.origin, verified, lastErrorCode }; },
    async respond({ input, tools = [], signal, maxOutputTokens = 8192 }) {
      if (!key) throw new ModelError('model_not_configured', '尚未配置模型凭据，请通过本地私密配置导入。', 503);
      if (!Array.isArray(input) || !Array.isArray(tools) || tools.length > 24 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32768) throw new ModelError('model_invalid_request', '本地模型请求参数无效。');
      const requestSignal = AbortSignal.any([AbortSignal.timeout(requestTimeoutMs), ...(signal ? [signal] : [])]);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST', redirect: 'error', signal: requestSignal,
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, store: false, stream: true, reasoning: { effort: reasoningEffort }, include: ['reasoning.encrypted_content'],
            parallel_tool_calls: false, max_output_tokens: maxOutputTokens, input, ...(tools.length ? { tools } : {}) }),
        });
        const text = await readBody(response, 8 * 1024 * 1024);
        if (text.includes(key)) throw new ModelError('provider_sensitive_response', '模型服务返回了敏感配置内容，响应已被本地拦截。');
        if (!response.ok) {
          let value; try { value = JSON.parse(text); } catch {}
          throw providerError(response.status, value);
        }
        const value = decodeResponse(text, response.headers.get('content-type') || 'application/json');
        if (value.error) throw providerError(response.status, value);
        if (value.status && value.status !== 'completed') throw new ModelError('model_response_incomplete', '模型未完整完成本轮响应；不会执行部分工具参数。');
        if (!Array.isArray(value.output)) throw new ModelError('provider_invalid_response', '模型服务未返回 Responses output 列表。');
        const outputText = value.output.filter(item => item.type === 'message' && (!item.role || item.role === 'assistant')).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text || '').join('\n');
        verified = true; lastErrorCode = null;
        return { output: value.output, outputText, usage: usageOf(value.usage), requestId: /^[a-zA-Z0-9_-]{1,120}$/.test(value.id || '') ? value.id : null };
      } catch (error) {
        if (signal?.aborted) {
          const cancelled = new ModelError('model_cancelled', '模型请求已取消；已发生但尚未报告的用量可能未知。'); cancelled.name = 'AbortError'; throw cancelled;
        }
        if (error instanceof ModelError) { lastErrorCode = error.code; throw error; }
        lastErrorCode = requestSignal.aborted ? 'provider_timeout' : 'provider_connection_failed';
        throw new ModelError(lastErrorCode, requestSignal.aborted ? '模型请求超时；没有自动重试或继续执行工具。' : '无法连接模型服务；未输出请求头或凭据。');
      }
    },
  };
}
