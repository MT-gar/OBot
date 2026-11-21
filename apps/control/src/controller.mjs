import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import { mkdir, readFile, writeFile, rename, lstat, readdir, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError } from './workspace.mjs';
import { runAgent, agentLimits, AgentError } from './agent.mjs';
import { createWork, handoffFacts, planRedelegation, reconcileWork, recordAttempt, viewWork } from './works.mjs';
import { approveDraftWrite, assertDraftWrite, createDraftGrant, inspectDraftGrant, revokeDraftGrant } from './draft-grants.mjs';

const STEP_TITLES = ['打开本地测试页面', '填写并提交可见表单', '生成工作区 Markdown 报告'];
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'paused']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MODEL_HANDOFF_REASONS = new Set(['human_action_required', 'account_selection', 'external_result_confirmation']);
const OFFLINE_POLICIES = new Set(['continue', 'pause_at_approval', 'stop']);
const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const cancelled = () => new DOMException('Automation control was revoked.', 'AbortError');
const fresh = () => ({ confirmed: false, input: false, observation: false, elapsedMs: 0 });
const validEvidence = evidence => Number.isSafeInteger(evidence?.generation) && evidence.generation > 0;

function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function scopes(value, allowDesktop, explicit) {
  if (value === undefined && !explicit) return { workspace: true, desktop: allowDesktop };
  if (!object(value) || Object.keys(value).some(key => !['workspace', 'desktop'].includes(key))
      || typeof value.workspace !== 'boolean' || typeof value.desktop !== 'boolean') {
    throw new HttpError(400, 'Choose fresh workspace and desktop observation scopes explicitly.');
  }
  if (allowDesktop && !value.desktop) throw new HttpError(400, 'Desktop input requires newly permitted desktop observation.');
  return { workspace: value.workspace, desktop: value.desktop };
}
function goalText(value, optional = false) {
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > 4000 || Buffer.byteLength(value) > 16000) {
    throw new HttpError(400, optional ? 'Owner context must be text of at most 4000 characters.' : 'Provide a non-empty goal of at most 4000 characters.');
  }
  return value.trim();
}
function draftMutation({ name, content, expectedVersion }) {
  const sha256 = createHash('sha256').update(content).digest('hex');
  const argumentsDigest = createHash('sha256').update(JSON.stringify(['staged-workspace-write-v1', name, expectedVersion, sha256])).digest('hex');
  return { name, bytes: content.length, argumentsDigest };
}
function serial() {
  let previous = Promise.resolve();
  return operation => {
    const next = previous.then(operation);
    previous = next.catch(() => {});
    return next;
  };
}

export async function createController({ runtime, workspace, artifacts, dataDir, fixtureUrl, stepDelayMs = 2000, model, agentLimits: requestedLimits = {}, offlineGraceMs = 3000 }) {
  if (!Number.isSafeInteger(offlineGraceMs) || offlineGraceMs < 1 || offlineGraceMs > 60000) throw new RangeError('Invalid offline grace period.');
  const defaultLimits = agentLimits(requestedLimits);
  const runsDir = path.join(dataDir, 'runs');
  for (const directory of [dataDir, runsDir]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Control history requires real directories.');
  }
  const stateFile = path.join(dataDir, 'state.json');
  const emitter = new EventEmitter();
  const works = new Map();
  let run = null;
  let events = [];
  let active = null;
  let starting = false;
  let closing = false;
  let generation = 0;
  let owner = 'unconfirmed';
  let privateMode = false;
  let stop = fresh();
  let writes = Promise.resolve();
  let idleStop = null;
  let ownerOnline = false;
  let offlineElapsed = true;
  let offlineTimer;
  const inputChange = serial();
  const observationChange = serial();
  const setInput = (value, options) => inputChange(() => runtime.setViewOnly(value, options));
  const setObservation = (value, options) => observationChange(() => runtime.setObservation?.(value, options));

  function notify() { emitter.emit('change'); }
  function changeOwner(value) {
    owner = value;
    if (value === 'stopping' || value === 'unconfirmed') emitter.emit('input-revoked');
  }
  function safeRun(value) {
    const view = clone(value);
    if (view?.redelegation) delete view.redelegation.context;
    return view;
  }
  async function atomic(file, value) {
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  }
  function persist(type) {
    events.push({ at: now(), type, runId: run?.id ?? null, generation, owner, status: run?.status ?? null });
    events = events.slice(-500);
    const state = clone({ version: 1, run: safeRun(run), events, generation, privateMode, works: [...works.values()] });
    const operation = writes.then(async () => {
      if (state.run) await atomic(path.join(runsDir, `${state.run.id}.json`), state.run);
      await atomic(stateFile, state);
    });
    writes = operation.catch(() => {});
    return operation.then(notify);
  }
  function stopSteps(status) {
    for (const step of run?.steps ?? []) {
      if (step.status === 'running' || step.status === 'pending') step.status = status === 'failed' ? 'failed' : 'cancelled';
    }
    if (run) delete run.approval;
  }
  try {
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.events)) throw new Error('Unsupported control state.');
    run = saved.run;
    events = saved.events.slice(-500);
    generation = Number.isSafeInteger(saved.generation) ? saved.generation + 1 : 1;
    privateMode = saved.privateMode === true;
    for (const work of saved.works ?? []) {
      if (!UUID.test(work.id) || !Array.isArray(work.attempts)) throw new Error('Invalid saved work.');
      works.set(work.id, work);
    }
    if (run && (!UUID.test(run.id) || !Array.isArray(run.steps))) throw new Error('Invalid saved run.');
    if (run && !TERMINAL.has(run.status)) {
      run.status = 'interrupted';
      run.error = 'The control service restarted; the previous run was interrupted and was not resumed.';
      run.finishedAt = now();
      privateMode = true;
      if (run.kind === 'agent' && run.usage) { run.usage.unknown = true; run.usage.unknownReason = 'service_restarted'; }
      stopSteps('interrupted');
      if (run.workId && works.has(run.workId)) recordAttempt(works.get(run.workId), run);
      await persist('run.interrupted');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  async function stopRuntime() {
    const started = performance.now();
    const checks = await Promise.allSettled([setInput(false), setObservation(false)]);
    const inputEvidence = checks[0].status === 'fulfilled' ? checks[0].value : undefined;
    const observationEvidence = checks[1].status === 'fulfilled' ? checks[1].value : undefined;
    const inputStopped = validEvidence(inputEvidence) && inputEvidence.stopped === true;
    const observationStopped = validEvidence(observationEvidence) && observationEvidence.enabled === false;
    return {
      confirmed: inputStopped && observationStopped, input: inputStopped, observation: observationStopped,
      elapsedMs: Math.round(performance.now() - started),
      ...(validEvidence(inputEvidence) ? { runnerGeneration: inputEvidence.generation } : {}),
      ...(validEvidence(observationEvidence) ? { observationGeneration: observationEvidence.generation } : {}),
    };
  }
  stop = await stopRuntime();
  changeOwner(stop.confirmed ? 'human' : 'unconfirmed');

  function modelInfo() {
    let value;
    try { value = model?.metadata?.() ?? {}; } catch { value = {}; }
    let baseUrl = '';
    try {
      const url = new URL(value.baseUrl);
      if (['http:', 'https:'].includes(url.protocol)) baseUrl = `${url.origin}${url.pathname}`;
    } catch {}
    return {
      configured: Boolean(model && (typeof model.respond === 'function' || typeof model.execute === 'function') && value.configured === true),
      protocol: 'responses', executionProtocol: value.executionProtocol === 'acp' ? 'acp' : 'direct',
      runtime: value.runtime === 'DSH' ? 'DSH' : undefined, baseUrl, verified: value.verified === true,
      model: typeof value.model === 'string' ? value.model.slice(0, 128) : '',
      reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort.slice(0, 64) : '',
      ...(typeof value.lastErrorCode === 'string' && /^[a-z0-9_]{1,64}$/i.test(value.lastErrorCode) ? { lastErrorCode: value.lastErrorCode } : {}),
    };
  }
  function publicRun() {
    const view = safeRun(run);
    if (view && active?.runId === view.id && active.grant) view.grant = inspectDraftGrant(active.grant);
    if (view && active?.runId === view.id && TERMINAL.has(view.status)) {
      view.status = 'finishing';
      delete view.finishedAt;
      delete view.handoff;
    }
    return view;
  }
  function publicWork(work, currentRun = publicRun()) {
    const related = currentRun?.workId === work.id ? currentRun : undefined;
    const view = viewWork(work, related);
    if (related?.status === 'finishing') view.status = 'finishing';
    return view;
  }
  function canStart() { return !starting && !active && !idleStop && !closing; }
  async function status() {
    const [desktop, files] = await Promise.all([Promise.resolve().then(() => runtime.inspect()).catch(() => ({})), workspace.list()]);
    const view = publicRun();
    if (view?.budget && active?.runId === view.id) view.budget.elapsedMs = Math.max(view.budget.elapsedMs, Date.now() - Date.parse(view.startedAt));
    if (view?.approval && active?.pendingApproval?.id === view.approval.id && active.pendingApproval.preview) view.approval.preview = clone(active.pendingApproval.preview);
    const work = view?.workId && works.get(view.workId);
    return {
      phase: model ? 'mvp' : 'p0', ...(model ? { model: modelInfo() } : {}), run: view,
      ...(work ? { work: publicWork(work, view) } : {}), canStart: canStart(), ownerOnline,
      desktop: { ready: desktop.ready === true, browserReady: desktop.browserReady === true },
      control: { owner, generation, private: privateMode, stop: clone(stop) }, files,
      sandbox: { enabled: desktop.sandboxEnabled === true }, workspacePersistent: true,
    };
  }
  function checkTicket(ticket) {
    if (closing || ticket.abort.signal.aborted || generation !== ticket.generation || active !== ticket) throw cancelled();
  }
  function checkInput(ticket) {
    checkTicket(ticket);
    if (!ticket.input || owner !== 'automation') throw cancelled();
  }
  function checkObservation(ticket, scope) {
    checkTicket(ticket);
    if (privateMode || (scope !== 'model' && ticket.observe[scope] !== true)) throw new AgentError('observation_closed', 'The owner did not authorize this observation.');
  }
  // The guards are next to the actual adapters as well as at model egress. An adapter resolving
  // after a revoke cannot hand its bytes to a newer attempt or write an observation to history.
  async function observed(ticket, scope, operation) {
    checkObservation(ticket, scope);
    const value = await operation();
    checkObservation(ticket, scope);
    return value;
  }
  function executionContext(ticket) {
    const reservations = new WeakMap();
    function authorizeDraftWrite(mutation) {
      if (!ticket.grant) return null;
      checkObservation(ticket, 'workspace');
      const descriptor = draftMutation(mutation);
      const reservation = approveDraftWrite(ticket.grant, descriptor);
      if (!reservation) return null;
      const assertion = assertDraftWrite(ticket.grant, descriptor, reservation);
      reservations.set(assertion, descriptor.argumentsDigest);
      run.grant = inspectDraftGrant(ticket.grant);
      notify();
      return assertion;
    }
    function stage(name, content, settings = {}) {
      const { expectedVersion, assertActive: assertDispatch, draftAuthorization } = settings;
      const bytes = content === null ? null : Buffer.from(content);
      if (draftAuthorization) {
        const digest = reservations.get(draftAuthorization);
        reservations.delete(draftAuthorization);
        if (!digest || bytes === null || digest !== draftMutation({ name, content: bytes, expectedVersion }).argumentsDigest) {
          throw new AgentError('draft_grant_denied', 'The staged write does not match its reserved authorization.');
        }
      }
      const assertActive = () => {
        checkObservation(ticket, 'workspace');
        assertDispatch?.();
        draftAuthorization?.();
      };
      return observed(ticket, 'workspace', () => artifacts.stage(ticket.runId, name, bytes, { expectedVersion, assertActive }));
    }
    const store = artifacts && {
      version: name => observed(ticket, 'workspace', () => artifacts.version(ticket.runId, name)),
      stage,
      list: () => observed(ticket, 'workspace', () => artifacts.listWorkspace(run.id)),
      read: name => observed(ticket, 'workspace', () => artifacts.readWorkspace(run.id, name)),
    };
    const desktopReads = new Set(['desktop_screenshot', 'browser_snapshot']);
    return {
      model, run, signal: ticket.abort.signal, fixtureUrl, limits: ticket.limits,
      runtime: {
        performTool(name, args, settings = {}) {
          if (desktopReads.has(name)) {
            return observed(ticket, 'desktop', () => runtime.performTool(name, args, { ...settings, assertLease: () => checkObservation(ticket, 'desktop') }));
          }
          checkInput(ticket);
          return runtime.performTool(name, args, { ...settings, assertLease: () => checkInput(ticket) });
        },
      },
      workspace: {
        list: () => observed(ticket, 'workspace', () => workspace.list()),
        download: name => observed(ticket, 'workspace', () => workspace.download(name)),
        ...(!artifacts ? { write: (name, content) => observed(ticket, 'workspace', () => workspace.write(name, content)) } : {}),
      },
      artifactStage: store, authorizeDraftWrite, freshObservation: ticket.freshObservation,
      assertLease: () => checkTicket(ticket), assertObservation: scope => checkObservation(ticket, scope),
      requestApproval: (summary, settings) => requestApproval(ticket, summary, settings),
      requestHandoff(reason) {
        checkTicket(ticket);
        if (!MODEL_HANDOFF_REASONS.has(reason)) throw new AgentError('invalid_tool', 'Use a supported handoff reason.');
        beginStop(ticket, 'paused', reason);
      },
      async update(type) { checkTicket(ticket); await persist(type); checkTicket(ticket); },
    };
  }
  function applyOfflinePolicy(ticket) {
    if (!ticket || ticket.intent || !offlineElapsed) return;
    if (ticket.offlinePolicy === 'stop') beginStop(ticket, 'cancelled', 'owner_offline');
    if (ticket.offlinePolicy === 'pause_at_approval' && ticket.pendingApproval) beginStop(ticket, 'paused', 'owner_offline');
  }
  function setOwnerOnline(value) {
    if (closing || value === ownerOnline) return;
    ownerOnline = value;
    clearTimeout(offlineTimer);
    offlineElapsed = false;
    if (!ownerOnline) {
      offlineTimer = setTimeout(() => {
        offlineElapsed = true;
        applyOfflinePolicy(active);
      }, offlineGraceMs);
      offlineTimer.unref();
    }
    notify();
  }
  function beginStop(ticket, result, reason) {
    if (ticket.intent) return;
    ticket.intent = { result, reason };
    generation++;
    run.status = 'finishing';
    if (result === 'paused') privateMode = true;
    if (ticket.grant) run.grant = revokeDraftGrant(ticket.grant);
    ticket.abort.abort();
    ticket.pendingApproval?.settle(cancelled());
    if (ticket.touchedDesktop) {
      changeOwner('stopping');
      stop = fresh();
      ticket.stop = stopRuntime();
    } else {
      ticket.stop = Promise.resolve({ ...stop, elapsedMs: 0 });
    }
    notify();
  }
  async function finalize(ticket) {
    const evidence = await ticket.stop;
    if (ticket.touchedDesktop) changeOwner(evidence.confirmed ? 'human' : 'unconfirmed');
    stop = evidence;
    const { result, reason } = ticket.intent;
    run.status = result;
    run.finishedAt = now();
    run.stop = evidence;
    if (run.budget) run.budget.elapsedMs = Math.max(run.budget.elapsedMs, Date.now() - Date.parse(run.startedAt));
    if (run.redelegation) delete run.redelegation.context;
    const unconfirmed = run.steps.some(step => step.effect === 'unconfirmed');
    stopSteps(result);
    if (result === 'paused' || unconfirmed) {
      const staged = artifacts ? await artifacts.list(run.id).catch(() => []) : [];
      run.handoff = handoffFacts(run, reason, staged, evidence);
    }
    if (ticket.work) recordAttempt(ticket.work, run);
    try { await persist(`run.${result}`); }
    catch {
      run.status = 'failed';
      run.errorCode = 'persistence_failed';
      run.error = 'Task state could not be persisted safely.';
      if (ticket.work) recordAttempt(ticket.work, run);
      throw new HttpError(503, run.error);
    } finally {
      ticket.freshObservation = undefined;
      active = null;
      notify();
    }
  }
  async function prepare(ticket) {
    checkTicket(ticket);
    if (ticket.input) changeOwner('stopping');
    if (ticket.input || ticket.observe.desktop) ticket.touchedDesktop = true;
    if (ticket.observe.desktop) {
      const proof = await setObservation(true, { signal: ticket.abort.signal });
      checkTicket(ticket);
      if (!validEvidence(proof) || proof.enabled !== true) throw new Error('The desktop runner did not confirm observation.');
    }
    if (run.redelegation) {
      const signal = ticket.abort.signal;
      const freshObservation = {};
      if (ticket.observe.workspace) {
        const files = await observed(ticket, 'workspace', () => artifacts ? artifacts.listWorkspace(run.id) : workspace.list());
        freshObservation.workspace = files.slice(0, 200).map(({ name, size, modifiedAt }) => ({ name, size, modifiedAt }));
      }
      if (ticket.observe.desktop) {
        freshObservation.desktop = await observed(ticket, 'desktop', () => runtime.performTool('browser_snapshot', {}, { signal, assertLease: () => checkObservation(ticket, 'desktop') }));
      }
      ticket.freshObservation = freshObservation;
    }
    if (ticket.input) {
      const proof = await setInput(true, { signal: ticket.abort.signal, onLeaseLost: () => {
        if (active === ticket && !ticket.intent) beginStop(ticket, run.kind === 'agent' ? 'paused' : 'failed', 'input_lease_lost');
      } });
      checkTicket(ticket);
      if (!validEvidence(proof)) throw new Error('The desktop runner did not confirm the input lease.');
      changeOwner('automation');
    }
    await persist('run.ready');
    checkTicket(ticket);
  }
  async function executeDemo(ticket) {
    const settings = { signal: ticket.abort.signal, assertLease: () => checkInput(ticket) };
    const operations = [
      () => runtime.openFixture({ url: fixtureUrl, ...settings }),
      () => runtime.fillAndSubmit(settings),
      async () => {
        checkInput(ticket);
        const report = `# 私人云电脑 P0 固定演示\n\n- Run: ${run.id}\n- 完成时间: ${now()}\n- 页面: 本地 /fixture\n- 结果: 已在同一个有界面 Chromium 中填写并提交固定测试表单。\n- 输入: 私人云电脑 P0 / 人工接管可随时中止后续步骤\n\n本报告由固定自动化生成，没有调用模型或访问外部网站。\n`;
        await workspace.write(`demo-${run.id}.md`, Buffer.from(report));
      },
    ];
    for (const [index, operation] of operations.entries()) {
      checkInput(ticket);
      const step = run.steps[index];
      step.status = 'running';
      await persist('step.started');
      await delay(stepDelayMs, undefined, { signal: ticket.abort.signal });
      checkInput(ticket);
      if (index === 1) { step.effect = 'unconfirmed'; await persist('step.dispatch'); checkInput(ticket); }
      await operation();
      checkInput(ticket);
      if (index === 1) step.effect = 'completed';
      step.status = 'succeeded';
      await persist('step.succeeded');
    }
  }
  async function execute(ticket, executeRun, ready) {
    let prepared = false;
    try {
      await persist('run.started');
      await prepare(ticket);
      prepared = true;
      ready.resolve();
      await executeRun(ticket);
      checkTicket(ticket);
      beginStop(ticket, 'succeeded', 'completed');
    } catch (error) {
      if (!ticket.intent) {
        const aborted = ticket.abort.signal.aborted || error.name === 'AbortError';
        if (!aborted) {
          run.errorCode = error instanceof AgentError ? error.code : !prepared ? 'lease_failed' : run.kind === 'demo' ? 'demo_failed' : 'model_failed';
          run.error = error instanceof AgentError ? error.message : !prepared ? 'Could not acquire the required observation or input permissions; no task actions were executed.' : run.kind === 'demo' ? 'The fixed desktop action failed. Check desktop and browser readiness.' : 'The model request or task failed. No automatic retry was performed.';
        }
        beginStop(ticket, aborted ? 'cancelled' : 'failed', 'execution_ended');
      }
    }
    try { await finalize(ticket); }
    catch (error) { if (!prepared) ready.reject(error); return; }
    if (!prepared) ready.reject(new HttpError(run.status === 'failed' ? 503 : 409, run.error ?? 'Control changed before the run started.'));
  }
  async function acquire({ input, observe, limits, work, workBudget, makeRun, executeRun, validate, offlinePolicy = 'continue', draftGrant }) {
    if (!canStart()) throw new HttpError(409, 'A run is already active.');
    if (!OFFLINE_POLICIES.has(offlinePolicy)) throw new HttpError(400, 'Choose a supported offline policy.');
    if (draftGrant != null && (!artifacts || observe.workspace !== true)) throw new HttpError(400, 'Draft grants require an observed workspace with staging.');
    starting = true;
    const before = generation;
    try {
      if (input || observe.desktop) {
        if (owner !== 'human') throw new HttpError(409, 'Confirm human input before assigning the desktop.');
        const ready = await runtime.inspect();
        if (!ready.ready || !ready.browserReady) throw new HttpError(503, 'Desktop and browser must both be ready.');
      }
      if (generation !== before || closing) throw new HttpError(409, 'Control changed while starting.');
      validate?.();
      if (offlinePolicy !== 'continue' && !ownerOnline) throw new HttpError(409, 'Connect the owner event stream before choosing an offline pause or stop policy.');
      const grant = createDraftGrant(draftGrant);
      const next = makeRun();
      if (grant) next.grant = inspectDraftGrant(grant);
      const ticket = { generation: ++generation, abort: new AbortController(), pendingApproval: null, input, observe, limits, work, runId: next.id, offlinePolicy, grant };
      run = next;
      active = ticket;
      privateMode = false;
      if (work) {
        if (workBudget) work.budget = workBudget;
        works.set(work.id, work);
        recordAttempt(work, run);
      }
      const ready = Promise.withResolvers();
      ticket.done = execute(ticket, executeRun, ready);
      await ready.promise;
      return { id: ticket.runId, ...(work ? { workId: work.id } : {}) };
    } finally { starting = false; notify(); }
  }
  function startDemo() {
    if (privateMode) throw new HttpError(409, 'Exit private mode through a new explicit task assignment.');
    return acquire({ input: true, observe: {}, executeRun: executeDemo, makeRun: () => ({ id: randomUUID(), kind: 'demo', status: 'running', startedAt: now(), steps: STEP_TITLES.map(title => ({ title, status: 'pending' })) }) });
  }
  async function requestApproval(ticket, summary, { signal, ttlMs, preview }) {
    checkTicket(ticket);
    if (signal.aborted) throw cancelled();
    if (ticket.offlinePolicy === 'pause_at_approval' && offlineElapsed) {
      beginStop(ticket, 'paused', 'owner_offline');
      throw cancelled();
    }
    const id = randomUUID();
    const expires = Date.now() + ttlMs;
    const waiting = Promise.withResolvers();
    waiting.promise.catch(() => {});
    let timer;
    const onAbort = () => pending.settle(cancelled());
    const pending = {
      id, expires, generation: ticket.generation, runId: run.id, deciding: false, settled: false, preview: preview ? clone(preview) : null,
      settle(error, decision) {
        if (pending.settled) return;
        pending.settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        pending.preview = null;
        if (ticket.pendingApproval === pending) ticket.pendingApproval = null;
        if (run?.approval?.id === id) delete run.approval;
        if (run?.status === 'awaiting_approval') run.status = 'running';
        if (error) waiting.reject(error); else waiting.resolve(decision);
      },
    };
    ticket.pendingApproval = pending;
    run.approval = { id, runId: run.id, ...clone(summary), generation: ticket.generation, expiresAt: new Date(expires).toISOString() };
    run.status = 'awaiting_approval';
    timer = setTimeout(() => pending.settle(new AgentError('approval_expired', 'The concrete action approval expired.')), ttlMs);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    try { await persist('approval.requested'); return await waiting.promise; }
    catch (error) { pending.settle(error); throw error; }
  }
  async function decideApproval(runId, decision) {
    if (!decision || !['approve', 'deny'].includes(decision.decision) || typeof decision.approvalId !== 'string') {
      throw new HttpError(400, 'A concrete approvalId and approve/deny decision are required.');
    }
    const ticket = active;
    const pending = ticket?.pendingApproval;
    if (!pending || pending.settled || pending.deciding || run?.status !== 'awaiting_approval' || pending.runId !== runId || pending.id !== decision.approvalId || pending.generation !== generation || ticket.abort.signal.aborted) {
      throw new HttpError(409, 'This action approval is no longer active.');
    }
    if (ticket.offlinePolicy !== 'continue' && !ownerOnline) throw new HttpError(409, 'Reconnect the owner event stream before deciding an approval.');
    if (pending.expires <= Date.now()) {
      pending.settle(new AgentError('approval_expired', 'The concrete action approval expired.'));
      throw new HttpError(409, 'This action approval expired.');
    }
    pending.deciding = true;
    delete run.approval;
    run.status = 'running';
    await persist(`approval.${decision.decision === 'approve' ? 'approved' : 'denied'}`);
    if (active !== ticket || pending.settled || ticket.abort.signal.aborted || generation !== pending.generation || pending.expires <= Date.now()
        || (ticket.offlinePolicy !== 'continue' && !ownerOnline)) {
      pending.settle(cancelled());
      throw new HttpError(409, 'Control or approval validity changed before dispatch.');
    }
    pending.settle(null, decision.decision === 'approve');
    return status();
  }
  function agentAttempt({ work, limits, observe, allowDesktop, redelegation, workBudget, validate, offlinePolicy = 'continue', draftGrant }) {
    if (!modelInfo().configured) throw new HttpError(503, 'The configured model is unavailable. Check model setup.');
    return acquire({
      input: allowDesktop, observe, limits, work, workBudget, validate, offlinePolicy, draftGrant,
      makeRun: () => ({
        id: randomUUID(), workId: work.id, kind: 'agent', goal: work.goal, allowDesktop, observe, offlinePolicy, model: modelInfo(),
        status: 'running', startedAt: now(), steps: [], ...(redelegation ? { redelegation } : {}),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, unknown: false },
        budget: { maxSteps: limits.maxSteps, maxDurationMs: limits.maxDurationMs, maxTokens: limits.maxTokens, maxOutputTokens: limits.maxOutputTokens, stepsUsed: 0, modelTurns: 0, toolSteps: 0, elapsedMs: 0 },
      }),
      executeRun: ticket => typeof model.execute === 'function' ? model.execute(executionContext(ticket)) : runAgent(executionContext(ticket)),
    });
  }
  function startTask(value = {}) {
    if (!object(value)) throw new HttpError(400, 'Task input must be an object.');
    const { goal, allowDesktop = false, observe, offlinePolicy, draftGrant } = value;
    if (typeof allowDesktop !== 'boolean') throw new HttpError(400, 'allowDesktop must be boolean.');
    return agentAttempt({
      work: createWork(goalText(goal), defaultLimits), limits: defaultLimits,
      observe: scopes(observe, allowDesktop, privateMode), allowDesktop, offlinePolicy, draftGrant,
    });
  }
  function findWork(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(400, 'Invalid work id.');
    const work = works.get(id);
    if (!work) throw new HttpError(404, 'Work not found.');
    return work;
  }
  function redelegate(id, value) {
    if (!object(value)) throw new HttpError(400, 'Redelegation settings are required.');
    if (!canStart() || owner !== 'human') throw new HttpError(409, 'Wait for confirmed human control and an available execution slot.');
    const work = findWork(id);
    const { allowDesktop = false, context = '', externalResult, offlinePolicy, draftGrant } = value;
    if (typeof allowDesktop !== 'boolean' || (externalResult !== undefined && !['confirmed', 'not_applied'].includes(externalResult))) {
      throw new HttpError(400, 'Invalid desktop or previous external result setting.');
    }
    const plan = planRedelegation(work, value, defaultLimits);
    return agentAttempt({
      ...plan, work, allowDesktop, offlinePolicy, draftGrant, observe: scopes(value.observe, allowDesktop, true),
      redelegation: { fromRunId: work.attempts.at(-1).id, context: goalText(context, true), ...(externalResult ? { externalResult } : {}) },
      validate: () => planRedelegation(work, value, defaultLimits),
    });
  }
  async function reconcile(id, value) {
    if (!canStart()) throw new HttpError(409, 'Wait for the active run to finish before reconciling usage.');
    const work = findWork(id);
    reconcileWork(work, value);
    await persist('work.usage_reconciled');
    return publicWork(work);
  }
  async function revokeGrant(id) {
    if (!active?.grant || active.runId !== id || active.intent) throw new HttpError(409, 'There is no live draft grant for this run.');
    const view = revokeDraftGrant(active.grant);
    run.grant = view;
    await persist('grant.revoked');
    return clone(view);
  }
  async function getRun(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(400, 'Invalid run id.');
    await writes;
    if (run?.id === id) return publicRun();
    let handle;
    try {
      handle = await open(path.join(runsDir, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new HttpError(500, 'Run history is invalid.');
      const value = JSON.parse(await handle.readFile('utf8'));
      if (value.id !== id || !Array.isArray(value.steps)) throw new HttpError(500, 'Run history is invalid.');
      return value;
    } catch (error) {
      if (['ENOENT', 'ELOOP'].includes(error.code)) throw new HttpError(404, 'Run not found.');
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, 'Run history could not be read.');
    } finally { await handle?.close(); }
  }
  async function listRuns({ limit = 20 } = {}) {
    const count = Number(limit);
    if (!Number.isInteger(count) || count < 1) throw new HttpError(400, 'History limit must be a positive integer.');
    await writes;
    const ids = (await readdir(runsDir)).filter(name => name.endsWith('.json') && UUID.test(name.slice(0, -5))).map(name => name.slice(0, -5));
    const fields = ['id', 'workId', 'kind', 'goal', 'allowDesktop', 'status', 'startedAt', 'finishedAt', 'usage', 'budget', 'error', 'errorCode'];
    const records = [];
    for (const id of ids) {
      const value = await getRun(id);
      records.push(Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]])));
    }
    return records.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '') || b.id.localeCompare(a.id)).slice(0, Math.min(count, 100));
  }
  async function stopIdleDesktop() {
    generation++;
    changeOwner('stopping');
    stop = fresh();
    notify();
    stop = await stopRuntime();
    changeOwner(stop.confirmed ? 'human' : 'unconfirmed');
    await persist(stop.confirmed ? 'control.human' : 'control.unconfirmed');
  }
  async function interrupt(action, expectedRunId) {
    const ticket = active;
    if (expectedRunId !== undefined && expectedRunId !== ticket?.runId && !(action === 'takeover' && !ticket && run?.id === expectedRunId)) {
      throw new HttpError(409, 'This run no longer owns the execution slot.');
    }
    if (action === 'pause' && run?.kind !== 'agent') throw new HttpError(409, 'Only an active agent work can be paused.');
    if (ticket) {
      const pause = run.kind === 'agent' && (action === 'pause' || action === 'takeover');
      beginStop(ticket, pause ? 'paused' : 'cancelled', pause ? 'owner_requested' : action);
      await ticket.done;
    } else if (action === 'pause') {
      throw new HttpError(409, 'There is no active run to pause.');
    } else if (action === 'takeover' || action === 'shutdown' || starting) {
      idleStop ??= stopIdleDesktop().finally(() => { idleStop = null; notify(); });
      await idleStop;
    }
    return status();
  }
  async function close() {
    if (closing) return;
    closing = true;
    clearTimeout(offlineTimer);
    await interrupt('shutdown').catch(() => {});
    await writes;
    await runtime.close?.();
    emitter.removeAllListeners();
  }
  return {
    status, startDemo, startTask, decideApproval, listRuns, getRun, redelegate, reconcile, setOwnerOnline, revokeGrant,
    getWork: id => publicWork(findWork(id)),
    listWorks: () => [...works.values()].reverse().slice(0, 100).map(work => publicWork(work)),
    takeover: id => interrupt('takeover', id), pause: id => interrupt('pause', id), cancel: id => interrupt('cancelled', id),
    desktopConnectable: () => !closing && (owner === 'human' || owner === 'automation'),
    close, events: emitter, notify,
  };
}
