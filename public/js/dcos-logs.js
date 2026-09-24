import { $, createRequestGate, DialogController, formatDate, getJson, postJson, setText } from '/shared/ui.js';

const q = (path, params) => `${path}?${new URLSearchParams(params)}`;
const selectors = ['#dcosCluster', '#dcosNamespace', '#dcosWorkload', '#dcosPod', '#dcosContainer'];

export function initDcosLogs() {
  const page = $('#processLogsPage');
  const isActive = () => !page.classList.contains('hidden');
  const gates = { namespaces: createRequestGate(), workloads: createRequestGate(), pods: createRequestGate(), logs: createRequestGate() };
  const confirmDialog = new DialogController($('#confirmDialog'));
  const state = { connected: false, configured: false, clusters: [], pageNow: 1, total: 0, pageSize: 50, timer: null, loadingLogs: false, pods: null, pendingAction: null, runningAction: false };

  function note(message, tone = 'info') { const node = $('#dcosLogState'); node.dataset.tone = tone; setText(node, message); }
  function clearTimer() { clearTimeout(state.timer); state.timer = null; }
  function cancelLogRequest() { gates.logs.cancel(); state.loadingLogs = false; clearTimer(); }
  function cancelRequests() { Object.values(gates).forEach((gate) => gate.cancel()); clearTimer(); state.loadingLogs = false; }
  function options(node, values, placeholder) {
    node.replaceChildren(new Option(placeholder, ''));
    for (const item of values) node.add(new Option(item.label, item.value));
    node.value = ''; node.disabled = !values.length;
  }
  function resetFrom(index) { for (const selector of selectors.slice(index)) options($(selector), [], '请先选择上一级'); $('#dcosRefresh').disabled = true; updateWorkloadButtons(); }
  // 启停按钮状态：以当前 StatefulSet 的 Pod 列表为准——有 Pod 可停止、无 Pod 可启动、未知（加载中）时两者禁用
  function updateWorkloadButtons() {
    const selectedWorkload = $('#dcosWorkload').value;
    const pods = Array.isArray(state.pods) ? state.pods : null;
    $('#dcosStartWorkload').disabled = state.runningAction || !selectedWorkload || pods === null || pods.length > 0;
    $('#dcosStopWorkload').disabled = state.runningAction || !selectedWorkload || pods === null || pods.length === 0;
  }
  function renderConnection(message = '') {
    setText($('#dcosConnectionStatus'), state.connected ? '已连接' : state.configured ? '未连接' : '待配置');
    $('#dcosConnectionDot').classList.toggle('on', state.connected);
    $('#dcosConnect').disabled = !state.configured || !$('#dcosCookieInput').value.trim();
    $('#dcosDisconnect').disabled = !state.connected;
    setText($('#dcosBaseUrl'), state.configured ? state.baseUrl : '待配置');
    setText($('#dcosClusters'), state.clusters.map((cluster) => `${cluster.name} (${cluster.id})`).join('、') || '—');
    setText($('#dcosConnectionError'), message || (state.configured ? 'Cookie 仅保存在本次 Node 进程内存；过期后重新粘贴。' : '请在本机 .env 设置 DCOS_BASE_URL。'));
  }
  function applyStatus(result, message = '') {
    state.connected = Boolean(result.connected); state.configured = Boolean(result.configured);
    state.baseUrl = result.baseUrl || ''; state.clusters = result.clusters || [];
    options($('#dcosCluster'), state.clusters.map((cluster) => ({ label: `${cluster.name} (${cluster.id})`, value: String(cluster.id) })), '选择集群');
    // 已连接时收起连接卡片，把纵向空间让给日志区；需要重粘 Cookie 时点标题展开
    $('#dcosConnectionCard').open = !state.connected;
    resetFrom(1); renderConnection(message);
  }
  async function loadStatus() {
    try { applyStatus(await getJson('/api/dcos/status')); }
    catch (error) { renderConnection(error.message); }
  }
  function schedule() {
    clearTimer();
    if (!$('#dcosAutoRefresh').checked || !isActive() || document.hidden || !$('#dcosContainer').value) return;
    state.timer = setTimeout(() => { void loadLogs(); }, 5000);
  }
  function selected() { return { clusterId: $('#dcosCluster').value, namespaceName: $('#dcosNamespace').value, workloadName: $('#dcosWorkload').value, podName: $('#dcosPod').value, containerName: $('#dcosContainer').value }; }
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
    setText($('#dcosPageInfo'), pages ? `第 ${state.pageNow}/${pages} 页 · 共 ${state.total} 个` : '无匹配工作负载');
    $('#dcosPrevPage').disabled = state.pageNow <= 1;
    $('#dcosNextPage').disabled = state.pageNow >= pages;
  }
  async function loadWorkloads() {
    gates.workloads.cancel(); gates.pods.cancel(); cancelLogRequest(); resetFrom(2); setText($('#dcosLogText'), '');
    const { clusterId, namespaceName } = selected();
    if (!namespaceName) return note('请选择命名空间。');
    const request = gates.workloads.next(); note('正在读取 StatefulSet…');
    try {
      const result = await getJson(q('/api/dcos/workloads', { clusterId, namespaceName, pageNow: state.pageNow, pageSize: state.pageSize, search: $('#dcosWorkloadSearch').value.trim() }), { signal: request.signal });
      if (!request.isCurrent()) return;
      state.total = result.total; state.pageNow = result.pageNow; pageInfo();
      options($('#dcosWorkload'), result.records.map((item) => ({ label: `${item.name} (${item.runningPodNum ?? '—'} Pod)`, value: item.name })), '选择 StatefulSet');
      note(result.records.length ? '请选择 StatefulSet。' : '当前页没有匹配的 StatefulSet。');
    } catch (error) { if (request.isCurrent() && error.code !== 'REQUEST_ABORTED') handleError(error); }
  }
  async function loadPods() {
    gates.pods.cancel(); cancelLogRequest(); resetFrom(3); setText($('#dcosLogText'), '');
    state.pods = null; updateWorkloadButtons();
    const { clusterId, namespaceName, workloadName } = selected();
    if (!workloadName) return note('请选择 StatefulSet。');
    const request = gates.pods.next(); note('正在读取 Pod…');
    try {
      const result = await getJson(q('/api/dcos/pods', { clusterId, namespaceName, workloadName }), { signal: request.signal });
      if (!request.isCurrent()) return;
      state.pods = result.pods; updateWorkloadButtons();
      options($('#dcosPod'), result.pods.map((pod) => ({ label: `${pod.name}${pod.status ? ` (${pod.status})` : ''}`, value: pod.name })), '选择 Pod');
      note(result.pods.length ? '请选择 Pod。' : '该 StatefulSet 没有 Pod。');
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
    if (error.code === 'DCOS_SESSION_EXPIRED') { state.connected = false; renderConnection(error.message); cancelRequests(); }
    note(error.message, 'error');
  }
  async function loadLogs() {
    clearTimer();
    if (state.loadingLogs || !isActive() || document.hidden) return;
    const { clusterId, namespaceName, podName, containerName } = selected();
    if (!containerName) return note('请选择容器。');
    const request = gates.logs.next(); state.loadingLogs = true; note('正在读取容器日志…');
    try {
      const result = await getJson(q('/api/dcos/logs', { clusterId, namespaceName, podName, containerName, tailingLines: $('#dcosLines').value }), { signal: request.signal, timeout: 30000 });
      if (!request.isCurrent()) return;
      setText($('#dcosLogText'), result.lines.length ? result.lines.join('\n') : '当前没有日志。');
      const saved = result.saved;
      const savedText = saved?.error ? '本地保存失败' : saved?.appended ? `本地 +${saved.appended} 行` : '本地无新增';
      $('#dcosLogState').title = saved?.path ? `本地日志：${saved.path}` : '';
      note(`已读取 ${result.lines.length} 行 · ${formatDate(result.readAt, { withZone: true })} · ${savedText}`, 'success');
    } catch (error) { if (request.isCurrent() && error.code !== 'REQUEST_ABORTED') handleError(error); }
    finally { if (request.isCurrent()) { state.loadingLogs = false; schedule(); } }
  }
  function confirmWorkloadAction(action) {
    const { clusterId, namespaceName, workloadName } = selected();
    if (!workloadName) return note('请先选择 StatefulSet。');
    const verb = action === 'stop' ? '停止' : '启动';
    state.pendingAction = { action, clusterId, namespaceName, workloadName };
    setText($('#confirmTitle'), `确认${verb} StatefulSet`);
    setText($('#confirmMessage'), action === 'stop'
      ? '停止后该 StatefulSet 的全部 Pod 会下线，可能影响测试环境数据处理，请确认目标正确。'
      : '启动后平台会重新拉起该 StatefulSet 的全部 Pod，请确认目标正确。');
    setText($('#confirmTarget'), `${clusterId}:${namespaceName} / ${workloadName}`);
    confirmDialog.open($('#btnConfirmAction'));
  }
  async function runWorkloadAction({ action, clusterId, namespaceName, workloadName }) {
    if (state.runningAction) return;
    state.runningAction = true; updateWorkloadButtons();
    note(`${action === 'stop' ? '正在停止' : '正在启动'} ${workloadName}…`);
    try {
      await postJson(`/api/dcos/workload/${action}`, { clusterId, namespaceName, workloadName }, { timeout: 30000 });
      note(`${action === 'stop' ? '已停止' : '已启动'} ${workloadName}，正在刷新 Pod 列表…`, 'success');
      await loadPods();
    } catch (error) { handleError(error); updateWorkloadButtons(); }
    finally { state.runningAction = false; updateWorkloadButtons(); }
  }

  $('#dcosCookieInput').addEventListener('input', () => renderConnection());
  $('#dcosConnect').addEventListener('click', async (event) => {
    event.preventDefault(); event.stopPropagation(); // 折叠卡片内的按钮不应触发 summary 展开/收起
    const cookie = $('#dcosCookieInput').value;
    $('#dcosConnect').disabled = true; setText($('#dcosConnectionError'), '正在验证会话…');
    try { applyStatus(await postJson('/api/dcos/connect', { cookie }, { timeout: 30000 }), '云翼平台会话已连接。'); note('请选择集群。'); }
    catch (error) { renderConnection(error.message); }
    finally { $('#dcosCookieInput').value = ''; renderConnection(); }
  });
  $('#dcosDisconnect').addEventListener('click', async (event) => {
    event.preventDefault(); event.stopPropagation();
    try { cancelRequests(); applyStatus(await postJson('/api/dcos/disconnect', {}), '已断开云翼平台会话。'); setText($('#dcosLogText'), ''); note('请重新连接云翼平台。'); }
    catch (error) { renderConnection(error.message); }
  });
  $('#dcosCluster').addEventListener('change', () => { void loadNamespaces(); });
  $('#dcosNamespace').addEventListener('change', () => { state.pageNow = 1; void loadWorkloads(); });
  $('#dcosWorkload').addEventListener('change', () => { void loadPods(); });
  $('#dcosPod').addEventListener('change', selectPod);
  $('#dcosContainer').addEventListener('change', () => { cancelLogRequest(); $('#dcosRefresh').disabled = !$('#dcosContainer').value; setText($('#dcosLogText'), ''); if ($('#dcosContainer').value) void loadLogs(); });
  $('#dcosSearchButton').addEventListener('click', () => { state.pageNow = 1; void loadWorkloads(); });
  $('#dcosWorkloadSearch').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('#dcosSearchButton').click(); } });
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
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelLogRequest(); else if (isActive() && $('#dcosAutoRefresh').checked) void loadLogs(); });
  void loadStatus();
  return {
    activate() { if (!state.connected) note('请先在此页粘贴云翼平台 Cookie。'); schedule(); },
    deactivate() { cancelRequests(); },
  };
}
