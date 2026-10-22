import { $, $$, el, getJson, postJson, formatBytes, formatDate, createRequestGate } from '/shared/ui.js';

export function initRedisSync({ confirm, refresh, openConnections, isWriting, acquireWrite, releaseWrite }) {
  const gate = createRequestGate();
  let preview = null, busy = false;
  const key = () => $('#redisKeyInput').value.trim();
  const message = (text, tone = '') => { $('#redisSyncState').textContent = text; $('#redisSyncState').dataset.tone = tone; if ($('#redisPage').dataset.task === 'history') { $('#redisHistoryState').textContent = text; $('#redisHistoryState').dataset.tone = tone; } };
  const options = () => ({ tables: $$('input[name="redisSyncTable"]:checked').map((input) => input.value), timestampZone: $('#redisSyncTimezone').value });
  function controls() {
    $('#btnRedisSyncPreview').disabled = busy || isWriting();
    $('#btnRedisSyncApply').disabled = busy || isWriting() || !preview?.canApply;
    $('#btnRedisSyncHistory').disabled = busy || isWriting();
    $('#redisKeyInput').disabled = busy || isWriting();
    $('#redisSyncTimezone').disabled = busy || isWriting();
    $$('input[name="redisSyncTable"]').forEach((input) => { input.disabled = busy || isWriting(); });
    $$('[data-redis-restore]').forEach((button) => { button.disabled = busy || isWriting() || button.dataset.restoreAllowed !== 'true'; });
  }
  function invalidate() {
    gate.cancel(); preview = null; controls();
    $('#redisSyncResults').replaceChildren();
    message('输入目标 ID，选择表范围后生成预览；同步字段及根产品直接订购新增记录。');
  }
  function table(headers, rows) {
    return el('div', { class: 'redis-sync-table-wrap' }, el('table', { class: 'redis-sync-table' },
      el('thead', {}, el('tr', {}, headers.map((header) => el('th', { text: header })))),
      el('tbody', {}, rows.map((row) => el('tr', {}, row.map((value) => el('td', { text: value === null ? 'NULL' : value ?? '—' })))))));
  }
  function render(result) {
    const root = $('#redisSyncResults'); root.replaceChildren();
    root.append(el('div', { class: 'query-summary' }, [
      `${result.key}`, `${result.changedFields} 处字段差异`, `${result.addedRecords || 0} 条待追加记录`, `原值 ${formatBytes(result.beforeBytes)} → 新值 ${formatBytes(result.afterBytes)}`,
      `TTL ${result.ttlMs === -1 ? '永久' : `${result.ttlMs} ms`}`, `前缀 ${result.prefixHex}`, `时间解释 ${result.options.timestampZone === 'Z' ? 'UTC' : '北京时间'}`,
    ].map((text) => el('span', { class: 'summary-chip', text }))));
    if (result.blockers.length) root.append(el('div', { class: 'redis-sync-warning' }, el('strong', { text: '先处理以下阻断项' }), el('ul', {}, result.blockers.map((text) => el('li', { text })))));
    if (result.timeAdjustmentCount) root.append(el('details', { open: true }, el('summary', { text: `时间精度兼容：${result.timeAdjustmentCount} 个字段由 PG 微秒截至 Redis 毫秒（不四舍五入）` }),
      table(['分组 / ID / his_id', '字段', 'PG 原始值', '毫秒时间解释', 'Redis 目标毫秒'], result.timeAdjustments.map((item) => [`${item.group} / ${item.id} / ${item.hisId ?? 'NULL'}`, `${item.field} (${item.column})`, item.rawValue, item.normalizedValue, item.targetValue]))));
    if (result.timeAdjustmentsTruncated) root.append(el('p', { text: '时间精度明细仅展示前 200 个字段，总数包含全部转换字段。' }));
    const comparison = result.recordComparison;
    if (comparison) {
      root.append(el('h4', { text: `记录级比对：PG 有、Redis 无 ${comparison.pgOnlyCount} 条` }),
        el('p', { class: 'query-help', text: '范围：所选表、根产品及产品/销售品一跳直接关系，按 ID + his_id 跨 Step 分组去重。根产品直接订购关系及销售品实例纳入追加；其他类型仅核对。0 条字段差异不表示完整档案一致。' }));
      if (!comparison.complete) root.append(el('p', { class: 'redis-sync-warning', text: `记录级比对覆盖不完整：${comparison.warnings.join('；')}` }));
      if (comparison.pgOnlyRecords.length) root.append(table(['PG 表', '目标分组 / 类型', 'PG 新增 / Redis 缺失 ID', 'his_id', '处理方式'], comparison.pgOnlyRecords.map((row) => [row.table, row.targetGroup || row.group, row.id, row.hisId, row.action === 'append' ? '待追加（整次预览无阻断时写入）' : row.reason || '仅核对'])));
      if (comparison.truncated) root.append(el('p', { text: '记录级差异仅展示前 200 条；总数包含全部已比对记录。' }));
    }
    if (result.additions?.length) root.append(el('details', {}, el('summary', { text: `查看待追加记录字段（${result.addedRecords} 条）` }), ...result.additions.map((item) => el('details', {},
      el('summary', { text: `${item.targetGroup} · ${item.id} / ${item.hisId ?? 'NULL'}` }), table(['字段', '新增值'], Object.entries(item.record))))));
    if (result.additionsTruncated) root.append(el('p', { text: '待追加内容仅展示前 200 条；确认后写入全部预览新增记录。' }));
    if (result.unresolvedRecords) root.append(el('p', { class: 'redis-sync-warning', text: `${result.unresolvedRecords} 条新增记录尚未纳入写入，请核对上方处理方式。` }));
    const missing = result.groups.reduce((count, group) => count + group.missing, 0);
    if (missing || result.unrecognized.length) root.append(el('p', { class: 'redis-sync-warning', text: `保留 ${missing} 条 PG 未匹配的分组记录${result.unrecognized.length ? `；未识别分组保留：${result.unrecognized.join('、')}` : ''}。不据此删除 Redis 内容。` }));
    root.append(el('details', {}, el('summary', { text: '匹配范围与保留项' }), table(['分组 / 表', '记录数', '匹配', '缺失保留', '修改记录', '未映射字段'], result.groups.map((group) => [`${group.group} / ${group.table}`, group.records, group.matched, group.missing, group.changed, group.preservedFields.join(', ') || '—']))));
    if (result.changes.length) root.append(table(['分组 / 行', 'ID / hisId', '字段', 'Redis 原值', 'PG 目标值'], result.changes.map((change) => [`${change.group}[${change.position}]`, `${change.id} / ${change.hisId}`, `${change.field} (${change.column})`, change.before, change.after])));
    if (result.changesTruncated) root.append(el('p', { text: '页面仅展示前 200 处差异，确认后同步全部预览差异。' }));
  }
  async function loadHistory(target = key()) {
    if (!/^(?:rate:cpp:)?\d{1,20}$/.test(target)) throw new Error('请输入有效产品实例 ID 或 rate:cpp 主键');
    const response = await postJson('/api/redis-sync/history', { key: target });
    if (key() !== target) return;
    const root = $('#redisSyncHistory'); root.replaceChildren();
    if (!response.result.length) { root.append(el('p', { class: 'query-help', text: '该档案在当前连接下尚无同步备份。' })); return; }
    response.result.forEach((backup) => {
      const statuses = { pending: '待确认结果', applied: '同步已验证', restored: '已恢复', 'not-applied': '未写入', uncertain: '结果待核对' };
      const button = el('button', { type: 'button', class: 'wb-button', text: '恢复此备份', 'data-redis-restore': backup.backupId,
        'data-restore-allowed': String(['applied', 'pending', 'uncertain'].includes(backup.status)),
        disabled: busy || !['applied', 'pending', 'uncertain'].includes(backup.status), on: { click: () => {
          confirm(target, `恢复 ${formatDate(backup.createdAt, { withZone: true })} 同步前的原始值及原过期时间。若当前 Redis 已被后续修改，恢复将停止。`, async () => {
            if (key() !== target || busy || !acquireWrite()) return;
            busy = true; preview = null; controls(); message('正在恢复并回读校验…');
            try { const response = await postJson('/api/redis-sync/restore', { backupId: backup.backupId, confirmed: true }, { timeout: 65000 }); message(`恢复成功，回读已验证 · ${response.result.backupId}`, 'success'); await refresh(); await loadHistory(target).catch(historyError); }
            catch (error) { message(error.message, 'error'); }
            finally { busy = false; releaseWrite(); controls(); }
          });
        } } });
      root.append(el('div', { class: 'redis-sync-history-row' }, el('span', { text: `${formatDate(backup.createdAt, { withZone: true })} · ${statuses[backup.status] || backup.status} · ${backup.changedFields} 处字段 · 新增 ${backup.addedRecords || 0} 条 · ${backup.backupId}` }), button));
    });
  }
  function historyError(error) { $('#redisSyncHistory').replaceChildren(el('p', { class: 'redis-sync-warning', text: `同步记录读取失败：${error.message}。可点击「同步记录 / 恢复」重试。` })); }
  document.addEventListener('redis:write-state', controls);
  $('#btnRedisSyncPreview').addEventListener('click', async () => {
    if (busy || isWriting()) return;
    const target = key();
    if (!/^(?:rate:cpp:)?\d+$/.test(target)) { message('请输入产品实例 ID 或 rate:cpp 主键', 'error'); return; }
    const selected = options();
    if (!selected.tables.length) { message('至少选择一张表', 'error'); return; }
    const request = gate.next(); preview = null; busy = true; controls(); message('正在只读匹配 PG 与 Redis…'); $('#redisSyncResults').replaceChildren();
    try {
      const response = await postJson('/api/redis-sync/preview', { key: target, ...selected }, { signal: request.signal, timeout: 65000 });
      if (!request.isCurrent()) return;
      preview = response.result; render(preview);
      message(preview.blockers.length ? '预览存在阻断项，先核对数据。' : preview.unresolvedRecords || preview.recordComparison?.complete === false ? '预览完成：存在仅核对记录或覆盖缺口，请核对处理方式；仅写入已纳入候选的字段和新增订购。' : preview.canApply ? `预览完成：${preview.changedFields} 处字段差异、${preview.addedRecords || 0} 条待追加；写前备份并保留 TTL。` : '预览完成，限定范围内无待写入差异。', preview.blockers.length || preview.unresolvedRecords || preview.recordComparison?.complete === false ? 'warning' : 'success');
      await loadHistory(target).catch(historyError);
    } catch (error) { if (request.isCurrent()) message(error.message, 'error'); }
    finally { if (request.isCurrent()) { busy = false; controls(); } }
  });
  $('#btnRedisSyncApply').addEventListener('click', () => {
    const selected = preview, target = key();
    if (!selected?.canApply || busy || isWriting()) return;
    confirm(selected.key, `将当前 PG 预览的 ${selected.changedFields} 处字段差异及 ${selected.addedRecords || 0} 条新增订购记录写入此 Redis 档案。另有 ${selected.unresolvedRecords || 0} 条新增记录仅核对、不写入。${selected.timeAdjustmentCount ? `${selected.timeAdjustmentCount} 个时间字段按预览由微秒截至毫秒，不四舍五入。` : ''}PG 缺失记录保持原值；自动备份旧值、保留 TTL 并回读验证。`, async () => {
      if (preview !== selected || key() !== target || busy || isWriting()) { message('选择已变化，请重新预览', 'error'); return; }
      if (!acquireWrite()) return;
      busy = true; preview = null; controls(); message('正在备份、同步并回读校验…');
      try {
        const response = await postJson('/api/redis-sync/apply', { previewId: selected.previewId, confirmed: true }, { timeout: 65000 });
        message(`同步成功，回读已验证 · ${response.result.changedFields} 处字段 · 新增 ${response.result.addedRecords || 0} 条 · 备份 ${response.result.backupId}`, 'success');
        await refresh(); await loadHistory(target).catch(historyError);
      } catch (error) { message(`${error.message}${error.details?.backupId ? ` · 备份 ${error.details.backupId} · 请查看同步记录` : ''}`, 'error'); await loadHistory(target).catch(() => {}); }
      finally { busy = false; releaseWrite(); controls(); }
    });
  });
  $('#btnRedisSyncHistory').addEventListener('click', () => { void loadHistory().catch(historyError); });
  $('#btnRedisSyncConnections').addEventListener('click', openConnections);
  $('#redisKeyInput').addEventListener('input', () => { invalidate(); $('#redisSyncHistory').replaceChildren(); });
  $('#redisSyncTimezone').addEventListener('change', invalidate);
  getJson('/api/redis-sync/status').then((response) => {
    $('#redisSyncTables').replaceChildren(...response.tables.map((item) => el('label', {}, el('input', { type: 'checkbox', name: 'redisSyncTable', value: item.table, checked: true, on: { change: invalidate } }), item.table)));
  }).catch((error) => message(error.message, 'error'));
  invalidate();
}
