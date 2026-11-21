import { attemptOptionsBody, attemptOptionsIssue, resetAttemptOptions, setAttemptOptionsDisabled } from './owner.js';

const $ = id => document.getElementById(id);
const ids = ['handoff-panel', 'works-refresh', 'work-empty', 'work-select', 'work-detail', 'work-goal', 'work-status', 'work-budget', 'handoff-facts', 'usage-form', 'usage-run', 'usage-total', 'usage-submit', 'redelegate-form', 'work-context', 'work-scope-none', 'work-scope-current', 'work-observe-workspace', 'work-observe-desktop', 'work-allow-desktop', 'external-result-fields', 'external-confirmed', 'external-not-applied', 'extra-tokens', 'extra-steps', 'extra-duration', 'redelegate-help', 'redelegate-submit', 'handoff-message', 'artifact-panel', 'artifacts-refresh', 'artifact-run', 'artifacts-empty', 'artifact-list', 'artifact-review', 'artifact-review-title', 'artifact-diff-note', 'artifact-diff', 'artifact-accept', 'artifact-message', 'recovery-panel', 'recovery-refresh', 'recovery-empty', 'recovery-list', 'recovery-message'];
const ui = Object.fromEntries(ids.map(id => [id, $(id)]));
const labels = { running: '运行中', awaiting_approval: '等待审批', finishing: '收尾中', paused: '已暂停', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', pending: '待确认', available: '可恢复', restored: '已恢复', conflict: '恢复冲突', added: '新增', modified: '修改', deleted: '删除' };
let state = null;
let fresh = false;
let session = 0;
let workSelection = 0;
let artifactSelection = 0;
let artifactRequest = 0;
let worksRequest = 0;
let recoveryRequest = 0;
let selectedWorkId = '';
let formKey = '';
let stateKey = '';
let artifactsKey = '';
let artifacts = [];
let reviewed = null;
let recovery = [];
const works = new Map();
const busy = new Set();
const requests = new Set();
const encode = encodeURIComponent;
const refresh = () => window.dispatchEvent(new Event('pc-refresh'));
const currentWork = () => works.get(selectedWorkId) || null;
const isCurrent = value => value === session && state !== null;
function message(id, text = '', error = false) { ui[id].textContent = text; ui[id].hidden = !text; ui[id].classList.toggle('error', error); }
async function api(path, body, blob = false) {
  const version = session;
  const controller = new AbortController(); requests.add(controller);
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    if (!isCurrent(version)) throw new Error('会话已变化。');
    if (response.status === 401) window.dispatchEvent(new Event('pc-login-required'));
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      const error = new Error(typeof result?.error === 'string' ? result.error : `请求失败（HTTP ${response.status}）。`);
      error.status = response.status; throw error;
    }
    return blob ? await response.blob() : response.status === 204 ? null : await response.json();
  } catch (error) { if (error.name === 'AbortError') throw new Error('请求已取消或超时，请刷新后确认服务端结果。'); throw error; }
  finally { clearTimeout(timer); requests.delete(controller); }
}
function mergeWork(work, fromState = false) {
  if (!work || typeof work.id !== 'string' || !Number.isSafeInteger(work.revision)) return;
  const previous = works.get(work.id);
  if (!previous || work.revision > previous.revision || (fromState && work.revision === previous.revision)) works.set(work.id, work);
}
function selectOptions(element, items, value) {
  element.replaceChildren();
  for (const [id, title] of items) { const option = document.createElement('option'); option.value = id; option.textContent = title; element.append(option); }
  element.value = items.some(item => item[0] === value) ? value : items[0]?.[0] || '';
}
function resetReview() {
  reviewed = null; artifactSelection++; busy.delete('diff');
  ui['artifact-review'].hidden = true; ui['artifact-diff'].textContent = ''; ui['artifact-diff-note'].textContent = '';
  ui['artifact-accept'].disabled = true;
}
function resetForm() {
  ui['redelegate-form'].reset(); ui['usage-form'].reset(); resetAttemptOptions('work'); controls();
}
function factText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return [value.title || value.name || value.kind, value.tool, value.status, typeof value.effect === 'string' ? value.effect : ''].filter(part => typeof part === 'string' && part).join(' · ');
}
function renderFacts(handoff) {
  ui['handoff-facts'].replaceChildren();
  ui['handoff-facts'].hidden = !handoff;
  if (!handoff) return;
  const reason = document.createElement('p'); reason.textContent = `交接原因：${typeof handoff.reason === 'string' ? labels[handoff.reason] || handoff.reason : '未提供'}`; ui['handoff-facts'].append(reason);
  if (typeof handoff.goal === 'string') { const goal = document.createElement('p'); goal.textContent = `工作目标：${handoff.goal}`; ui['handoff-facts'].append(goal); }
  for (const [key, label] of [['completed', '已经完成'], ['artifacts', '已有文件'], ['notExecuted', '没有执行'], ['unconfirmed', '尚未确认']]) {
    const title = document.createElement('p'); title.className = 'fact-label'; title.textContent = label; ui['handoff-facts'].append(title);
    const values = Array.isArray(handoff[key]) ? handoff[key].map(factText).filter(Boolean) : [];
    if (!values.length) { const none = document.createElement('p'); none.textContent = '无记录'; ui['handoff-facts'].append(none); continue; }
    const list = document.createElement('ul');
    for (const text of values) { const item = document.createElement('li'); item.textContent = text; list.append(item); }
    ui['handoff-facts'].append(list);
  }
}
function extraValue(id, multiplier = 1) {
  if (!ui[id].value.trim()) return 0;
  const value = Number(ui[id].value) * multiplier;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function extras() { return { extraTokens: extraValue('extra-tokens'), extraSteps: extraValue('extra-steps'), extraDurationMs: extraValue('extra-duration', 1000) }; }
function needsExternal(work) { return Array.isArray(work?.handoff?.unconfirmed) && work.handoff.unconfirmed.length > 0; }
function usageAttempts(work) {
  if (Array.isArray(work?.attempts)) return work.attempts.filter(attempt => attempt?.usageUnknown === true && !attempt.reconciliation && attempt.finishedAt && typeof attempt.id === 'string');
  return (Array.isArray(work?.runIds) ? work.runIds : []).filter(id => typeof id === 'string').map(id => ({ id, totalTokens: 0 }));
}
function externalResult() { return ui['external-confirmed'].checked ? 'confirmed' : ui['external-not-applied'].checked ? 'not_applied' : null; }
function remaining(budget, key, max, used) { return typeof budget?.[key] === 'number' ? budget[key] : typeof budget?.[max] === 'number' && typeof budget?.[used] === 'number' ? Math.max(0, budget[max] - budget[used]) : null; }
function redelegateIssue() {
  const work = currentWork();
  if (!work) return '请选择工作。';
  if (!fresh) return '状态待确认，请先重连状态。';
  if (state.canStart !== true || ['stopping', 'unconfirmed'].includes(state.control?.owner)) return '等待当前执行收尾和停止确认。';
  if (work.status !== 'paused') return '只有已暂停的工作可以再次委托。';
  const optionsIssue = attemptOptionsIssue('work'); if (optionsIssue) return optionsIssue;
  if (work.budget?.usageUnknown !== false) return '用量未完整报告，请先补记已核对的用量。';
  if (!ui['work-scope-none'].checked && !ui['work-scope-current'].checked) return '请明确选择这次是否重新观察当前范围。';
  if (ui['work-scope-current'].checked && !ui['work-observe-workspace'].checked && !ui['work-observe-desktop'].checked) return '请至少选择一个当前观察范围，或选择仅使用交接说明。';
  if (needsExternal(work) && !externalResult()) return '请先核对尚未确认的外部操作。';
  const extra = extras();
  if (Object.values(extra).some(value => value === null)) return '追加预算须为非负整数。';
  for (const [key, max, used, add] of [['remainingTokens', 'maxTokens', 'tokensUsed', 'extraTokens'], ['remainingSteps', 'maxSteps', 'stepsUsed', 'extraSteps'], ['remainingDurationMs', 'maxDurationMs', 'elapsedMs', 'extraDurationMs']]) {
    const left = remaining(work.budget, key, max, used);
    if (left === null || !Number.isSafeInteger(left + extra[add]) || left + extra[add] <= 0) return '工作预算已耗尽或追加额度无效；请为相应额度填写明确预算。';
  }
  return '';
}
function controls() {
  const work = currentWork();
  const busyWork = busy.has('redelegate') || busy.has('usage');
  setAttemptOptionsDisabled('work', busyWork);
  const selectedScope = ui['work-scope-current'].checked;
  for (const id of ['work-context', 'work-scope-none', 'work-scope-current', 'extra-tokens', 'extra-steps', 'extra-duration', 'external-confirmed', 'external-not-applied']) ui[id].disabled = busyWork;
  for (const id of ['work-observe-workspace', 'work-observe-desktop']) ui[id].disabled = busyWork || !selectedScope;
  ui['work-allow-desktop'].disabled = busyWork || !selectedScope || !ui['work-observe-desktop'].checked;
  const issue = redelegateIssue();
  ui['redelegate-help'].textContent = issue || '仅使用这次填写的说明与选中的当前范围，原有预算会累计使用。';
  ui['redelegate-submit'].disabled = busyWork || Boolean(issue);
  ui['redelegate-submit'].textContent = busy.has('redelegate') ? '正在再次委托…' : '按本次范围再次委托';
  const total = ui['usage-total'].value.trim() ? Number(ui['usage-total'].value) : null;
  const attempt = usageAttempts(work).find(item => item.id === ui['usage-run'].value);
  const reported = Number.isSafeInteger(attempt?.totalTokens) && attempt.totalTokens >= 0 ? attempt.totalTokens : 0;
  ui['usage-total'].min = String(reported);
  ui['usage-submit'].disabled = !fresh || !work || work.budget?.usageUnknown !== true || state?.canStart !== true || busyWork || !attempt || !Number.isSafeInteger(total) || total < reported;
  ui['usage-run'].disabled = busyWork; ui['usage-total'].disabled = busyWork;
  ui['work-select'].disabled = busyWork; ui['works-refresh'].disabled = busy.has('works') || busyWork;
  ui['artifacts-refresh'].disabled = !ui['artifact-run'].value || busy.has('artifacts') || busy.has('accept');
  ui['artifact-run'].disabled = busy.has('accept');
  ui['artifact-accept'].disabled = !fresh || state?.canStart !== true || !reviewed || reviewed.status !== 'staged' || !reviewed.version || busy.has('accept') || busy.has('diff');
  ui['artifact-accept'].textContent = busy.has('accept') ? '正在接受…' : '接受这个版本';
  ui['recovery-refresh'].disabled = busy.has('recovery') || busy.has('restore');
  for (const button of ui['recovery-list'].querySelectorAll('button')) button.disabled = !fresh || state?.canStart !== true || busy.has('restore');
}
function renderWork() {
  const work = currentWork();
  selectOptions(ui['work-select'], [...works.values()].map(item => [item.id, `${labels[item.status] || item.status || '工作'} · ${item.goal || item.id}`]), selectedWorkId);
  selectedWorkId = ui['work-select'].value;
  window.dispatchEvent(new CustomEvent('pc-work-selected', { detail: currentWork() }));
  ui['work-empty'].hidden = Boolean(work); ui['work-detail'].hidden = !work;
  if (!work) { controls(); renderArtifactRuns(); return; }
  const key = `${work.id}:${work.revision}:${state?.control?.generation}:${state?.control?.private === true}`;
  if (formKey !== key) { formKey = key; resetForm(); }
  ui['work-goal'].textContent = typeof work.goal === 'string' ? work.goal : '';
  ui['work-status'].textContent = `${labels[work.status] || work.status || '未知状态'} · 版本 ${work.revision} · ${Array.isArray(work.runIds) ? work.runIds.length : 0} 次执行`;
  const budget = work.budget || {};
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '未知';
  ui['work-budget'].textContent = `累计 token ${number(budget.tokensUsed)} / ${number(budget.maxTokens)}，剩余 ${number(budget.remainingTokens)}；步骤 ${number(budget.stepsUsed)} / ${number(budget.maxSteps)}，剩余 ${number(budget.remainingSteps)}；时间 ${number(typeof budget.elapsedMs === 'number' ? Math.round(budget.elapsedMs / 1000) : null)} / ${number(typeof budget.maxDurationMs === 'number' ? Math.round(budget.maxDurationMs / 1000) : null)} 秒。${budget.usageUnknown ? '用量未完整报告。' : ''}`;
  renderFacts(work.handoff || (state?.run?.id === work.latestRunId ? state.run.handoff : null));
  ui['usage-form'].hidden = budget.usageUnknown !== true;
  const attempts = usageAttempts(work);
  selectOptions(ui['usage-run'], attempts.map(attempt => [attempt.id, attempt.id === work.latestRunId ? `最近一次 · ${attempt.id}` : attempt.id]), ui['usage-run'].value || work.latestRunId);
  ui['external-result-fields'].hidden = !needsExternal(work);
  renderArtifactRuns(); controls();
}
async function loadWorks() {
  if (state?.phase !== 'mvp') return;
  const version = session; const attempt = ++worksRequest;
  busy.add('works'); controls();
  try {
    const result = await api('/api/works');
    if (!isCurrent(version) || attempt !== worksRequest) return;
    if (!Array.isArray(result?.works)) throw new Error('服务端未返回工作列表。');
    for (const work of result.works) mergeWork(work);
    if (!selectedWorkId) selectedWorkId = state?.work?.id || result.works[0]?.id || '';
    renderWork();
  } catch (error) { if (isCurrent(version) && attempt === worksRequest) message('handoff-message', error.status === 404 ? '当前服务尚未提供工作交接。' : error.message, error.status !== 404); }
  finally { if (isCurrent(version) && attempt === worksRequest) { busy.delete('works'); controls(); } }
}
async function selectWork(id) {
  selectedWorkId = id; const selection = ++workSelection; const version = session;
  resetReview(); renderWork(); message('handoff-message');
  if (!id) return;
  try {
    const result = await api(`/api/works/${encode(id)}`);
    if (!isCurrent(version) || selection !== workSelection || selectedWorkId !== id) return;
    mergeWork(result.work); renderWork();
  } catch (error) { if (isCurrent(version) && selection === workSelection) message('handoff-message', error.message, true); }
}
function renderArtifactRuns() {
  const work = currentWork();
  const ids = Array.isArray(work?.runIds) ? work.runIds.filter(id => typeof id === 'string') : state?.run?.kind === 'agent' && state.run.id ? [state.run.id] : [];
  const previous = ui['artifact-run'].value;
  selectOptions(ui['artifact-run'], [...ids].reverse().map(id => [id, id === work?.latestRunId ? `最近一次 · ${id}` : id]), previous);
  if (ui['artifact-run'].value !== previous || artifactsKey !== `${ui['artifact-run'].value}:${work?.revision}`) {
    artifactsKey = `${ui['artifact-run'].value}:${work?.revision}`; resetReview(); artifacts = []; renderArtifacts();
    if (ui['artifact-run'].value) void loadArtifacts();
  }
}
function renderArtifacts() {
  ui['artifact-list'].replaceChildren(); ui['artifacts-empty'].hidden = artifacts.length > 0;
  for (const artifact of artifacts) {
    const item = document.createElement('li'); item.className = 'artifact-item';
    const title = document.createElement('span'); title.className = 'file-name'; title.textContent = artifact.name;
    const meta = document.createElement('span'); meta.className = 'file-meta'; meta.textContent = `${labels[artifact.operation] || artifact.operation || '文件'} · ${artifact.status === 'accepted' ? '已接受' : '待验收'} · ${artifact.bytes ?? 0} B`;
    const actions = document.createElement('div'); actions.className = 'task-actions';
    const review = document.createElement('button'); review.type = 'button'; review.textContent = '查看差异'; review.setAttribute('aria-label', `查看 ${artifact.name} 的差异`); review.addEventListener('click', () => void reviewArtifact(artifact));
    const download = document.createElement('button'); download.type = 'button'; download.textContent = '下载'; download.setAttribute('aria-label', `下载待验收文件 ${artifact.name}`); download.addEventListener('click', () => void downloadArtifact(artifact, download));
    actions.append(review, download); item.append(title, meta, actions); ui['artifact-list'].append(item);
  }
  controls();
}
async function loadArtifacts() {
  const runId = ui['artifact-run'].value; if (!runId || busy.has('accept')) return;
  const version = session; const attempt = ++artifactRequest;
  busy.add('artifacts'); controls();
  try {
    const result = await api(`/api/tasks/${encode(runId)}/artifacts`);
    if (!isCurrent(version) || attempt !== artifactRequest || runId !== ui['artifact-run'].value) return;
    if (!Array.isArray(result?.artifacts)) throw new Error('服务端未返回待验收文件列表。');
    artifacts = result.artifacts.filter(item => item && typeof item.name === 'string');
    if (reviewed && !artifacts.some(item => item.name === reviewed.name && item.version === reviewed.version && item.status === reviewed.status)) resetReview();
    renderArtifacts();
  } catch (error) { if (isCurrent(version) && attempt === artifactRequest && runId === ui['artifact-run'].value) message('artifact-message', error.message, true); }
  finally { if (isCurrent(version) && attempt === artifactRequest) { busy.delete('artifacts'); controls(); } }
}
async function reviewArtifact(artifact) {
  if (busy.has('accept')) return;
  resetReview(); const selection = artifactSelection; const version = session; const runId = ui['artifact-run'].value;
  busy.add('diff'); controls(); message('artifact-message');
  try {
    const result = await api(`/api/tasks/${encode(runId)}/artifacts/${encode(artifact.name)}/diff`);
    if (!isCurrent(version) || selection !== artifactSelection || runId !== ui['artifact-run'].value || !artifacts.some(item => item.name === artifact.name && item.version === artifact.version)) return;
    if (!result?.diff || typeof result.diff.text !== 'string') throw new Error('服务端未返回可查看的差异。');
    reviewed = { ...artifact, runId };
    ui['artifact-review'].hidden = false; ui['artifact-review-title'].textContent = artifact.name;
    ui['artifact-diff-note'].textContent = [result.diff.binary ? '二进制文件，无法逐行预览；可先下载核对。' : '', result.diff.truncated ? '差异预览已截断；请下载核对完整版本。' : '', artifact.status === 'accepted' ? '这个版本已接受。' : '接受时会核对这个待验收版本与当前工作区版本。'].filter(Boolean).join(' ');
    ui['artifact-diff'].textContent = result.diff.text || '无文本差异。';
  } catch (error) { if (isCurrent(version) && selection === artifactSelection) message('artifact-message', error.message, true); }
  finally { if (isCurrent(version) && selection === artifactSelection) { busy.delete('diff'); controls(); } }
}
async function downloadArtifact(artifact, button) {
  const version = session; const runId = ui['artifact-run'].value; button.disabled = true;
  try {
    const blob = await api(`/api/tasks/${encode(runId)}/artifacts/${encode(artifact.name)}/download`, undefined, true);
    if (!isCurrent(version)) return;
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = artifact.name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    message('artifact-message', `已请求下载：${artifact.name}`);
  } catch (error) { if (isCurrent(version)) message('artifact-message', error.message, true); }
  finally { if (isCurrent(version)) button.disabled = false; }
}
async function acceptArtifact() {
  if (ui['artifact-accept'].disabled || !reviewed) return;
  const artifact = reviewed; const version = session; busy.add('accept'); controls();
  try {
    await api(`/api/tasks/${encode(artifact.runId)}/artifacts/${encode(artifact.name)}/accept`, { expectedVersion: artifact.version });
    if (!isCurrent(version)) return;
    message('artifact-message', `已接受：${artifact.name}`); resetReview(); refresh();
  } catch (error) {
    if (!isCurrent(version)) return;
    if (error.status === 409) resetReview();
    message('artifact-message', error.status === 409 ? '文件版本已变化，未覆盖工作区。请刷新并重新查看差异后再接受；待验收版本仍可下载。' : error.message, true);
  } finally {
    if (isCurrent(version)) { busy.delete('accept'); await loadArtifacts(); await loadRecovery(); controls(); }
  }
}
function renderRecovery() {
  ui['recovery-list'].replaceChildren(); ui['recovery-empty'].hidden = recovery.length > 0;
  for (const entry of recovery) {
    const item = document.createElement('li'); item.className = 'artifact-item';
    const name = document.createElement('span'); name.className = 'file-name'; name.textContent = entry.name;
    const meta = document.createElement('span'); meta.className = 'file-meta'; meta.textContent = `${labels[entry.operation] || entry.operation || '文件'} · ${labels[entry.status] || entry.status || '未知状态'}`;
    item.append(name, meta);
    if (entry.status === 'available') {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '恢复此前版本'; button.setAttribute('aria-label', `恢复 ${entry.name} 的此前版本`); button.addEventListener('click', () => void restore(entry)); item.append(button);
    }
    ui['recovery-list'].append(item);
  }
  controls();
}
async function loadRecovery() {
  if (state?.phase !== 'mvp') return;
  const version = session; const attempt = ++recoveryRequest; busy.add('recovery'); controls();
  try {
    const result = await api('/api/recovery');
    if (!isCurrent(version) || attempt !== recoveryRequest) return;
    if (!Array.isArray(result?.recovery)) throw new Error('服务端未返回恢复记录。');
    recovery = result.recovery.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string'); renderRecovery();
  } catch (error) { if (isCurrent(version) && attempt === recoveryRequest) message('recovery-message', error.status === 404 ? '当前服务尚未提供文件恢复。' : error.message, error.status !== 404); }
  finally { if (isCurrent(version) && attempt === recoveryRequest) { busy.delete('recovery'); controls(); } }
}
async function restore(entry) {
  if (!fresh || state?.canStart !== true || busy.has('restore')) return;
  const version = session; busy.add('restore'); controls();
  try { await api(`/api/recovery/${encode(entry.id)}/restore`, {}); if (isCurrent(version)) { message('recovery-message', `已恢复：${entry.name}`); refresh(); } }
  catch (error) { if (isCurrent(version)) message('recovery-message', error.status === 409 ? '工作区已有后续修改，恢复未覆盖现场。请先保留并核对当前文件。' : error.message, true); }
  finally { if (isCurrent(version)) { busy.delete('restore'); await loadRecovery(); controls(); } }
}
ui['redelegate-form'].addEventListener('submit', async event => {
  event.preventDefault(); controls(); if (ui['redelegate-submit'].disabled) return;
  const work = currentWork(); const version = session; const observe = ui['work-scope-current'].checked ? { workspace: ui['work-observe-workspace'].checked, desktop: ui['work-observe-desktop'].checked } : { workspace: false, desktop: false };
  const body = { revision: work.revision, context: ui['work-context'].value, observe, allowDesktop: observe.desktop && ui['work-allow-desktop'].checked, ...attemptOptionsBody('work') };
  if (needsExternal(work)) body.externalResult = externalResult();
  for (const [key, value] of Object.entries(extras())) if (value > 0) body[key] = value;
  busy.add('redelegate'); controls(); window.dispatchEvent(new Event('pc-control-pending'));
  try { await api(`/api/works/${encode(work.id)}/redelegate`, body); if (isCurrent(version)) { resetForm(); message('handoff-message', '已按这次明确选择的范围再次委托。'); refresh(); } }
  catch (error) { if (isCurrent(version)) { message('handoff-message', error.status === 409 ? '工作状态或版本已变化，请刷新并重新选择本次范围。' : error.message, true); resetForm(); refresh(); await loadWorks(); } }
  finally { if (isCurrent(version)) { busy.delete('redelegate'); controls(); window.dispatchEvent(new Event('pc-control-settled')); } }
});
ui['usage-form'].addEventListener('submit', async event => {
  event.preventDefault(); controls(); if (ui['usage-submit'].disabled) return;
  const work = currentWork(); const version = session; busy.add('usage'); controls();
  try { const result = await api(`/api/works/${encode(work.id)}/usage`, { revision: work.revision, runId: ui['usage-run'].value, totalTokens: Number(ui['usage-total'].value) }); if (isCurrent(version)) { mergeWork(result?.work); ui['usage-total'].value = ''; renderWork(); message('handoff-message', '已补记该次执行的核对用量，请确认其他执行也已核对。'); refresh(); await loadWorks(); } }
  catch (error) { if (isCurrent(version)) { message('handoff-message', error.message, true); refresh(); await loadWorks(); } }
  finally { if (isCurrent(version)) { busy.delete('usage'); controls(); } }
});
for (const id of ['work-scope-none', 'work-scope-current', 'work-observe-workspace', 'work-observe-desktop', 'work-allow-desktop', 'external-confirmed', 'external-not-applied', 'extra-tokens', 'extra-steps', 'extra-duration', 'usage-total']) ui[id].addEventListener('input', () => {
  if (!ui['work-scope-current'].checked) { ui['work-observe-workspace'].checked = false; ui['work-observe-desktop'].checked = false; }
  if (!ui['work-observe-desktop'].checked) ui['work-allow-desktop'].checked = false;
  controls();
});
ui['usage-run'].addEventListener('change', () => { ui['usage-total'].value = ''; controls(); });
ui['works-refresh'].addEventListener('click', () => void loadWorks());
ui['work-select'].addEventListener('change', () => void selectWork(ui['work-select'].value));
ui['artifact-run'].addEventListener('change', () => { resetReview(); artifacts = []; renderArtifacts(); void loadArtifacts(); });
ui['artifacts-refresh'].addEventListener('click', () => { resetReview(); void loadArtifacts(); });
ui['artifact-accept'].addEventListener('click', () => void acceptArtifact());
ui['recovery-refresh'].addEventListener('click', () => void loadRecovery());
window.addEventListener('pc-attempt-options', event => { if (event.detail === 'work') controls(); });
window.addEventListener('pc-open-work', async event => {
  const { workId, runId, kind } = event.detail || {};
  if (busy.has('redelegate') || busy.has('usage') || busy.has('accept')) return;
  if (typeof workId === 'string') await selectWork(workId);
  if (typeof runId === 'string' && [...ui['artifact-run'].options].some(option => option.value === runId)) {
    ui['artifact-run'].value = runId; resetReview(); void loadArtifacts();
  }
  const target = kind === 'artifacts' ? ui['artifact-panel'] : kind === 'usage' ? ui['usage-form'] : ui['handoff-panel'];
  target.scrollIntoView({ block: 'start' });
});
window.addEventListener('pc-state', event => {
  state = event.detail; fresh = true;
  const enabled = state?.phase === 'mvp';
  for (const id of ['handoff-panel', 'artifact-panel', 'recovery-panel']) ui[id].hidden = !enabled;
  if (!enabled) return;
  mergeWork(state.work, true);
  if (!selectedWorkId && state.work?.id) selectedWorkId = state.work.id;
  renderWork();
  const key = `${state?.work?.id}:${state?.work?.revision}:${state?.run?.id}:${state?.run?.status}`;
  if (stateKey !== key) { stateKey = key; void loadWorks(); void loadRecovery(); if (ui['artifact-run'].value) void loadArtifacts(); }
});
window.addEventListener('pc-state-freshness', event => { fresh = event.detail === true; controls(); });
window.addEventListener('pc-auth', event => {
  if (event.detail !== false) return;
  session++; workSelection++; artifactSelection++; artifactRequest++; worksRequest++; recoveryRequest++;
  for (const request of requests) request.abort(); requests.clear();
  state = null; fresh = false; selectedWorkId = ''; formKey = ''; stateKey = ''; artifactsKey = ''; artifacts = []; recovery = []; works.clear(); busy.clear();
  resetReview(); resetForm(); ui['artifact-list'].replaceChildren(); ui['recovery-list'].replaceChildren(); ui['handoff-facts'].replaceChildren();
  for (const id of ['work-goal', 'work-budget', 'work-status']) ui[id].textContent = '';
  for (const id of ['handoff-panel', 'artifact-panel', 'recovery-panel']) ui[id].hidden = true;
  for (const id of ['handoff-message', 'artifact-message', 'recovery-message']) message(id);
});
