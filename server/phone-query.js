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

const SQL = {
  productsByPhone: `SELECT prod_inst_id, PROD_ID, acc_prod_inst_id, acc_num, OWNER_CUST_ID, use_cust_id, payment_mode_cd, STATUS_CD, stop_status, begin_rent_date, stop_rent_date, REGION_ID, lan_id FROM prod_inst WHERE acc_num = ? ORDER BY prod_inst_id LIMIT ${STEP_LIMIT}`,
  customerProducts: `SELECT prod_inst_id, PROD_ID, acc_prod_inst_id, acc_num, payment_mode_cd, STATUS_CD, stop_status, begin_rent_date, stop_rent_date, REGION_ID, lan_id FROM prod_inst WHERE OWNER_CUST_ID = ? ORDER BY prod_inst_id LIMIT ${STEP_LIMIT}`,
  product: 'SELECT prod_id, prod_nbr, prod_name, alias_name, prod_desc, prod_comp_type, prod_func_type, prod_use_type, base_offer_id, STATUS_CD, eff_date, exp_date FROM product WHERE prod_id = ? LIMIT 500',
  accountRel: 'SELECT prod_inst_acct_rel_id, PROD_INST_ID, ACCT_ID, IF_DEFAULT_ACCT_ID, PRIORITY, PAYMENT_LIMIT_TYPE, PAYMENT_LIMIT, STATUS_CD, EFF_DATE, EXP_DATE, region_id, lan_id FROM prod_inst_acct_rel WHERE PROD_INST_ID = ? LIMIT 500',
  account: 'SELECT acct_id, TRIM(ACCT_CD) AS contract_no, ACCT_NAME, CUST_ID, PROD_INST_ID, if_default, contact_phone, mobile_phone, STATUS_CD, EFF_DATE, EXP_DATE, region_id, lan_id FROM account WHERE acct_id = ? LIMIT 500',
  accountByProduct: 'SELECT acct_id, TRIM(ACCT_CD) AS contract_no, ACCT_NAME, CUST_ID, PROD_INST_ID, if_default, contact_phone, mobile_phone, STATUS_CD, EFF_DATE, EXP_DATE, region_id, lan_id FROM account WHERE PROD_INST_ID = ? LIMIT 500',
  accountByCustomer: 'SELECT acct_id, TRIM(ACCT_CD) AS contract_no, ACCT_NAME, CUST_ID, PROD_INST_ID, if_default, contact_phone, mobile_phone, STATUS_CD, EFF_DATE, EXP_DATE, region_id, lan_id FROM account WHERE CUST_ID = ? LIMIT 500',
  offerRel: 'SELECT offer_prod_inst_rel_id, PROD_INST_ID, OFFER_INST_ID, role_id, rel_type, STATUS_CD, eff_date, exp_date FROM offer_prod_inst_rel WHERE PROD_INST_ID = ? LIMIT 500',
  offerInst: 'SELECT offer_inst_id, offer_id, OWNER_CUST_ID, OFFER_TYPE, service_nbr, STATUS_CD, eff_date, exp_date, status_date, update_date FROM offer_inst WHERE offer_inst_id = ? LIMIT 500',
  offer: 'SELECT offer_id, offer_name, inner_offer_name, offer_nbr, ext_offer_nbr, offer_type, ibs_offer_type, pricing_plan_id, offer_desc, status_cd, eff_date, exp_date, status_date, update_date FROM offer WHERE offer_id = ? LIMIT 500',
  pricingPlan: 'SELECT * FROM pricing_plan WHERE pricing_plan_id = ? LIMIT 500',
  thresholdRelations: `SELECT * FROM prod_inst_rel WHERE a_prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  thresholdTerminalProduct: `SELECT * FROM prod_inst WHERE prod_id = ${THRESHOLD_PRODUCT_ID} AND prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  thresholdAttributes: `SELECT * FROM prod_inst_attr WHERE attr_id IN (${THRESHOLD_ATTR_IDS.join(',')}) AND prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
};

function valuesOf(rows, key) { return [...new Set(rows.map((row) => row?.[key]).filter((value) => value !== null && value !== undefined && value !== ''))]; }
function utc8Iso(date = new Date()) { return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00'); }
function sourceMeta(database) { return { source: 'udal', database, readAt: utc8Iso() }; }

class QueryContext {
  constructor(db, signal) { this.db = db; this.signal = signal; this.count = 0; this.truncated = false; this.steps = []; }
  async step(name, database, sql, values) {
    if (this.signal?.aborted) throw Object.assign(new Error('查询已取消'), { code: 'QUERY_CANCELLED' });
    try {
      const rows = repairBusinessText(await this.db.query('udal', database, sql, values, { signal: this.signal, timeout: 15000 }));
      const kept = rows.slice(0, Math.max(0, TOTAL_LIMIT - this.count));
      this.count += kept.length;
      if (rows.length >= STEP_LIMIT || kept.length < rows.length) this.truncated = true;
      this.steps.push({ name, status: kept.length ? 'ok' : 'empty', count: kept.length, ...sourceMeta(database) });
      return kept;
    } catch (error) {
      if (error.code === 'QUERY_CANCELLED') throw error;
      if (/尚未连接/.test(String(error.message || ''))) throw error;
      this.steps.push({ name, status: 'error', count: 0, message: error.message, ...sourceMeta(database) });
      return [];
    }
  }
  async each(name, database, sql, ids) {
    const rows = [];
    for (const id of ids) {
      if (this.count >= TOTAL_LIMIT) { this.truncated = true; break; }
      rows.push(...await this.step(`${name}:${id}`, database, sql, [id]));
    }
    return rows;
  }
}

async function queryPhone(db, phone, { signal } = {}) {
  const input = String(phone || '').trim();
  if (!input) throw new Error('手机号或接入号码不能为空');
  const ctx = new QueryContext(db, signal);
  const productInstances = await ctx.step('号码产品实例', CRM, SQL.productsByPhone, [input]);
  const productIds = valuesOf(productInstances, 'PROD_ID');
  const instanceIds = valuesOf(productInstances, 'prod_inst_id');
  const [productDefinitions, accountRelations, offerRelations] = await Promise.all([
    ctx.each('产品定义', CRM, SQL.product, productIds),
    ctx.each('产品账户关系', CRM, SQL.accountRel, instanceIds),
    ctx.each('产品销售品关系', CRM, SQL.offerRel, instanceIds),
  ]);
  const accounts = await ctx.each('账户', CRM, SQL.account, valuesOf(accountRelations, 'ACCT_ID'));
  const offerInstances = await ctx.each('销售品实例', CRM, SQL.offerInst, valuesOf(offerRelations, 'OFFER_INST_ID'));
  const offers = await ctx.each('销售品定义', CONFIG, SQL.offer, valuesOf(offerInstances, 'offer_id'));
  const pricingPlans = await ctx.each('定价计划', CONFIG, SQL.pricingPlan, valuesOf(offers, 'pricing_plan_id'));
  const hasErrors = ctx.steps.some((step) => step.status === 'error');
  const missingRelations = productInstances.length > 0 && (
    (productIds.length > 0 && !productDefinitions.length) || !accountRelations.length || !offerRelations.length ||
    (offerRelations.length > 0 && !offerInstances.length) || (offerInstances.length > 0 && !offers.length) ||
    (valuesOf(offers, 'pricing_plan_id').length > 0 && !pricingPlans.length)
  );
  return {
    phone: input,
    status: !productInstances.length ? (hasErrors ? 'failed' : 'empty') : (hasErrors || missingRelations || ctx.truncated ? 'partial' : 'complete'),
    queriedAt: utc8Iso(), truncated: ctx.truncated, totalRows: ctx.count, steps: ctx.steps,
    data: { productInstances, productDefinitions, accountRelations, accounts, offerRelations, offerInstances, offers, pricingPlans },
  };
}

async function queryCustomerProducts(db, customerId, options = {}) {
  const id = String(customerId ?? '').trim(); if (!id) throw new Error('客户 ID 不能为空');
  const ctx = new QueryContext(db, options.signal); const rows = await ctx.step('同客户其他产品', CRM, SQL.customerProducts, [id]);
  return { customerId: id, queriedAt: utc8Iso(), truncated: ctx.truncated, rows, steps: ctx.steps };
}

async function queryAccountCandidates(db, { productInstanceId, customerId }, options = {}) {
  const productId = String(productInstanceId ?? '').trim(); const custId = String(customerId ?? '').trim();
  if (!productId && !custId) throw new Error('产品实例 ID 或客户 ID 至少填写一个');
  const ctx = new QueryContext(db, options.signal); const rows = [];
  if (productId) rows.push(...await ctx.step('按产品实例查账户候选', CRM, SQL.accountByProduct, [productId]));
  if (custId) rows.push(...await ctx.step('按客户查账户候选', CRM, SQL.accountByCustomer, [custId]));
  const unique = [...new Map(rows.map((row) => [String(row.acct_id), row])).values()];
  return { productInstanceId: productId || null, customerId: custId || null, candidate: true, queriedAt: utc8Iso(), truncated: ctx.truncated, rows: unique, steps: ctx.steps };
}

async function queryThreshold(db, aProductInstanceId, { signal } = {}) {
  const input = String(aProductInstanceId ?? '').trim();
  if (!input) throw new Error('A 端产品实例 ID 不能为空');
  const ctx = new QueryContext(db, signal);
  const relationships = await ctx.step('A/Z 产品实例关系', CRM, SQL.thresholdRelations, [input]);
  const zProductInstanceIds = [...new Set(relationships.map((row) => row?.z_prod_inst_id ?? row?.Z_PROD_INST_ID).filter((value) => value !== null && value !== undefined && value !== '').map(String))];
  const terminalProducts = await ctx.each('终端产品实例', CRM, SQL.thresholdTerminalProduct, zProductInstanceIds);
  const thresholdAttributes = (await ctx.each('档位提醒配置', CRM, SQL.thresholdAttributes, valuesOf(terminalProducts, 'prod_inst_id')))
    .map((row) => ({ ...row, threshold_level: THRESHOLD_LEVELS[String(row.attr_id ?? row.ATTR_ID)] || '未知档位' }));
  const hasErrors = ctx.steps.some((step) => step.status === 'error');
  const status = hasErrors
    ? (relationships.length || terminalProducts.length || thresholdAttributes.length ? 'partial' : 'failed')
    : (!relationships.length || !terminalProducts.length ? 'empty' : (!thresholdAttributes.length || ctx.truncated ? 'partial' : 'complete'));
  return {
    aProductInstanceId: input, productId: THRESHOLD_PRODUCT_ID, thresholdLevels: THRESHOLD_LEVELS,
    status, queriedAt: utc8Iso(), truncated: ctx.truncated, totalRows: ctx.count, steps: ctx.steps,
    data: { relationships, terminalProducts, thresholdAttributes },
  };
}

module.exports = { CRM, CONFIG, STEP_LIMIT, TOTAL_LIMIT, THRESHOLD_PRODUCT_ID, THRESHOLD_LEVELS, THRESHOLD_ATTR_IDS, SQL, QueryContext, queryPhone, queryCustomerProducts, queryAccountCandidates, queryThreshold, valuesOf, utc8Iso };
