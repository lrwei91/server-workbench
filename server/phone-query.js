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
  thresholdRelations: `SELECT * FROM prod_inst_rel WHERE a_prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  thresholdTerminalProduct: `SELECT * FROM prod_inst WHERE prod_id = ${THRESHOLD_PRODUCT_ID} AND prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
  thresholdAttributes: `SELECT * FROM prod_inst_attr WHERE attr_id IN (${THRESHOLD_ATTR_IDS.join(',')}) AND prod_inst_id = ? LIMIT ${STEP_LIMIT}`,
};

function rowValue(row, key) {
  if (!row || typeof row !== 'object') return undefined;
  if (Object.hasOwn(row, key)) return row[key];
  const wanted = String(key).toLowerCase();
  const actual = Object.keys(row).find((candidate) => candidate.toLowerCase() === wanted);
  return actual === undefined ? undefined : row[actual];
}
function valuesOf(rows, key) { return [...new Set(rows.map((row) => rowValue(row, key)).filter((value) => value !== null && value !== undefined && value !== ''))]; }
function utc8Iso(date = new Date()) { return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00'); }
function sourceMeta(source, database) { return { source, database, readAt: utc8Iso() }; }

class QueryContext {
  constructor(db, signal, source = 'udal') { this.db = db; this.signal = signal; this.source = source; this.count = 0; this.truncated = false; this.steps = []; }
  async step(name, database, sql, values) {
    if (this.signal?.aborted) throw Object.assign(new Error('查询已取消'), { code: 'QUERY_CANCELLED' });
    try {
      const rows = repairBusinessText(await this.db.query(this.source, database, sql, values, { signal: this.signal, timeout: 15000 }));
      const kept = rows.slice(0, Math.max(0, TOTAL_LIMIT - this.count));
      this.count += kept.length;
      if (rows.length >= STEP_LIMIT || kept.length < rows.length) this.truncated = true;
      this.steps.push({ name, status: kept.length ? 'ok' : 'empty', count: kept.length, ...sourceMeta(this.source, database) });
      return kept;
    } catch (error) {
      if (error.code === 'QUERY_CANCELLED') throw error;
      if (/尚未连接/.test(String(error.message || ''))) throw error;
      this.steps.push({ name, status: 'error', count: 0, message: error.message, ...sourceMeta(this.source, database) });
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

async function aggregateProductArchive(ctx, productInstances) {
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
    status: !productInstances.length ? (hasErrors ? 'failed' : 'empty') : (hasErrors || missingRelations || ctx.truncated ? 'partial' : 'complete'),
    queriedAt: utc8Iso(), truncated: ctx.truncated, totalRows: ctx.count, steps: ctx.steps,
    data: { productInstances, productDefinitions, accountRelations, accounts, offerRelations, offerInstances, offers, pricingPlans },
  };
}

async function queryPhone(db, phone, { signal, source = 'udal' } = {}) {
  const input = String(phone || '').trim();
  if (!input) throw new Error('手机号或接入号码不能为空');
  const ctx = new QueryContext(db, signal, source);
  const productInstances = await ctx.step('号码产品实例', CRM, SQL.productsByPhone, [input]);
  return { phone: input, source, ...await aggregateProductArchive(ctx, productInstances) };
}

async function queryProductInstance(db, productInstanceId, { signal, source = 'udal' } = {}) {
  const input = String(productInstanceId ?? '').trim();
  if (!input) throw new Error('产品实例 ID 不能为空');
  if (!/^\d+$/.test(input)) throw new Error('产品实例 ID 必须是数字');
  const ctx = new QueryContext(db, signal, source);
  const productInstances = await ctx.step('产品实例档案', CRM, SQL.productsByInstance, [input]);
  return { productInstanceId: input, source, ...await aggregateProductArchive(ctx, productInstances) };
}

async function queryCustomerProducts(db, customerId, options = {}) {
  const id = String(customerId ?? '').trim(); if (!id) throw new Error('客户 ID 不能为空');
  const source = options.source || 'udal'; const ctx = new QueryContext(db, options.signal, source); const rows = await ctx.step('同客户其他产品', CRM, SQL.customerProducts, [id]);
  return { customerId: id, source, queriedAt: utc8Iso(), truncated: ctx.truncated, rows, steps: ctx.steps };
}

async function queryAccountCandidates(db, { productInstanceId, customerId }, options = {}) {
  const productId = String(productInstanceId ?? '').trim(); const custId = String(customerId ?? '').trim();
  if (!productId && !custId) throw new Error('产品实例 ID 或客户 ID 至少填写一个');
  const source = options.source || 'udal'; const ctx = new QueryContext(db, options.signal, source); const rows = [];
  if (productId) rows.push(...await ctx.step('按产品实例查账户候选', CRM, SQL.accountByProduct, [productId]));
  if (custId) rows.push(...await ctx.step('按客户查账户候选', CRM, SQL.accountByCustomer, [custId]));
  const unique = [...new Map(rows.map((row) => [String(rowValue(row, 'acct_id')), row])).values()];
  return { productInstanceId: productId || null, customerId: custId || null, source, candidate: true, queriedAt: utc8Iso(), truncated: ctx.truncated, rows: unique, steps: ctx.steps };
}

async function queryThreshold(db, aProductInstanceId, { signal, source = 'udal' } = {}) {
  const input = String(aProductInstanceId ?? '').trim();
  if (!input) throw new Error('A 端产品实例 ID 不能为空');
  const ctx = new QueryContext(db, signal, source);
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
    aProductInstanceId: input, source, productId: THRESHOLD_PRODUCT_ID, thresholdLevels: THRESHOLD_LEVELS,
    status, queriedAt: utc8Iso(), truncated: ctx.truncated, totalRows: ctx.count, steps: ctx.steps,
    data: { relationships, terminalProducts, thresholdAttributes },
  };
}

module.exports = { CRM, CONFIG, STEP_LIMIT, TOTAL_LIMIT, THRESHOLD_PRODUCT_ID, THRESHOLD_LEVELS, THRESHOLD_ATTR_IDS, SQL, QueryContext, aggregateProductArchive, queryPhone, queryProductInstance, queryCustomerProducts, queryAccountCandidates, queryThreshold, rowValue, valuesOf, utc8Iso };
