import { $, $$, announce, createRequestGate, DialogController, el, formatBytes, formatDate, getJson, postJson, setText } from '/shared/ui.js';
import { formatHbaseScanText, isBatchInfoTable, isMonthlyAccumulatorDetailTable, isTicketDispatchTable } from '/js/hbase-scan-format.js';

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
  pendingConfirm: null, pendingName: null,
  gates: { files: createRequestGate(), hdfs: createRequestGate(), hbase: createRequestGate(), scan: createRequestGate(), phone: createRequestGate(), threshold: createRequestGate() }, statusTimer: null, statusRunning: false, pendingUpload: null, loaded: { files: false, hdfs: false, hbase: false },
  annotations: {}, pendingAnnotationPath: '', pendingAnnotationKind: '',
  timeouts: { ...DEFAULT_RESOURCE_TIMEOUTS },
  resources: { files: makeResourceState(), hdfs: makeResourceState(), hbase: makeResourceState() },
  favorites: [],
  pendingFavorite: null,
  hbaseScan: { tablePath: '', limit: 20, rawText: '', displayText: '', structured: false, parsedCount: 0, skippedCount: 0, truncated: false, loading: false, startedAt: 0, progressTimer: null, error: '', matchIndex: 0 },
  databases: { udal: { connected: false, config: null, password: '' }, doris: { connected: false, config: null, password: '' } },
  connectionProfiles: { ssh: null, udal: null, doris: null }, connectionErrors: { ssh: '', udal: '', doris: '' },
  activeQuery: 'phone', phoneQuery: { running: false, result: null }, thresholdQuery: { running: false, result: null },
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
  '/ns_cnos/ACCUMULATOR_202606': '量本主表（Qualifier 六段字段；24A=独享，其他编码=共享；ACCUM 100=结转，200=初始化）',
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
  if (/^(ACCUMULATOR|ACCUMULATION)_DETAIL(_0|_\d{6})$/.test(core)) return tryLabel + '量本从表（量本明细字段拼在 RowKey，Qualifier 为空）';
  if (/^(ACCUMULATOR|ACCUMULATION)_0$/.test(core)) return tryLabel + '永久累积量表（长期有效）';
  if (/^(ACCUMULATOR|ACCUMULATION)_\d{6}$/.test(core)) return tryLabel + '量本主表（Qualifier 六段字段；24A=独享，其他编码=共享；ACCUM 100=结转，200=初始化）';
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

const dialogs = new Map(['connectionDialog', 'billingDialog', 'confirmDialog', 'nameDialog', 'uploadDialog', 'annotationDialog', 'previewDialog', 'hbaseScanDialog', 'favoriteDialog', 'cdrDialog'].map((id) => [id, new DialogController(document.getElementById(id))]));
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
  const configured = state.config || {};
  const host = String(configured.host || '').trim().toLowerCase();
  const port = Number(configured.port || 22);
  const username = String(configured.username || '').trim();
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
  const button = $('#btnConnect'); setText(button, '连接'); button.classList.add('primary');
  if (connected) { state.favorites = loadFavoritesForCurrentServer(); renderFavorites(); updateFavoriteButtons(); return; }
  ['files', 'hdfs', 'hbase'].forEach((kind) => { resetResourceState(kind); });
  if (dialogs.get('hbaseScanDialog')?.isOpen) closeDialog('hbaseScanDialog');
  cancelHbaseScan(); state.hbaseScan.rawText = ''; state.hbaseScan.displayText = ''; state.hbaseScan.structured = false; state.hbaseScan.parsedCount = 0; state.hbaseScan.skippedCount = 0; state.hbaseScan.truncated = false; state.hbaseScan.error = ''; state.hbaseScan.tablePath = '';
  $('#fileList').replaceChildren(el('div', { class: 'empty-tip', text: '尚未连接服务器\n请先点击右上角“连接”' }));
  $('#hdfsList').replaceChildren(el('div', { class: 'empty-tip', text: '尚未连接服务器' }));
  $('#hbaseList').replaceChildren(el('div', { class: 'empty-tip', text: '尚未连接服务器' }));
  renderFavorites(); updateFavoriteButtons();
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
  const row = el('div', { class: 'resource-row' }, nameCell, el('span', { class: 'resource-size', text: item.isDir ? '—' : (kind === 'hbase' ? '表' : formatBytes(item.size)) }), el('span', { class: 'resource-date', text: item.mtime ? formatDate(item.mtime) : '—', title: item.mtime ? `${formatDate(item.mtime)} +08:00` : '—' }), el('div', { class: 'resource-actions' }));
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
  if (!state.connected || resourceState(kind).loading) return null;
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
  const formatSource = isBatchInfoTable(scan.tablePath) ? 'RowKey 与列族 batch_info' : isMonthlyAccumulatorDetailTable(scan.tablePath) || isTicketDispatchTable(scan.tablePath) ? 'RowKey' : '列族 f 的 Qualifier';
  const formatNote = scan.structured ? `已从 ${formatSource} 解析 ${scan.parsedCount} 条${scan.skippedCount ? `，${scan.skippedCount} 条格式不匹配` : ''}。` : '';
  setText($('#hbaseScanNotice'), `${formatNote}${scan.truncated ? '输出已截断；当前内容仅代表已加载样本，复制仍会保留原始输出。' : '仅查找当前样本；匹配数量按文字出现次数计算，复制按钮会保留原始输出。'}`);
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
  if (!sameTable) { scan.rawText = ''; scan.displayText = ''; scan.structured = false; scan.parsedCount = 0; scan.skippedCount = 0; scan.truncated = false; $('#hbaseScanSearch').value = ''; }
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
    const scan = state.hbaseScan; scan.tablePath = tablePath; scan.limit = Number(result.limit) || limit; scan.rawText = String(result.text || ''); scan.truncated = Boolean(result.truncated);
    const formatted = formatHbaseScanText(tablePath, scan.rawText); scan.structured = formatted.structured; scan.parsedCount = formatted.parsedCount; scan.skippedCount = formatted.skippedCount;
    scan.displayText = formatted.structured ? formatted.text : (scan.rawText ? (scan.truncated ? scan.rawText : (prettifyJson(scan.rawText) || scan.rawText)) : '');
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
  if (!sameTable) { state.hbaseScan.rawText = ''; state.hbaseScan.displayText = ''; state.hbaseScan.structured = false; state.hbaseScan.parsedCount = 0; state.hbaseScan.skippedCount = 0; state.hbaseScan.truncated = false; state.hbaseScan.error = ''; $('#hbaseScanSearch').value = ''; }
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
  try { const endpoint = kind === 'files' ? '/api/sftp/preview' : '/api/hdfs/preview'; const timeout = kind === 'files' ? 30000 : state.timeouts.hdfsListMs; const result = await postJson(endpoint, { path: remotePath, maxBytes: 262144 }, { timeout }); setText($('#previewText'), prettifyJson(result.text) || '（空文件）'); if (result.truncated) setText($('#previewMeta'), `${remotePath} · 已显示前 256 KiB，内容已截断`); status(`${kind === 'hdfs' ? 'HDFS' : '服务器文件'} · 已预览 ${remotePath}`, 'success'); } catch (error) { setText($('#previewText'), error.message); status(error.message, 'error'); }
}
function downloadRemote(remotePath, kind) { const a = document.createElement('a'); a.href = `${kind === 'hdfs' ? '/api/hdfs/download' : '/api/sftp/download'}?path=${encodeURIComponent(remotePath)}`; a.download = ''; document.body.append(a); a.click(); a.remove(); toast(`开始下载：${remotePath.split('/').pop()}`, 'ok'); }
async function uploadLocalFile(file) {
  if (!state.connected) { toast('请先连接服务器', 'err'); return; }
  const targetDir = state.cwd;
  status(`正在上传 ${file.name}…`);
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch('/api/sftp/upload', { method: 'POST', headers: { 'X-Target-Dir': targetDir, 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' }, body: buf });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) throw new Error(json.error?.message || `上传失败（HTTP ${res.status}）`);
    toast(`已上传到 ${json.remotePath}`, 'ok');
    status(`已上传 ${file.name} · ${formatBytes(json.size)}`, 'success');
    refreshFiles();
  } catch (error) {
    status(`上传失败 · ${error.message}`, 'error');
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

function renderBilling() { const root = $('#billingContent'); root.replaceChildren(); const search = $('#billSearch').value.trim().toLowerCase(); const suffix = $('#billSuffix').value.trim() || '597_2606'; const month = $('#billMonth').value.trim() || '202410'; const ns = $('#billNs').value.trim() || 'ns_aibcp_dev'; BILLING.forEach((card) => { const rows = card.rows.map(([label, value]) => [label, value.replace('{ns}', ns).replace('{month}', month)]).filter(([label, value]) => !search || `${label}${value}`.toLowerCase().includes(search)); if (!rows.length) return; const section = el('section', { class: 'billing-card' }, el('h3', { text: card.title })); rows.forEach(([label, value]) => { const code = el('code', { text: value, title: value }); const copy = el('button', { class: 'fact', type: 'button', text: '复制' }); copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(value); toast('已复制', 'ok'); } catch (_) { toast('复制失败', 'err'); } }); section.append(el('div', { class: 'billing-row' }, el('span', { text: label }), code, copy)); }); root.append(section); }); }

$('#btnConnect').addEventListener('click', () => { renderConnectionList(); openDialog('connectionDialog', $('#btnConnectAll')); });
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
function switchTab(tab, { load = true } = {}) { $$('.tabs .tab').forEach((button) => { const active = button.dataset.tab === tab; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); }); $('#filesPane').classList.toggle('hidden', tab !== 'files'); $('#hdfsPane').classList.toggle('hidden', tab !== 'hdfs'); $('#hbasePane').classList.toggle('hidden', tab !== 'hbase'); if (load && tab === 'hdfs' && state.connected && !state.loaded.hdfs) void refreshHdfs(); if (load && tab === 'hbase' && state.connected && !state.loaded.hbase) void refreshHbase(); }
$$('.tabs .tab').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
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

const DB_SOURCE_LABEL = { udal: 'MySQL / UDAL', doris: 'Doris' };
const CONNECTION_LABEL = { ssh: 'SSH / SFTP / HDFS', ...DB_SOURCE_LABEL };
function connectionConfig(source) { return source === 'ssh' ? (state.config || state.connectionProfiles.ssh || {}) : (state.databases[source].config || state.connectionProfiles[source] || {}); }
function renderConnectionList() {
  for (const source of ['ssh', 'udal', 'doris']) {
    const config = connectionConfig(source); const connected = source === 'ssh' ? state.connected : state.databases[source].connected;
    const values = { host: config.host || '—', port: config.port || '—', username: config.username || '—', database: source === 'udal' ? 'CRM3DB、CONFIGDB_CNOS_JF_TEST' : config.database || '—', password: config.hasPassword ? '已配置' : '未配置' };
    for (const [field, value] of Object.entries(values)) setText(document.querySelector(`[data-connection-field="${source}.${field}"]`), value);
    document.querySelector(`[data-connection-dot="${source}"]`)?.classList.toggle('on', connected);
    setText(document.querySelector(`[data-connection-status="${source}"]`), connected ? '已连接' : '未连接');
    setText(document.querySelector(`[data-connection-error="${source}"]`), state.connectionErrors[source] || '');
  }
}
async function connectAll() {
  const button = $('#btnConnectAll'); button.disabled = true; setText(button, '连接中…'); setText($('#connectionError'), '正在连接 SSH、MySQL / UDAL 和 Doris…');
  state.connectionErrors = { ssh: '', udal: '', doris: '' };
  try {
    const response = await postJson('/api/connections/connect', {}, { timeout: 60000 });
    const sshResult = response.sources?.ssh || {}; const sshConnected = Boolean(sshResult.connected);
    setConnected(sshConnected, sshResult.config || state.connectionProfiles.ssh); state.home = sshResult.home || state.home || '~'; if (sshConnected) state.cwd = state.home;
    for (const source of ['udal', 'doris']) { const item = response.sources?.[source] || {}; state.databases[source] = { connected: Boolean(item.connected), config: item.config || state.connectionProfiles[source], password: '' }; }
    for (const source of ['ssh', 'udal', 'doris']) state.connectionErrors[source] = response.sources?.[source]?.error || '';
    renderConnectionList(); renderDbStatus(); clearQueryResult();
    const connectedCount = ['ssh', 'udal', 'doris'].filter((source) => source === 'ssh' ? state.connected : state.databases[source].connected).length;
    setText($('#connectionError'), connectedCount === 3 ? '全部连接成功' : `已连接 ${connectedCount} / 3，请查看分项提示`);
    toast(connectedCount === 3 ? '全部数据源已连接' : `连接完成 · ${connectedCount} / 3`, connectedCount ? 'ok' : 'err');
    if (sshConnected) await refreshFiles();
  } catch (error) { setText($('#connectionError'), error.message); toast(error.message, 'err'); }
  finally { button.disabled = false; setText(button, '连接'); }
}
function clearQueryResult() {
  state.gates.phone.cancel(); state.gates.threshold.cancel(); state.phoneQuery = { running: false, result: null }; state.thresholdQuery = { running: false, result: null };
  $('#btnPhoneQuery').disabled = false; $('#btnPhoneCancel').classList.add('hidden'); $('#btnThresholdQuery').disabled = false; $('#btnThresholdCancel').classList.add('hidden');
  setText($('#queryState'), ''); $('#queryState').dataset.tone = '';
  const hint = state.activeQuery === 'threshold' ? '请先连接 MySQL / UDAL，再输入 A 端产品实例 ID。' : '请先连接 MySQL / UDAL，再输入号码。';
  $('#queryResults').replaceChildren(el('div', { class: 'query-empty' }, el('strong', { text: '等待查询' }), el('span', { text: hint }), el('button', { id: 'emptyDbConnect', class: 'wb-button primary', type: 'button', text: '打开连接设置', on: { click: () => { renderConnectionList(); openDialog('connectionDialog'); } } })));
}
function renderDbStatus() {
  const root = $('#dbStatusCards'); root.replaceChildren();
  for (const source of ['udal', 'doris']) {
    const item = state.databases[source]; const config = item.config || state.connectionProfiles[source] || {}; const detail = item.connected ? `${config.host || ''}:${config.port || ''} · ${config.username || ''}` : '未连接';
    root.append(el('button', { class: 'db-status-card', type: 'button', on: { click: () => { renderConnectionList(); openDialog('connectionDialog'); } } }, el('span', { class: `status-dot ${item.connected ? 'on' : ''}`, 'aria-hidden': 'true' }), el('span', { class: 'db-status-copy' }, el('strong', { text: DB_SOURCE_LABEL[source] }), el('small', { text: detail }))));
  }
}
function setQueryState(message, tone = '') { setText($('#queryState'), message); $('#queryState').dataset.tone = tone; }
function displayValue(value, column = '') {
  if (value === null || value === undefined || value === '') return '—'; if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value); if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return formatDate(text, { withZone: true, milliseconds: true });
  if (/(?:date|time|时间|_at)$/i.test(String(column)) && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) return `${text.replace('T', ' ')} +08:00`;
  return text;
}
function renderTable(rows) {
  if (!rows?.length) return el('div', { class: 'query-section-empty', text: '无数据或关联缺失' });
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const head = el('tr'); columns.forEach((column) => head.append(el('th', { text: column })));
  const body = el('tbody'); rows.forEach((row) => { const tr = el('tr'); columns.forEach((column) => { const text = displayValue(row[column], column); tr.append(el('td', { text, title: text })); }); body.append(tr); });
  return el('div', { class: 'query-table-wrap' }, el('table', { class: 'query-table' }, el('thead', {}, head), body));
}
function resultSection(title, rows, { open = false, actions = [] } = {}) {
  const details = el('details', { class: 'query-section', ...(open ? { open: '' } : {}) }, el('summary', { text: `${title} · ${rows?.length || 0} 条` }), renderTable(rows));
  if (actions.length) details.append(el('div', { class: 'query-row-actions' }, ...actions));
  return details;
}
function renderQueryResult(result) {
  state.phoneQuery.result = result; const root = $('#queryResults'); root.replaceChildren(); const data = result.data || {};
  const statusText = { complete: '查询完成', partial: '部分完成', empty: '无匹配', failed: '查询失败' }[result.status] || result.status;
  root.append(el('div', { class: 'query-summary' }, el('span', { class: `summary-chip ${result.status === 'partial' ? 'warn' : result.status === 'failed' ? 'err' : ''}`, text: statusText }), el('span', { class: 'summary-chip', text: `号码 ${result.phone}` }), el('span', { class: 'summary-chip', text: `共 ${result.totalRows || 0} 行` }), el('span', { class: 'summary-chip', text: formatDate(result.queriedAt, { withZone: true, milliseconds: true }) }), ...(result.truncated ? [el('span', { class: 'summary-chip warn', text: '结果已达上限' })] : [])));
  const failed = (result.steps || []).filter((step) => step.status === 'error');
  if (failed.length) {
    const list = el('ul', { class: 'query-step-list' });
    failed.forEach((step) => list.append(el('li', { class: 'query-step error' }, el('strong', { text: step.name }), el('span', { text: `${step.database} · ${step.message}` }))));
    root.append(list);
  }
  root.append(resultSection('查询步骤与数据来源', (result.steps || []).map((step) => ({ 步骤: step.name, 状态: step.status, 行数: step.count, 数据源: step.source, 逻辑库: step.database, 读取时间: step.readAt, 错误: step.message || '' }))));
  const customerId = data.productInstances?.[0]?.OWNER_CUST_ID; const productInstanceId = data.productInstances?.[0]?.prod_inst_id;
  const customerButton = el('button', { class: 'wb-button', type: 'button', text: '查看同客户其他产品', disabled: !customerId, on: { click: () => loadCustomerProducts(customerId) } });
  const candidateButton = el('button', { class: 'wb-button', type: 'button', text: '辅助定位账户', disabled: !customerId && !productInstanceId, on: { click: () => loadAccountCandidates(productInstanceId, customerId) } });
  root.append(
    resultSection('产品实例', data.productInstances, { open: true, actions: [customerButton] }), resultSection('产品定义', data.productDefinitions),
    resultSection('账户付费关系', data.accountRelations, { open: true, actions: data.productInstances?.length && !data.accountRelations?.length ? [candidateButton] : [] }), resultSection('账户与合同', data.accounts, { open: true }),
    resultSection('产品与销售品关系', data.offerRelations), resultSection('销售品实例', data.offerInstances), resultSection('套餐 / 销售品定义', data.offers, { open: true }), resultSection('定价计划', data.pricingPlans),
  );
}
function renderThresholdResult(result) {
  state.thresholdQuery.result = result; const root = $('#queryResults'); root.replaceChildren(); const data = result.data || {};
  const statusText = { complete: '查询完成', partial: '部分完成', empty: '无匹配', failed: '查询失败' }[result.status] || result.status;
  root.append(el('div', { class: 'query-summary' }, el('span', { class: `summary-chip ${result.status === 'partial' ? 'warn' : result.status === 'failed' ? 'err' : ''}`, text: statusText }), el('span', { class: 'summary-chip', text: `A 端实例 ${result.aProductInstanceId}` }), el('span', { class: 'summary-chip', text: `终端产品规格 ${result.productId}` }), el('span', { class: 'summary-chip', text: `共 ${result.totalRows || 0} 行` }), el('span', { class: 'summary-chip', text: formatDate(result.queriedAt, { withZone: true, milliseconds: true }) }), ...(result.truncated ? [el('span', { class: 'summary-chip warn', text: '结果已达上限' })] : [])));
  const failed = (result.steps || []).filter((step) => step.status === 'error');
  if (failed.length) { const list = el('ul', { class: 'query-step-list' }); failed.forEach((step) => list.append(el('li', { class: 'query-step error' }, el('strong', { text: step.name }), el('span', { text: `${step.database} · ${step.message}` })))); root.append(list); }
  root.append(
    resultSection('查询步骤与数据来源', (result.steps || []).map((step) => ({ 步骤: step.name, 状态: step.status, 行数: step.count, 数据源: step.source, 逻辑库: step.database, 读取时间: step.readAt, 错误: step.message || '' })), { open: false }),
    resultSection('A/Z 产品实例关系', data.relationships, { open: true }),
    resultSection('符合规格的终端产品实例', data.terminalProducts, { open: true }),
    resultSection('档位提醒配置', data.thresholdAttributes, { open: true }),
  );
}
async function loadCustomerProducts(customerId) {
  try { setQueryState('正在查询同客户其他产品…'); const response = await postJson('/api/query/customer-products', { customerId }, { timeout: 60000 }); const phones = [...new Set(response.result.rows.map((row) => row.acc_num).filter(Boolean))]; const actions = phones.map((phone) => el('button', { class: 'wb-button', type: 'button', text: `查询 ${phone}`, on: { click: () => { $('#phoneInput').value = phone; $('#phoneQueryForm').requestSubmit(); } } })); const section = resultSection('同客户其他产品（按需展开）', response.result.rows, { open: true, actions }); $('#queryResults').append(section); setQueryState(`同客户产品已加载 · ${response.result.rows.length} 条`, 'success'); } catch (error) { setQueryState(error.message, 'error'); }
}
async function loadAccountCandidates(productInstanceId, customerId) { try { setQueryState('正在辅助定位账户…'); const response = await postJson('/api/query/account-candidates', { productInstanceId: String(productInstanceId || ''), customerId: String(customerId || '') }, { timeout: 60000 }); $('#queryResults').append(resultSection('账户候选（非付费关系结论）', response.result.rows, { open: true })); setQueryState(`账户候选已加载 · ${response.result.rows.length} 条`, 'success'); } catch (error) { setQueryState(error.message, 'error'); } }
async function restoreDatabaseStatus() { try { const response = await getJson('/api/db/status'); for (const source of ['udal', 'doris']) { const item = response.sources?.[source] || {}; state.connectionProfiles[source] = response.defaults?.[source] || state.connectionProfiles[source]; state.databases[source] = { connected: Boolean(item.connected), config: item.config, password: '' }; } renderDbStatus(); renderConnectionList(); } catch (_) { renderDbStatus(); } }
async function submitPhoneQuery(event) {
  event?.preventDefault(); const phone = $('#phoneInput').value.trim(); if (!phone) { setQueryState('请输入手机号或接入号码', 'error'); return; } if (!state.databases.udal.connected) { setQueryState('请先连接 MySQL / UDAL', 'error'); renderConnectionList(); openDialog('connectionDialog'); return; }
  const request = state.gates.phone.next(); state.phoneQuery.running = true; $('#btnPhoneQuery').disabled = true; $('#btnPhoneCancel').classList.remove('hidden'); setQueryState('正在按关联链分步查询…'); $('#queryResults').replaceChildren(el('div', { class: 'query-empty' }, el('strong', { text: '查询中' }), el('span', { text: '正在读取 CRM3DB 与 CONFIGDB_CNOS_JF_TEST' })));
  try { const response = await postJson('/api/query/phone', { phone }, { signal: request.signal, timeout: 60000 }); if (!request.isCurrent()) return; renderQueryResult(response.result); setQueryState(response.result.status === 'partial' ? '查询部分完成，请查看缺失或失败步骤' : response.result.status === 'empty' ? '没有找到匹配号码' : '查询完成', response.result.status === 'complete' ? 'success' : ''); }
  catch (error) { if (!request.isCurrent() || error.code === 'REQUEST_ABORTED') return; setQueryState(error.message, 'error'); $('#queryResults').replaceChildren(el('div', { class: 'query-empty' }, el('strong', { text: '查询失败' }), el('span', { text: error.message }))); }
  finally { if (request.isCurrent()) { state.phoneQuery.running = false; $('#btnPhoneQuery').disabled = false; $('#btnPhoneCancel').classList.add('hidden'); } }
}
async function submitThresholdQuery(event) {
  event?.preventDefault(); const aProductInstanceId = $('#thresholdProductInput').value.trim(); if (!aProductInstanceId) { setQueryState('请输入 A 端产品实例 ID', 'error'); return; } if (!state.databases.udal.connected) { setQueryState('请先连接 MySQL / UDAL', 'error'); renderConnectionList(); openDialog('connectionDialog'); return; }
  const request = state.gates.threshold.next(); state.thresholdQuery.running = true; $('#btnThresholdQuery').disabled = true; $('#btnThresholdCancel').classList.remove('hidden'); setQueryState('正在查询 A/Z 关系与档位提醒配置…'); $('#queryResults').replaceChildren(el('div', { class: 'query-empty' }, el('strong', { text: '查询中' }), el('span', { text: '正在读取 CRM3DB 的产品关系、终端产品与属性配置' })));
  try { const response = await postJson('/api/query/threshold', { aProductInstanceId }, { signal: request.signal, timeout: 60000 }); if (!request.isCurrent()) return; renderThresholdResult(response.result); setQueryState(response.result.status === 'partial' ? '查询部分完成，请查看缺失或失败步骤' : response.result.status === 'empty' ? '没有找到符合条件的终端产品或档位配置' : '查询完成', response.result.status === 'complete' ? 'success' : ''); }
  catch (error) { if (!request.isCurrent() || error.code === 'REQUEST_ABORTED') return; setQueryState(error.message, 'error'); $('#queryResults').replaceChildren(el('div', { class: 'query-empty' }, el('strong', { text: '查询失败' }), el('span', { text: error.message })));
  } finally { if (request.isCurrent()) { state.thresholdQuery.running = false; $('#btnThresholdQuery').disabled = false; $('#btnThresholdCancel').classList.add('hidden'); } }
}
function switchQueryTab(query) { state.activeQuery = query === 'threshold' ? 'threshold' : 'phone'; $$('[data-query-tab]').forEach((button) => { const active = button.dataset.queryTab === state.activeQuery; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); }); $$('[data-query-pane]').forEach((pane) => pane.classList.toggle('hidden', pane.dataset.queryPane !== state.activeQuery)); clearQueryResult(); }
$('#emptyDbConnect').addEventListener('click', () => { renderConnectionList(); openDialog('connectionDialog'); });
$('#btnConnectAll').addEventListener('click', () => void connectAll());
$$('[data-query-tab]').forEach((button) => button.addEventListener('click', () => switchQueryTab(button.dataset.queryTab)));
$('#phoneQueryForm').addEventListener('submit', submitPhoneQuery); $('#btnPhoneCancel').addEventListener('click', () => { state.gates.phone.cancel(); state.phoneQuery.running = false; $('#btnPhoneQuery').disabled = false; $('#btnPhoneCancel').classList.add('hidden'); setQueryState('查询已取消'); });
$('#thresholdQueryForm').addEventListener('submit', submitThresholdQuery); $('#btnThresholdCancel').addEventListener('click', () => { state.gates.threshold.cancel(); state.thresholdQuery.running = false; $('#btnThresholdQuery').disabled = false; $('#btnThresholdCancel').classList.add('hidden'); setQueryState('查询已取消'); }); $('#btnQueryReset').addEventListener('click', clearQueryResult);

async function checkStatus() { if (document.hidden || state.statusRunning) return; state.statusRunning = true; try { const [sshStatus, dbStatus] = await Promise.all([getJson('/api/status'), getJson('/api/db/status')]); if (state.connected && !sshStatus.connected) { setConnected(false); toast('远程连接已断开', 'err'); } for (const source of ['udal', 'doris']) { const item = dbStatus.sources?.[source]; if (item) { state.databases[source].connected = Boolean(item.connected); state.databases[source].config = item.config || state.databases[source].config; } } renderDbStatus(); } catch (error) { if (state.connected) { setConnected(false); toast('本地桥接服务不可用', 'err'); } } finally { state.statusRunning = false; if (!document.hidden) state.statusTimer = setTimeout(checkStatus, 5000); } }
document.addEventListener('visibilitychange', () => { clearTimeout(state.statusTimer); if (!document.hidden) checkStatus(); });

$('#pathInput').value = state.cwd; $('#hdfsPathInput').value = state.hdfsCwd; $('#hbasePathInput').value = state.hbaseCwd;
renderBreadcrumbs($('#crumbs'), state.cwd, state.home, (value) => navigateResource('files', value)); renderBreadcrumbs($('#hdfsCrumbs'), state.hdfsCwd, '/', (value) => navigateResource('hdfs', value)); renderBreadcrumbs($('#hbaseCrumbs'), state.hbaseCwd, '/', (value) => navigateResource('hbase', value)); renderFavorites(); updateFavoriteButtons();
(async function init() {
  state.annotations = loadAnnotations();
  try {
    const cfg = await getJson('/api/config'); state.config = cfg.config || null; state.connectionProfiles = { ...state.connectionProfiles, ...(cfg.connections || {}), ssh: cfg.connections?.ssh || cfg.config || null };
    const configuredTimeouts = cfg.timeouts || {};
    state.timeouts = { filesListMs: DEFAULT_RESOURCE_TIMEOUTS.filesListMs, hdfsListMs: Number(configuredTimeouts.hdfsListMs) || DEFAULT_RESOURCE_TIMEOUTS.hdfsListMs, hbaseScanMs: Number(configuredTimeouts.hbaseScanMs) || DEFAULT_RESOURCE_TIMEOUTS.hbaseScanMs };
    state.favorites = loadFavoritesForCurrentServer(); renderFavorites(); updateFavoriteButtons(); renderConnectionList();
  } catch (_) {}
  await restoreDatabaseStatus();
  await restoreSession();
  checkStatus();
})();

// 页面刷新/重开后恢复仍存活在 Node 进程里的 SSH 会话；新连接统一由连接弹窗发起。
async function restoreSession() {
  try {
    const connectionStatus = await getJson('/api/status');
    if (connectionStatus?.connected) {
      // 后端 SSH 会话仍在：直接恢复前端状态，不重新认证
      const conn = connectionStatus.conn || state.connectionProfiles.ssh || {};
      setConnected(true, conn);
      state.home = connectionStatus.home || '~';
      state.cwd = state.home;
      status(`已恢复连接 · ${conn.host || ''}`, 'success');
      toast(`已恢复 ${conn.host || ''} 的连接会话`, 'ok');
      if ($('#filesPane') && !$('#filesPane').classList.contains('hidden')) void refreshFiles();
    }
  } catch (_) { /* 桥接服务不可用：保持默认未连接状态 */ }
}
