import './mvp.js';
import './handoff.js';
const $ = (id) => document.getElementById(id);

const ui = Object.fromEntries([
  'login-view', 'workspace-view', 'login-form', 'password', 'login-button',
  'login-error', 'initial-status', 'state-connection', 'state-reconnect',
  'logout-button', 'global-message', 'desktop-status', 'desktop-reconnect',
  'takeover-button', 'control-owner', 'input-mode', 'vnc-screen',
  'desktop-placeholder', 'desktop-placeholder-title', 'desktop-placeholder-detail',
  'desktop-message', 'run-status', 'demo-button', 'cancel-button', 'pause-button', 'control-stop', 'task-empty',
  'run-steps', 'run-error', 'files-refresh', 'upload-form', 'upload-file',
  'upload-button', 'upload-help', 'file-message', 'files-empty', 'file-list',
  'environment-desktop', 'environment-browser', 'sandbox-row',
  'environment-sandbox', 'persistence-row', 'environment-persistence',
].map((id) => [id, $(id)]));

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const TERMINAL_RUN_STATUSES = new Set([
  'completed', 'complete', 'succeeded', 'success', 'done', 'failed', 'error',
  'cancelled', 'canceled', 'interrupted', 'aborted', 'paused',
]);
const STATUS_LABELS = {
  idle: '空闲', queued: '排队中', pending: '等待中', waiting: '等待中',
  starting: '启动中', running: '运行中', in_progress: '运行中', awaiting_approval: '等待审批',
  finishing: '收尾中', paused: '已暂停', stopping: '正在停止', unconfirmed: '停止未确认',
  cancelling: '取消中', canceling: '取消中', completed: '已完成',
  complete: '已完成', succeeded: '已完成', success: '已完成', done: '已完成',
  failed: '失败', error: '错误', cancelled: '已取消', canceled: '已取消',
  interrupted: '已中断', aborted: '已终止', skipped: '已跳过',
};

let state = null;
let authenticated = false;
let sessionVersion = 0;
let initializing = true;
let loginBusy = false;
const pendingActions = new Set();
let eventSource = null;
let eventRetryTimer = null;
let eventRetryCount = 0;
let rfb = null;
let rfbModulePromise = null;
let desktopAttempt = 0;
let desktopAttempted = false;
let desktopConnection = 'idle';
let stateSequence = 0;
let stateFresh = false;
let controlRequests = 0;
let desktopRetryTimer = null;
let desktopRetryCount = 0;

class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function messageFrom(value, fallback = '请求失败，请重试。') {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object') {
    if (typeof value.message === 'string') return value.message;
    if (typeof value.error === 'string') return value.error;
    if (value.error && typeof value.error.message === 'string') return value.error.message;
  }
  return fallback;
}

function showMessage(element, text, isError = false) {
  element.textContent = text || '';
  element.hidden = !text;
  element.classList.toggle('error', isError);
}

function connectionLabel(element, text, status = '') {
  element.textContent = text;
  element.dataset.state = status;
}

async function api(path, { method = 'GET', body, auth = true, responseType = 'json' } = {}) {
  const requestVersion = sessionVersion;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.status === 401) {
      if (auth && requestVersion === sessionVersion) showLogin('登录已失效，请重新输入访问密码。');
      throw new ApiError(auth ? '登录已失效，请重新登录。' : '密码不正确或无法登录。', 401);
    }
    if (!response.ok) {
      let errorData = null;
      try { errorData = await response.json(); } catch { /* A non-JSON server error needs a safe fallback. */ }
      throw new ApiError(messageFrom(errorData, `请求失败（HTTP ${response.status}）。`), response.status);
    }
    if (responseType === 'blob') return await response.blob();
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { throw new ApiError('服务端返回了无效的 JSON，请检查服务状态。'); }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.name === 'AbortError') throw new ApiError('请求超时，请检查本地服务后重试。');
    throw new ApiError('无法连接本地服务，请检查服务是否启动。');
  } finally {
    window.clearTimeout(timeout);
  }
}

function isCurrent(version) {
  return authenticated && version === sessionVersion;
}

function isRunActive(run = state?.run) {
  return Boolean(run && !TERMINAL_RUN_STATUSES.has(run.status));
}

function mayStart() {
  return stateFresh && state?.control?.owner !== 'stopping' && state?.control?.owner !== 'unconfirmed'
    && (typeof state?.canStart === 'boolean' ? state.canStart : !isRunActive());
}

function updateButtons() {
  ui['login-button'].disabled = initializing || loginBusy;
  ui['login-button'].textContent = loginBusy ? '正在登录…' : '登录';
  ui['logout-button'].disabled = pendingActions.has('logout');
  ui['demo-button'].disabled = !authenticated || !state?.desktop?.ready || !state?.desktop?.browserReady
    || !mayStart() || isRunActive() || pendingActions.has('demo') || pendingActions.has('logout');
  ui['demo-button'].textContent = pendingActions.has('demo') ? '正在启动…' : '运行固定演示';
  ui['cancel-button'].disabled = !authenticated || !stateFresh || !isRunActive()
    || pendingActions.has('cancel') || pendingActions.has('logout')
    || ['cancelling', 'canceling', 'finishing'].includes(state?.run?.status);
  ui['pause-button'].hidden = state?.phase !== 'mvp';
  ui['pause-button'].disabled = !authenticated || !stateFresh || state?.run?.kind !== 'agent' || !isRunActive()
    || pendingActions.has('pause') || pendingActions.has('logout')
    || ['cancelling', 'canceling', 'finishing'].includes(state?.run?.status)
    || ['stopping', 'unconfirmed'].includes(state?.control?.owner);
  ui['pause-button'].textContent = pendingActions.has('pause') ? '正在暂停…' : '暂停并交接';
  ui['takeover-button'].disabled = !authenticated || !state?.control
    || pendingActions.has('takeover') || pendingActions.has('logout') || state?.control?.owner === 'stopping';
  ui['takeover-button'].textContent = pendingActions.has('takeover') ? '正在接管…'
    : state?.control?.owner === 'unconfirmed' ? '重试停止并接管' : '人工接管';
  ui['desktop-reconnect'].disabled = !authenticated || !stateFresh || !state?.desktop?.ready
    || ['stopping', 'unconfirmed'].includes(state?.control?.owner)
    || desktopConnection === 'connecting' || pendingActions.has('logout');
  ui['files-refresh'].disabled = !authenticated || pendingActions.has('files') || pendingActions.has('logout');
  ui['upload-button'].disabled = !authenticated || pendingActions.has('upload') || pendingActions.has('logout');
  ui['upload-file'].disabled = !authenticated || pendingActions.has('upload') || pendingActions.has('logout');
  ui['upload-button'].textContent = pendingActions.has('upload') ? '上传中…' : '上传';
}

function closeEvents() {
  window.dispatchEvent(new CustomEvent('pc-events-connection', { detail: false }));
  window.clearTimeout(eventRetryTimer);
  eventRetryTimer = null;
  const previous = eventSource;
  eventSource = null;
  previous?.close();
}

function stopDesktop() {
  window.clearTimeout(desktopRetryTimer);
  desktopRetryTimer = null;
  desktopAttempt += 1;
  const previous = rfb;
  rfb = null;
  if (previous) {
    try { previous.disconnect(); } catch { /* The transport may already be closed. */ }
  }
  ui['vnc-screen'].replaceChildren();
  desktopConnection = 'idle';
}

function showLogin(message = '') {
  authenticated = false;
  sessionVersion += 1;
  state = null;
  controlRequests = 0;
  stateSequence += 1;
  setStateFresh(false);
  window.dispatchEvent(new CustomEvent('pc-auth', { detail: false }));
  pendingActions.clear();
  closeEvents();
  stopDesktop();
  desktopAttempted = false;
  eventRetryCount = 0;
  ui['workspace-view'].hidden = true;
  ui['login-view'].hidden = false;
  ui.password.value = '';
  ui['initial-status'].hidden = true;
  showMessage(ui['login-error'], message, Boolean(message));
  updateButtons();
  if (!initializing) ui.password.focus();
}

function setStateFresh(value) {
  if (!value) stateSequence += 1;
  stateFresh = value;
  if (rfb) rfb.viewOnly = desktopReadOnly();
  if (!value && state) ui['input-mode'].textContent = '状态待确认 · 桌面输入已暂停';
  window.dispatchEvent(new CustomEvent('pc-state-freshness', { detail: value }));
  updateButtons();
}

function acceptState(next, expectedSequence) {
  if (!next || typeof next !== 'object' || !next.desktop || !next.control) {
    throw new ApiError('服务端状态格式不完整，无法更新界面。');
  }
  if (expectedSequence !== undefined && expectedSequence !== stateSequence) return false;
  const previousGeneration = state?.control?.generation;
  if (Number.isSafeInteger(previousGeneration)
    && (!Number.isSafeInteger(next.control.generation) || next.control.generation < previousGeneration)) return false;
  state = next;
  stateSequence += 1;
  setStateFresh(true);
  renderState();
  window.dispatchEvent(new CustomEvent('pc-state', { detail: next }));
  if (controlRequests > 0) setStateFresh(false);
  return true;
}

async function refreshStatus(version = sessionVersion) {
  const sequence = stateSequence;
  const next = await api('/api/status');
  if (!isCurrent(version)) return false;
  return acceptState(next, sequence);
}

function enterWorkspace(next) {
  if (!next || typeof next !== 'object' || !next.desktop || !next.control) {
    throw new ApiError('服务端状态格式不完整，无法打开工作区。');
  }
  if (!authenticated) {
    sessionVersion += 1;
    authenticated = true;
  }
  ui.password.value = '';
  ui['login-view'].hidden = true;
  ui['workspace-view'].hidden = false;
  showMessage(ui['login-error'], '');
  showMessage(ui['global-message'], '');
  acceptState(next);
  connectEvents();
}

function renderRun() {
  const run = state.run;
  ui['run-steps'].replaceChildren();
  showMessage(ui['run-error'], '');
  if (!run) {
    ui['run-status'].textContent = '空闲';
    ui['task-empty'].textContent = '还没有运行任务。点击“运行固定演示”开始。';
    ui['task-empty'].hidden = false;
    ui['run-steps'].hidden = true;
    return;
  }
  ui['run-status'].textContent = STATUS_LABELS[run.status] || String(run.status || '状态未知');
  const steps = Array.isArray(run.steps) ? run.steps : [];
  ui['task-empty'].hidden = steps.length > 0;
  ui['task-empty'].textContent = '任务已创建，等待服务端步骤。';
  ui['run-steps'].hidden = steps.length === 0;
  for (const step of steps) {
    const item = document.createElement('li');
    item.className = 'run-step';
    item.dataset.status = typeof step?.status === 'string' ? step.status : '';
    const title = document.createElement('span');
    title.className = 'step-title';
    title.textContent = typeof step?.title === 'string' ? step.title : '未命名步骤';
    const status = document.createElement('span');
    status.className = 'step-status';
    status.textContent = STATUS_LABELS[step?.status] || String(step?.status || '等待状态');
    item.append(title, status);
    ui['run-steps'].append(item);
  }
  if (run.error) showMessage(ui['run-error'], messageFrom(run.error, '任务执行失败，请检查本地服务日志。'), true);
}

function formatSize(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatModified(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function renderFiles(files) {
  ui['file-list'].replaceChildren();
  if (!Array.isArray(files)) {
    ui['files-empty'].textContent = '尚未收到文件列表，请刷新。';
    ui['files-empty'].hidden = false;
    return;
  }
  const validFiles = files.filter((file) => file && typeof file.name === 'string');
  ui['files-empty'].textContent = '工作区暂无文件。';
  ui['files-empty'].hidden = validFiles.length > 0;
  for (const file of validFiles) {
    const item = document.createElement('li');
    item.className = 'file-item';
    const info = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = [formatSize(file.size), formatModified(file.modifiedAt)].filter(Boolean).join(' · ');
    info.append(name, meta);
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'file-download';
    download.textContent = '下载';
    download.setAttribute('aria-label', `下载 ${file.name}`);
    download.addEventListener('click', () => downloadFile(file, download));
    item.append(info, download);
    ui['file-list'].append(item);
  }
}

function desktopReadOnly() {
  return controlRequests > 0 || !stateFresh || state?.control?.owner !== 'human'
    || [...pendingActions].some(key => ['takeover', 'pause', 'demo', 'cancel'].includes(key))
    || state?.desktop?.readOnly === true || state?.desktop?.readonly === true
    || state?.control?.readOnly === true || state?.control?.readonly === true;
}

function renderState() {
  const { desktop, control } = state;
  const ownerLabels = { human: control.private ? '当前控制：人工 · 私人操作' : '当前控制：人工', automation: '当前控制：自动化', stopping: '正在停止自动化 · 尚未交还控制', unconfirmed: '停止未确认 · 桌面保持锁定' };
  ui['control-owner'].textContent = ownerLabels[control.owner] || '控制权状态未知';
  const readOnly = desktopReadOnly();
  ui['input-mode'].textContent = !stateFresh ? '状态待确认 · 桌面输入已暂停'
    : ['stopping', 'unconfirmed'].includes(control.owner) ? '等待服务端确认停止'
      : readOnly ? '只读查看 · 接管后可操作' : '可以操作桌面';
  if (stateFresh && control.owner === 'human' && readOnly) ui['input-mode'].textContent = '服务端要求只读查看';
  if (rfb) rfb.viewOnly = readOnly;
  const stop = control.stop;
  const confirmation = value => value === true ? '已确认' : value === false ? '未确认' : '待确认';
  const stopText = stop && typeof stop === 'object'
    ? `停止${confirmation(stop.confirmed)} · 输入${confirmation(stop.input)} · 观察${confirmation(stop.observation)}${typeof stop.elapsedMs === 'number' && Number.isFinite(stop.elapsedMs) ? ` · ${Math.max(0, Math.round(stop.elapsedMs))} 毫秒` : ''}` : '';
  showMessage(ui['control-stop'], stopText || (control.owner === 'unconfirmed' ? '停止尚未得到确认。可重试停止并接管；确认前不会开放桌面输入。' : ''));
  ui['environment-desktop'].textContent = desktop.ready === true ? '就绪' : desktop.ready === false ? '未就绪' : '等待状态';
  ui['environment-browser'].textContent = desktop.browserReady === true ? '就绪' : desktop.browserReady === false ? '未就绪' : '等待状态';
  ui['sandbox-row'].hidden = typeof state.sandbox?.enabled !== 'boolean';
  ui['environment-sandbox'].textContent = state.sandbox?.enabled ? '已启用' : '未启用';
  ui['persistence-row'].hidden = typeof state.workspacePersistent !== 'boolean';
  ui['environment-persistence'].textContent = state.workspacePersistent ? '持久化' : '不持久化';
  renderRun();
  renderFiles(state.files);
  if (['stopping', 'unconfirmed'].includes(control.owner)) {
    stopDesktop();
    desktopAttempted = false;
    connectionLabel(ui['desktop-status'], control.owner === 'stopping' ? '等待停止确认' : '停止未确认', 'error');
    showDesktopPlaceholder('桌面暂时锁定', '等待服务端确认自动化已停止后再连接桌面。');
  } else if (!desktop.ready) {
    stopDesktop();
    desktopAttempted = false;
    connectionLabel(ui['desktop-status'], '桌面服务未就绪');
    showDesktopPlaceholder('桌面服务未就绪', '等待本地桌面服务启动。状态更新后将自动尝试连接。');
    showMessage(ui['desktop-message'], '');
  } else if (!desktopAttempted) {
    connectDesktop();
  }
  updateButtons();
}

function showDesktopPlaceholder(title, detail) {
  ui['desktop-placeholder-title'].textContent = title;
  ui['desktop-placeholder-detail'].textContent = detail;
  ui['desktop-placeholder'].hidden = false;
}

function desktopFailure(title, detail) {
  stopDesktop();
  desktopConnection = 'error';
  desktopAttempted = true;
  connectionLabel(ui['desktop-status'], title, 'error');
  showDesktopPlaceholder(title, detail);
  showMessage(ui['desktop-message'], detail, true);
  updateButtons();
}

async function connectDesktop() {
  if (!authenticated || !stateFresh || !state?.desktop?.ready || ['stopping', 'unconfirmed'].includes(state?.control?.owner)) return;
  stopDesktop();
  desktopAttempted = true;
  desktopConnection = 'connecting';
  const attempt = desktopAttempt;
  const version = sessionVersion;
  connectionLabel(ui['desktop-status'], '桌面连接中…');
  showDesktopPlaceholder('正在连接桌面', '正在加载 noVNC 并建立同源桌面连接。');
  showMessage(ui['desktop-message'], '');
  updateButtons();
  try {
    rfbModulePromise ||= import('/vendor/novnc/core/rfb.js').catch((error) => {
      rfbModulePromise = null;
      throw error;
    });
    const module = await rfbModulePromise;
    if (!isCurrent(version) || attempt !== desktopAttempt) return;
    const url = new URL('/desktop', window.location.href);
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const client = new module.default(ui['vnc-screen'], url.href);
    rfb = client;
    client.scaleViewport = true;
    client.resizeSession = false;
    client.viewOnly = desktopReadOnly();
    client.focusOnClick = true;
    const current = () => isCurrent(version) && attempt === desktopAttempt && rfb === client;
    client.addEventListener('connect', () => {
      if (!current()) return;
      desktopConnection = 'connected';
      desktopRetryCount = 0;
      client.viewOnly = desktopReadOnly();
      ui['desktop-placeholder'].hidden = true;
      connectionLabel(ui['desktop-status'], '桌面已连接', 'connected');
      showMessage(ui['desktop-message'], '');
      updateButtons();
    });
    client.addEventListener('disconnect', () => {
      if (!current()) return;
      desktopFailure('桌面连接已断开', '桌面连接中断。请点击“重连桌面”；若会话失效，请重新登录。');
      checkSessionAfterDisconnect(version);
    });
    client.addEventListener('securityfailure', () => {
      if (!current()) return;
      desktopFailure('桌面认证失败', '服务端拒绝桌面连接。请检查本地桌面服务配置后重连。');
      checkSessionAfterDisconnect(version);
    });
    client.addEventListener('credentialsrequired', () => {
      if (!current()) return;
      desktopFailure('桌面需要额外认证', '当前 P0 使用服务端桌面代理。请检查服务端 VNC 认证配置后重连。');
    });
  } catch {
    if (!isCurrent(version) || attempt !== desktopAttempt) return;
    desktopFailure('无法连接桌面', 'noVNC 模块加载或桌面连接失败。请检查 /vendor/novnc/ 静态资源及 /desktop 代理后重连。');
    checkSessionAfterDisconnect(version);
  }
}

async function checkSessionAfterDisconnect(version) {
  try {
    await refreshStatus(version);
    if (!isCurrent(version) || !stateFresh || !state?.desktop?.ready || ['stopping', 'unconfirmed'].includes(state?.control?.owner)) return;
    desktopRetryCount += 1;
    const delayMs = Math.min(1000 * 2 ** Math.min(desktopRetryCount - 1, 4), 15000);
    window.clearTimeout(desktopRetryTimer);
    desktopRetryTimer = window.setTimeout(() => {
      desktopRetryTimer = null;
      if (isCurrent(version) && desktopConnection !== 'connected') void connectDesktop();
    }, delayMs);
  } catch (error) {
    if (isCurrent(version) && error.status !== 401) showMessage(ui['global-message'], error.message, true);
  }
}

function scheduleEventsReconnect(version, detail) {
  if (!isCurrent(version)) return;
  closeEvents();
  eventRetryCount += 1;
  const delaySeconds = Math.min(2 ** Math.min(eventRetryCount, 5), 30);
  connectionLabel(ui['state-connection'], `状态连接中断 · ${delaySeconds} 秒后重试`, 'error');
  ui['state-reconnect'].hidden = false;
  showMessage(ui['global-message'], detail, true);
  eventRetryTimer = window.setTimeout(async () => {
    eventRetryTimer = null;
    if (!isCurrent(version)) return;
    try {
      await refreshStatus(version);
      if (!isCurrent(version)) return;
      connectEvents();
    } catch (error) {
      if (isCurrent(version)) scheduleEventsReconnect(version, error.message);
    }
  }, delaySeconds * 1000);
}

function connectEvents() {
  if (!authenticated) return;
  closeEvents();
  const version = sessionVersion;
  connectionLabel(ui['state-connection'], '正在连接状态…');
  ui['state-reconnect'].hidden = true;
  let source;
  try {
    source = new EventSource('/api/events', { withCredentials: true });
  } catch {
    scheduleEventsReconnect(version, '浏览器无法建立状态推送连接，请点击“重连状态”重试。');
    return;
  }
  eventSource = source;
  source.addEventListener('open', () => {
    if (!isCurrent(version) || eventSource !== source) return;
    eventRetryCount = 0;
    window.dispatchEvent(new CustomEvent('pc-events-connection', { detail: true }));
    connectionLabel(ui['state-connection'], '状态已连接', 'connected');
    ui['state-reconnect'].hidden = true;
    showMessage(ui['global-message'], '');
  });
  source.addEventListener('state', (event) => {
    if (!isCurrent(version) || eventSource !== source) return;
    try {
      acceptState(JSON.parse(event.data));
      connectionLabel(ui['state-connection'], '状态已连接', 'connected');
    } catch (error) {
      showMessage(ui['global-message'], messageFrom(error, '状态推送数据无效，请重连状态。'), true);
    }
  });
  source.addEventListener('error', async () => {
    if (!isCurrent(version) || eventSource !== source) return;
    closeEvents();
    setStateFresh(false);
    connectionLabel(ui['state-connection'], '状态连接中断', 'error');
    ui['state-reconnect'].hidden = false;
    showMessage(ui['global-message'], '状态推送已断开，正在检查登录状态并准备重连。', true);
    try {
      await refreshStatus(version);
      if (!isCurrent(version)) return;
      scheduleEventsReconnect(version, '状态推送已断开，正在自动重连。也可点击“重连状态”。');
    } catch (error) {
      if (isCurrent(version)) scheduleEventsReconnect(version, error.message);
    }
  });
}

async function runAction(key, path, body = {}) {
  if (!authenticated || pendingActions.has(key)) return;
  const version = sessionVersion;
  pendingActions.add(key);
  setStateFresh(false);
  showMessage(ui['global-message'], '');
  updateButtons();
  try {
    const sequence = stateSequence;
    const result = await api(path, { method: 'POST', body });
    if (!isCurrent(version)) return;
    if (result?.desktop && result?.control) acceptState(result, sequence);
    await refreshStatus(version);
  } catch (error) {
    if (isCurrent(version)) {
      showMessage(ui['global-message'], error.message, true);
      void refreshStatus(version).catch(() => {});
    }
  } finally {
    if (version === sessionVersion) pendingActions.delete(key);
    if (state) renderState();
    updateButtons();
  }
}

async function refreshFiles() {
  if (!authenticated || pendingActions.has('files')) return;
  const version = sessionVersion;
  pendingActions.add('files');
  updateButtons();
  try {
    const result = await api('/api/files');
    if (!isCurrent(version)) return;
    if (!Array.isArray(result?.files)) throw new ApiError('服务端未返回有效的文件列表。');
    state.files = result.files;
    renderFiles(result.files);
  } catch (error) {
    if (isCurrent(version)) showMessage(ui['file-message'], error.message, true);
  } finally {
    if (version === sessionVersion) pendingActions.delete('files');
    updateButtons();
  }
}

function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result !== 'string' || !reader.result.includes(',')) {
        reject(new ApiError('无法读取文件内容。'));
        return;
      }
      resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    });
    reader.addEventListener('error', () => reject(new ApiError('无法读取文件，请重新选择。')));
    reader.addEventListener('abort', () => reject(new ApiError('文件读取已取消。')));
    reader.readAsDataURL(file);
  });
}

async function downloadFile(file, button) {
  if (!authenticated) return;
  const version = sessionVersion;
  button.disabled = true;
  button.textContent = '下载中…';
  showMessage(ui['file-message'], '');
  try {
    const blob = await api(`/api/files/download?name=${encodeURIComponent(file.name)}`, { responseType: 'blob' });
    if (!isCurrent(version)) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    showMessage(ui['file-message'], `已请求下载：${file.name}`);
  } catch (error) {
    if (isCurrent(version)) showMessage(ui['file-message'], error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '下载';
  }
}

ui['login-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  if (initializing || loginBusy) return;
  const password = ui.password.value;
  if (!password) {
    showMessage(ui['login-error'], '请输入访问密码。', true);
    ui.password.focus();
    return;
  }
  loginBusy = true;
  showMessage(ui['login-error'], '');
  updateButtons();
  try {
    await api('/api/login', { method: 'POST', body: { password }, auth: false });
    ui.password.value = '';
    enterWorkspace(await api('/api/status'));
  } catch (error) {
    showMessage(ui['login-error'], error.message, true);
    ui.password.value = '';
    ui.password.focus();
  } finally {
    loginBusy = false;
    updateButtons();
  }
});

ui['logout-button'].addEventListener('click', async () => {
  if (!authenticated || loginBusy) return;
  loginBusy = true;
  showLogin();
  ui['initial-status'].textContent = '正在注销，桌面与状态连接已关闭…';
  ui['initial-status'].hidden = false;
  updateButtons();
  try {
    await api('/api/logout', { method: 'POST', body: {}, auth: false });
  } catch (error) {
    if (error.status !== 401) {
      showMessage(ui['login-error'], `已关闭本页连接，但未确认服务端注销：${error.message}`, true);
    }
  } finally {
    loginBusy = false;
    ui['initial-status'].hidden = true;
    updateButtons();
    ui.password.focus();
  }
});

ui['demo-button'].addEventListener('click', () => runAction('demo', '/api/demo'));
ui['takeover-button'].addEventListener('click', () => runAction('takeover', '/api/control/takeover', state?.run?.id ? { runId: state.run.id } : {}));
ui['pause-button'].addEventListener('click', () => {
  if (!ui['pause-button'].disabled && state?.run?.id) void runAction('pause', '/api/control/pause', { runId: state.run.id });
});
ui['cancel-button'].addEventListener('click', () => runAction('cancel', '/api/run/cancel', state?.run?.id ? { runId: state.run.id } : {}));
ui['desktop-reconnect'].addEventListener('click', connectDesktop);
ui['state-reconnect'].addEventListener('click', () => {
  if (!authenticated) return;
  eventRetryCount = 0;
  const version = sessionVersion;
  closeEvents();
  connectionLabel(ui['state-connection'], '正在检查状态…');
  setStateFresh(false);
  refreshStatus(version).then(() => {
    if (!isCurrent(version)) return;
    connectEvents();
  }).catch((error) => {
    if (isCurrent(version)) scheduleEventsReconnect(version, error.message);
  });
});
ui['files-refresh'].addEventListener('click', refreshFiles);

ui['upload-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!authenticated || pendingActions.has('upload')) return;
  const file = ui['upload-file'].files?.[0];
  if (!file) {
    showMessage(ui['file-message'], '请先选择一个文件。', true);
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showMessage(ui['file-message'], '文件超过 5 MiB，无法上传。请选择更小的文件。', true);
    return;
  }
  const version = sessionVersion;
  pendingActions.add('upload');
  showMessage(ui['file-message'], `正在上传：${file.name}`);
  updateButtons();
  try {
    const contentBase64 = await fileAsBase64(file);
    if (!isCurrent(version)) return;
    await api('/api/files', { method: 'POST', body: { name: file.name, contentBase64 } });
    if (!isCurrent(version)) return;
    ui['upload-file'].value = '';
    showMessage(ui['file-message'], `已上传：${file.name}`);
    await refreshFiles();
  } catch (error) {
    if (isCurrent(version)) showMessage(ui['file-message'], error.message, true);
  } finally {
    if (version === sessionVersion) pendingActions.delete('upload');
    updateButtons();
  }
});

window.addEventListener('pagehide', () => {
  closeEvents();
  stopDesktop();
});
window.addEventListener('pageshow', (event) => {
  if (!event.persisted || !authenticated) return;
  desktopAttempted = false;
  const version = sessionVersion;
  setStateFresh(false);
  refreshStatus(version).then(() => {
    if (!isCurrent(version)) return;
    connectEvents();
  }).catch((error) => {
    if (isCurrent(version)) showMessage(ui['global-message'], error.message, true);
  });
});

async function initialize() {
  updateButtons();
  try {
    // An anonymous first visit is expected, not an expired authenticated session.
    enterWorkspace(await api('/api/status', { auth: false }));
  } catch (error) {
    if (error.status !== 401) showLogin(error.message);
  } finally {
    initializing = false;
    ui['initial-status'].hidden = true;
    updateButtons();
    if (!authenticated) ui.password.focus();
  }
}

window.addEventListener('pc-control-pending', () => { if (authenticated) { controlRequests++; setStateFresh(false); } });
window.addEventListener('pc-control-settled', () => {
  if (!authenticated) return;
  controlRequests = Math.max(0, controlRequests - 1);
  setStateFresh(false);
  const version = sessionVersion;
  refreshStatus(version).catch(error => { if (isCurrent(version)) showMessage(ui['global-message'], error.message, true); });
});
window.addEventListener('pc-login-required', () => showLogin('登录已失效，请重新输入访问密码。'));
window.addEventListener('pc-refresh', () => {
  if (!authenticated) return;
  const version = sessionVersion;
  refreshStatus(version).catch(error => { if (isCurrent(version)) showMessage(ui['global-message'], error.message, true); });
});
initialize();
