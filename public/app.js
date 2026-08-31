/* =====================================================================
 * 远程服务器管理工作台 · 前端逻辑（零外部依赖）
 * ===================================================================*/
'use strict';

/* ---------- 全局状态 ---------- */
const state = {
  connected: false,
  config: null,       // {host,port,username}
  home: '~',
  cwd: '~',           // 文件浏览器当前目录
  history: [],        // 命令历史
  hIdx: -1,
  pendingDelete: null,
  autoRefreshTimers: new Map(), // logBlockId -> {timer, block}
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ---------- 快捷指令定义（数据驱动） ---------- */
const COMMANDS = [
  { group: '查看', icon: 'folder', label: '当前目录文件列表', sub: 'ls -lh', desc: '列出当前目录下的文件和文件夹，含大小、修改时间。', cmd: 'ls -lh', autoCwd: true },
  { group: '查看', icon: 'pin', label: '我现在的位置', sub: 'pwd', desc: '显示当前所在目录的完整路径。', cmd: 'pwd', autoCwd: true },
  { group: '查看', icon: 'file', label: '查看文件内容', sub: 'cat 文件路径', desc: '查看指定文本文件的内容（超过 256KB 自动截断，大文件建议用「查看文件最后 N 行」）。', params: [{ key: 'file', label: '文件路径', ph: '例如 /home/cnos_jf/app/logs/run.log' }], build: (v) => `cat ${q(v.file)} | head -c 262144`, refreshable: true },
  { group: '查看', icon: 'file', label: '查看文件最后 N 行', sub: 'tail -n 100 文件', desc: '查看文件末尾内容，适合看最新日志。可开启自动刷新，持续跟踪日志变化。', params: [{ key: 'n', label: '行数', ph: '100', def: '100' }, { key: 'file', label: '文件路径', ph: '/home/cnos_jf/app/logs/run.log' }], build: (v) => `tail -n ${num(v.n, 100)} ${q(v.file)}`, refreshable: true },
  { group: '查看', icon: 'search', label: '按名字查找文件', sub: 'find … -name "关键字"', desc: '在指定目录下按文件名关键字查找文件（最多显示 50 条）。', params: [{ key: 'kw', label: '文件名关键字', ph: '例如 .log' }, { key: 'dir', label: '查找范围（目录）', ph: '留空 = 当前浏览目录' }], build: (v) => `find ${q(v.dir || state.cwd)} -name ${q('*' + v.kw + '*')} 2>/dev/null | head -50` },
  { group: '查看', icon: 'search', label: '搜索文件内容', sub: 'grep -rn "关键字" …', desc: '在指定目录的文件内容中搜索关键字，定位配置/日志中的信息（最多显示 50 条）。', params: [{ key: 'kw', label: '搜索关键字', ph: '例如 ERROR' }, { key: 'dir', label: '搜索范围（目录）', ph: '留空 = 当前浏览目录' }], build: (v) => `grep -rn ${q(v.kw)} ${q(v.dir || state.cwd)} 2>/dev/null | head -50` },
  { group: '增建', icon: 'plus', label: '新建文件夹', sub: 'mkdir 名称', desc: '在当前浏览目录下新建文件夹。', params: [{ key: 'name', label: '文件夹名称', ph: '例如 test_dir' }], build: (v) => `mkdir ${q(state.cwd.replace(/~$/, state.home) + '/' + v.name)}`, successMsg: '文件夹已创建，文件列表已刷新' },
  { group: '增建', icon: 'plus', label: '新建空文件', sub: 'touch 名称', desc: '在当前浏览目录下新建空文件。', params: [{ key: 'name', label: '文件名', ph: '例如 notes.txt' }], build: (v) => `touch ${q(state.cwd.replace(/~$/, state.home) + '/' + v.name)}`, successMsg: '文件已创建，文件列表已刷新' },
  { group: '删除', icon: 'trash', label: '删除文件', sub: 'rm 文件路径', danger: true, desc: '删除指定的文件（不可恢复，需二次确认）。', params: [{ key: 'file', label: '要删除的文件路径', ph: '例如 /home/cnos_jf/test.txt' }], build: (v) => `rm ${q(v.file)}`, confirm: '文件', successMsg: '文件已删除，文件列表已刷新' },
  { group: '删除', icon: 'trash', label: '删除空文件夹', sub: 'rmdir 目录路径', danger: true, desc: '删除空文件夹（仅限空目录，更安全；删除后可用 ls 验证）。', params: [{ key: 'dir', label: '要删除的文件夹路径', ph: '例如 /home/cnos_jf/test_dir' }], build: (v) => `rmdir ${q(v.dir)}`, confirm: '文件夹', successMsg: '文件夹已删除，文件列表已刷新' },
  { group: '系统', icon: 'disk', label: '磁盘空间', sub: 'df -h', desc: '查看各磁盘分区的总容量与剩余空间。', cmd: 'df -h' },
  { group: '系统', icon: 'mem', label: '内存使用', sub: 'free -h', desc: '查看服务器内存总量、已用与剩余。', cmd: 'free -h' },
  { group: '系统', icon: 'cpu', label: '运行中的进程', sub: 'ps -ef | head -60', desc: '查看当前运行中的进程（前 60 条）。', cmd: 'ps -ef | head -60' },
  { group: '系统', icon: 'clock', label: '运行时长与负载', sub: 'uptime', desc: '服务器已运行多久、当前负载。', cmd: 'uptime' },
  { group: '系统', icon: 'user', label: '当前登录用户', sub: 'who && whoami', desc: '查看当前有哪些用户登录本服务器。', cmd: 'who && whoami' },
];

const GROUP_TAGS = { '查看': '增删查 · 查', '增建': '增删查 · 增', '删除': '增删查 · 删', '系统': '服务器状态' };
const ICONS = {
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  plus: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  disk: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  mem: '<rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="18" x2="6" y2="12"/><line x1="10" y1="18" x2="10" y2="12"/><line x1="14" y1="18" x2="14" y2="12"/><line x1="18" y1="18" x2="18" y2="12"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
};
const iconSvg = (n, sz = 15) => `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ICONS.file}</svg>`;

/* ---------- 工具函数 ---------- */
function q(s) { return '"' + String(s == null ? '' : s).trim().replace(/(["\\])/g, '\\$1') + '"'; }
function num(v, def) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : def; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function nowTime() { const d = new Date(); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':'); }
function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(1) + ' GB';
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function joinPath(dir, name) {
  if (dir === '~') return '~/' + name;
  return dir.replace(/\/+$/, '') + '/' + name;
}
function expandPath(p) { return p === '~' ? state.home : p; }

function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 350); }, 3200);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  return data;
}
async function post(path, body) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
}

/* =====================================================================
 * 输出高亮：把命令输出渲染成带颜色的 HTML
 *====================================================================*/
function highlightLsLine(line) {
  // ls -l 输出：权限 链接 属主 属组 大小 日期 时间 名称
  const m = line.match(/^([drwxstST+.-]{10,})\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+(?:\.\d+)?[KMGT]?)\s+(\w{3}\s+\d{1,2}\s+[\d:]+|\d{4}-\d{2}-\d{2}\s+[\d:]+)\s+(.*)$/);
  if (!m) return null;
  const isDir = m[1][0] === 'd';
  const isLink = m[1][0] === 'l';
  let nameHtml;
  const nm = m[7];
  if (isLink) {
    const i = nm.indexOf(' -> ');
    const l = i >= 0 ? nm.slice(0, i) : nm;
    const r = i >= 0 ? nm.slice(i + 4) : '';
    nameHtml = `<span class="hl-link">${esc(l)}</span>${i >= 0 ? ' <span class="hl-date">-></span> <span class="hl-link">' + esc(r) + '</span>' : ''}`;
  } else {
    nameHtml = isDir ? `<span class="hl-dir">${esc(nm)}/</span>` : esc(nm);
  }
  return `<span class="hl-perm">${esc(m[1])}</span>  ${esc(m[2])}  ${esc(m[3])}  ${esc(m[4])}  <span class="hl-size">${esc(m[5])}</span>  <span class="hl-date">${esc(m[6])}</span>  ${nameHtml}`;
}

function highlightLine(line) {
  if (/permission denied|no such file or directory|not found|cannot|failed|error|denied|invalid|argument|refused/i.test(line)) {
    return `<span class="hl-err">${esc(line)}</span>`;
  }
  const ls = highlightLsLine(line);
  if (ls) return ls;
  // df -h 表头与分区
  if (/^Filesystem\s/i.test(line)) return `<span class="hl-head">${esc(line)}</span>`;
  if (/^\/dev\//.test(line)) {
    return esc(line).replace(/^([^ ]+)/, '<span class="hl-dir">$1</span>').replace(/(\d+%)/, '<span class="hl-size">$1</span>');
  }
  // free -h 表头
  if (/^\s*(total|Mem:|Swap:)\s/i.test(line)) return `<span class="hl-head">${esc(line)}</span>`;
  // ps 表头
  if (/^\s*UID\s+PID\s+PPID/.test(line)) return `<span class="hl-head">${esc(line)}</span>`;
  return esc(line);
}

function highlightOutput(text) {
  return text.split('\n').map(highlightLine).join('\n');
}

/* =====================================================================
 * 日志块管理
 *====================================================================*/
let blockSeq = 0;

function appendLogBlock(cmd, opts) {
  opts = opts || {};
  $('#emptyState').style.display = 'none';
  const id = 'lb' + (++blockSeq);
  const el = document.createElement('div');
  el.className = 'log-block';
  el.innerHTML = `
    <div class="log-head">
      <span class="log-time">${nowTime()}</span>
      <span class="log-cmd">${esc(cmd)}</span>
      <span class="badge run" data-role="badge">执行中…</span>
      <div class="grow"></div>
      ${opts.refreshable ? `<label class="autorefresh" title="每 10 秒自动重新执行一次，适合跟踪日志"><input type="checkbox" data-role="autorefresh">自动刷新</label>` : ''}
      <div class="log-acts">
        <button class="fact" data-role="copy" title="复制输出内容">复制</button>
        <button class="fact" data-role="save" title="将该输出保存为本地 txt 文件">保存</button>
      </div>
    </div>
    <pre class="log-body" data-role="body"><span data-role="out">正在执行…</span></pre>`;
  $('#logFlow').appendChild(el);
  el.scrollIntoView({ block: 'nearest' });

  const block = {
    id, el, cmd,
    setRunning() { el.querySelector('[data-role=badge]').className = 'badge run'; el.querySelector('[data-role=badge]').textContent = '执行中…'; },
    setResult(out, code, durationMs) {
      const badge = el.querySelector('[data-role=badge]');
      if (code === 0) { badge.className = 'badge ok'; badge.textContent = '成功 · ' + (durationMs / 1000).toFixed(1) + 's'; }
      else { badge.className = 'badge err'; badge.textContent = '退出码 ' + code + (durationMs ? ' · ' + (durationMs / 1000).toFixed(1) + 's' : ''); }
      el.querySelector('[data-role=out]').innerHTML = out;
    },
    setError(errText) {
      const badge = el.querySelector('[data-role=badge]');
      badge.className = 'badge err'; badge.textContent = '失败';
      el.querySelector('[data-role=out]').innerHTML = `<span class="hl-err">✕ ${esc(errText)}</span>`;
    },
    setText(t) { el.querySelector('[data-role=out]').textContent = t; },
    rawText() { return el.querySelector('[data-role=out]').textContent || ''; },
    serialize() {
      return {
        t: el.querySelector('.log-time').textContent || '',
        cmd: el.querySelector('.log-cmd').textContent || '',
        badge: el.querySelector('[data-role=badge]').textContent || '',
        out: this.rawText(),
      };
    },
  };

  el.querySelector('[data-role=copy]').onclick = async () => {
    try { await navigator.clipboard.writeText(block.rawText()); toast('已复制到剪贴板', 'ok'); }
    catch (e) { toast('复制失败，请手动选择文本'); }
  };
  el.querySelector('[data-role=save]').onclick = () => {
    const blob = new Blob([block.rawText()], { type: 'text/plain;charset=utf-8' });
    downloadBlob(blob, '日志_' + nowTime().replace(/:/g, '-') + '.txt');
  };
  const arCb = el.querySelector('[data-role=autorefresh]');
  if (arCb) arCb.onchange = () => toggleAutoRefresh(block, arCb.checked, opts.buildCmd);
  return block;
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* 自动刷新（跟踪日志） */
function toggleAutoRefresh(block, on, buildCmd) {
  const old = state.autoRefreshTimers.get(block.id);
  if (old) { clearInterval(old.timer); state.autoRefreshTimers.delete(block.id); }
  if (!on) return;
  toast('已开启自动刷新（每 10 秒）', 'ok');
  const run = async () => {
    try {
      const cmd = buildCmd();
      const r = await post('/api/exec', { cmd });
      if (r.ok) block.setResult(highlightOutput(r.stdout || (r.stderr ? r.stderr : '（无输出）')), r.code, r.duration);
      else block.setError(r.error || '执行失败');
    } catch (e) { block.setError(e.message); }
  };
  run();
  state.autoRefreshTimers.set(block.id, { timer: setInterval(run, 10000) });
}

/* =====================================================================
 * 命令执行入口
 *====================================================================*/
async function runCommand(cmd, opts) {
  opts = opts || {};
  const block = appendLogBlock(cmd, opts);
  try {
    const r = await post('/api/exec', { cmd, confirmed: !!opts.confirmed, timeout: opts.timeoutHint });
    if (r.needConfirm) { block.setError('该命令为删除类操作，请在弹窗中二次确认后重试'); persistLog(block); return null; }
    if (!r.ok) { block.setError(r.error || '执行失败'); persistLog(block); return null; }
    const out = r.stdout || r.stderr || '（无输出）';
    block.setResult(highlightOutput(out), r.code, r.duration);
    persistLog(block);
    if (r.timedOut) toast('命令执行超时，已截断输出');
    if (opts.successMsg && r.code === 0) toast(opts.successMsg, 'ok');
    if (opts.onDone) opts.onDone(r);
    return r;
  } catch (e) {
    block.setError('本地服务异常：' + e.message + '（请确认 start.bat 启动的服务仍在运行）');
    persistLog(block);
    return null;
  }
}

/* 执行日志持久化：把一条日志块写入后端本地文件（logs/YYYY-MM-DD.log） */
async function persistLog(block) {
  try {
    await post('/api/log/append', block.serialize());
  } catch (e) {
    // 落盘失败不影响命令执行，静默忽略
  }
}

/* 刷新恢复：加载当天日志并渲染到日志区（历史条目只读，无操作按钮） */
async function restoreLogs() {
  try {
    const r = await api('/api/log/list');
    if (!r.ok || !r.entries || !r.entries.length) return;
    const flow = $('#logFlow');
    $('#emptyState').style.display = 'none';
    r.entries.forEach((e) => {
      const el = document.createElement('div');
      el.className = 'log-block';
      el.innerHTML = `
        <div class="log-head">
          <span class="log-time">${esc(e.t || '')}</span>
          <span class="log-cmd">${esc(e.cmd || '')}</span>
          <span class="badge ${e.badge && e.badge.indexOf('失败') >= 0 ? 'err' : (e.badge && e.badge.indexOf('成功') >= 0 ? 'ok' : 'run')}" data-role="badge">${esc(e.badge || '')}</span>
          <div class="grow"></div>
        </div>
        <pre class="log-body" data-role="body"><span data-role="out">${e.out || ''}</span></pre>`;
      flow.appendChild(el);
    });
    flow.scrollTop = flow.scrollHeight;
    if (r.date) toast('已恢复 ' + r.date + ' 的历史日志（' + r.entries.length + ' 条）', 'ok');
  } catch (e) {
    // 恢复失败静默忽略（后端未启动等）
  }
}

/* 带删除确认的执行 */
function runDangerCommand(cmd, kind, path, successMsg) {
  $('#delTitle').textContent = '确认删除' + (kind || '');
  $('#delNote').innerHTML = `即将在服务器上删除以下${kind || '内容'}：<br><code>${esc(path)}</code><br><br>对应命令：<code>${esc(cmd)}</code>`;
  $('#ovDelete').classList.add('show');
  state.pendingDelete = { cmd, successMsg };
}
$('#btnDelConfirm').onclick = async () => {
  const p = state.pendingDelete;
  if (!p) return;
  $('#ovDelete').classList.remove('show');
  state.pendingDelete = null;
  const r = await runCommand(p.cmd, { confirmed: true, successMsg: p.successMsg });
  if (r && r.code === 0) refreshFiles();
};

/* =====================================================================
 * 快捷指令面板渲染
 *====================================================================*/
function renderCmdPane() {
  const pane = $('#cmdPane');
  pane.innerHTML = '';
  const groups = ['查看', '增建', '删除', '系统'];
  groups.forEach((g) => {
    const title = document.createElement('div');
    title.className = 'cmd-group-title';
    title.innerHTML = `${g} <span class="tag">${GROUP_TAGS[g]}</span>`;
    pane.appendChild(title);
    COMMANDS.filter((c) => c.group === g).forEach((c) => {
      const btn = document.createElement('button');
      btn.className = 'cmd-btn' + (c.danger ? ' danger' : '');
      btn.innerHTML = `<span class="lab">${iconSvg(c.icon)}${c.label}</span><span class="sub">${esc(c.sub || '')}</span>`;
      btn.onclick = () => invokeCommand(c);
      pane.appendChild(btn);
    });
  });
}

function invokeCommand(c) {
  if (!state.connected) { toast('请先点击右上角【连接】按钮', 'err'); return; }
  if (c.params) { openParamModal(c); return; }
  const cmd = c.autoCwd ? `cd ${q(expandPath(state.cwd))} && ${c.cmd}` : c.cmd;
  runCommand(cmd, { successMsg: c.successMsg, onDone: c.successMsg ? refreshFiles : null });
}

/* 参数化命令弹窗 */
let currentParamCmd = null;
function openParamModal(c) {
  currentParamCmd = c;
  $('#paramTitle').textContent = c.label;
  $('#paramDesc').textContent = c.desc || '';
  const box = $('#paramFields');
  box.innerHTML = '';
  c.params.forEach((p) => {
    const f = document.createElement('div');
    f.className = 'field';
    f.innerHTML = `<label>${esc(p.label)}</label><input data-pkey="${esc(p.key)}" placeholder="${esc(p.ph || '')}" value="${esc(p.def || '')}">`;
    box.appendChild(f);
  });
  updateParamPreview();
  box.querySelectorAll('input').forEach((inp) => {
    inp.oninput = updateParamPreview;
    inp.onkeydown = (e) => { if (e.key === 'Enter') $('#btnParamRun').click(); };
  });
  $('#ovParams').classList.add('show');
  setTimeout(() => { const first = box.querySelector('input'); if (first) first.focus(); }, 50);
}
function updateParamPreview() {
  if (!currentParamCmd) return;
  const v = {};
  $('#paramFields').querySelectorAll('input').forEach((inp) => { v[inp.dataset.pkey] = inp.value; });
  try {
    const cmd = currentParamCmd.build(v);
    $('#paramPreview').innerHTML = '将执行 → <b>' + esc(cmd) + '</b>';
  } catch (e) {
    $('#paramPreview').textContent = '（请填写参数）';
  }
}
$('#btnParamRun').onclick = () => {
  if (!currentParamCmd) return;
  const v = {};
  let missing = false;
  $('#paramFields').querySelectorAll('input').forEach((inp) => {
    v[inp.dataset.pkey] = inp.value.trim();
    if (!inp.value.trim() && !currentParamCmd.params.find((p) => p.key === inp.dataset.pkey).def) missing = true;
  });
  if (missing) { toast('请先填写完整参数', 'err'); return; }
  const c = currentParamCmd;
  const cmd = c.build(v);
  const vSnapshot = Object.assign({}, v); // 快照参数，避免自动刷新时被后续弹窗覆盖
  $('#ovParams').classList.remove('show');
  if (c.danger) {
    const pathVal = v.file || v.dir || '';
    runDangerCommand(cmd, c.confirm, pathVal, c.successMsg);
    return;
  }
  const opts = { successMsg: c.successMsg, refreshable: c.refreshable, buildCmd: () => c.build(vSnapshot) };
  runCommand(cmd, Object.assign(opts, c.successMsg ? { onDone: refreshFiles } : {}));
};

/* =====================================================================
 * 计费速查面板（数据来自开发提供的排障资料，2026-08）
 *====================================================================*/
const BILL_SUFFIX_KEY = 'wb_bill_suffix';
const HB_MONTH_KEY = 'wb_hb_month';
const HB_NS_KEY = 'wb_hb_ns';
function billSuffix() { return localStorage.getItem(BILL_SUFFIX_KEY) || '597_2606'; }
function hbMonth() { return localStorage.getItem(HB_MONTH_KEY) || '202410'; }
function hbNs() { return localStorage.getItem(HB_NS_KEY) || 'ns_aibcp_dev'; }

/* 话单类型 ↔ 表名映射（type 为空表示无事件类型维度的兜底表） */
const TICKETS = [
  { type: '206080000', biz: 'CDMA 集团话单', table: 'TICKET_CDMA_GROUP' },
  { type: '206070000', biz: 'CDMA 语音话单', table: 'TICKET_CDMA_VOICE' },
  { type: '206110000', biz: 'CDMA 短信话单', table: 'TICKET_CDMA_SMS' },
  { type: '206120000', biz: 'CDMA 业务域话单（C网增值）', table: 'TICKET_CDMA_OPERA' },
  { type: '202010000', biz: '数据业务拨号正常话单', table: 'TICKET_DATA' },
  { type: '201010000', biz: '正常语音话单', table: 'TICKET_VOICE' },
  { type: '205060000', biz: '智能网话单正常单', table: 'TICKET_IN' },
  { type: '203030000', biz: '信息台清单正常单话单', table: 'TICKET_INFO_STATION' },
  { type: '206190000', biz: 'CDMA 综合 VPN 业务话单', table: 'TICKET_IVPN' },
  { type: '204210000', biz: '597 协同通信语音正常话单', table: 'TICKET_COMM_VOICE' },
  { type: '204350000', biz: '彩铃正常话单', table: 'TICKET_BLOC_NCR' },
  { type: '204220100', biz: '597 协同通信短信正常话单', table: 'TICKET_COMM_SMS' },
  { type: '204470000', biz: '全国商务领航正常话单', table: 'TICKET_QBUG' },
  { type: '204410000', biz: '商务领航声讯外包正常单', table: 'TICKET_BNG' },
  { type: '208520000', biz: '国漫语音', table: 'TICKET_ROAM_VOICE' },
  { type: '208530000', biz: '国漫数据', table: 'TICKET_ROAM_DATA' },
  { type: '208540000', biz: '国漫短信', table: 'TICKET_ROAM_SMS' },
  { type: '208550000', biz: '国漫套餐费', table: 'TICKET_ROAM_PACKAGE' },
  { type: '—', biz: '异常单（全部业务）', table: 'TICKET_ABNORMAL' },
  { type: '—', biz: '不计费话单', table: 'TICKET_OTHER' },
];

/* HBase 表速查分组
 * 说明：开发资料按生产环境写 ns_cnos / ACCUMULATOR；本测试服务器实测为 ns_aibcp_dev / ACCUMULATION，
 * 命名空间已做成可配置项，表名按实测修正。 */
const HBASE_GROUPS = [
  {
    title: '分发表（批价结果分发）',
    desc: '记录批价正常单文件分发给哪个模块使用。未处理：DISPATCH_FILE；已处理：DISPATCHED_FILE（另有 _HIS 历史表）。STRA = 发策略中心（MQ），MR = 话单入库。',
    tables: ['{ns}:TICKET_DISPATCH_FILE', '{ns}:TICKET_DISPATCHED_FILE', '{ns}:TICKET_DISPATCHED_FILE_HIS'],
    cmds: [
      { label: '查 STRA（发策略中心）', scan: "scan '{ns}:TICKET_DISPATCH_FILE', {FILTER => \"RowFilter(=,'substring:STRA')\", LIMIT => 10}" },
      { label: '查 MR（话单入库）', scan: "scan '{ns}:TICKET_DISPATCH_FILE', {FILTER => \"RowFilter(=,'substring:MR')\", LIMIT => 10}" },
    ],
  },
  {
    title: '量本表',
    desc: 'ACCUMULATION_0 = 永久累积量表（长期有效量本）；ACCUMULATION_账期 = 量本主表；ACCUMULATION 配套明细见 PROD_INST_ACCU_USE_INFO / ACCU_SOURCE 系列。OWNER_TYPE：24A 独享→关联产品实例，非 24A 共享→关联销售品实例；ACCUM：100=结转，200=使用量。（资料原文写 ACCUMULATOR_，本测试环境实测表名为 ACCUMULATION_）',
    tables: ['{ns}:ACCUMULATION_0', '{ns}:ACCUMULATION_{月}'],
    dynamic: true,
    cmds: [],
  },
  {
    title: '批次表（采预 / 批价处理记录）',
    desc: 'pro_ 前缀 = 当前处理中的批次（一个批次可处理多个文件）；不带 pro_ = 已处理完的批次。preproc = 采预，rating = 批价；major/minor 为主/辅表。',
    tables: ['{ns}:pro_preproc_batch_major_info', '{ns}:pro_preproc_batch_minor_info', '{ns}:preproc_batch_major_info', '{ns}:preproc_batch_minor_info', '{ns}:pro_rating_batch_major_info', '{ns}:pro_rating_batch_minor_info', '{ns}:rating_batch_major_info', '{ns}:rating_batch_minor_info'],
    cmds: [
      { label: '批价·在途批次', scan: "scan '{ns}:pro_rating_batch_major_info', {LIMIT => 10}" },
      { label: '批价·已完成批次', scan: "scan '{ns}:rating_batch_major_info', {LIMIT => 10}" },
      { label: '采预·在途批次', scan: "scan '{ns}:pro_preproc_batch_major_info', {LIMIT => 10}" },
      { label: '采预·已完成批次', scan: "scan '{ns}:preproc_batch_major_info', {LIMIT => 10}" },
    ],
  },
  {
    title: '采预排重表',
    desc: '同一话单文件多次跑会被采预程序排重（按账期分表）。需要重跑时：改文件名，或清理排重表（需评估影响，建议找开发确认）。',
    tables: ['{ns}:source_file_index_{月}'],
    dynamic: true,
    cmds: [],
  },
];

/* 计费服务速查 */
const SERVICES = [
  { name: 'idis-rating-accuminit-process-prod', zh: '量本初始化', group: '批价相关', desc: '根据用户档案将用户订购的套餐量本初始化到 HBase' },
  { name: 'idis-prep-prep-normal-process-prod', zh: '采预程序', group: '批价相关', desc: '话单信息增强' },
  { name: 'idis-rating-cal-process-prod', zh: '批价程序', group: '批价相关', desc: '话单算费处理' },
  { name: 'idis-rating-ticket2pg-process-prod', zh: '入库进程', group: '批价相关', desc: '扫描分发表，将话单（含正常单、异常单、不计费话单）入库到 Doris 数据库' },
  { name: 'idis-rating-msgsend-process-prod', zh: '消息发送进程', group: '批价相关', desc: '扫描分发表，将话单（仅正常单）按逻辑解析生成 MQ 消息，发送给策略中心' },
  { name: 'idis-plca-usage-notification-dljs-cmp-prod', zh: '达量降速', group: '策略中心', desc: '处理批价送来的 MQ 消息，查询量本后满足条件的落 PG 结果表：plca_sms_notify_send_limit' },
  { name: 'idis-plca-usage-notification-dljs-cmp-prod', zh: '大流量提醒', group: '策略中心', desc: '处理批价送来的 MQ 消息，查询量本后满足条件的落 PG 结果表：plca_sms_notify_send_big（资料中服务名与达量降速相同，按原资料收录）' },
  { name: 'idis-plca-usage-notification-process-prod', zh: '阈值提醒', group: '策略中心', desc: '处理批价送来的 MQ 消息，查询量本后满足条件的落 PG 结果表：sms_rat_res_monitor_plca_send' },
];

/* HDFS 常用目录速查（本测试服务器实测，2026-08） */
const HDFS_QUICK_PATHS = [
  { path: '/apps', zh: '计费根目录', desc: '所有计费应用目录的根（bill / bill_cnos_jf / dcs / cal 等）' },
  { path: '/apps/bill_cnos_jf_test/prep', zh: '采预 prep', desc: '采预程序目录，话单从这里进入预处理流程' },
  { path: '/apps/bill_cnos_jf/cal', zh: '批价 cal', desc: '批价计算目录，正式计费处理结果' },
];

/* 常用命令速查 · HDFS 分组（服务器类放在 COMMANDS 增删查里，HDFS 类在此速查展示） */
const CHEATSHEET = [
  { group: 'HDFS 命令', items: [
    { cmd: 'hadoop fs -ls <路径>', zh: '列目录', desc: '列出 HDFS 指定目录内容（如 /apps）' },
    { cmd: 'hadoop fs -ls -R <路径>', zh: '递归列目录', desc: '递归列出目录下所有文件（慎用，可能很大）' },
    { cmd: 'hadoop fs -du -h <路径>', zh: '目录占用', desc: '统计目录磁盘占用（含子目录汇总）' },
    { cmd: 'hadoop fs -df -h', zh: '集群空间', desc: '查看 HDFS 集群整体空间使用情况' },
    { cmd: 'hadoop fs -cat <文件>', zh: '查看文件', desc: '查看 HDFS 文件内容' },
    { cmd: 'hadoop fs -head 50 <文件>', zh: '查看头部', desc: '查看文件前 50 行（比 cat 安全）' },
    { cmd: 'hadoop fs -tail 100 <文件>', zh: '查看尾部', desc: '查看文件后 100 行（适合看日志）' },
    { cmd: 'hadoop fs -count -q <路径>', zh: '计数配额', desc: '统计文件/目录数量与配额使用' },
    { cmd: 'hadoop fs -mv <src> <dst>', zh: '移动/重命名', desc: '移动或重命名 HDFS 文件（重跑排重时改文件名用）' },
    { cmd: 'hadoop fs -rm <文件>', zh: '删除文件', desc: '删除 HDFS 文件（危险，需评估影响）' },
    { cmd: 'hadoop fs -rmdir <空目录>', zh: '删除空目录', desc: '删除空目录（非空会失败）' },
    { cmd: 'hadoop fs -mkdir -p <路径>', zh: '建目录', desc: '递归创建 HDFS 目录' },
    { cmd: 'echo "scan ..." | hbase shell', zh: '非交互 HBase scan', desc: '非交互执行 HBase scan（常配合计费速查的卡片使用）' },
  ]},
];

/* 把 hbase shell 的 scan 命令包装成服务器上可非交互执行的命令 */
function hbaseWrap(scanCmd) {
  return 'echo "' + scanCmd.replace(/"/g, '\\"') + '" | hbase shell';
}
function ticketSql(table) {
  return 'select count(*) from ' + table + '_' + billSuffix() + ';';
}
function expandHb(t) { return t.replace(/\{ns\}/g, hbNs()).replace(/\{月\}/g, hbMonth()); }

async function copyText(text, tip) {
  try { await navigator.clipboard.writeText(text); toast(tip || '已复制到剪贴板', 'ok'); }
  catch (e) { toast('复制失败，请手动选择文本'); }
}

function renderBillPane() {
  const kw = ($('#billSearch').value || '').trim().toLowerCase();

  /* HDFS 目录速查 */
  const hqt = $('#hdfsQuickTable');
  hqt.innerHTML = '';
  HDFS_QUICK_PATHS.filter((p) => !kw || (p.path + p.zh + p.desc).toLowerCase().includes(kw)).forEach((p) => {
    const row = document.createElement('div');
    row.className = 'bill-row';
    row.innerHTML = `
      <span class="bzh">${esc(p.zh)}</span>
      <span class="btab" style="max-width:none;flex:1;min-width:0" title="${esc(p.path)}">${esc(p.path)}</span>
      <span class="bdesc" style="flex:none;max-width:180px">${esc(p.desc)}</span>
      <button class="fact" data-act="go" title="切到 HDFS 页并进入该目录">进入</button>`;
    row.querySelector('[data-act=go]').onclick = () => {
      state.hdfsCwd = p.path;
      localStorage.setItem(HDFS_CWD_KEY, p.path);
      $('#ovBilling').classList.remove('show');
      switchTab('hdfs');
      refreshHdfs();
    };
    hqt.appendChild(row);
  });
  if (!hqt.children.length) hqt.innerHTML = '<div class="empty-tip" style="padding:14px">无匹配的 HDFS 目录</div>';

  /* 话单映射表 */
  const tt = $('#ticketTable');
  tt.innerHTML = '';
  TICKETS.filter((t) => !kw || (t.type + t.biz + t.table).toLowerCase().includes(kw)).forEach((t) => {
    const row = document.createElement('div');
    row.className = 'bill-row';
    row.innerHTML = `
      <span class="btype">${esc(t.type)}</span>
      <span class="bbiz" title="${esc(t.biz)}">${esc(t.biz)}</span>
      <span class="btab" title="${esc(t.table)}_${esc(billSuffix())}">${esc(t.table)}_${esc(billSuffix())}</span>
      <button class="fact" data-act="sql" title="复制 count SQL，粘贴到数据库客户端执行">SQL</button>`;
    row.querySelector('[data-act=sql]').onclick = () => copyText(ticketSql(t.table), 'SQL 已复制');
    tt.appendChild(row);
  });
  if (!tt.children.length) tt.innerHTML = '<div class="empty-tip" style="padding:14px">无匹配的话单类型</div>';

  /* HBase 卡片 */
  const hc = $('#hbaseCards');
  hc.innerHTML = '';
  HBASE_GROUPS.filter((g) => !kw || (g.title + g.desc + g.tables.join(' ')).toLowerCase().includes(kw)).forEach((g) => {
    const card = document.createElement('div');
    card.className = 'hb-card';
    let cmdsHtml = '';
    const cmds = g.dynamic ? [
      { label: '量本·永久量表', scan: "scan '{ns}:ACCUMULATION_0', {LIMIT => 10}" },
      { label: '量本·主表（{月}）', scan: "scan '{ns}:ACCUMULATION_{月}', {LIMIT => 10}" },
      { label: '排重表（{月}）', scan: "scan '{ns}:source_file_index_{月}', {LIMIT => 10}" },
    ] : g.cmds;
    const finalCmds = g.title.includes('排重') ? cmds.filter((c) => c.label.includes('排重')) : (g.dynamic ? cmds.filter((c) => !c.label.includes('排重')) : cmds);
    finalCmds.forEach((c) => {
      cmdsHtml += `
        <div class="hb-cmd">
          <span class="cl">${esc(c.label)}</span>
          <button class="fact" data-act="run">执行</button>
          <button class="fact" data-act="copy">复制</button>
        </div>`;
    });
    card.innerHTML = `
      <div class="hb-head">${iconSvg('disk', 14)}${esc(g.title)}</div>
      <div class="hb-desc">${esc(g.desc)}</div>
      <div class="hb-tables">${g.tables.map((t) => `<code title="点击复制表名">${esc(expandHb(t))}</code>`).join('')}</div>
      <div class="hb-cmds">${cmdsHtml}</div>`;
    card.querySelectorAll('.hb-cmd').forEach((el, i) => {
      const c = finalCmds[i];
      el.querySelector('[data-act=run]').onclick = () => {
        if (!state.connected) { toast('请先点击右上角【连接】按钮', 'err'); return; }
        runCommand(hbaseWrap(c.scan), { timeoutHint: 90000 });
      };
      el.querySelector('[data-act=copy]').onclick = () => copyText(hbaseWrap(c.scan), '命令已复制');
    });
    card.querySelectorAll('.hb-tables code').forEach((code) => {
      code.onclick = () => copyText(code.textContent, '表名已复制');
    });
    hc.appendChild(card);
  });
  if (!hc.children.length) hc.innerHTML = '<div class="empty-tip" style="padding:14px">无匹配的 HBase 表</div>';

  /* 服务速查 */
  const st = $('#svcTable');
  st.innerHTML = '';
  SERVICES.filter((s) => !kw || (s.name + s.zh + s.desc + s.group).toLowerCase().includes(kw)).forEach((s) => {
    const row = document.createElement('div');
    row.className = 'bill-row';
    row.innerHTML = `
      <span class="bzh">${esc(s.zh)}</span>
      <span class="bname" title="点击复制服务名">${esc(s.name)}</span>
      <span class="bdesc">${esc(s.desc)}</span>
      <button class="fact" data-act="ps" title="在服务器上查该服务进程是否在跑">查进程</button>`;
    row.querySelector('[data-act=ps]').onclick = () => {
      if (!state.connected) { toast('请先点击右上角【连接】按钮', 'err'); return; }
      runCommand('ps -ef | grep ' + q(s.name) + ' | grep -v grep | head -10');
    };
    row.querySelector('.bname').onclick = () => copyText(s.name, '服务名已复制');
    st.appendChild(row);
  });
  if (!st.children.length) st.innerHTML = '<div class="empty-tip" style="padding:14px">无匹配的服务</div>';
}

/* 常用命令速查：按服务器 / HDFS 分组展示命令 + 中文 + 作用，支持复制 / 执行 */
function renderCheatsheet() {
  const pane = $('#cheatPane');
  pane.innerHTML = '';
  CHEATSHEET.forEach((g) => {
    const title = document.createElement('div');
    title.className = 'cmd-group-title';
    title.innerHTML = `${esc(g.group)} <span class="tag">${g.items.length} 条</span>`;
    pane.appendChild(title);
    const table = document.createElement('div');
    table.className = 'bill-table';
    table.style.marginBottom = '10px';
    g.items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'bill-row';
      row.innerHTML = `
        <span class="bzh" style="min-width:72px">${esc(it.zh)}</span>
        <code class="cheat-cmd" title="点击复制命令">${esc(it.cmd)}</code>
        <span class="bdesc">${esc(it.desc)}</span>
        <button class="fact" data-act="copy" title="复制命令">复制</button>
        <button class="fact" data-act="run" title="在服务器上执行该命令">执行</button>`;
      row.querySelector('[data-act=copy]').onclick = () => copyText(it.cmd, '命令已复制');
      row.querySelector('[data-act=run]').onclick = () => {
        if (!state.connected) { toast('请先点击右上角【连接】按钮', 'err'); return; }
        runCommand(it.cmd);
      };
      row.querySelector('.cheat-cmd').onclick = () => copyText(it.cmd, '命令已复制');
      table.appendChild(row);
    });
    pane.appendChild(table);
  });
}

$('#billSearch').addEventListener('input', renderBillPane);
$('#billSuffixInput').addEventListener('change', (e) => {
  localStorage.setItem(BILL_SUFFIX_KEY, e.target.value.trim() || '597_2606');
  renderBillPane();
});
$('#hbMonthInput').addEventListener('change', (e) => {
  localStorage.setItem(HB_MONTH_KEY, e.target.value.trim() || '202410');
  renderBillPane();
});
$('#hbNsInput').addEventListener('change', (e) => {
  localStorage.setItem(HB_NS_KEY, e.target.value.trim() || 'ns_aibcp_dev');
  renderBillPane();
});

/* =====================================================================
 * 文件浏览器
 *====================================================================*/
async function refreshFiles() {
  if (!state.connected) return;
  const r = await post('/api/sftp/list', { path: state.cwd });
  if (!r.ok) { toast(r.error || '读取目录失败', 'err'); return; }
  state.cwd = r.path;
  renderFileList(r.items);
}

function renderFileList(items) {
  $('#curPath').textContent = state.cwd;
  renderCrumbs();
  const list = $('#fileList');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<div class="empty-tip">该目录为空</div>';
    return;
  }
  items.forEach((it) => {
    const row = document.createElement('div');
    row.className = 'file-row';
    const icon = it.isDir ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="#2563eb" stroke="#2563eb" stroke-width="1"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
      : it.isLink ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#0e8f8f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'
      : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa0a6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    row.innerHTML = `
      ${icon}
      <span class="fname ${it.isDir ? 'dir' : ''}" title="${esc(it.name)}${it.isDir ? '（双击进入）' : '（点击查看内容）'}">${esc(it.name)}</span>
      <span class="fsize">${it.isDir ? '—' : fmtSize(it.size)}</span>
      <span class="fdate">${fmtDate(it.mtime)}</span>
      <span class="facts">
        ${it.isDir ? '<button class="fact" data-act="enter">进入</button>' : '<button class="fact" data-act="view">查看</button>'}
        ${!it.isDir ? '<button class="fact" data-act="dl">下载</button>' : ''}
        <button class="fact del" data-act="del">删除</button>
      </span>`;
    const full = joinPath(state.cwd, it.name);
    if (it.isDir) {
      row.querySelector('.fname').ondblclick = () => { state.cwd = full; refreshFiles(); };
      const enterBtn = row.querySelector('[data-act=enter]');
      if (enterBtn) enterBtn.onclick = () => { state.cwd = full; refreshFiles(); };
      row.querySelector('.fname').onclick = (e) => { if (e.detail >= 2) { state.cwd = full; refreshFiles(); } };
    } else {
      row.querySelector('.fname').onclick = () => viewFile(full, it);
      const viewBtn = row.querySelector('[data-act=view]');
      if (viewBtn) viewBtn.onclick = () => viewFile(full, it);
      const dlBtn = row.querySelector('[data-act=dl]');
      if (dlBtn) dlBtn.onclick = () => downloadRemote(full);
    }
    const delBtn = row.querySelector('[data-act=del]');
    if (delBtn) delBtn.onclick = () => {
      const cmd = it.isDir ? 'rmdir ' + q(full) : 'rm ' + q(full);
      runDangerCommand(cmd, it.isDir ? '空文件夹' : '文件', full, '已删除，文件列表已刷新');
    };
    list.appendChild(row);
  });
}

function viewFile(path, it) {
  if (it && it.size > 1024 * 1024) {
    toast('文件较大（' + fmtSize(it.size) + '），自动改为查看最后 200 行');
    runCommand('tail -n 200 ' + q(path), { refreshable: true, buildCmd: () => 'tail -n 200 ' + q(path) });
    return;
  }
  runCommand('cat ' + q(path) + ' | head -c 262144', { refreshable: true, buildCmd: () => 'cat ' + q(path) + ' | head -c 262144' });
}

function downloadRemote(path) {
  const a = document.createElement('a');
  a.href = '/api/sftp/download?path=' + encodeURIComponent(path);
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('开始下载：' + path.split('/').pop(), 'ok');
}

function renderCrumbs() {
  const box = $('#crumbs');
  box.innerHTML = '';
  const parts = state.cwd === '~' ? [] : state.cwd.replace(/^\//, '').split('/');
  const mk = (label, path) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { state.cwd = path; refreshFiles(); };
    return b;
  };
  box.appendChild(mk('~', '~'));
  parts.filter(Boolean).forEach((p, i) => {
    const sep = document.createElement('span');
    sep.className = 'sep'; sep.textContent = '/';
    box.appendChild(sep);
    box.appendChild(mk(p, '/' + parts.slice(0, i + 1).join('/')));
  });
}

$('#btnUp').onclick = () => {
  if (state.cwd === '~') return;
  if (state.cwd === state.home || state.cwd === '/') { state.cwd = '~'; refreshFiles(); return; }
  const parent = state.cwd.replace(/\/[^/]+\/?$/, '') || '/';
  state.cwd = parent;
  refreshFiles();
};
$('#btnRefresh').onclick = refreshFiles;
$('#btnGoto').onclick = () => {
  const p = prompt('请输入要跳转的目录路径：', state.cwd);
  if (p && p.trim()) { state.cwd = p.trim(); refreshFiles(); }
};
$('#btnMkdir').onclick = () => {
  const name = prompt('新建文件夹名称（在 ' + state.cwd + ' 下）：');
  if (!name || !name.trim()) return;
  runCommand('mkdir ' + q(joinPath(state.cwd, name.trim())), { successMsg: '文件夹已创建', onDone: refreshFiles });
};
$('#btnTouch').onclick = () => {
  const name = prompt('新建文件名称（在 ' + state.cwd + ' 下）：');
  if (!name || !name.trim()) return;
  runCommand('touch ' + q(joinPath(state.cwd, name.trim())), { successMsg: '文件已创建', onDone: refreshFiles });
};

/* =====================================================================
 * HDFS 浏览器（hadoop fs 可视化，只读：进入 / 预览 / 下载）
 *====================================================================*/
const HDFS_CWD_KEY = 'wb_hdfs_cwd';
state.hdfsCwd = localStorage.getItem(HDFS_CWD_KEY) || '/apps/bill_cnos_jf_test/prep';

function hdfsJoin(dir, name) {
  return dir.replace(/\/+$/, '') + '/' + name;
}

async function refreshHdfs() {
  if (!state.connected) return;
  const listEl = $('#hdfsList');
  listEl.innerHTML = '<div class="empty-tip">正在读取 HDFS 目录…（首次约需 2~6 秒）</div>';
  const r = await post('/api/hdfs/list', { path: state.hdfsCwd });
  if (!r.ok) {
    listEl.innerHTML = '<div class="empty-tip">' + esc(r.error || '读取失败') + '</div>';
    toast(r.error || '读取 HDFS 目录失败', 'err');
    return;
  }
  localStorage.setItem(HDFS_CWD_KEY, state.hdfsCwd);
  renderHdfsList(r.items);
}

function hdfsCrumbs() {
  const box = $('#hdfsCrumbs');
  box.innerHTML = '';
  const parts = state.hdfsCwd.replace(/^\//, '').split('/').filter(Boolean);
  const mk = (label, path) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { state.hdfsCwd = path; refreshHdfs(); };
    return b;
  };
  box.appendChild(mk('/', '/'));
  parts.forEach((p, i) => {
    const sep = document.createElement('span');
    sep.className = 'sep'; sep.textContent = '/';
    box.appendChild(sep);
    box.appendChild(mk(p, '/' + parts.slice(0, i + 1).join('/')));
  });
}

function renderHdfsList(items) {
  $('#hdfsCurPath').textContent = state.hdfsCwd;
  hdfsCrumbs();
  const list = $('#hdfsList');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<div class="empty-tip">该 HDFS 目录为空</div>';
    return;
  }
  items.forEach((it) => {
    const row = document.createElement('div');
    row.className = 'file-row';
    const icon = it.isDir ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="#7c3aed" stroke="#7c3aed" stroke-width="1"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
      : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa0a6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    row.innerHTML = `
      ${icon}
      <span class="fname ${it.isDir ? 'dir' : ''}" title="${esc(it.path)}${it.isDir ? '（双击进入）' : '（点击查看前 256KB 内容）'}">${esc(it.name)}${it.isDir ? '/' : ''}</span>
      <span class="fsize">${it.isDir ? '—' : fmtSize(it.size)}</span>
      <span class="fdate">${esc(it.mtime || '')}</span>
      <span class="facts">
        ${it.isDir ? '<button class="fact" data-act="enter">进入</button>' : '<button class="fact" data-act="view">查看</button><button class="fact" data-act="dl">下载</button>'}
      </span>`;
    const full = it.path || hdfsJoin(state.hdfsCwd, it.name);
    if (it.isDir) {
      row.querySelector('.fname').ondblclick = () => { state.hdfsCwd = full; refreshHdfs(); };
      const enterBtn = row.querySelector('[data-act=enter]');
      if (enterBtn) enterBtn.onclick = () => { state.hdfsCwd = full; refreshHdfs(); };
      row.querySelector('.fname').onclick = (e) => { if (e.detail >= 2) { state.hdfsCwd = full; refreshHdfs(); } };
    } else {
      const view = () => runCommand('hadoop fs -cat ' + q(full) + ' | head -c 262144', { timeoutHint: 60000 });
      row.querySelector('.fname').onclick = view;
      const viewBtn = row.querySelector('[data-act=view]');
      if (viewBtn) viewBtn.onclick = view;
      const dlBtn = row.querySelector('[data-act=dl]');
      if (dlBtn) dlBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = '/api/hdfs/download?path=' + encodeURIComponent(full);
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
        toast('开始下载 HDFS 文件：' + it.name, 'ok');
      };
    }
    list.appendChild(row);
  });
}

$('#btnHdfsUp').onclick = () => {
  if (state.hdfsCwd === '/') return;
  const parent = state.hdfsCwd.replace(/\/[^/]+\/?$/, '') || '/';
  state.hdfsCwd = parent;
  refreshHdfs();
};
$('#btnHdfsRefresh').onclick = refreshHdfs;
$('#btnHdfsGoto').onclick = () => {
  const p = prompt('请输入要跳转的 HDFS 路径（以 / 开头）：', state.hdfsCwd);
  if (p && p.trim()) {
    const t = p.trim();
    if (!t.startsWith('/')) { toast('HDFS 路径必须以 / 开头', 'err'); return; }
    state.hdfsCwd = t;
    refreshHdfs();
  }
};
$('#hdfsQuick').addEventListener('click', (e) => {
  const b = e.target.closest('[data-hp]');
  if (!b) return;
  state.hdfsCwd = b.dataset.hp;
  refreshHdfs();
});

/* =====================================================================
 * 连接管理
 *====================================================================*/
function setConnected(on, cfg) {
  state.connected = on;
  if (cfg) state.config = cfg;
  const dot = $('#statusDot');
  const txt = $('#statusText');
  if (on) {
    dot.className = 'dot on';
    txt.innerHTML = `已连接 <b>${esc(cfg.host)}</b> · ${esc(cfg.username)}`;
    $('#btnConnect').innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg> 断开';
  } else {
    dot.className = 'dot off';
    txt.textContent = '未连接';
    state.hdfsLoaded = false;
    $('#hdfsList').innerHTML = '<div class="empty-tip">尚未连接服务器<br>请先点击右上角【连接】</div>';
    $('#btnConnect').innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> 连接';
  }
}

/* 断线感知：每 5 秒核对一次本地服务与 SSH 连接状态，避免界面显示与实际不符 */
let serviceDown = false;
setInterval(async () => {
  let r = null;
  try {
    r = await api('/api/status');
    serviceDown = false;
  } catch (e) {
    if (!serviceDown) {
      serviceDown = true;
      if (state.connected) {
        setConnected(false);
        toast('本地桥接服务已停止：请重新运行 start.bat 后刷新页面', 'err');
      }
    }
    return;
  }
  if (r && r.ok && state.connected && !r.connected) {
    setConnected(false);
    state.autoRefreshTimers.forEach((v) => clearInterval(v.timer));
    state.autoRefreshTimers.clear();
    toast('与服务器的连接已断开（网络波动或服务器重启），请重新点击【连接】', 'err');
  }
}, 5000);

async function doConnect(overrides) {
  const savedCfg = JSON.parse(localStorage.getItem('wb_conn_cfg') || '{}');
  const body = Object.assign({}, savedCfg, overrides || {});
  delete body.password0;
  $('#btnConnect').disabled = true;
  $('#statusText').textContent = '正在连接…';
  const r = await post('/api/connect', body);
  $('#btnConnect').disabled = false;
  if (!r.ok) {
    setConnected(false);
    const block = appendLogBlock('连接 ' + (body.host || '(默认)'));
    block.setError((r.error || '连接失败') + '\n\n排查建议：\n  1) 确认本机已连入服务器所在内网 / VPN\n  2) 确认服务器 IP、端口正确\n  3) 确认账号密码有效（可在【连接设置】中修改）');
    persistLog(block);
    toast('连接失败：' + (r.error || ''), 'err');
    return;
  }
  setConnected(true, r.config);
  state.home = r.home || '~';
  state.cwd = state.home;
  state.hdfsLoaded = false; // 重连后 HDFS 页重新加载
  toast('已连接 ' + r.config.host + '，文件目录已就绪', 'ok');
  switchTab('files');
  await refreshFiles();
  const block = appendLogBlock('连接 ' + r.config.host);
  block.setResult('<span class="hl-ok">✓ 连接成功</span>\n用户 ' + esc(r.config.username) + ' 已登录，主目录：' + esc(state.home) + '\n现在可以浏览【服务器文件】或【HDFS】目录了。', 0, 0);
  persistLog(block);
}

$('#btnConnect').onclick = async () => {
  if (state.connected) {
    await post('/api/disconnect');
    setConnected(false);
    toast('已断开连接');
    return;
  }
  doConnect();
};

/* 连接设置 */
$('#btnCmds').onclick = () => { switchCheatTab('srv'); $('#ovCmds').classList.add('show'); };

/* 快捷指令弹窗内的主 Tab：服务器（增删查）/ HDFS（速查表） */
function switchCheatTab(name) {
  $$('[data-cheat-tab]').forEach((b) => b.classList.toggle('active', b.dataset.cheatTab === name));
  $('#cmdPane').style.display = name === 'srv' ? '' : 'none';
  $('#cheatPane').style.display = name === 'hdfs' ? '' : 'none';
  if (name === 'hdfs') renderCheatsheet();
}
$('#cheatTabSrv').onclick = () => switchCheatTab('srv');
$('#cheatTabHdfs').onclick = () => switchCheatTab('hdfs');

$('#btnBilling').onclick = () => {
  $('#billSuffixInput').value = billSuffix();
  $('#hbMonthInput').value = hbMonth();
  $('#hbNsInput').value = hbNs();
  renderBillPane();
  $('#ovBilling').classList.add('show');
};

/* 话单工具：iframe 加载 cdr-tool，首次点击时才真正挂载 src，避免启动即加载 */
let cdrLoaded = false;
$('#btnCdr').onclick = () => {
  if (!cdrLoaded) {
    cdrLoaded = true;
    $('#cdrFrame').src = '/cdr/';
  }
  $('#ovCdr').classList.add('show');
};
$('#btnSettings').onclick = () => {
  const c = state.config || {};
  $('#cfgHost').value = c.host || '';
  $('#cfgPort').value = c.port || '';
  $('#cfgUser').value = c.username || '';
  $('#cfgPass').value = '';
  $('#ovSettings').classList.add('show');
};
$('#btnSaveCfg').onclick = async () => {
  const host = $('#cfgHost').value.trim();
  const port = $('#cfgPort').value.trim() || '22';
  const username = $('#cfgUser').value.trim();
  const password = $('#cfgPass').value;
  if (!host || !username) { toast('服务器地址和用户名不能为空', 'err'); return; }
  const cfg = { host, port: Number(port), username };
  if (password) cfg.password = password;
  localStorage.setItem('wb_conn_cfg', JSON.stringify(cfg));
  $('#ovSettings').classList.remove('show');
  if (state.connected) { await post('/api/disconnect'); setConnected(false); }
  doConnect();
};

/* =====================================================================
 * 顶部 / 底部交互
 *====================================================================*/
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-pane').forEach((p) => {
    const on = p.dataset.pane === name;
    p.classList.toggle('active', on);
    p.style.display = on ? 'flex' : 'none';
  });
  // chips 组与 datalist 自动补全跟随 Tab 切换：服务器文件 vs HDFS
  const SUGGESTS = {
    files: ['ls -lh', 'pwd', 'df -h', 'free -h', 'ps -ef | head -60', 'uptime', 'date', 'cat /etc/hostname', 'who && whoami', 'top -b -n 1 | head -20'],
    hdfs: ['hadoop fs -ls', 'hadoop fs -ls /apps', 'hadoop fs -du -h .', 'hadoop fs -df -h', 'hadoop fs -cat', 'hadoop fs -head 50', 'hadoop fs -tail 100', 'hadoop fs -count -q .', 'hadoop fs -ls /apps/bill_cnos_jf_test/prep'],
  };
  $$('#chips .chip-group').forEach((g) => { g.style.display = (g.dataset.for === name) ? '' : 'none'; });
  const dl = $('#cmdSuggest');
  if (dl) {
    dl.innerHTML = (SUGGESTS[name] || []).map((v) => '<option value="' + v.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">').join('');
  }
  // 输入框 placeholder 跟随场景
  const inp = $('#cmdInput');
  if (inp) {
    inp.placeholder = name === 'hdfs'
      ? '也可直接输入 HDFS 命令（↑↓ 切换历史）…'
      : '也可直接输入命令回车执行（↑↓ 切换历史）…';
  }
  if (name === 'hdfs' && state.connected && !state.hdfsLoaded) {
    state.hdfsLoaded = true;
    refreshHdfs();
  }
}
$$('.tab').forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });

/* 命令输入 */
async function submitInput() {
  const inp = $('#cmdInput');
  const cmd = inp.value.trim();
  if (!cmd) return;
  state.history.push(cmd);
  state.hIdx = state.history.length;
  inp.value = '';
  if (!state.connected) { toast('请先点击右上角【连接】按钮', 'err'); return; }
  if (/\brm\b/.test(cmd)) {
    // 输入的删除命令也走确认流程
    const m = cmd.match(/\brm\s+((?:["'][^"']*["'])|(?:\S+))\s*$/);
    const target = m ? m[1].replace(/^["']|["']$/g, '') : '（自由输入的删除命令）';
    runDangerCommand(cmd, '目标', target, null);
    return;
  }
  runCommand(cmd);
}
$('#btnRun').onclick = submitInput;
$('#cmdInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitInput(); }
  else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (state.hIdx > 0) { state.hIdx--; $('#cmdInput').value = state.history[state.hIdx] || ''; }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (state.hIdx < state.history.length - 1) { state.hIdx++; $('#cmdInput').value = state.history[state.hIdx] || ''; }
    else { state.hIdx = state.history.length; $('#cmdInput').value = ''; }
  }
});
$('#chips').addEventListener('click', (e) => {
  if (e.target.classList.contains('chip')) {
    $('#cmdInput').value = e.target.textContent;
    $('#cmdInput').focus();
  }
});

/* 清屏 / 导出 */
$('#btnClear').onclick = () => {
  state.autoRefreshTimers.forEach((v) => clearInterval(v.timer));
  state.autoRefreshTimers.clear();
  $('#logFlow').innerHTML = '';
  $('#emptyState').style.display = 'flex';
};
$('#btnExport').onclick = () => {
  const blocks = $$('#logFlow .log-block');
  if (!blocks.length) { toast('暂无日志可导出'); return; }
  const lines = ['# 远程服务器管理工作台 · 会话日志', '# 导出时间：' + new Date().toLocaleString('zh-CN'), '# 服务器：' + (state.config ? state.config.host + ' (' + state.config.username + ')' : '未连接'), ''];
  blocks.forEach((b) => {
    const time = b.querySelector('.log-time').textContent;
    const cmd = b.querySelector('.log-cmd').textContent;
    const badge = b.querySelector('[data-role=badge]').textContent;
    const out = b.querySelector('[data-role=out]').textContent || '';
    lines.push('──── [' + time + '] ' + cmd + ' （' + badge + '）');
    lines.push(out);
    lines.push('');
  });
  downloadBlob(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }), '服务器操作日志_' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-') + '.txt');
  toast('日志已导出到本地', 'ok');
};

/* 引导横幅 */
if (localStorage.getItem('wb_guide_closed') === '1') $('#guide').style.display = 'none';
$('#guideClose').onclick = () => {
  $('#guide').style.display = 'none';
  localStorage.setItem('wb_guide_closed', '1');
};

/* 模态通用关闭 */
$$('.overlay').forEach((ov) => {
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('show'); });
});
$$('[data-close]').forEach((b) => { b.onclick = () => $('#' + b.dataset.close).classList.remove('show'); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.overlay.show').forEach((ov) => ov.classList.remove('show'));
});

/* =====================================================================
 * 初始化
 *====================================================================*/
renderCmdPane();
$('#billSuffixInput').value = billSuffix();
$('#hbMonthInput').value = hbMonth();
$('#hbNsInput').value = hbNs();
renderBillPane();
// 默认 Tab 触发 chips/datalist 初始化
const defaultActiveTab = ($('.tab.active') || {}).dataset && ($('.tab.active') || {}).dataset.tab;
switchTab(defaultActiveTab || 'files');

(async function init() {
  const r = await api('/api/config');
  if (r.ok) {
    state.config = r.config;
    setConnected(false);
    $('#cfgHost').value = r.config.host;
  }
  const st = await api('/api/status');
  if (st.ok && st.connected) {
    setConnected(true, st.conn);
    const home = await post('/api/exec', { cmd: 'echo $HOME' });
    if (home.ok) { state.home = (home.stdout || '').trim().split('\n').pop() || '~'; state.cwd = state.home; }
    switchTab('files');
    await refreshFiles();
    toast('检测到已有连接：' + st.conn.host, 'ok');
  }
  // 恢复当天历史日志（刷新不丢）
  await restoreLogs();
})();
