import { randomUUID } from 'node:crypto';
import { HttpError } from './workspace.mjs';

const dimensions = [
  ['maxSteps', 'stepsUsed', 'remainingSteps', 'extraSteps'],
  ['maxDurationMs', 'elapsedMs', 'remainingDurationMs', 'extraDurationMs'],
  ['maxTokens', 'tokensUsed', 'remainingTokens', 'extraTokens'],
];
const positive = n => Number.isSafeInteger(n) && n > 0;
const nonnegative = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;

export function createWork(goal, limits) {
  const budget = Object.fromEntries(dimensions.map(([name]) => [name, limits[name]]));
  return { id: randomUUID(), goal, revision: 0, attempts: [], status: 'running', budget, createdAt: new Date().toISOString() };
}

export function recordAttempt(work, run) {
  const previous = work.attempts.at(-1);
  const attempt = {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    stepsUsed: nonnegative(run.budget?.stepsUsed),
    elapsedMs: nonnegative(run.budget?.elapsedMs),
    totalTokens: nonnegative(run.usage?.totalTokens),
    usageUnknown: run.usage?.unknown === true,
    ...(previous?.id === run.id && previous.reconciliation ? { reconciliation: previous.reconciliation } : {}),
  };
  if (previous?.id === run.id) work.attempts[work.attempts.length - 1] = attempt;
  else work.attempts.push(attempt);
  work.status = run.status === 'awaiting_approval' ? 'running' : run.status;
  if (run.handoff) work.handoff = run.handoff;
  work.revision++;
}

export function viewWork(work, currentRun) {
  const attempts = structuredClone(work.attempts);
  if (currentRun && attempts.at(-1)?.id === currentRun.id && ['running', 'awaiting_approval', 'finishing'].includes(currentRun.status)) {
    const attempt = attempts.at(-1);
    attempt.status = currentRun.status;
    attempt.elapsedMs = Math.max(attempt.elapsedMs, nonnegative(Date.now() - Date.parse(currentRun.startedAt)));
    attempt.stepsUsed = nonnegative(currentRun.budget?.stepsUsed);
    attempt.totalTokens = nonnegative(currentRun.usage?.totalTokens);
    attempt.usageUnknown = currentRun.usage?.unknown === true;
  }
  const totals = attempts.reduce((result, attempt) => {
    result.stepsUsed += attempt.stepsUsed;
    result.elapsedMs += attempt.elapsedMs;
    result.tokensUsed += attempt.reconciliation?.totalTokens ?? attempt.totalTokens;
    result.usageUnknown ||= attempt.usageUnknown && !attempt.reconciliation;
    return result;
  }, { stepsUsed: 0, elapsedMs: 0, tokensUsed: 0, usageUnknown: false });
  const budget = { ...work.budget, ...totals };
  for (const [cap, used, remaining] of dimensions) budget[remaining] = Math.max(0, budget[cap] - budget[used]);
  return structuredClone({
    id: work.id, goal: work.goal, status: work.status, revision: work.revision, createdAt: work.createdAt,
    latestRunId: attempts.at(-1)?.id, runIds: attempts.map(attempt => attempt.id), attempts, budget,
    ...(work.handoff ? { handoff: work.handoff } : {}),
  });
}

export function requireRevision(work, revision) {
  if (!positive(revision)) throw new HttpError(400, 'A current work revision is required.');
  if (work.revision !== revision) throw new HttpError(409, 'This work changed. Refresh it before acting.');
}

export function planRedelegation(work, supplied, caps) {
  requireRevision(work, supplied.revision);
  if (work.status !== 'paused') throw new HttpError(409, 'Only paused work can be redelegated.');
  const { budget, handoff } = viewWork(work);
  if (budget.usageUnknown) throw new HttpError(409, 'Reconcile the previous run usage before redelegating.');
  if (handoff?.unconfirmed.length && !['confirmed', 'not_applied'].includes(supplied.externalResult)) {
    throw new HttpError(409, 'Confirm the outcome of the previous external action before redelegating.');
  }
  const workBudget = { ...work.budget };
  const limits = { ...caps };
  for (const [cap, used, , extra] of dimensions) {
    const value = supplied[extra] ?? 0;
    if (value !== 0 && (!positive(value) || value > caps[cap] || !Number.isSafeInteger(workBudget[cap] + value))) {
      throw new HttpError(400, `Invalid additional budget: ${extra}.`);
    }
    workBudget[cap] += value;
    const remaining = workBudget[cap] - budget[used];
    if (remaining <= 0) throw new HttpError(409, `The work budget for ${cap} is exhausted. Authorize more budget explicitly.`);
    limits[cap] = Math.min(caps[cap], remaining);
  }
  limits.maxOutputTokens = Math.min(limits.maxOutputTokens, limits.maxTokens);
  return { workBudget, limits };
}

export function reconcileWork(work, { revision, runId, totalTokens }) {
  requireRevision(work, revision);
  const attempt = work.attempts.find(candidate => candidate.id === runId);
  if (!attempt?.usageUnknown || attempt.reconciliation || !attempt.finishedAt) {
    throw new HttpError(409, 'This run has no unsettled accounting to reconcile.');
  }
  if (!Number.isSafeInteger(totalTokens) || totalTokens < attempt.totalTokens) {
    throw new HttpError(400, 'The verified total must be an integer at least as large as the already reported usage.');
  }
  attempt.reconciliation = { totalTokens, at: new Date().toISOString() };
  work.revision++;
}

export function handoffFacts(run, reason, artifacts, stop) {
  const describe = step => ({ kind: step.kind ?? 'action', title: step.title, status: step.status,
    ...(step.tool ? { tool: step.tool } : {}), ...(step.effect ? { effect: step.effect } : {}) });
  const uncertain = step => step.effect === 'unconfirmed';
  return {
    reason, goal: run.goal, at: new Date().toISOString(), stop,
    completed: run.steps.filter(step => step.status === 'succeeded' && !uncertain(step)).map(describe),
    notExecuted: run.steps.filter(step => ['cancelled', 'pending'].includes(step.status) && !uncertain(step)).map(describe),
    unconfirmed: run.steps.filter(uncertain).map(describe),
    artifacts: artifacts.map(({ name, operation, status, sha256, bytes }) => ({ name, operation, status, sha256, bytes })),
  };
}
