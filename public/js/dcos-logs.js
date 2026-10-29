import { $, createRequestGate, DialogController, formatDate, getJson, postJson, setText } from '/shared/ui.js';

const q = (path, params) => `${path}?${new URLSearchParams(params)}`;
const selectors = ['#dcosCluster', '#dcosNamespace', '#dcosWorkload', '#dcosPod', '#dcosContainer'];

export function initDcosLogs() {
  const page = $('#processLogsPage');
  const isActive = () => !page.classList.contains('hidden');
  const gates = { namespaces: createRequestGate(), workloads: createRequestGate(), pods: createRequestGate(), logs: createRequestGate() };
  const confirmDialog = new DialogController($('#confirmDialog'));
  const state = { connected: false, configured: false, clusters: [], pageNow: 1, total: 0, pageSize: 50, timer: null, loadingLogs: false, pods: null, pendingAction: null, runningAction: false, workloads: [], searching: null, loginPending: false, activeOption: -1 };
  const search = $('#dcosWorkloadSearch');
  const list = $('#dcosWorkloadOptions');
  const desktopLogin = window.workbenchDesktop?.loginDcos;

  function closePicker() { list.hidden = true; search.setAttribute('aria-expanded', 'false'); search.removeAttribute('aria-activedescendant'); state.activeOption = -1; }
  function openPicker() {
    if (search.disabled) return;
    const rect = search.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 440), window.innerWidth - 32);
    const below = window.innerHeight - rect.bottom - 16;
    const above = below < 140 && rect.top > below;
    const height = Math.min(260, Math.max(80, above ? rect.top - 16 : below));
    list.style.width = `${width}px`; list.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))}px`;
    list.style.top = `${above ? Math.max(16, rect.top - height) : rect.bottom}px`; list.style.maxHeight = `${height}px`;
    list.hidden = false; search.setAttribute('aria-expanded', 'true');
  }
  function renderPicker(message = '没有匹配的工作负载') {
    list.replaceChildren(); state.activeOption = -1; search.removeAttribute('aria-activedescendant');
    state.workloads.forEach((item, index) => {
      const option = document.createElement('div');
      option.id = `dcos-workload-option-${index}`; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
      option.textContent = `${item.name} · ${item.kind === 'Deployment' ? '无状态' : '有状态'} ${item.kind} · ${item.runningPodNum ?? '—'} Pod`;
      option.title = option.textContent;
      option.addEventListener('pointerdown', (event) => event.preventDefault());
      option.addEventListener('click', () => {
        $('#dcosWorkload').value = `${item.kind}/${item.name}`; search.value = item.name; search.title = `${item.name} · ${item.kind}`; closePicker();
        $('#dcosWorkload').dispatchEvent(new Event('change'));
      });
      list.append(option);
    });
    if (!state.workloads.length) { const empty = document.createElement('div'); empty.textContent = message; list.append(empty); }
  }

  function note(message, tone = 'info') { const node = $('#dcosLogState'); node.dataset.tone = tone; setText(node, message); }
  function clearTimer() { clearTimeout(state.timer); state.timer = null; }
  function cancelLogRequest() { gates.logs.cancel(); state.loadingLogs = false; clearTimer(); }
  function cancelRequests() { Object.values(gates).forEach((gate) => gate.cancel()); clearTimeout(state.searching); closePicker(); clearTimer(); state.loadingLogs = false; }
  function options(node, values, placeholder) {
    node.replaceChildren(new Option(placeholder, ''));
    for (const item of values) node.add(new Option(item.label, item.value));
    node.value = ''; node.disabled = !values.length;
  }
  function resetFrom(index, { keepSearch = false } = {}) {
    for (const selector of selectors.slice(index)) options($(selector), [], '请先选择上一级');
    if (index <= 2) { clearTimeout(state.searching); state.workloads = []; state.total = 0; pageInfo(); renderPicker(); search.title = ''; if (!keepSearch) search.value = ''; search.disabled = !$('#dcosNamespace').value; closePicker(); }
    if (index <= 3) state.pods = null;
    $('#dcosRefresh').disabled = true; updateWorkloadButtons();
  }
  // 按所选工作负载的 Pod 列表启用按钮；未知（加载中）时两者禁用。
  function updateWorkloadButtons() {
    const selectedWorkload = $('#dcosWorkload').value;
    const pods = Array.isArray(state.pods) ? state.pods : null;
    $('#dcosStartWorkload').disabled = state.runningAction || !selectedWorkload || pods === null || pods.length > 0;
    $('#dcosStopWorkload').disabled = state.runningAction || !selectedWorkload || pods === null || pods.length === 0;
    for (const selector of selectors) if (state.runningAction) $(selector).disabled = true;
    renderConnection();
    $('#dcosWorkloadSearch').disabled = state.runningAction || !$('#dcosNamespace').value;
    $('#dcosSearchButton').disabled = state.runningAction || !$('#dcosNamespace').value;
    if (state.runningAction) { closePicker(); $('#dcosPrevPage').disabled = true; $('#dcosNextPage').disabled = true; }
  }
  function renderConnection(message = '') {
    setText($('#dcosConnectionStatus'), state.connected ? '已连接' : state.configured ? '未连接' : '待配置');
    $('#dcosConnectionDot').classList.toggle('on', state.connected);
    $('#dcosConnectionStatus').classList.toggle('connected', state.connected);
    $('#dcosConnect').disabled = state.runningAction || state.loginPending || !state.configured || !$('#dcosCookieInput').value.trim();
    $('#dcosDisconnect').disabled = state.runningAction || state.loginPending || !state.connected;
    $('#dcosDisconnect').hidden = !state.connected;
    $('#dcosCookieInput').disabled = state.runningAction || state.loginPending;
    $('#dcosBrowserLogin').hidden = !desktopLogin;
    $('#dcosBrowserLogin').disabled = state.runningAction || !state.configured || state.loginPending;
    setText($('#dcosBaseUrl'), state.configured ? state.baseUrl : '待配置');
    setText($('#dcosConnectionError'), message || (state.configured ? '' : '请在本机 .env 设置 DCOS_BASE_URL。'));
  }
  function applyStatus(result, message = '') {
    state.connected = Boolean(result.connected); state.configured = Boolean(result.configured);
    state.baseUrl = result.baseUrl || ''; state.clusters = result.clusters || [];
    options($('#dcosCluster'), state.clusters.map((cluster) => ({ label: `${cluster.name} (${cluster.id})`, value: String(cluster.id) })), '选择集群');
    // 默认隐藏连接细节，需要时可展开使用手动 Cookie。
    $('#dcosConnectionCard').open = false;
    resetFrom(1); renderConnection(message);
  }
  async function loadStatus() {
    try { applyStatus(await getJson('/api/dcos/status')); if (isActive()) note(state.connected ? '请选择集群。' : state.configured ? '请先在此页连接云翼平台。' : '请先配置云翼平台连接。'); }
    catch (error) { renderConnection(error.message); }
  }
  function schedule() {
    clearTimer();
    if (!state.connected || !$('#dcosContainer').value) return;
    state.timer = setTimeout(() => { void loadLogs({ silent: true }); }, 5000);
  }
  function selected() {
    const item = state.workloads.find((item) => `${item.kind}/${item.name}` === $('#dcosWorkload').value);
    return { clusterId: $('#dcosCluster').value, namespaceName: $('#dcosNamespace').value, workloadName: item?.name || '', workloadKind: item?.kind || '', podName: $('#dcosPod').value, containerName: $('#dcosContainer').value };
  }
  async function loadNamespaces() {
    gates.namespaces.cancel(); gates.workloads.cancel(); gates.pods.cancel(); cancelLogRequest();
    resetFrom(1); setText($('#dcosLogText'), '');
    const clusterId = $('#dcosCluster').value; if (!clusterId) return note('请选择集群。');
    const request = gates.namespaces.next(); note('正在读取命名空间…');
    try {
      const result = await getJson(q('/api/dcos/namespaces', { clusterId }), { signal: request.signal });
      if (!request.isCurrent()) return;
      options($('#dcosNamespace'), result.namespaces.map((item) => ({ label: item.name, value: item.name })), '选择命名空间');
      note(result.namespaces.length ? '请选择命名空间。' : '该集群没有可用命名空间。');
    } catch (error) { if (request.isCurrent() && error.code !== 'REQUEST_ABORTED') handleError(error); }
  }
  function pageInfo() {
    const pages = Math.ceil(state.total / state.pageSize);
    setText($('#dcosPageInfo'), pages ? `${state.total} 个工作负载${pages > 1 ? ` · ${state.pageNow}/${pages}` : ''}` : $('#dcosNamespace').value ? '无匹配工作负载' : '');
    $('#dcosPrevPage').hidden = pages <= 1;
    $('#dcosNextPage').hidden = pages <= 1;
    $('#dcosPrevPage').disabled = state.pageNow <= 1;
    $('#dcosNextPage').disabled = state.pageNow >= pages;
  }
  async function loadWorkloads() {
    gates.workloads.cancel(); gates.pods.cancel(); cancelLogRequest(); resetFrom(2, { keepSearch: true }); setText($('#dcosLogText'), '');
    const { clusterId, namespaceName } = selected();
    if (!namespaceName) return note('请选择命名空间。');
    const request = gates.workloads.next(); note('正在读取有状态和无状态工作负载…'); renderPicker('正在读取…');
    if (document.activeElement === search) openPicker();
    try {
      const result = await getJson(q('/api/dcos/workloads', { clusterId, namespaceName, pageNow: state.pageNow, pageSize: state.pageSize, search: $('#dcosWorkloadSearch').value.trim() }), { signal: request.signal });
      if (!request.isCurrent()) return;
      state.total = result.total; state.pageNow = result.pageNow; pageInfo();
      state.workloads = result.records;
      options($('#dcosWorkload'), result.records.map((item) => ({ label: item.name, value: `${item.kind}/${item.name}` })), '选择工作负载');
      renderPicker(); if (document.activeElement === search) openPicker();
      note(result.records.length ? '请选择工作负载，可在下拉框输入名称模糊搜索。' : '当前没有匹配的工作负载。');
    } catch (error) { if (request.isCurrent() && error.code !== 'REQUEST_ABORTED') { renderPicker('读取失败，请刷新重试'); handleError(error); } }
  }
  async function loadPods() {
    gates.pods.cancel(); cancelLogRequest(); resetFrom(3); setText($('#dcosLogText'), '');
    state.pods = null; updateWorkloadButtons();
    const { clusterId, namespaceName, workloadName, workloadKind } = selected();
    if (!workloadName) return note('请选择工作负载。');
    const request = gates.pods.next(); note('正在读取 Pod…');
    try {
      const result = await getJson(q('/api/dcos/pods', { clusterId, namespaceName, workloadName, workloadKind }), { signal: request.signal });
      if (!request.isCurrent()) return;
      state.pods = result.pods; updateWorkloadButtons();
      options($('#dcosPod'), result.pods.map((pod) => ({ label: `${pod.name}${pod.status ? ` (${pod.status})` : ''}`, value: pod.name })), '选择 Pod');
      note(result.pods.length ? '请选择 Pod。' : '该工作负载没有 Pod。');
    } catch (error) { if (request.isCurrent() && error.code !== 'REQUEST_ABORTED') handleError(error); }
  }
  function selectPod() {
    cancelLogRequest(); resetFrom(4); setText($('#dcosLogText'), '');
    const pod = state.pods?.find((item) => item.name === $('#dcosPod').value);
    if (!pod) return note('请选择 Pod。');
    options($('#dcosContainer'), pod.containers.map((name) => ({ label: name, value: name })), '选择容器');
    note(pod.containers.length ? '请选择容器。' : '该 Pod 没有可用容器。');
  }
  function handleError(error) {
    if (error.code === 'DCOS_SESSION_EXPIRED') { state.connected = false; renderConnection(error.message); cancelRequests(); resetFrom(1); $('#dcosConnectionCard').open = true; }
    note(error.message, 'error');
  }
  async function loadLogs({ silent = false } = {}) {
    clearTimer();
    if (state.loadingLogs) return;
    const { clusterId, namespaceName, podName, containerName } = selected();
    if (!containerName) return note('请选择容器。');
    const request = gates.logs.next(); state.loadingLogs = true; if (!silent) note('正在读取容器日志…');
    try {
      const result = await getJson(q('/api/dcos/logs', { clusterId, namespaceName, podName, containerName, tailingLines: $('#dcosLines').value }), { signal: request.signal, timeout: 30000 });
      if (!request.isCurrent()) return;
      if (silent && (!isActive() || document.hidden || !$('#dcosAutoRefresh').checked)) return;
      const log = $('#dcosLogText');
      const position = log.scrollTop;
      setText(log, result.lines.length ? result.lines.join('\n') : '当前没有日志。');
      log.scrollTop = $('#dcosFollow').checked ? log.scrollHeight : position;
      const saved = result.saved;
      const savedText = saved?.error ? '本地保存失败' : saved?.appended ? `本地 +${saved.appended} 行` : '本地无新增';
      $('#dcosLogState').title = saved?.path ? `本地日志：${saved.path}` : '';
      note(`已读取 ${result.lines.length} 行 · ${formatDate(result.readAt, { withZone: true })} · ${savedText}`, 'success');
    } catch (error) { if (request.isCurrent() && error.code !== 'REQUEST_ABORTED') handleError(error); }
    finally { if (request.isCurrent()) { state.loadingLogs = false; schedule(); } }
  }
  function confirmWorkloadAction(action) {
    const { clusterId, namespaceName, workloadName, workloadKind } = selected();
    if (!workloadName) return note('请先选择工作负载。');
    const verb = action === 'stop' ? '停止' : '启动';
    state.pendingAction = { action, clusterId, namespaceName, workloadName, workloadKind };
    setText($('#confirmTitle'), `确认${verb} ${workloadKind}`);
    setText($('#confirmMessage'), action === 'stop'
      ? '停止后该工作负载的全部 Pod 会下线，可能影响该环境数据处理，请确认目标正确。'
      : '启动后平台会重新拉起该工作负载的全部 Pod，请确认目标正确。');
    setText($('#confirmTarget'), `${clusterId}:${namespaceName} / ${workloadKind} / ${workloadName}`);
    confirmDialog.open($('#btnConfirmAction'));
  }
  async function runWorkloadAction({ action, clusterId, namespaceName, workloadName, workloadKind }) {
    if (state.runningAction) return;
    state.runningAction = true; updateWorkloadButtons();
    note(`${action === 'stop' ? '正在停止' : '正在启动'} ${workloadName}…`);
    try {
      await postJson(`/api/dcos/workload/${action}`, { clusterId, namespaceName, workloadName, workloadKind }, { timeout: 30000 });
      note(`${action === 'stop' ? '已停止' : '已启动'} ${workloadName}，正在刷新 Pod 列表…`, 'success');
      const current = selected();
      if (current.clusterId === clusterId && current.namespaceName === namespaceName && current.workloadName === workloadName && current.workloadKind === workloadKind) await loadPods();
    } catch (error) { handleError(error); updateWorkloadButtons(); }
    finally {
      state.runningAction = false;
      for (const selector of selectors) $(selector).disabled = $(selector).options.length <= 1;
      pageInfo(); updateWorkloadButtons();
    }
  }

  $('#dcosCookieInput').addEventListener('input', () => renderConnection());
  $('#dcosBrowserLogin').addEventListener('click', async (event) => {
    event.preventDefault(); event.stopPropagation();
    if (state.runningAction || state.loginPending) return;
    state.loginPending = true; renderConnection('请在打开的云翼窗口完成登录，成功后会自动连接。');
    try {
      const result = await desktopLogin();
      if (result.ok) { cancelRequests(); applyStatus(result.status, '网页登录成功，云翼平台已连接。'); note('请选择集群。'); }
      else renderConnection(result.message);
    } catch (_) { renderConnection('网页登录失败，请重试或使用手动 Cookie。'); }
    finally {
      state.loginPending = false;
      $('#dcosBrowserLogin').disabled = state.runningAction || !state.configured;
      $('#dcosDisconnect').disabled = state.runningAction || !state.connected;
      $('#dcosCookieInput').disabled = state.runningAction;
      $('#dcosConnect').disabled = state.runningAction || !state.configured || !$('#dcosCookieInput').value.trim();
    }
  });
  $('#dcosConnect').addEventListener('click', async (event) => {
    event.preventDefault(); event.stopPropagation(); // 折叠卡片内的按钮不应触发 summary 展开/收起
    if (state.runningAction) return;
    const cookie = $('#dcosCookieInput').value;
    $('#dcosConnect').disabled = true; setText($('#dcosConnectionError'), '正在验证会话…');
    try { cancelRequests(); applyStatus(await postJson('/api/dcos/connect', { cookie }, { timeout: 30000 }), '云翼平台会话已连接。'); note('请选择集群。'); }
    catch (error) { renderConnection(error.message); }
    finally { $('#dcosCookieInput').value = ''; renderConnection(); }
  });
  $('#dcosDisconnect').addEventListener('click', async (event) => {
    event.preventDefault(); event.stopPropagation();
    if (state.runningAction) return;
    try { cancelRequests(); applyStatus(await postJson('/api/dcos/disconnect', {}), '已断开云翼平台会话。'); setText($('#dcosLogText'), ''); note('请重新连接云翼平台。'); }
    catch (error) { renderConnection(error.message); }
  });
  $('#dcosCluster').addEventListener('change', () => { void loadNamespaces(); });
  $('#dcosNamespace').addEventListener('change', () => { state.pageNow = 1; search.value = ''; void loadWorkloads(); });
  $('#dcosWorkload').addEventListener('change', () => { void loadPods(); });
  $('#dcosPod').addEventListener('change', selectPod);
  $('#dcosContainer').addEventListener('change', () => { cancelLogRequest(); $('#dcosRefresh').disabled = !$('#dcosContainer').value; setText($('#dcosLogText'), ''); if ($('#dcosContainer').value) void loadLogs(); });
  $('#dcosSearchButton').addEventListener('click', () => { state.pageNow = 1; void loadWorkloads(); });
  search.addEventListener('focus', () => { search.select(); openPicker(); });
  search.addEventListener('click', openPicker);
  search.addEventListener('blur', closePicker);
  window.addEventListener('resize', closePicker);
  page.querySelector('.process-log-body').addEventListener('scroll', closePicker);
  // 搜索框在窄窗口聚焦时会自动滚入可视区，保持弹层跟随而不是提前关闭。
  page.querySelector('.log-targets').addEventListener('scroll', () => { if (!list.hidden) openPicker(); });
  search.addEventListener('input', () => {
    gates.workloads.cancel(); gates.pods.cancel(); cancelLogRequest(); resetFrom(2, { keepSearch: true }); setText($('#dcosLogText'), '');
    state.pageNow = 1; renderPicker('正在搜索…'); openPicker();
    state.searching = setTimeout(() => void loadWorkloads(), 250);
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' || event.key === 'Tab') { closePicker(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); openPicker();
      const count = state.workloads.length; if (!count) return;
      state.activeOption = (state.activeOption + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      [...list.children].forEach((node, index) => node.setAttribute('aria-selected', String(index === state.activeOption)));
      const option = list.children[state.activeOption]; search.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (!list.hidden && state.activeOption >= 0) list.children[state.activeOption].click();
      else { state.pageNow = 1; void loadWorkloads(); }
    }
  });
  $('#dcosPrevPage').addEventListener('click', () => { if (state.pageNow > 1) { state.pageNow--; void loadWorkloads(); } });
  $('#dcosNextPage').addEventListener('click', () => { if (state.pageNow * state.pageSize < state.total) { state.pageNow++; void loadWorkloads(); } });
  $('#dcosLines').addEventListener('change', () => { cancelLogRequest(); if ($('#dcosContainer').value) void loadLogs(); });
  $('#dcosRefresh').addEventListener('click', () => { void loadLogs(); });
  $('#dcosStartWorkload').addEventListener('click', () => confirmWorkloadAction('start'));
  $('#dcosStopWorkload').addEventListener('click', () => confirmWorkloadAction('stop'));
  // 共用确认弹窗：确认走本页监听器；取消/关闭时清掉挂起操作，避免残留到工作台的删除确认
  $('#confirmDialog').addEventListener('close', () => { state.pendingAction = null; });
  $('#btnConfirmAction').addEventListener('click', () => {
    const pending = state.pendingAction; state.pendingAction = null;
    confirmDialog.close();
    if (pending) void runWorkloadAction(pending);
  });
  $('#dcosAutoRefresh').addEventListener('change', schedule);
  $('#dcosFollow').addEventListener('change', () => { if ($('#dcosFollow').checked) $('#dcosLogText').scrollTop = $('#dcosLogText').scrollHeight; });
  $('#dcosLogText').addEventListener('scroll', () => {
    const log = $('#dcosLogText');
    if (log.scrollHeight - log.scrollTop - log.clientHeight > 24) $('#dcosFollow').checked = false;
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && isActive() && $('#dcosAutoRefresh').checked) void loadLogs(); });
  void loadStatus();
  return {
    activate() {
      if (!state.connected) { note('请先在此页连接云翼平台。'); return; }
      if (state.runningAction) return;
      if ($('#dcosCluster').value && $('#dcosNamespace').options.length <= 1) void loadNamespaces();
      else if ($('#dcosNamespace').value && $('#dcosWorkload').options.length <= 1) void loadWorkloads();
      else if ($('#dcosWorkload').value && state.pods === null) void loadPods();
      else if ($('#dcosContainer').value && !$('#dcosLogText').textContent) void loadLogs();
      else schedule();
    },
    deactivate() { gates.namespaces.cancel(); gates.workloads.cancel(); gates.pods.cancel(); clearTimeout(state.searching); closePicker(); },
  };
}
