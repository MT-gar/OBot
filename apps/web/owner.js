const $ = id => document.getElementById(id);
const prefixes = ['agent', 'work'];
const policyLabels = { continue: '断线后继续运行', pause_at_approval: '断线后在审批点暂停', stop: '断线后停止任务' };
const grantLabels = { active: '有效', exhausted: '额度已用完', revoked: '已撤销', expired: '已到期' };
const inboxLabels = { approval: '需要人工决定', handoff: '工作交接', usage: '用量待核对', artifacts: '文件待验收', failure: '执行问题', backup: '备份状态' };
let state = null;
let fresh = false;
let connected = false;
let session = 0;
let inboxRequest = 0;
let templatesRequest = 0;
let selectedWork = null;
let stateKey = '';
let templates = [];
const busy = new Set();
const requests = new Set();
const notifyOptions = prefix => window.dispatchEvent(new CustomEvent('pc-attempt-options', { detail: prefix }));
const refresh = () => window.dispatchEvent(new Event('pc-refresh'));
function message(id, text = '', error = false) { const element = $(id); element.textContent = text; element.hidden = !text; element.classList.toggle('error', error); }
function installOptions(prefix) {
  const mount = $(`${prefix}-attempt-options`);
  mount.innerHTML = `<details id="${prefix}-options-details" class="attempt-options"><summary>本次断线策略与草稿授权（可选）</summary><div class="attempt-option-fields">
    <label for="${prefix}-offline-policy">状态页断开后的处理</label><select id="${prefix}-offline-policy" autocomplete="off"><option value="">默认：继续运行</option><option value="continue">继续运行</option><option value="pause_at_approval">在审批点暂停</option><option value="stop">停止任务</option></select>
    <p class="fine-print">断线后服务端先等待 3 秒重连。选择暂停或停止前，状态推送必须已连接；这次选择不会沿用到下次任务。</p>
    <label class="desktop-consent"><input id="${prefix}-grant-enabled" type="checkbox" autocomplete="off">为本次任务授予有限的草稿写入权限</label>
    <p class="fine-print">需要明确选中本次观察当前工作区；仅允许下方确切文件名的私有待验收草稿写入。不会授权读取、删除或修改已接受的工作区文件；草稿仍需逐个验收。</p>
    <div id="${prefix}-grant-fields" class="draft-grant-fields" hidden><label for="${prefix}-grant-names">确切文件名，每行一个（最多 128 个，不含目录）</label><textarea id="${prefix}-grant-names" rows="3" maxlength="32768" autocomplete="off" placeholder="report.md"></textarea>
    <label for="${prefix}-grant-writes">最多写入次数（1–100）</label><input id="${prefix}-grant-writes" type="number" min="1" max="100" step="1" inputmode="numeric" autocomplete="off">
    <label for="${prefix}-grant-bytes">累计写入字节（1–10485760，最多 10 MiB）</label><input id="${prefix}-grant-bytes" type="number" min="1" max="10485760" step="1" inputmode="numeric" autocomplete="off">
    <label for="${prefix}-grant-minutes">有效时间（1–60 分钟）</label><input id="${prefix}-grant-minutes" type="number" min="1" max="60" step="1" inputmode="numeric" autocomplete="off"></div>
    </div></details>`;
  mount.addEventListener('input', () => { $(`${prefix}-grant-fields`).hidden = !$(`${prefix}-grant-enabled`).checked; notifyOptions(prefix); });
  mount.addEventListener('change', () => { $(`${prefix}-grant-fields`).hidden = !$(`${prefix}-grant-enabled`).checked; notifyOptions(prefix); });
}
for (const prefix of prefixes) installOptions(prefix);
export function resetAttemptOptions(prefix) {
  $(`${prefix}-offline-policy`).value = '';
  $(`${prefix}-grant-enabled`).checked = false;
  for (const key of ['names', 'writes', 'bytes', 'minutes']) $(`${prefix}-grant-${key}`).value = '';
  $(`${prefix}-grant-fields`).hidden = true;
  $(`${prefix}-options-details`).open = false;
}
export function setAttemptOptionsDisabled(prefix, disabled) {
  for (const element of $(`${prefix}-attempt-options`).querySelectorAll('input,select,textarea')) element.disabled = disabled;
}
function integer(prefix, key, maximum) {
  const text = $(`${prefix}-grant-${key}`).value.trim();
  const value = Number(text);
  return text && Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : null;
}
function grantNames(prefix) { return $(`${prefix}-grant-names`).value.split(/\r?\n/).map(name => name.trim()).filter(Boolean); }
export function ownerStreamReady() { return connected && state?.ownerOnline !== false; }
const currentGrant = run => run?.draftGrant ?? run?.grant;
export function attemptOptionsIssue(prefix) {
  const policy = $(`${prefix}-offline-policy`).value;
  if (policy && !Object.hasOwn(policyLabels, policy)) return '请选择有效的本次断线策略。';
  if (policy && policy !== 'continue' && !ownerStreamReady()) return '请先连接状态推送，再使用断线时暂停或停止的策略。';
  if (!$(`${prefix}-grant-enabled`).checked) return '';
  if (!$(`${prefix}-observe-workspace`).checked || (prefix === 'work' && !$('work-scope-current').checked)) return '草稿授权需要明确重新观察当前工作区，请先选择这个范围。';
  const names = grantNames(prefix);
  if (!names.length || names.length > 128) return '草稿授权需填写 1–128 个确切文件名。';
  if (names.some(name => !/^[\p{L}\p{N}][\p{L}\p{N}_. -]{0,127}$/u.test(name) || name.includes('..') || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))) return '草稿授权只接受不含目录的确切文件名，请移除路径、通配符和无效字符。';
  if (new Set(names).size !== names.length) return '草稿授权的文件名不能重复。';
  if (integer(prefix, 'writes', 100) === null) return '请填写 1–100 次的草稿写入上限。';
  if (integer(prefix, 'bytes', 10485760) === null) return '请填写 1–10485760 字节的累计写入上限（最多 10 MiB）。';
  if (integer(prefix, 'minutes', 60) === null) return '请填写 1–60 分钟的授权有效时间。';
  return '';
}
export function attemptOptionsBody(prefix) {
  const result = {};
  const policy = $(`${prefix}-offline-policy`).value;
  if (policy) result.offlinePolicy = policy;
  if ($(`${prefix}-grant-enabled`).checked) result.draftGrant = { names: grantNames(prefix), maxWrites: integer(prefix, 'writes', 100), maxBytes: integer(prefix, 'bytes', 10485760), ttlMs: integer(prefix, 'minutes', 60) * 60000 };
  return result;
}
async function api(route, options = {}) {
  const version = session;
  const controller = new AbortController(); requests.add(controller);
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(route, { method: options.method || 'GET', credentials: 'same-origin', cache: 'no-store', headers: options.body === undefined ? {} : { 'Content-Type': 'application/json' }, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: controller.signal });
    if (version !== session) throw new Error('会话已变化。');
    const result = response.status === 204 ? null : await response.json();
    if (version !== session) throw new Error('会话已变化。');
    if (response.status === 401) window.dispatchEvent(new Event('pc-login-required'));
    if (!response.ok) { const error = new Error(typeof result?.error === 'string' ? result.error : `请求失败（HTTP ${response.status}）。`); error.status = response.status; throw error; }
    return result;
  } catch (error) { if (error.name === 'AbortError') throw new Error('请求已取消或超时，请刷新后核对服务端结果。'); throw error; }
  finally { clearTimeout(timer); requests.delete(controller); }
}
function grantStatus(grant) { return grant.revoked ? 'revoked' : grant.expired || Date.parse(grant.expiresAt) <= Date.now() ? 'expired' : grant.status; }
function controls() {
  $('inbox-refresh').disabled = busy.has('inbox');
  $('templates-refresh').disabled = busy.has('templates') || busy.has('template-write');
  const name = $('template-name').value.trim();
  $('template-save').disabled = !fresh || !selectedWork?.id || !name || name.length > 80 || busy.has('template-write');
  $('template-name').disabled = busy.has('template-write');
  for (const button of $('template-list').querySelectorAll('button')) button.disabled = busy.has('template-write');
  const grant = currentGrant(state?.run);
  $('grant-revoke').hidden = !grant;
  $('grant-revoke').disabled = !fresh || !state?.run?.id || !grant || grantStatus(grant) !== 'active' || busy.has('grant');
  $('grant-revoke').textContent = busy.has('grant') ? '正在撤销…' : '撤销本次草稿写入授权';
}
function renderRunOptions() {
  const run = state?.run;
  const grant = currentGrant(run);
  $('current-run-options').hidden = state?.phase !== 'mvp' || !run || (!run.offlinePolicy && !grant);
  $('run-offline-policy').textContent = run ? `本次执行：${policyLabels[run.offlinePolicy] || policyLabels.continue}。断线先等待 3 秒重连。` : '';
  if (grant) {
    const names = Array.isArray(grant.names) ? grant.names.filter(name => typeof name === 'string').join('、') : '未提供';
    const expiry = Number.isFinite(Date.parse(grant.expiresAt)) ? new Date(grant.expiresAt).toLocaleString('zh-CN') : '未提供';
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : '未知';
    $('run-draft-grant').textContent = `草稿授权：${grantLabels[grantStatus(grant)] || '状态待确认'}；文件 ${names}。已写 ${count(grant.usedWrites)} / ${count(grant.maxWrites)} 次，${count(grant.usedBytes)} / ${count(grant.maxBytes)} 字节；剩余 ${count(grant.remainingWrites)} 次、${count(grant.remainingBytes)} 字节；到期 ${expiry}。仅适用于私有待验收草稿。`;
  } else $('run-draft-grant').textContent = '';
  controls();
}
function openInbox(item) {
  if (item.workId || item.runId) window.dispatchEvent(new CustomEvent('pc-open-work', { detail: { workId: item.workId, runId: item.runId, kind: item.kind } }));
  const targets = { approval: 'agent-approval', handoff: 'handoff-panel', usage: 'usage-form', artifacts: 'artifact-panel', failure: 'agent-history', backup: 'recovery-panel' };
  const target = $(targets[item.kind]);
  if (item.kind === 'failure' && target) target.open = true;
  target?.scrollIntoView({ block: 'start' });
}
function renderInbox(items) {
  $('inbox-list').replaceChildren();
  $('inbox-summary').textContent = items.length ? `${items.length} 项待处理事项；点击查看后由你决定下一步。` : '暂无待处理事项。';
  for (const item of items) {
    const row = document.createElement('li'); row.className = 'artifact-item';
    const title = document.createElement('p'); title.className = 'owner-item-title';
    title.textContent = `${inboxLabels[item.kind] || '待处理'} · ${item.title}${Number.isSafeInteger(item.count) && item.count > 1 ? `（${item.count}）` : ''}`; row.append(title);
    if (typeof item.detail === 'string') { const detail = document.createElement('p'); detail.className = 'owner-item-detail'; detail.textContent = item.detail; row.append(detail); }
    if (['approval', 'handoff', 'usage', 'artifacts', 'failure'].includes(item.kind)) { const button = document.createElement('button'); button.type = 'button'; button.className = 'compact'; button.textContent = '查看'; button.addEventListener('click', () => openInbox(item)); row.append(button); }
    $('inbox-list').append(row);
  }
}
async function loadInbox() {
  if (state?.phase !== 'mvp') return;
  const version = session; const request = ++inboxRequest; busy.add('inbox'); controls();
  try {
    const result = await api('/api/inbox');
    if (version !== session || request !== inboxRequest) return;
    if (!Array.isArray(result?.items)) throw new Error('服务端未返回待处理事项。');
    renderInbox(result.items.filter(item => item && typeof item.id === 'string' && typeof item.title === 'string'));
    message('inbox-message');
  } catch (error) { if (version === session && request === inboxRequest) { $('inbox-summary').textContent = '待处理事项暂不可用。'; message('inbox-message', error.status === 404 ? '当前服务尚未提供收件箱。' : error.message, error.status !== 404); } }
  finally { if (version === session && request === inboxRequest) { busy.delete('inbox'); controls(); } }
}
function renderTemplates() {
  $('template-list').replaceChildren(); $('templates-empty').hidden = templates.length > 0;
  for (const template of templates) {
    const row = document.createElement('li'); row.className = 'artifact-item';
    const name = document.createElement('p'); name.className = 'owner-item-title'; name.textContent = template.name;
    const goal = document.createElement('p'); goal.className = 'owner-item-detail'; goal.textContent = template.goal;
    const actions = document.createElement('div'); actions.className = 'task-actions';
    const load = document.createElement('button'); load.type = 'button'; load.className = 'compact'; load.textContent = '填入新任务';
    load.addEventListener('click', () => window.dispatchEvent(new CustomEvent('pc-task-template', { detail: { id: template.id, goal: template.goal } })));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'compact'; remove.textContent = '删除模板'; remove.addEventListener('click', () => void deleteTemplate(template));
    actions.append(load, remove); row.append(name, goal, actions); $('template-list').append(row);
  }
  controls();
}
async function loadTemplates() {
  if (state?.phase !== 'mvp') return;
  const version = session; const request = ++templatesRequest; busy.add('templates'); controls();
  try {
    const result = await api('/api/templates');
    if (version !== session || request !== templatesRequest) return;
    if (!Array.isArray(result?.templates)) throw new Error('服务端未返回模板列表。');
    templates = result.templates.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.goal === 'string'); renderTemplates(); message('templates-message');
  } catch (error) { if (version === session && request === templatesRequest) message('templates-message', error.status === 404 ? '当前服务尚未提供任务模板。' : error.message, error.status !== 404); }
  finally { if (version === session && request === templatesRequest) { busy.delete('templates'); controls(); } }
}
async function deleteTemplate(template) {
  if (busy.has('template-write')) return;
  const version = session; busy.add('template-write'); templatesRequest++; controls();
  try { await api(`/api/templates/${encodeURIComponent(template.id)}`, { method: 'DELETE' }); if (version === session) { await loadTemplates(); if (version === session) message('templates-message', '模板已删除。'); } }
  catch (error) { if (version === session) message('templates-message', error.message, true); }
  finally { if (version === session) { busy.delete('template-write'); controls(); } }
}
$('template-save-form').addEventListener('submit', async event => {
  event.preventDefault(); controls(); if ($('template-save').disabled) return;
  const version = session; const workId = selectedWork.id; const name = $('template-name').value.trim(); busy.add('template-write'); templatesRequest++; controls();
  try { await api('/api/templates', { method: 'POST', body: { workId, name } }); if (version === session) { $('template-name').value = ''; await loadTemplates(); if (version === session) message('templates-message', '已保存工作目标，使用时会新建任务并重新选择权限。'); } }
  catch (error) { if (version === session) message('templates-message', error.status === 409 ? '该模板名称已存在，请使用其他名称。' : error.message, true); }
  finally { if (version === session) { busy.delete('template-write'); controls(); } }
});
$('grant-revoke').addEventListener('click', async () => {
  controls(); if ($('grant-revoke').disabled) return;
  const version = session; const runId = state.run.id; busy.add('grant'); controls();
  try { await api(`/api/tasks/${encodeURIComponent(runId)}/grant/revoke`, { method: 'POST', body: {} }); if (version === session) { if (state?.run?.id === runId) message('grant-message', '已撤销本次草稿写入授权；之后的写入需重新审批。'); refresh(); } }
  catch (error) { if (version === session && state?.run?.id === runId) message('grant-message', error.message, true); }
  finally { if (version === session) { busy.delete('grant'); controls(); } }
});
$('template-name').addEventListener('input', controls);
$('inbox-refresh').addEventListener('click', () => void loadInbox());
$('templates-refresh').addEventListener('click', () => void loadTemplates());
window.addEventListener('pc-work-selected', event => { selectedWork = event.detail || null; $('template-source').textContent = selectedWork?.id ? `保存所选工作目标：${typeof selectedWork.goal === 'string' ? selectedWork.goal : selectedWork.id}` : '先在工作交接中选择工作。'; controls(); });
window.addEventListener('pc-events-connection', event => { connected = event.detail === true; for (const prefix of prefixes) notifyOptions(prefix); });
window.addEventListener('pc-state', event => {
  state = event.detail; fresh = true;
  for (const id of ['owner-inbox', 'templates-panel']) $(id).hidden = state?.phase !== 'mvp';
  renderRunOptions();
  if (state?.phase !== 'mvp') return;
  const key = `${state.work?.id}:${state.work?.revision}:${state.run?.id}:${state.run?.status}:${state.run?.approval?.id}:${currentGrant(state.run)?.status}:${currentGrant(state.run)?.usedWrites}:${currentGrant(state.run)?.usedBytes}:${state.ownerOnline}`;
  if (stateKey !== key) { const initial = !stateKey; stateKey = key; void loadInbox(); if (initial) void loadTemplates(); }
  for (const prefix of prefixes) notifyOptions(prefix);
});
window.addEventListener('pc-refresh', () => { if (state?.phase === 'mvp') void loadInbox(); });
window.addEventListener('pc-state-freshness', event => { fresh = event.detail === true; controls(); });
window.addEventListener('pc-auth', event => {
  if (event.detail !== false) return;
  session++; inboxRequest++; templatesRequest++; state = null; fresh = false; connected = false; selectedWork = null; stateKey = ''; templates = []; busy.clear();
  for (const request of requests) request.abort(); requests.clear();
  for (const prefix of prefixes) resetAttemptOptions(prefix);
  $('template-save-form').reset(); $('template-source').textContent = '先在工作交接中选择工作。';
  for (const id of ['inbox-list', 'template-list']) $(id).replaceChildren();
  for (const id of ['owner-inbox', 'templates-panel', 'current-run-options']) $(id).hidden = true;
  for (const id of ['inbox-message', 'templates-message', 'grant-message']) message(id);
  $('run-offline-policy').textContent = ''; $('run-draft-grant').textContent = ''; controls();
});
setInterval(() => { if (state?.phase === 'mvp' && currentGrant(state?.run)) renderRunOptions(); }, 1000);
