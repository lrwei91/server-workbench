const { test, expect } = require('@playwright/test');
const failedAssets = new WeakMap();
test.beforeEach(async ({ page }) => { const failures = []; failedAssets.set(page, failures); page.on('response', response => { if (response.status() >= 400 && !new URL(response.url()).pathname.includes('/api/')) failures.push(`${response.status()} ${new URL(response.url()).pathname}`); }); });
test.afterEach(async ({ page }) => { expect(failedAssets.get(page)).toEqual([]); });

test('five workspaces restore tabs without losing input, and route values contain no identifiers', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveURL(/#\/resources\/files$/);
  await expect.poll(() => page.locator('.primary-nav-item svg').evaluateAll(nodes => nodes.length === 5 && nodes.every(node => node.getBBox().width > 0))).toBe(true);
  await page.getByRole('button', { name: '数据库查询', exact: true }).click();
  await page.locator('#phoneInput').fill('13800000000');
  await page.getByRole('tab', { name: '实例查档案', exact: true }).click();
  await page.locator('#productInstanceInput').fill('103386066');
  await page.getByRole('button', { name: 'Redis 档案', exact: true }).click();
  await expect(page.locator('#redisResults')).toBeVisible();
  await expect(page.locator('#redisIndexForm')).toBeHidden();
  await page.getByRole('tab', { name: '号码索引', exact: true }).click();
  await page.getByRole('button', { name: '数据库查询', exact: true }).click();
  await expect(page.locator('#productInstanceInput')).toHaveValue('103386066');
  await page.goBack();
  await expect(page.locator('#redisIndexForm')).toBeVisible();
  await page.reload();
  await expect(page.locator('#redisIndexForm')).toBeVisible();
  expect(page.url()).not.toContain('103386066');
  expect(errors).toEqual([]);
});

const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function connected(page) {
  await page.route('**/api/db/status', route => fulfill(route, { sources: { pg: { connected: true }, udal: { connected: true }, doris: { connected: false } } }));
  await page.route('**/api/voyage/status', route => fulfill(route, { connected: true, config: {} }));
}
function queryResult(overrides = {}) {
  return { status: 'complete', source: 'pg', schema: 'bill_inmemory', phone: '13800000000', totalRows: 2, queriedAt: '2026-10-22T12:00:00Z', steps: [], data: { productInstances: [{ prod_inst_id: '103386066', OWNER_CUST_ID: '700', acc_nbr: '13800000000', prod_name: '测试产品' }], productAttributes: [{ prod_inst_id: '103386066', attr_id: '100', value: '测试属性' }] }, ...overrides };
}
test('query groups, typed handoff and environment source are retained independently', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await connected(page);
  await page.route('**/api/query/phone', route => fulfill(route, { result: queryResult({ status: 'partial', truncated: true, steps: [{ name: '读取配置', status: 'error', database: 'MySQL', message: '测试超时' }] }) }));
  await page.goto('/#/query/phone');
  await expect(page.locator('#dbStatusCards')).toContainText('PostgreSQL');
  await expect(page.locator('#dbStatusCards')).not.toContainText('Doris');
  await page.locator('#phoneInput').fill('13800000000'); await page.locator('#btnPhoneQuery').click();
  const groups = page.getByRole('navigation', { name: '查询结果分组' });
  await expect(groups).toBeVisible();
  await expect(page.locator('#queryState')).toContainText('部分完成');
  await expect(page.locator('.query-summary')).toContainText('结果已达上限');
  await groups.getByRole('button', { name: /^产品实例 ·/ }).click();
  await page.locator('.result-group-content:visible').getByRole('button', { name: '在 Redis 中打开' }).click();
  await expect(page.locator('#redisKeyInput')).toHaveValue('103386066');
  await expect(page.locator('#redisHandoff')).toContainText('测试环境 PostgreSQL');
  await expect(page.locator('#redisResults')).toContainText('等待查询');
  await page.getByRole('button', { name: '数据库查询', exact: true }).click();
  await expect(groups).toBeVisible();
  await page.locator('#querySourceSelect').selectOption('voyage');
  await expect(groups).toHaveCount(0); await expect(page.locator('#dbStatusCards')).toContainText('Voyage');
  await expect(page.locator('#dbStatusCards')).not.toContainText('PostgreSQL');
  expect(errors).toEqual([]);
});

test('cancel and environment changes reject delayed results; failures can be retried', async ({ page }) => {
  await connected(page);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/query/phone', async route => { await held; await fulfill(route, { result: queryResult() }).catch(() => {}); });
  await page.goto('/#/query/phone'); await expect(page.locator('#dbStatusCards')).toContainText('PostgreSQL');
  await page.locator('#phoneInput').fill('13800000000'); await page.locator('#btnPhoneQuery').click();
  await page.locator('#btnPhoneCancel').click(); await expect(page.locator('#queryState')).toHaveText('查询已取消');
  release(); await expect(page.locator('.result-browser')).toHaveCount(0);
  await page.unroute('**/api/query/phone');
  await page.route('**/api/query/phone', route => fulfill(route, { ok: false, error: { code: 'REMOTE_TIMEOUT', message: '测试超时', retryable: true } }, 504));
  await page.locator('#btnPhoneQuery').click(); await expect(page.locator('#queryState')).toHaveText('测试超时');
  await page.unroute('**/api/query/phone');
  await page.route('**/api/query/phone', route => fulfill(route, { result: queryResult({ status: 'empty', data: {} }) }));
  await page.locator('#btnPhoneQuery').click(); await expect(page.locator('#queryState')).toHaveText('没有找到匹配号码');
  let releaseOld;
  const old = new Promise(resolve => { releaseOld = resolve; });
  await page.unroute('**/api/query/phone');
  await page.route('**/api/query/phone', async route => { await old; await fulfill(route, { result: queryResult() }).catch(() => {}); });
  await page.locator('#btnPhoneQuery').click(); await page.locator('#querySourceSelect').selectOption('voyage'); releaseOld();
  await expect(page.locator('#querySourceSelect')).toHaveValue('voyage');
  await expect(page.locator('.result-browser')).toHaveCount(0);
  await expect(page.locator('#btnPhoneQuery')).toBeEnabled();
});

function syncPreview() { return { key: 'rate:cpp:103386066', previewId: 'preview-fixture', canApply: true, changedFields: 1, addedRecords: 0, beforeBytes: 128, afterBytes: 128, ttlMs: -1, prefixHex: '00', options: { timestampZone: '+08:00' }, blockers: [], groups: [], unrecognized: [], changes: [{ group: 'FirstStep', position: 0, id: '103386066', hisId: '0', field: 'test', column: 'test', before: '旧值', after: '新值' }] }; }
test('Redis invalidates previews, requires confirmation, locks writes and completes after navigation', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let writes = 0, release;
  const applied = new Promise(resolve => { release = resolve; });
  await page.route('**/api/redis-sync/preview', route => fulfill(route, { result: syncPreview() }));
  await page.route('**/api/redis-sync/history', route => fulfill(route, { result: [] }));
  await page.route('**/api/query/redis', route => fulfill(route, { result: { status: 'complete', key: 'rate:cpp:103386066', productInstanceId: '103386066', data: { test: '新值' } } }));
  await page.route('**/api/redis-sync/apply', async route => { writes++; expect(route.request().postDataJSON()).toEqual({ previewId: 'preview-fixture', confirmed: true }); await applied; await fulfill(route, { result: { changedFields: 1, addedRecords: 0, backupId: 'fixture-backup' } }); });
  await page.goto('/#/redis/sync'); await page.locator('#redisKeyInput').fill('103386066');
  await expect(page.locator('#redisSyncTables input').first()).toBeChecked();
  await page.locator('#btnRedisSyncPreview').click(); await expect(page.locator('#btnRedisSyncApply')).toBeEnabled();
  await page.getByText('表范围与时间解释', { exact: true }).click(); await page.locator('#redisSyncTimezone').selectOption('Z'); await expect(page.locator('#btnRedisSyncApply')).toBeDisabled();
  await page.locator('#btnRedisSyncPreview').click(); await expect(page.locator('#btnRedisSyncApply')).toBeEnabled();
  await page.locator('#redisKeyInput').fill('103386067'); await expect(page.locator('#btnRedisSyncApply')).toBeDisabled();
  await page.locator('#redisKeyInput').fill('103386066'); await page.locator('#btnRedisSyncPreview').click();
  await page.locator('#btnRedisSyncApply').click(); await expect(page.locator('#confirmTarget')).toHaveText('rate:cpp:103386066'); expect(writes).toBe(0);
  await page.locator('#btnConfirmAction').click(); await expect(page.locator('#redisKeyInput')).toBeDisabled();
  await page.getByRole('button', { name: '资源浏览', exact: true }).click(); release();
  await page.getByRole('button', { name: 'Redis 档案', exact: true }).click();
  await expect(page.locator('#redisSyncState')).toContainText('同步成功，回读已验证');
  await expect(page.locator('#redisKeyInput')).toBeEnabled(); expect(writes).toBe(1); expect(errors).toEqual([]);
});

test('index lookup never auto-selects multiple product candidates and changes invalidate selection previews', async ({ page }) => {
  await page.route('**/api/redis-index/lookup', route => fulfill(route, { result: { candidates: [{ productInstanceId: '101' }, { productInstanceId: '102' }], source: '测试 PG' } }));
  await page.route('**/api/redis-index/preview', route => fulfill(route, { result: { key: 'rate:cpp:101', previewId: 'index-fixture', canApply: true, missingKeys: 1, warnings: [], scope: '只补所选实例', groups: [{ key: 'rate:accNbr:13800000000', field: 'accNbr', status: 'missing', members: [{ areaCode: '0591', servId: '101', accNbr: '13800000000' }] }] } }));
  await page.goto('/#/redis/indexes'); await page.locator('#redisIndexType').selectOption('phone'); await page.locator('#redisIndexInput').fill('13800000000'); await page.locator('#btnRedisIndexLookup').click();
  await expect(page.locator('#redisIndexCandidate')).toHaveValue(''); await expect(page.locator('#btnRedisIndexApply')).toBeDisabled();
  await page.locator('#redisIndexCandidate').selectOption('101'); await page.locator('#btnRedisIndexPreview').click(); await expect(page.locator('#btnRedisIndexApply')).toBeEnabled();
  await page.locator('#redisIndexCandidate').selectOption('102'); await expect(page.locator('#btnRedisIndexApply')).toBeDisabled();
});

test('CDR keeps its iframe and session; editing, batch preview, generate, undo and export use the real local engine', async ({ page, request }) => {
  await request.post('/cdr/api/reset', { data: {} });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let fileReads = 0; page.on('request', req => { if (new URL(req.url()).pathname === '/cdr/api/files') fileReads++; });
  await page.goto('/#/cdr'); const frame = page.frameLocator('#cdrFrame');
  await expect(frame.locator('#statExport')).toHaveText('未加载');
  await expect(frame.locator('#btnExport')).toBeDisabled(); expect(fileReads).toBe(1);
  await frame.locator('#fileSelect').selectOption('sample.json'); await frame.locator('#btnLoad').click();
  await expect(frame.locator('#statTotal')).toHaveText('2'); await expect(frame.locator('#btnLoad')).toBeEnabled();
  await frame.getByRole('button', { name: '编辑', exact: true }).first().click();
  await frame.getByLabel('CHARGE', { exact: true }).fill('2'); await frame.locator('#btnSaveEdit').click();
  await expect(frame.locator('#statExport')).toHaveText('有未导出修改');
  await page.getByRole('button', { name: '资源浏览', exact: true }).click();
  await page.getByRole('button', { name: '话单工具', exact: true }).click();
  await expect(frame.locator('#statExport')).toHaveText('有未导出修改');
  await frame.getByRole('button', { name: '批量修改', exact: true }).click();
  await frame.locator('#btnAddFilter').click(); await frame.getByLabel('筛选字段', { exact: true }).selectOption('IMSI_NBR'); await frame.getByLabel('筛选值', { exact: true }).fill('13800000000');
  await frame.locator('#batchField').fill('CHARGE'); await frame.locator('#batchValue').fill('3.5');
  await frame.locator('#btnBatchPreview').click(); await expect(frame.locator('#batchPreview')).toContainText('3.5'); await expect(frame.locator('#btnBatchApply')).toBeEnabled();
  await frame.locator('#batchValue').fill('4'); await expect(frame.locator('#btnBatchApply')).toBeDisabled();
  await frame.locator('#btnBatchPreview').click(); await frame.locator('#btnBatchApply').click(); await expect(frame.locator('#batchStatus')).toContainText('已应用 1 处修改');
  await frame.getByRole('tab', { name: '批量造数', exact: true }).click(); await frame.locator('#templateIdxs').fill('0');
  await frame.locator('#btnGenerate').click(); await frame.locator('#btnConfirm').click(); await expect(frame.locator('#statTotal')).toHaveText('3');
  await expect(frame.getByRole('button', { name: '关闭话单操作' })).toBeEnabled(); await frame.getByRole('button', { name: '关闭话单操作' }).click();
  await frame.locator('#btnUndo').click(); await expect(frame.locator('#statTotal')).toHaveText('2'); await expect(frame.locator('#btnUndo')).toBeEnabled();
  await frame.locator('#btnUndo').click(); await expect(frame.locator('#btnUndo')).toBeEnabled();
  await expect.poll(async () => (await (await request.get('/cdr/api/record/0')).json()).record.CHARGE).toBe(2);
  await frame.locator('#fileSelect').selectOption('other.json'); await frame.locator('#btnLoad').click(); await expect(frame.locator('#confirmMessage')).toContainText('有未导出修改');
  await frame.locator('#confirmDialog [data-close]').last().click(); await expect(frame.locator('#sessionState')).toContainText('sample.json');
  await frame.locator('#btnExport').click(); await expect(frame.locator('#statExport')).toHaveText('已导出');
  await expect(frame.locator('#exportStatus')).toContainText('导出完成');
  expect(errors).toEqual([]);
});

test('CDR delayed preview cannot survive changed inputs and unsaved record editing requires discard confirmation', async ({ page, request }) => {
  await request.post('/cdr/api/reset', { data: {} }); await request.post('/cdr/api/load', { data: { filename: 'sample.json' } });
  await page.goto('/#/cdr'); const frame = page.frameLocator('#cdrFrame');
  await expect(frame.locator('#statTotal')).toHaveText('2');
  await frame.getByRole('button', { name: '编辑', exact: true }).first().click(); await frame.getByLabel('CHARGE', { exact: true }).fill('9');
  await frame.getByLabel('CHARGE', { exact: true }).press('Escape'); await expect(frame.locator('#confirmMessage')).toContainText('尚未保存');
  await frame.locator('#confirmDialog [data-close]').last().click(); await expect(frame.locator('#editDialog')).toBeVisible();
  await frame.getByRole('button', { name: '关闭编辑' }).click(); await frame.locator('#btnConfirm').click(); await expect(frame.locator('#editDialog')).toBeHidden();
  await frame.getByRole('button', { name: '批量修改', exact: true }).click(); await frame.locator('#btnAddFilter').click();
  await frame.getByLabel('筛选字段', { exact: true }).selectOption('IMSI_NBR'); await frame.getByLabel('筛选值', { exact: true }).fill('13800000000'); await frame.locator('#batchField').fill('CHARGE'); await frame.locator('#batchValue').fill('3');
  let release; const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/cdr/api/batch-update', async route => { await pending; await fulfill(route, { matched: 1, preview: [{ idx: 0, field: 'CHARGE', old: 1, new: 3 }] }).catch(() => {}); });
  await frame.locator('#btnBatchPreview').click(); await frame.locator('#batchValue').fill('4'); release();
  await expect(frame.locator('#btnBatchApply')).toBeDisabled(); await expect(frame.locator('#batchPreview')).toBeEmpty();
});

async function mockLogs(page) {
  const calls = { logs: 0, kinds: [] };
  await page.route('**/api/dcos/status', route => fulfill(route, { configured: true, connected: true, baseUrl: 'https://logs.example.invalid', clusters: [{ id: 321, name: '测试集群' }] }));
  await page.route('**/api/dcos/namespaces?*', route => fulfill(route, { namespaces: [{ name: 'bill-cnos-jf' }] }));
  await page.route('**/api/dcos/workloads?*', route => {
    const term = new URL(route.request().url()).searchParams.get('search').toLowerCase();
    const records = [{ name: 'billing-test', kind: 'StatefulSet', runningPodNum: 1 }, { name: 'billing-backend-test', kind: 'Deployment', runningPodNum: 1 }].filter(item => item.name.toLowerCase().includes(term));
    return fulfill(route, { records, total: records.length, pageNow: 1 });
  });
  await page.route('**/api/dcos/pods?*', route => { calls.kinds.push(new URL(route.request().url()).searchParams.get('workloadKind')); return fulfill(route, { pods: [{ name: 'billing-test-0', status: 'Running', containers: ['billing'] }] }); });
  await page.route('**/api/dcos/logs?*', route => { calls.logs++; return fulfill(route, { lines: Array.from({ length: 150 }, (_, i) => `2026-10-22 20:00:${String(i % 60).padStart(2,'0')} [INFO] 测试日志第 ${i} 行`), readAt: '2026-10-22T12:00:00Z' }); });
  return calls;
}
async function selectLogTarget(page) {
  await page.locator('#dcosCluster').selectOption('321'); await page.locator('#dcosNamespace').selectOption('bill-cnos-jf');
  await page.locator('#dcosWorkloadSearch').click();
  await page.getByRole('option', { name: 'billing-test · 有状态 StatefulSet · 1 Pod', exact: true }).click();
  await page.locator('#dcosPod').selectOption('billing-test-0'); await page.locator('#dcosContainer').selectOption('billing');
}
test('log follow pauses when scrolling up; leaving the page stops polling and returning resumes it', async ({ page }) => {
  const calls = await mockLogs(page); await page.clock.install(); await page.goto('/#/logs'); await selectLogTarget(page);
  await expect(page.locator('#dcosLogState')).toContainText('已读取 150 行'); await expect(page.locator('#dcosConnectionCard')).not.toHaveAttribute('open');
  await expect(page.locator('#dcosFollow')).toBeChecked();
  await page.locator('#dcosLogText').evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
  await expect(page.locator('#dcosFollow')).not.toBeChecked();
  await page.locator('#dcosAutoRefresh').check(); await page.getByRole('button', { name: '资源浏览', exact: true }).click();
  const before = calls.logs; await page.clock.runFor(6000); expect(calls.logs).toBe(before);
  await page.getByRole('button', { name: '进程日志', exact: true }).click(); await page.clock.runFor(5100); await expect.poll(() => calls.logs).toBe(before + 1);
  await expect(page.locator('#dcosWorkload')).toHaveValue('StatefulSet/billing-test');
  await expect(page.locator('#dcosWorkloadSearch')).toHaveValue('billing-test');
});

async function mockResources(page) {
  await page.route('**/api/status', route => fulfill(route, { connected: true, home: '/home/qa', conn: { host: 'fixture-host', username: 'qa' } }));
  await page.route('**/api/sftp/list', route => fulfill(route, { path: route.request().postDataJSON().path, items: Array.from({ length: 50 }, (_, i) => ({ name: i === 0 ? 'billing-test.log' : `sample-${String(i).padStart(2,'0')}.json`, isDir: false, path: `/home/qa/sample-${i}.json`, size: 2048, mtime: '2026-10-22T12:00:00+08:00' })) }));
  await page.route('**/api/sftp/preview', route => fulfill(route, { text: '测试文件预览\n第二行', size: 32 }));
}
test('resource path edit, preview drawer sizing, focus restoration and scroll context work', async ({ page }) => {
  await mockResources(page); await page.goto('/'); await expect(page.locator('#fileList .resource-row')).toHaveCount(50);
  await page.getByRole('button', { name: '编辑当前路径', exact: true }).click(); await page.locator('#pathInput').fill('/not-applied'); await page.locator('#pathInput').press('Escape');
  await expect(page.locator('#pathInput')).toHaveValue('/home/qa');
  await page.getByRole('button', { name: '编辑当前路径', exact: true }).click(); await page.locator('#pathInput').fill('/var/log'); await page.locator('#pathInput').press('Enter');
  await expect(page.locator('#crumbs')).toContainText('/var/log');
  const trigger = page.locator('#fileList .resource-row').first().getByRole('button', { name: '查看', exact: true }); await trigger.click();
  await expect(page.locator('#previewDialog')).toBeVisible(); await page.getByRole('button', { name: '展开详情至全宽', exact: true }).click();
  expect((await page.locator('#previewDialog').boundingBox()).width).toBe(1366);
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  const more = page.locator('#fileList .resource-row').first().getByRole('button', { name: /^更多操作/ });
  await more.click(); await page.locator('.row-action-menu:popover-open').getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.locator('#confirmTarget')).toHaveText('/home/qa/sample-0.json');
  await page.locator('#confirmDialog [data-dialog-close]').last().click(); await expect(more).toBeFocused();
  await page.locator('#fileList').evaluate(node => { node.scrollTop = 360; });
  await page.getByRole('button', { name: '数据库查询', exact: true }).click(); await page.getByRole('button', { name: '资源浏览', exact: true }).click();
  expect(await page.locator('#fileList').evaluate(node => node.scrollTop)).toBe(360);
});

const sizes = [{ width: 1024, height: 768, label: '1024' }, { width: 1366, height: 768, label: '1366' }, { width: 1920, height: 1080, label: '1920' }, { width: 1093, height: 614, label: '1366-at-125' }, { width: 911, height: 512, label: '1366-at-150' }, { width: 683, height: 512, label: '1024-at-150' }];
for (const size of sizes) test(`layout has no page overflow or clipped primary controls at ${size.label}`, async ({ page, request }) => {
  await page.setViewportSize({ width: size.width, height: size.height }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await connected(page); await mockResources(page); await mockLogs(page);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/query/phone', route => fulfill(route, { result: queryResult({ data: { productInstances: Array.from({ length: 30 }, (_, i) => ({ prod_inst_id: String(103386066 + i), ...Object.fromEntries(Array.from({ length: 16 }, (_, j) => [`test_field_${j}`, `测试长字段${'内容'.repeat(30)}`])) })) } }) }));
  await request.post('/cdr/api/reset', { data: {} }); await request.post('/cdr/api/load', { data: { filename: 'sample.json' } });
  await page.goto('/'); await expect(page.locator('#fileList .resource-row')).toHaveCount(50);
  async function fits(selector, root = page) {
    const box = await root.locator(selector).boundingBox(); expect(box, selector).toBeTruthy();
    expect(box.x, selector).toBeGreaterThanOrEqual(0); expect(box.y, selector).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, selector).toBeLessThanOrEqual(size.width + 1); expect(box.y + box.height, selector).toBeLessThanOrEqual(size.height + 1);
  }
  await fits('#btnUploadLocal');
  const path = require('node:path'); const fs = require('node:fs'); const dir = path.resolve('outputs/ui-redesign'); fs.mkdirSync(dir, { recursive: true });
  if (size.label === '1366') await page.screenshot({ path: path.join(dir, 'resources.png') });
  await page.getByRole('button', { name: '数据库查询', exact: true }).click(); await page.locator('#phoneInput').fill('13800000000'); await page.locator('#btnPhoneQuery').click();
  await expect(page.locator('.result-browser')).toBeVisible(); await fits('#btnPhoneQuery');
  await page.getByRole('navigation', { name: '查询结果分组' }).getByRole('button', { name: /^产品实例 ·/ }).click();
  expect(await page.locator('.result-group-content .query-table-wrap:visible').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await page.screenshot({ path: path.join(dir, `query-${size.label}.png`) });
  await page.getByRole('button', { name: 'Redis 档案', exact: true }).click(); await fits('#btnRedisQuery');
  if (size.label === '1366') await page.screenshot({ path: path.join(dir, 'redis.png') });
  await page.getByRole('button', { name: '进程日志', exact: true }).click(); await selectLogTarget(page); await fits('#dcosRefresh');
  if (size.label === '1366') await page.screenshot({ path: path.join(dir, 'logs.png') });
  await page.getByRole('button', { name: '话单工具', exact: true }).click(); const frame = page.frameLocator('#cdrFrame'); await expect(frame.locator('#statTotal')).toHaveText('2'); await fits('#btnExport', frame);
  expect((await frame.locator('.table-wrap').boundingBox()).height).toBeGreaterThan(45);
  if (size.label === '1366') await page.screenshot({ path: path.join(dir, 'cdr.png') });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#btnConnect').click(); await fits('#connectionDialog');
  if (size.label === '1366') await page.screenshot({ path: path.join(dir, 'connections.png') });
  await page.keyboard.press('Escape'); expect(errors).toEqual([]);
});


test('cancelled file deletion cannot leak into a later workload confirmation; running workload operations lock their target', async ({ page }) => {
  await mockResources(page); await mockLogs(page);
  let deletions = 0, stops = 0, release, stopped = false;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/sftp/delete', route => { deletions++; return fulfill(route, { ok: true }); });
  await page.route('**/api/dcos/pods?*', route => fulfill(route, { pods: stopped ? [] : [{ name: 'billing-test-0', containers: ['billing'] }] }));
  await page.route('**/api/dcos/workload/stop', async route => { stops++; expect(route.request().postDataJSON().workloadName).toBe('billing-test'); expect(route.request().postDataJSON().workloadKind).toBe('StatefulSet'); await held; stopped = true; await fulfill(route, { ok: true }); });
  await page.goto('/'); await expect(page.locator('#fileList .resource-row')).toHaveCount(50);
  await page.locator('#fileList .resource-row').first().getByRole('button', { name: /^更多操作/ }).click();
  await page.locator('.row-action-menu:popover-open').getByRole('button', { name: '删除', exact: true }).click();
  await page.locator('#confirmDialog [data-dialog-close]').last().click();
  await page.getByRole('button', { name: '进程日志', exact: true }).click(); await selectLogTarget(page);
  await page.locator('#dcosStopWorkload').click(); await expect(page.locator('#confirmTarget')).toHaveText('321:bill-cnos-jf / StatefulSet / billing-test');
  await page.locator('#btnConfirmAction').click(); await expect(page.locator('#dcosCluster')).toBeDisabled(); await expect(page.locator('#dcosDisconnect')).toBeDisabled();
  expect(deletions).toBe(0); expect(stops).toBe(1);
  await page.getByRole('button', { name: '资源浏览', exact: true }).click(); release();
  await page.getByRole('button', { name: '进程日志', exact: true }).click(); await expect(page.locator('#dcosStartWorkload')).toBeEnabled();
  expect(deletions).toBe(0); expect(stops).toBe(1);
});

test('direct HBase routes load the restored connection; sample and RowKey views remain usable in the detail drawer', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await mockResources(page);
  await page.route('**/api/bigdata/status', route => fulfill(route, { connected: true, mode: 'client', config: { configured: true } }));
  await page.route('**/api/hbase/list', route => fulfill(route, { path: route.request().postDataJSON().path, items: route.request().postDataJSON().path === '/' ? [{ name: 'ns_test', path: '/ns_test', isDir: true }] : [{ name: 'TABLE', path: '/ns_test:TABLE', isDir: false }] }));
  let scans = 0;
  await page.route('**/api/hbase/scan', route => { scans++; return fulfill(route, { text: 'row-1 column=cf:value, timestamp=1760000000000, value=sample-value', rowCount: 1, truncated: false }); });
  await page.route('**/api/hbase/get', route => fulfill(route, { text: `${route.request().postDataJSON().rowKey} column=cf:value, value=exact-result`, rowCount: 1, truncated: false }));
  await page.goto('/#/resources/hbase'); await expect(page.locator('#hbaseList')).toContainText('ns_test'); await expect(page.locator('#statusText')).toHaveText('常驻客户端 · 已连接');
  await page.locator('#hbaseList').getByRole('button', { name: '进入', exact: true }).click(); await page.locator('#hbaseList').getByRole('button', { name: '查看', exact: true }).click();
  await expect(page.locator('#hbaseScanDialog')).toBeVisible(); await expect(page.locator('#hbaseScanText')).toContainText('sample-value');
  await page.locator('#hbaseScanLimit').selectOption('100'); await page.locator('#hbaseScanReload').click(); await expect.poll(() => scans).toBe(2);
  await page.locator('#hbaseRowKeyInput').fill('row-exact'); await page.locator('#hbaseRowKeyInput').press('Enter'); await expect(page.locator('#hbaseScanText')).toContainText('exact-result');
  await page.keyboard.press('Escape'); await expect(page.locator('#hbaseList')).toContainText('TABLE'); expect(errors).toEqual([]);
});

test('keyboard tab navigation updates routing and connection management opens the relevant environment', async ({ page }) => {
  await connected(page); await page.goto('/#/query/phone');
  const first = page.getByRole('tab', { name: '号码查产品', exact: true }); await first.focus(); await first.press('ArrowRight');
  await expect(page).toHaveURL(/#\/query\/productInstance$/); await expect(page.getByRole('tab', { name: '实例查档案', exact: true })).toBeFocused();
  await page.locator('#querySourceSelect').selectOption('voyage'); await page.locator('#btnConnect').click();
  await expect(page.locator('[data-connection-environment="project"]')).toHaveAttribute('open'); await expect(page.locator('[data-connection-environment="test"]')).not.toHaveAttribute('open');
  await page.keyboard.press('Escape'); await expect(page.locator('#btnConnect')).toBeFocused();
  await page.getByRole('tab', { name: '关系链查询', exact: true }).click(); await expect(page.locator('#querySourceSelect')).toBeDisabled(); await expect(page.locator('#querySourceNote')).toContainText('固定使用测试 PG');
  await page.locator('#btnConnect').click(); await expect(page.locator('[data-connection-environment="test"]')).toHaveAttribute('open');
});


test('CDR rejects saving an edit after an external session revision change', async ({ page, request }) => {
  await request.post('/cdr/api/reset', { data: {} }); await request.post('/cdr/api/load', { data: { filename: 'sample.json' } });
  await page.goto('/#/cdr'); const frame = page.frameLocator('#cdrFrame'); await expect(frame.locator('#statTotal')).toHaveText('2');
  await frame.getByRole('button', { name: '编辑', exact: true }).first().click(); await frame.getByLabel('CHARGE', { exact: true }).fill('9');
  const session = await (await request.get('/cdr/api/session')).json();
  await request.post('/cdr/api/record/1', { data: { updates: { CHARGE: 5 }, expected_revision: session.revision } });
  await frame.locator('#btnSaveEdit').click(); await expect(frame.locator('#editStatus')).toContainText('会话版本已变化'); await expect(frame.locator('#btnSaveEdit')).toBeDisabled();
  expect((await (await request.get('/cdr/api/record/0')).json()).record.CHARGE).toBe(1);
});

test('log target selection resumes after leaving during a cancelled namespace request', async ({ page }) => {
  await mockLogs(page);
  let reads = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/dcos/namespaces?*', async route => { reads++; if (reads === 1) await held; await fulfill(route, { namespaces: [{ name: 'bill-cnos-jf' }] }).catch(() => {}); });
  await page.goto('/#/logs'); await page.locator('#dcosCluster').selectOption('321'); await expect.poll(() => reads).toBe(1);
  await page.getByRole('button', { name: '资源浏览', exact: true }).click(); release();
  await page.getByRole('button', { name: '进程日志', exact: true }).click();
  await expect(page.locator('#dcosNamespace')).toBeEnabled(); await expect.poll(() => reads).toBe(2);
  await page.locator('#dcosNamespace').selectOption('bill-cnos-jf'); await expect(page.locator('#dcosWorkloadSearch')).toBeEnabled();
});

test('workload combobox searches both kinds without case sensitivity and clears stale selection', async ({ page }) => {
  const calls = await mockLogs(page);
  await page.goto('/#/logs'); await selectLogTarget(page);
  const search = page.locator('#dcosWorkloadSearch');
  await search.fill('BACKEND');
  await expect(page.locator('#dcosWorkload')).toHaveValue('');
  await expect(page.locator('#dcosStopWorkload')).toBeDisabled();
  await expect(page.getByRole('option', { name: 'billing-backend-test · 无状态 Deployment · 1 Pod', exact: true })).toBeVisible();
  await search.press('ArrowDown'); await search.press('Enter');
  await expect(page.locator('#dcosWorkload')).toHaveValue('Deployment/billing-backend-test');
  await expect.poll(() => calls.kinds.at(-1)).toBe('Deployment');
  await search.fill('no-matching-workload');
  await expect(page.locator('#dcosWorkloadOptions')).toContainText('没有匹配的工作负载');
  await expect(page.locator('#dcosPod')).toBeDisabled();
});
