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
  assert.match(sql, /-- 目标：PostgreSQL 数据库 bill_cnos_jftest，Schema bill_inmemory/);
  assert.match(sql, /\nBEGIN;\n/); assert.match(sql, /\nCOMMIT;\n/);
  assert.match(sql, /-- 来源逻辑库：CRM3DB \| 表：prod_inst \| 2 行/);
  assert.match(sql, /INSERT INTO "bill_inmemory"\."prod_inst" \("prod_inst_id", "remark", "nullable", "create_date", "display_name", "extra_col"\) VALUES/);
  assert.match(sql, /'9007199254740993'/);
  assert.match(sql, /E'O''Reilly\\\\测试'/);
  assert.match(sql, /NULL/);
  assert.match(sql, /'2026-09-16T07:14:18Z'/);
  assert.match(sql, /'原始值'/);
  assert.doesNotMatch(sql, /display_name__RAW|修复值/);
  assert.match(sql, /\('2', '第二行', NULL, NULL, NULL, 'x'\);/);
  assert.match(sql, /-- 来源逻辑库：CONFIGDB_CNOS_JF_TEST \| 表：offer_ces \| 1 行/);
  assert.doesNotMatch(sql, /`/);
});

test('INSERT export rejects test-source results and explains empty Voyage results', async () => {
  const { generateInsertScript, hasInsertRows, sqlLiteral } = await import(moduleUrl);
  assert.throws(() => generateInsertScript({ source: 'udal', data: {} }), /仅工程环境 Voyage/);
  assert.equal(hasInsertRows({ source: 'voyage', data: { accounts: [] } }), false);
  assert.match(generateInsertScript({ source: 'voyage', productInstanceId: '1', data: {} }, { generatedAt: 'TIME' }), /没有可导出的数据行/);
  assert.equal(sqlLiteral(true), 'TRUE');
  assert.equal(sqlLiteral(false), 'FALSE');
  assert.equal(sqlLiteral(undefined), 'NULL');
  assert.equal(sqlLiteral("O'Reilly"), "'O''Reilly'");
  assert.equal(sqlLiteral('a\\b'), "E'a\\\\b'");
  const mysql = generateInsertScript({ source: 'voyage', data: { productInstances: [{ prod_inst_id: '1' }] } }, { target: 'mysql', generatedAt: 'TIME' });
  assert.match(mysql, /INSERT INTO `prod_inst` \(`prod_inst_id`\) VALUES/);
  assert.equal(sqlLiteral(true, 'mysql'), '1');
});

test('threshold Voyage results map back to relationship, product, and attribute tables', async () => {
  const { generateInsertScript } = await import(moduleUrl);
  const sql = generateInsertScript({ source: 'voyage', aProductInstanceId: '48243980', data: {
    relationships: [{ a_prod_inst_id: '48243980', z_prod_inst_id: '3134581391' }],
    terminalProducts: [{ prod_inst_id: '3134581391', prod_id: '900178630' }],
    thresholdAttributes: [{ prod_inst_id: '3134581391', attr_id: '800053985', threshold_level: '80%' }],
  } }, { generatedAt: 'TIME' });
  assert.match(sql, /表：prod_inst_rel/);
  assert.match(sql, /"prod_inst_a_id", "prod_inst_z_id"/);
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
    offerInstanceRelationships: [{ a_offer_inst_id: '701', z_offer_inst_id: '702' }],
    relatedOfferInstances: [{ offer_inst_id: '702', offer_id: '801' }],
    offerInstanceFeeAttributes: [{ offer_inst_fee_info_id: 'F701', attr_id: '2' }],
    offerObjectInstanceRelations: [{ offer_inst_id: '701', obj_inst_id: 'O1' }],
    offerResourceInstanceRelations: [{ offer_inst_id: '701', res_inst_id: 'R1' }],
    offerInstanceAssurances: [{ offer_inst_id: '701', assure_id: 'A1' }],
    offerCouponInstanceRelations: [{ offer_inst_id: '701', coupon_inst_id: 'C1' }],
    skuInstances: [{ offer_inst_id: '701', sku_inst_id: 'S1' }],
    valueAddedOrderRelations: [{ offer_inst_id: '701', order_id: 'V1' }],
  } }, { generatedAt: 'TIME' });
  assert.match(sql, /表：prod_inst \| 2 行/);
  assert.match(sql, /表：prod_inst_rel \| 1 行/);
  assert.match(sql, /表：prod_inst_attr \| 1 行/);
  assert.match(sql, /表：prod_inst_state \| 1 行/);
  assert.match(sql, /表：prod_offer_inst_attr \| 1 行/);
  assert.match(sql, /表：offer_inst_fee_info \| 1 行/);
  assert.match(sql, /表：prod_offer_inst_rel \| 1 行/);
  assert.match(sql, /表：prod_offer_inst \| 1 行/);
  assert.match(sql, /表：offer_inst_fee_attr \| 1 行/);
  assert.match(sql, /表：offer_obj_inst_rel \| 1 行/);
  assert.match(sql, /表：offer_res_inst_rel \| 1 行/);
  assert.match(sql, /表：offer_inst_assure \| 1 行/);
  assert.match(sql, /表：offer_coupon_inst_rel \| 1 行/);
  assert.match(sql, /表：sku_inst \| 1 行/);
  assert.match(sql, /表：va_order_rel \| 1 行/);
  assert.match(sql, /INSERT INTO "bill_inmemory"\."prod_offer_inst" \("prod_offer_inst_id", "prod_offer_id"\) VALUES/);
});

test('PostgreSQL bill_inmemory export maps the observed subscription tables and columns', async () => {
  const { generateInsertScript } = await import(moduleUrl);
  const sql = generateInsertScript({ source: 'voyage', productInstanceId: '125424', data: {
    productRelationships: [{ a_prod_inst_id: '125424', z_prod_inst_id: '1' }],
    accountRelations: [{ prod_inst_acct_id: '10', account_id: '20', prod_inst_id: '125424' }],
    offerRelations: [{ offer_prod_inst_rel_id: '30', prod_offer_inst_id: '40', prod_inst_id: '125424' }],
    offerInstances: [{ prod_offer_inst_id: '40', prod_offer_id: '50' }],
    offerInstanceAttributes: [{ prod_offer_inst_attr_id: '60', prod_offer_inst_id: '40' }],
  } }, { generatedAt: 'TIME' });
  for (const table of ['prod_inst_rel', 'prod_inst_acct', 'offer_prod_inst_rel', 'prod_offer_inst', 'prod_offer_inst_attr']) {
    assert.match(sql, new RegExp(`INSERT INTO "bill_inmemory"\\."${table}"`));
  }
  assert.match(sql, /"prod_inst_a_id", "prod_inst_z_id"/);
  assert.doesNotMatch(sql, /"dcs"\.|"offer_inst"|"prod_inst_acct_rel"/);
});

test('INSERT export retains historical versions and maps sale relationship endpoints, with partial-result warning', async () => {
  const { generateInsertScript } = await import(moduleUrl);
  const first = { prod_inst_id: '9007199254740993', his_id: '1' };
  const sql = generateInsertScript({ source: 'voyage', productInstanceId: first.prod_inst_id, status: 'partial',
    archiveCoverage: { limits: { nodesPerKind: 100, rounds: 8, readRows: 5000 } }, data: {
      productInstances: [first, { ...first, his_id: '2' }], relatedProductInstances: [first],
      offerInstanceRelationships: [{ offer_inst_rel_id: '31', a_offer_inst_id: '701', z_offer_inst_id: '702', his_id: '1' }],
      accounts: [{ acct_id: '501', his_id: '1' }],
    } }, { generatedAt: 'TIME' });
  assert.match(sql, /表：prod_inst \| 2 行/);
  assert.match(sql, /'9007199254740993', '1'/); assert.match(sql, /'9007199254740993', '2'/);
  assert.match(sql, /"prod_offer_inst_rel_id", "rela_prod_offer_inst_id", "related_prod_offer_inst_id", "his_id"/);
  assert.match(sql, /"account_id", "his_id"/);
  assert.match(sql, /保留工程库现存的全部 his_id 版本/); assert.match(sql, /本脚本不代表完整档案/);
});
