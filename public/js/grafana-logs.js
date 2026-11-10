import { $, announce, createRequestGate, el, formatDate, getJson, postJson } from '/shared/ui.js';

export function initGrafanaLogs() {
  const form = $('#grafanaLogForm');
  const login = $('#grafanaLogin');
  const search = $('#grafanaLogSearch');
  const service = $('#grafanaLogService');
  const picker = service.closest('.grafana-service-picker');
  const toggle = $('#grafanaServiceToggle');
  const popup = $('#grafanaServicePopup');
  const options = $('#grafanaServiceOptions');
  const empty = $('#grafanaServiceEmpty');
  const selectedAlias = $('#grafanaSelectedAlias');
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
  let serviceNames = [], selectedService = '', matches = [], activeOption = -1;
  let serviceAliases = {};
  const aliasFor = name => Object.hasOwn(serviceAliases, name) ? serviceAliases[name] : '';

  function closeServices() {
    popup.hidden = true;
    activeOption = -1;
    service.setAttribute('aria-expanded', 'false');
    service.removeAttribute('aria-activedescendant');
  }
  function highlightOption(index, scroll = false) {
    options.children[activeOption]?.classList.remove('is-active');
    activeOption = index;
    const item = options.children[index];
    if (!item) { service.removeAttribute('aria-activedescendant'); return; }
    item.classList.add('is-active');
    service.setAttribute('aria-activedescendant', item.id);
    if (scroll) item.scrollIntoView({ block: 'nearest' });
  }
  function openServices() {
    if (service.disabled) return;
    const words = selectedService ? [] : service.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    matches = serviceNames.filter(name => {
      const searchable = `${name} ${aliasFor(name)}`.toLowerCase();
      return words.every(word => searchable.includes(word));
    });
    options.replaceChildren(...matches.map((name, index) => {
      const alias = aliasFor(name);
      return el('div', {
        id: `grafana-service-option-${index}`, role: 'option', 'aria-selected': String(name === selectedService),
        dataset: { serviceIndex: index },
      }, alias ? el('span', { class: 'grafana-option-alias', text: alias }) : null,
      el('span', { class: alias ? 'grafana-option-original' : '', text: name }));
    }));
    empty.hidden = Boolean(matches.length);
    popup.hidden = false;
    popup.scrollTop = 0;
    service.setAttribute('aria-expanded', 'true');
    highlightOption(matches.indexOf(selectedService), true);
  }
  function chooseService(index) {
    if (service.disabled || popup.hidden || !matches[index]) return;
    selectedService = service.value = matches[index];
    closeServices();
    filtersChanged();
  }

  function updateButtons() {
    login.disabled = !configured || connected || signingIn;
    login.textContent = signingIn ? '等待 Grafana 登录…' : connected ? 'Grafana 已连接' : '登录 Grafana';
    refresh.disabled = !connected || loadingServices || querying;
    service.disabled = toggle.disabled = !connected || loadingServices || !serviceNames.length;
    if (service.disabled) closeServices();
    search.disabled = service.disabled || !selectedService || querying;
    const alias = aliasFor(selectedService);
    selectedAlias.textContent = selectedAlias.title = alias;
    selectedAlias.hidden = !alias;
  }
  function replaceServices(names, aliases = {}) {
    serviceNames = names;
    serviceAliases = aliases;
    if (selectedService && !names.includes(selectedService)) {
      selectedService = '';
      results.replaceChildren();
    }
    service.value = selectedService;
    closeServices();
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
      const { services, aliases, truncated, aliasConfigInvalid } = await getJson(`/api/grafana/services?minutes=${Number(range.value)}`, { signal: request.signal });
      if (!request.isCurrent()) return;
      replaceServices(services, aliases);
      const message = !services.length ? '所选时间范围内没有服务名包含 test 的日志。' :
        `所选时间范围内有日志且名称包含 test 的服务：${services.length} 个${truncated ? '（列表达到上限）' : ''}，请选择后查询。`;
      announce(status, message + (aliasConfigInvalid ? ' 本机服务备注配置读取失败，已显示原名。' : ''));
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
  service.addEventListener('focus', openServices);
  service.addEventListener('click', () => { if (popup.hidden) openServices(); });
  service.addEventListener('input', () => { selectedService = ''; openServices(); });
  toggle.addEventListener('mousedown', event => event.preventDefault());
  toggle.addEventListener('click', () => {
    const open = popup.hidden;
    service.focus();
    if (open) { if (popup.hidden) openServices(); }
    else closeServices();
  });
  options.addEventListener('mousedown', event => event.preventDefault());
  options.addEventListener('click', event => {
    const option = event.target.closest('[data-service-index]');
    if (option) chooseService(Number(option.dataset.serviceIndex));
  });
  picker.addEventListener('focusout', event => { if (!picker.contains(event.relatedTarget)) closeServices(); });
  document.addEventListener('pointerdown', event => { if (!picker.contains(event.target)) closeServices(); });
  service.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (popup.hidden) openServices();
      if (matches.length) {
        const next = event.key === 'ArrowDown' ? Math.min(activeOption + 1, matches.length - 1) :
          activeOption < 0 ? matches.length - 1 : Math.max(activeOption - 1, 0);
        highlightOption(next, true);
      }
    } else if (event.key === 'Enter' && !popup.hidden) {
      event.preventDefault();
      chooseService(activeOption < 0 && matches.length === 1 ? 0 : activeOption);
    } else if (event.key === 'Escape' && !popup.hidden) {
      event.preventDefault();
      closeServices();
    }
  });
  function filtersChanged(target) {
    if (!connected) return;
    cancelQuery();
    results.replaceChildren();
    if (target === range) void loadServices();
    else if (!loadingServices) announce(status, selectedService ? '查询条件已更新，请查询日志。' : '请选择服务后再查询。');
  }
  form.addEventListener('input', event => filtersChanged(event.target));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (search.disabled) return;
    const request = queries.next();
    querying = true;
    updateButtons();
    results.replaceChildren();
    announce(status, '正在查询 Grafana…');
    const filters = { service: selectedService, minutes: Number(range.value), level: level.value, limit: Number(limit.value) };
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
    closeServices();
    if (querying) { cancelQuery(); announce(status, '查询已取消。'); }
  } };
}
