const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { queryProductInstance } = require('../../server/phone-query');

const ROOT = '9007199254740993';
const options = { source: 'voyage', schema: 'bill_inmemory' };
const compare = (a, b) => /^\d+$/.test(String(a)) && /^\d+$/.test(String(b))
  ? (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0) : String(a).localeCompare(String(b));
function fixture(tables, { failTable } = {}) {
  const calls = [];
  return { calls, async query(source, database, sql, values, queryOptions) {
    calls.push({ source, database, sql, values, options: queryOptions });
    assert.match(sql, /^SELECT \* FROM \w+ WHERE /);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|DROP|TRUNCATE|JOIN)\b/i);
    assert.equal(source, 'voyage'); assert.equal(database, 'CRM3DB'); assert.equal(queryOptions.schema, 'bill_inmemory');
    const table = sql.match(/FROM (\w+)/)[1];
    if (table === failTable) throw new Error('模拟档案分支失败');
    if (table === 'offer_ces') return (tables[table] || []).filter((row) => values.map(String).includes(String(row.offer_id)));
    const pk = sql.match(/ORDER BY (\w+), his_id NULLS FIRST/)[1];
    const where = sql.split(' WHERE (')[1].split(' ORDER BY ')[0].split(') AND (')[0];
    const clauses = [...where.matchAll(/(\w+) (?:IN \(([^)]+)\)|= (\?))/g)];
    let used = 0;
    const filters = clauses.map((match) => {
      const count = (match[2] || match[3]).split('?').length - 1;
      const ids = values.slice(used, used + count).map(String); used += count;
      return (row) => ids.includes(String(row[match[1]]));
    });
    let rows = (tables[table] || []).filter((row) => filters.some((filter) => filter(row)));
    if (values.length > used) {
      const id = values[used]; const his = values[used + 2];
      rows = rows.filter((row) => compare(row[pk], id) > 0 || (compare(row[pk], id) === 0 && row.his_id != null && (his == null || compare(row.his_id, his) > 0)));
    }
    return rows.sort((a, b) => compare(a[pk], b[pk]) || (a.his_id == null ? (b.his_id == null ? 0 : -1) : b.his_id == null ? 1 : compare(a.his_id, b.his_id))).slice(0, 500);
  } };
}

function graphTables() {
  return {
    prod_inst: [{ prod_inst_id: ROOT, his_id: '1' }, { prod_inst_id: ROOT, his_id: '2' },
      { prod_inst_id: '200', his_id: '1' }, { prod_inst_id: '200', his_id: '2' },
      { prod_inst_id: '300', his_id: '1' }, { prod_inst_id: '400', his_id: '1' }, { prod_inst_id: '999', his_id: '1' }],
    prod_inst_rel: [{ prod_inst_rel_id: '11', prod_inst_a_id: ROOT, prod_inst_z_id: '200', his_id: '1' },
      { prod_inst_rel_id: '12', prod_inst_a_id: '300', prod_inst_z_id: '200', his_id: '1' },
      { prod_inst_rel_id: '13', prod_inst_a_id: '300', prod_inst_z_id: ROOT, his_id: '1' }],
    prod_inst_attr: [{ prod_inst_attr_id: '21', prod_inst_id: ROOT, his_id: '1' }, { prod_inst_attr_id: '21', prod_inst_id: ROOT, his_id: '2' },
      { prod_inst_attr_id: '22', prod_inst_id: '200', his_id: '1' }, { prod_inst_attr_id: '23', prod_inst_id: '400', his_id: '1' }],
    prod_inst_acct: [{ prod_inst_acct_id: '31', prod_inst_id: ROOT, account_id: '501', his_id: '1' },
      { prod_inst_acct_id: '32', prod_inst_id: '400', account_id: '502', his_id: '1' }],
    account: [{ account_id: '501', his_id: '1' }, { account_id: '501', his_id: '2' }, { account_id: '502', his_id: '1' }],
    offer_prod_inst_rel: [{ offer_prod_inst_rel_id: '41', prod_inst_id: ROOT, prod_offer_inst_id: '701', his_id: '1' },
      { offer_prod_inst_rel_id: '42', prod_inst_id: '200', prod_offer_inst_id: '702', his_id: '1' },
      { offer_prod_inst_rel_id: '43', prod_inst_id: '400', prod_offer_inst_id: '703', his_id: '1' }],
    prod_offer_inst: [{ prod_offer_inst_id: '701', prod_offer_id: '801', his_id: '1' }, { prod_offer_inst_id: '701', prod_offer_id: '801', his_id: '2' },
      { prod_offer_inst_id: '702', prod_offer_id: '801', his_id: '1' }, { prod_offer_inst_id: '703', prod_offer_id: '802', his_id: '1' }],
    prod_offer_inst_rel: [{ prod_offer_inst_rel_id: '51', rela_prod_offer_inst_id: '702', related_prod_offer_inst_id: '701', his_id: '1' },
      { prod_offer_inst_rel_id: '52', rela_prod_offer_inst_id: '702', related_prod_offer_inst_id: '703', his_id: '1' },
      { prod_offer_inst_rel_id: '53', rela_prod_offer_inst_id: '703', related_prod_offer_inst_id: '701', his_id: '1' }],
    prod_offer_inst_attr: [{ prod_offer_inst_attr_id: '61', prod_offer_inst_id: '701', his_id: '1' },
      { prod_offer_inst_attr_id: '62', prod_offer_inst_id: '702', his_id: '1' }, { prod_offer_inst_attr_id: '63', prod_offer_inst_id: '703', his_id: '1' }],
    offer_ces: [{ offer_id: '801' }, { offer_id: '802' }],
  };
}

test('engineering instance archive follows both product and sale graphs, preserves histories and reads account/offer IDs', async () => {
  const db = fixture(graphTables()); const result = await queryProductInstance(db, ROOT, options);
  assert.equal(result.status, 'complete'); assert.equal(result.truncated, false);
  assert.equal(result.data.productInstances.length, 2);
  assert.deepEqual(result.data.relatedProductInstances.map((row) => row.prod_inst_id), ['200', '200', '300', '400']);
  assert.equal(result.data.productRelationships.length, 3); assert.equal(result.data.productAttributes.length, 4);
  assert.equal(result.data.accountRelations.length, 2); assert.equal(result.data.accounts.length, 3);
  assert.equal(result.data.offerRelations.length, 3); assert.equal(result.data.offerInstances.length, 2);
  assert.deepEqual(result.data.relatedOfferInstances.map((row) => row.prod_offer_inst_id).sort(), ['702', '703']);
  assert.equal(result.data.offerInstanceRelationships.length, 3); assert.equal(result.data.offerInstanceAttributes.length, 3);
  assert.deepEqual(result.data.offerInstanceRelationships.find((row) => row.prod_offer_inst_rel_id === '52'),
    { prod_offer_inst_rel_id: '52', rela_prod_offer_inst_id: '702', related_prod_offer_inst_id: '703', his_id: '1' });
  assert.ok(db.calls.some((call) => /FROM prod_offer_inst_rel WHERE \(rela_prod_offer_inst_id.* OR related_prod_offer_inst_id/.test(call.sql)));
  assert.deepEqual(result.data.offers.map((row) => row.offer_id), ['801', '802']);
  assert.equal(result.archiveCoverage.productInstanceCount, 4); assert.equal(result.archiveCoverage.offerInstanceCount, 3);
  assert.equal(Object.values(result.archiveCoverage.missingReferences).flat().length, 0);
  for (const [logicalTable, physicalTable] of [['prod_inst_acct_rel', 'prod_inst_acct'], ['offer_inst', 'prod_offer_inst'], ['offer_inst_rel', 'prod_offer_inst_rel']]) {
    assert.ok(result.steps.some((step) => step.tableMap?.some((mapping) => mapping.logicalTable === logicalTable && mapping.physicalTable === physicalTable)));
  }
  assert.equal(db.calls.some((call) => call.values.includes('999')), false);
  assert.equal(db.calls.filter((call) => call.sql.startsWith('SELECT * FROM prod_inst WHERE')).length, 3);
  assert.equal(result.totalRows, Object.values(result.data).flat().length);
  const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/insert-export.js'), 'utf8');
  const { generateInsertScript } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const exportSql = generateInsertScript(result, { generatedAt: 'TIME' });
  for (const [table, count] of [['prod_inst', 6], ['prod_offer_inst', 4], ['prod_offer_inst_rel', 3], ['account', 3]]) assert.ok(exportSql.includes(`表：${table} | ${count} 行`));
  assert.match(exportSql, /"prod_offer_inst_rel_id", "rela_prod_offer_inst_id", "related_prod_offer_inst_id", "his_id"/);
});

test('engineering archive paginates beyond 500 rows by ID and his_id, including null history', async () => {
  const rows = Array.from({ length: 501 }, (_, index) => ({ prod_inst_id: ROOT, his_id: index === 0 ? null : String(index) }));
  const db = fixture({ prod_inst: rows }); const result = await queryProductInstance(db, ROOT, options);
  assert.equal(result.data.productInstances.length, 501); assert.equal(result.status, 'complete'); assert.equal(result.truncated, false);
  const pages = db.calls.filter((call) => /FROM prod_inst WHERE/.test(call.sql));
  assert.equal(pages.length, 2); assert.match(pages[1].sql, /his_id > \?/);
  assert.deepEqual(pages[1].values, [ROOT, ROOT, ROOT, '499']);
  assert.equal(result.data.productInstances.at(-1).his_id, '500');
});

test('engineering archive paginates null histories and reports a depth boundary', async () => {
  const tables = { prod_inst: [{ prod_inst_id: ROOT, his_id: '1' }], prod_inst_attr: Array.from({ length: 501 }, (_, index) => ({
    prod_inst_attr_id: String(index + 1), prod_inst_id: ROOT, his_id: null,
  })) };
  const db = fixture(tables); const paged = await queryProductInstance(db, ROOT, options);
  assert.equal(paged.status, 'complete'); assert.equal(paged.data.productAttributes.length, 501);
  assert.ok(db.calls.some((call) => /his_id IS NOT NULL/.test(call.sql)));
  tables.prod_inst_attr = []; tables.prod_inst_rel = [];
  for (let index = 1; index <= 10; index++) {
    tables.prod_inst.push({ prod_inst_id: String(index), his_id: '1' });
    tables.prod_inst_rel.push({ prod_inst_rel_id: String(index), prod_inst_a_id: index === 1 ? ROOT : String(index - 1), prod_inst_z_id: String(index), his_id: '1' });
  }
  const capped = await queryProductInstance(fixture(tables), ROOT, options);
  assert.equal(capped.status, 'partial'); assert.equal(capped.archiveCoverage.rounds, 8);
  assert.ok(capped.archiveCoverage.limitReasons.includes('关联展开达到 8 轮'));
});

test('engineering archive surfaces unresolved references and retains healthy branches after errors', async () => {
  const tables = graphTables(); tables.account = []; tables.offer_ces = [{ offer_id: '801' }];
  const result = await queryProductInstance(fixture(tables, { failTable: 'prod_inst_attr' }), ROOT, options);
  assert.equal(result.status, 'partial'); assert.equal(result.data.offerInstanceRelationships.length, 3);
  assert.deepEqual(result.archiveCoverage.missingReferences.accounts, ['501', '502']);
  assert.deepEqual(result.archiveCoverage.missingReferences.offers, ['802']);
  assert.ok(result.steps.some((step) => step.status === 'error' && step.message === '模拟档案分支失败'));
});

test('engineering graph bounds node expansion and reports partial instead of silently claiming completeness', async () => {
  const tables = { prod_inst: [{ prod_inst_id: ROOT, his_id: '1' }], prod_inst_rel: [] };
  for (let index = 1; index <= 105; index++) {
    const id = String(index); tables.prod_inst.push({ prod_inst_id: id, his_id: '1' });
    tables.prod_inst_rel.push({ prod_inst_rel_id: id, prod_inst_a_id: ROOT, prod_inst_z_id: id, his_id: '1' });
  }
  const result = await queryProductInstance(fixture(tables), ROOT, options);
  assert.equal(result.status, 'partial'); assert.equal(result.truncated, true);
  assert.equal(result.archiveCoverage.productInstanceCount, 100); assert.equal(result.data.relatedProductInstances.length, 99);
  assert.ok(result.archiveCoverage.limitReasons.includes('关联产品超过 100 个 ID'));
});

test('engineering archive treats an empty root distinctly and propagates cancellation/disconnection', async () => {
  const result = await queryProductInstance(fixture({}), ROOT, options); assert.equal(result.status, 'empty');
  assert.equal(result.steps.length, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(queryProductInstance(fixture({}), ROOT, { ...options, signal: controller.signal }), /查询已取消/);
  await assert.rejects(queryProductInstance({ query: async () => { throw new Error('Voyage 在线数据库尚未连接'); } }, ROOT, options), /尚未连接/);
});

test('engineering archive stops at row budget and flags a stalled page cursor', async () => {
  const rows = Array.from({ length: 5001 }, (_, index) => ({ prod_inst_id: ROOT, his_id: String(index) }));
  const db = fixture({ prod_inst: rows }); const capped = await queryProductInstance(db, ROOT, options);
  assert.equal(capped.data.productInstances.length, 5000); assert.equal(capped.status, 'partial'); assert.equal(capped.truncated, true);
  assert.equal(capped.archiveCoverage.readRows, 5000); assert.equal(db.calls.length, 10);
  const stalled = await queryProductInstance({ query: async (_source, _database, sql) => /FROM prod_inst WHERE/.test(sql) ? Array.from({ length: 500 }, () => ({ prod_inst_id: ROOT, his_id: '1' })) : [] }, ROOT, options);
  assert.equal(stalled.status, 'partial'); assert.equal(stalled.truncated, true);
  assert.ok(stalled.steps.some((step) => step.name.endsWith('分页游标') && step.status === 'error'));
});
