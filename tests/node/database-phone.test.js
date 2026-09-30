const test = require('node:test');
const assert = require('node:assert/strict');
const iconv = require('iconv-lite');
const { createDatabaseManager } = require('../../server/database');
const { repairBusinessText, repairUtf8AsGbk } = require('../../server/encoding');
const { queryPhone, queryProductInstance, queryCustomerProducts, queryAccountCandidates, queryOffer, queryEventType, queryThreshold, THRESHOLD_PRODUCT_ID, THRESHOLD_ATTR_IDS, EVENT_TYPE_CATALOG, VOYAGE_BILL_INMEMORY_TABLE_MAP, mapQueryTables, utc8Iso } = require('../../server/phone-query');

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

test('PostgreSQL connection uses its own driver and masks credentials', async () => {
  const pools = [];
  const pg = { Pool: class {
    constructor(options) { this.options = options; this.ended = false; pools.push(this); }
    async query(sql) { assert.equal(sql, 'SELECT 1 AS ok'); return { rows: [{ ok: 1 }] }; }
    async end() { this.ended = true; }
  } };
  const mysql = { createPool() { throw new Error('PostgreSQL must not use mysql2'); } };
  const manager = createDatabaseManager(mysql, pg);
  const result = await manager.connect('pg', { host: 'HOST', port: 18801, username: 'USER', password: 'SECRET', database: 'DB' });
  assert.equal(pools[0].options.database, 'DB');
  assert.equal(pools[0].options.password, 'SECRET');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(JSON.stringify(manager.status()).includes('SECRET'), false);
  assert.equal(manager.status().pg.connected, true);
  await manager.disconnect('pg');
  assert.equal(pools[0].ended, true);
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

test('Voyage bill_inmemory maps logical CRM archive tables to physical table names', () => {
  assert.equal(VOYAGE_BILL_INMEMORY_TABLE_MAP.offer_inst, 'prod_offer_inst');
  const mapped = mapQueryTables('SELECT * FROM offer_inst WHERE offer_id = ?', 'voyage', 'bill_inmemory');
  assert.match(mapped.sql, /FROM prod_offer_inst WHERE/);
  assert.deepEqual(mapped.tableMap, [{ logicalTable: 'offer_inst', physicalTable: 'prod_offer_inst' }]);
  assert.match(mapQueryTables('SELECT * FROM prod_inst WHERE acc_num = ?', 'voyage', 'bill_inmemory').sql, /acc_nbr = \?/);
  assert.match(mapQueryTables('SELECT * FROM offer_inst WHERE offer_inst_id = ?', 'voyage', 'bill_inmemory').sql, /FROM prod_offer_inst WHERE prod_offer_inst_id = \?/);
  assert.equal(mapQueryTables('SELECT * FROM pricing_plan WHERE pricing_plan_id = ?', 'voyage', 'bill_inmemory').sql, 'SELECT * FROM pricing_plan WHERE pricing_plan_id = ?');
  assert.equal(mapQueryTables('SELECT * FROM offer_inst WHERE offer_id = ?', 'voyage', 'crmv3').sql, 'SELECT * FROM offer_inst WHERE offer_id = ?');
  assert.match(mapQueryTables('SELECT * FROM offer_inst_attr WHERE offer_inst_id = ?', 'voyage', 'bill_inmemory').sql, /FROM prod_offer_inst_attr WHERE/);
  assert.match(mapQueryTables('SELECT * FROM prod_inst_acct_rel WHERE prod_inst_id = ?', 'voyage', 'bill_inmemory').sql, /FROM prod_inst_acct WHERE/);
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

function fixtureDb({ failAccount = false, failExtension = false, missingPricing = false } = {}) {
  const calls = [];
  const query = async (source, database, sql, values, options = {}) => {
    calls.push({ source, database, sql, values, options }); const id = String(values[0]);
    if (/FROM source_event_type_format/.test(sql)) return [{ SOURCE_EVENT_TYPE_ID: '8', EVENT_TYPE_ID: '206080000', SOURCE_EVENT_FORMAT_ID: '3001', VERSION: '1' }];
    if (/FROM ratable_event_type_format/.test(sql)) return [{ EVENT_FORMAT_ID: '4001', EVENT_TYPE_ID: '206080000', MODULE_ID: '1' }];
    if (/FROM ratable_event_format WHERE/.test(sql)) return [{ EVENT_FORMAT_ID: id, CH_NAME: 'CDMA集团格式' }];
    if (/FROM ratable_event_format_item/.test(sql)) return [{ EVENT_FORMAT_ID: id, EVENT_ATTR_ID: '5001', SORT_ID: '1' }];
    if (/FROM tpr_resource_attr/.test(sql)) return [{ ATTR_ID: id, EN_NAME: 'SOURCE_EVENT_TYPE_ID', CH_NAME: '源事件类型' }];
    if (/FROM TPL_INDB_TABLE_PG/.test(sql)) return [{ EVENT_TYPE_ID: '206080000', TABLE_NAME: 'TICKET_CDMA_GROUP_597_2606', BILLING_CYCLE_ID: '202609' }];
    if (/SELECT DISTINCT o\.\*/.test(sql)) return [{ offer_id: '801', offer_name: '共享套餐', pricing_plan_id: '901', status_cd: '1000' }];
    if (/FROM event_pricing_strategy/.test(sql)) return [{ EVENT_PRICING_STRATEGY_ID: '610', EVENT_TYPE_ID: '206080100' }];
    if (/FROM pricing_combine/.test(sql)) return [{ PRICING_COMBINE_ID: '611', EVENT_PRICING_STRATEGY_ID: id, PRICING_OBJECT_ID: '620', PRICING_PLAN_ID: '901' }];
    if (/FROM pricing_object/.test(sql)) return [{ PRICING_OBJECT_ID: id, OBJECT_TYPE: '1', OBJECT_ID: '801' }];
    if (/FROM prod_inst WHERE acc_num/.test(sql)) return [
      { prod_inst_id: '11', PROD_ID: '101', acc_prod_inst_id: '11', acc_num: id, OWNER_CUST_ID: '900' },
      { prod_inst_id: '12', PROD_ID: '102', acc_prod_inst_id: '11', acc_num: id, OWNER_CUST_ID: '900' },
    ];
    if (/FROM prod_inst_rel WHERE a_prod_inst_id/.test(sql)) return [{ prod_inst_rel_id: `az${id}`, a_prod_inst_id: id, z_prod_inst_id: '777' }];
    if (/FROM prod_inst_rel WHERE z_prod_inst_id/.test(sql)) return [{ prod_inst_rel_id: `za${id}`, a_prod_inst_id: '778', z_prod_inst_id: id }];
    if (/FROM prod_inst_attr WHERE prod_inst_id/.test(sql)) return [{ prod_inst_attr_id: `pa${id}`, prod_inst_id: id, attr_id: '800000251' }];
    if (/FROM prod_inst_state/.test(sql)) { if (failExtension) throw new Error('状态档案查询失败'); return [{ prod_inst_state_id: `ps${id}`, prod_inst_id: id }]; }
    if (/FROM prod_inst_ext/.test(sql)) return [{ prod_inst_id: id, ext_value: '扩展' }];
    if (/FROM prod_inst_contact/.test(sql)) return [{ prod_inst_contact_id: `pc${id}`, prod_inst_id: id }];
    if (/FROM prod_inst_paymode/.test(sql)) return [{ prod_inst_id: id, pay_mode: '1' }];
    if (/FROM prod_inst_acc_num/.test(sql)) return [{ prod_inst_id: id, acc_num: '13338297988' }];
    if (/FROM prod_inst_acc_nbr_rela/.test(sql)) return [{ prod_inst_id: id, acc_nbr: '13338297988' }];
    if (/FROM prod_inst_party/.test(sql)) return [{ prod_inst_id: id, party_id: 'P1' }];
    if (/FROM prod_res_inst_rel/.test(sql)) return [{ prod_inst_id: id, res_inst_id: 'R1' }];
    if (/FROM prod_inst WHERE prod_inst_id/.test(sql)) return [{ prod_inst_id: id, PROD_ID: '101', acc_prod_inst_id: id === '9007199254740993' ? '779' : id, acc_num: '13338297988', OWNER_CUST_ID: '900' }];
    if (/FROM product WHERE/.test(sql)) return [{ prod_id: id, prod_name: `产品${id}` }];
    if (/FROM prod_inst_acct_rel/.test(sql)) { if (failAccount) throw new Error('账户分片查询失败'); return [{ prod_inst_acct_rel_id: `r${id}`, PROD_INST_ID: id, ACCT_ID: id === '11' ? '501' : '502' }]; }
    if (/FROM account WHERE acct_id/.test(sql)) return [{ acct_id: id, contract_no: `C${id}` }];
    if (/FROM offer_prod_inst_rel WHERE OFFER_INST_ID/.test(sql)) return [{ offer_prod_inst_rel_id: `oi${id}`, PROD_INST_ID: '11', OFFER_INST_ID: id }];
    if (/FROM offer_prod_inst_rel/.test(sql)) return [{ offer_prod_inst_rel_id: `o${id}`, PROD_INST_ID: id, OFFER_INST_ID: '701' }];
    if (/FROM offer_inst_rel WHERE A_OFFER_INST_ID/.test(sql)) return [{ offer_inst_rel_id: `oira${id}`, A_OFFER_INST_ID: id, Z_OFFER_INST_ID: '702' }];
    if (/FROM offer_inst_rel WHERE Z_OFFER_INST_ID/.test(sql)) return [{ offer_inst_rel_id: `oirz${id}`, A_OFFER_INST_ID: '703', Z_OFFER_INST_ID: id }];
    if (/FROM (?:offer_inst|prod_offer_inst) WHERE OFFER_ID/.test(sql)) return [{ offer_inst_id: '701', offer_id: id }];
    if (/FROM offer_inst WHERE/.test(sql)) return [{ offer_inst_id: id, offer_id: '801' }];
    if (/FROM offer_inst_attr/.test(sql)) return [{ offer_inst_attr_id: `oa${id}`, offer_inst_id: id }];
    if (/FROM offer_inst_fee_info/.test(sql)) return [{ offer_inst_fee_info_id: `of${id}`, offer_inst_id: id }];
    if (/FROM offer_inst_fee_attr/.test(sql)) return [{ offer_inst_fee_attr_id: `ofa${id}`, offer_inst_fee_info_id: id }];
    if (/FROM offer_obj_inst_rel/.test(sql)) return [{ offer_obj_inst_rel_id: `oo${id}`, offer_inst_id: id }];
    if (/FROM offer_res_inst_rel/.test(sql)) return [{ offer_res_inst_rel_id: `or${id}`, offer_inst_id: id }];
    if (/FROM offer_inst_assure/.test(sql)) return [{ offer_inst_assure_id: `oas${id}`, offer_inst_id: id }];
    if (/FROM offer_coupon_inst_rel/.test(sql)) return [{ offer_coupon_inst_rel_id: `oc${id}`, offer_inst_id: id }];
    if (/FROM sku_inst/.test(sql)) return [{ sku_inst_id: `sku${id}`, offer_inst_id: id }];
    if (/FROM va_order_rel/.test(sql)) return [{ va_order_rel_id: `va${id}`, offer_inst_id: id }];
    if (/FROM offer WHERE PRICING_PLAN_ID/.test(sql)) return [{ offer_id: '801', offer_name: '共享套餐', pricing_plan_id: id }];
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

test('phone query supports Voyage lower-case columns and propagates the selected schema', async () => {
  const base = fixtureDb();
  const db = { calls: base.calls, query: async (source, database, sql, values, options) => {
    const rows = await base.query(source, database, sql, values, options);
    return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])));
  } };
  const result = await queryPhone(db, '15305972490', { source: 'voyage', schema: 'crmv3' });
  assert.equal(result.status, 'complete'); assert.equal(result.source, 'voyage'); assert.equal(result.schema, 'crmv3');
  assert.equal(result.data.accounts.length, 2); assert.equal(result.data.offers.length, 1);
  assert.equal(result.steps.every((step) => step.source === 'voyage'), true);
  assert.equal(result.steps.every((step) => step.schema === 'crmv3'), true);
  assert.equal(db.calls.every((call) => call.source === 'voyage'), true);
  assert.equal(db.calls.every((call) => call.options.schema === 'crmv3'), true);
});

test('Voyage bill_inmemory phone lookup uses acc_nbr and preserves it as the access number', async () => {
  const calls = []; const db = { query: async (source, database, sql, values, options) => {
    calls.push({ source, database, sql, values, options });
    if (/FROM prod_inst WHERE acc_nbr =/.test(sql)) return [{ prod_inst_id: '11', prod_id: '101', owner_cust_id: '900', acc_nbr: values[0] }];
    return [];
  } };
  const result = await queryPhone(db, '18959025796', { source: 'voyage', schema: 'bill_inmemory' });
  assert.equal(result.data.productInstances[0].acc_nbr, '18959025796'); assert.match(calls[0].sql, /acc_nbr = \?/);
  assert.deepEqual(result.steps[0].columnMap, [{ logicalColumn: 'acc_num', physicalColumn: 'acc_nbr' }]);
});

test('Voyage bill_inmemory product relation uses physical A/Z columns and keeps logical result fields', async () => {
  const mappedA = mapQueryTables('SELECT * FROM prod_inst_rel WHERE a_prod_inst_id = ? LIMIT 500', 'voyage', 'bill_inmemory');
  const mappedZ = mapQueryTables('SELECT * FROM prod_inst_rel WHERE z_prod_inst_id = ? LIMIT 500', 'voyage', 'bill_inmemory');
  assert.match(mappedA.sql, /WHERE prod_inst_a_id = \?/); assert.match(mappedZ.sql, /WHERE prod_inst_z_id = \?/);
  assert.deepEqual(mappedA.columnMap, [{ logicalColumn: 'a_prod_inst_id', physicalColumn: 'prod_inst_a_id' }]);
  assert.match(mapQueryTables('SELECT * FROM prod_inst_rel WHERE a_prod_inst_id = ?', 'voyage', 'crmv3').sql, /a_prod_inst_id = \?/);
  assert.match(mapQueryTables('SELECT * FROM prod_inst_rel WHERE a_prod_inst_id = ?', 'udal').sql, /a_prod_inst_id = \?/);
  const calls = []; const db = { query: async (_source, _database, sql, values) => {
    calls.push({ sql, values });
    if (/FROM prod_inst WHERE prod_inst_id/.test(sql)) return [{ prod_inst_id: values[0] }];
    if (/FROM prod_inst_rel WHERE prod_inst_a_id/.test(sql)) return [{ prod_inst_a_id: '1254240', prod_inst_z_id: '7001' }];
    if (/FROM prod_inst_rel WHERE prod_inst_z_id/.test(sql)) return [{ prod_inst_a_id: '7002', prod_inst_z_id: '1254240' }];
    return [];
  } };
  const result = await queryProductInstance(db, '1254240', { source: 'voyage', schema: 'bill_inmemory' });
  assert.deepEqual(result.data.relatedProductInstances.map((row) => row.prod_inst_id).sort(), ['7001', '7002']);
  assert.deepEqual(result.data.productRelationships[0], { a_prod_inst_id: '1254240', z_prod_inst_id: '7001' });
  assert.equal(calls.some((call) => /FROM prod_inst_rel WHERE a_prod_inst_id|FROM prod_inst_rel WHERE z_prod_inst_id/.test(call.sql)), false);
  const threshold = await queryThreshold(db, '1254240', { source: 'voyage', schema: 'bill_inmemory' });
  assert.deepEqual(threshold.data.relationships[0], { a_prod_inst_id: '1254240', z_prod_inst_id: '7001' });
  assert.equal(calls.some((call) => /FROM prod_inst WHERE prod_id = 900178630/.test(call.sql) && call.values[0] === '7001'), true);
});

test('product instance query reuses the archive chain and preserves a large string id', async () => {
  const db = fixtureDb(); const id = '9007199254740993'; const result = await queryProductInstance(db, id, { source: 'voyage' });
  assert.equal(result.productInstanceId, id); assert.equal(result.source, 'voyage'); assert.equal(result.status, 'complete');
  assert.equal(result.data.productInstances[0].prod_inst_id, id); assert.equal(result.data.accounts.length, 1); assert.equal(result.data.offers.length, 1);
  assert.deepEqual(result.data.accessProductInstances.map((row) => row.prod_inst_id), ['779']);
  assert.equal(result.data.productRelationships.length, 2); assert.deepEqual(result.data.relatedProductInstances.map((row) => row.prod_inst_id).sort(), ['777', '778']);
  assert.equal(result.data.productAttributes.length, 1); assert.equal(result.data.productStates.length, 1); assert.equal(result.data.productExtensions.length, 1);
  assert.equal(result.data.productContacts.length, 1); assert.equal(result.data.productPaymodes.length, 1); assert.equal(result.data.productAccessNumbers.length, 1);
  assert.equal(result.data.productNumberRelations.length, 1); assert.equal(result.data.productParties.length, 1); assert.equal(result.data.productResourceRelations.length, 1);
  assert.equal(result.data.offerInstanceRelationships.length, 2); assert.deepEqual(result.data.relatedOfferInstances.map((row) => row.offer_inst_id).sort(), ['702', '703']);
  assert.equal(result.data.offerInstanceAttributes.length, 3); assert.equal(result.data.offerInstanceFees.length, 3); assert.equal(result.data.offerInstanceFeeAttributes.length, 3);
  assert.equal(result.data.offerObjectInstanceRelations.length, 3); assert.equal(result.data.offerResourceInstanceRelations.length, 3);
  assert.equal(result.data.offerInstanceAssurances.length, 3); assert.equal(result.data.offerCouponInstanceRelations.length, 3);
  assert.equal(result.data.skuInstances.length, 3); assert.equal(result.data.valueAddedOrderRelations.length, 3);
  assert.equal(db.calls.filter((call) => /FROM prod_inst_rel/.test(call.sql)).length, 2);
  assert.equal(db.calls.filter((call) => /FROM offer_inst_rel/.test(call.sql)).length, 2);
  assert.equal(db.calls[0].source, 'voyage'); assert.match(db.calls[0].sql, /prod_inst_id = \?/); assert.deepEqual(db.calls[0].values, [id]);
  await assert.rejects(queryProductInstance(db, 'ABC'), /必须是数字/);
});

test('archive extension failures keep successful product-instance data and mark the result partial', async () => {
  const result = await queryProductInstance(fixtureDb({ failExtension: true }), '123');
  assert.equal(result.status, 'partial'); assert.equal(result.data.productAttributes.length, 1);
  assert.equal(result.data.productStates.length, 0); assert.equal(result.steps.some((step) => step.name.startsWith('产品实例状态') && step.status === 'error'), true);
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

test('event type query returns format configuration and reverse-finds owning product instances', async () => {
  const db = fixtureDb(); const result = await queryEventType(db, '206080000', { source: 'udal' });
  assert.equal(EVENT_TYPE_CATALOG[0].routeEventTypeId, '206080000'); assert.equal(result.status, 'complete'); assert.equal(result.definition.name, 'CDMA 集团');
  assert.equal(result.data.eventTypeMappings.length, 1); assert.equal(result.data.eventTypeFormats.length, 1); assert.equal(result.data.eventFormats.length, 1);
  assert.equal(result.data.eventFormatItems.length, 1); assert.equal(result.data.resourceAttributes.length, 1); assert.equal(result.data.targetTables[0].TABLE_NAME, 'TICKET_CDMA_GROUP_597_2606');
  assert.equal(result.data.eventPricingStrategies[0].EVENT_PRICING_STRATEGY_ID, '610');
  assert.equal(result.data.pricingCombines[0].PRICING_COMBINE_ID, '611'); assert.equal(result.data.pricingObjects[0].PRICING_OBJECT_ID, '620');
  assert.equal(result.data.pricingPlans[0].pricing_plan_id, '901'); assert.equal(result.data.offers[0].offer_id, '801');
  assert.equal(result.data.offerInstances[0].offer_inst_id, '701'); assert.equal(result.data.offerRelations[0].PROD_INST_ID, '11'); assert.equal(result.data.productInstances[0].prod_inst_id, '11');
  assert.equal(result.data.subscribers[0].OWNER_CUST_ID, ''); assert.equal(result.data.subscribers[0].ACC_NUM, '13338297988');
  assert.equal(db.calls.some((call) => call.database === 'CONFIGDB_CNOS_JF_TEST'), true); assert.equal(db.calls.some((call) => call.database === 'CRM3DB'), true);
  assert.equal(result.schema, undefined);
  assert.equal(db.calls.every((call) => call.source === 'udal' && call.options.schema === undefined), true);
  assert.deepEqual(result.eventTypeFamily, { start: '206080000', endExclusive: '206081000' });
  assert.deepEqual(db.calls.find((call) => /event_pricing_strategy WHERE EVENT_TYPE_ID/.test(call.sql)).values, ['206080000', '206081000']);
  assert.equal(db.calls.filter((call) => /\bJOIN\b/i.test(call.sql)).length, 1);
  assert.deepEqual(db.calls.find((call) => /source_event_type_format/.test(call.sql)).values, ['8', '206080000', '206080000', '206080000']);
  await assert.rejects(queryEventType(db, 'ABC'), /必须是数字/);
});

test('offer query uses offer_id directly and follows the UDAL subscription chain', async () => {
  const db = fixtureDb(); const result = await queryOffer(db, ' 801 ');
  assert.equal(result.offerId, '801'); assert.equal(result.status, 'complete');
  assert.equal(result.data.offers[0].offer_id, '801'); assert.equal(result.data.offerInstances[0].offer_inst_id, '701');
  assert.equal(result.data.subscribers[0].PROD_INST_ID, '11');
  assert.deepEqual(db.calls[0].values, ['801']); assert.match(db.calls[0].sql, /FROM offer WHERE offer_id = \?/);
  assert.equal(db.calls.some((call) => /event_pricing_strategy|source_event_type_format/.test(call.sql)), false);
  await assert.rejects(queryOffer(db, 'abc'), /offer_id 必须是数字/);
});

test('offer query maps offer_id to Voyage bill_inmemory offer_ces', async () => {
  const calls = []; const db = { query: async (source, database, sql, values, options) => {
    calls.push({ source, database, sql, values, options });
    if (/FROM offer_ces WHERE offer_id/.test(sql)) return [{ offer_id: '801', offer_name: '集团套餐' }];
    if (/FROM prod_offer_inst WHERE/.test(sql)) return [{ prod_offer_inst_id: '701', offer_id: '801' }];
    if (/FROM offer_prod_inst_rel/.test(sql)) return [{ prod_offer_inst_id: '701', prod_inst_id: '11' }];
    if (/FROM prod_offer_inst_attr/.test(sql)) return [{ prod_offer_inst_id: '701', attr_id: 'A1' }];
    if (/FROM prod_inst WHERE/.test(sql)) return [{ prod_inst_id: '11', owner_cust_id: '900', acc_nbr: '13338297988' }];
    return [];
  } };
  const result = await queryOffer(db, '801', { source: 'voyage', schema: 'bill_inmemory' });
  assert.equal(result.status, 'complete'); assert.equal(result.data.subscribers[0].ACC_NUM, '13338297988');
  assert.equal(result.data.offerInstanceAttributes.length, 1);
  assert.deepEqual(calls[0].values, ['801']); assert.equal(calls.every((call) => call.source === 'voyage' && call.options.schema === 'bill_inmemory'), true);
  assert.equal(calls.some((call) => /offer_name LIKE/.test(call.sql)), false);
});

test('engineering event query follows offer name to instance, attributes, relations, and products within Voyage', async () => {
  const calls = []; const db = { query: async (source, database, sql, values, options) => {
    calls.push({ source, database, sql, values, options });
    if (/FROM offer_ces/.test(sql)) return [{ offer_id: '801', offer_name: 'CDMA集团套餐' }];
    if (/FROM prod_offer_inst WHERE/.test(sql)) return [{ prod_offer_inst_id: '701', offer_id: '801', status_cd: '1000' }];
    if (/FROM offer_prod_inst_rel/.test(sql)) return [{ prod_offer_inst_id: '701', prod_inst_id: '11' }];
    if (/FROM prod_offer_inst_attr/.test(sql)) return [{ prod_offer_inst_id: '701', attr_id: 'A1', attr_value: 'V1' }];
    if (/FROM prod_inst WHERE/.test(sql)) return [{ prod_inst_id: '11', owner_cust_id: '900', acc_num: '13338297988', prod_id: '101', status_cd: '1000' }];
    return [];
  } };
  const result = await queryEventType(db, '206080000', { source: 'voyage', schema: 'bill_inmemory' });
  assert.equal(result.status, 'complete'); assert.equal(result.source, 'voyage'); assert.equal(result.schema, 'bill_inmemory'); assert.equal(result.offerNameQuery, 'CDMA 集团');
  assert.equal(result.data.offers[0].offer_id, '801'); assert.equal(result.data.offerInstances[0].prod_offer_inst_id, '701');
  assert.equal(result.data.offerInstanceAttributes[0].attr_id, 'A1'); assert.equal(result.data.productInstances[0].prod_inst_id, '11');
  assert.equal(result.data.subscribers[0].ACC_NUM, '13338297988'); assert.equal(result.data.subscribers[0].OWNER_CUST_ID, '900');
  assert.equal(calls[0].values[0], '%CDMA%集团%'); assert.equal(calls.every((call) => call.source === 'voyage' && call.options.schema === 'bill_inmemory'), true);
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
  const noRelation = await queryThreshold({ query: async () => [] }, '11'); assert.equal(noRelation.status, 'empty');
  const noTerminal = await queryThreshold({ query: async (_source, _database, sql) => /FROM prod_inst_rel/.test(sql) ? [{ z_prod_inst_id: '21' }] : [] }, '11'); assert.equal(noTerminal.status, 'empty');
  const missingAttr = await queryThreshold({ query: async (_source, _database, sql) => /FROM prod_inst_rel/.test(sql) ? [{ z_prod_inst_id: '21' }] : /FROM prod_inst WHERE/.test(sql) ? [{ prod_inst_id: '21', PROD_ID: THRESHOLD_PRODUCT_ID }] : [] }, '11'); assert.equal(missingAttr.status, 'partial');
  await assert.rejects(queryThreshold({ query: async () => [] }, ' '), /A 端产品实例 ID/);
  await assert.rejects(queryThreshold({ query: async () => [] }, 'ABC'), /必须是数字/);
});
