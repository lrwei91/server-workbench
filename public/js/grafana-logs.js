import { $, announce, createRequestGate, el, formatDate, getJson, postJson } from '/shared/ui.js';

export function initGrafanaLogs() {
  const form = $('#grafanaLogForm');
  const login = $('#grafanaLogin');
  const search = $('#grafanaLogSearch');
  const service = $('#grafanaLogService');
  const refresh = $('#grafanaRefreshServices');
  const range = $('#grafanaLogRange');
  const level = $('#grafanaLogLevel');
  const limit = $('#grafanaLogLimit');
  const results = $('#grafanaLogResults');
  const status = $('#grafanaLogState');
  const queries = createRequestGate();
  const serviceLists = createRequestGate();
  let configured = false, connected = false, signingIn = false, querying = false;
  let active = false, initialized = false, loadingServices = false;

  function updateButtons() {
    login.disabled = !configured || connected || signingIn;
    login.textContent = signingIn ? '等待 Grafana 登录…' : connected ? 'Grafana 已连接' : '登录 Grafana';
    refresh.disabled = !connected || loadingServices || querying;
    service.disabled = !connected || loadingServices || service.options.length < 2;
    search.disabled = service.disabled || !service.value || querying;
  }
  function replaceServices(names) {
    const selected = service.value;
    service.replaceChildren(el('option', { value: '', text: '请选择服务' }),
      ...names.map(name => el('option', { value: name, text: name })));
    service.value = names.includes(selected) ? selected : '';
    if (selected && !service.value) results.replaceChildren();
  }
  function handleSessionError(error) {
    if (error.code === 'GRAFANA_LOGIN_REQUIRED') {
      connected = false;
      replaceServices([]);
    }
  }
  async function loadServices() {
    if (!connected) return;
    const request = serviceLists.next();
    loadingServices = true;
    updateButtons();
    announce(status, '正在加载服务列表…');
    try {
      const { services, truncated } = await getJson(`/api/grafana/services?minutes=${Number(range.value)}`, { signal: request.signal });
      if (!request.isCurrent()) return;
      replaceServices(services);
      announce(status, !services.length ? '所选时间范围内未发现产生过日志的服务。' :
        `所选时间范围内有日志的服务：${services.length} 个${truncated ? '（列表达到上限）' : ''}，请选择后查询。`);
    } catch (error) {
      if (!request.isCurrent()) return;
      handleSessionError(error);
      replaceServices([]);
      announce(status, `加载服务列表失败：${error.message}`, 'error');
    } finally {
      if (request.isCurrent()) { loadingServices = false; updateButtons(); }
    }
  }
  async function activate() {
    active = true;
    if (initialized) return;
    try {
      const state = await getJson('/api/grafana/status');
      configured = Boolean(state.configured && state.desktop && window.workbenchDesktop?.loginGrafana);
      connected = Boolean(configured && state.connected);
      initialized = true;
      if (connected) await loadServices();
      else announce(status, !state.desktop ? '请在桌面版使用 Grafana 日志。' :
        !state.configured ? '请在本机 .env 配置 Grafana 后重启工作台。' :
        '请先登录 Grafana。');
    } catch (error) { announce(status, error.message, 'error'); }
    finally { updateButtons(); }
  }
  function cancelQuery() {
    queries.cancel();
    querying = false;
    updateButtons();
  }
  login.addEventListener('click', async () => {
    if (login.disabled) return;
    signingIn = true;
    updateButtons();
    announce(status, '请在独立窗口完成 Grafana 登录。');
    try {
      const result = await window.workbenchDesktop.loginGrafana();
      connected = Boolean(result?.ok);
      if (connected) await loadServices();
      else announce(status, result?.message || 'Grafana 登录未完成。');
    } catch (error) { announce(status, error.message, 'error'); }
    finally { signingIn = false; updateButtons(); }
  });
  refresh.addEventListener('click', loadServices);
  form.addEventListener('input', event => {
    if (!connected) return;
    cancelQuery();
    results.replaceChildren();
    if (event.target === range) void loadServices();
    else if (!loadingServices) announce(status, service.value ? '查询条件已更新，请查询日志。' : '请选择服务后再查询。');
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (search.disabled) return;
    const request = queries.next();
    querying = true;
    updateButtons();
    results.replaceChildren();
    announce(status, '正在查询 Grafana…');
    const filters = { service: service.value, minutes: Number(range.value), level: level.value, limit: Number(limit.value) };
    try {
      const { rows } = await postJson('/api/grafana/query', filters, { signal: request.signal, timeout: 30000 });
      if (!request.isCurrent()) return;
      const fragment = document.createDocumentFragment();
      for (const row of rows) {
        const metadata = [formatDate(row.time, { milliseconds: true }), row.level, row.service_instance_id, row.scope_name,
          row.trace_id && `Trace: ${row.trace_id}`, row.span_id && `Span: ${row.span_id}`].filter(Boolean).join(' · ');
        fragment.append(el('li', {}, el('div', { class: 'grafana-log-meta', text: metadata }), el('pre', { text: row.body ?? '' })));
      }
      results.replaceChildren(fragment);
      results.scrollTop = 0;
      announce(status, rows.length === 0 ? '此时间范围内没有匹配的日志。' :
        `返回 ${rows.length} 条日志${rows.length === filters.limit ? '，达到查询上限' : ''} · 北京时间`);
    } catch (error) {
      if (!request.isCurrent()) return;
      handleSessionError(error);
      announce(status, error.message, 'error');
    } finally {
      if (request.isCurrent()) { querying = false; updateButtons(); }
    }
  });
  return { activate, deactivate() {
    if (!active) return;
    active = false;
    if (querying) { cancelQuery(); announce(status, '查询已取消。'); }
  } };
}
