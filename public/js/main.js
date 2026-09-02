import { $, $$, announce, ApiError, createRequestGate, DialogController, el, formatBytes, getJson, postJson, setText } from '/shared/ui.js';

const state = {
  connected: false, config: null, home: '~', cwd: '~', hdfsCwd: localStorage.getItem('wb_hdfs_cwd') || '/apps', hbaseCwd: localStorage.getItem('wb_hbase_cwd') || '/',
  history: [], historyIndex: 0, sessionPassword: '', pendingConfirm: null, pendingName: null, pendingParam: null,
  gates: { files: createRequestGate(), hdfs: createRequestGate(), hbase: createRequestGate() }, refreshBlocks: new Map(), statusTimer: null, statusRunning: false, pendingUpload: null, loaded: { files: false, hdfs: false, hbase: false },
};

const COMMANDS = [
  { group: '查看', label: '当前位置', command: 'pwd', desc: '显示远程主目录和当前工作位置。' },
  { group: '查看', label: '当前目录', command: 'ls -lh', desc: '列出当前目录的文件和目录。', autoCwd: true },
  { group: '查看', label: '磁盘空间', command: 'df -h', desc: '查看磁盘容量和使用率。' },
  { group: '查看', label: '内存使用', command: 'free -h', desc: '查看内存和交换分区。' },
  { group: '查看', label: '运行中的进程', command: 'ps -ef | head -60', desc: '查看前 60 个进程。' },
  { group: '查看', label: '查看文件', param: 'file', desc: '安全预览文本文件的前 256 KiB。' },
  { group: '查看', label: '查看最后 N 行', param: 'tail', desc: '适合查看最新日志。' },
  { group: '系统', label: '运行时长与负载', command: 'uptime', desc: '查看系统运行时长和负载。' },
  { group: '系统', label: '当前登录用户', command: 'who && whoami', desc: '查看登录用户和当前用户。' },
  { group: '删除', label: '高级删除命令', command: 'rm ', desc: '仅用于已确认的自由命令；结构化文件删除请使用目录行操作。', danger: true },
];
const BILLING = [
  { title: '常用 HDFS 目录', rows: [['计费根目录', '/apps'], ['采预 prep', '/apps/bill_cnos_jf_test/prep'], ['批价 cal', '/apps/bill_cnos_jf/cal']] },
  { title: '话单表映射', rows: [['语音话单', 'TICKET_CDMA_VOICE'], ['数据业务', 'TICKET_DATA'], ['异常单', 'TICKET_ABNORMAL'], ['不计费话单', 'TICKET_OTHER']] },
  { title: 'HBase 速查', rows: [['分发表', '{ns}:TICKET_DISPATCH_FILE'], ['量本主表', '{ns}:ACCUMULATION_{month}'], ['排重表', '{ns}:source_file_index_{month}']] },
  { title: '排障提示', rows: [['分发', 'STRA / MR'], ['处理批次', 'pro_ 前缀表示在途'], ['命名空间', '按当前环境填写并复制']] },
];

const dialogs = new Map(['settingsDialog', 'commandsDialog', 'paramDialog', 'billingDialog', 'confirmDialog', 'nameDialog', 'uploadDialog', 'previewDialog', 'hbaseScanDialog', 'cdrDialog'].map((id) => [id, new DialogController(document.getElementById(id))]));
function openDialog(id, focus) { dialogs.get(id)?.open(focus); }
function closeDialog(id) { dialogs.get(id)?.close(); }
$$('[data-dialog-close]').forEach((button) => button.addEventListener('click', () => closeDialog(button.dataset.dialogClose)));

function icon(name, label = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', label ? 'false' : 'true'); svg.classList.add('row-icon');
  if (label) svg.setAttribute('aria-label', label);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `/shared/icons.svg#${name}`); svg.append(use); return svg;
}
function toast(message, tone = '') { const node = el('div', { class: `toast ${tone}`, text: message }); $('#toast').append(node); setTimeout(() => node.remove(), 3600); }
function status(message, tone = 'info') { announce($('#explorerState'), message, tone); announce($('#live'), message, tone); }
function shellQuote(value) { return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`; }
function nowTime() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }
// 若整段输出是 JSON，则按 2 空格缩进美化（一行一个结构）；否则原样返回，不影响普通日志
// 支持四种情况：(1) 完整 JSON / (2) 多行 NDJSON（每行一个 JSON）/ (3) 末尾被截断的 JSON（启发式补全）/ (4) 普通文本原样返回
function prettifyJson(text) {
  const raw = String(text == null ? '' : text);
  const trimmed = raw.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return text;
  const tryParse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
  const format = (value) => JSON.stringify(value, null, 2);
  // 1. 直接 parse（单行紧凑 JSON 或已格式化 JSON）
  const direct = tryParse(trimmed);
  if (direct !== null) return format(direct);
  // 2. NDJSON：多行多对象，每行单独 parse 后逐个格式化
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    const parsed = lines.map(tryParse);
    if (parsed.every((value) => value !== null)) {
      return parsed.map((value) => format(value)).join('\n\n');
    }
  }
  // 3. 启发式补全截断：跟踪未闭合的 "、(、[、{ 深度，按相反顺序补齐
  const stack = []; let i = 0; let inString = false; let escaped = false;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) { escaped = false; }
      else if (ch === '\\') { escaped = true; }
      else if (ch === '"') { inString = false; stack.pop(); }
    } else if (ch === '"') { inString = true; stack.push('"'); }
    else if (ch === '{' || ch === '[') { stack.push(ch === '{' ? '}' : ']'); }
    i++;
  }
  if (stack.length > 0) {
    const suffix = stack.reverse().join('');
    const value = tryParse(trimmed + suffix);
    if (value !== null) return format(value);
  }
  return text;
}
function pathJoin(dir, name) { return `${dir.replace(/\/+$/, '') || '/'}/${name}`.replace(/^\/\//, '/'); }
function storedConfig() { try { const value = JSON.parse(localStorage.getItem('wb_conn_cfg') || '{}'); return { host: value.host || '', port: value.port || 22, username: value.username || '' }; } catch (_) { return {}; } }
function saveStoredConfig(value) { localStorage.setItem('wb_conn_cfg', JSON.stringify({ host: value.host, port: Number(value.port) || 22, username: value.username })); }

function setConnected(connected, cfg = null) {
  state.connected = connected; if (cfg) state.config = cfg;
  const dot = $('#statusDot'); dot.className = `status-dot ${connected ? 'on' : ''}`;
  setText($('#statusText'), connected ? `已连接 · ${state.config?.host || ''} · ${state.config?.username || ''}` : '未连接');
  const button = $('#btnConnect'); setText(button, connected ? '断开' : '连接'); button.classList.toggle('primary', !connected);
  if (!connected) { $('#fileList').replaceChildren(el('div', { class: 'empty-tip', text: '尚未连接服务器\n请先点击右上角“连接”' })); $('#hdfsList').replaceChildren(el('div', { class: 'empty-tip', text: '尚未连接服务器' })); $('#hbaseList').replaceChildren(el('div', { class: 'empty-tip', text: '尚未连接服务器' })); state.loaded.files = false; state.loaded.hdfs = false; state.loaded.hbase = false; state.gates.files.cancel(); state.gates.hdfs.cancel(); state.gates.hbase.cancel(); stopRefreshBlocks(); }
}

function createLogBlock(command, { refreshable = false, buildCommand = null, historic = false } = {}) {
  $('#emptyState').classList.add('hidden');
  const badge = el('span', { class: 'badge run', text: historic ? '历史记录' : '执行中…' });
  const output = el('pre', { class: 'log-body' }); setText(output, historic ? '' : '正在执行…');
  const head = el('div', { class: 'log-head' }, el('span', { class: 'log-time', text: nowTime() }), el('span', { class: 'log-cmd', text: command }), badge, el('span', { class: 'log-spacer' }));
  if (refreshable && buildCommand) {
    const checkbox = el('input', { type: 'checkbox', 'aria-label': '自动刷新' }); const label = el('label', { class: 'switch' }, checkbox, '自动刷新'); head.append(label);
    checkbox.addEventListener('change', () => checkbox.checked ? startRefreshBlock(block) : stopRefreshBlock(block));
  }
  const copy = el('button', { class: 'fact', type: 'button', text: '复制' }); copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(output.textContent || ''); toast('输出已复制', 'ok'); } catch (_) { toast('复制失败，请手动选择文本', 'err'); } }); head.append(copy);
  const node = el('article', { class: 'log-block' }, head, output); $('#logFlow').append(node);
  const blocks = $$('#logFlow .log-block'); if (blocks.length > 200) blocks.slice(0, blocks.length - 200).forEach((old) => old.remove());
  const block = {
    node, command, badge, output, refreshable, buildCommand, running: false, timer: null,
    setResult(text, code, duration, truncated = false) { badge.className = `badge ${code === 0 ? 'ok' : 'err'}`; setText(badge, code === 0 ? `成功 · ${(duration / 1000).toFixed(1)}s` : `退出码 ${code}`); setText(output, `${prettifyJson(text) || '（无输出）'}${truncated ? '\n\n[输出已达到 2 MiB 上限，后续内容已截断]' : ''}`); },
    setError(message) { badge.className = 'badge err'; setText(badge, '失败'); setText(output, `✕ ${message}`); },
    serialize() { return { t: node.querySelector('.log-time')?.textContent || '', cmd: command, badge: badge.textContent || '', out: output.textContent || '' }; },
  };
  return block;
}
async function persistLog(block) { try { await postJson('/api/log/append', block.serialize()); } catch (_) {} }
function stopRefreshBlock(block) { if (block) { clearTimeout(block.timer); block.timer = null; state.refreshBlocks.delete(block.node); return; } state.refreshBlocks.forEach((item) => { clearTimeout(item.timer); }); state.refreshBlocks.clear(); }
function startRefreshBlock(block) {
  if (!block?.buildCommand) return;
  stopRefreshBlock(block); state.refreshBlocks.set(block.node, block);
  const tick = async () => {
    if (!state.refreshBlocks.has(block.node)) return;
    if (document.hidden || block.running) { block.timer = setTimeout(tick, 10000); return; }
    block.running = true;
    try { const result = await postJson('/api/exec', { cmd: block.buildCommand(), confirmed: false }); if (result.ok) block.setResult(result.stdout || result.stderr, result.code, result.duration, result.truncated); else block.setError(result.error?.message || '执行失败'); } catch (error) { block.setError(error.message); } finally { block.running = false; block.timer = document.hidden ? null : setTimeout(tick, 10000); }
  };
  void tick();
}
async function runCommand(command, options = {}) {
  const block = createLogBlock(command, options);
  try {
    const result = await postJson('/api/exec', { cmd: command, confirmed: options.confirmed === true, timeout: options.timeout });
    if (result.ok) { block.setResult(result.stdout || result.stderr, result.code, result.duration, result.truncated); if (result.truncated) toast('命令输出超过 2 MiB，已截断', 'warn'); if (options.onDone && result.code === 0) options.onDone(); }
    else block.setError(result.error?.message || '执行失败');
    await persistLog(block); return result;
  } catch (error) { block.setError(error.message || '执行失败'); await persistLog(block); toast(error.message || '命令执行失败', 'err'); return null; }
}
async function restoreLogs() {
  try {
    const date = $('#logDate').value; const query = date ? `?date=${encodeURIComponent(date)}&limit=200` : '?limit=200'; const result = await getJson(`/api/log/list${query}`);
    if (!result.entries?.length) { $('#emptyState').classList.remove('hidden'); return; }
    result.entries.forEach((entry) => { const block = createLogBlock(entry.cmd || '', { historic: true }); setText(block.node.querySelector('.log-time'), entry.t || ''); block.badge.className = /失败|退出码/.test(entry.badge || '') ? 'badge err' : 'badge ok'; setText(block.badge, entry.badge || '历史记录'); setText(block.output, prettifyJson(entry.out) || ''); });
    toast(`已恢复最近 ${result.entries.length} 条日志`, 'ok');
  } catch (_) {}
}

function renderBreadcrumbs(container, current, rootLabel, navigate) {
  container.replaceChildren(); const root = rootLabel === '~' ? '~' : '/'; container.append(el('button', { type: 'button', text: root, on: { click: () => navigate(rootLabel) } }));
  const parts = current === rootLabel || current === '/' ? [] : current.replace(/^\//, '').split('/').filter(Boolean); let built = rootLabel === '~' ? '~' : '';
  parts.forEach((part) => { const sep = el('span', { class: 'sep', text: '/' }); built = rootLabel === '~' && built === '~' ? `~/${part}` : `${built}/${part}`; const target = built; container.append(sep, el('button', { type: 'button', text: part, on: { click: () => navigate(target) } })); });
}
function resourceRow(item, kind) {
  const fullPath = item.path || pathJoin(kind === 'files' ? state.cwd : kind === 'hbase' ? state.hbaseCwd : state.hdfsCwd, item.name); const nameButton = el('button', { type: 'button', class: item.isDir ? 'dir' : '', text: `${item.name}${item.isDir ? '/' : ''}`, title: fullPath });
  const row = el('div', { class: 'resource-row' }, el('div', { class: 'resource-name' }, icon(item.isDir ? 'folder' : 'file'), nameButton), el('span', { class: 'resource-size', text: item.isDir ? '—' : (kind === 'hbase' ? '表' : formatBytes(item.size)) }), el('span', { class: 'resource-date', text: item.mtime || '—' }), el('div', { class: 'resource-actions' }));
  const actions = row.querySelector('.resource-actions');
  if (kind === 'hbase') {
    if (item.isDir) { const enter = el('button', { class: 'fact', type: 'button', text: '进入' }); enter.addEventListener('click', () => { state.hbaseCwd = fullPath; localStorage.setItem('wb_hbase_cwd', fullPath); refreshHbase(); }); actions.append(enter); }
    else { const scan = el('button', { class: 'fact', type: 'button', text: '查看' }); scan.addEventListener('click', () => scanHbase(fullPath)); actions.append(scan); }
    nameButton.addEventListener('dblclick', () => item.isDir ? (state.hbaseCwd = fullPath, localStorage.setItem('wb_hbase_cwd', fullPath), refreshHbase()) : scanHbase(fullPath));
    return row;
  }
  if (item.isDir) { const enter = el('button', { class: 'fact', type: 'button', text: '进入' }); enter.addEventListener('click', () => kind === 'files' ? (state.cwd = fullPath, refreshFiles()) : (state.hdfsCwd = fullPath, localStorage.setItem('wb_hdfs_cwd', fullPath), refreshHdfs())); actions.append(enter); if (kind === 'files') { const remove = el('button', { class: 'fact danger', type: 'button', text: '删除' }); remove.addEventListener('click', () => confirmDelete(fullPath, 'dir')); actions.append(remove); } }
  else { const view = el('button', { class: 'fact', type: 'button', text: '查看' }); view.addEventListener('click', () => previewRemote(fullPath, kind)); const download = el('button', { class: 'fact', type: 'button', text: '下载' }); download.addEventListener('click', () => downloadRemote(fullPath, kind)); actions.append(view, download); if (kind === 'files') { const remove = el('button', { class: 'fact danger', type: 'button', text: '删除' }); remove.addEventListener('click', () => confirmDelete(fullPath, 'file')); const upload = el('button', { class: 'fact', type: 'button', text: '上传到 HDFS' }); upload.addEventListener('click', () => openUploadDialog(fullPath)); actions.append(remove, upload); } }
  nameButton.addEventListener('dblclick', () => item.isDir ? (kind === 'files' ? (state.cwd = fullPath, refreshFiles()) : (state.hdfsCwd = fullPath, refreshHdfs())) : previewRemote(fullPath, kind)); return row;
}
function renderResourceList(container, items, kind) { container.replaceChildren(); if (!items?.length) { container.append(el('div', { class: 'empty-tip', text: '该目录为空' })); return; } items.forEach((item) => container.append(resourceRow(item, kind))); }

async function refreshFiles() {
  if (!state.connected) return; const request = state.gates.files.next(); $('#fileList').replaceChildren(el('div', { class: 'empty-tip', text: '正在读取目录…' })); status('正在读取服务器文件目录…');
  try { const result = await postJson('/api/sftp/list', { path: state.cwd }, { signal: request.signal }); if (!request.isCurrent()) return; state.cwd = result.path || state.cwd; state.loaded.files = true; $('#pathInput').value = state.cwd; renderBreadcrumbs($('#crumbs'), state.cwd, state.home || '~', (value) => { state.cwd = value; refreshFiles(); }); renderResourceList($('#fileList'), result.items, 'files'); status(`${result.items?.length || 0} 项`, 'success'); }
  catch (error) { if (error.code === 'REQUEST_ABORTED') return; $('#fileList').replaceChildren(el('div', { class: 'empty-tip', text: error.message })); status(error.message, 'error'); }
}
async function refreshHdfs() {
  if (!state.connected) return; const request = state.gates.hdfs.next(); $('#hdfsList').replaceChildren(el('div', { class: 'empty-tip', text: '正在读取 HDFS 目录…' }));
  try { const result = await postJson('/api/hdfs/list', { path: state.hdfsCwd }, { signal: request.signal }); if (!request.isCurrent()) return; state.hdfsCwd = result.path || state.hdfsCwd; state.loaded.hdfs = true; $('#hdfsPathInput').value = state.hdfsCwd; renderBreadcrumbs($('#hdfsCrumbs'), state.hdfsCwd, '/', (value) => { state.hdfsCwd = value; localStorage.setItem('wb_hdfs_cwd', value); refreshHdfs(); }); renderResourceList($('#hdfsList'), result.items, 'hdfs'); status(`${result.items?.length || 0} 项`, 'success'); }
  catch (error) { if (error.code === 'REQUEST_ABORTED') return; $('#hdfsList').replaceChildren(el('div', { class: 'empty-tip', text: error.message })); status(error.message, 'error'); }
}
async function refreshHbase() {
  if (!state.connected) return; const request = state.gates.hbase.next(); $('#hbaseList').replaceChildren(el('div', { class: 'empty-tip', text: '正在读取 HBase 命名空间…' }));
  try { const result = await postJson('/api/hbase/list', { path: state.hbaseCwd }, { signal: request.signal }); if (!request.isCurrent()) return; state.hbaseCwd = result.path || state.hbaseCwd; state.loaded.hbase = true; $('#hbasePathInput').value = state.hbaseCwd; renderBreadcrumbs($('#hbaseCrumbs'), state.hbaseCwd, '/', (value) => { state.hbaseCwd = value; localStorage.setItem('wb_hbase_cwd', value); refreshHbase(); }); renderResourceList($('#hbaseList'), result.items, 'hbase'); status(`${result.items?.length || 0} 项`, 'success'); }
  catch (error) { if (error.code === 'REQUEST_ABORTED') return; $('#hbaseList').replaceChildren(el('div', { class: 'empty-tip', text: error.message })); status(error.message, 'error'); }
}
async function scanHbase(tablePath) {
  setText($('#hbaseScanTitle'), 'HBase 表查看'); setText($('#hbaseScanMeta'), tablePath); setText($('#hbaseScanText'), '正在读取…'); openDialog('hbaseScanDialog');
  try { const result = await postJson('/api/hbase/scan', { path: tablePath, limit: 20 }); setText($('#hbaseScanMeta'), `${result.table} · 最多 ${result.limit} 行`); setText($('#hbaseScanText'), prettifyJson(result.text) || '（无数据）'); }
  catch (error) { setText($('#hbaseScanText'), error.message); }
}
async function previewRemote(remotePath, kind) {
  openDialog('previewDialog'); setText($('#previewTitle'), kind === 'hdfs' ? 'HDFS 文件预览' : '文件预览'); setText($('#previewMeta'), remotePath); setText($('#previewText'), '正在读取…');
  try { if (kind === 'files') { const result = await postJson('/api/sftp/preview', { path: remotePath, maxBytes: 262144 }); setText($('#previewText'), prettifyJson(result.text) || '（空文件）'); if (result.truncated) setText($('#previewMeta'), `${remotePath} · 已显示前 256 KiB，内容已截断`); } else { const result = await runCommand(`hadoop fs -cat ${shellQuote(remotePath)} | head -c 262144`, { timeout: 60000 }); closeDialog('previewDialog'); if (result?.ok) toast('HDFS 内容已写入执行日志', 'ok'); } } catch (error) { setText($('#previewText'), error.message); }
}
function downloadRemote(remotePath, kind) { const a = document.createElement('a'); a.href = `${kind === 'hdfs' ? '/api/hdfs/download' : '/api/sftp/download'}?path=${encodeURIComponent(remotePath)}`; a.download = ''; document.body.append(a); a.click(); a.remove(); toast(`开始下载：${remotePath.split('/').pop()}`, 'ok'); }
async function uploadLocalFile(file) {
  if (!state.connected) { toast('请先连接服务器', 'err'); return; }
  const targetDir = state.cwd;
  const block = createLogBlock(`上传本地文件 → ${targetDir}/${file.name}`);
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch('/api/sftp/upload', { method: 'POST', headers: { 'X-Target-Dir': targetDir, 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' }, body: buf });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) throw new Error(json.error?.message || `上传失败（HTTP ${res.status}）`);
    block.setResult(`已上传：${json.remotePath}\n大小：${formatBytes(json.size)}`, 0, 0);
    toast(`已上传到 ${json.remotePath}`, 'ok');
    await persistLog(block);
    refreshFiles();
  } catch (error) {
    block.setError(error.message);
    await persistLog(block);
    toast(error.message, 'err');
  }
}
function openUploadDialog(localPath) { state.pendingUpload = localPath; $('#uploadLocal').value = localPath; $('#uploadDir').value = state.hdfsCwd; $('#uploadDir').removeAttribute('aria-invalid'); setText($('#uploadError'), ''); openDialog('uploadDialog', $('#uploadDir')); }
$('#btnUploadSubmit').addEventListener('click', async () => { const localPath = state.pendingUpload; const hdfsDir = $('#uploadDir').value.trim(); if (!localPath) { setText($('#uploadError'), '未指定要上传的文件'); return; } if (!hdfsDir.startsWith('/')) { $('#uploadDir').setAttribute('aria-invalid', 'true'); setText($('#uploadError'), 'HDFS 目标目录必须以 / 开头'); return; } $('#uploadDir').removeAttribute('aria-invalid'); try { const result = await postJson('/api/hdfs/upload', { localPath, hdfsDir }); closeDialog('uploadDialog'); toast(`已上传到 ${result.hdfsPath}`, 'ok'); if (state.hdfsCwd.replace(/\/+$/, '') === hdfsDir.replace(/\/+$/, '')) refreshHdfs(); } catch (error) { setText($('#uploadError'), error.message); } });
function confirmDelete(remotePath, kind) { state.pendingConfirm = { action: async () => { await postJson('/api/sftp/delete', { path: remotePath, kind, confirmed: true }); toast('删除成功', 'ok'); refreshFiles(); } }; setText($('#confirmTitle'), `确认删除${kind === 'dir' ? '空目录' : '文件'}`); setText($('#confirmMessage'), '删除不可恢复，请确认目标路径正确。'); setText($('#confirmTarget'), remotePath); openDialog('confirmDialog', $('#btnConfirmAction')); }
$('#btnConfirmAction').addEventListener('click', async () => { const pending = state.pendingConfirm; state.pendingConfirm = null; closeDialog('confirmDialog'); if (!pending) return; try { await pending.action(); } catch (error) { toast(error.message, 'err'); } });

function openNameDialog(kind) { state.pendingName = kind; setText($('#nameTitle'), kind === 'mkdir' ? '新建目录' : '新建文件'); setText($('#nameLabel'), `${kind === 'mkdir' ? '目录' : '文件'}名称（当前目录：${state.cwd}）`); $('#nameInput').value = ''; setText($('#nameError'), ''); openDialog('nameDialog', $('#nameInput')); }
$('#btnNameSubmit').addEventListener('click', async () => { const name = $('#nameInput').value.trim(); const invalid = !name || /[\\/]/.test(name) || name === '.' || name === '..'; $('#nameInput').toggleAttribute('aria-invalid', invalid); if (invalid) { setText($('#nameError'), '请输入不含路径分隔符的名称'); return; } const kind = state.pendingName; try { await postJson(`/api/sftp/${kind}`, { path: pathJoin(state.cwd, name) }); closeDialog('nameDialog'); toast(kind === 'mkdir' ? '目录已创建' : '文件已创建', 'ok'); refreshFiles(); } catch (error) { setText($('#nameError'), error.message); } });

function renderCommands() { const root = $('#commandGroups'); root.replaceChildren(); const groups = [...new Set(COMMANDS.map((item) => item.group))]; groups.forEach((group) => { const items = COMMANDS.filter((item) => item.group === group); const list = el('section', { class: 'command-group' }, el('h3', { text: group })); items.forEach((item) => { const run = el('button', { class: 'fact', type: 'button', text: item.param ? '填写' : '执行' }); run.addEventListener('click', () => { if (item.param) openParamCommand(item); else if (item.danger) { setText($('#confirmTitle'), '确认执行高级删除命令'); setText($('#confirmMessage'), '自由命令可能影响多个文件，请确认后执行。'); setText($('#confirmTarget'), item.command); state.pendingConfirm = { action: () => runCommand(item.command, { confirmed: true }) }; openDialog('confirmDialog', $('#btnConfirmAction')); } else { closeDialog('commandsDialog'); runCommand(item.autoCwd ? `cd ${shellQuote(state.home === '~' ? state.cwd : state.home)} && ${item.command}` : item.command); } }); list.append(el('div', { class: 'command-item' }, el('span', { class: 'command-label' }, el('strong', { text: item.label }), el('small', { text: item.desc })), run)); }); root.append(list); }); }
function openParamCommand(item) { state.pendingParam = item; setText($('#paramTitle'), item.param === 'file' ? '查看文件' : '查看最后 N 行'); setText($('#paramLabel'), item.param === 'file' ? '文件路径' : '行数和文件路径（例如：100 /var/log/app.log）'); $('#paramInput').value = item.param === 'file' ? state.cwd : '100 '; $('#paramInput').removeAttribute('aria-invalid'); setText($('#paramError'), ''); openDialog('paramDialog', $('#paramInput')); }
$('#btnParamSubmit').addEventListener('click', () => { const item = state.pendingParam; const value = $('#paramInput').value.trim(); if (!item || !value) { $('#paramInput').setAttribute('aria-invalid', 'true'); setText($('#paramError'), '请输入参数'); return; } $('#paramInput').removeAttribute('aria-invalid'); if (item.param === 'file') { runCommand(`cat ${shellQuote(value)} | head -c 262144`, { refreshable: true, buildCommand: () => `cat ${shellQuote(value)} | head -c 262144` }); closeDialog('paramDialog'); return; } const match = value.match(/^(\d+)\s+(.+)$/); if (!match) { $('#paramInput').setAttribute('aria-invalid', 'true'); setText($('#paramError'), '格式应为：行数 文件路径'); return; } const command = `tail -n ${Number(match[1]) || 100} ${shellQuote(match[2])}`; closeDialog('paramDialog'); runCommand(command, { refreshable: true, buildCommand: () => command }); });

function renderBilling() { const root = $('#billingContent'); root.replaceChildren(); const search = $('#billSearch').value.trim().toLowerCase(); const suffix = $('#billSuffix').value.trim() || '597_2606'; const month = $('#billMonth').value.trim() || '202410'; const ns = $('#billNs').value.trim() || 'ns_aibcp_dev'; BILLING.forEach((card) => { const rows = card.rows.map(([label, value]) => [label, value.replace('{ns}', ns).replace('{month}', month)]).filter(([label, value]) => !search || `${label}${value}`.toLowerCase().includes(search)); if (!rows.length) return; const section = el('section', { class: 'billing-card' }, el('h3', { text: card.title })); rows.forEach(([label, value]) => { const code = el('code', { text: value, title: value }); const copy = el('button', { class: 'fact', type: 'button', text: '复制' }); copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(value); toast('已复制', 'ok'); } catch (_) { toast('复制失败', 'err'); } }); section.append(el('div', { class: 'billing-row' }, el('span', { text: label }), code, copy)); }); root.append(section); }); }

async function doConnect(overrides = {}) { const saved = storedConfig(); const body = { ...saved, ...overrides }; if (state.sessionPassword) body.password = state.sessionPassword; $('#btnConnect').disabled = true; setText($('#statusText'), '正在连接…'); try { const result = await postJson('/api/connect', body); setConnected(true, result.config); state.home = result.home || '~'; state.cwd = state.home; saveStoredConfig({ ...body, ...result.config }); toast(`已连接 ${result.config.host}`, 'ok'); await refreshFiles(); } catch (error) { setConnected(false); toast(error.message || '连接失败', 'err'); } finally { $('#btnConnect').disabled = false; } }
$('#btnConnect').addEventListener('click', async () => { if (state.connected) { try { await postJson('/api/disconnect', {}); } finally { setConnected(false); toast('已断开连接'); } } else { const cfg = state.config || storedConfig(); $('#cfgHost').value = cfg.host || ''; $('#cfgPort').value = cfg.port || 22; $('#cfgUser').value = cfg.username || ''; $('#cfgPass').value = ''; setText($('#settingsError'), ''); openDialog('settingsDialog', $('#cfgHost')); } });
$('#btnSaveCfg').addEventListener('click', () => { const host = $('#cfgHost').value.trim(); const portValue = $('#cfgPort').value.trim(); const port = Number(portValue); const username = $('#cfgUser').value.trim(); const invalid = !host || !username || !portValue || !Number.isInteger(port) || port < 1 || port > 65535; ['cfgHost', 'cfgPort', 'cfgUser'].forEach((id) => document.getElementById(id)?.toggleAttribute('aria-invalid', invalid)); if (invalid) { setText($('#settingsError'), '服务器地址、端口和用户名必须填写正确'); return; } ['cfgHost', 'cfgPort', 'cfgUser'].forEach((id) => document.getElementById(id)?.removeAttribute('aria-invalid')); state.sessionPassword = $('#cfgPass').value; saveStoredConfig({ host, port, username }); closeDialog('settingsDialog'); void doConnect({ host, port, username }); });
$('#emptyConnect').addEventListener('click', () => $('#btnConnect').click());
$('#btnSettings').addEventListener('click', () => { const cfg = state.config || storedConfig(); $('#cfgHost').value = cfg.host || ''; $('#cfgPort').value = cfg.port || 22; $('#cfgUser').value = cfg.username || ''; $('#cfgPass').value = ''; setText($('#settingsError'), ''); openDialog('settingsDialog', $('#cfgHost')); });
$('#btnCmds').addEventListener('click', () => { renderCommands(); openDialog('commandsDialog'); });
$('#btnBilling').addEventListener('click', () => { renderBilling(); openDialog('billingDialog', $('#billSearch')); });
$('#btnCdr').addEventListener('click', () => { if (!$('#cdrFrame').getAttribute('src')) $('#cdrFrame').src = '/cdr/'; openDialog('cdrDialog'); });
$('#billSearch').addEventListener('input', renderBilling); ['billSuffix', 'billMonth', 'billNs'].forEach((id) => $( `#${id}`).addEventListener('input', renderBilling));

function switchTab(tab) { $$('.tab').forEach((button) => { const active = button.dataset.tab === tab; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); }); $('#filesPane').classList.toggle('hidden', tab !== 'files'); $('#hdfsPane').classList.toggle('hidden', tab !== 'hdfs'); $('#hbasePane').classList.toggle('hidden', tab !== 'hbase'); if (tab === 'hdfs' && state.connected && !state.loaded.hdfs) refreshHdfs(); if (tab === 'hbase' && state.connected && !state.loaded.hbase) refreshHbase(); }
$$('.tab').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
$('#btnRefresh').addEventListener('click', refreshFiles); $('#btnHdfsRefresh').addEventListener('click', refreshHdfs); $('#btnMkdir').addEventListener('click', () => state.connected ? openNameDialog('mkdir') : toast('请先连接服务器', 'err')); $('#btnTouch').addEventListener('click', () => state.connected ? openNameDialog('touch') : toast('请先连接服务器', 'err'));
$('#btnUploadLocal').addEventListener('click', () => { if (!state.connected) { toast('请先连接服务器', 'err'); return; } const input = $('#localFileInput'); input.value = ''; input.click(); });
$('#localFileInput').addEventListener('change', () => { const file = $('#localFileInput').files && $('#localFileInput').files[0]; if (!file) return; void uploadLocalFile(file); });
$('#btnUp').addEventListener('click', () => { if (state.cwd === '~' || state.cwd === state.home) return; state.cwd = state.cwd.replace(/\/[^/]+\/?$/, '') || '/'; refreshFiles(); }); $('#btnHdfsUp').addEventListener('click', () => { if (state.hdfsCwd !== '/') { state.hdfsCwd = state.hdfsCwd.replace(/\/[^/]+\/?$/, '') || '/'; localStorage.setItem('wb_hdfs_cwd', state.hdfsCwd); refreshHdfs(); } });
$('#btnHbaseRefresh').addEventListener('click', refreshHbase); $('#btnHbaseUp').addEventListener('click', () => { if (state.hbaseCwd !== '/') { state.hbaseCwd = '/'; localStorage.setItem('wb_hbase_cwd', '/'); refreshHbase(); } }); $('#btnHbaseGoto').addEventListener('click', () => { const value = $('#hbasePathInput').value.trim(); if (!value) return; if (value !== '/' && !/^\/[^/]+$/.test(value)) return toast('HBase 路径只能为 / 或 /namespace', 'err'); state.hbaseCwd = value; localStorage.setItem('wb_hbase_cwd', value); refreshHbase(); }); $('#hbasePathInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#btnHbaseGoto').click(); });
$('#btnGoto').addEventListener('click', () => { const value = $('#pathInput').value.trim(); if (value) { state.cwd = value; refreshFiles(); } }); $('#pathInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#btnGoto').click(); }); $('#btnHdfsGoto').addEventListener('click', () => { const value = $('#hdfsPathInput').value.trim(); if (!value.startsWith('/')) return toast('HDFS 路径必须以 / 开头', 'err'); state.hdfsCwd = value; localStorage.setItem('wb_hdfs_cwd', value); refreshHdfs(); }); $('#hdfsPathInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#btnHdfsGoto').click(); }); $$('[data-hdfs-path]').forEach((button) => button.addEventListener('click', () => { state.hdfsCwd = button.dataset.hdfsPath; localStorage.setItem('wb_hdfs_cwd', state.hdfsCwd); switchTab('hdfs'); refreshHdfs(); }));

async function submitCommand() { const input = $('#cmdInput'); const command = input.value.trim(); if (!command) return; state.history.push(command); state.historyIndex = state.history.length; input.value = ''; if (!state.connected) return toast('请先连接服务器', 'err'); if (/\b(?:rm|rmdir|del|erase|format)\b/i.test(command)) { setText($('#confirmTitle'), '确认执行删除命令'); setText($('#confirmMessage'), '删除类自由命令需要二次确认。'); setText($('#confirmTarget'), command); state.pendingConfirm = { action: () => runCommand(command, { confirmed: true }) }; openDialog('confirmDialog', $('#btnConfirmAction')); return; } runCommand(command); }
$('#btnRun').addEventListener('click', submitCommand); $('#cmdInput').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitCommand(); } else if (event.key === 'ArrowUp') { event.preventDefault(); state.historyIndex = Math.max(0, state.historyIndex - 1); $('#cmdInput').value = state.history[state.historyIndex] || ''; } else if (event.key === 'ArrowDown') { event.preventDefault(); state.historyIndex = Math.min(state.history.length, state.historyIndex + 1); $('#cmdInput').value = state.history[state.historyIndex] || ''; } }); $$('#chips .chip').forEach((chip) => chip.addEventListener('click', () => { $('#cmdInput').value = chip.dataset.command; $('#cmdInput').focus(); }));
$('#btnClear').addEventListener('click', () => { stopRefreshBlock(); $('#logFlow').replaceChildren(); $('#emptyState').classList.remove('hidden'); }); $('#btnExport').addEventListener('click', () => { const blocks = $$('#logFlow .log-block'); if (!blocks.length) return toast('暂无日志可导出'); const lines = ['# Server Workbench · 会话日志', `# 导出时间：${new Date().toLocaleString('zh-CN')}`, '']; blocks.forEach((block) => lines.push(`──── [${block.querySelector('.log-time')?.textContent}] ${block.querySelector('.log-cmd')?.textContent}（${block.querySelector('.badge')?.textContent}）`, block.querySelector('.log-body')?.textContent || '', '')); const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'server-workbench-log.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }); $('#btnLogReload').addEventListener('click', () => { $('#logFlow').replaceChildren(); restoreLogs(); }); $('#logDate').valueAsDate = new Date();

async function checkStatus() { if (document.hidden || state.statusRunning) return; state.statusRunning = true; try { const result = await getJson('/api/status'); if (state.connected && !result.connected) { setConnected(false); toast('远程连接已断开', 'err'); } } catch (error) { if (state.connected) { setConnected(false); toast('本地桥接服务不可用', 'err'); } } finally { state.statusRunning = false; if ($('#autoStatus').checked && !document.hidden) state.statusTimer = setTimeout(checkStatus, 5000); } }
$('#autoStatus').checked = true; $('#autoStatus').addEventListener('change', () => { clearTimeout(state.statusTimer); if ($('#autoStatus').checked) checkStatus(); }); document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(state.statusTimer); state.refreshBlocks.forEach((block) => { clearTimeout(block.timer); block.timer = null; }); } else { if ($('#autoStatus').checked) checkStatus(); [...state.refreshBlocks.values()].forEach((block) => startRefreshBlock(block)); } });

renderCommands(); renderBreadcrumbs($('#crumbs'), state.cwd, state.home, (value) => { state.cwd = value; refreshFiles(); }); renderBreadcrumbs($('#hdfsCrumbs'), state.hdfsCwd, '/', (value) => { state.hdfsCwd = value; refreshHdfs(); });
(async function init() {
  try { const cfg = await getJson('/api/config'); state.config = cfg.config || storedConfig(); $('#cfgHost').value = state.config.host || ''; $('#cfgPort').value = state.config.port || 22; $('#cfgUser').value = state.config.username || ''; } catch (_) {}
  await restoreLogs();
  await restoreSession();
  checkStatus();
})();

// 页面刷新/重开后的会话恢复：SSH 长连接存活在后端 Node 进程里，刷新页面并不会真的断开，
// 这里探测后端状态直接恢复前端 UI（无需重新输密码）；若后端也已断开则用保存的配置自动重连。
async function restoreSession() {
  try {
    const saved = storedConfig();
    const status = await getJson('/api/status');
    if (status?.connected) {
      // 后端 SSH 会话仍在：直接恢复前端状态，不重新认证
      const conn = status.conn || { host: saved.host, port: saved.port, username: saved.username };
      setConnected(true, conn);
      state.home = status.home || '~';
      state.cwd = state.home;
      status(`已恢复连接 · ${conn.host || ''}`, 'success');
      toast(`已恢复 ${conn.host || ''} 的连接会话`, 'ok');
      if ($('#filesPane') && !$('#filesPane').classList.contains('hidden')) refreshFiles();
      return;
    }
    // 后端无会话：尝试用已保存的主机/端口/用户名自动重连（密码由后端配置文件提供，不落浏览器）
    if (saved.host && saved.username) {
      try {
        const result = await postJson('/api/connect', { host: saved.host, port: saved.port, username: saved.username });
        setConnected(true, result.config); state.home = result.home || '~'; state.cwd = state.home;
        toast(`已自动重连 ${result.config.host}`, 'ok');
        if ($('#filesPane') && !$('#filesPane').classList.contains('hidden')) refreshFiles();
      } catch (_) { /* 自动重连失败（如密码未配置）：保持未连接，等待用户手动连接 */ }
    }
  } catch (_) { /* 桥接服务不可用：保持默认未连接状态 */ }
}
