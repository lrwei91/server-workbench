const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/insert-export.js'), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

test('Voyage results generate table-mapped INSERT statements without losing source values', async () => {
  const { generateInsertScript } = await import(moduleUrl);
  const sql = generateInsertScript({
    source: 'voyage', phone: '18900000000', data: {
      productInstances: [
        { prod_inst_id: '9007199254740993', remark: "O'Reilly\\测试", nullable: null, create_date: '2026-09-16T07:14:18Z', display_name: '修复值', display_name__RAW: '原始值' },
        { prod_inst_id: '2', remark: '第二行', extra_col: 'x' },
      ],
      offers: [{ offer_id: '800010088', offer_name: '套餐' }],
    },
  }, { generatedAt: '2026-09-16T16:00:00.000+08:00' });
  assert.match(sql, /-- 目标逻辑库：CRM3DB \| 表：prod_inst \| 2 行/);
  assert.match(sql, /INSERT INTO `prod_inst` \(`prod_inst_id`, `remark`, `nullable`, `create_date`, `display_name`, `extra_col`\) VALUES/);
  assert.match(sql, /'9007199254740993'/);
  assert.match(sql, /'O''Reilly\\\\测试'/);
  assert.match(sql, /NULL/);
  assert.match(sql, /'2026-09-16T07:14:18Z'/);
  assert.match(sql, /'原始值'/);
  assert.doesNotMatch(sql, /display_name__RAW|修复值/);
  assert.match(sql, /\('2', '第二行', NULL, NULL, NULL, 'x'\);/);
  assert.match(sql, /-- 目标逻辑库：CONFIGDB_CNOS_JF_TEST \| 表：offer \| 1 行/);
});

test('INSERT export rejects test-source results and explains empty Voyage results', async () => {
  const { generateInsertScript, hasInsertRows, sqlLiteral } = await import(moduleUrl);
  assert.throws(() => generateInsertScript({ source: 'udal', data: {} }), /仅工程环境 Voyage/);
  assert.equal(hasInsertRows({ source: 'voyage', data: { accounts: [] } }), false);
  assert.match(generateInsertScript({ source: 'voyage', productInstanceId: '1', data: {} }, { generatedAt: 'TIME' }), /没有可导出的数据行/);
  assert.equal(sqlLiteral(true), '1');
  assert.equal(sqlLiteral(false), '0');
  assert.equal(sqlLiteral(undefined), 'NULL');
});

test('threshold Voyage results map back to relationship, product, and attribute tables', async () => {
  const { generateInsertScript } = await import(moduleUrl);
  const sql = generateInsertScript({ source: 'voyage', aProductInstanceId: '48243980', data: {
    relationships: [{ a_prod_inst_id: '48243980', z_prod_inst_id: '3134581391' }],
    terminalProducts: [{ prod_inst_id: '3134581391', prod_id: '900178630' }],
    thresholdAttributes: [{ prod_inst_id: '3134581391', attr_id: '800053985', threshold_level: '80%' }],
  } }, { generatedAt: 'TIME' });
  assert.match(sql, /表：prod_inst_rel/);
  assert.match(sql, /表：prod_inst \| 1 行/);
  assert.match(sql, /表：prod_inst_attr/);
  assert.doesNotMatch(sql, /threshold_level|80%/);
});

test('product archive extensions export to their source tables and deduplicate shared product rows', async () => {
  const { generateInsertScript } = await import(moduleUrl);
  const shared = { prod_inst_id: '11', prod_id: '101' };
  const sql = generateInsertScript({ source: 'voyage', productInstanceId: '11', data: {
    productInstances: [shared], accessProductInstances: [shared], relatedProductInstances: [{ prod_inst_id: '12', prod_id: '102' }],
    productRelationships: [{ a_prod_inst_id: '11', z_prod_inst_id: '12' }],
    productAttributes: [{ prod_inst_id: '11', attr_id: '800000251' }],
    productStates: [{ prod_inst_id: '11', status_cd: '1000' }],
    offerInstanceAttributes: [{ offer_inst_id: '701', attr_id: '1' }],
    offerInstanceFees: [{ offer_inst_id: '701', fee: '10.00' }],
  } }, { generatedAt: 'TIME' });
  assert.match(sql, /表：prod_inst \| 2 行/);
  assert.match(sql, /表：prod_inst_rel \| 1 行/);
  assert.match(sql, /表：prod_inst_attr \| 1 行/);
  assert.match(sql, /表：prod_inst_state \| 1 行/);
  assert.match(sql, /表：offer_inst_attr \| 1 行/);
  assert.match(sql, /表：offer_inst_fee_info \| 1 行/);
});
