export const name = 'private-computer-acp-policy';
export const inject = ['agents', 'sessions', 'llm'];

export function apply(ctx) {
  const origin = new URL(process.env.PRIVATE_COMPUTER_POLICY_URL);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') throw new Error('Policy must use a loopback address.');
  const token = process.env.PRIVATE_COMPUTER_POLICY_TOKEN;
  if (!token || token.length < 24) throw new Error('Private policy capability is missing.');
  const outputCap = Number(process.env.PRIVATE_COMPUTER_MAX_OUTPUT_TOKENS || 8192);
  if (!Number.isSafeInteger(outputCap) || outputCap < 1 || outputCap > 8192) throw new Error('Invalid private output cap.');
  let tail = Promise.resolve();
  async function send(event, signal) {
    const response = await fetch(origin, { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]) });
    if (!response.ok) throw new Error('Private computer task budget or lease was revoked.');
    return response.json();
  }
  ctx.on('agent/created', async ({ agent }) => { agent.options.maxTokens = outputCap; });
  ctx.on('agent/pre-step', async (payload, next) => {
    await tail;
    const policy = await send({ type: 'prepare-model' }, payload.signal);
    // Must change AgentOptions before prepareCall binds its immutable controls.
    payload.agent.options.maxTokens = Math.min(outputCap, policy.maxOutputTokens, policy.remainingTokens);
    return next();
  });
  ctx.on('llm/stream', (options, next) => (async function* () {
    await tail;
    options.signal?.throwIfAborted();
    // The final host waterfall runs after model preparation and prompt assembly.
    // Check the already-bound cap; never rewrite prepared request controls here.
    await send({ type: 'before-model', maxOutputTokens: options.maxTokens }, options.signal);
    options.signal?.throwIfAborted();
    for await (const chunk of next()) {
      options.signal?.throwIfAborted();
      await send({ type: 'model-egress' }, options.signal);
      options.signal?.throwIfAborted();
      yield chunk;
    }
  })());
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return;
    const usage = event.type === 'assistant/message' ? event.data?.usage : undefined;
    const finish = event.type === 'assistant/attempt' && Array.isArray(event.data?.stream)
      ? event.data.stream.findLast(record => record.type === 'chunk' && record.chunk?.type === 'finish')?.chunk
      : undefined;
    const code = finish?.reason?.kind === 'error' ? finish.reason.failure?.code : undefined;
    const failureCode = ['TRANSPORT', 'AUTH', 'TIMEOUT'].includes(code) ? code : undefined;
    const safe = { type: 'model-usage', event: String(event.seq), usage: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, reasoningTokens: usage.reasoningTokens } : null, ...(failureCode ? { failureCode } : {}) };
    tail = tail.then(() => send(safe));
    tail.catch(() => { try { ctx.agents.get(session.header.id)?.cancel({ kind: 'user' }); } catch {} });
  });
  ctx.on('dispose', async () => { await tail.catch(() => {}); });
}
