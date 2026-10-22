import { $, $$, announce, ApiError, DialogController, createRequestGate, el, getJson as requestGet, postJson as requestPost, setText, initTabKeyboard } from '/shared/ui.js';

const API_PREFIX = location.pathname.startsWith('/cdr') ? '/cdr' : '';
const getJson = (path, options = {}) => requestGet(`${API_PREFIX}${path}`, options);
const postJson = (path, body, options = {}) => requestPost(`${API_PREFIX}${path}`, body, options);
document.body.classList.toggle('embedded', new URLSearchParams(location.search).get('embedded') === '1');
const state = { session: { loaded: false, revision: 0 }, page: 1, pageSize: 100, totalPages: 1, bizType: '', filters: [], records: [], fields: [], pendingEdit: null, pendingConfirm: null, gate: createRequestGate(), previewGate: createRequestGate(), batchPreview: null, generateImpact: null, busy: false, previewing: false, editDirty: false };
const editDialog = new DialogController($('#editDialog'));
const confirmDialog = new DialogController($('#confirmDialog'));
const operationsDialog = new DialogController($('#operationsDialog'));
const cdrDialogs = { editDialog, confirmDialog, operationsDialog };
initTabKeyboard();

function toast(message, tone = '') { const node = el('div', { class: `toast ${tone}`, text: message }); $('#cdrToast').append(node); setTimeout(() => node.remove(), 3600); }
function showStatus(id, message, tone = 'info') { announce($(`#${id}`), message, tone); }
function currentRevision() { return Number(state.session.revision || 0); }
function openConfirm(message, action) {
  if (state.busy) return;
  setText($('#confirmMessage'), message); state.pendingConfirm = action; confirmDialog.open($('#btnConfirm'));
}
function requestEditClose() {
  if (state.busy) return;
  if (state.editDirty) openConfirm('这条记录有尚未保存的编辑，放弃这些编辑并关闭？', () => { state.editDirty = false; editDialog.close(); });
  else editDialog.close();
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-close]');
  if (!button || state.busy) return;
  if (button.dataset.close === 'editDialog') requestEditClose();
  else cdrDialogs[button.dataset.close]?.close();
});
$('#editDialog').addEventListener('cancel', event => { event.preventDefault(); event.stopImmediatePropagation(); requestEditClose(); }, true);
$('#confirmDialog').addEventListener('close', () => { state.pendingConfirm = null; });
$('#btnConfirm').addEventListener('click', async () => {
  const action = state.pendingConfirm; state.pendingConfirm = null; confirmDialog.close();
  if (action && !state.busy) await action();
});
function setOperation(kind) {
  $$('[data-operation]').forEach(tab => { const active = tab.dataset.operation === kind; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; });
  $$('[data-operation-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.operationPanel !== kind));
}
$$('[data-operation]').forEach(tab => tab.addEventListener('click', () => setOperation(tab.dataset.operation)));
$$('[data-open-operation]').forEach(button => button.addEventListener('click', () => { setOperation(button.dataset.openOperation); operationsDialog.open($(`[data-operation="${button.dataset.openOperation}"]`)); }));

function invalidatePreview(message = '') {
  state.previewGate.cancel(); state.batchPreview = null; state.previewing = false;
  $('#batchPreview').replaceChildren();
  if (message) showStatus('batchStatus', message, 'warning');
  controls();
}
function controls() {
  const loaded = Boolean(state.session.loaded), busy = state.busy;
  for (const id of ['btnLoad', 'btnReloadFiles', 'fileSelect']) $(`#${id}`).disabled = busy;
  $('#btnUndo').disabled = busy || !state.session.can_undo;
  $('#btnExport').disabled = busy || !loaded;
  $('#btnSaveEdit').disabled = busy || !state.pendingEdit;
  $('#btnBatchPreview').disabled = busy || !loaded || state.previewing;
  $('#btnBatchApply').disabled = busy || state.previewing || !state.batchPreview?.result.preview?.length;
  $('#btnAddFilter').disabled = busy || !loaded;
  $('#btnGeneratePreview').disabled = busy || !loaded;
  const impact = state.generateImpact;
  $('#btnGenerate').disabled = busy || !loaded || !impact || impact.revision !== currentRevision() || !impact.indexes.length || impact.copies < 1 || !Number.isInteger(impact.copies) || impact.total > (state.session.max_records || 100000);
  $$('[data-open-operation]').forEach(button => { button.disabled = busy || (button.dataset.openOperation !== 'history' && !loaded); });
  for (const root of [$('#batchFilters'), $('#operation-batch'), $('#operation-generate'), $('#editFields')]) $$('input,select', root).forEach(input => { input.disabled = busy; });
  $$('[data-close]').forEach(button => { button.disabled = busy; });
}
async function handleError(error, id = 'loadStatus') {
  if (error.code === 'REVISION_CONFLICT' || error.status === 409) {
    invalidatePreview(); if (id === 'editStatus') state.pendingEdit = null; showStatus(id, id === 'editStatus' ? '会话版本已变化，请关闭并重新打开记录后编辑。' : '会话版本已变化，请重新核对并预览。', 'warning'); await refreshSession();
  } else showStatus(id, error.message || '请求失败', 'error');
}
async function mutate(buttonId, statusId, action) {
  if (state.busy) return;
  state.busy = true; state.previewGate.cancel(); state.previewing = false; controls();
  const button = $(`#${buttonId}`), label = button.textContent; button.textContent = '处理中…';
  try { await action(); }
  catch (error) { await handleError(error, statusId); }
  finally { state.busy = false; button.textContent = label; controls(); }
}
function renderSession() {
  setText($('#sessionState'), state.session.loaded ? `${state.session.filename} · ${state.session.total_records} 条` : '未加载文件');
  setText($('#revisionText'), `revision ${state.session.revision ?? '—'}`);
  setText($('#statTotal'), state.session.loaded ? state.session.total_records : '—');
  setText($('#statExport'), !state.session.loaded ? '未加载' : state.session.dirty ? '有未导出修改' : '已导出');
  $('#statExport').classList.toggle('dirty', Boolean(state.session.dirty)); controls();
}
async function refreshSession({ reloadFiles = true } = {}) {
  try {
    const session = await getJson('/api/session');
    if (session.revision !== state.session.revision || session.filename !== state.session.filename) { invalidatePreview(); state.generateImpact = null; }
    state.session = session; renderSession();
    if (reloadFiles) await loadFiles();
    if (state.session.loaded) { $('#fileSelect').value = state.session.filename || ''; await refreshRecords(); }
    await loadExportHistory();
  } catch (error) { showStatus('loadStatus', error.message, 'error'); }
}
async function loadFiles() {
  const result = await getJson('/api/files'), select = $('#fileSelect'), selected = select.value;
  select.replaceChildren(...(result.files || []).map(file => el('option', { value: file.name, text: `${file.name} · ${file.size_mb} MiB · ${file.mtime}` })));
  if (!result.files?.length) select.append(el('option', { value: '', text: '源目录中没有可加载的话单文件' }));
  if (selected && [...select.options].some(option => option.value === selected)) select.value = selected;
}
$('#btnReloadFiles').addEventListener('click', async () => { try { await loadFiles(); showStatus('loadStatus', '文件列表已刷新', 'success'); } catch (error) { await handleError(error); } });
$('#btnLoad').addEventListener('click', () => {
  const filename = $('#fileSelect').value;
  if (!filename) return showStatus('loadStatus', '请先选择源文件', 'warning');
  const load = () => mutate('btnLoad', 'loadStatus', async () => {
    state.gate.cancel(); invalidatePreview();
    const result = await postJson('/api/load', { filename });
    state.page = 1; state.filters = []; state.bizType = ''; $('#quickFilter').value = ''; $('#bizSelect').value = ''; $('#batchFilters').replaceChildren();
    showStatus('loadStatus', `已加载 ${result.total_records} 条记录`, 'success');
    await refreshSession();
  });
  if (state.session.dirty) openConfirm(`当前 ${state.session.filename} 有未导出修改。加载 ${filename} 将替换当前会话，是否继续？`, load);
  else void load();
});

function filterRow(initial = {}) {
  const field = el('select', { class: 'wb-field', 'aria-label': '筛选字段' });
  state.fields.forEach(name => field.append(el('option', { value: name, text: name }))); if (initial.field) field.value = initial.field;
  const op = el('select', { class: 'wb-field', 'aria-label': '筛选运算符' });
  for (const [value, label] of [['eq', '等于'], ['contains', '包含'], ['ne', '不等于'], ['gt', '大于'], ['lt', '小于']]) op.append(el('option', { value, text: label }));
  op.value = initial.op || 'eq';
  const value = el('input', { class: 'wb-field', 'aria-label': '筛选值', value: initial.value ?? '' });
  const remove = el('button', { class: 'wb-button', type: 'button', text: '移除', on: { click: () => { if (!state.busy) { row.remove(); invalidatePreview('条件已变化，请重新预览'); } } } });
  const row = el('div', { class: 'filter-row' }, field, op, value, remove);
  row.getValue = () => ({ field: field.value, op: op.value, value: value.value }); return row;
}
function readFilterRows() { return $$('#batchFilters .filter-row').map(row => row.getValue()).filter(item => item.field && item.value !== ''); }
$('#btnAddFilter').addEventListener('click', () => { if (state.busy) return; $('#batchFilters').append(filterRow()); invalidatePreview('条件已变化，请重新预览'); });
$('#operation-batch').addEventListener('input', () => invalidatePreview('条件已变化，请重新预览'));
$('#operation-batch').addEventListener('change', () => invalidatePreview('条件已变化，请重新预览'));

async function refreshRecords() {
  if (!state.session.loaded) return;
  const request = state.gate.next();
  $('#recordBody').replaceChildren(el('tr', {}, el('td', { class: 'table-empty', colspan: 6, text: '正在读取记录…' })));
  try {
    const params = new URLSearchParams({ page: String(state.page), page_size: String(state.pageSize) });
    if (state.bizType) params.set('biz_type', state.bizType); if (state.filters.length) params.set('filters', JSON.stringify(state.filters));
    const result = await getJson(`/api/records?${params}`, { signal: request.signal }); if (!request.isCurrent()) return;
    state.records = result.records || []; state.fields = result.fields || []; state.totalPages = result.total_pages || 1;
    renderRecords(result); renderBizTypes(result.biz_filter_counts || {});
  } catch (error) {
    if (!request.isCurrent() || error.code === 'REQUEST_ABORTED') return;
    $('#recordBody').replaceChildren(el('tr', {}, el('td', { class: 'table-empty', colspan: 6, text: error.message }))); await handleError(error, 'recordsSummary');
  }
}
function renderBizTypes(counts) {
  const select = $('#bizSelect'); select.replaceChildren(el('option', { value: '', text: '全部类型' }));
  Object.entries(counts).forEach(([value, count]) => select.append(el('option', { value, text: `${value} · ${count} 条` }))); select.value = state.bizType;
}
function renderRecords(result) {
  const columns = (result.common_fields?.length ? result.common_fields : result.fields || []).slice(0, 5);
  $('#recordHead').replaceChildren(el('tr', {}, ...columns.map(name => el('th', { scope: 'col', text: name })), el('th', { scope: 'col', text: '操作' })));
  const body = $('#recordBody'); body.replaceChildren();
  if (!result.records?.length) body.append(el('tr', {}, el('td', { class: 'table-empty', colspan: columns.length + 1, text: '没有匹配记录' })));
  for (const record of result.records || []) body.append(el('tr', {}, ...columns.map(name => el('td', { text: record[name] == null ? '—' : record[name], title: String(record[name] ?? '') })), el('td', {}, el('button', { class: 'wb-button ghost', type: 'button', text: '编辑', on: { click: () => openEdit(record.idx) } }))));
  setText($('#recordsSummary'), `${result.biz_name || '全部类型'} · 匹配 ${result.total} 条 · 每页 ${result.page_size}`);
  setText($('#pageText'), `第 ${result.page} / ${result.total_pages} 页`);
  $('#btnPrev').disabled = result.page <= 1; $('#btnNext').disabled = result.page >= result.total_pages;
  setText($('#statBiz'), Object.keys(result.biz_filter_counts || {}).length); setText($('#statFields'), result.fields?.length || 0);
}
$('#btnApplyFilter').addEventListener('click', () => {
  const raw = $('#quickFilter').value.trim(); let filters = [];
  if (raw) { const match = raw.match(/^([A-Za-z0-9_]+)\s*(?:=|包含)\s*(.+)$/); if (!match) return toast('快速筛选格式：FIELD=value', 'warn'); filters = [{ field: match[1], op: 'contains', value: match[2] }]; }
  state.filters = filters; state.page = 1; void refreshRecords();
});
$('#quickFilter').addEventListener('keydown', event => { if (event.key === 'Enter') $('#btnApplyFilter').click(); });
$('#btnClearFilter').addEventListener('click', () => { $('#quickFilter').value = ''; state.filters = []; state.bizType = ''; state.page = 1; void refreshRecords(); });
$('#bizSelect').addEventListener('change', () => { state.bizType = $('#bizSelect').value; state.page = 1; void refreshRecords(); });
$('#btnRefreshRecords').addEventListener('click', () => void refreshRecords());
$('#btnPrev').addEventListener('click', () => { state.page = Math.max(1, state.page - 1); void refreshRecords(); });
$('#btnNext').addEventListener('click', () => { state.page = Math.min(state.totalPages, state.page + 1); void refreshRecords(); });

async function openEdit(idx) {
  if (state.busy) return;
  try {
    const result = await getJson(`/api/record/${idx}`); state.pendingEdit = { idx, record: result.record, revision: currentRevision() }; state.editDirty = false;
    const root = $('#editFields'); root.replaceChildren();
    for (const [field, value] of Object.entries(result.record || {})) root.append(el('label', { class: 'edit-field' }, el('span', { class: 'wb-label', text: field }), el('input', { class: 'wb-field', value: value == null ? '' : value, 'aria-label': field })));
    setText($('#editStatus'), ''); controls(); editDialog.open(root.querySelector('input'));
  } catch (error) { toast(error.message, 'err'); }
}
$('#editFields').addEventListener('input', () => { state.editDirty = true; });
$('#btnSaveEdit').addEventListener('click', () => {
  if (!state.pendingEdit) return;
  const selected = state.pendingEdit;
  const updates = {}; $$('#editFields .edit-field').forEach(label => { updates[label.querySelector('.wb-label').textContent] = label.querySelector('input').value; });
  void mutate('btnSaveEdit', 'editStatus', async () => {
    const result = await postJson(`/api/record/${selected.idx}`, { updates, expected_revision: selected.revision });
    if (!result.ok) throw new ApiError(result.error?.message || '保存失败');
    state.editDirty = false; state.pendingEdit = null; editDialog.close(); toast('记录已保存', 'ok'); await refreshSession();
  });
});
$('#btnBatchPreview').addEventListener('click', async () => {
  if (state.busy || state.previewing) return;
  const filters = readFilterRows(), field = $('#batchField').value.trim(), value = $('#batchValue').value;
  if (!filters.length) return showStatus('batchStatus', '批量修改必须先添加筛选条件', 'warning');
  if (!field || value === '') return showStatus('batchStatus', '修改字段和新值不能为空', 'warning');
  invalidatePreview(); const request = state.previewGate.next(); state.previewing = true; controls();
  const payload = { filters, updates: { [field]: value }, dry_run: true, expected_revision: currentRevision() };
  try {
    const result = await postJson('/api/batch-update', payload, { signal: request.signal }); if (!request.isCurrent()) return;
    state.batchPreview = { payload, revision: currentRevision(), result };
    const table = el('table', {}, el('thead', {}, el('tr', {}, ...['记录 idx', '字段', '原值', '新值'].map(text => el('th', { text })))), el('tbody', {}, ...(result.preview || []).map(item => el('tr', {}, ...[item.idx, item.field, item.old, item.new].map(value => el('td', { text: value == null ? 'NULL' : String(value) }))))));
    $('#batchPreview').replaceChildren(table);
    showStatus('batchStatus', `匹配 ${result.matched} 条 · 预览 ${result.preview?.length || 0} 处 · 跳过 ${result.skipped_count || 0} 处`, 'success');
  } catch (error) { if (request.isCurrent()) await handleError(error, 'batchStatus'); }
  finally { if (request.isCurrent()) { state.previewing = false; controls(); } }
});
$('#btnBatchApply').addEventListener('click', () => {
  const preview = state.batchPreview;
  if (!preview || preview.revision !== currentRevision()) return invalidatePreview('预览已过期，请重新预览');
  void mutate('btnBatchApply', 'batchStatus', async () => {
    state.batchPreview = null;
    const result = await postJson('/api/batch-update', { ...preview.payload, dry_run: false, expected_revision: preview.revision });
    showStatus('batchStatus', `已应用 ${result.applied} 处修改`, 'success'); await refreshSession();
  });
});
function computeGenerateImpact() {
  const raw = $('#templateIdxs').value.trim();
  const valid = raw && raw.split(',').every(value => /^\d+$/.test(value.trim()));
  const indexes = valid ? [...new Set(raw.split(',').map(value => Number(value.trim())))] : [];
  const copies = Number($('#copies').value), added = indexes.length * copies, total = Number(state.session.total_records || 0) + added;
  state.generateImpact = { indexes, copies, added, total, revision: currentRevision() };
  setText($('#generateImpact'), valid ? `将新增 ${added} 条，最终总数 ${total} / ${state.session.max_records || 100000}` : '请输入有效的模板记录 idx，以逗号分隔'); controls();
}
$('#btnGeneratePreview').addEventListener('click', computeGenerateImpact);
$('#templateIdxs').addEventListener('input', computeGenerateImpact); $('#copies').addEventListener('input', computeGenerateImpact);
$('#btnGenerate').addEventListener('click', () => {
  const impact = state.generateImpact; if (!impact || $('#btnGenerate').disabled) return;
  openConfirm(`将新增 ${impact.added} 条记录，完成后总数 ${impact.total} 条，是否继续？`, () => mutate('btnGenerate', 'generateStatus', async () => {
    const result = await postJson('/api/batch-generate', { template_idxs: impact.indexes, copies_per_template: impact.copies, expected_revision: impact.revision });
    toast(`已生成 ${result.generated} 条`, 'ok'); await refreshSession();
  }));
});
$('#btnUndo').addEventListener('click', () => void mutate('btnUndo', 'loadStatus', async () => { const result = await postJson(`/api/undo?expected_revision=${currentRevision()}`, {}); toast(result.desc || '已撤销', 'ok'); await refreshSession(); }));
$('#btnExport').addEventListener('click', () => void mutate('btnExport', 'exportStatus', async () => { const result = await postJson('/api/export', { expected_revision: currentRevision() }); showStatus('exportStatus', `导出完成：${result.filename} · ${result.record_count} 条`, 'success'); await refreshSession(); }));
async function loadExportHistory() {
  try {
    const result = await getJson('/api/export-history');
    $('#exportHistory').replaceChildren(...(result.items || []).slice(0, 10).map(item => el('div', { class: 'history-item', text: `${item.name} · ${item.size_mb} MiB` })));
    if (!result.items?.length) setText($('#exportHistory'), '尚无导出记录');
  } catch (error) { setText($('#exportHistory'), `导出记录读取失败：${error.message}`); }
}
window.addEventListener('beforeunload', event => { if (state.session.dirty || state.editDirty || state.busy) { event.preventDefault(); event.returnValue = ''; } });
controls();
(async function init() { try { await loadFiles(); await refreshSession({ reloadFiles: false }); } catch (error) { await handleError(error); } })();
