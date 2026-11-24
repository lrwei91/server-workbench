import { $, el, announce, postJson } from '/shared/ui.js';

const PREFIX = 'rate:SERV_SNAPSHOT:';
const request = async (path, body) => (await postJson('/api/redis-snapshot/' + path, body, { timeout: 65000 })).result;
const displayValue = (row) => row.value === null ? `二进制或超长内容（${row.size} 字节，只读）` : row.value || '（空值）';
const actionButton = (text, click, danger = false) => el('button', {
  type: 'button', class: 'wb-button' + (danger ? ' danger' : ''), text, on: { click },
});

export function initRedisSnapshots({ confirm, isWriting, acquireWrite, releaseWrite, openDialog, closeDialog, getTarget }) {
  const form = $('#snapshotSearch'), query = $('#snapshotQuery'), keysRoot = $('#snapshotKeys'),
    detailRoot = $('#snapshotDetail'), moreKeys = $('#snapshotMoreKeys'), addKey = $('#snapshotAddKey'),
    editor = $('#snapshotEditor'), editorKey = $('#snapshotEditorKey'), editorType = $('#snapshotEditorType'),
    editorValue = $('#snapshotEditorValue');
  const status = (message, tone) => announce($('#snapshotState'), message, tone);
  let busy = false, target, keys = [], search, selected, edit;

  function controls() {
    const disabled = busy || isWriting();
    for (const control of [...form.elements, addKey, moreKeys, ...keysRoot.querySelectorAll('button'), ...detailRoot.querySelectorAll('button')]) {
      control.disabled = disabled;
    }
    moreKeys.classList.toggle('hidden', !search || search.cursor === '0' || query.value !== search.query);
  }
  function renderKeys() {
    keysRoot.replaceChildren(...keys.map((key) => el('li', {},
      el('button', {
        text: key, type: 'button', class: 'wb-button',
        'aria-pressed': String(selected?.key === key), on: { click: () => void loadKey(key) },
      }))));
  }
  function renderDetail() {
    detailRoot.replaceChildren();
    if (!selected) {
      detailRoot.append(el('p', { class: 'query-help', text: '选择一个键查看内容。' })); return;
    }
    const { key, type, ttl, row, count, members, cursor } = selected;
    detailRoot.append(el('h3', { text: key }));
    if (type === 'none') {
      detailRoot.append(el('p', { text: '该键已不存在。' })); return;
    }
    detailRoot.append(el('p', { class: 'query-help', text: `${type.toUpperCase()} · ${ttl === -1 ? '永久' : `查询时剩余 ${Math.ceil(ttl / 1000)} 秒`}${type === 'set' ? ` · ${count} 个成员` : ''}` }));
    const actions = el('div', { class: 'snapshot-actions' }, actionButton('刷新内容', () => void loadKey(key)));
    detailRoot.append(actions);
    if (type === 'string') {
      detailRoot.append(el('pre', { text: displayValue(row) }));
      if (row.value !== null) actions.append(actionButton('编辑值', () => openEditor({ action: 'set-string', key, previous: row.value })));
    } else if (type === 'set') {
      actions.append(actionButton('插入行', () => openEditor({ action: 'add-member', key })));
      const list = el('ul', { class: 'snapshot-members' }, members.map((row) => {
        const item = el('li', {}, el('pre', { text: displayValue(row) }));
        if (row.value !== null) item.append(el('div', { class: 'snapshot-actions' },
          actionButton('编辑', () => openEditor({ action: 'replace-member', key, previous: row.value })),
          actionButton('删除', () => deleteMember(key, row.value), true)));
        return item;
      }));
      detailRoot.append(list);
      if (!members.length) detailRoot.append(el('p', { class: 'query-help', text: '本批没有成员，可继续读取。' }));
      if (cursor !== '0') detailRoot.append(actionButton('下一批成员', () => void loadKey(key, cursor)));
    } else detailRoot.append(el('p', { class: 'query-help', text: '当前版本仅编辑 STRING 和 SET。' }));
  }
  async function scan(reset) {
    if (busy || isWriting()) return;
    const term = query.value;
    if (!reset && (!search || search.query !== term || search.cursor === '0')) return;
    if (reset) { search = null; keys = []; renderKeys(); }
    busy = true; controls(); status('正在扫描快照键…');
    try {
      const result = await request('search', { query: term, cursor: reset ? '0' : search.cursor });
      target = result.target; search = { query: term, cursor: result.cursor };
      keys = result.keys; renderKeys();
      status(`${target.host}:${target.port} / DB${target.db} · 本批 ${keys.length} 个键${result.cursor === '0' ? ' · 扫描结束' : ' · 还有后续批次'}`, 'success');
    } catch (error) { status(error.message, 'error'); }
    finally { busy = false; controls(); }
  }
  async function readKey(key, cursor = '0') {
    selected = await request('detail', { key, cursor });
    renderKeys(); renderDetail();
  }
  async function loadKey(key, cursor) {
    if (busy || isWriting()) return;
    busy = true; controls(); status('正在读取键内容…');
    try { await readKey(key, cursor); status('键内容已刷新', 'success'); }
    catch (error) { status(error.message, 'error'); }
    finally { busy = false; controls(); }
  }
  const titles = { create: '添加新键', 'set-string': '编辑值', 'add-member': '插入行', 'replace-member': '编辑成员' };
  function syncEditor() {
    const member = !['set-string', 'create'].includes(edit?.action) || (edit.action === 'create' && editorType.value === 'set');
    $('#snapshotEditorValueLabel').textContent = member ? '成员（必填）' : '值';
    editorValue.required = member;
  }
  function openEditor(data) {
    if (busy || isWriting()) return;
    edit = data; const creating = data.action === 'create';
    $('#snapshotEditorTitle').textContent = titles[data.action];
    $('#snapshotEditorOptions').classList.toggle('hidden', !creating);
    editorKey.setCustomValidity(''); editorKey.value = data.key || PREFIX; editorKey.readOnly = !creating;
    editorType.value = 'string'; editorValue.value = data.previous ?? ''; syncEditor();
    openDialog('snapshotDialog', creating ? editorKey : editorValue);
  }
  function confirmMutation(data, message) {
    const redis = target || getTarget();
    const destination = redis?.host ? `${redis.host}:${redis.port} / DB${redis.db}` : '当前配置的 Redis DB';
    confirm(data.key, `目标：${destination}。 ${message}`, () => mutate(data));
  }
  async function mutate(data) {
    if (busy || !acquireWrite()) return;
    busy = true; controls(); status('正在写入 Redis…');
    try {
      const result = await request('mutate', { ...data, confirmed: true });
      try {
        if (result.removed) keys = keys.filter((key) => key !== data.key);
        await readKey(data.key);
        status(result.removed ? '最后一个成员已删除，键已移除。' :
          data.action === 'create' ? '键已创建并回读；重新查询可更新键列表。' : '操作成功，内容已刷新。', 'success');
      } catch (error) {
        selected = null; renderKeys(); renderDetail();
        status(`写入已返回成功，但刷新失败：${error.message}。请重新查询核对。`, 'error');
      }
    } catch (error) { status(`${error.message} · 请刷新核对后再操作`, 'error'); }
    finally { busy = false; releaseWrite(); controls(); }
  }
  function deleteMember(key, previous) {
    if (busy || isWriting()) return;
    confirmMutation({ key, previous, action: 'remove-member' },
      `删除所选成员（${previous ? JSON.stringify(previous.slice(0, 120)) + (previous.length > 120 ? '…' : '') : '空值'}）。若为最后一个成员，Redis 将移除整个键。`);
  }
  form.addEventListener('submit', (event) => { event.preventDefault(); void scan(true); });
  query.addEventListener('input', controls);
  moreKeys.addEventListener('click', () => void scan(false));
  addKey.addEventListener('click', () => openEditor({ action: 'create' }));
  editorType.addEventListener('change', syncEditor);
  editor.addEventListener('submit', (event) => {
    event.preventDefault(); if (!edit || busy || isWriting()) return;
    const creating = edit.action === 'create';
    const data = { ...edit, key: editorKey.value, value: editorValue.value };
    if (creating) data.type = editorType.value;
    editorKey.setCustomValidity(creating && (!data.key.startsWith(PREFIX) || data.key.length === PREFIX.length) ? '请输入快照键前缀和后缀' : '');
    if (!editorKey.reportValidity()) return;
    closeDialog('snapshotDialog');
    confirmMutation(data, creating ? `创建 ${data.type.toUpperCase()} 键，永久有效，已有键不覆盖。` : `${titles[data.action]}，保留原键 TTL。`);
  });
  editorKey.addEventListener('input', () => editorKey.setCustomValidity(''));
  document.addEventListener('redis:write-state', controls);
  renderDetail(); controls();
}
