import { attemptOptionsBody, attemptOptionsIssue, resetAttemptOptions, setAttemptOptionsDisabled, ownerStreamReady } from './owner.js';

const $ = id => document.getElementById(id);
const ids = ['mvp-panel', 'model-connection', 'model-metadata', 'model-test', 'model-message', 'agent-task-form', 'agent-goal', 'agent-observe-workspace', 'agent-observe-desktop', 'agent-allow-desktop', 'agent-submit', 'agent-approval', 'approval-summary', 'approval-preview', 'approval-expiry', 'approval-approve', 'approval-deny', 'agent-usage', 'agent-output', 'agent-history', 'history-refresh', 'history-list', 'history-detail'];
const ui = Object.fromEntries(ids.map(id => [id, $(id)]));
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'paused']);
const labels = { running: '运行中', awaiting_approval: '等待审批', finishing: '收尾中', paused: '已暂停', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
let state = null;
let fresh = false;
let version = 0;
let historyKey = '';
let historyRequest = 0;
let privateKey = '';
const busy = new Set();
const requests = new Set();
function message(text = '', error = false) { ui['model-message'].textContent = text; ui['model-message'].hidden = !text; ui['model-message'].classList.toggle('error', error); }
async function api(route, body, timeoutMs = 30000) {
  const controller = new AbortController(); requests.add(controller);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const current = version;
  try {
    const response = await fetch(route, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    if (current !== version) throw new Error('会话已变化。');
    const result = response.status === 204 ? null : await response.json();
    if (response.status === 401) window.dispatchEvent(new Event('pc-login-required'));
    if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : `请求失败（HTTP ${response.status}）。`);
    return result;
  } catch (error) { if (error.name === 'AbortError') throw new Error('请求已取消或超时，结果可能尚未完整报告。'); throw error; }
  finally { clearTimeout(timer); requests.delete(controller); }
}
const refresh = () => window.dispatchEvent(new Event('pc-refresh'));
function active() { return state?.run && !terminal.has(state.run.status); }
function canStart() { return fresh && !['stopping', 'unconfirmed'].includes(state?.control?.owner) && (typeof state?.canStart === 'boolean' ? state.canStart : !active()); }
function approval() { const run = state?.run; return run?.status === 'awaiting_approval' && run.approval?.runId === run.id ? run.approval : null; }
function controls() {
  const configured = state?.model?.configured === true;
  const restricted = state?.model?.lastErrorCode === 'client_not_allowed' && state?.model?.verified !== true;
  ui['model-test'].disabled = !configured || !canStart() || active() || busy.has('test');
  const optionsIssue = attemptOptionsIssue('agent');
  $('agent-options-help').textContent = optionsIssue; $('agent-options-help').hidden = !optionsIssue;
  ui['agent-submit'].disabled = !configured || restricted || !canStart() || active() || busy.size > 0 || Boolean(optionsIssue);
  setAttemptOptionsDisabled('agent', busy.has('task'));
  for (const id of ['agent-goal', 'agent-observe-workspace', 'agent-observe-desktop']) ui[id].disabled = busy.has('task');
  ui['agent-allow-desktop'].disabled = busy.has('task') || !ui['agent-observe-desktop'].checked;
  const pending = approval();
  const canApprove = fresh && pending && (!state.run?.offlinePolicy || state.run.offlinePolicy === 'continue' || ownerStreamReady()) && Date.parse(pending.expiresAt) > Date.now() && pending.generation === state.control.generation && !['stopping', 'unconfirmed'].includes(state.control.owner) && !busy.has('approval');
  ui['approval-approve'].disabled = !canApprove; ui['approval-deny'].disabled = !canApprove;
  if (pending) ui['approval-expiry'].textContent = Date.parse(pending.expiresAt) > Date.now() ? `剩余约 ${Math.ceil((Date.parse(pending.expiresAt) - Date.now()) / 1000)} 秒；审批绑定当前操作与控制权。` : '审批已过期。';
}
function resetTaskForm() { ui['agent-task-form'].reset(); resetAttemptOptions('agent'); }
function renderUsage() {
  const run = state?.run;
  ui['agent-usage'].hidden = !run?.budget;
  if (!run?.budget) return;
  const started = Date.parse(run.startedAt);
  const elapsed = active() && Number.isFinite(started) ? Date.now() - started : run.budget.elapsedMs;
  ui['agent-usage'].textContent = `本次执行：步骤 ${run.budget.stepsUsed ?? 0} / ${run.budget.maxSteps ?? '未知'}，已报告 token ${run.usage?.totalTokens ?? '未知'} / ${run.budget.maxTokens ?? '未知'}，约 ${Math.max(0, Math.round((elapsed || 0) / 1000))} 秒。${run.usage?.unknown ? '用量未完整报告；再次委托前须核对。' : ''}`;
}
function render() {
  ui['mvp-panel'].hidden = state?.phase !== 'mvp';
  if (state?.phase !== 'mvp') return;
  const model = state.model || {};
  document.querySelector('.phase-label').textContent = 'MVP · Responses';
  document.querySelector('.prototype-notice').textContent = '私人 MVP 验证 · 模型请求由你主动发起 · 尚非多租户生产服务';
  document.querySelector('[aria-labelledby="task-title"] .section-description').textContent = '当前任务与固定桌面演示共用任务槽；可暂停交接、取消任务或人工接管。';
  ui['model-connection'].textContent = !model.configured ? '未配置' : model.verified ? '已验证连通' : model.lastErrorCode ? '已配置 · 验证失败' : '已配置 · 待验证';
  ui['model-metadata'].textContent = model.configured ? `${model.model || ''} · ${model.executionProtocol === 'acp' ? 'DSH ACP / Responses' : 'Responses'} · 推理强度 ${model.reasoningEffort || '未知'}` : '请通过本地私密配置导入凭据，网页不读取或保存模型密钥。';
  if (model.lastErrorCode === 'client_not_allowed') message('模型网关未授权当前应用客户端（403 client_not_allowed）。请先在服务商侧开放标准 Responses 自定义应用访问，再点击测试。', true);
  const pending = approval();
  ui['agent-approval'].hidden = !pending;
  if (pending) {
    ui['approval-summary'].textContent = pending.summary || pending.toolName || pending.tool || '待审批操作';
    ui['approval-preview'].hidden = !pending.preview;
    ui['approval-preview'].textContent = pending.preview ? JSON.stringify(pending.preview, null, 2) : '';
  } else { ui['approval-preview'].textContent = ''; ui['approval-summary'].textContent = ''; }
  const run = state.run;
  ui['agent-output'].hidden = !run?.output; ui['agent-output'].textContent = typeof run?.output === 'string' ? run.output : '';
  renderUsage(); controls();
}
async function history() {
  if (!state || state.phase !== 'mvp') return;
  const current = version; const attempt = ++historyRequest;
  try {
    const result = await api('/api/tasks?limit=20');
    if (current !== version || attempt !== historyRequest) return;
    ui['history-list'].replaceChildren();
    for (const run of result.runs || []) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'history-item';
      button.textContent = `${labels[run.status] || run.status} · ${run.goal || '固定演示'}`;
      button.addEventListener('click', async () => {
        const selectedVersion = version; const selection = ++historyRequest;
        try {
          const detail = await api(`/api/tasks/${encodeURIComponent(run.id)}`);
          if (selectedVersion !== version || selection !== historyRequest) return;
          ui['history-detail'].hidden = false;
          const record = detail.run;
          ui['history-detail'].textContent = JSON.stringify({ goal: record.goal, status: record.status, output: record.output, error: record.error, usage: record.usage, budget: record.budget }, null, 2);
        } catch (error) { if (selectedVersion === version) message(error.message, true); }
      });
      ui['history-list'].append(button);
    }
    if (!result.runs?.length) ui['history-list'].textContent = '暂无任务历史。';
  } catch (error) { if (current === version) message(error.message, true); }
}
async function decide(decision) {
  const pending = approval(); if (!pending || busy.has('approval') || ui['approval-approve'].disabled) return;
  const runId = state.run.id; const current = version;
  busy.add('approval'); controls();
  try { await api(`/api/tasks/${encodeURIComponent(runId)}/approval`, { approvalId: pending.id, decision }); if (current === version) { message(decision === 'approve' ? '本次操作已批准。' : '已拒绝本次操作。'); refresh(); } }
  catch (error) { if (current === version) message(error.message, true); }
  finally { if (current === version) { busy.delete('approval'); controls(); } }
}
ui['approval-approve'].addEventListener('click', () => decide('approve'));
ui['approval-deny'].addEventListener('click', () => decide('deny'));
ui['agent-observe-workspace'].addEventListener('change', controls);
ui['agent-observe-desktop'].addEventListener('change', () => { if (!ui['agent-observe-desktop'].checked) ui['agent-allow-desktop'].checked = false; controls(); });
ui['agent-task-form'].addEventListener('submit', async event => {
  event.preventDefault(); if (ui['agent-submit'].disabled) return;
  const goal = ui['agent-goal'].value.trim(); if (!goal || goal.length > 4000) return message('请填写 1–4000 字符的任务目标。', true);
  const body = { goal, allowDesktop: ui['agent-allow-desktop'].checked, observe: { workspace: ui['agent-observe-workspace'].checked, desktop: ui['agent-observe-desktop'].checked }, ...attemptOptionsBody('agent') };
  const current = version; busy.add('task'); controls(); window.dispatchEvent(new Event('pc-control-pending'));
  try {
    await api('/api/tasks', body);
    if (current === version) { resetTaskForm(); message('任务已创建，仅使用本次明确选择的观察范围。'); refresh(); }
  } catch (error) { if (current === version) { message(error.message, true); refresh(); } }
  finally { if (current === version) { busy.delete('task'); controls(); window.dispatchEvent(new Event('pc-control-settled')); } }
});
ui['model-test'].addEventListener('click', async () => {
  if (ui['model-test'].disabled) return;
  const current = version; busy.add('test'); controls(); message('正在发送一次显式模型连接测试…');
  try { const result = await api('/api/model/test', {}, 120000); if (current === version) message(`连接测试通过：${result.model} / ${result.reasoningEffort}，已报告 token ${result.usage?.totalTokens ?? '未知'}。`); }
  catch (error) { if (current === version) message(error.message, true); }
  finally { if (current === version) { busy.delete('test'); controls(); refresh(); } }
});
ui['history-refresh'].addEventListener('click', history);
window.addEventListener('pc-state', event => {
  state = event.detail; fresh = true;
  const nextPrivateKey = `${state?.control?.generation}:${state?.control?.private === true}`;
  if (privateKey !== nextPrivateKey && state?.control?.private === true) resetTaskForm();
  privateKey = nextPrivateKey;
  render();
  const key = `${state?.run?.id}:${state?.run?.status}`;
  if (key !== historyKey) { historyKey = key; void history(); }
});
window.addEventListener('pc-state-freshness', event => { fresh = event.detail === true; controls(); });
window.addEventListener('pc-auth', event => {
  if (event.detail !== false) return;
  version++; historyRequest++; state = null; fresh = false; historyKey = ''; privateKey = ''; busy.clear();
  for (const request of requests) request.abort(); requests.clear();
  ui['mvp-panel'].hidden = true; resetTaskForm(); ui['approval-preview'].textContent = ''; ui['agent-output'].textContent = ''; ui['history-detail'].textContent = ''; ui['history-list'].replaceChildren(); message(); controls();
});
window.addEventListener('pc-attempt-options', event => { if (event.detail === 'agent') controls(); });
window.addEventListener('pc-task-template', event => {
  const goal = event.detail?.goal;
  if (busy.has('task') || typeof goal !== 'string' || !goal.trim() || goal.length > 4000) return;
  resetTaskForm(); ui['agent-goal'].value = goal; controls(); message('模板目标已填入新任务；请重新选择这次观察范围和授权，再手动开始。');
  ui['agent-task-form'].scrollIntoView({ block: 'start' }); ui['agent-goal'].focus();
});
setInterval(() => { if (state?.phase === 'mvp') { controls(); renderUsage(); } }, 1000);
