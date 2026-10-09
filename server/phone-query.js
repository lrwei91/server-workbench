'use strict';

const { repairBusinessText } = require('./encoding');

const CRM = 'CRM3DB';
const CONFIG = 'CONFIGDB_CNOS_JF_TEST';
const STEP_LIMIT = 500;
const TOTAL_LIMIT = 5000;
const THRESHOLD_PRODUCT_ID = '900178630';
const THRESHOLD_LEVELS = Object.freeze({
  800053983: '20%', 800053984: '40%', 800053985: '80%',
  800053986: '100%', 800053987: '150%', 800053988: '200%',
});
const THRESHOLD_ATTR_IDS = Object.keys(THRESHOLD_LEVELS);
const VOYAGE_BILL_INMEMORY_TABLE_MAP = Object.freeze({
  prod_inst_acct_rel: 'prod_inst_acct',
  offer_inst: 'prod_offer_inst',
  offer_inst_attr: 'prod_offer_inst_attr',
  offer_inst_rel: 'prod_offer_inst_rel',
  offer: 'offer_ces',
});
const VOYAGE_BILL_INMEMORY_COLUMN_MAP = Object.freeze({
  acc_num: 'acc_nbr',
  offer_inst_id: 'prod_offer_inst_id',
});
const VOYAGE_PRODUCT_RELATION_COLUMN_MAP = Object.freeze({
  a_prod_inst_id: 'prod_inst_a_id',
  z_prod_inst_id: 'prod_inst_z_id',
});
const VOYAGE_TABLE_COLUMN_MAP = Object.freeze({
  account: { acct_id: 'account_id' },
  prod_inst_acct: { acct_id: 'account_id', prod_inst_acct_rel_id: 'prod_inst_acct_id' },
  prod_offer_inst: { offer_id: 'prod_offer_id' },
  prod_offer_inst_rel: { a_offer_inst_id: 'rela_prod_offer_inst_id', z_offer_inst_id: 'related_prod_offer_inst_id', offer_inst_rel_id: 'prod_offer_inst_rel_id' },
});
const BILL_ARCHIVE_TABLES = Object.freeze({
  prod_inst: 'prod_inst_id', prod_inst_rel: 'prod_inst_rel_id', prod_inst_attr: 'prod_inst_attr_id',
  prod_inst_acct: 'prod_inst_acct_id', offer_prod_inst_rel: 'offer_prod_inst_rel_id',
  prod_offer_inst: 'prod_offer_inst_id', prod_offer_inst_attr: 'prod_offer_inst_attr_id',
  prod_offer_inst_rel: 'prod_offer_inst_rel_id', account: 'account_id',
});
const ARCHIVE_NODE_LIMIT = 100;
const ARCHIVE_ROUND_LIMIT = 8;
const EVENT_TYPE_CATALOG = Object.freeze([
  { sourceTypeSequence: '8', eventTypeId: '206080000', routeEventTypeId: '206080000', name: 'CDMA 集团', targetTable: 'TICKET_CDMA_GROUP' },
  { sourceTypeSequence: '7', eventTypeId: '206070000', routeEventTypeId: '206070000', name: 'CDMA 语音', targetTable: 'TICKET_CDMA_VOICE' },
  { sourceTypeSequence: '11', eventTypeId: '206110000', routeEventTypeId: '206110000', name: 'CDMA 短信', targetTable: 'TICKET_CDMA_SMS' },
  { sourceTypeSequence: '12', eventTypeId: '206120000', routeEventTypeId: '206120000', name: '正常 CDMA 业务域话单（C 网增值）', targetTable: 'TICKET_CDMA_OPERA' },
  { sourceTypeSequence: '3', eventTypeId: '202010000', routeEventTypeId: '202010000', name: '数据业务拨号正常话单', targetTable: 'TICKET_DATA' },
  { sourceTypeSequence: '1', eventTypeId: '201010000', routeEventTypeId: '201010000', name: '正常语音话单', targetTable: 'TICKET_VOICE' },
  { sourceTypeSequence: '2', eventTypeId: '205060000', routeEventTypeId: '205060000', name: '智能网话单正常单', targetTable: 'TICKET_IN' },
  { sourceTypeSequence: '13', eventTypeId: '203030000', routeEventTypeId: '203030000', name: '信息台清单正常单话单', targetTable: 'TICKET_INFO_STATION' },
  { sourceTypeSequence: '19', eventTypeId: '206190000', routeEventTypeId: '206190000', name: '正常 CDMA 综合 VPN 业务话单', targetTable: 'TICKET_IVPN' },
  { sourceTypeSequence: '21', eventTypeId: '204210000', routeEventTypeId: '204210000', name: '597 协同通信语音正常话单', targetTable: 'TICKET_COMM_VOICE' },
  { sourceTypeSequence: '35', eventTypeId: '204350000', routeEventTypeId: '204350000', name: '彩铃正常话单', targetTable: 'TICKET_BLOC_NCR' },
  { sourceTypeSequence: '22', eventTypeId: '204220000', routeEventTypeId: '204220100', name: '597 协同通信短信正常话单（细分码）', targetTable: 'TICKET_COMM_SMS' },
  { sourceTypeSequence: '47', eventTypeId: '204470000', routeEventTypeId: '204470000', name: '全国商务领航正常话单', targetTable: 'TICKET_QBUG' },
  { sourceTypeSequence: '41', eventTypeId: '204410000', routeEventTypeId: '204410000', name: '商务领航声讯外包正常单', targetTable: 'TICKET_BNG' },
  { sourceTypeSequence: '52', eventTypeId: '208520000', routeEventTypeId: '208520000', name: '国漫语音', targetTable: 'TICKET_ROAM_VOICE' },
  { sourceTypeSequence: '53', eventTypeId: '208530000', routeEventTypeId: '208530000', name: '国漫数据', targetTable: 'TICKET_ROAM_DATA' },
  { sourceTypeSequence: '54', eventTypeId: '208540000', routeEventTypeId: '208540000', name: '国漫短信', targetTable: 'TICKET_ROAM_SMS' },
  { sourceTypeSequence: '55', eventTypeId: '208550000', routeEventTypeId: '208550000', name: '国漫套餐费', targetTable: 'TICKET_ROAM_PACKAGE' },
  { sourceTypeSequence: '6', eventTypeId: '203020000', routeEventTypeId: '203020000', name: '固网/固定虚拟详单(VDR)类（推断）', targetTable: 'TICKET_FIX_VDR' },
  { sourceTypeSequence: '16', eventTypeId: '204050000', routeEventTypeId: '204050000', name: 'C 网增值运营（推断）', targetTable: 'TICKET_CDMA_OPERA' },
  { sourceTypeSequence: '22', eventTypeId: '204220000', routeEventTypeId: '204220000', name: '协同通信类虚拟详单（推断）', targetTable: 'TICKET_FIX_VDR' },
  { sourceTypeSequence: '33', eventTypeId: '204330000', routeEventTypeId: '204330000', name: 'C 网增值运营（推断）', targetTable: 'TICKET_CDMA_OPERA' },
  { sourceTypeSequence: '34', eventTypeId: '204340000', routeEventTypeId: '204340000', name: 'C 网增值运营（推断）', targetTable: 'TICKET_CDMA_OPERA' },
  { sourceTypeSequence: '37', eventTypeId: '204370000', routeEventTypeId: '204370000', name: '固网虚拟详单(VDR)类（推断）', targetTable: 'TICKET_FIX_VDR' },
  { sourceTypeSequence: '38', eventTypeId: '204380000', routeEventTypeId: '204380000', name: 'C 网增值运营（推断）', targetTable: 'TICKET_CDMA_OPERA' },
  { sourceTypeSequence: '39', eventTypeId: '204390000', routeEventTypeId: '204390000', name: 'C 网增值运营（推断）', targetTable: 'TICKET_CDMA_OPERA' },
  { sourceTypeSequence: '40', eventTypeId: '204400000', routeEventTypeId: '204400000', name: '固网虚拟详单(VDR)类（推断）', targetTable: 'TICKET_FIX_VDR' },
  { sourceTypeSequence: '49', eventTypeId: '204490000', routeEventTypeId: '204490000', name: '固网虚拟详单(VDR)类（推断）', targetTable: 'TICKET_FIX_VDR' },
  { sourceTypeSequence: '51', eventTypeId: '204510000', routeEventTypeId: '204510000', name: '固网虚拟详单(VDR)类（推断）', targetTable: 'TICKET_FIX_VDR' },
]);

const SQL = {
  productsByPhone: `SELECT * FROM prod_inst WHERE acc_num = ? ORDER BY prod_inst_id LIMIT ${STEP_LIMIT}`,
  productsByInstance: 'SELECT * FROM prod_inst WHERE prod_inst_id = ? LIMIT 1',
  customerProducts: `SELECT * FROM prod_inst WHERE OWNER_CUST_ID = ? ORDER BY prod_inst_id LIMIT ${STEP_LIMIT}`,
  product: 'SELECT * FROM product WHERE prod_id = ? LIMIT 500',
  accountRel: 'SELECT * FROM prod_inst_acct_rel WHERE PROD_INST_ID = ? LIMIT 500',
  account: 'SELECT * FROM account WHERE acct_id = ? LIMIT 500',
  accountByProduct: 'SELECT * FROM account WHERE PROD_INST_ID = ? LIMIT 500',
  accountByCustomer: 'SELECT * FROM account WHERE CUST_ID = ? LIMIT 500',
  offerRel: 'SELECT * FROM offer_prod_inst_rel WHERE PROD_INST_ID = ? LIMIT 500',
  offerInst: 'SELECT * FROM offer_inst WHERE offer_inst_id = ? LIMIT 500',
  offer: 'SELECT * FROM offer WHERE offer_id = ? LIMIT 500',
  pricingPlan: 'SELECT * FROM pricing_plan WHERE pricing_plan_id = ? LIMIT 500',
  relationshipByA: `SELECT * FROM prod_inst_rel WHERE a_prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  relationshipByZ: `SELECT * FROM prod_inst_rel WHERE z_prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  productAttribute: `SELECT * FROM prod_inst_attr WHERE prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  productState: `SELECT * FROM prod_inst_state WHERE prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  productExtension: `SELECT * FROM prod_inst_ext WHERE prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  productContact: `SELECT * FROM prod_inst_contact WHERE prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  productPaymode: `SELECT * FROM prod_inst_paymode WHERE prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  productAccessNumber: `SELECT * FROM prod_inst_acc_num WHERE prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  productNumberRelation: `SELECT * FROM prod_inst_acc_nbr_rela WHERE prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  productParty: `SELECT * FROM prod_inst_party WHERE prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  productResourceRelation: `SELECT * FROM prod_res_inst_rel WHERE prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  offerInstanceAttribute: `SELECT * FROM offer_inst_attr WHERE offer_inst_id = ? LIMIT ${STEP_LIMIT}`,
  offerInstanceFee: `SELECT * FROM offer_inst_fee_info WHERE offer_inst_id = ? LIMIT ${STEP_LIMIT}`,
  offerInstanceRelationByA: `SELECT * FROM offer_inst_rel WHERE A_OFFER_INST_ID = ? LIMIT ${STEP_LIMIT}`,
  offerInstanceRelationByZ: `SELECT * FROM offer_inst_rel WHERE Z_OFFER_INST_ID = ? LIMIT ${STEP_LIMIT}`,
  offerInstanceFeeAttribute: `SELECT * FROM offer_inst_fee_attr WHERE OFFER_INST_FEE_INFO_ID = ? LIMIT ${STEP_LIMIT}`,
  offerObjectInstanceRelation: `SELECT * FROM offer_obj_inst_rel WHERE OFFER_INST_ID = ? LIMIT ${STEP_LIMIT}`,
  offerResourceInstanceRelation: `SELECT * FROM offer_res_inst_rel WHERE OFFER_INST_ID = ? LIMIT ${STEP_LIMIT}`,
  offerInstanceAssurance: `SELECT * FROM offer_inst_assure WHERE offer_inst_id = ? LIMIT ${STEP_LIMIT}`,
  offerCouponInstanceRelation: `SELECT * FROM offer_coupon_inst_rel WHERE OFFER_INST_ID = ? LIMIT ${STEP_LIMIT}`,
  skuInstance: `SELECT * FROM sku_inst WHERE offer_inst_id = ? LIMIT ${STEP_LIMIT}`,
  valueAddedOrderRelation: `SELECT * FROM va_order_rel WHERE OFFER_INST_ID = ? LIMIT ${STEP_LIMIT}`,
  thresholdRelations: `SELECT * FROM prod_inst_rel WHERE a_prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  thresholdTerminalProduct: `SELECT * FROM prod_inst WHERE prod_id = ${THRESHOLD_PRODUCT_ID} AND prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  thresholdAttributes: `SELECT * FROM prod_inst_attr WHERE attr_id IN (${THRESHOLD_ATTR_IDS.join(',')}) AND prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  sourceEventTypeFormats: `SELECT * FROM source_event_type_format WHERE SOURCE_EVENT_TYPE_ID IN (?, ?) OR EVENT_TYPE_ID IN (?, ?) ORDER BY VERSION DESC LIMIT ${STEP_LIMIT}`,
  eventTypeFormats: `SELECT * FROM ratable_event_type_format WHERE EVENT_TYPE_ID IN (?, ?) LIMIT ${STEP_LIMIT}`,
  eventFormat: `SELECT * FROM ratable_event_format WHERE EVENT_FORMAT_ID = ? LIMIT ${STEP_LIMIT}`,
  eventFormatItems: `SELECT * FROM ratable_event_format_item WHERE EVENT_FORMAT_ID = ? ORDER BY SORT_ID LIMIT ${STEP_LIMIT}`,
  resourceAttribute: `SELECT * FROM tpr_resource_attr WHERE ATTR_ID = ? LIMIT ${STEP_LIMIT}`,
  targetTables: `SELECT * FROM TPL_INDB_TABLE_PG WHERE EVENT_TYPE_ID IN (?, ?, ?) ORDER BY BILLING_CYCLE_ID DESC LIMIT ${STEP_LIMIT}`,
  eventPricingStrategyFamily: `SELECT * FROM event_pricing_strategy WHERE EVENT_TYPE_ID >= ? AND EVENT_TYPE_ID < ? ORDER BY EVENT_TYPE_ID, EVENT_PRICING_STRATEGY_ID LIMIT ${STEP_LIMIT}`,
  eventSubscriptionOffers: 'SELECT DISTINCT o.* FROM event_pricing_strategy eps JOIN pricing_combine pc ON pc.EVENT_PRICING_STRATEGY_ID = eps.EVENT_PRICING_STRATEGY_ID JOIN offer o ON o.PRICING_PLAN_ID = pc.PRICING_PLAN_ID WHERE eps.EVENT_TYPE_ID >= ? AND eps.EVENT_TYPE_ID < ? ORDER BY CASE WHEN o.STATUS_CD = \'1000\' THEN 0 ELSE 1 END, o.OFFER_ID LIMIT 20',
  pricingCombineByStrategy: `SELECT * FROM pricing_combine WHERE EVENT_PRICING_STRATEGY_ID = ? LIMIT ${STEP_LIMIT}`,
  pricingObject: `SELECT * FROM pricing_object WHERE PRICING_OBJECT_ID = ? LIMIT ${STEP_LIMIT}`,
  offersByPricingPlan: `SELECT * FROM offer WHERE PRICING_PLAN_ID = ? LIMIT ${STEP_LIMIT}`,
  offerInstancesByOffer: 'SELECT * FROM offer_inst WHERE OFFER_ID = ? LIMIT 3',
  allOfferInstancesByOffer: `SELECT * FROM offer_inst WHERE OFFER_ID = ? LIMIT ${STEP_LIMIT}`,
  offerRelationsByInstance: `SELECT * FROM offer_prod_inst_rel WHERE OFFER_INST_ID = ? LIMIT ${STEP_LIMIT}`,
  voyageOffersByName: 'SELECT * FROM offer_ces WHERE offer_name LIKE ? ORDER BY offer_id LIMIT 50',
  offerById: 'SELECT * FROM offer WHERE offer_id = ? LIMIT 1',
  voyageOfferInstancesByOffer: `SELECT * FROM prod_offer_inst WHERE offer_id = ? LIMIT ${STEP_LIMIT}`,
  voyageOfferRelationsByInstance: `SELECT * FROM offer_prod_inst_rel WHERE prod_offer_inst_id = ? LIMIT ${STEP_LIMIT}`,
  voyageOfferInstanceAttributes: `SELECT * FROM prod_offer_inst_attr WHERE prod_offer_inst_id = ? LIMIT ${STEP_LIMIT}`,
};

function rowValue(row, key) {
  if (!row || typeof row !== 'object') return undefined;
  if (Object.hasOwn(row, key)) return row[key];
  const wanted = String(key).toLowerCase();
  const actual = Object.keys(row).find((candidate) => candidate.toLowerCase() === wanted);
  return actual === undefined ? undefined : row[actual];
}
function valuesOf(rows, key) { return [...new Set(rows.map((row) => rowValue(row, key)).filter((value) => value !== null && value !== undefined && value !== ''))]; }
function valuesOfAny(rows, keys) { return [...new Set(rows.map((row) => keys.map((key) => rowValue(row, key)).find((value) => value !== null && value !== undefined && value !== '')).filter((value) => value !== undefined))]; }
function accessNumber(row) { return rowValue(row, 'ACC_NUM') ?? rowValue(row, 'ACC_NBR') ?? ''; }
function uniqueRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = JSON.stringify(Object.entries(row || {}).sort(([left], [right]) => left.localeCompare(right)));
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function utc8Iso(date = new Date()) { return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00'); }
function sourceMeta(source, database, schema) { return { source, database, ...(source === 'voyage' && schema ? { schema } : {}), readAt: utc8Iso() }; }
function resultSourceMeta(source, schema) { return { source, ...(source === 'voyage' && schema ? { schema } : {}) }; }
function mapQueryTables(sql, source, schema) {
  if (source !== 'voyage' || schema !== 'bill_inmemory') return { sql, tableMap: [], columnMap: [] };
  let mappedSql = sql; const tableMap = []; const columnMap = [];
  for (const [logicalTable, physicalTable] of Object.entries(VOYAGE_BILL_INMEMORY_TABLE_MAP)) {
    const pattern = new RegExp(`\\b(FROM|JOIN)\\s+${logicalTable}\\b`, 'gi');
    if (!pattern.test(mappedSql)) continue;
    mappedSql = mappedSql.replace(pattern, (_match, keyword) => `${keyword} ${physicalTable}`);
    tableMap.push({ logicalTable, physicalTable });
  }
  const columns = /\b(?:FROM|JOIN)\s+prod_inst_rel\b/i.test(sql)
    ? { ...VOYAGE_BILL_INMEMORY_COLUMN_MAP, ...VOYAGE_PRODUCT_RELATION_COLUMN_MAP }
    : { ...VOYAGE_BILL_INMEMORY_COLUMN_MAP };
  for (const [table, mappings] of Object.entries(VOYAGE_TABLE_COLUMN_MAP)) {
    if (new RegExp(`\\b(?:FROM|JOIN)\\s+${table}\\b`, 'i').test(mappedSql)) Object.assign(columns, mappings);
  }
  for (const [logicalColumn, physicalColumn] of Object.entries(columns)) {
    const pattern = new RegExp(`\\b${logicalColumn}\\b`, 'gi');
    if (!pattern.test(mappedSql)) continue;
    mappedSql = mappedSql.replace(pattern, physicalColumn);
    columnMap.push({ logicalColumn, physicalColumn });
  }
  return { sql: mappedSql, tableMap, columnMap };
}

function normalizeQueryRows(rows, source, schema, sql) {
  if (source !== 'voyage' || schema !== 'bill_inmemory' || !/\b(?:FROM|JOIN)\s+prod_inst_rel\b/i.test(sql)) return rows;
  const reverse = Object.fromEntries(Object.entries(VOYAGE_PRODUCT_RELATION_COLUMN_MAP).map(([logical, physical]) => [physical, logical]));
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [reverse[key.toLowerCase()] || key, value])));
}

class QueryContext {
  constructor(db, signal, source = 'udal', schema) { this.db = db; this.signal = signal; this.source = source; this.schema = source === 'voyage' ? schema : undefined; this.count = 0; this.truncated = false; this.steps = []; }
  async step(name, database, sql, values, { schema, source, paged = false } = {}) {
    if (this.signal?.aborted) throw Object.assign(new Error('查询已取消'), { code: 'QUERY_CANCELLED' });
    const effectiveSource = source || this.source;
    const effectiveSchema = effectiveSource === 'voyage' ? (schema || this.schema) : undefined;
    const mapped = mapQueryTables(sql, effectiveSource, effectiveSchema);
    try {
      const rows = normalizeQueryRows(repairBusinessText(await this.db.query(effectiveSource, database, mapped.sql, values, { signal: this.signal, timeout: 15000, ...(effectiveSchema ? { schema: effectiveSchema } : {}) })), effectiveSource, effectiveSchema, mapped.sql);
      const kept = rows.slice(0, Math.max(0, TOTAL_LIMIT - this.count));
      this.count += kept.length;
      if ((!paged && rows.length >= STEP_LIMIT) || kept.length < rows.length) this.truncated = true;
      this.steps.push({ name, status: kept.length ? 'ok' : 'empty', count: kept.length, ...(mapped.tableMap.length ? { tableMap: mapped.tableMap } : {}), ...(mapped.columnMap.length ? { columnMap: mapped.columnMap } : {}), ...sourceMeta(effectiveSource, database, effectiveSchema) });
      return kept;
    } catch (error) {
      if (error.code === 'QUERY_CANCELLED') throw error;
      if (/尚未连接/.test(String(error.message || ''))) throw error;
      this.steps.push({ name, status: 'error', count: 0, message: error.message, ...(mapped.tableMap.length ? { tableMap: mapped.tableMap } : {}), ...(mapped.columnMap.length ? { columnMap: mapped.columnMap } : {}), ...sourceMeta(effectiveSource, database, effectiveSchema) });
      return [];
    }
  }
  async each(name, database, sql, ids, options = {}) {
    const rows = [];
    for (const id of ids) {
      if (this.count >= TOTAL_LIMIT) { this.truncated = true; break; }
      rows.push(...await this.step(`${name}:${id}`, database, sql, [id], options));
    }
    return rows;
  }
}

// 固定档案表按主键 + his_id 游标分页；同一业务 ID 的历史版本全部保留。
async function readBillArchive(ctx, name, table, columns, ids) {
  const pk = BILL_ARCHIVE_TABLES[table];
  if (!pk) throw new Error('档案表不在固定查询范围');
  const logicalTable = Object.entries(VOYAGE_BILL_INMEMORY_TABLE_MAP).find(([, physical]) => physical === table)?.[0] || table;
  const output = [];
  const keys = [...new Set(ids.map(String))];
  for (let start = 0; start < keys.length; start += ARCHIVE_NODE_LIMIT) {
    const batch = keys.slice(start, start + ARCHIVE_NODE_LIMIT);
    const clause = columns.map((column) => batch.length === 1 ? `${column} = ?` : `${column} IN (${batch.map(() => '?').join(', ')})`).join(' OR ');
    const parameters = columns.flatMap(() => batch);
    let cursor;
    for (let page = 1; ; page++) {
      if (ctx.count >= TOTAL_LIMIT) { ctx.truncated = true; return output; }
      let after = ''; const values = [...parameters];
      if (cursor) {
        after = cursor.his === null || cursor.his === undefined
          ? ` AND (${pk} > ? OR (${pk} = ? AND his_id IS NOT NULL))`
          : ` AND (${pk} > ? OR (${pk} = ? AND his_id > ?))`;
        values.push(cursor.id, cursor.id);
        if (cursor.his !== null && cursor.his !== undefined) values.push(cursor.his);
      }
      const sql = `SELECT * FROM ${logicalTable} WHERE (${clause})${after} ORDER BY ${pk}, his_id NULLS FIRST LIMIT ${STEP_LIMIT}`;
      const rows = await ctx.step(`${name}:批${Math.floor(start / ARCHIVE_NODE_LIMIT) + 1}/页${page}`, CRM, sql, values, { paged: true });
      output.push(...rows);
      if (rows.length < STEP_LIMIT) break;
      const last = rows[rows.length - 1];
      const next = { id: rowValue(last, pk), his: rowValue(last, 'his_id') };
      if (next.id === undefined || (cursor && String(next.id) === String(cursor.id) && String(next.his) === String(cursor.his))) {
        ctx.truncated = true;
        ctx.steps.push({ name: `${name}:分页游标`, status: 'error', count: 0, message: '主键与历史版本游标未前进，保留已返回数据', ...sourceMeta(ctx.source, CRM, ctx.schema) });
        break;
      }
      cursor = next;
    }
  }
  return output;
}

async function queryBillProductArchive(ctx, input) {
  const data = { productInstances: [], relatedProductInstances: [], productRelationships: [], productAttributes: [],
    accountRelations: [], accounts: [], offerRelations: [], offerInstances: [], relatedOfferInstances: [],
    offerInstanceRelationships: [], offerInstanceAttributes: [], offers: [] };
  data.productInstances = await readBillArchive(ctx, '产品实例档案（含历史版本）', 'prod_inst', ['prod_inst_id'], [input]);
  const products = new Set([input]); const offers = new Set();
  const processedProducts = new Set(); const processedOffers = new Set(); const directOffers = new Set();
  const allOfferInstances = []; const limitReasons = new Set(); let rounds = 0;
  const addIds = (target, ids, label) => {
    for (const id of ids.map(String)) {
      if (target.has(id)) continue;
      if (target.size >= ARCHIVE_NODE_LIMIT) { ctx.truncated = true; limitReasons.add(`${label}超过 ${ARCHIVE_NODE_LIMIT} 个 ID`); continue; }
      target.add(id);
    }
  };
  // 仅沿实例关系扩展，不按客户、号码或销售品定义扫描其他订购用户。
  if (data.productInstances.length) {
    while (rounds < ARCHIVE_ROUND_LIMIT && ctx.count < TOTAL_LIMIT) {
      const productFrontier = [...products].filter((id) => !processedProducts.has(id));
      const offerFrontierBefore = [...offers].filter((id) => !processedOffers.has(id));
      if (!productFrontier.length && !offerFrontierBefore.length) break;
      rounds++;
      if (productFrontier.length) {
        productFrontier.forEach((id) => processedProducts.add(id));
        data.relatedProductInstances.push(...await readBillArchive(ctx, '关联产品实例（含历史版本）', 'prod_inst', ['prod_inst_id'], productFrontier.filter((id) => id !== input)));
        const relations = await readBillArchive(ctx, '产品实例关系（双向）', 'prod_inst_rel', ['prod_inst_a_id', 'prod_inst_z_id'], productFrontier);
        data.productRelationships.push(...relations);
        data.productAttributes.push(...await readBillArchive(ctx, '产品实例属性（含关联产品）', 'prod_inst_attr', ['prod_inst_id'], productFrontier));
        data.accountRelations.push(...await readBillArchive(ctx, '产品账户关系（含关联产品）', 'prod_inst_acct', ['prod_inst_id'], productFrontier));
        const offerRelations = await readBillArchive(ctx, '产品销售品关系（含关联产品）', 'offer_prod_inst_rel', ['prod_inst_id'], productFrontier);
        data.offerRelations.push(...offerRelations);
        for (const row of offerRelations) {
          if (String(rowValue(row, 'prod_inst_id')) === input) valuesOfAny([row], ['prod_offer_inst_id', 'offer_inst_id']).forEach((id) => directOffers.add(String(id)));
        }
        addIds(products, [...valuesOf(relations, 'a_prod_inst_id'), ...valuesOf(relations, 'z_prod_inst_id')], '关联产品');
        addIds(offers, valuesOfAny(offerRelations, ['prod_offer_inst_id', 'offer_inst_id']), '关联销售品');
      }
      const offerFrontier = [...offers].filter((id) => !processedOffers.has(id));
      if (offerFrontier.length) {
        offerFrontier.forEach((id) => processedOffers.add(id));
        allOfferInstances.push(...await readBillArchive(ctx, '销售品实例（含历史版本）', 'prod_offer_inst', ['prod_offer_inst_id'], offerFrontier));
        data.offerInstanceAttributes.push(...await readBillArchive(ctx, '销售品实例属性（含关联销售品）', 'prod_offer_inst_attr', ['prod_offer_inst_id'], offerFrontier));
        const relations = await readBillArchive(ctx, '销售品实例关系（双向）', 'prod_offer_inst_rel', ['rela_prod_offer_inst_id', 'related_prod_offer_inst_id'], offerFrontier);
        data.offerInstanceRelationships.push(...relations);
        const productRelations = await readBillArchive(ctx, '销售品关联产品关系', 'offer_prod_inst_rel', ['prod_offer_inst_id'], offerFrontier);
        data.offerRelations.push(...productRelations);
        addIds(products, valuesOf(productRelations, 'prod_inst_id'), '关联产品');
        addIds(offers, [...valuesOf(relations, 'rela_prod_offer_inst_id'), ...valuesOf(relations, 'related_prod_offer_inst_id')], '关联销售品');
      }
    }
    if ([...products].some((id) => !processedProducts.has(id)) || [...offers].some((id) => !processedOffers.has(id))) {
      ctx.truncated = true; limitReasons.add(rounds >= ARCHIVE_ROUND_LIMIT ? `关联展开达到 ${ARCHIVE_ROUND_LIMIT} 轮` : `累计读取达到 ${TOTAL_LIMIT} 行`);
    }
    data.accounts = await readBillArchive(ctx, '账户（含历史版本）', 'account', ['account_id'], valuesOfAny(data.accountRelations, ['account_id', 'acct_id']));
    const definitionIds = valuesOfAny(allOfferInstances, ['prod_offer_id', 'offer_id']).map(String);
    for (let start = 0; start < definitionIds.length; start += ARCHIVE_NODE_LIMIT) {
      if (ctx.count >= TOTAL_LIMIT) { ctx.truncated = true; break; }
      const batch = definitionIds.slice(start, start + ARCHIVE_NODE_LIMIT);
      const clause = batch.length === 1 ? 'offer_id = ?' : `offer_id IN (${batch.map(() => '?').join(', ')})`;
      const rows = await ctx.step('销售品定义（批量）', CRM, `SELECT * FROM offer WHERE ${clause} ORDER BY offer_id LIMIT ${STEP_LIMIT}`, batch);
      data.offers.push(...rows);
      if (rows.length >= STEP_LIMIT) limitReasons.add(`销售品定义批次达到 ${STEP_LIMIT} 行，覆盖待核对`);
    }
  }
  if (ctx.truncated && ctx.count >= TOTAL_LIMIT) limitReasons.add(`累计读取达到 ${TOTAL_LIMIT} 行`);
  if (ctx.steps.some((step) => step.status === 'error' && step.name.endsWith('分页游标'))) limitReasons.add('分页游标未前进');
  data.offerInstances = allOfferInstances.filter((row) => directOffers.has(String(rowValue(row, 'prod_offer_inst_id'))));
  data.relatedOfferInstances = allOfferInstances.filter((row) => !directOffers.has(String(rowValue(row, 'prod_offer_inst_id'))));
  for (const key of Object.keys(data)) data[key] = uniqueRows(data[key]);
  const absent = (ids, rows, keys) => { const found = new Set(valuesOfAny(rows, keys).map(String)); return [...new Set(ids.map(String))].filter((id) => !found.has(id)); };
  const missingReferences = {
    productInstances: data.productInstances.length ? absent([...products], [...data.productInstances, ...data.relatedProductInstances], ['prod_inst_id']) : [],
    offerInstances: absent([...offers], allOfferInstances, ['prod_offer_inst_id', 'offer_inst_id']),
    accounts: absent(valuesOfAny(data.accountRelations, ['account_id', 'acct_id']), data.accounts, ['account_id', 'acct_id']),
    offers: absent(valuesOfAny(allOfferInstances, ['prod_offer_id', 'offer_id']), data.offers, ['offer_id']),
  };
  const hasErrors = ctx.steps.some((step) => step.status === 'error');
  const missing = Object.values(missingReferences).some((ids) => ids.length);
  return { status: !data.productInstances.length ? (hasErrors ? 'failed' : 'empty') : (hasErrors || missing || ctx.truncated ? 'partial' : 'complete'),
    queriedAt: utc8Iso(), truncated: ctx.truncated, totalRows: Object.values(data).reduce((sum, rows) => sum + rows.length, 0), steps: ctx.steps, data,
    archiveCoverage: { mode: 'related-instance-graph', history: 'all-available-versions', tables: Object.keys(BILL_ARCHIVE_TABLES),
      productInstanceCount: products.size, offerInstanceCount: offers.size, rounds, readRows: ctx.count,
      limits: { nodesPerKind: ARCHIVE_NODE_LIMIT, rounds: ARCHIVE_ROUND_LIMIT, readRows: TOTAL_LIMIT }, limitReasons: [...limitReasons], missingReferences } };
}

async function aggregateProductArchive(ctx, productInstances, { includeArchiveExtensions = false } = {}) {
  const voyageBillInmemory = ctx.source === 'voyage' && ctx.schema === 'bill_inmemory';
  const productIds = valuesOf(productInstances, 'PROD_ID');
  const instanceIds = valuesOf(productInstances, 'prod_inst_id');
  const [productDefinitions, accountRelations, offerRelations] = await Promise.all([
    voyageBillInmemory ? Promise.resolve([]) : ctx.each('产品定义', CRM, SQL.product, productIds),
    ctx.each('产品账户关系', CRM, SQL.accountRel, instanceIds),
    ctx.each('产品销售品关系', CRM, SQL.offerRel, instanceIds),
  ]);
  let accessProductInstances = []; let productRelationships = []; let relatedProductInstances = [];
  let productAttributes = []; let productStates = []; let productExtensions = []; let productContacts = [];
  let productPaymodes = []; let productAccessNumbers = []; let productNumberRelations = []; let productParties = [];
  let productResourceRelations = [];
  let offerInstanceRelationships = []; let relatedOfferInstances = []; let offerInstanceAttributes = [];
  let offerInstanceFees = []; let offerInstanceFeeAttributes = []; let offerObjectInstanceRelations = [];
  let offerResourceInstanceRelations = []; let offerInstanceAssurances = []; let offerCouponInstanceRelations = [];
  let skuInstances = []; let valueAddedOrderRelations = [];
  if (includeArchiveExtensions) {
    const rootIds = instanceIds.map(String);
    const accessInstanceIds = valuesOf(productInstances, 'acc_prod_inst_id').filter((id) => !rootIds.includes(String(id)));
    const [relationshipsByA, relationshipsByZ, attributes, states, extensions, contacts, paymodes, accessNumbers,
      numberRelations, parties, resourceRelations, accessInstances] = await Promise.all([
      ctx.each('产品实例关系(A端)', CRM, SQL.relationshipByA, instanceIds),
      ctx.each('产品实例关系(Z端)', CRM, SQL.relationshipByZ, instanceIds),
      ctx.each('产品实例属性', CRM, SQL.productAttribute, instanceIds),
      voyageBillInmemory ? Promise.resolve([]) : ctx.each('产品实例状态', CRM, SQL.productState, instanceIds),
      voyageBillInmemory ? Promise.resolve([]) : ctx.each('产品实例扩展', CRM, SQL.productExtension, instanceIds),
      voyageBillInmemory ? Promise.resolve([]) : ctx.each('产品实例联系人', CRM, SQL.productContact, instanceIds),
      voyageBillInmemory ? Promise.resolve([]) : ctx.each('产品实例付费方式', CRM, SQL.productPaymode, instanceIds),
      voyageBillInmemory ? Promise.resolve([]) : ctx.each('产品实例接入号码', CRM, SQL.productAccessNumber, instanceIds),
      voyageBillInmemory ? Promise.resolve([]) : ctx.each('产品号码关联', CRM, SQL.productNumberRelation, instanceIds),
      voyageBillInmemory ? Promise.resolve([]) : ctx.each('产品实例参与人', CRM, SQL.productParty, instanceIds),
      voyageBillInmemory ? Promise.resolve([]) : ctx.each('产品资源实例关系', CRM, SQL.productResourceRelation, instanceIds),
      ctx.each('接入产品实例', CRM, SQL.productsByInstance, accessInstanceIds),
    ]);
    productRelationships = uniqueRows([...relationshipsByA, ...relationshipsByZ]);
    const relatedInstanceIds = [...new Set([
      ...valuesOf(productRelationships, 'a_prod_inst_id'), ...valuesOf(productRelationships, 'z_prod_inst_id'),
    ].map(String))].filter((id) => !rootIds.includes(id) && !accessInstanceIds.map(String).includes(id));
    relatedProductInstances = await ctx.each('关联产品实例', CRM, SQL.productsByInstance, relatedInstanceIds);
    [productAttributes, productStates, productExtensions, productContacts, productPaymodes, productAccessNumbers,
      productNumberRelations, productParties, productResourceRelations, accessProductInstances] = [
      attributes, states, extensions, contacts, paymodes, accessNumbers, numberRelations, parties, resourceRelations, accessInstances,
    ];
  }
  const accounts = await ctx.each('账户', CRM, SQL.account, valuesOfAny(accountRelations, ['ACCT_ID', 'ACCOUNT_ID']));
  const directOfferInstanceIds = valuesOfAny(offerRelations, ['OFFER_INST_ID', 'PROD_OFFER_INST_ID']).map(String);
  const offerInstances = await ctx.each('销售品实例', CRM, SQL.offerInst, directOfferInstanceIds);
  if (includeArchiveExtensions) {
    if (voyageBillInmemory) {
      offerInstanceAttributes = await ctx.each('销售品实例属性', CRM, SQL.offerInstanceAttribute, directOfferInstanceIds);
    } else {
      const [relationsByA, relationsByZ] = await Promise.all([
        ctx.each('销售品实例关系(A端)', CRM, SQL.offerInstanceRelationByA, directOfferInstanceIds),
        ctx.each('销售品实例关系(Z端)', CRM, SQL.offerInstanceRelationByZ, directOfferInstanceIds),
      ]);
      offerInstanceRelationships = uniqueRows([...relationsByA, ...relationsByZ]);
      const relatedOfferInstanceIds = [...new Set([
        ...valuesOf(offerInstanceRelationships, 'A_OFFER_INST_ID'), ...valuesOf(offerInstanceRelationships, 'Z_OFFER_INST_ID'),
      ].map(String))].filter((id) => !directOfferInstanceIds.includes(id));
      relatedOfferInstances = await ctx.each('关联销售品实例', CRM, SQL.offerInst, relatedOfferInstanceIds);
      const allOfferInstanceIds = [...new Set([...directOfferInstanceIds, ...relatedOfferInstanceIds])];
      [offerInstanceAttributes, offerInstanceFees, offerObjectInstanceRelations, offerResourceInstanceRelations,
        offerInstanceAssurances, offerCouponInstanceRelations, skuInstances, valueAddedOrderRelations] = await Promise.all([
        ctx.each('销售品实例属性', CRM, SQL.offerInstanceAttribute, allOfferInstanceIds),
        ctx.each('销售品实例费用', CRM, SQL.offerInstanceFee, allOfferInstanceIds),
        ctx.each('销售品关联对象', CRM, SQL.offerObjectInstanceRelation, allOfferInstanceIds),
        ctx.each('销售品关联资源', CRM, SQL.offerResourceInstanceRelation, allOfferInstanceIds),
        ctx.each('销售品实例担保', CRM, SQL.offerInstanceAssurance, allOfferInstanceIds),
        ctx.each('销售品优惠券关系', CRM, SQL.offerCouponInstanceRelation, allOfferInstanceIds),
        ctx.each('SKU 实例', CRM, SQL.skuInstance, allOfferInstanceIds),
        ctx.each('增值业务订购关系', CRM, SQL.valueAddedOrderRelation, allOfferInstanceIds),
      ]);
      offerInstanceFeeAttributes = await ctx.each('销售品实例费用属性', CRM, SQL.offerInstanceFeeAttribute, valuesOf(offerInstanceFees, 'OFFER_INST_FEE_INFO_ID'));
    }
  }
  const allOfferInstances = uniqueRows([...offerInstances, ...relatedOfferInstances]);
  const offers = await ctx.each('销售品定义', voyageBillInmemory ? CRM : CONFIG, SQL.offer, valuesOfAny(allOfferInstances, ['offer_id', 'prod_offer_id']));
  const pricingPlans = voyageBillInmemory ? [] : await ctx.each('定价计划', CONFIG, SQL.pricingPlan, valuesOf(offers, 'pricing_plan_id'));
  const hasErrors = ctx.steps.some((step) => step.status === 'error');
  const missingRelations = productInstances.length > 0 && (
    (!voyageBillInmemory && productIds.length > 0 && !productDefinitions.length) || !accountRelations.length || !offerRelations.length ||
    (offerRelations.length > 0 && !offerInstances.length) || (offerInstances.length > 0 && !offers.length) ||
    (!voyageBillInmemory && valuesOf(offers, 'pricing_plan_id').length > 0 && !pricingPlans.length)
  );
  return {
    status: !productInstances.length ? (hasErrors ? 'failed' : 'empty') : (hasErrors || missingRelations || ctx.truncated ? 'partial' : 'complete'),
    queriedAt: utc8Iso(), truncated: ctx.truncated, totalRows: ctx.count, steps: ctx.steps,
    data: {
      productInstances, productDefinitions, accessProductInstances, productRelationships, relatedProductInstances,
      productAttributes, productStates, productExtensions, productContacts, productPaymodes, productAccessNumbers,
      productNumberRelations, productParties, productResourceRelations, accountRelations, accounts, offerRelations,
      offerInstances, offerInstanceRelationships, relatedOfferInstances, offerInstanceAttributes, offerInstanceFees,
      offerInstanceFeeAttributes, offerObjectInstanceRelations, offerResourceInstanceRelations, offerInstanceAssurances,
      offerCouponInstanceRelations, skuInstances, valueAddedOrderRelations, offers, pricingPlans,
    },
  };
}

async function queryPhone(db, phone, { signal, source = 'udal', schema } = {}) {
  const input = String(phone || '').trim();
  if (!input) throw new Error('手机号或接入号码不能为空');
  const ctx = new QueryContext(db, signal, source, schema);
  const productInstances = await ctx.step('号码产品实例', CRM, SQL.productsByPhone, [input]);
  return { phone: input, ...resultSourceMeta(source, schema), ...await aggregateProductArchive(ctx, productInstances) };
}

async function queryProductInstance(db, productInstanceId, { signal, source = 'udal', schema } = {}) {
  const input = String(productInstanceId ?? '').trim();
  if (!input) throw new Error('产品实例 ID 不能为空');
  if (!/^\d+$/.test(input)) throw new Error('产品实例 ID 必须是数字');
  const ctx = new QueryContext(db, signal, source, schema);
  if (source === 'voyage' && schema === 'bill_inmemory') {
    return { productInstanceId: input, ...resultSourceMeta(source, schema), ...await queryBillProductArchive(ctx, input) };
  }
  const productInstances = await ctx.step('产品实例档案', CRM, SQL.productsByInstance, [input]);
  return { productInstanceId: input, ...resultSourceMeta(source, schema), ...await aggregateProductArchive(ctx, productInstances, { includeArchiveExtensions: true }) };
}

async function queryCustomerProducts(db, customerId, options = {}) {
  const id = String(customerId ?? '').trim(); if (!id) throw new Error('客户 ID 不能为空');
  const source = options.source || 'udal'; const ctx = new QueryContext(db, options.signal, source, options.schema); const rows = await ctx.step('同客户其他产品', CRM, SQL.customerProducts, [id]);
  return { customerId: id, ...resultSourceMeta(source, options.schema), queriedAt: utc8Iso(), truncated: ctx.truncated, rows, steps: ctx.steps };
}

async function queryAccountCandidates(db, { productInstanceId, customerId }, options = {}) {
  const productId = String(productInstanceId ?? '').trim(); const custId = String(customerId ?? '').trim();
  if (!productId && !custId) throw new Error('产品实例 ID 或客户 ID 至少填写一个');
  const source = options.source || 'udal'; const ctx = new QueryContext(db, options.signal, source, options.schema); const rows = [];
  if (productId) rows.push(...await ctx.step('按产品实例查账户候选', CRM, SQL.accountByProduct, [productId]));
  if (custId) rows.push(...await ctx.step('按客户查账户候选', CRM, SQL.accountByCustomer, [custId]));
  const unique = [...new Map(rows.map((row) => [String(rowValue(row, 'acct_id') ?? rowValue(row, 'account_id')), row])).values()];
  return { productInstanceId: productId || null, customerId: custId || null, ...resultSourceMeta(source, options.schema), candidate: true, queriedAt: utc8Iso(), truncated: ctx.truncated, rows: unique, steps: ctx.steps };
}

async function queryOffer(db, offerId, { signal, source = 'udal', schema } = {}) {
  const input = String(offerId ?? '').trim();
  if (!/^\d+$/.test(input)) throw new Error('套餐 offer_id 必须是数字');
  const ctx = new QueryContext(db, signal, source, schema);
  const voyage = source === 'voyage' && schema === 'bill_inmemory';
  const offers = await ctx.step('按 offer_id 查询套餐定义', voyage ? CRM : CONFIG, SQL.offerById, [input]);
  const offerIds = valuesOf(offers, 'OFFER_ID');
  const offerInstances = await ctx.each('套餐实例', CRM, voyage ? SQL.voyageOfferInstancesByOffer : SQL.allOfferInstancesByOffer, offerIds);
  const instanceKey = voyage ? 'PROD_OFFER_INST_ID' : 'OFFER_INST_ID';
  const instanceIds = valuesOf(offerInstances, instanceKey);
  const [offerRelations, offerInstanceAttributes] = await Promise.all([
    ctx.each('套餐实例产品关系', CRM, voyage ? SQL.voyageOfferRelationsByInstance : SQL.offerRelationsByInstance, instanceIds),
    voyage ? ctx.each('套餐实例属性', CRM, SQL.voyageOfferInstanceAttributes, instanceIds) : Promise.resolve([]),
  ]);
  const productIds = valuesOf(offerRelations, 'PROD_INST_ID');
  if (productIds.length > 100) ctx.truncated = true;
  const productInstances = await ctx.each('订购套餐的产品实例', CRM, SQL.productsByInstance, productIds.slice(0, 100));
  const pricingPlans = voyage ? [] : await ctx.each('套餐定价计划', CONFIG, SQL.pricingPlan, valuesOf(offers, 'PRICING_PLAN_ID'));
  const offer = offers[0] || {};
  const productsById = new Map(productInstances.map((row) => [String(rowValue(row, 'PROD_INST_ID')), row]));
  const subscribers = uniqueRows(offerRelations.map((relation) => {
    const id = String(rowValue(relation, 'PROD_INST_ID') || '');
    const instanceId = String(rowValue(relation, instanceKey) || '');
    const instance = offerInstances.find((row) => String(rowValue(row, instanceKey)) === instanceId) || {};
    const product = productsById.get(id) || {};
    return {
      OWNER_CUST_ID: rowValue(product, 'OWNER_CUST_ID') ?? rowValue(instance, 'OWNER_CUST_ID') ?? '',
      OFFER_ID: input, OFFER_NAME: rowValue(offer, 'OFFER_NAME') ?? '',
      [instanceKey]: instanceId, OFFER_INST_STATUS: rowValue(instance, 'STATUS_CD') ?? '',
      PROD_INST_ID: id, ACC_NUM: accessNumber(product), PROD_ID: rowValue(product, 'PROD_ID') ?? '',
      PROD_INST_STATUS: rowValue(product, 'STATUS_CD') ?? '',
    };
  }));
  const hasErrors = ctx.steps.some((step) => step.status === 'error');
  const hasRows = [offers, offerInstances, offerRelations, offerInstanceAttributes, productInstances].some((rows) => rows.length);
  return {
    offerId: input, ...resultSourceMeta(source, schema),
    status: hasErrors ? (hasRows ? 'partial' : 'failed') : (hasRows ? (ctx.truncated ? 'partial' : 'complete') : 'empty'),
    queriedAt: utc8Iso(), truncated: ctx.truncated, totalRows: ctx.count, steps: ctx.steps,
    data: { offers, offerInstances, offerRelations, offerInstanceAttributes, productInstances, pricingPlans, subscribers },
  };
}

async function queryEventType(db, eventTypeId, { signal, source = 'udal', schema, offerName } = {}) {
  const input = String(eventTypeId ?? '').trim();
  if (!/^\d+$/.test(input)) throw new Error('事件类型 ID 必须是数字');
  const definition = EVENT_TYPE_CATALOG.find((item) => item.routeEventTypeId === input)
    || EVENT_TYPE_CATALOG.find((item) => item.eventTypeId === input)
    || { sourceTypeSequence: input, eventTypeId: input, routeEventTypeId: input, name: '未收录类型', targetTable: '' };
  if (source === 'voyage') {
    const keyword = String(offerName || definition.name || '').trim();
    if (!keyword || keyword === '未收录类型') throw new Error('工程环境查询需要填写套餐名称');
    const ctx = new QueryContext(db, signal, source, schema);
    const likePattern = `%${keyword.replace(/\s+/g, '%')}%`;
    const offers = await ctx.step('按套餐名称查询销售品定义', CRM, SQL.voyageOffersByName, [likePattern]);
    const offerInstances = await ctx.each('按套餐查询销售品实例', CRM, SQL.voyageOfferInstancesByOffer, valuesOf(offers, 'OFFER_ID'));
    const offerInstanceIds = valuesOf(offerInstances, 'PROD_OFFER_INST_ID');
    const [offerRelations, offerInstanceAttributes] = await Promise.all([
      ctx.each('销售品实例与产品实例关系', CRM, SQL.voyageOfferRelationsByInstance, offerInstanceIds),
      ctx.each('销售品实例属性', CRM, SQL.voyageOfferInstanceAttributes, offerInstanceIds),
    ]);
    const productInstances = await ctx.each('订购套餐的产品实例', CRM, SQL.productsByInstance, valuesOf(offerRelations, 'PROD_INST_ID'));
    const offersById = new Map(offers.map((row) => [String(rowValue(row, 'OFFER_ID')), row]));
    const instancesById = new Map(offerInstances.map((row) => [String(rowValue(row, 'PROD_OFFER_INST_ID')), row]));
    const productsById = new Map(productInstances.map((row) => [String(rowValue(row, 'PROD_INST_ID')), row]));
    const subscribers = uniqueRows(offerRelations.map((relation) => {
      const productInstanceId = String(rowValue(relation, 'PROD_INST_ID') || '');
      const offerInstanceId = String(rowValue(relation, 'PROD_OFFER_INST_ID') || '');
      const instance = instancesById.get(offerInstanceId) || {};
      const offerId = String(rowValue(instance, 'PROD_OFFER_ID') ?? rowValue(instance, 'OFFER_ID') ?? '');
      const offer = offersById.get(offerId) || {};
      const product = productsById.get(productInstanceId) || {};
      return {
        OWNER_CUST_ID: rowValue(product, 'OWNER_CUST_ID') ?? '', OFFER_ID: offerId,
        OFFER_NAME: rowValue(offer, 'OFFER_NAME') ?? keyword, PROD_OFFER_INST_ID: offerInstanceId,
        OFFER_INST_STATUS: rowValue(instance, 'STATUS_CD') ?? '', PROD_INST_ID: productInstanceId,
        ACC_NUM: accessNumber(product), PROD_ID: rowValue(product, 'PROD_ID') ?? '', PROD_INST_STATUS: rowValue(product, 'STATUS_CD') ?? '',
      };
    }));
    const hasErrors = ctx.steps.some((step) => step.status === 'error');
    const hasRows = [offers, offerInstances, offerRelations, offerInstanceAttributes, productInstances, subscribers].some((rows) => rows.length);
    return {
      eventTypeId: input, definition, offerNameQuery: keyword, ...resultSourceMeta(source, schema),
      status: hasErrors ? (hasRows ? 'partial' : 'failed') : (hasRows ? (ctx.truncated ? 'partial' : 'complete') : 'empty'),
      queriedAt: utc8Iso(), truncated: ctx.truncated, totalRows: ctx.count, steps: ctx.steps,
      data: {
        eventTypeMappings: [], eventTypeFormats: [], eventFormats: [], eventFormatItems: [], resourceAttributes: [], targetTables: [],
        eventPricingStrategies: [], pricingCombines: [], pricingObjects: [], pricingPlans: [], offers, offerInstances, offerRelations, offerInstanceAttributes, productInstances, subscribers,
      },
    };
  }
  const ctx = new QueryContext(db, signal, source, schema);
  const configQueryOptions = {};
  const familyBase = /^\d{9}$/.test(String(definition.eventTypeId))
    ? `${String(definition.eventTypeId).slice(0, 6)}000`
    : String(definition.eventTypeId);
  const familyStart = BigInt(familyBase);
  const familyEnd = familyStart + 1000n;
  const familyRange = [familyStart.toString(), familyEnd.toString()];
  const eventPricingStrategies = await ctx.step('事件定价策略族', CONFIG, SQL.eventPricingStrategyFamily, familyRange, configQueryOptions);
  const pricingCombines = await ctx.each('事件定价组合', CONFIG, SQL.pricingCombineByStrategy, valuesOf(eventPricingStrategies, 'EVENT_PRICING_STRATEGY_ID'), configQueryOptions);
  const pricingObjects = await ctx.each('事件定价对象', CONFIG, SQL.pricingObject, valuesOf(pricingCombines, 'PRICING_OBJECT_ID'), configQueryOptions);
  const offers = await ctx.step('事件关联套餐定义', CONFIG, SQL.eventSubscriptionOffers, familyRange, configQueryOptions);
  const pricingPlanIds = [...new Set([...valuesOf(offers, 'PRICING_PLAN_ID'), ...valuesOf(pricingCombines, 'PRICING_PLAN_ID')])];
  const pricingPlans = await ctx.each('事件关联定价计划', CONFIG, SQL.pricingPlan, pricingPlanIds, configQueryOptions);
  const offerInstances = await ctx.each('事件关联套餐实例（每套餐最多3条）', CRM, SQL.offerInstancesByOffer, valuesOf(offers, 'OFFER_ID'));
  const offerRelations = await ctx.each('套餐实例产品关系', CRM, SQL.offerRelationsByInstance, valuesOf(offerInstances, 'OFFER_INST_ID'));
  const matchedProductIds = valuesOf(offerRelations, 'PROD_INST_ID').map(String).slice(0, 100);
  if (valuesOf(offerRelations, 'PROD_INST_ID').length > matchedProductIds.length) ctx.truncated = true;
  const productInstances = await ctx.each('拥有套餐的产品实例（最多100条）', CRM, SQL.productsByInstance, matchedProductIds);
  const offerById = new Map(offers.map((row) => [String(rowValue(row, 'OFFER_ID')), row]));
  const productById = new Map(productInstances.map((row) => [String(rowValue(row, 'PROD_INST_ID')), row]));
  const relationsByOfferInstance = new Map();
  for (const row of offerRelations) {
    const key = String(rowValue(row, 'OFFER_INST_ID'));
    if (!relationsByOfferInstance.has(key)) relationsByOfferInstance.set(key, []);
    relationsByOfferInstance.get(key).push(row);
  }
  const subscribers = uniqueRows(offerInstances.flatMap((instance) => {
    const offerId = String(rowValue(instance, 'OFFER_ID'));
    const offerInstanceId = String(rowValue(instance, 'OFFER_INST_ID'));
    const offer = offerById.get(offerId) || {};
    const relations = relationsByOfferInstance.get(offerInstanceId) || [null];
    return relations.map((relation) => {
      const productInstanceId = relation ? String(rowValue(relation, 'PROD_INST_ID')) : '';
      const product = productById.get(productInstanceId) || {};
      return {
        OWNER_CUST_ID: rowValue(instance, 'OWNER_CUST_ID') ?? '', OFFER_ID: offerId,
        OFFER_NAME: rowValue(offer, 'OFFER_NAME') ?? '', PRICING_PLAN_ID: rowValue(offer, 'PRICING_PLAN_ID') ?? '',
        OFFER_INST_ID: offerInstanceId, OFFER_INST_STATUS: rowValue(instance, 'STATUS_CD') ?? '',
        PROD_INST_ID: productInstanceId, ACC_NUM: accessNumber(product), PROD_ID: rowValue(product, 'PROD_ID') ?? '',
        PROD_INST_STATUS: rowValue(product, 'STATUS_CD') ?? '',
      };
    });
  }));
  const eventTypeMappings = await ctx.step('源事件类型映射', CONFIG, SQL.sourceEventTypeFormats, [
    definition.sourceTypeSequence, definition.routeEventTypeId, definition.eventTypeId, definition.routeEventTypeId,
  ], configQueryOptions);
  const eventTypeFormats = await ctx.step('基础事件类型格式', CONFIG, SQL.eventTypeFormats, [definition.eventTypeId, definition.routeEventTypeId], configQueryOptions);
  const formatIds = [...new Set(valuesOf(eventTypeFormats, 'EVENT_FORMAT_ID').map(String))];
  const [eventFormats, eventFormatItems] = await Promise.all([
    ctx.each('事件格式定义', CONFIG, SQL.eventFormat, formatIds, configQueryOptions),
    ctx.each('事件格式字段', CONFIG, SQL.eventFormatItems, formatIds, configQueryOptions),
  ]);
  const resourceAttributes = await ctx.each('资源属性定义', CONFIG, SQL.resourceAttribute, valuesOf(eventFormatItems, 'EVENT_ATTR_ID'), configQueryOptions);
  const targetTables = await ctx.step('详单入库目标表', CONFIG, SQL.targetTables, [definition.sourceTypeSequence, definition.eventTypeId, definition.routeEventTypeId], configQueryOptions);
  const hasErrors = ctx.steps.some((step) => step.status === 'error');
  const hasRows = [eventTypeMappings, eventTypeFormats, eventFormats, eventFormatItems, resourceAttributes, targetTables,
    eventPricingStrategies, pricingCombines, pricingObjects, pricingPlans, offers, offerInstances, offerRelations, productInstances, subscribers].some((rows) => rows.length);
  return {
    eventTypeId: input, definition, eventTypeFamily: { start: familyRange[0], endExclusive: familyRange[1] }, subscriptionSampled: offers.length >= 20,
    ...resultSourceMeta(source, schema),
    status: hasErrors ? (hasRows ? 'partial' : 'failed') : (hasRows ? (ctx.truncated ? 'partial' : 'complete') : 'empty'),
    queriedAt: utc8Iso(), truncated: ctx.truncated, totalRows: ctx.count, steps: ctx.steps,
    data: {
      eventTypeMappings, eventTypeFormats, eventFormats, eventFormatItems, resourceAttributes, targetTables,
      subscribers, eventPricingStrategies, pricingCombines, pricingObjects, pricingPlans, offers, offerInstances, offerRelations, productInstances,
    },
  };
}

async function queryThreshold(db, aProductInstanceId, { signal, source = 'udal', schema } = {}) {
  const input = String(aProductInstanceId ?? '').trim();
  if (!input) throw new Error('A 端产品实例 ID 不能为空');
  if (!/^\d+$/.test(input)) throw new Error('A 端产品实例 ID 必须是数字');
  const ctx = new QueryContext(db, signal, source, schema);
  const relationships = await ctx.step('A/Z 产品实例关系', CRM, SQL.thresholdRelations, [input]);
  const zProductInstanceIds = valuesOf(relationships, 'z_prod_inst_id').map(String);
  const terminalProducts = await ctx.each('终端产品实例', CRM, SQL.thresholdTerminalProduct, zProductInstanceIds);
  const thresholdAttributes = (await ctx.each('档位提醒配置', CRM, SQL.thresholdAttributes, valuesOf(terminalProducts, 'prod_inst_id')))
    .map((row) => ({ ...row, threshold_level: THRESHOLD_LEVELS[String(rowValue(row, 'attr_id'))] || '未知档位' }));
  const hasErrors = ctx.steps.some((step) => step.status === 'error');
  const status = hasErrors
    ? (relationships.length || terminalProducts.length || thresholdAttributes.length ? 'partial' : 'failed')
    : (!relationships.length || !terminalProducts.length ? 'empty' : (!thresholdAttributes.length || ctx.truncated ? 'partial' : 'complete'));
  return {
    aProductInstanceId: input, ...resultSourceMeta(source, schema), productId: THRESHOLD_PRODUCT_ID, thresholdLevels: THRESHOLD_LEVELS,
    status, queriedAt: utc8Iso(), truncated: ctx.truncated, totalRows: ctx.count, steps: ctx.steps,
    data: { relationships, terminalProducts, thresholdAttributes },
  };
}

module.exports = { CRM, CONFIG, STEP_LIMIT, TOTAL_LIMIT, THRESHOLD_PRODUCT_ID, THRESHOLD_LEVELS, THRESHOLD_ATTR_IDS, EVENT_TYPE_CATALOG, VOYAGE_BILL_INMEMORY_TABLE_MAP, SQL, QueryContext, aggregateProductArchive, queryPhone, queryProductInstance, queryCustomerProducts, queryAccountCandidates, queryOffer, queryEventType, queryThreshold, rowValue, valuesOf, uniqueRows, mapQueryTables, utc8Iso };
