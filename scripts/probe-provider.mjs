// Explicit, bounded owner connection test. Never prints credentials or raw errors.
import { readFile } from 'node:fs/promises';
const base = new URL(process.env.MODEL_BASE_URL || 'https://api.xingchiapi.com');
if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('An HTTPS provider origin is required.');
const endpoint = new URL(base);
endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + (endpoint.pathname.replace(/\/$/, '').endsWith('/v1') ? '/responses' : '/v1/responses');
let key = (await readFile(process.env.MODEL_API_KEY_FILE || '/root/.local/state/private-computer-p0/model-key', 'utf8')).trim();
const model = process.env.MODEL_NAME || 'gpt-6.1-sol';
const effort = process.env.MODEL_EFFORT || 'max';
let summary;
try {
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, store: false, stream: false, reasoning: { effort }, max_output_tokens: 1024,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply exactly READY. This is a harmless connection test; do not call tools.' }] }] }),
  });
  const raw = await response.text();
  let result; try { result = JSON.parse(raw); } catch {}
  if (!result && raw.includes('data:')) {
    for (const frame of raw.split(/\r?\n\r?\n/)) {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      try { const event = JSON.parse(data); if (event.type === 'response.completed' || event.type === 'response.incomplete') result = event.response; } catch {}
    }
  }
  const text = (result?.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text || '').join('');
  const safeNumber = value => Number.isFinite(value) && value >= 0 ? value : null;
  summary = { ok: response.ok && text.trim() === 'READY', httpStatus: response.status, endpoint: endpoint.href, model, reasoningEffort: effort,
    responseStatus: ['completed', 'incomplete', 'failed'].includes(result?.status) ? result.status : null,
    readyAnswer: text.trim() === 'READY',
    usage: { inputTokens: safeNumber(result?.usage?.input_tokens), outputTokens: safeNumber(result?.usage?.output_tokens), reasoningTokens: safeNumber(result?.usage?.output_tokens_details?.reasoning_tokens) } };
  if (!response.ok) {
    const message = String(result?.error?.message || '');
    summary.reasoningValuesMentioned = [...new Set(message.match(/\b(?:none|minimal|low|medium|high|xhigh|max)\b/g) || [])];
    summary.errorCode = /^[a-z_]{1,64}$/.test(result?.error?.code || '') ? result.error.code : 'provider_request_rejected';
  }
} catch (error) {
  summary = { ok: false, endpoint: endpoint.href, model, reasoningEffort: effort, errorCode: ['TimeoutError', 'AbortError'].includes(error.name) ? 'provider_timeout' : 'provider_connection_failed' };
} finally { key = undefined; }
console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exitCode = 1;
