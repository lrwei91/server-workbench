const test = require('node:test');
const assert = require('node:assert/strict');
const iconv = require('iconv-lite');
const { createDatabaseManager } = require('../../server/database');
const { repairBusinessText, repairUtf8AsGbk } = require('../../server/encoding');
const { queryPhone, queryProductInstance, queryCustomerProducts, queryAccountCandidates, queryThreshold, THRESHOLD_PRODUCT_ID, THRESHOLD_ATTR_IDS, utc8Iso } = require('../../server/phone-query');

test('database manager creates isolated UDAL pools, preserves values as strings, and never exposes passwords', async () => {
  const pools = [];
  const mysql = { createPool(options) { const pool = { options, ended: false, async query() { return [[{ ok: 1 }]]; }, async getConnection() { return { async query(query) { assert.equal(query.values[0], '13338297988'); return [[{ prod_inst_id: '9925377578', amount: '100.00000' }]]; }, release() {}, destroy() {} }; }, async end() { this.ended = true; } }; pools.push(pool); return pool; } };
  const manager = createDatabaseManager(mysql);
  const config = await manager.connect('udal', { host: 'HOST', port: 8901, username: 'USER', password: 'SECRET' });
  assert.equal(pools.length, 2); assert.deepEqual(pools.map((pool) => pool.options.database), ['CRM3DB', 'CONFIGDB_CNOS_JF_TEST']);
  assert.equal(pools.every((pool) => pool.options.multipleStatements === false && pool.options.charset === 'utf8mb4' && pool.options.bigNumberStrings === true && pool.options.dateStrings === true), true);
  assert.equal(JSON.stringify(config).includes('SECRET'), false); assert.equal(JSON.stringify(manager.status()).includes('SECRET'), false);
  const rows = await manager.query('udal', 'CRM3DB', 'SELECT * FROM prod_inst WHERE acc_num = ?', ['13338297988']);
  assert.equal(rows[0].prod_inst_id, '9925377578'); assert.equal(rows[0].amount, '100.00000');
  await manager.disconnect('udal'); assert.equal(pools.every((pool) => pool.ended), true);
});

test('business text repair reverses UTF-8 bytes decoded as GB18030 and preserves the source value', () => {
  const expected = '真实账户名称';
  const mojibake = iconv.decode(Buffer.from(expected, 'utf8'), 'gb18030');
  assert.equal(repairUtf8AsGbk(mojibake), expected);
  assert.equal(repairUtf8AsGbk('正常中文'), '正常中文');
  const [row] = repairBusinessText([{ ACCT_NAME: mojibake, contract_no: '123' }]);
  assert.equal(row.ACCT_NAME, expected);
  assert.equal(row.ACCT_NAME_原始值, mojibake);
  assert.equal(row.contract_no, '123');
});

test('query metadata uses an explicit UTC+8 offset', () => {
  assert.equal(utc8Iso(new Date('2026-09-15T02:35:26.813Z')), '2026-09-15T10:35:26.813+08:00');
});

test('database reconnect closes the previous source pools before switching configuration', async () => {
  const pools = []; const mysql = { createPool(options) { const pool = { options, ended: false, async query() { return [[{ ok: 1 }]]; }, async end() { this.ended = true; } }; pools.push(pool); return pool; } };
  const manager = createDatabaseManager(mysql);
  await manager.connect('udal', { host: 'FIRST', username: 'USER', password: 'ONE' });
  await manager.connect('udal', { host: 'SECOND', username: 'USER', password: 'TWO' });
  assert.equal(pools.slice(0, 2).every((pool) => pool.ended), true); assert.equal(manager.status().udal.config.host, 'SECOND');
  assert.equal(JSON.stringify(manager.status()).includes('ONE') || JSON.stringify(manager.status()).includes('TWO'), false);
  await manager.closeAll();
});

test('database query cancellation destroys the active connection instead of returning stale data', async () => {
  let rejectQuery; let destroyed = false; let released = false;
  const connection = { query() { return new Promise((_resolve, reject) => { rejectQuery = reject; }); }, destroy() { destroyed = true; rejectQuery?.(new Error('socket closed')); }, release() { released = true; } };
  const mysql = { createPool() { return { async query() { return [[{ ok: 1 }]]; }, async getConnection() { return connection; }, async end() {} }; } };
  const manager = createDatabaseManager(mysql); await manager.connect('doris', { host: 'HOST', username: 'USER' });
  const controller = new AbortController(); const pending = manager.query('doris', '', 'SELECT * FROM t WHERE id = ?', ['1'], { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, /查询已取消/); assert.equal(destroyed, true); assert.equal(released, false); await manager.closeAll();
});

function fixtureDb({ failAccount = false, missingPricing = false } = {}) {
  const calls = [];
  const query = async (source, database, sql, values) => {
    calls.push({ source, database, sql, values }); const id = String(values[0]);
    if (/FROM prod_inst WHERE acc_num/.test(sql)) return [
      { prod_inst_id: '11', PROD_ID: '101', acc_prod_inst_id: '11', acc_num: id, OWNER_CUST_ID: '900' },
      { prod_inst_id: '12', PROD_ID: '102', acc_prod_inst_id: '11', acc_num: id, OWNER_CUST_ID: '900' },
    ];
    if (/FROM prod_inst WHERE prod_inst_id/.test(sql)) return [{ prod_inst_id: id, PROD_ID: '101', acc_num: '13338297988', OWNER_CUST_ID: '900' }];
    if (/FROM product WHERE/.test(sql)) return [{ prod_id: id, prod_name: `产品${id}` }];
    if (/FROM prod_inst_acct_rel/.test(sql)) { if (failAccount) throw new Error('账户分片查询失败'); return [{ prod_inst_acct_rel_id: `r${id}`, PROD_INST_ID: id, ACCT_ID: id === '11' ? '501' : '502' }]; }
    if (/FROM account WHERE acct_id/.test(sql)) return [{ acct_id: id, contract_no: `C${id}` }];
    if (/FROM offer_prod_inst_rel/.test(sql)) return [{ offer_prod_inst_rel_id: `o${id}`, PROD_INST_ID: id, OFFER_INST_ID: '701' }];
    if (/FROM offer_inst WHERE/.test(sql)) return [{ offer_inst_id: id, offer_id: '801' }];
    if (/FROM offer WHERE/.test(sql)) return [{ offer_id: id, offer_name: '共享套餐', pricing_plan_id: '901' }];
    if (/FROM pricing_plan/.test(sql)) return missingPricing ? [] : [{ pricing_plan_id: id, pricing_plan_name: '计划' }];
    if (/OWNER_CUST_ID =/.test(sql)) return [{ prod_inst_id: '13', acc_num: 'OTHER' }];
    if (/FROM account WHERE PROD_INST_ID/.test(sql)) return [{ acct_id: '501', PROD_INST_ID: id }];
    if (/FROM account WHERE CUST_ID/.test(sql)) return [{ acct_id: '501', CUST_ID: id }, { acct_id: '503', CUST_ID: id }];
    return [];
  };
  return { calls, query };
}

test('phone query aggregates multi-product and multi-account data while deduplicating shared offers', async () => {
  const db = fixtureDb(); const result = await queryPhone(db, ' 13338297988 ');
  assert.equal(result.status, 'complete'); assert.equal(result.phone, '13338297988');
  assert.equal(result.data.productInstances.length, 2); assert.equal(result.data.accounts.length, 2);
  assert.equal(result.data.offerRelations.length, 2); assert.equal(result.data.offerInstances.length, 1); assert.equal(result.data.offers.length, 1);
  assert.equal(db.calls.filter((call) => /FROM offer_inst WHERE/.test(call.sql)).length, 1);
  assert.equal(db.calls.every((call) => call.values.length === 1 && call.sql.includes('?')), true);
});

test('phone query supports Voyage lower-case columns and records the selected source', async () => {
  const base = fixtureDb();
  const db = { calls: base.calls, query: async (source, database, sql, values) => {
    const rows = await base.query(source, database, sql, values);
    return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])));
  } };
  const result = await queryPhone(db, '15305972490', { source: 'voyage' });
  assert.equal(result.status, 'complete'); assert.equal(result.source, 'voyage');
  assert.equal(result.data.accounts.length, 2); assert.equal(result.data.offers.length, 1);
  assert.equal(result.steps.every((step) => step.source === 'voyage'), true);
  assert.equal(db.calls.every((call) => call.source === 'voyage'), true);
});

test('product instance query reuses the archive chain and preserves a large string id', async () => {
  const db = fixtureDb(); const id = '9007199254740993'; const result = await queryProductInstance(db, id, { source: 'voyage' });
  assert.equal(result.productInstanceId, id); assert.equal(result.source, 'voyage'); assert.equal(result.status, 'complete');
  assert.equal(result.data.productInstances[0].prod_inst_id, id); assert.equal(result.data.accounts.length, 1); assert.equal(result.data.offers.length, 1);
  assert.equal(db.calls[0].source, 'voyage'); assert.match(db.calls[0].sql, /prod_inst_id = \?/); assert.deepEqual(db.calls[0].values, [id]);
  await assert.rejects(queryProductInstance(db, 'ABC'), /必须是数字/);
});

test('phone query distinguishes empty, missing definition, and partial branch failures', async () => {
  const emptyDb = { query: async () => [] }; const empty = await queryPhone(emptyDb, 'NO_MATCH'); assert.equal(empty.status, 'empty');
  const missing = await queryPhone(fixtureDb({ missingPricing: true }), 'PHONE'); assert.equal(missing.status, 'partial'); assert.deepEqual(missing.data.pricingPlans, []);
  const partial = await queryPhone(fixtureDb({ failAccount: true }), 'PHONE'); assert.equal(partial.status, 'partial'); assert.equal(partial.data.offers.length, 1); assert.equal(partial.steps.some((step) => step.status === 'error'), true);
});

test('phone query cancellation and disconnected database propagate immediately', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(queryPhone({ query: async () => [] }, 'PHONE', { signal: controller.signal }), /查询已取消/);
  await assert.rejects(queryPhone({ query: async () => { throw new Error('MySQL / UDAL 尚未连接'); } }, 'PHONE'), /尚未连接/);
});

test('on-demand customer products and account candidates keep candidate semantics and deduplicate accounts', async () => {
  const db = fixtureDb(); const products = await queryCustomerProducts(db, '900'); assert.equal(products.rows[0].acc_num, 'OTHER');
  const candidates = await queryAccountCandidates(db, { productInstanceId: '11', customerId: '900' });
  assert.equal(candidates.candidate, true); assert.deepEqual(candidates.rows.map((row) => row.acct_id), ['501', '503']);
});

test('threshold query follows A/Z relations with fixed single-table parameterized steps', async () => {
  const calls = [];
  const db = { query: async (_source, database, sql, values) => {
    calls.push({ database, sql, values });
    if (/FROM prod_inst_rel/.test(sql)) return [{ a_prod_inst_id: '48243980', z_prod_inst_id: '7001' }, { a_prod_inst_id: '48243980', z_prod_inst_id: '7001' }, { a_prod_inst_id: '48243980', z_prod_inst_id: '7002' }];
    if (/FROM prod_inst WHERE/.test(sql)) return values[0] === '7001' ? [{ prod_inst_id: '7001', PROD_ID: THRESHOLD_PRODUCT_ID }] : [];
    if (/FROM prod_inst_attr/.test(sql)) return [{ prod_inst_attr_id: '9001', prod_inst_id: values[0], attr_id: '800053985', attr_value: '1' }];
    return [];
  } };
  const result = await queryThreshold(db, ' 48243980 ');
  assert.equal(result.status, 'complete'); assert.equal(result.aProductInstanceId, '48243980');
  assert.deepEqual(result.data.terminalProducts.map((row) => row.prod_inst_id), ['7001']);
  assert.equal(result.data.thresholdAttributes[0].threshold_level, '80%');
  assert.equal(calls.filter((call) => /FROM prod_inst WHERE/.test(call.sql)).length, 2);
  assert.equal(calls.every((call) => call.database === 'CRM3DB' && call.values.length === 1 && call.sql.includes('?') && !/\bJOIN\b|\bSELECT\b[\s\S]*\bSELECT\b/i.test(call.sql)), true);
  assert.deepEqual(THRESHOLD_ATTR_IDS, ['800053983', '800053984', '800053985', '800053986', '800053987', '800053988']);
});

test('threshold query distinguishes no relation, no matching terminal, and missing threshold attributes', async () => {
  const noRelation = await queryThreshold({ query: async () => [] }, 'A1'); assert.equal(noRelation.status, 'empty');
  const noTerminal = await queryThreshold({ query: async (_source, _database, sql) => /FROM prod_inst_rel/.test(sql) ? [{ z_prod_inst_id: 'Z1' }] : [] }, 'A1'); assert.equal(noTerminal.status, 'empty');
  const missingAttr = await queryThreshold({ query: async (_source, _database, sql) => /FROM prod_inst_rel/.test(sql) ? [{ z_prod_inst_id: 'Z1' }] : /FROM prod_inst WHERE/.test(sql) ? [{ prod_inst_id: 'Z1', PROD_ID: THRESHOLD_PRODUCT_ID }] : [] }, 'A1'); assert.equal(missingAttr.status, 'partial');
  await assert.rejects(queryThreshold({ query: async () => [] }, ' '), /A 端产品实例 ID/);
});
