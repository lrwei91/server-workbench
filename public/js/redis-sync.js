import { $, $$, el, getJson, postJson, formatBytes, formatDate, createRequestGate } from '/shared/ui.js';

export function initRedisSync({ confirm, refresh, openConnections }) {
  const gate = createRequestGate();
  let preview = null, busy = false;
  const key = () => $('#redisKeyInput').value.trim();
  const message = (text, tone = '') => { $('#redisSyncState').textContent = text; $('#redisSyncState').dataset.tone = tone; };
  const options = () => ({ tables: $$('input[name="redisSyncTable"]:checked').map((input) => input.value), timestampZone: $('#redisSyncTimezone').value });
  function controls() {
    $('#btnRedisSyncPreview').disabled = busy;
    $('#btnRedisSyncApply').disabled = busy || !preview?.canApply;
    $('#btnRedisSyncHistory').disabled = busy;
    $('#redisKeyInput').disabled = busy;
    $('#redisSyncTimezone').disabled = busy;
    $$('input[name="redisSyncTable"]').forEach((input) => { input.disabled = busy; });
    $$('[data-redis-restore]').forEach((button) => { button.disabled = busy || button.dataset.restoreAllowed !== 'true'; });
  }
  function invalidate() {
    gate.cancel(); preview = null; controls();
    $('#redisSyncResults').replaceChildren();
    message('输入目标 ID，选择表范围后生成预览；仅同步已有记录字段。');
  }
  function table(headers, rows) {
    return el('div', { class: 'redis-sync-table-wrap' }, el('table', { class: 'redis-sync-table' },
      el('thead', {}, el('tr', {}, headers.map((header) => el('th', { text: header })))),
      el('tbody', {}, rows.map((row) => el('tr', {}, row.map((value) => el('td', { text: value === null ? 'NULL' : value ?? '—' })))))));
  }
  function render(result) {
    const root = $('#redisSyncResults'); root.replaceChildren();
    root.append(el('div', { class: 'query-summary' }, [
      `${result.key}`, `${result.changedFields} 处字段差异`, `原值 ${formatBytes(result.beforeBytes)} → 新值 ${formatBytes(result.afterBytes)}`,
      `TTL ${result.ttlMs === -1 ? '永久' : `${result.ttlMs} ms`}`, `前缀 ${result.prefixHex}`, `时间解释 ${result.options.timestampZone === 'Z' ? 'UTC' : '北京时间'}`,
    ].map((text) => el('span', { class: 'summary-chip', text }))));
    if (result.blockers.length) root.append(el('div', { class: 'redis-sync-warning' }, el('strong', { text: '先处理以下阻断项' }), el('ul', {}, result.blockers.map((text) => el('li', { text })))));
    const missing = result.groups.reduce((count, group) => count + group.missing, 0);
    if (missing || result.unrecognized.length) root.append(el('p', { class: 'redis-sync-warning', text: `保留 ${missing} 条 PG 未匹配的分组记录${result.unrecognized.length ? `；未识别分组保留：${result.unrecognized.join('、')}` : ''}。不据此删除 Redis 内容。` }));
    root.append(el('details', {}, el('summary', { text: '匹配范围与保留项' }), table(['分组 / 表', '记录数', '匹配', '缺失保留', '修改记录', '未映射字段'], result.groups.map((group) => [`${group.group} / ${group.table}`, group.records, group.matched, group.missing, group.changed, group.preservedFields.join(', ') || '—']))));
    if (result.changes.length) root.append(table(['分组 / 行', 'ID / hisId', '字段', 'Redis 原值', 'PG 目标值'], result.changes.map((change) => [`${change.group}[${change.position}]`, `${change.id} / ${change.hisId}`, `${change.field} (${change.column})`, change.before, change.after])));
    if (result.changesTruncated) root.append(el('p', { text: '页面仅展示前 200 处差异，确认后同步全部预览差异。' }));
  }
  async function loadHistory(target = key()) {
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
            if (key() !== target || busy) return;
            busy = true; preview = null; controls(); message('正在恢复并回读校验…');
            try { const response = await postJson('/api/redis-sync/restore', { backupId: backup.backupId, confirmed: true }, { timeout: 65000 }); message(`恢复成功，回读已验证 · ${response.result.backupId}`, 'success'); await refresh(); await loadHistory(target).catch(historyError); }
            catch (error) { message(error.message, 'error'); }
            finally { busy = false; controls(); }
          });
        } } });
      root.append(el('div', { class: 'redis-sync-history-row' }, el('span', { text: `${formatDate(backup.createdAt, { withZone: true })} · ${statuses[backup.status] || backup.status} · ${backup.changedFields} 处 · ${backup.backupId}` }), button));
    });
  }
  function historyError(error) { $('#redisSyncHistory').replaceChildren(el('p', { class: 'redis-sync-warning', text: `同步记录读取失败：${error.message}。可点击「同步记录 / 恢复」重试。` })); }
  $('#btnRedisSyncPreview').addEventListener('click', async () => {
    const target = key();
    if (!/^(?:rate:cpp:)?\d+$/.test(target)) { message('请输入产品实例 ID 或 rate:cpp 主键', 'error'); return; }
    const selected = options();
    if (!selected.tables.length) { message('至少选择一张表', 'error'); return; }
    const request = gate.next(); preview = null; busy = true; controls(); message('正在只读匹配 PG 与 Redis…'); $('#redisSyncResults').replaceChildren();
    try {
      const response = await postJson('/api/redis-sync/preview', { key: target, ...selected }, { signal: request.signal, timeout: 65000 });
      if (!request.isCurrent()) return;
      preview = response.result; render(preview);
      message(preview.blockers.length ? '预览存在阻断项，先核对数据。' : preview.changedFields ? '预览完成，确认后仅写入该 key；写前备份并保留 TTL。' : '预览完成，已匹配字段无差异，无需写入。', preview.blockers.length ? 'error' : 'success');
      await loadHistory(target).catch(historyError);
    } catch (error) { if (request.isCurrent()) message(error.message, 'error'); }
    finally { busy = false; controls(); }
  });
  $('#btnRedisSyncApply').addEventListener('click', () => {
    const selected = preview, target = key();
    if (!selected?.canApply || busy) return;
    confirm(selected.key, `将当前 PG 预览的 ${selected.changedFields} 处字段差异写入此 Redis 档案。PG 缺失记录保持原值；自动备份旧值并回读验证。`, async () => {
      if (preview !== selected || key() !== target || busy) { message('选择已变化，请重新预览', 'error'); return; }
      busy = true; preview = null; controls(); message('正在备份、同步并回读校验…');
      try {
        const response = await postJson('/api/redis-sync/apply', { previewId: selected.previewId, confirmed: true }, { timeout: 65000 });
        message(`同步成功，回读已验证 · ${response.result.changedFields} 处 · 备份 ${response.result.backupId}`, 'success');
        await refresh(); await loadHistory(target).catch(historyError);
      } catch (error) { message(`${error.message}${error.details?.backupId ? ` · 备份 ${error.details.backupId} · 请查看同步记录` : ''}`, 'error'); await loadHistory(target).catch(() => {}); }
      finally { busy = false; controls(); }
    });
  });
  $('#btnRedisSyncHistory').addEventListener('click', () => { void loadHistory().catch((error) => message(error.message, 'error')); });
  $('#btnRedisSyncConnections').addEventListener('click', openConnections);
  $('#redisKeyInput').addEventListener('input', () => { invalidate(); $('#redisSyncHistory').replaceChildren(); });
  $('#redisSyncTimezone').addEventListener('change', invalidate);
  getJson('/api/redis-sync/status').then((response) => {
    $('#redisSyncTables').replaceChildren(...response.tables.map((item) => el('label', {}, el('input', { type: 'checkbox', name: 'redisSyncTable', value: item.table, checked: true, on: { change: invalidate } }), item.table)));
  }).catch((error) => message(error.message, 'error'));
  invalidate();
}
