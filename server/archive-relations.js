'use strict';

const { QueryContext, CRM, CONFIG, STEP_LIMIT, SQL, rowValue, valuesOf, uniqueRows, utc8Iso } = require('./phone-query');

const RELATION_QUERIES = Object.freeze([
  { id: 'product-offers', name: '产品实例 → 销售品与定价', input: '产品实例 ID', chain: 'prod_inst → offer_prod_inst_rel → prod_offer_inst → MySQL offer / pricing_plan' },
  { id: 'function-offers', name: '接入产品 → 功能产品与销售品', input: '接入产品实例 ID', chain: 'prod_inst_rel（A→Z，100600）→ offer_prod_inst_rel → prod_offer_inst' },
  { id: 'group-offers', name: '成员产品 → 群主销售品', input: '成员产品实例 ID', chain: 'prod_inst_rel（Z→A）→ offer_prod_inst_rel → prod_offer_inst' },
  { id: 'offer-links-a', name: '销售品 A端 → Z端', input: 'A端销售品实例 ID', chain: 'prod_offer_inst_rel.rela_prod_offer_inst_id → related_prod_offer_inst_id' },
  { id: 'offer-links-z', name: '销售品 Z端 → A端', input: 'Z端销售品实例 ID', chain: 'prod_offer_inst_rel.related_prod_offer_inst_id → rela_prod_offer_inst_id' },
  { id: 'offer-members', name: '销售品 → 产品成员', input: '销售品实例 ID', chain: 'offer_prod_inst_rel → prod_inst；群主候选再沿prod_inst_rel（A→Z）展开一层' },
  { id: 'function-members', name: '组合功能销售品 → A端主产品', input: '功能销售品实例 ID', chain: 'offer_prod_inst_rel → 功能产品 → prod_inst_rel（Z→A）→ 主产品候选' },
  { id: 'customer-offers', name: '账户 → 客户群销售品', input: '默认电信账户 ID', chain: 'account.cust_id → prod_offer_member_inst（CLASS_ID=1）→ prod_offer_inst' },
  { id: 'account-offers', name: '账户 → 账户群销售品', input: '默认电信账户 ID', chain: 'prod_offer_member_inst（CLASS_ID=137，MEMBER_ID=账户ID）→ prod_offer_inst' },
  { id: 'bank-offers', name: '账户 → 银行群销售品', input: '默认电信账户 ID', chain: 'payment_plan → 银行ID+账号 → prod_offer_member_inst（CLASS_ID=2001）' },
  { id: 'account-products', name: '账户 → 产品实例', input: '电信账户 ID', chain: 'prod_inst_acct → prod_inst；保留账户关系类型供判断默认账户' },
  { id: 'group-members', name: '非产品群销售品 → 成员产品', input: '销售品实例 ID', chain: 'prod_offer_member_inst → 客户/账户/银行 → prod_inst_acct → prod_inst' },
  { id: 'inner-call', name: '销售品 → 对端成员关系检查', input: '销售品实例 ID', peer: true, chain: '直接产品成员、对端群主、Z端产品关联可选包；可附对端默认账户检查非产品群' },
]);

const relationSql = (table, clause) => `SELECT * FROM ${table} WHERE ${clause} LIMIT ${STEP_LIMIT}`;
function numericId(value, label, optional = false) {
  const id = String(value ?? '').trim();
  if (optional && !id) return '';
  if (!/^\d+$/.test(id)) throw Object.assign(new Error(`${label}必须是数字`), { status: 400, code: 'INVALID_INPUT' });
  return id;
}

async function queryArchiveRelations(db, input, { signal } = {}) {
  const definition = RELATION_QUERIES.find((item) => item.id === input.mode);
  if (!definition) throw Object.assign(new Error('请选择固定关系链查询场景'), { status: 400, code: 'INVALID_INPUT' });
  const id = numericId(input.id, definition.input);
  const peer = definition.peer ? numericId(input.peerProductInstanceId, '对端产品实例 ID') : '';
  const peerAccount = definition.peer ? numericId(input.peerAccountId, '对端默认账户 ID', true) : '';
  const ctx = new QueryContext(db, signal, 'pg');
  const data = {};
  const step = async (key, title, table, clause, values) => {
    const rows = await ctx.step(title, CRM, relationSql(table, clause), values);
    data[key] = uniqueRows([...(data[key] || []), ...rows]); return rows;
  };
  const each = async (key, title, table, column, ids) => {
    const keys = [...new Set(ids.map(String))];
    if (keys.length > 100) ctx.truncated = true;
    const rows = await ctx.each(title, CRM, relationSql(table, `${column} = ?`), keys.slice(0, 100));
    data[key] = uniqueRows([...(data[key] || []), ...rows]); return rows;
  };
  const offers = (ids) => each('offerInstances', '销售品实例', 'offer_inst', 'offer_inst_id', ids);
  const products = (ids) => each('productInstances', '产品实例档案', 'prod_inst', 'prod_inst_id', ids);
  const memberOffers = async (classId, column, ids) => {
    const rows = [];
    const keys = [...new Set(ids.map(String))];
    if (keys.length > 100) ctx.truncated = true;
    for (const member of keys.slice(0, 100)) rows.push(...await step('members', '非产品销售品成员关系', 'prod_offer_member_inst', `class_id = ${classId} AND ${column} = ?`, [member]));
    return offers(valuesOf(rows, 'prod_offer_inst_id'));
  };

  switch (definition.id) {
    case 'product-offers': {
      await products([id]);
      const rows = await step('offerRelations', '产品销售品关系', 'offer_prod_inst_rel', 'prod_inst_id = ?', [id]);
      await offers(valuesOf(rows, 'prod_offer_inst_id')); break;
    }
    case 'function-offers': {
      const rows = await step('productRelationships', '功能产品实例关系', 'prod_inst_rel', "prod_inst_a_id = ? AND relation_type_cd = '100600'", [id]);
      const ids = valuesOf(rows, 'prod_inst_z_id'); await products(ids);
      const relations = await each('offerRelations', '功能产品销售品关系', 'offer_prod_inst_rel', 'prod_inst_id', ids);
      const instances = await offers(valuesOf(relations, 'prod_offer_inst_id'));
      // IBS_OFFER_TYPE常见于配置定义，兼容实例含该字段的档案。
      data.functionOfferCandidates = instances.filter((row) => String(rowValue(row, 'ibs_offer_type')) === '10030'); break;
    }
    case 'group-offers': {
      const rows = await step('productRelationships', '成员反查A端产品关系', 'prod_inst_rel', 'prod_inst_z_id = ?', [id]);
      const ids = valuesOf(rows, 'prod_inst_a_id'); await products(ids);
      const relations = await each('offerRelations', '群主候选产品销售品关系', 'offer_prod_inst_rel', 'prod_inst_id', ids);
      await offers(valuesOf(relations, 'prod_offer_inst_id')); break;
    }
    case 'offer-links-a':
    case 'offer-links-z': {
      const forward = definition.id === 'offer-links-a';
      const rows = await step('offerInstanceRelationships', '销售品实例关系', 'offer_inst_rel', `${forward ? 'a_offer_inst_id' : 'z_offer_inst_id'} = ?`, [id]);
      await offers([id, ...valuesOf(rows, forward ? 'related_prod_offer_inst_id' : 'rela_prod_offer_inst_id')]); break;
    }
    case 'offer-members':
    case 'function-members': {
      const rows = await step('offerRelations', '销售品关联产品关系', 'offer_prod_inst_rel', 'offer_inst_id = ?', [id]);
      const ids = valuesOf(rows, 'prod_inst_id'); await products(ids);
      const reverse = definition.id === 'function-members';
      const relations = await each('productRelationships', reverse ? '功能产品反查A端主产品关系' : '直接成员A端产品关系（一层候选）', 'prod_inst_rel', reverse ? 'prod_inst_z_id' : 'prod_inst_a_id', ids);
      await products(valuesOf(relations, reverse ? 'prod_inst_a_id' : 'prod_inst_z_id')); break;
    }
    case 'customer-offers': {
      const rows = await step('accounts', '账户查支付客户', 'account', 'acct_id = ?', [id]);
      await memberOffers(1, 'member_id', valuesOf(rows, 'cust_id')); break;
    }
    case 'account-offers': await memberOffers(137, 'member_id', [id]); break;
    case 'bank-offers': {
      const plans = await step('paymentPlans', '支付方案银行账户', 'payment_plan', 'account_id = ?', [id]);
      const rows = [];
      for (const p of uniqueRows(plans)) {
        const bank = rowValue(p, 'payment_bank_id'); const account = rowValue(p, 'payment_account');
        if (bank == null || account == null) continue;
        rows.push(...await step('members', '银行账户销售品成员', 'prod_offer_member_inst', 'class_id = 2001 AND bank_id = ? AND bank_account = ?', [bank, account]));
      }
      await offers(valuesOf(rows, 'prod_offer_inst_id')); break;
    }
    case 'account-products': {
      const rows = await step('accountRelations', '账户关联产品关系', 'prod_inst_acct', 'account_id = ?', [id]);
      await products(valuesOf(rows, 'prod_inst_id')); break;
    }
    case 'group-members': {
      const members = await step('members', '非产品销售品成员关系', 'prod_offer_member_inst', 'prod_offer_inst_id = ?', [id]);
      const customerIds = valuesOf(members.filter((row) => String(rowValue(row, 'class_id')) === '1'), 'member_id');
      const accounts = await each('accounts', '客户关联账户', 'account', 'cust_id', customerIds);
      const accountIds = [...valuesOf(accounts, 'account_id'), ...valuesOf(members.filter((row) => String(rowValue(row, 'class_id')) === '137'), 'member_id')];
      for (const m of members.filter((row) => String(rowValue(row, 'class_id')) === '2001')) {
        const bank = rowValue(m, 'bank_id'); const account = rowValue(m, 'bank_account');
        if (bank == null || account == null) continue;
        const plans = await step('paymentPlans', '银行成员支付方案', 'payment_plan', 'payment_bank_id = ? AND payment_account = ?', [bank, account]);
        accountIds.push(...valuesOf(plans, 'account_id'));
      }
      const rows = await each('accountRelations', '账户关联产品关系', 'prod_inst_acct', 'account_id', accountIds);
      await products(valuesOf(rows, 'prod_inst_id')); break;
    }
    case 'inner-call': {
      await step('directMatches', '对端直接成员匹配', 'offer_prod_inst_rel', 'offer_inst_id = ? AND prod_inst_id = ?', [id, peer]);
      const relations = await step('productRelationships', '对端反查A端产品关系', 'prod_inst_rel', 'prod_inst_z_id = ?', [peer]);
      for (const parent of valuesOf(relations, 'prod_inst_a_id').slice(0, 100)) await step('parentMatches', '对端群主候选成员匹配', 'offer_prod_inst_rel', 'offer_inst_id = ? AND prod_inst_id = ?', [id, parent]);
      if (valuesOf(relations, 'prod_inst_a_id').length > 100) ctx.truncated = true;
      const links = await step('offerInstanceRelationships', '销售品实例关系（Z端）', 'offer_inst_rel', 'a_offer_inst_id = ?', [id]);
      const instances = await offers(valuesOf(links, 'related_prod_offer_inst_id'));
      for (const instance of instances) await step('optionalMatches', 'Z端销售品对端成员候选', 'offer_prod_inst_rel', 'offer_inst_id = ? AND prod_inst_id = ?', [rowValue(instance, 'prod_offer_inst_id'), peer]);
      if (peerAccount) {
        await step('accountMatches', '对端账户群成员匹配', 'prod_offer_member_inst', 'prod_offer_inst_id = ? AND class_id = 137 AND member_id = ?', [id, peerAccount]);
        const accounts = await step('accounts', '对端账户查支付客户', 'account', 'acct_id = ?', [peerAccount]);
        for (const cust of valuesOf(accounts, 'cust_id')) await step('customerMatches', '对端客户群成员匹配', 'prod_offer_member_inst', 'prod_offer_inst_id = ? AND class_id = 1 AND member_id = ?', [id, cust]);
        const plans = await step('paymentPlans', '对端支付方案', 'payment_plan', 'account_id = ?', [peerAccount]);
        for (const p of plans) if (rowValue(p, 'payment_bank_id') != null && rowValue(p, 'payment_account') != null) await step('bankMatches', '对端银行群成员匹配', 'prod_offer_member_inst', 'prod_offer_inst_id = ? AND class_id = 2001 AND bank_id = ? AND bank_account = ?', [id, rowValue(p, 'payment_bank_id'), rowValue(p, 'payment_account')]);
      }
      break;
    }
  }
  const instances = data.offerInstances || [];
  data.offers = await ctx.each('销售品定义', CONFIG, SQL.offer, valuesOf(instances, 'prod_offer_id'));
  data.pricingPlans = await ctx.each('定价计划', CONFIG, SQL.pricingPlan, valuesOf(data.offers, 'pricing_plan_id'));
  if (definition.id === 'function-offers') {
    const functional = new Set(valuesOf(data.offers.filter((row) => String(rowValue(row, 'ibs_offer_type')) === '10030'), 'offer_id').map(String));
    data.functionOfferCandidates = uniqueRows([...(data.functionOfferCandidates || []), ...instances.filter((row) => functional.has(String(rowValue(row, 'prod_offer_id'))))]);
  }
  // 类型来自实例或配置；只提供规则提示，不将原始候选冒充当前有效定价。
  data.typeRules = instances.map((row) => {
    const config = data.offers.find((offer) => String(rowValue(offer, 'offer_id')) === String(rowValue(row, 'prod_offer_id')));
    const type = String(rowValue(row, 'ibs_offer_type') ?? rowValue(config, 'ibs_offer_type') ?? '');
    return { prod_offer_inst_id: rowValue(row, 'prod_offer_inst_id'), ibs_offer_type: type || '待核对',
      规则提示: ['30010', '30030'].includes(type) ? '接入产品直接入口取；A→Z取价入口过滤；群内检查另按特例' : type === '30020' ? 'A→Z取价入口取；接入产品直接入口过滤' : '按销售品类型及计费流程判断' };
  });
  const hasRows = Object.entries(data).some(([key, rows]) => key !== 'typeRules' && rows.length);
  const failed = ctx.steps.some((s) => s.status === 'error');
  return { mode: definition.id, definition, id, peerProductInstanceId: peer || undefined, source: 'pg', schema: 'bill_inmemory', configSource: 'udal',
    status: failed ? (hasRows ? 'partial' : 'failed') : hasRows ? (ctx.truncated ? 'partial' : 'complete') : 'empty',
    queriedAt: utc8Iso(), truncated: ctx.truncated, totalRows: ctx.count, steps: ctx.steps, data,
    notice: '关系诊断候选，保留历史/状态/角色原值；不判断当前有效履历、默认账户或最终群内优惠。群主与功能关系需结合关系类型核对。每分支最多500行、关联ID最多100个、总读取5000行；原始档案查PG，销售品定义和定价计划查MySQL。' };
}

module.exports = { RELATION_QUERIES, queryArchiveRelations };
