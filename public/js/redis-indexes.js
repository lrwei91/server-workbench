import { $, el, postJson, createRequestGate } from '/shared/ui.js';

export function initRedisIndexes({ confirm, openConnections, isWriting, acquireWrite, releaseWrite }) {
  const gate = createRequestGate();
  let preview = null, loading = false, writing = false;
  const state = (text, tone = '') => { $('#redisIndexState').textContent = text; $('#redisIndexState').dataset.tone = tone; };
  const resultRoot = $('#redisIndexResults');
  const targetText = (result) => result.target ? `${result.target.host}:${result.target.port} / DB${result.target.db}` : '当前配置的 Redis DB';
  function controls() {
    $('#btnRedisIndexLookup').disabled = loading || writing || isWriting();
    $('#btnRedisIndexPreview').disabled = loading || writing || isWriting() || !$('#redisIndexCandidate').value;
    $('#btnRedisIndexApply').disabled = loading || writing || isWriting() || !preview?.canApply;
    $('#btnRedisIndexCancel').classList.toggle('hidden', !loading);
    for (const id of ['redisIndexType', 'redisIndexInput', 'redisIndexCandidate']) $(`#${id}`).disabled = writing || isWriting();
  }
  function invalidate(clearCandidates = true) {
    gate.cancel(); preview = null; loading = false; resultRoot.replaceChildren();
    if (clearCandidates) $('#redisIndexCandidate').replaceChildren(el('option', { value: '', text: '先查询实例' }));
    controls(); state('请输入实例 ID 或手机号，先查询预览；已有 key 保留。');
  }
  function render(result) {
    resultRoot.replaceChildren(el('p', { class: 'query-help', text: `${targetText(result)} · ${result.key} · 待新增 ${result.missingKeys} 个缺失 key · 新 key 永久有效（无 TTL）` }),
      el('p', { class: 'query-help', text: result.scope }));
    for (const warning of result.warnings) resultRoot.append(el('p', { class: 'redis-sync-warning', text: warning }));
    resultRoot.append(el('div', { class: 'redis-sync-table-wrap' }, el('table', { class: 'redis-sync-table' },
      el('thead', {}, el('tr', {}, ['目标 key / 来源字段', '状态 / 处理', '解码后的成员（核对区号和实例）'].map((text) => el('th', { text })))),
      el('tbody', {}, result.groups.map((group) => el('tr', {},
        el('td', { text: `${group.key} (${group.field})` }),
        el('td', { text: group.status === 'missing' ? '缺失：待新增 SET' : group.status === 'created' ? '本次新增：成员回读已验证' : `已存在 ${group.type}：保持原样（未核对成员）` }),
        el('td', {}, group.members.map((member) => el('pre', { class: 'redis-index-member', text: `{"areaCode":${JSON.stringify(member.areaCode)},"servId":${member.servId},${JSON.stringify(group.field)}:${JSON.stringify(member[group.field])}}` })))))))));
  }
  async function readPreview(request) {
    const id = $('#redisIndexCandidate').value;
    const response = await postJson('/api/redis-index/preview', { productInstanceId: id }, { signal: request.signal, timeout: 65000 });
    if (!request.isCurrent()) return;
    preview = response.result; render(preview);
    state(preview.canApply ? '预览完成，请核对字段映射及所选实例；确认后仅创建缺失 key。' : '没有待新增 key；已有 key 不做覆盖或成员修复。', preview.canApply ? 'warning' : 'success');
  }
  document.addEventListener('redis:write-state', controls);
  $('#redisIndexForm').addEventListener('submit', async (event) => {
    event.preventDefault(); if (writing || loading || isWriting()) return;
    const value = $('#redisIndexInput').value.trim(), inputType = $('#redisIndexType').value;
    if (!(inputType === 'instance' ? /^(?:rate:cpp:)?\d{1,20}$/ : /^\d{1,20}$/).test(value)) { state('请输入有效实例 ID 或手机号', 'error'); return; }
    invalidate(); const request = gate.next(); loading = true; controls(); state('正在定位实例，仅读取数据…');
    try {
      const response = await postJson('/api/redis-index/lookup', { inputType, value }, { signal: request.signal, timeout: 65000 });
      if (!request.isCurrent()) return;
      const { candidates, source } = response.result;
      $('#redisIndexCandidate').replaceChildren(el('option', { value: '', text: candidates.length ? '请选择实例' : '未找到实例' }),
        ...candidates.map((item) => el('option', { value: item.productInstanceId, text: item.productInstanceId })));
      if (candidates.length === 1) { $('#redisIndexCandidate').value = candidates[0].productInstanceId; await readPreview(request); }
      else state(`${source} · 找到 ${candidates.length} 个实例${candidates.length ? '，请选择一个实例再预览；不自动选择。' : '，请核对号码或直接输入实例 ID。'}`);
    } catch (error) { if (request.isCurrent()) state(error.message, 'error'); }
    finally { if (request.isCurrent()) { loading = false; controls(); } }
  });
  $('#btnRedisIndexPreview').addEventListener('click', async () => {
    if (loading || writing || isWriting() || !$('#redisIndexCandidate').value) return;
    invalidate(false); const request = gate.next(); loading = true; controls(); state('正在读取 CPP 与索引状态…');
    try { await readPreview(request); }
    catch (error) { if (request.isCurrent()) state(error.message, 'error'); }
    finally { if (request.isCurrent()) { loading = false; controls(); } }
  });
  $('#btnRedisIndexApply').addEventListener('click', () => {
    const selected = preview;
    if (!selected?.canApply || loading || writing || isWriting()) return;
    confirm(selected.groups.filter((group) => group.status === 'missing').map((group) => group.key).join('\n'),
      `目标 ${targetText(selected)}：从 ${selected.key} 的根产品字段创建 ${selected.missingKeys} 个缺失 SET key，按 LZ4/Kryo 二进制编码并回读验证。新 key 无 TTL；已有 key 保持原样。仅含所选实例，不保证共享号码的全库成员覆盖。`, async () => {
        if (preview !== selected || writing || loading) { state('输入或选择已变化，请重新预览', 'error'); return; }
        if (!acquireWrite()) return;
        writing = true; preview = null; controls(); state('正在新增并回读校验；请等待结果，勿重复操作…');
        try {
          const response = await postJson('/api/redis-index/apply', { previewId: selected.previewId, confirmed: true }, { timeout: 65000 });
          state(`新增成功，回读已验证：${response.result.createdKeys.join('、')} · ${response.result.members} 个成员 · 操作记录 ${response.result.auditId}`, 'success');
          selected.canApply = false; selected.missingKeys = 0;
          selected.groups.forEach((group) => { if (group.status === 'missing') { group.status = 'created'; group.type = 'set'; } }); render(selected);
        } catch (error) { state(`${error.message} · 请重新查询 key 状态后再操作${error.details?.auditId ? ` · 操作记录 ${error.details.auditId}` : ''}`, 'error'); }
        finally { writing = false; releaseWrite(); controls(); }
      });
  });
  $('#redisIndexInput').addEventListener('input', () => invalidate());
  $('#redisIndexType').addEventListener('change', () => invalidate());
  $('#redisIndexCandidate').addEventListener('change', () => invalidate(false));
  $('#btnRedisIndexCancel').addEventListener('click', () => { invalidate(false); state('查询已取消'); });
  $('#btnRedisIndexConnections').addEventListener('click', openConnections);
  invalidate();
}
