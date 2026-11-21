// Explicit paid test of the real DSH adapter; ordinary test/CI runs never invoke it.
import { createDshAcpExecutor } from '../apps/control/src/acp.mjs';
import { writeFile } from 'node:fs/promises';
if (!process.argv.includes('--live')) { console.error('Use --live only for an owner-authorized real provider test.'); process.exit(2); }
const prefix = process.env.DSH_PRIVATE_ROOT || '/root/.local/share/private-computer-dsh';
const executor = await createDshAcpExecutor({ nodeExecutable: prefix + '/node_modules/node/bin/node', entry: prefix + '/node_modules/@deepseek-ai/dsh/lib/bin.js', keyFile: process.env.MODEL_API_KEY_FILE || '/root/.local/state/private-computer-p0/model-key', workRoot: '/root/.local/state/private-computer-acp-test-runs' });
let result;
try {
  const tested = await executor.test({ signal: AbortSignal.timeout(120000) });
  const readyAnswer = tested.outputText?.trim() === 'READY';
  const ok = tested.ok === true && readyAnswer && tested.usage?.unknown === false;
  result = { ok, runtime: 'real DSH ACP', model: tested.model, reasoningEffort: tested.reasoningEffort, readyAnswer, usage: tested.usage };
  if (!ok) process.exitCode = 1;
} catch (error) { result = { ok: false, code: error.code || 'test_failed', error: error.message }; process.exitCode = 1; }
await writeFile('.local/evidence/acp-adapter-live.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
