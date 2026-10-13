const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabaseManager } = require('../../server/database');
const { queryPhone, queryProductInstance, queryOffer, queryEventType, queryThreshold, mapQueryTables } = require('../../server/phone-query');
const { RELATION_QUERIES, queryArchiveRelations } = require('../../server/archive-relations');

function fixture({ configMissing = false, missingMembers = false } = {}) {
  const calls = [];
  return { calls, async query(source, database, sql, values) {
    calls.push({ source, database, sql, values });
    if (source === 'udal') {
      assert.equal(database, 'CONFIGDB_CNOS_JF_TEST');
      if (configMissing) throw new Error('MySQL / UDAL 尚未连接');
      if (/FROM offer\b/i.test(sql) || /SELECT DISTINCT o\.\*/.test(sql)) return [{ offer_id: '801', pricing_plan_id: '901', ibs_offer_type: '30010', offer_name: '测试配置' }];
      if (/FROM pricing_plan\b/.test(sql)) return [{ pricing_plan_id: '901' }];
      if (/FROM event_pricing_strategy\b/.test(sql)) return [{ EVENT_PRICING_STRATEGY_ID: '610', EVENT_TYPE_ID: '206080100' }];
      if (/FROM pricing_combine\b/.test(sql)) return [{ PRICING_PLAN_ID: '901' }];
      return [];
    }
    assert.equal(source, 'pg'); assert.equal(database, 'bill_inmemory');
    assert.match(sql, /FROM bill_inmemory\./); assert.doesNotMatch(sql, /\?/);
    const table = sql.match(/FROM bill_inmemory\.(\w+)/i)?.[1];
    switch (table) {
      case 'prod_inst': return [{ prod_inst_id: String(values[0]) === '13800000000' ? '11' : String(values[0]), acc_nbr: '13800000000', prod_id: '900178630', owner_cust_id: '900', his_id: '9007199254740993' }];
      case 'prod_inst_rel': return [{ prod_inst_rel_id: '21', prod_inst_a_id: '11', prod_inst_z_id: '12', relation_type_cd: '100600', his_id: null }];
      case 'prod_inst_attr': return [{ prod_inst_attr_id: '22', prod_inst_id: '12', attr_id: '800053983', his_id: null }];
      case 'prod_inst_acct': return [{ prod_inst_acct_id: '23', prod_inst_id: '11', account_id: '401', his_id: null }];
      case 'account': return [{ account_id: '401', cust_id: '900', his_id: null }];
      case 'offer_prod_inst_rel': return [{ offer_prod_inst_rel_id: '24', prod_inst_id: '11', prod_offer_inst_id: '601', his_id: null }];
      case 'prod_offer_inst': return [{ prod_offer_inst_id: String(values[0]) === '602' ? '602' : '601', prod_offer_id: '801', his_id: null }];
      case 'prod_offer_inst_rel': return [{ prod_offer_inst_rel_id: '25', rela_prod_offer_inst_id: '601', related_prod_offer_inst_id: '602', his_id: null }];
      case 'prod_offer_inst_attr': return [{ prod_offer_inst_attr_id: '26', prod_offer_inst_id: '601', his_id: null }];
      case 'payment_plan': return [{ account_id: '401', payment_bank_id: '1', payment_account: '000012345678901234567890' }];
      case 'prod_offer_member_inst': {
        if (missingMembers) throw new Error('relation bill_inmemory.prod_offer_member_inst does not exist');
        return [{ prod_offer_inst_id: '601', class_id: '1', member_id: '900' }, { prod_offer_inst_id: '601', class_id: '137', member_id: '401' }, { prod_offer_inst_id: '601', class_id: '2001', bank_id: '1', bank_account: '000012345678901234567890' }];
      }
      default: throw new Error(`unexpected PG table ${table}`);
    }
  } };
}

test('PG mappings bind positional values and preserve physical fields for relation traversal', () => {
  const mapped = mapQueryTables('SELECT * FROM offer_inst_rel WHERE A_OFFER_INST_ID = ? OR Z_OFFER_INST_ID = ? LIMIT 500', 'pg', 'bill_inmemory');
  assert.match(mapped.sql, /bill_inmemory\.prod_offer_inst_rel WHERE rela_prod_offer_inst_id = \$1 OR related_prod_offer_inst_id = \$2/);
  assert.match(mapQueryTables('SELECT * FROM offer_inst WHERE offer_id = ?', 'pg', 'bill_inmemory').sql, /prod_offer_id = \$1/);
});

test('all fixed PG query chains route archives to PG and definitions to MySQL', async () => {
  for (const [fn, id] of [[queryPhone, '13800000000'], [queryProductInstance, '11'], [queryOffer, '801'], [queryEventType, '206080000'], [queryThreshold, '11']]) {
    const db = fixture(); const result = await fn(db, id, { source: 'pg' });
    assert.equal(result.source, 'pg'); assert.equal(result.schema, 'bill_inmemory');
    assert.ok(db.calls.some((call) => call.source === 'pg'));
    assert.ok(db.calls.filter((call) => call.source === 'udal').every((call) => call.database === 'CONFIGDB_CNOS_JF_TEST'));
    assert.ok(result.steps.every((step) => ['pg', 'udal'].includes(step.source)));
    assert.ok(!db.calls.some((call) => call.source === 'voyage' || call.database === 'CRM3DB'));
    if (fn === queryProductInstance) assert.equal(result.data.productInstances[0].his_id, '9007199254740993');
  }
});

test('missing MySQL configuration retains successful PG archive branches as partial', async () => {
  const result = await queryProductInstance(fixture({ configMissing: true }), '11', { source: 'pg' });
  assert.equal(result.status, 'partial'); assert.ok(result.data.productInstances.length);
  assert.ok(result.steps.some((step) => step.status === 'error' && step.source === 'udal'));
});

test('every training relationship mode runs fixed bounded SQL and records both sources', async () => {
  for (const definition of RELATION_QUERIES) {
    const db = fixture(); const result = await queryArchiveRelations(db, { mode: definition.id, id: '601', peerProductInstanceId: '11', peerAccountId: '401' });
    assert.notEqual(result.status, 'failed', definition.id);
    assert.equal(result.source, 'pg'); assert.match(result.notice, /候选/);
    for (const call of db.calls) { assert.match(call.sql, /^SELECT /); assert.match(call.sql, /LIMIT /); }
    assert.ok(db.calls.filter((call) => call.source === 'pg').every((call) => call.database === 'bill_inmemory'));
    if (definition.id === 'bank-offers') {
      const match = db.calls.find((call) => /class_id = 2001 AND bank_id/.test(call.sql));
      assert.deepEqual(match.values, ['1', '000012345678901234567890']);
      assert.match(match.sql, /bank_id = \$1 AND bank_account = \$2/);
    }
  }
});

test('relation inputs reject arbitrary modes and SQL-shaped IDs before querying', async () => {
  const db = fixture();
  await assert.rejects(queryArchiveRelations(db, { mode: 'arbitrary', id: '1' }), /固定关系链/);
  await assert.rejects(queryArchiveRelations(db, { mode: 'product-offers', id: "1' OR 1=1" }), /必须是数字/);
  await assert.rejects(queryArchiveRelations(db, { mode: 'inner-call', id: '1', peerProductInstanceId: '' }), /必须是数字/);
  assert.equal(db.calls.length, 0);
});

test('schema errors retain successful bank path and mark relation query partial', async () => {
  const result = await queryArchiveRelations(fixture({ missingMembers: true }), { mode: 'bank-offers', id: '401' });
  assert.equal(result.status, 'partial'); assert.ok(result.data.paymentPlans.length);
  assert.ok(result.steps.some((step) => step.status === 'error'));
});

test('PG fixed SELECT runs in a read-only transaction with raw numeric/date results', async () => {
  const calls = []; let released = false;
  const pg = { types: { getTypeParser: () => (value) => value }, Pool: class {
    async query() { return { rows: [{ ok: 1 }] }; }
    async connect() { return { query: async (query) => { calls.push(query); return { rows: [{ id: '9007199254740993', timestamp: '2026-10-13 10:00:00' }] }; }, release: () => { released = true; } }; }
    async end() {}
  } };
  const manager = createDatabaseManager({ createPool() { throw new Error('no mysql expected'); } }, pg);
  await manager.connect('pg', { host: 'HOST', username: 'USER', database: 'DB' });
  const result = await manager.query('pg', 'bill_inmemory', 'SELECT * FROM bill_inmemory.prod_inst WHERE prod_inst_id = $1', ['11']);
  assert.equal(result[0].id, '9007199254740993');
  assert.match(calls[0], /REPEATABLE READ READ ONLY/); assert.ok(calls.some((sql) => /statement_timeout/.test(String(sql))));
  const select = calls.find((query) => typeof query === 'object'); assert.deepEqual(select.values, ['11']);
  assert.equal(select.types.getTypeParser(1114)('2026-10-13 10:00:00'), '2026-10-13 10:00:00');
  assert.equal(calls.at(-1), 'COMMIT'); assert.equal(released, true);
  await assert.rejects(manager.query('pg', 'bill_inmemory', 'DELETE FROM t'), /固定 SELECT/);
  await manager.closeAll();
});

test('HTTP fixed query routes ignore legacy source selection and expose only fixed relation modes', async () => {
  const { manager } = require('../../server/database');
  const { createServer } = require('../../server/server');
  const db = fixture(); const original = manager.query; manager.query = db.query.bind(db);
  const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const request = (method, endpoint, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = require('node:http').request({ host: '127.0.0.1', port: server.address().port, path: endpoint, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let text = ''; res.on('data', (b) => { text += b; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(payload);
  });
  try {
    for (const source of ['pg', 'udal', 'voyage']) {
      const result = await request('POST', '/api/query/phone', { phone: '13800000000', source });
      assert.equal(result.status, 200); assert.equal(result.body.result.source, 'pg');
    }
    const catalog = await request('GET', '/api/query/relations/catalog');
    assert.equal(catalog.body.queries.length, 13);
    const result = await request('POST', '/api/query/relations', { mode: 'bank-offers', id: '401' });
    assert.equal(result.status, 200); assert.equal(result.body.result.source, 'pg');
    assert.equal((await request('POST', '/api/query/relations', { mode: 'arbitrary', id: '1' })).status, 400);
    assert.equal((await request('POST', '/api/query/relations', { mode: 'product-offers', id: '1', sql: 'SELECT 1' })).status, 400);
    assert.equal((await request('POST', '/api/query/product-instance', { productInstanceId: '11', schema: 'crmv3' })).status, 400);
    assert.ok(db.calls.every((call) => call.source === 'pg' || (call.source === 'udal' && call.database === 'CONFIGDB_CNOS_JF_TEST')));
  } finally { manager.query = original; await new Promise((resolve) => server.close(resolve)); }
});

test('relation node and row limits are reported as partial rather than complete membership', async () => {
  const db = { async query(_source, _database, sql, values) {
    if (/offer_prod_inst_rel/.test(sql)) return Array.from({ length: 500 }, (_, i) => ({ prod_inst_id: String(i + 1), prod_offer_inst_id: '601' }));
    if (/prod_inst_rel/.test(sql)) return [];
    if (/prod_inst\b/.test(sql)) return [{ prod_inst_id: values[0] }];
    return [];
  } };
  const result = await queryArchiveRelations(db, { mode: 'offer-members', id: '601' });
  assert.equal(result.status, 'partial'); assert.equal(result.truncated, true);
  assert.equal(result.data.productInstances.length, 100);
});

test('relationship cancellation propagates and does not return stale partial data', async () => {
  const controller = new AbortController(); controller.abort();
  const db = { async query() { throw new Error('must not query after cancel'); } };
  await assert.rejects(queryArchiveRelations(db, { mode: 'product-offers', id: '11' }, { signal: controller.signal }), { code: 'QUERY_CANCELLED' });
});
