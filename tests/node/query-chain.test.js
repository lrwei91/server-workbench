const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, configRows, runChain, connect, csv, writeReport, createOutputDirectory } = require('../../scripts/query-chain.cjs');

test('query CLI validates mutually exclusive modes and preserves bigint/number text', () => {
  assert.equal(parseArgs([]).sample, 'archive');
  assert.deepEqual(parseArgs(['--type', 'product', '--ids', '9007199254740993,0001,1']).ids, ['9007199254740993', '1']);
  assert.deepEqual(parseArgs(['--type', 'number', '--ids', '001234']).ids, ['001234']);
  for (const args of [['--type', 'product'], ['--ids', '1'], ['--limit', '0'], ['--limit', '101'],
    ['--type', 'product', '--ids', '1;DROP TABLE x'], ['--type', 'bad', '--ids', '1'],
    ['--type', 'plan', '--ids', '1', '--sample', 'archive'], ['--out'], ['--out', 'a', '--out', 'b'],
    ['--type', 'event-family', '--ids', '123'], ['--type', 'plan', '--ids', '9223372036854775808']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('config rows keep plan-only results, multiple combinations and missing references', () => {
  const data = { offers: [{ offer_id: '1', pricing_plan_id: '2', offer_name: 'a' }, { offer_id: '3', pricing_plan_id: null }, { offer_id: '4', pricing_plan_id: '5' }],
    plans: [{ pricing_plan_id: '2' }, { pricing_plan_id: '6' }],
    combines: [{ pricing_combine_id: '7', pricing_plan_id: '2', event_pricing_strategy_id: '8', pricing_object_id: '9' },
      { pricing_combine_id: '10', pricing_plan_id: '2', event_pricing_strategy_id: '11', pricing_object_id: null }],
    strategies: [{ event_pricing_strategy_id: '8', event_type_id: '206080100' }], objects: [] };
  const rows = configRows(data, ['6']);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].config_status, '对象引用未匹配');
  assert.equal(rows[1].config_status, '事件策略缺失');
  assert.equal(rows.find(r => r.offer_id === '3').config_status, '计划定义缺失');
  assert.equal(rows.find(r => r.offer_id === '4').plan_id, '5');
  assert.equal(rows.find(r => r.plan_id === '6').offer_id, null);
});

function mockDb({ fail = false } = {}) {
  const calls = [];
  const raw = {
    offer: [{ offer_id: '4', pricing_plan_id: '5', offer_name: '套餐' }], pricing_plan: [{ pricing_plan_id: '5', pricing_plan_name: '计划' }],
    pricing_combine: [{ pricing_combine_id: '6', pricing_plan_id: '5', event_pricing_strategy_id: '7' }],
    event_pricing_strategy: [{ event_pricing_strategy_id: '7', event_type_id: '206080100' }], pricing_object: [],
    product: [{ prod_id: '2', prod_name: '产品' }],
  };
  return { calls, async query(source, sql, params = []) {
    calls.push({ source, sql, params });
    if (source !== 'pg') {
      assert.match(sql, /^SELECT /);
      assert.doesNotMatch(sql, /LIMIT/); // associated rows are not silently sampled
      if (fail) throw Object.assign(new Error('test failure'), { code: 'TEST_ERROR' });
      return raw[sql.match(/FROM (\w+)/)[1]] || [];
    }
    if (/FROM bill_inmemory.prod_inst WHERE/.test(sql)) return [{ prod_inst_id: '1', product_id: '2' }];
    if (/CREATE TEMP TABLE swq_path/.test(sql)) return [{ prod_inst_id: '1', product_id: '2', offer_id: '4', product_his_id: '9007199254740993' }];
    if (/SELECT \* FROM pg_temp.swq_products/.test(sql)) return [{ prod_inst_id: '1', product_id: '2', his_id: '9007199254740993' }];
    if (/SELECT \* FROM pg_temp.swq_offers/.test(sql)) return [{ prod_offer_inst_id: '3', prod_offer_id: '4' }];
    if (/FULL JOIN pg_temp.swq_cfg/.test(sql)) return [{ prod_inst_id: '1', offer_id: '4', plan_id: '5', chain_status: '已连接' }];
    return [];
  } };
}

test('automatic chain transfers IDs to independent sources, keeps raw rows and only stages in pg_temp', async () => {
  const db = mockDb(); const r = await runChain(db, parseArgs(['--type', 'product', '--ids', '1', '--expand-relations']));
  assert.equal(r.status, 'queried');
  assert.equal(r.data.products[0].his_id, '9007199254740993');
  assert.equal(r.chain[0].plan_id, '5');
  assert.ok(db.calls.some(c => c.source === 'crm' && c.params[0] === '2'));
  assert.ok(db.calls.some(c => c.source === 'config' && /FROM offer WHERE offer_id/.test(c.sql) && c.params[0] === '4'));
  for (const { sql, source } of db.calls) {
    assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE|TRUNCATE)\b/i);
    if (source === 'pg') for (const target of sql.matchAll(/(?:INSERT INTO|DROP TABLE IF EXISTS)\s+(\S+)/g)) assert.match(target[1], /^pg_temp\./);
  }
});

test('query failure preserves completed steps and explicitly marks the failed step', async () => {
  const r = { data: {}, steps: [] };
  await assert.rejects(runChain(mockDb({ fail: true }), parseArgs(['--type', 'product', '--ids', '1']), r));
  assert.equal(r.steps.at(-1).status, 'error');
  assert.equal(r.steps.at(-1).code, 'TEST_ERROR');
  assert.equal(r.data.products.length, 1);
});

test('empty and unmatched input is not reported as a complete chain', async () => {
  const r = await runChain({ async query() { return []; } }, parseArgs(['--type', 'product', '--ids', '123']));
  assert.equal(r.status, 'empty'); assert.deepEqual(r.unmatchedInputs, ['123']);
});

test('product definition input is queried even without PG subscriptions', async () => {
  const calls = [];
  const r = await runChain({ async query(source, sql, params) {
    calls.push({ source, sql, params });
    if (source === 'crm') return [{ prod_id: '2', prod_name: '未订购产品' }];
    if (sql.includes('FULL JOIN pg_temp.swq_definition')) return [{ product_id: '2', chain_status: '未找到PG产品实例' }];
    return [];
  } }, parseArgs(['--type', 'product_spec', '--ids', '2']));
  assert.ok(calls.some(c => c.source === 'crm' && c.params[0] === '2'));
  assert.deepEqual(r.unmatchedInputs, []);
  assert.equal(r.chain[0].chain_status, '未找到PG产品实例');
});

test('output creates missing parents but preserves an existing result directory', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'query-chain-dir-'));
  const target = path.join(base, 'parent', 'result');
  try { assert.equal(createOutputDirectory(target), target); assert.throws(() => createOutputDirectory(target), { code: 'EEXIST' }); }
  finally { fs.rmdirSync(target); fs.rmdirSync(path.dirname(target)); fs.rmdirSync(base); }
});

test('connect cleans earlier connections on later failure and closes successful sessions', async () => {
  const closed = [], databases = [];
  class Client { async connect() {} async end() { closed.push('pg'); } async query() { return { rows: [] }; } }
  const pg = { Client, types: { getTypeParser() {} } };
  const config = { database: { pg: {}, udal: {} } };
  await assert.rejects(connect(config, { pg, mysql: { async createConnection(c) { databases.push(c.database);
    if (c.database === 'CRM3DB') throw new Error('failed'); return { async end() { closed.push('config'); } }; } } }));
  assert.deepEqual(databases, ['CONFIGDB_CNOS_JF_TEST', 'CRM3DB']);
  assert.deepEqual(closed.sort(), ['config', 'pg']);
  const db = await connect(config, { pg, mysql: { async createConnection(c) { return { async end() { closed.push(c.database); }, async query() { return [[]]; } }; } } });
  await assert.rejects(db.query('config', 'DELETE FROM offer'));
  await db.close(); assert.ok(closed.includes('CRM3DB'));
});

test('CSV and JSON retain bigint, protect spreadsheet text and escape quotes/newlines', () => {
  const output = csv([{ id: '9007199254740993', number: '001234', name: '=1+1', value: 'a,"b"\nc' }]);
  assert.ok(output.startsWith('\ufeff'));
  assert.match(output, /'9007199254740993/); assert.match(output, /'001234/); assert.match(output, /'=1\+1/);
  assert.match(output, /a,""b""\nc/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-chain-test-'));
  try {
    writeReport(dir, { at: 'test', options: { type: 'product' }, status: 'failed', errorCode: 'TEST_ERROR',
      steps: [], data: {}, chain: [{ id: '9007199254740993' }] });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'result.json'))).chain[0].id, '9007199254740993');
    assert.match(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), /failed/);
  } finally { for (const file of ['result.json', 'chain.csv', 'summary.md']) fs.unlinkSync(path.join(dir, file)); fs.rmdirSync(dir); }
});
