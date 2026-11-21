#!/usr/bin/env node
// Paid integration smoke: nothing contacts Docker, owner HTTP, or a model without --live.
// Use a disposable Compose project and its own volumes. This never creates/removes projects,
// reads a model key, invokes DSH directly, restores files, or approves arbitrary model actions.
import http from 'node:http';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const HELP = `Usage (Node >=22; paid, owner-authorized integration test):
  node scripts/verify-acp-tasks.mjs --live \\
    --origin http://127.0.0.1:43180 --project acp-smoke-unique123 \\
    --owner-password-file /absolute/local/owner-password \\
    --expect-executor dsh-acp --expect-model gpt-6.1-sol --expect-effort max

Required: all six value flags above, plus --live. There is no default origin or
password path. Only localhost/127.0.0.1, explicit ports >=1024 other than 3180,
and dedicated acp-smoke-* Compose projects are allowed. Start an isolated copy
of deploy/compose/compose.yaml yourself with that project, port, and fresh
project-owned volumes. All three services must be running. The initial owner
workspace and task history must be empty. The Docker context must use a local
unix/npipe socket; DOCKER_HOST overrides are refused.

Optional: --request-timeout-ms 8000 (1000..15000), --run-timeout-ms 240000
(10000..300000), --max-run-tokens 50000 (128..50000). Server limits must also
be <=12 combined steps, 300000ms, 50000 tokens, and 8192 output tokens/call.
The configured route must be DSH ACP, xingchi/gpt-6.1-sol/max, with provider
origin https://api.xingchiapi.com. No provider configuration is changed.

A2: seed one unique synthetic inventory .txt through owner HTTP; run exactly
two consecutive related workspace-only tasks, list/read/stage the exact file,
approve each exact write once, verify complete staged text/hash/diff, reject
stale/duplicate approvals and stale acceptance, accept the selected artifact,
verify live text/hash, and check idempotent duplicate acceptance. Usage is
checked per run (input already includes cache reads/writes) and aggregated.
Unexpected actions, existing data, identity drift, unknown usage, or budgets
fail closed and cancel only this invocation's own active run. No retries of
login, task launch, or approvals. SIGINT/SIGTERM also trigger bounded cleanup.

Only synthetic fixture data is sent to the configured provider. A sanitized
JSON report goes to stdout; credentials, cookies, response bodies, provider
messages, and model output are never printed. The fixture, history, artifacts,
and recovery records remain in the isolated project for inspection; remove
that disposable project yourself. This script has no desktop mode.
Without --live, it exits 2 before any I/O. --help exits 0 without I/O.
`;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const CAPS = { maxSteps: 12, maxDurationMs: 300000, maxTokens: 50000, maxOutputTokens: 8192 };
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'paused']);
const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
class VerificationError extends Error { constructor(code) { super(code); this.code = code; } }
function check(condition, code) { if (!condition) throw new VerificationError(code); }
function sameKeys(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function numeric(value, fallback, min, max) {
  if (value === undefined) return fallback;
  check(/^\d+$/.test(value), 'invalid_numeric_option');
  const number = Number(value); check(Number.isSafeInteger(number) && number >= min && number <= max, 'invalid_numeric_option'); return number;
}
function options(argv) {
  const names = new Set(['origin', 'project', 'owner-password-file', 'expect-executor', 'expect-model', 'expect-effort', 'request-timeout-ms', 'run-timeout-ms', 'max-run-tokens']);
  const values = {}; let live = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--live') { check(!live, 'duplicate_option'); live = true; continue; }
    check(flag.startsWith('--') && names.has(flag.slice(2)), 'unknown_option');
    const key = flag.slice(2); const value = argv[++index];
    check(value && !value.startsWith('--') && !Object.hasOwn(values, key), 'missing_or_duplicate_option'); values[key] = value;
  }
  check(live, 'live_opt_in_required');
  for (const key of ['origin', 'project', 'owner-password-file', 'expect-executor', 'expect-model', 'expect-effort']) check(values[key], 'explicit_configuration_required');
  let origin; try { origin = new URL(values.origin); } catch { throw new VerificationError('invalid_origin'); }
  check(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname) && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'loopback_origin_required');
  check(/^\d+$/.test(origin.port) && Number(origin.port) >= 1024 && Number(origin.port) <= 65535 && Number(origin.port) !== 3180, 'isolated_nondefault_port_required');
  check(/^acp-smoke-[a-z0-9][a-z0-9-]{5,47}$/.test(values.project), 'isolated_project_required');
  check(path.isAbsolute(values['owner-password-file']), 'absolute_owner_password_file_required');
  check(values['expect-executor'] === 'dsh-acp' && values['expect-model'] === 'gpt-6.1-sol' && values['expect-effort'] === 'max', 'expected_acp_route_required');
  check(!process.env.DOCKER_HOST, 'docker_host_override_forbidden');
  return { origin, project: values.project, passwordFile: values['owner-password-file'], requestMs: numeric(values['request-timeout-ms'], 8000, 1000, 15000), runMs: numeric(values['run-timeout-ms'], 240000, 10000, 300000), tokens: numeric(values['max-run-tokens'], 50000, 128, 50000) };
}

// Request only specific Docker fields: never Config.Env, secret contents, or docker exec.
async function isolatedCompose(config, signal) {
  const command = async args => {
    try { return (await exec('docker', args, { timeout: config.requestMs, maxBuffer: 1024 * 1024, windowsHide: true, signal })).stdout.trim(); }
    catch { throw new VerificationError('local_compose_inspection_failed'); }
  };
  const context = await command(['context', 'show']);
  check(/^[a-zA-Z0-9_.-]{1,128}$/.test(context), 'invalid_docker_context');
  const socket = JSON.parse(await command(['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}']));
  check(typeof socket === 'string' && /^(unix:\/\/\/|npipe:\/\/\/\/\.\/pipe\/)/.test(socket), 'local_docker_socket_required');
  const docker = args => command(['--context', context, ...args]);
  const ids = (await docker(['ps', '-aq', '--no-trunc', '--filter', `label=com.docker.compose.project=${config.project}`])).split(/\s+/).filter(Boolean);
  check(ids.length === 3 && ids.every(id => HEX.test(id)) && new Set(ids).size === 3, 'isolated_three_service_project_required');
  const format = '{"id":{{json .Id}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"oneoff":{{json (index .Config.Labels "com.docker.compose.oneoff")}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}},"networks":{{json .NetworkSettings.Networks}},"privileged":{{json .HostConfig.Privileged}},"pidMode":{{json .HostConfig.PidMode}},"networkMode":{{json .HostConfig.NetworkMode}}}';
  const containers = JSON.parse(`[${(await docker(['inspect', '--format', format, ...ids])).split(/\r?\n/).join(',')}]`);
  const expectedMounts = { computer: { '/workspace': 'computer-home', '/var/lib/private-computer': 'control-state' }, desktop: { '/home/desktop': 'computer-home' }, egress: {} };
  check(containers.map(item => item.service).sort().join(',') === 'computer,desktop,egress', 'unexpected_compose_services');
  const volumes = new Map(); const networkNames = new Set();
  for (const item of containers) {
    check(item.project === config.project && item.running === true && item.privileged === false && item.pidMode === '' && !['host', 'container'].some(value => item.networkMode?.startsWith(value)) && item.oneoff === 'False', 'unsafe_compose_container');
    const bindings = Object.entries(item.ports ?? {}).flatMap(([port, entries]) => (entries ?? []).map(entry => ({ port, ...entry })));
    check(item.service === 'computer' ? bindings.length === 1 && bindings[0].port === '3180/tcp' && bindings[0].HostIp === '127.0.0.1' && bindings[0].HostPort === config.origin.port : bindings.length === 0, 'isolated_port_binding_required');
    const mounts = expectedMounts[item.service]; const seen = new Set();
    for (const mount of item.mounts ?? []) {
      if (mount.Type === 'volume') {
        check(Object.hasOwn(mounts, mount.Destination) && mount.RW === true && typeof mount.Name === 'string', 'unexpected_project_volume');
        check(!seen.has(mount.Destination), 'duplicate_project_mount'); seen.add(mount.Destination);
        const previous = volumes.get(mount.Name); check(!previous || previous === mounts[mount.Destination], 'shared_volume_role_mismatch'); volumes.set(mount.Name, mounts[mount.Destination]);
      } else if (mount.Type === 'bind') {
        const allowedSecrets = item.service === 'computer' ? ['owner-password', 'runner-token', 'model-key'] : item.service === 'desktop' ? ['runner-token'] : [];
        check(allowedSecrets.some(name => mount.Destination === `/run/secrets/${name}`) && mount.RW === false, 'unexpected_host_bind_mount');
      } else check(mount.Type === 'tmpfs' && ['/run/private-computer', '/run/private-runner'].includes(mount.Destination), 'unexpected_compose_mount');
    }
    check(seen.size === Object.keys(mounts).length, 'project_workspace_volumes_required');
    const networks = Object.keys(item.networks ?? {}); networks.forEach(name => networkNames.add(name));
    check(networks.length === (item.service === 'desktop' ? 1 : 2), 'unexpected_project_networks');
  }
  check(volumes.size === 2 && networkNames.size === 2, 'project_storage_and_networks_required');
  for (const [name, role] of volumes) {
    const meta = JSON.parse(await docker(['volume', 'inspect', name, '--format', '{"project":{{json (index .Labels "com.docker.compose.project")}},"role":{{json (index .Labels "com.docker.compose.volume")}}}']));
    check(meta.project === config.project && meta.role === role, 'volume_not_owned_by_project');
    const users = (await docker(['ps', '-aq', '--no-trunc', '--filter', `volume=${name}`])).split(/\s+/).filter(Boolean);
    check(users.length > 0 && users.every(id => ids.includes(id)), 'volume_shared_outside_project');
  }
  const roles = new Map();
  for (const name of networkNames) {
    const meta = JSON.parse(await docker(['network', 'inspect', name, '--format', '{"project":{{json (index .Labels "com.docker.compose.project")}},"role":{{json (index .Labels "com.docker.compose.network")}},"internal":{{json .Internal}},"containers":{{json .Containers}}}']));
    check(meta.project === config.project && ['desktop-net', 'internet-net'].includes(meta.role) && !roles.has(meta.role) && meta.internal === (meta.role === 'desktop-net'), 'network_not_isolated');
    check(Object.keys(meta.containers ?? {}).every(id => ids.includes(id)), 'network_shared_outside_project'); roles.set(meta.role, name);
  }
  for (const item of containers) check(Object.hasOwn(item.networks, roles.get('desktop-net')) && (item.service === 'desktop' || Object.hasOwn(item.networks, roles.get('internet-net'))), 'project_network_roles_mismatch');
  return { localSocket: true, projectOwnedVolumes: volumes.size, isolatedNetworks: roles.size, services: containers.length, loopbackPort: Number(config.origin.port) };
}

async function ownerPassword(filename) {
  let handle; let bytes;
  try {
    const before = await lstat(filename);
    check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size >= 12 && before.size <= 4096, 'invalid_owner_password_file');
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    check(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, 'owner_password_file_changed');
    bytes = await handle.readFile(); const after = await handle.stat();
    check(bytes.length === before.size && after.size === opened.size && after.mtimeMs === opened.mtimeMs, 'owner_password_file_changed');
    const password = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r?\n$/, '');
    check(Buffer.byteLength(password) >= 12 && !/[\r\n\0]/.test(password), 'invalid_owner_password_file'); return password;
  } catch (error) { if (error instanceof VerificationError) throw error; throw new VerificationError('owner_password_file_unreadable'); }
  finally { bytes?.fill(0); await handle?.close(); }
}

function ownerHttp(config, signal, deadline) {
  let cookie = ''; let count = 0;
  async function request(route, { method = 'GET', body, status = 200, binary = false, cleanup = false } = {}) {
    check(route.startsWith('/api/') && !route.includes('#') && new URL(route, config.origin).origin === config.origin.origin, 'unsafe_owner_route');
    check(++count <= (cleanup ? 1600 : 1500), 'http_request_budget_exhausted');
    const remaining = cleanup ? config.requestMs : Math.min(config.requestMs, deadline() - Date.now());
    check(remaining > 0 && (cleanup || !signal.aborted), 'client_time_budget_exhausted');
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    try {
      return await new Promise((resolve, reject) => {
        let responseBytes = 0; const chunks = []; let timer;
        const fail = code => reject(new VerificationError(code));
        const req = http.request(new URL(route, config.origin), { method, agent: false, family: 4, autoSelectFamily: false, headers: { Origin: config.origin.origin, ...(cookie ? { Cookie: cookie } : {}), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) }, lookup: (_hostname, _options, callback) => callback(null, '127.0.0.1', 4) }, res => {
          res.on('data', chunk => { responseBytes += chunk.length; if (responseBytes > 1024 * 1024) { req.destroy(); fail('owner_response_too_large'); } else chunks.push(chunk); });
          res.on('error', () => fail('owner_response_failed'));
          res.on('end', () => {
            try {
              check(res.statusCode === status, 'unexpected_owner_http_status');
              if (route === '/api/login') {
                const values = res.headers['set-cookie'] ?? []; const found = values.map(value => /^pc_session=[a-f0-9]{64}(?=;)/.exec(value)?.[0]).filter(Boolean);
                check(found.length === 1, 'owner_session_cookie_missing'); cookie = found[0];
              }
              const buffer = Buffer.concat(chunks);
              if (binary) resolve(buffer);
              else { try { resolve(JSON.parse(buffer.toString('utf8'))); } catch { fail('owner_json_invalid'); } }
            } catch (error) { reject(error); }
          });
        });
        const abort = () => req.destroy(new VerificationError('client_interrupted'));
        if (!cleanup) signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => req.destroy(new VerificationError('owner_request_timeout')), remaining);
        req.on('error', error => reject(error instanceof VerificationError ? error : new VerificationError('owner_request_failed')));
        req.on('close', () => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
        req.end(payload);
      });
    } finally { payload?.fill(0); }
  }
  return { get: (route, settings) => request(route, settings), post: (route, body, settings) => request(route, { ...settings, method: 'POST', body }), get authenticated() { return Boolean(cookie); }, get count() { return count; } };
}
function verifyModel(model) {
  check(model?.configured === true && model.executionProtocol === 'acp' && model.runtime === 'DSH' && model.model === 'gpt-6.1-sol' && model.reasoningEffort === 'max' && model.baseUrl === 'https://api.xingchiapi.com', 'configured_expected_dsh_acp_required');
}
function boundedRun(run, fixture) {
  check(run?.id === fixture.id && UUID.test(run.id) && run.kind === 'agent' && run.goal === fixture.goal && run.allowDesktop === false && sameKeys(run.observe, ['workspace', 'desktop']) && run.observe.workspace === true && run.observe.desktop === false, 'run_identity_or_scope_changed');
  verifyModel(run.model);
  for (const [key, cap] of Object.entries(CAPS)) check(Number.isSafeInteger(run.budget?.[key]) && run.budget[key] >= 1 && run.budget[key] <= cap, 'server_budget_not_bounded');
  check(Array.isArray(run.steps) && run.steps.length <= CAPS.maxSteps, 'run_step_budget_invalid');
  const tools = run.steps.filter(step => step.kind === 'tool');
  check(tools.length <= 3 && tools.every((step, index) => step.tool === ['workspace_list', 'workspace_read', 'workspace_write'][index]), 'unexpected_tool_or_operation');
  for (const step of tools) {
    if (step.tool === 'workspace_list') check(sameKeys(step.summary?.args, []), 'unexpected_workspace_list_args');
    if (step.tool === 'workspace_read') check(sameKeys(step.summary?.args, ['name']) && step.summary.args.name === fixture.name, 'unexpected_workspace_read_args');
    if (step.tool === 'workspace_write') check(sameKeys(step.summary?.args, ['name', 'bytes', 'sha256', 'overwrite']) && step.summary.args.name === fixture.name && step.summary.args.bytes === Buffer.byteLength(fixture.after) && step.summary.args.sha256 === hash(fixture.after) && step.summary.args.overwrite === true, 'unexpected_workspace_write_args');
  }
  if (run.usage?.unknown === true) throw new VerificationError('run_usage_unknown');
  check(!integer(run.usage?.totalTokens) || run.usage.totalTokens <= fixture.tokens, 'client_token_budget_exhausted');
  return tools;
}
function usageEvidence(run) {
  const usage = run.usage; const keys = ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  check(usage?.unknown === false && keys.every(key => integer(usage[key])), 'settled_usage_required');
  check(usage.inputTokens > 0 && usage.outputTokens > 0 && usage.totalTokens >= usage.inputTokens + usage.outputTokens && usage.cacheReadTokens + usage.cacheWriteTokens <= usage.inputTokens && usage.totalTokens <= run.budget.maxTokens, 'inconsistent_usage');
  const modelSteps = run.steps.filter(step => step.kind === 'model'); const toolSteps = run.steps.filter(step => step.kind === 'tool'); const budget = run.budget;
  check(run.steps.every(step => ['model', 'tool'].includes(step.kind) && step.status === 'succeeded') && modelSteps.length >= 2 && budget.modelTurns === modelSteps.length && budget.toolSteps === toolSteps.length && budget.toolSteps === 3 && budget.stepsUsed === budget.modelTurns + budget.toolSteps && budget.stepsUsed <= budget.maxSteps && integer(budget.elapsedMs) && budget.elapsedMs <= budget.maxDurationMs && usage.outputTokens <= budget.modelTurns * budget.maxOutputTokens, 'completed_tool_and_budget_evidence_required');
  check(run.execution?.protocol === 'acp' && run.execution.runtime === 'DSH' && run.execution.reasoningEffort === 'max' && typeof run.execution.sessionId === 'string' && run.execution.sessionId.length > 0, 'native_acp_execution_required');
  return { usage: { ...Object.fromEntries(keys.map(key => [key, usage[key]])), unknown: false }, budget: { modelTurns: budget.modelTurns, toolSteps: budget.toolSteps, stepsUsed: budget.stepsUsed, elapsedMs: budget.elapsedMs, ...Object.fromEntries(Object.keys(CAPS).map(key => [key, budget[key]])) } };
}
async function liveFile(api, name, text) {
  const { files } = await api.get('/api/files');
  check(Array.isArray(files) && files.length === 1 && files[0].name === name && files[0].size === Buffer.byteLength(text), 'isolated_workspace_changed');
  const bytes = await api.get(`/api/files/download?name=${encodeURIComponent(name)}`, { binary: true });
  check(bytes.equals(Buffer.from(text)) && hash(bytes) === hash(text), 'live_workspace_text_or_hash_mismatch');
  return files[0];
}
function goal(name, after, number, previousId) {
  return `Bounded synthetic workshop inventory task ${number}${previousId ? `, following accepted task ${previousId}` : ''}. Work ONLY with the single workspace file ${name}. Use exactly these tools in this order: workspace_list once, workspace_read once with name ${name}, workspace_write once with the same name, then finish with a concise summary. Read the current inventory before making the related update. Stage this exact UTF-8 content (JSON string; decode its escapes): ${JSON.stringify(after)}. Wait for separate owner approval of that exact staged write. Do not change any other file, delete anything, browse, control a desktop, request a handoff, or repeat a tool/write. No other goal or operation is authorized. Stop after the stage succeeds; the owner will review and accept separately.`;
}
function expectedDiff(name, before, after) {
  const oldLines = before.trimEnd().split('\n'); const newLines = after.trimEnd().split('\n');
  return `--- a/${name}\n+++ b/${name}\n@@ -1,3 +1,3 @@\n` + oldLines.map((line, index) => line === newLines[index] ? ` ${line}\n` : `-${line}\n+${newLines[index]}\n`).join('');
}
async function exactApproval(api, state, fixture) {
  boundedRun(state.run, fixture); const approval = state.run.approval;
  check(state.run.status === 'awaiting_approval' && approval?.runId === fixture.id && UUID.test(approval.id) && approval.toolName === 'workspace_write' && approval.generation === state.control?.generation && Date.parse(approval.expiresAt) > Date.now() + 1000 && HEX.test(approval.argumentsDigest), 'exact_approval_identity_required');
  check(sameKeys(approval.args, ['name', 'bytes', 'sha256', 'overwrite']) && approval.args.name === fixture.name && approval.args.bytes === Buffer.byteLength(fixture.after) && approval.args.sha256 === hash(fixture.after) && approval.args.overwrite === true && sameKeys(approval.preview, ['content']) && approval.preview.content === fixture.after, 'exact_write_preview_required');
  const tools = state.run.steps.filter(step => step.kind === 'tool');
  check(tools.length === 3 && tools[0].status === 'succeeded' && tools[1].status === 'succeeded' && tools[1].result?.bytes === Buffer.byteLength(fixture.before) && tools[2].status === 'running' && tools[2].summary.argumentsDigest === approval.argumentsDigest, 'list_read_before_write_required');
  await liveFile(api, fixture.name, fixture.before); return approval;
}
async function task(api, config, fixture, report, control) {
  control.pendingGoal = fixture.goal;
  const started = await api.post('/api/tasks', { goal: fixture.goal, allowDesktop: false, observe: { workspace: true, desktop: false } }, { status: 202 });
  check(UUID.test(started.id), 'task_id_missing'); fixture.id = started.id; control.id = fixture.id;
  const evidence = { task: report.tasks.length + 1, runId: fixture.id, status: 'started' }; report.tasks.push(evidence);
  const base = `/api/tasks/${fixture.id}`; const end = Date.now() + config.runMs; let approved;
  control.deadline = Math.min(control.sessionDeadline, end);
  while (true) {
    check(Date.now() < end && !control.abort.signal.aborted, 'client_time_budget_exhausted');
    const state = await api.get('/api/status'); boundedRun(state.run, fixture);
    check(state.control?.owner === 'human', 'workspace_only_desktop_lease_changed');
    if (state.run.approval) {
      check(!approved, 'additional_approval_forbidden');
      const approval = await exactApproval(api, state, fixture);
      await api.post(`${base}/approval`, { approvalId: randomUUID(), decision: 'approve' }, { status: 409 });
      const fresh = await exactApproval(api, await api.get('/api/status'), fixture);
      check(fresh.id === approval.id && fresh.argumentsDigest === approval.argumentsDigest, 'approval_changed_during_review');
      await api.post(`${base}/approval`, { approvalId: fresh.id, decision: 'approve' }); approved = fresh.id;
      await api.post(`${base}/approval`, { approvalId: fresh.id, decision: 'approve' }, { status: 409 });
      evidence.exactApproval = true; evidence.staleAndDuplicateApprovalRejected = true;
    }
    if (TERMINAL.has(state.run.status) && state.canStart === true) {
      check(state.run.status === 'succeeded' && approved, 'task_did_not_succeed_with_exact_approval'); break;
    }
    await delay(600, undefined, { signal: control.abort.signal });
  }
  control.deadline = control.sessionDeadline;
  const { run } = await api.get(base); boundedRun(run, fixture); check(run.status === 'succeeded', 'persisted_task_not_successful');
  Object.assign(evidence, usageEvidence(run));
  await api.post(`${base}/approval`, { approvalId: approved, decision: 'approve' }, { status: 409 });
  const { artifacts } = await api.get(`${base}/artifacts`);
  check(Array.isArray(artifacts) && artifacts.length === 1, 'single_selected_artifact_required');
  const artifact = artifacts[0]; const artifactBase = `${base}/artifacts/${encodeURIComponent(fixture.name)}`;
  check(artifact.name === fixture.name && artifact.operation === 'modified' && artifact.status === 'staged' && artifact.sha256 === hash(fixture.after) && artifact.bytes === Buffer.byteLength(fixture.after) && typeof artifact.version === 'string' && /^artifact:[a-f0-9-]{36}$/.test(artifact.version), 'staged_artifact_metadata_mismatch');
  const staged = await api.get(`${artifactBase}/download`, { binary: true });
  check(staged.equals(Buffer.from(fixture.after)) && hash(staged) === artifact.sha256, 'staged_text_or_hash_mismatch');
  const { diff } = await api.get(`${artifactBase}/diff`);
  check(diff?.name === fixture.name && diff.operation === 'modified' && diff.beforeSha256 === hash(fixture.before) && diff.afterSha256 === hash(fixture.after) && diff.binary === false && diff.truncated === false && diff.text === expectedDiff(fixture.name, fixture.before, fixture.after), 'staged_diff_mismatch');
  await liveFile(api, fixture.name, fixture.before);
  await api.post(`${artifactBase}/accept`, { expectedVersion: `artifact:${randomUUID()}` }, { status: 409 });
  await liveFile(api, fixture.name, fixture.before);
  const accepted = (await api.post(`${artifactBase}/accept`, { expectedVersion: artifact.version })).artifact;
  check(accepted?.status === 'accepted' && accepted.name === fixture.name && accepted.version === artifact.version && accepted.sha256 === artifact.sha256 && UUID.test(accepted.recoveryId), 'selected_acceptance_failed');
  const live = await liveFile(api, fixture.name, fixture.after);
  const duplicate = (await api.post(`${artifactBase}/accept`, { expectedVersion: artifact.version })).artifact;
  check(duplicate?.status === 'accepted' && duplicate.version === accepted.version && duplicate.recoveryId === accepted.recoveryId, 'duplicate_acceptance_not_idempotent');
  const repeated = await liveFile(api, fixture.name, fixture.after);
  check(live.version === repeated.version && live.modifiedAt === repeated.modifiedAt, 'duplicate_acceptance_changed_live_file');
  Object.assign(evidence, { status: 'succeeded', stagedTextHashAndDiffVerified: true, staleAcceptanceRejected: true, selectedAcceptanceVerified: true, duplicateAcceptanceIdempotent: true, liveSha256: hash(fixture.after) });
  control.id = undefined; control.pendingGoal = undefined;
  return fixture.id;
}
async function cancelOwn(api, control, report) {
  if (!api?.authenticated || (!control.id && !control.pendingGoal)) return;
  try {
    // A known runId is enough: the server's expected-run fence prevents touching
    // a later run even when the status endpoint is unavailable during failure.
    let id = control.id; let observed;
    try { observed = await api.get('/api/status', { cleanup: true }); } catch {}
    if (!id) {
      const run = observed?.run;
      if (UUID.test(run?.id) && run.goal === control.pendingGoal) id = run.id;
      else { report.cleanup.ownRunNotFound = true; return; }
    }
    check(UUID.test(id), 'own_run_identity_unconfirmed');
    if (observed && (observed.run?.id !== id || (TERMINAL.has(observed.run.status) && observed.canStart === true))) {
      report.cleanup.ownRunAlreadyInactive = true; return;
    }
    const state = await api.post('/api/run/cancel', { runId: id }, { cleanup: true });
    check(state.run?.id === id && TERMINAL.has(state.run.status), 'own_run_cancellation_unconfirmed');
    report.cleanup.ownRunCancelled = true;
  } catch { report.cleanup.ownRunCancellationUnconfirmed = true; }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--help') { console.log(HELP); return; }
  let config;
  try { config = options(argv); }
  catch (error) { console.error(JSON.stringify({ ok: false, code: error instanceof VerificationError ? error.code : 'invalid_options', help: 'node scripts/verify-acp-tasks.mjs --help' })); process.exitCode = 2; return; }
  const report = { ok: false, scenario: 'A2_workspace_only', startedAt: new Date().toISOString(), project: config.project, origin: config.origin.origin, route: 'xingchi/gpt-6.1-sol/max', executor: 'DSH ACP', tasks: [], cleanup: {} };
  const abort = new AbortController(); const interrupt = () => abort.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const control = { abort, sessionDeadline: Date.now() + config.runMs * 2 + 120000 };
  control.deadline = control.sessionDeadline; let api; let phase = 'compose_isolation';
  try {
    report.isolation = await isolatedCompose(config, abort.signal);
    api = ownerHttp(config, abort.signal, () => control.deadline);
    phase = 'owner_login'; let password = await ownerPassword(config.passwordFile);
    try { await api.post('/api/login', { password }); } finally { password = undefined; }
    phase = 'empty_project_preflight';
    const state = await api.get('/api/status'); verifyModel(state.model);
    check(state.canStart === true && state.run == null && state.control?.owner === 'human' && state.control.private === false, 'fresh_idle_isolated_project_required');
    const { runs } = await api.get('/api/tasks?limit=1'); const { files } = await api.get('/api/files');
    check(Array.isArray(runs) && runs.length === 0 && Array.isArray(files) && files.length === 0, 'empty_project_workspace_and_history_required');
    const name = `acp-smoke-${randomBytes(12).toString('hex')}.txt`; report.fixtureName = name;
    const texts = ['Fictional workshop inventory\nBlue notebooks: 3\nGreen pencils: 5\n', 'Fictional workshop inventory\nBlue notebooks: 5\nGreen pencils: 5\n', 'Fictional workshop inventory\nBlue notebooks: 5\nGreen pencils: 9\n'];
    phase = 'seed_synthetic_fixture';
    await api.post('/api/files', { name, contentBase64: Buffer.from(texts[0]).toString('base64') }, { status: 201 }); await liveFile(api, name, texts[0]);
    let previous;
    for (let index = 1; index <= 2; index++) {
      phase = `workspace_task_${index}`;
      previous = await task(api, config, { name, before: texts[index - 1], after: texts[index], goal: goal(name, texts[index], index, previous), tokens: config.tokens }, report, control);
    }
    phase = 'consecutive_history_and_usage';
    const history = (await api.get('/api/tasks?limit=3')).runs;
    check(Array.isArray(history) && history.length === 2 && history.every(run => report.tasks.some(item => item.runId === run.id && run.status === 'succeeded')) && new Set(report.tasks.map(item => item.runId)).size === 2, 'two_separate_task_histories_required');
    const final = await api.get('/api/status'); verifyModel(final.model);
    check(final.canStart === true && final.control?.owner === 'human' && final.run?.id === previous && final.run.status === 'succeeded', 'final_idle_state_required');
    report.usage = Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'].map(key => [key, report.tasks.reduce((sum, item) => sum + item.usage[key], 0)]));
    report.usage.unknown = false; report.usage.inputIncludesCache = true; report.ok = true;
  } catch (error) {
    report.failure = { phase, code: error instanceof VerificationError ? error.code : abort.signal.aborted ? 'client_interrupted' : 'verification_failed' };
    process.exitCode = 1; await cancelOwn(api, control, report);
  } finally {
    if (api?.authenticated) {
      try { await api.post('/api/logout', {}, { cleanup: true }); report.cleanup.ownerSessionLoggedOut = true; }
      catch { report.cleanup.ownerLogoutUnconfirmed = true; report.ok = false; process.exitCode = 1; }
    }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    report.requests = api?.count ?? 0; report.finishedAt = new Date().toISOString();
    console.log(JSON.stringify(report, null, 2));
  }
}
await main();
