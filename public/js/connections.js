import { $, el, postJson, setText } from '/shared/ui.js';
export const DB_SOURCE_LABEL = { udal: '测试环境 · MySQL / UDAL', doris: 'Doris', pg: '测试环境 · PostgreSQL', voyage: '工程环境 · Voyage' };

export function initConnections({ state, setConnected, refreshFiles, resetResourceState, renderBigdataSource, clearQueryResult, syncQuerySchemaControl, activeDatabaseSource, openDialog, toast }) {
const connecting = new Set();

function connectionConfig(source) {
  if (source === 'ssh') return state.config || state.connectionProfiles.ssh || {};
  if (source === 'bigdata') return state.bigdata.config || state.connectionProfiles.bigdata || {};
  if (source === 'voyage') return state.voyage.config || state.connectionProfiles.voyage || {};
  return state.databases[source].config || state.connectionProfiles[source] || {};
}
function renderConnectionList() {
  for (const source of ['ssh', 'bigdata', 'udal', 'doris', 'pg', 'voyage']) {
    const errorNode = document.querySelector(`[data-connection-error="${source}"]`);
    if (errorNode) errorNode.dataset.tone = state.connectionErrors[source] ? 'error' : 'info';
    const config = connectionConfig(source); const connected = source === 'ssh' ? state.connected : source === 'bigdata' ? state.bigdata.connected : source === 'voyage' ? state.voyage.connected : state.databases[source].connected;
    if (connecting.has(source)) { const button = document.querySelector(`[data-connection-connect="${source}"]`); if (button) { button.disabled = true; setText(button, '连接中…'); } continue; }
    if (source === 'bigdata') {
      const configured = Boolean(config.configured); const clientMode = state.bigdata.mode === 'client';
      const values = { endpoint: `${config.remoteHost || '127.0.0.1'}:${config.remotePort || '—'}`, token: config.hasToken ? '已配置' : '未配置', defaultMode: config.defaultMode === 'client' ? '常驻客户端' : 'SSH 命令', cache: `${Math.round((Number(config.listCacheMs) || 30000) / 1000)} 秒`, timeout: `${Math.round((Number(config.timeoutMs) || 30000) / 1000)} 秒` };
      for (const [field, value] of Object.entries(values)) setText(document.querySelector(`[data-connection-field="bigdata.${field}"]`), value);
      document.querySelector('[data-connection-dot="bigdata"]')?.classList.toggle('on', connected);
      setText(document.querySelector('[data-connection-status="bigdata"]'), connected ? '已连接' : clientMode ? (configured ? '未连接' : '待配置') : 'SSH 命令模式');
      setText(document.querySelector('[data-connection-error="bigdata"]'), state.connectionErrors.bigdata || (configured ? 'HDFS 内容与 HBase 扫描实时读取；命名空间和表列表缓存 30 秒。' : '请在本机 .env 配置 BIGDATA_CLIENT_TOKEN。'));
      const button = document.querySelector('[data-connection-connect="bigdata"]'); if (button) { button.disabled = !configured || !state.connected; setText(button, configured ? (connected ? '重新连接' : '连接客户端') : '待配置'); }
      document.querySelector('[data-connection-use-ssh]')?.classList.toggle('primary', !clientMode);
      continue;
    }
    if (source === 'voyage') {
      const mapping = config.mappings?.CRM3DB || {}; const tokenInput = $('#voyageTokenInput');
      const validMapping = (item = {}) => Number.isInteger(Number(item.datasourceId)) && Number(item.datasourceId) > 0 && Boolean(item.database && item.schema);
      const baseConfigured = Boolean(config.apiUrl && validMapping(config.mappings?.CRM3DB) && validMapping(config.mappings?.CONFIGDB_CNOS_JF_TEST));
      const hasUsableToken = Boolean(config.hasToken || tokenInput?.value.trim()); const configured = baseConfigured && hasUsableToken;
      const values = { apiUrl: config.apiUrl || '—', datasource: mapping.datasourceId || '—', database: mapping.database && mapping.schema ? `${mapping.database} / ${mapping.schema}` : '—', token: config.hasToken ? '已配置' : '未配置', timeoutMs: `${Math.round((Number(config.timeoutMs) || 15000) / 1000)} 秒` };
      for (const [field, value] of Object.entries(values)) { const node = document.querySelector(`[data-connection-field="voyage.${field}"]`); setText(node, value); if (field === 'apiUrl') node?.setAttribute('title', value); }
      document.querySelector('[data-connection-dot="voyage"]')?.classList.toggle('on', connected);
      setText(document.querySelector('[data-connection-status="voyage"]'), connected ? '已连接' : !baseConfigured ? '待配置' : '未连接');
      setText(document.querySelector('[data-connection-error="voyage"]'), state.connectionErrors.voyage || (!baseConfigured ? '请在本机 .env 补充 Voyage 接口与数据源映射。' : config.hasToken ? '使用固定只读 SQL 模板查询工程环境。' : '请输入 VOYAGE_TOKEN，或在本机 .env 配置。'));
      const button = document.querySelector('[data-connection-connect="voyage"]'); if (button) { button.disabled = !configured; setText(button, !baseConfigured ? '待配置' : !hasUsableToken ? '请输入 Token' : connected ? '重新连接' : '连接'); }
      continue;
    }
    const configured = Boolean(config.host && config.username);
    const values = { host: config.host || '—', port: config.port || '—', username: config.username || '—', database: source === 'udal' ? 'CRM3DB、CONFIGDB_CNOS_JF_TEST' : config.database || '—', password: config.hasPassword ? '已配置' : '未配置' };
    for (const [field, value] of Object.entries(values)) setText(document.querySelector(`[data-connection-field="${source}.${field}"]`), value);
    document.querySelector(`[data-connection-dot="${source}"]`)?.classList.toggle('on', connected);
    setText(document.querySelector(`[data-connection-status="${source}"]`), connected ? '已连接' : configured ? '未连接' : '待配置');
    setText(document.querySelector(`[data-connection-error="${source}"]`), state.connectionErrors[source] || (source === 'pg' ? '固定档案查询与 Redis 同步从 bill_inmemory 只读；配置定义仍查 MySQL，不执行导出脚本。' : ''));
    const connectButton = document.querySelector(`[data-connection-connect="${source}"]`);
    connectButton.disabled = !connected && !configured;
    setText(connectButton, connected ? '重新连接' : configured ? '连接' : '待配置');
  }
}
async function connectSource(source) {
  if (!['ssh', 'bigdata', 'udal', 'doris', 'pg', 'voyage'].includes(source)) return;
  const button = document.querySelector(`[data-connection-connect="${source}"]`);
  if (connecting.has(source)) return;
  connecting.add(source);
  button.disabled = true; setText(button, '连接中…'); state.connectionErrors[source] = '';
  const errorNode = document.querySelector(`[data-connection-error="${source}"]`);
  errorNode.dataset.tone = 'info'; setText(errorNode, '正在连接…');
  try {
    if (source === 'ssh') {
      const response = await postJson('/api/connect', {}, { timeout: 30000 });
      setConnected(true, response.config || state.connectionProfiles.ssh); state.home = response.home || '~'; state.cwd = state.home;
      renderConnectionList(); toast('SSH / SFTP 已连接', 'ok'); await refreshFiles();
    } else if (source === 'bigdata') {
      const response = await postJson('/api/bigdata/connect', {}, { timeout: 30000 }); state.bigdata = { connected: Boolean(response.connected), mode: response.mode || 'client', config: response.config || state.connectionProfiles.bigdata };
      ['hdfs', 'hbase'].forEach((kind) => resetResourceState(kind)); renderBigdataSource(); renderConnectionList(); toast('HDFS/HBase 常驻客户端服务已连接', 'ok');
    } else if (source === 'voyage') {
      const token = $('#voyageTokenInput')?.value.trim() || '';
      clearQueryResult({ all: true }); const response = await postJson('/api/voyage/connect', token ? { token } : {}, { timeout: 30000 });
      state.voyage = { connected: Boolean(response.connected), config: response.config || state.connectionProfiles.voyage };
      state.connectionProfiles.voyage = response.config || state.connectionProfiles.voyage;
      $('#querySourceSelect').value = 'voyage'; syncQuerySchemaControl(); clearQueryResult({ all: true });
      renderConnectionList(); renderDbStatus(); toast('工程环境 Voyage 在线数据库已连接', 'ok');
    } else {
      clearQueryResult({ all: true }); const response = await postJson('/api/db/connect', { source }, { timeout: 30000 });
      state.databases[source] = { connected: true, config: response.config || state.connectionProfiles[source], password: '' };
      if (source === 'pg') { $('#querySourceSelect').value = 'pg'; syncQuerySchemaControl(); clearQueryResult({ all: true }); }
      renderConnectionList(); renderDbStatus(); toast(`${DB_SOURCE_LABEL[source]} 已连接`, 'ok');
    }
  } catch (error) {
    state.connectionErrors[source] = error.message;
    if (source === 'ssh') setConnected(false); else if (source === 'bigdata') state.bigdata = { connected: false, mode: 'client', config: state.bigdata.config || state.connectionProfiles.bigdata }; else if (source === 'voyage') state.voyage = { connected: false, config: state.voyage.config || state.connectionProfiles.voyage }; else state.databases[source] = { connected: false, config: state.databases[source].config || state.connectionProfiles[source], password: '' };
    renderConnectionList(); renderDbStatus(); toast(error.message, 'err');
  } finally { connecting.delete(source); if (source === 'voyage' && $('#voyageTokenInput')) $('#voyageTokenInput').value = ''; renderConnectionList(); }
}
async function useSshBigdataMode() {
  try { const response = await postJson('/api/bigdata/use-ssh', {}); state.bigdata = { connected: false, mode: 'ssh', config: response.config || state.bigdata.config || state.connectionProfiles.bigdata }; state.connectionErrors.bigdata = ''; ['hdfs', 'hbase'].forEach((kind) => resetResourceState(kind)); renderBigdataSource(); renderConnectionList(); toast('HDFS/HBase 已切换为 SSH 命令模式', 'ok'); }
  catch (error) { state.connectionErrors.bigdata = error.message; renderConnectionList(); toast(error.message, 'err'); }
}
function renderDbStatus() {
  const root = $('#dbStatusCards'); root.replaceChildren();
  for (const source of (activeDatabaseSource() === 'voyage' && state.activeQuery !== 'relations' ? [] : ['pg', 'udal'])) {
    const item = state.databases[source]; const config = item.config || state.connectionProfiles[source] || {}; const detail = item.connected ? `${config.host || ''}:${config.port || ''} · ${config.username || ''}` : config.host && config.username ? '未连接' : '待配置';
    root.append(el('button', { class: 'db-status-card', type: 'button', on: { click: () => { openConnections(source); } } }, el('span', { class: `status-dot ${item.connected ? 'on' : ''}`, 'aria-hidden': 'true' }), el('span', { class: 'db-status-copy' }, el('strong', { text: DB_SOURCE_LABEL[source] }), el('small', { text: detail }))));
  }
  if (activeDatabaseSource() !== 'voyage' || state.activeQuery === 'relations') return;
  const voyageConfig = state.voyage.config || state.connectionProfiles.voyage || {}; const voyageDetail = state.voyage.connected ? '工程环境 · 已连接' : voyageConfig.configured ? '工程环境 · 未连接' : '工程环境 · 待配置';
  root.append(el('button', { class: 'db-status-card', type: 'button', on: { click: () => { openConnections('voyage'); } } }, el('span', { class: `status-dot ${state.voyage.connected ? 'on' : ''}`, 'aria-hidden': 'true' }), el('span', { class: 'db-status-copy' }, el('strong', { text: DB_SOURCE_LABEL.voyage }), el('small', { text: voyageDetail }))));
}

function openConnections(source) {
  if (!source) {
    const page = document.querySelector('[data-primary-page][aria-current="page"]')?.dataset.primaryPage;
    source = page === 'workspace' ? 'ssh' : page === 'query' && activeDatabaseSource() === 'voyage' && state.activeQuery !== 'relations' ? 'voyage' : 'pg';
  }
  renderConnectionList();
  const target = document.querySelector(`[data-connection-source="${source}"]`);
  const group = target?.closest('details');
  document.querySelectorAll('.connection-environment').forEach(item => { item.open = item === group; });
  openDialog('connectionDialog', target?.querySelector('button'));
  requestAnimationFrame(() => target?.scrollIntoView({ block: 'nearest' }));
}
return { renderConnectionList, connectSource, useSshBigdataMode, renderDbStatus, openConnections };
}
