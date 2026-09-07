import { $, $$, announce, ApiError, createRequestGate, DialogController, el, formatBytes, getJson, postJson, setText } from '/shared/ui.js';

const HDFS_UPLOAD_TIMEOUT = 200000;
const DEFAULT_RESOURCE_TIMEOUTS = { filesListMs: 30000, hdfsListMs: 190000, hbaseScanMs: 130000 };
const RESOURCE_META = {
  files: { listId: 'fileList', searchId: 'filesSearch', matchId: 'filesMatch', sortId: 'filesSort', retryId: 'filesRetry', favoriteButtonId: 'filesFavoriteButton', label: '服务器文件' },
  hdfs: { listId: 'hdfsList', searchId: 'hdfsSearch', matchId: 'hdfsMatch', sortId: 'hdfsSort', retryId: 'hdfsRetry', favoriteButtonId: 'hdfsFavoriteButton', label: 'HDFS' },
  hbase: { listId: 'hbaseList', searchId: 'hbaseSearch', matchId: 'hbaseMatch', sortId: 'hbaseSort', retryId: 'hbaseRetry', favoriteButtonId: 'hbaseFavoriteButton', label: 'HBase' },
};
const FAVORITES_KEY = 'wb_favorites_v1';
const FAVORITE_KIND_LABEL = { files: '服务器文件', hdfs: 'HDFS', hbase: 'HBase' };
const resourceCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
function makeResourceState() { return { items: [], query: '', sortKey: 'name', sortDirection: 'asc', loading: false, startedAt: 0, progressTimer: null, error: '' }; }

const state = {
  connected: false, config: null, home: '~', cwd: '~', hdfsCwd: localStorage.getItem('wb_hdfs_cwd') || '/apps', hbaseCwd: localStorage.getItem('wb_hbase_cwd') || '/',
  history: [], historyIndex: 0, sessionPassword: '', pendingConfirm: null, pendingName: null, pendingParam: null,
  gates: { files: createRequestGate(), hdfs: createRequestGate(), hbase: createRequestGate(), scan: createRequestGate() }, refreshBlocks: new Map(), statusTimer: null, statusRunning: false, pendingUpload: null, loaded: { files: false, hdfs: false, hbase: false },
  annotations: {}, pendingAnnotationPath: '', pendingAnnotationKind: '',
  timeouts: { ...DEFAULT_RESOURCE_TIMEOUTS },
  resources: { files: makeResourceState(), hdfs: makeResourceState(), hbase: makeResourceState() },
  favorites: [],
  pendingFavorite: null,
  hbaseScan: { tablePath: '', limit: 20, rawText: '', displayText: '', truncated: false, loading: false, startedAt: 0, progressTimer: null, error: '', matchIndex: 0 },
};
const ANNOTATIONS_KEY = 'wb_annotations';
// 业务侧默认备注字典：本地未自定义时展示；用户手动保存即覆盖（清空可置空字符串表示不使用默认）
const DEFAULT_ANNOTATIONS = {
  // HDFS 目录流转规范（来源：目录流转规则文档）
  '/apps/bill_cnos_jf_test/prep/normal/input': '输入（测试数据入口，程序自动拉取）',
  '/apps/bill_cnos_jf_test/prep/normal/working': '处理中（在途）',
  '/apps/bill_cnos_jf_test/prep/normal/archive': '归档（处理完成）',
  '/apps/bill_cnos_jf_test/prep/normal/errstyle': '错误样式（格式错误的话单）',
  '/apps/bill_cnos_jf_test/prep/normal/overLoad': '重单（重复话单）',
  '/apps/bill_cnos_jf_test/prep/normal/upload': '上传',

  // HBase 命名空间
  '/ns_cnos': '生产话单环境（话单/HBase 业务表）',
  '/ns_aibcp_dev': '开发环境（量本/账户）',
  '/ns_bill_cnos_jf': '生产话单',
  '/ns_bill_cnos_jf_test': '测试话单',
  '/ns_ffcmp': 'FF 全网比对',

  // 话单类型表（事件类型 → 表名 → 业务含义）
  '/ns_cnos/TICKET_CDMA_GROUP_597_2606': 'CDMA分组话单 (206080000)',
  '/ns_cnos/TICKET_CDMA_VOICE_597_2606': 'CDMA语音话单 (206070000)',
  '/ns_cnos/TICKET_CDMA_SMS_597_2606': 'CDMA短信话单 (206110000)',
  '/ns_cnos/TICKET_CDMA_OPERA_597_2606': 'CDMA增值业务话单 (206120000)',
  '/ns_cnos/TICKET_DATA_597_2606': '数据业务话单 (202010000)',
  '/ns_cnos/TICKET_VOICE_597_2606': '语音话单 (201010000)',
  '/ns_cnos/TICKET_IN_597_2606': '智能网话单 (205060000)',
  '/ns_cnos/TICKET_INFO_STATION_597_2606': '信息台话单 (203030000)',
  '/ns_cnos/TICKET_IVPN_597_2606': '综合VPN话单 (206190000)',
  '/ns_cnos/TICKET_COMM_VOICE_597_2606': '协同通信语音 (204210000)',
  '/ns_cnos/TICKET_BLOC_NCR_597_2606': '彩铃话单 (204350000)',
  '/ns_cnos/TICKET_COMM_SMS_597_2606': '协同通信短信 (204220100)',
  '/ns_cnos/TICKET_QBUG_597_2606': '全国商务领航 (204470000)',
  '/ns_cnos/TICKET_BNG_597_2606': '商务领航声讯外包 (204410000)',
  '/ns_cnos/TICKET_ROAM_VOICE_597_2606': '国漫语音 (208520000)',
  '/ns_cnos/TICKET_ROAM_DATA_597_2606': '国漫数据 (208530000)',
  '/ns_cnos/TICKET_ROAM_SMS_597_2606': '国漫短信 (208540000)',
  '/ns_cnos/TICKET_ROAM_PACKAGE_597_2606': '国漫套餐费 (208550000)',
  '/ns_cnos/TICKET_ABNORMAL': '异常单',
  '/ns_cnos/TICKET_OTHER': '不计费话单',

  // 分发表
  '/ns_cnos/TICKET_DISPATCH_FILE': '分发表（未处理；STRA→策略中心，MR→话单入库）',
  '/ns_cnos/TICKET_DISPATCHED_FILE': '分发表（已处理）',

  // 量本表
  '/ns_cnos/ACCUMULATOR_0': '永久累积量表（长期有效）',
  '/ns_cnos/ACCUMULATOR_202606': '量本主表（用户量本；24A独享→产品实例 / 非24A共享→销售品实例；ACCUM 100=结转 200=使用量）',
  '/ns_cnos/ACCUMULATOR_DETAIL_202606': '量本从表（量本明细）',

  // 批次表（pro_ 前缀=在途，无前缀=已完成；major/minor = 主/子）
  '/ns_cnos/pro_preproc_batch_major_info': '采预批次主表（在途）',
  '/ns_cnos/pro_preproc_batch_minor_info': '采预批次子表（在途）',
  '/ns_cnos/preproc_batch_major_info': '采预批次主表（已完成）',
  '/ns_cnos/preproc_batch_minor_info': '采预批次子表（已完成）',
  '/ns_cnos/pro_rating_batch_major_info': '批价批次主表（在途）',
  '/ns_cnos/pro_rating_batch_minor_info': '批价批次子表（在途）',
  '/ns_cnos/rating_batch_major_info': '批价批次主表（已完成）',
  '/ns_cnos/rating_batch_minor_info': '批价批次子表（已完成）',

  // 采预排重表
  '/ns_cnos/source_file_index_202608': '采预排重表（同文件重跑会被排重；改文件名或清表可处理）',
};
function loadAnnotations() { try { return JSON.parse(localStorage.getItem(ANNOTATIONS_KEY) || '{}') || {}; } catch (_) { return {}; } }
function saveAnnotations(map) { localStorage.setItem(ANNOTATIONS_KEY, JSON.stringify(map)); }
// 用户自定义优先（localStorage），其次默认业务字典；显式空字符串表示用户主动清空（覆盖默认）
function getAlias(path) { const override = (state.annotations || {})[path]; if (override !== undefined) return override; return DEFAULT_ANNOTATIONS[path] || ''; }
function setAlias(path, text) { state.annotations = { ...state.annotations, [path]: text }; saveAnnotations(state.annotations); }
function removeAlias(path) { const next = { ...state.annotations }; delete next[path]; state.annotations = next; saveAnnotations(state.annotations); }

// HBase 表默认备注（按表名匹配，与 namespace 解耦）。
// 背景：测试环境 HBase 命名空间实际为 ns_aibcp_dev / ns_bill_cnos_jf_test / ns_ffcmp 等，
// 没有字典里写的 ns_cnos；且表行路径是 /ns:表名（冒号分隔），字典键是 /ns/表名（斜杠），
// 原「/ns_cnos/表名」形式的表备注在实际环境永远不会命中。改为表名级兜底后，
// 同表名出现在任何 namespace（aibcp/测试话单/FF 比对）都会显示业务备注。
const DEFAULT_TABLE_ALIASES = {
  // 话单类型表（事件类型 → 表名 → 业务含义）
  TICKET_CDMA_GROUP_597_2606: 'CDMA分组话单 (206080000)',
  TICKET_CDMA_VOICE_597_2606: 'CDMA语音话单 (206070000)',
  TICKET_CDMA_SMS_597_2606: 'CDMA短信话单 (206110000)',
  TICKET_CDMA_OPERA_597_2606: 'CDMA增值业务话单 (206120000)',
  TICKET_DATA_597_2606: '数据业务话单 (202010000)',
  TICKET_VOICE_597_2606: '语音话单 (201010000)',
  TICKET_IN_597_2606: '智能网话单 (205060000)',
  TICKET_INFO_STATION_597_2606: '信息台话单 (203030000)',
  TICKET_IVPN_597_2606: '综合VPN话单 (206190000)',
  TICKET_COMM_VOICE_597_2606: '协同通信语音 (204210000)',
  TICKET_BLOC_NCR_597_2606: '彩铃话单 (204350000)',
  TICKET_COMM_SMS_597_2606: '协同通信短信 (204220100)',
  TICKET_QBUG_597_2606: '全国商务领航 (204470000)',
  TICKET_BNG_597_2606: '商务领航声讯外包 (204410000)',
  TICKET_ROAM_VOICE_597_2606: '国漫语音 (208520000)',
  TICKET_ROAM_DATA_597_2606: '国漫数据 (208530000)',
  TICKET_ROAM_SMS_597_2606: '国漫短信 (208540000)',
  TICKET_ROAM_PACKAGE_597_2606: '国漫套餐费 (208550000)',
  TICKET_ABNORMAL: '异常单',
  TICKET_OTHER: '不计费话单',
  TICKET_DISPATCH_FILE: '分发表（未处理；STRA→策略中心，MR→话单入库）',
  TICKET_DISPATCHED_FILE: '分发表（已处理）',
  ACCUMULATOR_0: '永久累积量表（长期有效）',
  ACCUMULATION_0: '永久累积量表（长期有效）',
  // 批次表（pro_ 前缀=在途，无前缀=已完成；major/minor = 主/子）
  pro_preproc_batch_major_info: '采预批次主表（在途）',
  pro_preproc_batch_minor_info: '采预批次子表（在途）',
  preproc_batch_major_info: '采预批次主表（已完成）',
  preproc_batch_minor_info: '采预批次子表（已完成）',
  pro_rating_batch_major_info: '批价批次主表（在途）',
  pro_rating_batch_minor_info: '批价批次子表（在途）',
  rating_batch_major_info: '批价批次主表（已完成）',
  rating_batch_minor_info: '批价批次子表（已完成）',
};
// 账期类动态表名（量本/排重按月建表无法穷举）与试算 TRY_/plcatest 变体用规则兜底
function tableDefaultAlias(name) {
  const raw = String(name || '');
  const direct = DEFAULT_TABLE_ALIASES[raw]; if (direct) return direct;
  const tryLabel = raw.startsWith('TRY_') ? '试算 ' : '';
  const core = (raw.startsWith('TRY_') ? raw.slice(4) : raw).replace(/_plcatest$/, '');
  const viaCore = DEFAULT_TABLE_ALIASES[core]; if (viaCore) return tryLabel + viaCore;
  if (/^(ACCUMULATOR|ACCUMULATION)_DETAIL(_0|_\d{6})$/.test(core)) return tryLabel + '量本从表（量本明细）';
  if (/^(ACCUMULATOR|ACCUMULATION)_0$/.test(core)) return tryLabel + '永久累积量表（长期有效）';
  if (/^(ACCUMULATOR|ACCUMULATION)_\d{6}$/.test(core)) return tryLabel + '量本主表（用户量本；24A独享→产品实例 / 非24A共享→销售品实例；ACCUM 100=结转 200=使用量）';
  if (/^source_file_index_\d{6}$/.test(core)) return tryLabel + '采预排重表（同文件重跑会被排重；改文件名或清表可处理）';
  return '';
}
// 生效备注文案（命中顺序）：用户自定义(按路径，含显式清空) → 默认路径字典 → HBase 表名默认
function aliasTextFor(path, tableName) {
  if (Object.prototype.hasOwnProperty.call(state.annotations || {}, path)) return state.annotations[path];
  const def = DEFAULT_ANNOTATIONS[path]; if (def) return def;
  if (tableName) return tableDefaultAlias(tableName);
  return '';
}
// 备注文案拆分为「短名（内容）」三段式：
//   label  = 括号前短名（列表行内始终显示）
//   status = 括号内的状态类关键词（在途/已处理/已完成/未处理/长期有效…）→ 关键信息，行内保留
//   desc   = 括号内完整内容（查看弹窗展示；含状态，信息最全）
// 无括号或括号内无状态词时 status 为空 → 括号内容整体视为说明，只进查看弹窗
function splitAliasText(text) {
  const value = String(text || '').trim();
  const match = value.match(/^(.*?)\s*[（(](.*)[）)]\s*$/);
  if (!match) return { label: value, status: '', desc: '' };
  const label = match[1].trim() || value;
  const inner = match[2].trim();
  // 注意：不能用 \b 做词边界 —— JS 里 CJK 不属于 \w，汉字与串尾/分隔符之间不构成边界，永远匹配失败
  const statusMatch = inner.match(/^(在途|已处理|未处理|已完成|进行中|待处理|长期有效)(?:[；;，,]|$)/);
  return statusMatch ? { label, status: statusMatch[1], desc: inner } : { label, status: '', desc: inner };
}
function rowAlias(item, kind, fullPath) {
  return aliasTextFor(fullPath, kind === 'hbase' && !item.isDir ? String(item.name || '') : '');
}

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
  { title: '常用 HDFS 目录', rows: [['计费根目录', '/apps'], ['采预 prep（测试）', '/apps/bill_cnos_jf_test/prep'], ['批价 cal（测试）', '/apps/bill_cnos_jf_test/cal'], ['批价 cal（生产）', '/apps/bill_cnos_jf/cal']] },
  { title: '话单表映射', rows: [['语音话单', 'TICKET_CDMA_VOICE'], ['数据业务', 'TICKET_DATA'], ['异常单', 'TICKET_ABNORMAL'], ['不计费话单', 'TICKET_OTHER']] },
  { title: 'HBase 速查', rows: [['分发表', '{ns}:TICKET_DISPATCH_FILE'], ['量本主表', '{ns}:ACCUMULATION_{month}'], ['排重表', '{ns}:source_file_index_{month}']] },
  { title: '排障提示', rows: [['分发', 'STRA / MR'], ['处理批次', 'pro_ 前缀表示在途'], ['命名空间', '按当前环境填写并复制']] },
  { title: '服务清单（Kubernetes）', rows: [
    ['量本初始化', 'idis-rating-accuminit-process-prod'],
    ['采预程序（话单增强）', 'idis-prep-prep-normal-process-prod'],
    ['批价程序（算费）', 'idis-rating-cal-process-prod'],
    ['入库进程（话单→Doris）', 'idis-rating-ticket2pg-process-prod'],
    ['消息发送（→策略中心）', 'idis-rating-msgsend-process-prod'],
    ['达量降速', 'idis-plca-usage-notification-dljs-cmp-prod'],
    ['大流量提醒', 'idis-plca-usage-notification-dljs-cmp-prod'],
    ['阈值提醒', 'idis-plca-usage-notification-process-prod'],
  ] },
];

const dialogs = new Map(['settingsDialog', 'commandsDialog', 'paramDialog', 'billingDialog', 'confirmDialog', 'nameDialog', 'uploadDialog', 'annotationDialog', 'previewDialog', 'hbaseScanDialog', 'cdrDialog'].map((id) => [id, new DialogController(document.getElementById(id))]));
function openDialog(id, focus) {
  // 单 modal 约束：开新弹窗前先收起其它已打开的弹窗。否则两层 modal 叠加时，
  // 下层弹窗的「关闭」按钮点击会被上层 backdrop 截获，表现为「点击完全无反应」。
  for (const [otherId, controller] of dialogs) { if (otherId !== id && controller.isOpen) closeDialog(otherId); }
  dialogs.get(id)?.open(focus);
}
function closeDialog(id) {
  if (id === 'hbaseScanDialog') cancelHbaseScan();
  dialogs.get(id)?.close();
}
// 关闭按钮统一走 document 级事件委托：即使按钮被动态重建/替换、或监听器因任何原因丢失，点击始终可被捕获
document.addEventListener('click', (event) => {
  const button = event.target.closest?.('[data-dialog-close]');
  if (!button) return;
  const id = button.dataset.dialogClose;
  if (id && dialogs.has(id)) closeDialog(id);
});
// 暴露到 window：便于同源 iframe（话单工具）与调试台通过 parent.closeDialog('cdrDialog') 联动关闭宿主弹窗
window.openDialog = openDialog;
window.closeDialog = closeDialog;

document.getElementById('hbaseScanDialog')?.addEventListener('close', () => cancelHbaseScan());

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

function openSettingsDialog() {
  const cfg = state.config || storedConfig();
  $('#cfgHost').value = cfg.host || '';
  $('#cfgPort').value = cfg.port || 22;
  $('#cfgUser').value = cfg.username || '';
  $('#cfgPass').value = '';
  setText($('#settingsError'), '');
  openDialog('settingsDialog', $('#cfgHost'));
}
function renderConsoleEmptyState() {
  const empty = $('#emptyState');
  if ($('#logFlow .log-block')) { empty.classList.add('hidden'); return; }
  setText(empty.querySelector('strong'), state.connected ? '暂无执行日志' : '连接后从这里开始');
  setText(empty.querySelector('span'), state.connected ? '可以浏览目录、使用快捷指令，或直接执行一条命令。' : '连接服务器后，可以浏览目录、使用快捷指令，或直接执行一条命令。');
  $('#emptyConnect').classList.toggle('hidden', state.connected);
  empty.classList.remove('hidden');
}


function currentResourcePath(kind) { return kind === 'files' ? state.cwd : kind === 'hdfs' ? state.hdfsCwd : state.hbaseCwd; }
function setCurrentResourcePath(kind, value) {
  if (kind === 'files') state.cwd = value;
  else if (kind === 'hdfs') { state.hdfsCwd = value; localStorage.setItem('wb_hdfs_cwd', value); }
  else { state.hbaseCwd = value; localStorage.setItem('wb_hbase_cwd', value); }
}
function resourceState(kind) { return state.resources[kind]; }
function resourceNode(kind) { return $(`#${RESOURCE_META[kind].listId}`); }
function resourceStatusNode(kind) { return $(`#${kind}State`); }
function clearResourceTimer(view) { if (view?.progressTimer) { clearInterval(view.progressTimer); view.progressTimer = null; } }

function favoriteServerKey() {
  const saved = storedConfig();
  const configured = state.config || {};
  const host = String((state.connected ? configured.host : configured.host || saved.host) || '').trim().toLowerCase();
  const port = Number((state.connected ? configured.port : configured.port || saved.port) || 22);
  const username = String((state.connected ? configured.username : configured.username || saved.username) || '').trim();
  return host || username ? `${host}|${port}|${username}` : 'unconfigured';
}
function readFavoriteStore() {
  try {
    const value = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) { return {}; }
}
function loadFavoritesForCurrentServer() {
  const entries = readFavoriteStore()[favoriteServerKey()];
  if (!Array.isArray(entries)) return [];
  return entries.filter((item) => FAVORITE_KIND_LABEL[item?.kind] && typeof item.path === 'string' && item.path).map((item) => ({
    kind: item.kind, path: item.path, label: typeof item.label === 'string' ? item.label : '', updatedAt: Number(item.updatedAt) || 0,
  }));
}
function saveFavorites() {
  const store = readFavoriteStore();
  store[favoriteServerKey()] = state.favorites.map(({ kind, path, label, updatedAt }) => ({ kind, path, label, updatedAt }));
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(store));
}
function favoriteId(kind, path) { return `${kind}:${path}`; }
function findFavorite(kind, path) { return state.favorites.find((item) => item.kind === kind && item.path === path) || null; }
function favoriteDefaultLabel(kind, path) {
  const value = String(path || '').replace(/\/+$/, '') || '/';
  if (kind === 'hbase' && value.includes(':')) {
    const tableName = value.slice(value.indexOf(':') + 1);
    const alias = aliasTextFor(value, tableName);
    if (alias) return splitAliasText(alias).label || tableName;
    return tableName;
  }
  const alias = getAlias(value);
  if (alias) return kind === 'hbase' ? splitAliasText(alias).label : alias;
  if (kind === 'files' && (value === '~' || value === '/')) return '主目录';
  const parts = value.split('/').filter(Boolean);
  return parts.pop() || (kind === 'files' ? '主目录' : '/');
}
function isFavorite(kind, path) { return Boolean(findFavorite(kind, path)); }
function renderFavorites() {
  const list = $('#favoritesList');
  if (!list) return;
  setText($('#favoritesCount'), state.favorites.length ? `${state.favorites.length} 项` : '');
  list.replaceChildren();
  if (!state.favorites.length) { list.append(el('span', { class: 'favorite-empty', text: '收藏当前目录或 HBase 表后会显示在这里' })); return; }
  state.favorites.forEach((favorite) => {
    const label = favorite.label || favoriteDefaultLabel(favorite.kind, favorite.path);
    const open = el('button', { class: 'favorite-open', type: 'button', text: `${FAVORITE_KIND_LABEL[favorite.kind]} · ${label}`, title: favorite.path, 'aria-label': `打开${FAVORITE_KIND_LABEL[favorite.kind]}：${favorite.path}` });
    open.addEventListener('click', () => openFavorite(favorite));
    const remove = el('button', { class: 'favorite-remove', type: 'button', text: '×', title: '取消收藏', 'aria-label': `取消收藏：${label}` });
    remove.addEventListener('click', (event) => { event.stopPropagation(); removeFavorite(favorite.kind, favorite.path); });
    list.append(el('span', { class: 'favorite-item' }, open, remove));
  });
}
function updateFavoriteButtons() {
  Object.entries(RESOURCE_META).forEach(([kind, meta]) => {
    const button = $(`#${meta.favoriteButtonId}`);
    if (!button) return;
    const path = currentResourcePath(kind);
    const table = kind === 'hbase' && path.includes(':');
    const label = table ? '当前表' : '当前目录';
    setText(button, `${isFavorite(kind, path) ? '★ 已收藏' : '☆ 收藏'}${label}`);
    button.title = path;
  });
}
function openFavoriteDialog(kind, path = currentResourcePath(kind)) {
  if (!state.connected) { toast('请先连接服务器', 'err'); return; }
  const value = String(path || '').trim();
  if (!value) { toast('当前位置为空，无法收藏', 'err'); return; }
  const existing = findFavorite(kind, value);
  state.pendingFavorite = { kind, path: value };
  setText($('#favoriteKind'), `${FAVORITE_KIND_LABEL[kind]} · ${value}`);
  $('#favoritePath').value = value;
  $('#favoriteLabel').value = existing?.label || favoriteDefaultLabel(kind, value);
  $('#favoriteLabel').removeAttribute('aria-invalid');
  setText($('#favoriteError'), '');
  $('#btnFavoriteRemove').classList.toggle('hidden', !existing);
  openDialog('favoriteDialog', $('#favoriteLabel'));
}
function removeFavorite(kind, path) {
  const before = state.favorites.length;
  state.favorites = state.favorites.filter((item) => !(item.kind === kind && item.path === path));
  if (state.favorites.length === before) return;
  saveFavorites(); renderFavorites(); updateFavoriteButtons();
  if (state.pendingFavorite?.kind === kind && state.pendingFavorite?.path === path) { state.pendingFavorite = null; closeDialog('favoriteDialog'); }
  toast('已取消收藏', 'ok');
}
function openFavorite(favorite) {
  if (!state.connected) { toast('请先连接服务器', 'err'); return; }
  const { kind, path } = favorite;
  if (kind !== 'hbase') { switchTab(kind, { load: false }); void navigateResource(kind, path); return; }
  switchTab('hbase', { load: false });
  if (path.includes(':')) {
    const namespace = path.replace(/^\/+/, '').split(':')[0];
    navigateResource('hbase', `/${namespace}`);
    void scanHbase(path);
  } else navigateResource('hbase', path);
}
function startResourceLoading(kind) {
  const view = resourceState(kind);
  const meta = RESOURCE_META[kind];
  clearResourceTimer(view);
  view.loading = true; view.error = ''; view.startedAt = Date.now();
  resourceNode(kind)?.setAttribute('aria-busy', 'true');
  const update = () => {
    const seconds = Math.max(0, Math.floor((Date.now() - view.startedAt) / 1000));
    const message = `正在刷新 · 已等待 ${seconds} 秒`;
    announce(resourceStatusNode(kind), message, 'info');
    status(`${meta.label} · ${currentResourcePath(kind)} · ${message}`);
  };
  update();
  view.progressTimer = setInterval(update, 1000);
  if (!view.items.length) renderResourceView(kind);
}
function finishResourceLoading(kind, error = null) {
  const view = resourceState(kind);
  clearResourceTimer(view); view.loading = false; view.startedAt = 0; view.error = error?.message || '';
  resourceNode(kind)?.setAttribute('aria-busy', 'false');
  const retry = $(`#${RESOURCE_META[kind].retryId}`);
  retry?.classList.toggle('hidden', !error);
  announce(resourceStatusNode(kind), error?.message || '', error ? 'error' : 'success');
}
function resourceSearchText(item, kind) {
  const path = item.path || pathJoin(currentResourcePath(kind), item.name || '');
  return `${item.name || ''}\n${path}\n${rowAlias(item, kind, path)}`.toLocaleLowerCase('zh-CN');
}
function resourceSortValue(item, key) {
  if (key === 'size') return Number.isFinite(Number(item.size)) ? Number(item.size) : 0;
  if (key === 'mtime') {
    const parsed = Date.parse(item.mtime || '');
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return String(item.name || '');
}
function sortResourceItems(items, kind) {
  const view = resourceState(kind);
  const sorted = [...items];
  const direction = view.sortDirection === 'desc' ? -1 : 1;
  sorted.sort((a, b) => {
    const dirs = Number(Boolean(b.isDir)) - Number(Boolean(a.isDir));
    if (dirs) return dirs;
    let comparison;
    if (view.sortKey === 'name') comparison = resourceCollator.compare(resourceSortValue(a, 'name'), resourceSortValue(b, 'name'));
    else comparison = resourceSortValue(a, view.sortKey) - resourceSortValue(b, view.sortKey);
    if (!comparison) comparison = resourceCollator.compare(String(a.path || a.name || ''), String(b.path || b.name || ''));
    return comparison * direction;
  });
  return sorted;
}
function renderResourceView(kind) {
  const view = resourceState(kind);
  const list = resourceNode(kind);
  if (!list) return;
  const query = view.query.trim().toLocaleLowerCase('zh-CN');
  const filtered = view.items.filter((item) => !query || resourceSearchText(item, kind).includes(query));
  setText($(`#${RESOURCE_META[kind].matchId}`), query ? `匹配 ${filtered.length} / ${view.items.length} 项` : `共 ${view.items.length} 项`);
  if (view.loading && !view.items.length) { list.replaceChildren(el('div', { class: 'empty-tip', text: '正在读取目录…' })); return; }
  if (view.error && !view.items.length) { list.replaceChildren(el('div', { class: 'empty-tip', text: view.error })); return; }
  if (!view.items.length) { list.replaceChildren(el('div', { class: 'empty-tip', text: '该目录为空' })); return; }
  if (!filtered.length) { list.replaceChildren(el('div', { class: 'empty-tip', text: '当前列表没有匹配项' })); return; }
  list.replaceChildren(...sortResourceItems(filtered, kind).map((item) => resourceRow(item, kind)));
  updateFavoriteButtons();
}
function resetResourceState(kind, { clearItems = true, clearSearch = true } = {}) {
  const view = resourceState(kind);
  clearResourceTimer(view); view.loading = false; view.error = ''; view.startedAt = 0;
  state.gates[kind].cancel();
  if (clearItems) { view.items = []; state.loaded[kind] = false; }
  if (clearSearch) { view.query = ''; const input = $(`#${RESOURCE_META[kind].searchId}`); if (input) input.value = ''; }
  resourceNode(kind)?.setAttribute('aria-busy', 'false');
  $(`#${RESOURCE_META[kind].retryId}`)?.classList.add('hidden');
  announce(resourceStatusNode(kind), '', 'info');
}
function navigateResource(kind, path) {
  const value = String(path || '').trim() || (kind === 'files' ? state.home || '~' : '/');
  setCurrentResourcePath(kind, value);
  resetResourceState(kind, { clearItems: true, clearSearch: true });
  if (kind === 'files') $('#pathInput').value = value;
  if (kind === 'hdfs') $('#hdfsPathInput').value = value;
  if (kind === 'hbase') $('#hbasePathInput').value = value;
  renderResourceView(kind); updateFavoriteButtons();
  return refreshResource(kind);
}

function setConnected(connected, cfg = null) {
  state.connected = connected; if (cfg) state.config = cfg;
  const dot = $('#statusDot'); dot.className = `status-dot ${connected ? 'on' : ''}`;
  setText($('#statusText'), connected ? `已连接 · ${state.config?.host || ''} · ${state.config?.username || ''}` : '未连接');
  const button = $('#btnConnect'); setText(button, connected ? '断开' : '连接'); button.classList.toggle('primary', !connected);
  if (connected) { state.favorites = loadFavoritesForCurrentServer(); renderFavorites(); updateFavoriteButtons(); return; }
  ['files', 'hdfs', 'hbase'].forEach((kind) => { resetResourceState(kind); });
  if (dialogs.get('hbaseScanDialog')?.isOpen) closeDialog('hbaseScanDialog');
  cancelHbaseScan(); state.hbaseScan.rawText = ''; state.hbaseScan.displayText = ''; state.hbaseScan.truncated = false; state.hbaseScan.error = ''; state.hbaseScan.tablePath = '';
  $('#fileList').replaceChildren(el('div', { class: 'empty-tip', text: '尚未连接服务器\n请先点击右上角“连接”' }));
  $('#hdfsList').replaceChildren(el('div', { class: 'empty-tip', text: '尚未连接服务器' }));
  $('#hbaseList').replaceChildren(el('div', { class: 'empty-tip', text: '尚未连接服务器' }));
  renderFavorites(); updateFavoriteButtons(); stopRefreshBlocks();
  renderConsoleEmptyState();
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
    if (!result.entries?.length) { renderConsoleEmptyState(); return; }
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
  const fullPath = item.path || pathJoin(currentResourcePath(kind), item.name); const nameButton = el('button', { type: 'button', class: item.isDir ? 'dir' : '', text: `${item.name}${item.isDir ? '/' : ''}`, title: fullPath });
  const nameCell = el('div', { class: 'resource-name' }, icon(item.isDir ? 'folder' : 'file'), nameButton);
  const alias = rowAlias(item, kind, fullPath); if (alias) { const split = kind === 'hbase' && !item.isDir ? splitAliasText(alias) : null; const inlineLabel = split ? (split.status ? `${split.label}（${split.status}）` : split.label) : alias; nameCell.append(el('span', { class: 'dir-alias', text: `[${inlineLabel}]`, title: alias })); }
  const row = el('div', { class: 'resource-row' }, nameCell, el('span', { class: 'resource-size', text: item.isDir ? '—' : (kind === 'hbase' ? '表' : formatBytes(item.size)) }), el('span', { class: 'resource-date', text: item.mtime || '—' }), el('div', { class: 'resource-actions' }));
  const actions = row.querySelector('.resource-actions');
  if (kind === 'hbase') {
    if (item.isDir) { const enter = el('button', { class: 'fact', type: 'button', text: '进入' }); enter.addEventListener('click', () => navigateResource('hbase', fullPath)); actions.append(enter); const note = el('button', { class: 'fact', type: 'button', text: '备注' }); note.addEventListener('click', () => openAnnotationDialog(fullPath, rowAlias(item, kind, fullPath), kind)); actions.append(note); }
    else {
      const scan = el('button', { class: 'fact', type: 'button', text: '查看' }); scan.addEventListener('click', () => scanHbase(fullPath));
      const note = el('button', { class: 'fact', type: 'button', text: '备注' }); note.addEventListener('click', () => openAnnotationDialog(fullPath, rowAlias(item, kind, fullPath), kind));
      const favorite = el('button', { class: 'fact', type: 'button', text: isFavorite('hbase', fullPath) ? '★' : '☆', title: isFavorite('hbase', fullPath) ? '编辑收藏' : '收藏表', 'aria-label': isFavorite('hbase', fullPath) ? '编辑收藏' : '收藏表' }); favorite.addEventListener('click', () => openFavoriteDialog('hbase', fullPath));
      actions.append(scan, note, favorite);
    }
    nameButton.addEventListener('dblclick', () => item.isDir ? navigateResource('hbase', fullPath) : scanHbase(fullPath));
    return row;
  }
  if (item.isDir) { const enter = el('button', { class: 'fact', type: 'button', text: '进入' }); enter.addEventListener('click', () => navigateResource(kind, fullPath)); const note = el('button', { class: 'fact', type: 'button', text: '备注' }); note.addEventListener('click', () => openAnnotationDialog(fullPath, getAlias(fullPath), kind)); actions.append(enter); actions.append(note); if (kind === 'files') { const remove = el('button', { class: 'fact danger', type: 'button', text: '删除' }); remove.addEventListener('click', () => confirmDelete(fullPath, 'dir')); actions.append(remove); } }
  else { const view = el('button', { class: 'fact', type: 'button', text: '查看' }); view.addEventListener('click', () => previewRemote(fullPath, kind)); const download = el('button', { class: 'fact', type: 'button', text: '下载' }); download.addEventListener('click', () => downloadRemote(fullPath, kind)); actions.append(view, download); if (kind === 'files') { const remove = el('button', { class: 'fact danger', type: 'button', text: '删除' }); remove.addEventListener('click', () => confirmDelete(fullPath, 'file')); const upload = el('button', { class: 'fact', type: 'button', text: '上传到 HDFS' }); upload.addEventListener('click', () => openUploadDialog(fullPath)); actions.append(remove, upload); } }
  nameButton.addEventListener('dblclick', () => item.isDir ? navigateResource(kind, fullPath) : previewRemote(fullPath, kind)); return row;
}
async function refreshResource(kind) {
  if (!state.connected) return null;
  const request = state.gates[kind].next();
  const path = currentResourcePath(kind);
  const meta = RESOURCE_META[kind];
  startResourceLoading(kind);
  try {
    const result = kind === 'files'
      ? await postJson('/api/sftp/list', { path }, { signal: request.signal, timeout: state.timeouts.filesListMs })
      : kind === 'hdfs'
        ? await postJson('/api/hdfs/list', { path }, { signal: request.signal, timeout: state.timeouts.hdfsListMs })
        : await postJson('/api/hbase/list', { path }, { signal: request.signal, timeout: state.timeouts.hbaseScanMs });
    if (!request.isCurrent()) return result;
    const current = result.path || path;
    setCurrentResourcePath(kind, current);
    resourceState(kind).items = Array.isArray(result.items) ? result.items : [];
    state.loaded[kind] = true;
    if (kind === 'files') { $('#pathInput').value = current; renderBreadcrumbs($('#crumbs'), current, state.home || '~', (value) => navigateResource('files', value)); }
    if (kind === 'hdfs') { $('#hdfsPathInput').value = current; renderBreadcrumbs($('#hdfsCrumbs'), current, '/', (value) => navigateResource('hdfs', value)); }
    if (kind === 'hbase') { $('#hbasePathInput').value = current; renderBreadcrumbs($('#hbaseCrumbs'), current, '/', (value) => navigateResource('hbase', value)); }
    finishResourceLoading(kind); renderResourceView(kind); updateFavoriteButtons();
    status(`${meta.label} · ${resourceState(kind).items.length} 项`, 'success');
    return result;
  } catch (error) {
    if (!request.isCurrent() || error.code === 'REQUEST_ABORTED') return null;
    finishResourceLoading(kind, error); renderResourceView(kind); status(error.message, 'error');
    return null;
  }
}
function refreshFiles() { return refreshResource('files'); }
function refreshHdfs() { return refreshResource('hdfs'); }
function refreshHbase() { return refreshResource('hbase'); }

function findTextMatches(text, query) {
  const value = String(text || ''); const needle = String(query || '').trim().toLocaleLowerCase('zh-CN');
  if (!needle) return [];
  const haystack = value.toLocaleLowerCase('zh-CN'); const matches = []; let from = 0; let index;
  while ((index = haystack.indexOf(needle, from)) >= 0) { matches.push(index); from = index + needle.length; }
  return matches;
}
function renderHighlightedText(node, text, query, activeIndex = 0) {
  node.replaceChildren();
  const value = String(text || ''); const matches = findTextMatches(value, query);
  if (!value) { node.append(document.createTextNode('（无数据）')); return matches; }
  if (!matches.length) { node.append(document.createTextNode(value)); return matches; }
  const length = String(query || '').trim().length; let cursor = 0;
  matches.forEach((start, index) => { if (start > cursor) node.append(document.createTextNode(value.slice(cursor, start))); node.append(el('mark', { class: index === activeIndex ? 'active-match' : '', text: value.slice(start, start + length) })); cursor = start + length; });
  if (cursor < value.length) node.append(document.createTextNode(value.slice(cursor)));
  return matches;
}
function renderHbaseScan() {
  const scan = state.hbaseScan; const query = $('#hbaseScanSearch').value.trim(); const text = scan.displayText || '';
  const matches = findTextMatches(text, query); scan.matchIndex = matches.length ? Math.min(scan.matchIndex, matches.length - 1) : 0;
  if (!query) setText($('#hbaseScanMatch'), '仅查找当前样本');
  else if (matches.length) setText($('#hbaseScanMatch'), `匹配 ${matches.length} 处 · 仅查找当前样本`);
  else setText($('#hbaseScanMatch'), '当前样本中未找到');
  $('#hbaseScanPrev').disabled = !matches.length; $('#hbaseScanNext').disabled = !matches.length;
  if (scan.loading && !text) setText($('#hbaseScanText'), '正在读取…');
  else renderHighlightedText($('#hbaseScanText'), text, query, scan.matchIndex);
  setText($('#hbaseScanNotice'), scan.truncated ? '输出已截断；当前内容仅代表已加载样本，复制仍会保留原始输出。' : '仅查找当前样本；匹配数量按文字出现次数计算，复制按钮会保留原始输出。');
  const stateText = scan.loading ? `正在读取 · 已等待 ${Math.floor(Math.max(0, Date.now() - scan.startedAt) / 1000)} 秒` : scan.error || (scan.tablePath ? `已加载，最多 ${scan.limit} 行` : '');
  setText($('#hbaseScanState'), stateText);
  $('#hbaseScanReload').disabled = scan.loading || !scan.tablePath; $('#hbaseScanLimit').disabled = scan.loading;
  $('#hbaseScanRetry').classList.toggle('hidden', !scan.error || scan.loading);
  setText($('#hbaseScanMeta'), scan.tablePath ? `${scan.tablePath.replace(/^\/+/, '')} · 最多 ${scan.limit} 行` : '');
}
function clearHbaseScanTimer() { if (state.hbaseScan.progressTimer) { clearInterval(state.hbaseScan.progressTimer); state.hbaseScan.progressTimer = null; } }
function cancelHbaseScan() { clearHbaseScanTimer(); state.hbaseScan.loading = false; state.hbaseScan.startedAt = 0; state.gates.scan.cancel(); }
function startHbaseScanLoading(tablePath, limit) {
  const scan = state.hbaseScan; const sameTable = scan.tablePath === tablePath;
  clearHbaseScanTimer(); scan.tablePath = tablePath; scan.limit = limit; scan.loading = true; scan.startedAt = Date.now(); scan.error = ''; scan.matchIndex = 0;
  if (!sameTable) { scan.rawText = ''; scan.displayText = ''; scan.truncated = false; $('#hbaseScanSearch').value = ''; }
  $('#hbaseScanLimit').value = String(limit); renderHbaseScan();
  const update = () => { renderHbaseScan(); status(`HBase · ${tablePath} · 正在读取 · 已等待 ${Math.floor(Math.max(0, Date.now() - scan.startedAt) / 1000)} 秒`); };
  update(); scan.progressTimer = setInterval(update, 1000);
}
function finishHbaseScan(error = null) { const scan = state.hbaseScan; clearHbaseScanTimer(); scan.loading = false; scan.startedAt = 0; scan.error = error?.message || ''; renderHbaseScan(); }
async function loadHbaseSample(tablePath, limit) {
  const request = state.gates.scan.next(); startHbaseScanLoading(tablePath, limit);
  try {
    const result = await postJson('/api/hbase/scan', { path: tablePath, limit }, { signal: request.signal, timeout: state.timeouts.hbaseScanMs });
    if (!request.isCurrent()) return null;
    const scan = state.hbaseScan; scan.tablePath = tablePath; scan.limit = Number(result.limit) || limit; scan.rawText = String(result.text || ''); scan.truncated = Boolean(result.truncated); scan.displayText = scan.rawText ? (scan.truncated ? scan.rawText : (prettifyJson(scan.rawText) || scan.rawText)) : '';
    finishHbaseScan(); status(`HBase · ${tablePath} · 样本已加载`, 'success'); return result;
  } catch (error) {
    if (!request.isCurrent() || error.code === 'REQUEST_ABORTED') return null;
    finishHbaseScan(error); status(error.message, 'error'); return null;
  }
}
function scanHbase(tablePath) {
  const value = String(tablePath || '').trim(); if (!value) return;
  const sameTable = state.hbaseScan.tablePath === value;
  const tableName = value.split(':').pop() || ''; const desc = aliasTextFor(value, tableName); const descLine = desc ? splitAliasText(desc).desc : '';
  setText($('#hbaseScanTitle'), 'HBase 表查看'); setText($('#hbaseScanDesc'), descLine ? `说明：${descLine}` : '');
  if (!sameTable) { state.hbaseScan.rawText = ''; state.hbaseScan.displayText = ''; state.hbaseScan.truncated = false; state.hbaseScan.error = ''; $('#hbaseScanSearch').value = ''; }
  openDialog('hbaseScanDialog'); renderHbaseScan(); void loadHbaseSample(value, sameTable ? state.hbaseScan.limit : 20);
}
function moveHbaseScanMatch(delta) {
  const scan = state.hbaseScan; const matches = findTextMatches(scan.displayText, $('#hbaseScanSearch').value.trim());
  if (!matches.length) return;
  scan.matchIndex = (scan.matchIndex + delta + matches.length) % matches.length; renderHbaseScan();
  requestAnimationFrame(() => $('#hbaseScanText mark.active-match')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
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
function openAnnotationDialog(path, currentAlias, kind = '') { state.pendingAnnotationPath = path; state.pendingAnnotationKind = kind; $('#annotationPath').value = path; $('#annotationAlias').value = currentAlias || ''; $('#annotationAlias').removeAttribute('aria-invalid'); setText($('#annotationError'), ''); $('#btnAnnotationRemove').style.display = currentAlias ? '' : 'none'; openDialog('annotationDialog', $('#annotationAlias')); }
function refreshAnnotationView() { const kind = state.pendingAnnotationKind; if (kind && state.loaded[kind]) renderResourceView(kind); renderFavorites(); updateFavoriteButtons(); state.pendingAnnotationPath = ''; state.pendingAnnotationKind = ''; }
$('#btnAnnotationSave').addEventListener('click', () => { const text = $('#annotationAlias').value.trim(); if (text.length > 40) { $('#annotationAlias').setAttribute('aria-invalid', 'true'); setText($('#annotationError'), '备注最多 40 个字符'); return; } const path = state.pendingAnnotationPath; if (!path) { setText($('#annotationError'), '路径为空'); return; } setAlias(path, text); closeDialog('annotationDialog'); toast(text ? `已保存备注：${text}` : '已清空备注', 'ok'); refreshAnnotationView(); });
$('#btnAnnotationRemove').addEventListener('click', () => { const path = state.pendingAnnotationPath; if (!path) return; removeAlias(path); closeDialog('annotationDialog'); toast('已删除备注', 'ok'); refreshAnnotationView(); });
$('#annotationAlias').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('#btnAnnotationSave').click(); } });
$('#btnFavoriteSave').addEventListener('click', () => {
  const pending = state.pendingFavorite; const label = $('#favoriteLabel').value.trim();
  if (!pending) { setText($('#favoriteError'), '收藏位置为空'); return; }
  if (label.length > 60) { $('#favoriteLabel').setAttribute('aria-invalid', 'true'); setText($('#favoriteError'), '显示名称最多 60 个字符'); return; }
  $('#favoriteLabel').removeAttribute('aria-invalid');
  const next = { ...pending, label, updatedAt: Date.now() };
  state.favorites = [next, ...state.favorites.filter((item) => favoriteId(item.kind, item.path) !== favoriteId(next.kind, next.path))];
  saveFavorites(); renderFavorites(); updateFavoriteButtons(); state.pendingFavorite = null; closeDialog('favoriteDialog'); toast('已保存收藏', 'ok');
});
$('#btnFavoriteRemove').addEventListener('click', () => { const pending = state.pendingFavorite; if (pending) removeFavorite(pending.kind, pending.path); });
$('#favoriteLabel').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('#btnFavoriteSave').click(); } });
$('#btnUploadSubmit').addEventListener('click', async () => {
  const localPath = state.pendingUpload;
  const hdfsDir = $('#uploadDir').value.trim();
  const submit = $('#btnUploadSubmit');
  if (!localPath) { setText($('#uploadError'), '未指定要上传的文件'); return; }
  if (!hdfsDir.startsWith('/')) { $('#uploadDir').setAttribute('aria-invalid', 'true'); setText($('#uploadError'), 'HDFS 目标目录必须以 / 开头'); return; }
  $('#uploadDir').removeAttribute('aria-invalid');
  submit.disabled = true;
  setText(submit, '上传中…');
  try {
    // Hadoop 冷启动、后台预热和大文件传输可能超过通用 30 秒请求上限。
    const result = await postJson('/api/hdfs/upload', { localPath, hdfsDir }, { timeout: HDFS_UPLOAD_TIMEOUT });
    closeDialog('uploadDialog'); toast(`已上传到 ${result.hdfsPath}`, 'ok');
    if (state.hdfsCwd.replace(/\/+$/, '') === hdfsDir.replace(/\/+$/, '')) refreshHdfs();
  } catch (error) { setText($('#uploadError'), error.message); }
  finally { submit.disabled = false; setText(submit, '上传'); }
});
function confirmDelete(remotePath, kind) { state.pendingConfirm = { action: async () => { await postJson('/api/sftp/delete', { path: remotePath, kind, confirmed: true }); toast('删除成功', 'ok'); refreshFiles(); } }; setText($('#confirmTitle'), `确认删除${kind === 'dir' ? '空目录' : '文件'}`); setText($('#confirmMessage'), '删除不可恢复，请确认目标路径正确。'); setText($('#confirmTarget'), remotePath); openDialog('confirmDialog', $('#btnConfirmAction')); }
$('#btnConfirmAction').addEventListener('click', async () => { const pending = state.pendingConfirm; state.pendingConfirm = null; closeDialog('confirmDialog'); if (!pending) return; try { await pending.action(); } catch (error) { toast(error.message, 'err'); } });

function openNameDialog(kind) { state.pendingName = kind; setText($('#nameTitle'), kind === 'mkdir' ? '新建目录' : '新建文件'); setText($('#nameLabel'), `${kind === 'mkdir' ? '目录' : '文件'}名称（当前目录：${state.cwd}）`); $('#nameInput').value = ''; setText($('#nameError'), ''); openDialog('nameDialog', $('#nameInput')); }
$('#btnNameSubmit').addEventListener('click', async () => { const name = $('#nameInput').value.trim(); const invalid = !name || /[\\/]/.test(name) || name === '.' || name === '..'; $('#nameInput').toggleAttribute('aria-invalid', invalid); if (invalid) { setText($('#nameError'), '请输入不含路径分隔符的名称'); return; } const kind = state.pendingName; try { await postJson(`/api/sftp/${kind}`, { path: pathJoin(state.cwd, name) }); closeDialog('nameDialog'); toast(kind === 'mkdir' ? '目录已创建' : '文件已创建', 'ok'); refreshFiles(); } catch (error) { setText($('#nameError'), error.message); } });

function renderCommands() { const root = $('#commandGroups'); root.replaceChildren(); const groups = [...new Set(COMMANDS.map((item) => item.group))]; groups.forEach((group) => { const items = COMMANDS.filter((item) => item.group === group); const list = el('section', { class: 'command-group' }, el('h3', { text: group })); items.forEach((item) => { const run = el('button', { class: 'fact', type: 'button', text: item.param ? '填写' : '执行' }); run.addEventListener('click', () => { if (item.param) openParamCommand(item); else if (item.danger) { setText($('#confirmTitle'), '确认执行高级删除命令'); setText($('#confirmMessage'), '自由命令可能影响多个文件，请确认后执行。'); setText($('#confirmTarget'), item.command); state.pendingConfirm = { action: () => runCommand(item.command, { confirmed: true }) }; openDialog('confirmDialog', $('#btnConfirmAction')); } else { closeDialog('commandsDialog'); runCommand(item.autoCwd ? `cd ${shellQuote(state.home === '~' ? state.cwd : state.home)} && ${item.command}` : item.command); } }); list.append(el('div', { class: 'command-item' }, el('span', { class: 'command-label' }, el('strong', { text: item.label }), el('small', { text: item.desc })), run)); }); root.append(list); }); }
function openParamCommand(item) { state.pendingParam = item; setText($('#paramTitle'), item.param === 'file' ? '查看文件' : '查看最后 N 行'); setText($('#paramLabel'), item.param === 'file' ? '文件路径' : '行数和文件路径（例如：100 /var/log/app.log）'); $('#paramInput').value = item.param === 'file' ? state.cwd : '100 '; $('#paramInput').removeAttribute('aria-invalid'); setText($('#paramError'), ''); openDialog('paramDialog', $('#paramInput')); }
$('#btnParamSubmit').addEventListener('click', () => { const item = state.pendingParam; const value = $('#paramInput').value.trim(); if (!item || !value) { $('#paramInput').setAttribute('aria-invalid', 'true'); setText($('#paramError'), '请输入参数'); return; } $('#paramInput').removeAttribute('aria-invalid'); if (item.param === 'file') { runCommand(`cat ${shellQuote(value)} | head -c 262144`, { refreshable: true, buildCommand: () => `cat ${shellQuote(value)} | head -c 262144` }); closeDialog('paramDialog'); return; } const match = value.match(/^(\d+)\s+(.+)$/); if (!match) { $('#paramInput').setAttribute('aria-invalid', 'true'); setText($('#paramError'), '格式应为：行数 文件路径'); return; } const command = `tail -n ${Number(match[1]) || 100} ${shellQuote(match[2])}`; closeDialog('paramDialog'); runCommand(command, { refreshable: true, buildCommand: () => command }); });

function renderBilling() { const root = $('#billingContent'); root.replaceChildren(); const search = $('#billSearch').value.trim().toLowerCase(); const suffix = $('#billSuffix').value.trim() || '597_2606'; const month = $('#billMonth').value.trim() || '202410'; const ns = $('#billNs').value.trim() || 'ns_aibcp_dev'; BILLING.forEach((card) => { const rows = card.rows.map(([label, value]) => [label, value.replace('{ns}', ns).replace('{month}', month)]).filter(([label, value]) => !search || `${label}${value}`.toLowerCase().includes(search)); if (!rows.length) return; const section = el('section', { class: 'billing-card' }, el('h3', { text: card.title })); rows.forEach(([label, value]) => { const code = el('code', { text: value, title: value }); const copy = el('button', { class: 'fact', type: 'button', text: '复制' }); copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(value); toast('已复制', 'ok'); } catch (_) { toast('复制失败', 'err'); } }); section.append(el('div', { class: 'billing-row' }, el('span', { text: label }), code, copy)); }); root.append(section); }); }

async function doConnect(overrides = {}) { const saved = storedConfig(); const body = { ...saved, ...overrides }; if (state.sessionPassword) body.password = state.sessionPassword; $('#btnConnect').disabled = true; setText($('#statusText'), '正在连接…'); try { const result = await postJson('/api/connect', body); setConnected(true, result.config); state.home = result.home || '~'; state.cwd = state.home; saveStoredConfig({ ...body, ...result.config }); toast(`已连接 ${result.config.host}`, 'ok'); await refreshFiles(); } catch (error) { setConnected(false); toast(error.message || '连接失败', 'err'); } finally { $('#btnConnect').disabled = false; } }
$('#btnConnect').addEventListener('click', async () => { if (state.connected) { try { await postJson('/api/disconnect', {}); } finally { setConnected(false); toast('已断开连接'); } } else { openSettingsDialog(); } });
$('#btnSaveCfg').addEventListener('click', () => { const host = $('#cfgHost').value.trim(); const portValue = $('#cfgPort').value.trim(); const port = Number(portValue); const username = $('#cfgUser').value.trim(); const invalid = !host || !username || !portValue || !Number.isInteger(port) || port < 1 || port > 65535; ['cfgHost', 'cfgPort', 'cfgUser'].forEach((id) => document.getElementById(id)?.toggleAttribute('aria-invalid', invalid)); if (invalid) { setText($('#settingsError'), '服务器地址、端口和用户名必须填写正确'); return; } ['cfgHost', 'cfgPort', 'cfgUser'].forEach((id) => document.getElementById(id)?.removeAttribute('aria-invalid')); state.sessionPassword = $('#cfgPass').value; saveStoredConfig({ host, port, username }); closeDialog('settingsDialog'); void doConnect({ host, port, username }); });
$('#emptyConnect').addEventListener('click', openSettingsDialog);
$('#btnSettings').addEventListener('click', openSettingsDialog);
$('#btnCmds').addEventListener('click', () => { renderCommands(); openDialog('commandsDialog'); });
$('#btnBilling').addEventListener('click', () => { renderBilling(); openDialog('billingDialog', $('#billSearch')); });
$('#btnCdr').addEventListener('click', () => { if (!$('#cdrFrame').getAttribute('src')) $('#cdrFrame').src = '/cdr/'; openDialog('cdrDialog'); });
$('#billSearch').addEventListener('input', renderBilling); ['billSuffix', 'billMonth', 'billNs'].forEach((id) => $( `#${id}`).addEventListener('input', renderBilling));

Object.keys(RESOURCE_META).forEach((kind) => {
  const meta = RESOURCE_META[kind]; const view = resourceState(kind); const search = $(`#${meta.searchId}`); const sort = $(`#${meta.sortId}`);
  search?.addEventListener('input', () => { view.query = search.value; renderResourceView(kind); });
  sort?.addEventListener('change', () => { const [sortKey, sortDirection] = sort.value.split('-'); view.sortKey = sortKey; view.sortDirection = sortDirection; renderResourceView(kind); });
  $(`#${meta.retryId}`)?.addEventListener('click', () => { void refreshResource(kind); });
  $(`#${meta.favoriteButtonId}`)?.addEventListener('click', () => openFavoriteDialog(kind));
});
function switchTab(tab, { load = true } = {}) { $$('.tab').forEach((button) => { const active = button.dataset.tab === tab; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); }); $('#filesPane').classList.toggle('hidden', tab !== 'files'); $('#hdfsPane').classList.toggle('hidden', tab !== 'hdfs'); $('#hbasePane').classList.toggle('hidden', tab !== 'hbase'); if (load && tab === 'hdfs' && state.connected && !state.loaded.hdfs) void refreshHdfs(); if (load && tab === 'hbase' && state.connected && !state.loaded.hbase) void refreshHbase(); }
$$('.tab').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
$('#btnRefresh').addEventListener('click', () => { void refreshFiles(); }); $('#btnHdfsRefresh').addEventListener('click', () => { void refreshHdfs(); }); $('#btnMkdir').addEventListener('click', () => state.connected ? openNameDialog('mkdir') : toast('请先连接服务器', 'err')); $('#btnTouch').addEventListener('click', () => state.connected ? openNameDialog('touch') : toast('请先连接服务器', 'err'));
$('#btnUploadLocal').addEventListener('click', () => { if (!state.connected) { toast('请先连接服务器', 'err'); return; } const input = $('#localFileInput'); input.value = ''; input.click(); });
$('#localFileInput').addEventListener('change', () => { const file = $('#localFileInput').files && $('#localFileInput').files[0]; if (!file) return; void uploadLocalFile(file); });
$('#btnUp').addEventListener('click', () => { if (state.cwd === '~' || state.cwd === state.home) return; void navigateResource('files', state.cwd.replace(/\/[^/]+\/?$/, '') || '/'); }); $('#btnHdfsUp').addEventListener('click', () => { if (state.hdfsCwd !== '/') void navigateResource('hdfs', state.hdfsCwd.replace(/\/[^/]+\/?$/, '') || '/'); });
$('#btnHbaseRefresh').addEventListener('click', () => { void refreshHbase(); }); $('#btnHbaseUp').addEventListener('click', () => { if (state.hbaseCwd !== '/') void navigateResource('hbase', '/'); }); $('#btnHbaseGoto').addEventListener('click', () => { const value = $('#hbasePathInput').value.trim(); if (!value) return; if (value !== '/' && !/^\/[^/]+$/.test(value)) return toast('HBase 路径只能为 / 或 /namespace', 'err'); void navigateResource('hbase', value); }); $('#hbasePathInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#btnHbaseGoto').click(); });
$('#btnGoto').addEventListener('click', () => { const value = $('#pathInput').value.trim(); if (value) void navigateResource('files', value); }); $('#pathInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#btnGoto').click(); }); $('#btnHdfsGoto').addEventListener('click', () => { const value = $('#hdfsPathInput').value.trim(); if (!value.startsWith('/')) return toast('HDFS 路径必须以 / 开头', 'err'); void navigateResource('hdfs', value); }); $('#hdfsPathInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#btnHdfsGoto').click(); }); $$('[data-hdfs-path]').forEach((button) => button.addEventListener('click', () => { switchTab('hdfs', { load: false }); void navigateResource('hdfs', button.dataset.hdfsPath); }));
$('#hbaseScanSearch').addEventListener('input', () => { state.hbaseScan.matchIndex = 0; renderHbaseScan(); });
$('#hbaseScanPrev').addEventListener('click', () => moveHbaseScanMatch(-1)); $('#hbaseScanNext').addEventListener('click', () => moveHbaseScanMatch(1));
$('#hbaseScanReload').addEventListener('click', () => { if (state.hbaseScan.tablePath) void loadHbaseSample(state.hbaseScan.tablePath, Number($('#hbaseScanLimit').value) || 20); });
$('#hbaseScanRetry').addEventListener('click', () => { if (state.hbaseScan.tablePath) void loadHbaseSample(state.hbaseScan.tablePath, Number($('#hbaseScanLimit').value) || state.hbaseScan.limit); });
$('#hbaseScanCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(state.hbaseScan.rawText || ''); toast('已复制原始结果', 'ok'); } catch (_) { toast('复制失败，请手动选择文本', 'err'); } });

async function submitCommand() { const input = $('#cmdInput'); const command = input.value.trim(); if (!command) return; state.history.push(command); state.historyIndex = state.history.length; input.value = ''; if (!state.connected) return toast('请先连接服务器', 'err'); if (/\b(?:rm|rmdir|del|erase|format)\b/i.test(command)) { setText($('#confirmTitle'), '确认执行删除命令'); setText($('#confirmMessage'), '删除类自由命令需要二次确认。'); setText($('#confirmTarget'), command); state.pendingConfirm = { action: () => runCommand(command, { confirmed: true }) }; openDialog('confirmDialog', $('#btnConfirmAction')); return; } runCommand(command); }
$('#btnRun').addEventListener('click', submitCommand); $('#cmdInput').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitCommand(); } else if (event.key === 'ArrowUp') { event.preventDefault(); state.historyIndex = Math.max(0, state.historyIndex - 1); $('#cmdInput').value = state.history[state.historyIndex] || ''; } else if (event.key === 'ArrowDown') { event.preventDefault(); state.historyIndex = Math.min(state.history.length, state.historyIndex + 1); $('#cmdInput').value = state.history[state.historyIndex] || ''; } }); $$('#chips .chip').forEach((chip) => chip.addEventListener('click', () => { $('#cmdInput').value = chip.dataset.command; $('#cmdInput').focus(); }));
$('#btnClear').addEventListener('click', () => { stopRefreshBlock(); $('#logFlow').replaceChildren(); renderConsoleEmptyState(); }); $('#btnExport').addEventListener('click', () => { const blocks = $$('#logFlow .log-block'); if (!blocks.length) return toast('暂无日志可导出'); const lines = ['# Server Workbench · 会话日志', `# 导出时间：${new Date().toLocaleString('zh-CN')}`, '']; blocks.forEach((block) => lines.push(`──── [${block.querySelector('.log-time')?.textContent}] ${block.querySelector('.log-cmd')?.textContent}（${block.querySelector('.badge')?.textContent}）`, block.querySelector('.log-body')?.textContent || '', '')); const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'server-workbench-log.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }); $('#btnLogReload').addEventListener('click', () => { $('#logFlow').replaceChildren(); restoreLogs(); }); $('#logDate').valueAsDate = new Date();

async function checkStatus() { if (document.hidden || state.statusRunning) return; state.statusRunning = true; try { const result = await getJson('/api/status'); if (state.connected && !result.connected) { setConnected(false); toast('远程连接已断开', 'err'); } } catch (error) { if (state.connected) { setConnected(false); toast('本地桥接服务不可用', 'err'); } } finally { state.statusRunning = false; if ($('#autoStatus').checked && !document.hidden) state.statusTimer = setTimeout(checkStatus, 5000); } }
$('#autoStatus').checked = true; $('#autoStatus').addEventListener('change', () => { clearTimeout(state.statusTimer); if ($('#autoStatus').checked) checkStatus(); }); document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(state.statusTimer); state.refreshBlocks.forEach((block) => { clearTimeout(block.timer); block.timer = null; }); } else { if ($('#autoStatus').checked) checkStatus(); [...state.refreshBlocks.values()].forEach((block) => startRefreshBlock(block)); } });

renderCommands(); renderBreadcrumbs($('#crumbs'), state.cwd, state.home, (value) => navigateResource('files', value)); renderBreadcrumbs($('#hdfsCrumbs'), state.hdfsCwd, '/', (value) => navigateResource('hdfs', value)); renderBreadcrumbs($('#hbaseCrumbs'), state.hbaseCwd, '/', (value) => navigateResource('hbase', value)); renderFavorites(); updateFavoriteButtons();
(async function init() {
  state.annotations = loadAnnotations();
  try {
    const cfg = await getJson('/api/config'); state.config = cfg.config || storedConfig();
    const configuredTimeouts = cfg.timeouts || {};
    state.timeouts = { filesListMs: DEFAULT_RESOURCE_TIMEOUTS.filesListMs, hdfsListMs: Number(configuredTimeouts.hdfsListMs) || DEFAULT_RESOURCE_TIMEOUTS.hdfsListMs, hbaseScanMs: Number(configuredTimeouts.hbaseScanMs) || DEFAULT_RESOURCE_TIMEOUTS.hbaseScanMs };
    $('#cfgHost').value = state.config.host || ''; $('#cfgPort').value = state.config.port || 22; $('#cfgUser').value = state.config.username || '';
    state.favorites = loadFavoritesForCurrentServer(); renderFavorites(); updateFavoriteButtons();
  } catch (_) {}
  await restoreLogs();
  await restoreSession();
  checkStatus();
})();

// 页面刷新/重开后的会话恢复：SSH 长连接存活在后端 Node 进程里，刷新页面并不会真的断开，
// 这里探测后端状态直接恢复前端 UI（无需重新输密码）；若后端也已断开则用保存的配置自动重连。
async function restoreSession() {
  try {
    const saved = storedConfig();
    const connectionStatus = await getJson('/api/status');
    if (connectionStatus?.connected) {
      // 后端 SSH 会话仍在：直接恢复前端状态，不重新认证
      const conn = connectionStatus.conn || { host: saved.host, port: saved.port, username: saved.username };
      setConnected(true, conn);
      state.home = connectionStatus.home || '~';
      state.cwd = state.home;
      status(`已恢复连接 · ${conn.host || ''}`, 'success');
      toast(`已恢复 ${conn.host || ''} 的连接会话`, 'ok');
      if ($('#filesPane') && !$('#filesPane').classList.contains('hidden')) void refreshFiles();
      return;
    }
    // 后端无会话：尝试用已保存的主机/端口/用户名自动重连（密码由后端配置文件提供，不落浏览器）
    if (saved.host && saved.username) {
      try {
        const result = await postJson('/api/connect', { host: saved.host, port: saved.port, username: saved.username });
        setConnected(true, result.config); state.home = result.home || '~'; state.cwd = state.home;
        toast(`已自动重连 ${result.config.host}`, 'ok');
        if ($('#filesPane') && !$('#filesPane').classList.contains('hidden')) void refreshFiles();
      } catch (_) { /* 自动重连失败（如密码未配置）：保持未连接，等待用户手动连接 */ }
    }
  } catch (_) { /* 桥接服务不可用：保持默认未连接状态 */ }
}
