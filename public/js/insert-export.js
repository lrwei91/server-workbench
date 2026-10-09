const TABLES = Object.freeze([
  { dataKey: 'productInstances', database: 'CRM3DB', table: 'prod_inst' },
  { dataKey: 'accessProductInstances', database: 'CRM3DB', table: 'prod_inst' },
  { dataKey: 'relatedProductInstances', database: 'CRM3DB', table: 'prod_inst' },
  { dataKey: 'productDefinitions', database: 'CRM3DB', table: 'product' },
  { dataKey: 'productRelationships', database: 'CRM3DB', table: 'prod_inst_rel' },
  { dataKey: 'productAttributes', database: 'CRM3DB', table: 'prod_inst_attr' },
  { dataKey: 'productStates', database: 'CRM3DB', table: 'prod_inst_state' },
  { dataKey: 'productExtensions', database: 'CRM3DB', table: 'prod_inst_ext' },
  { dataKey: 'productContacts', database: 'CRM3DB', table: 'prod_inst_contact' },
  { dataKey: 'productPaymodes', database: 'CRM3DB', table: 'prod_inst_paymode' },
  { dataKey: 'productAccessNumbers', database: 'CRM3DB', table: 'prod_inst_acc_num' },
  { dataKey: 'productNumberRelations', database: 'CRM3DB', table: 'prod_inst_acc_nbr_rela' },
  { dataKey: 'productParties', database: 'CRM3DB', table: 'prod_inst_party' },
  { dataKey: 'productResourceRelations', database: 'CRM3DB', table: 'prod_res_inst_rel' },
  { dataKey: 'accountRelations', database: 'CRM3DB', table: 'prod_inst_acct_rel' },
  { dataKey: 'accounts', database: 'CRM3DB', table: 'account' },
  { dataKey: 'offerRelations', database: 'CRM3DB', table: 'offer_prod_inst_rel' },
  { dataKey: 'offerInstances', database: 'CRM3DB', table: 'offer_inst' },
  { dataKey: 'offerInstanceRelationships', database: 'CRM3DB', table: 'offer_inst_rel' },
  { dataKey: 'relatedOfferInstances', database: 'CRM3DB', table: 'offer_inst' },
  { dataKey: 'offerInstanceAttributes', database: 'CRM3DB', table: 'offer_inst_attr' },
  { dataKey: 'offerInstanceFees', database: 'CRM3DB', table: 'offer_inst_fee_info' },
  { dataKey: 'offerInstanceFeeAttributes', database: 'CRM3DB', table: 'offer_inst_fee_attr' },
  { dataKey: 'offerObjectInstanceRelations', database: 'CRM3DB', table: 'offer_obj_inst_rel' },
  { dataKey: 'offerResourceInstanceRelations', database: 'CRM3DB', table: 'offer_res_inst_rel' },
  { dataKey: 'offerInstanceAssurances', database: 'CRM3DB', table: 'offer_inst_assure' },
  { dataKey: 'offerCouponInstanceRelations', database: 'CRM3DB', table: 'offer_coupon_inst_rel' },
  { dataKey: 'skuInstances', database: 'CRM3DB', table: 'sku_inst' },
  { dataKey: 'valueAddedOrderRelations', database: 'CRM3DB', table: 'va_order_rel' },
  { dataKey: 'offers', database: 'CONFIGDB_CNOS_JF_TEST', table: 'offer' },
  { dataKey: 'pricingPlans', database: 'CONFIGDB_CNOS_JF_TEST', table: 'pricing_plan' },
  { dataKey: 'relationships', database: 'CRM3DB', table: 'prod_inst_rel' },
  { dataKey: 'terminalProducts', database: 'CRM3DB', table: 'prod_inst' },
  { dataKey: 'thresholdAttributes', database: 'CRM3DB', table: 'prod_inst_attr' },
]);
const POSTGRES_TABLE_MAP = Object.freeze({
  prod_inst_acct_rel: 'prod_inst_acct',
  offer_inst: 'prod_offer_inst',
  offer_inst_attr: 'prod_offer_inst_attr',
  offer_inst_rel: 'prod_offer_inst_rel',
  offer: 'offer_ces',
});
const POSTGRES_COLUMN_MAP = Object.freeze({
  prod_inst: { acc_num: 'acc_nbr' },
  prod_inst_rel: { a_prod_inst_id: 'prod_inst_a_id', z_prod_inst_id: 'prod_inst_z_id' },
  prod_inst_acct_rel: { prod_inst_acct_rel_id: 'prod_inst_acct_id', acct_id: 'account_id' },
  account: { acct_id: 'account_id' },
  offer_inst: { offer_inst_id: 'prod_offer_inst_id', offer_id: 'prod_offer_id' },
  offer_inst_attr: { offer_inst_attr_id: 'prod_offer_inst_attr_id', offer_inst_id: 'prod_offer_inst_id' },
  offer_inst_rel: { offer_inst_id: 'prod_offer_inst_id', offer_inst_rel_id: 'prod_offer_inst_rel_id', a_offer_inst_id: 'rela_prod_offer_inst_id', z_offer_inst_id: 'related_prod_offer_inst_id' },
  offer_prod_inst_rel: { offer_inst_id: 'prod_offer_inst_id' },
});

function mapTargetRow(row, table, target) {
  if (target !== 'postgres') return row;
  const columns = POSTGRES_COLUMN_MAP[table] || {};
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [columns[key.toLowerCase()] || key, value]));
}

function quoteIdentifier(value, target) {
  return target === 'postgres' ? `"${String(value).replace(/"/g, '""')}"` : `\`${String(value).replace(/`/g, '``')}\``;
}

export function sqlLiteral(value, target = 'postgres') {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL';
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return target === 'postgres' ? (value ? 'TRUE' : 'FALSE') : (value ? '1' : '0');
  const source = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (target === 'postgres') {
    const escaped = source.replace(/'/g, "''");
    return /[\\\0\n\r\x1a]/.test(source)
      ? `E'${escaped.replace(/\\/g, '\\\\').replace(/\0/g, '\\000').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\x1a/g, '\\032')}'`
      : `'${escaped}'`;
  }
  const escaped = source.replace(/\\/g, '\\\\').replace(/\0/g, '\\0').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\x1a/g, '\\Z').replace(/'/g, "''");
  return `'${escaped}'`;
}

function exportColumns(rows) {
  const columns = [];
  const seen = new Set();
  for (const row of rows) {
    for (const column of Object.keys(row || {})) {
      if (/__RAW$/i.test(column) || column === 'threshold_level' || seen.has(column)) continue;
      seen.add(column); columns.push(column);
    }
  }
  return columns;
}

function sourceValue(row, column) {
  const rawKey = Object.keys(row || {}).find((key) => key.toLowerCase() === `${column}__raw`.toLowerCase());
  return rawKey ? row[rawKey] : row?.[column];
}

function rowIdentity(row) {
  return JSON.stringify(Object.keys(row || {}).sort().map((key) => [key, row[key]]));
}

export function hasInsertRows(result) {
  if (result?.source !== 'voyage') return false;
  return TABLES.some(({ dataKey }) => Array.isArray(result.data?.[dataKey]) && result.data[dataKey].length > 0);
}

function utc8Iso(date = new Date()) { return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00'); }

export function generateInsertScript(result, { generatedAt = utc8Iso(), target = 'postgres' } = {}) {
  if (result?.source !== 'voyage') throw new Error('仅工程环境 Voyage 查询结果支持生成 INSERT');
  if (!['postgres', 'mysql'].includes(target)) throw new Error('不支持的 INSERT 目标类型');
  const identifier = result.productInstanceId ? `产品实例 ${result.productInstanceId}` : result.aProductInstanceId ? `A 端产品实例 ${result.aProductInstanceId}` : `号码 ${result.phone || '—'}`;
  const lines = [
    '-- Server Workbench 工程环境数据同步脚本',
    '-- 来源：工程环境 Voyage 在线数据库',
    target === 'postgres' ? '-- 目标：PostgreSQL 数据库 bill_cnos_jftest，Schema bill_inmemory（执行前请再次核对连接环境）' : '-- 目标：测试环境 MySQL / UDAL（执行前请再次核对连接环境）',
    `-- 查询：${identifier}`,
    `-- 生成时间：${generatedAt}`,
    target === 'postgres' ? '-- 说明：脚本仅包含当前查询已返回的数据；执行前请核对 bill_inmemory 中各目标表和字段。' : '-- 说明：脚本仅包含当前查询已返回的数据；不同逻辑库需在对应连接中分别执行。',
  ];
  if (result.archiveCoverage) lines.push(`-- 查询范围：根实例及一跳直接产品关系、根销售品的一跳关系（关联节点不展开兄弟实例）；保留工程库现存的全部 his_id 版本；最多 ${result.archiveCoverage.limits.nodesPerKind} 个产品与销售品 ID、${result.archiveCoverage.limits.rounds} 轮、${result.archiveCoverage.limits.readRows} 行读取。`);
  if (result.status === 'partial' || result.truncated) lines.push('-- 警告：本次查询部分完成，请先核对失败步骤、关联引用缺失和查询上限；本脚本不代表完整档案。');
  if (target === 'postgres') lines.push('', 'BEGIN;');
  let totalRows = 0;
  const grouped = new Map();
  for (const { dataKey, database, table } of TABLES) {
    const rows = Array.isArray(result.data?.[dataKey]) ? result.data[dataKey].filter((row) => row && typeof row === 'object') : [];
    if (!rows.length) continue;
    const key = `${database}\u0000${table}`;
    if (!grouped.has(key)) grouped.set(key, { database, table, rows: [] });
    grouped.get(key).rows.push(...rows);
  }
  for (const { database, table, rows: sourceRows } of grouped.values()) {
    const seen = new Set();
    const rows = sourceRows.map((row) => mapTargetRow(row, table, target)).filter((row) => { const key = rowIdentity(row); if (seen.has(key)) return false; seen.add(key); return true; });
    const columns = exportColumns(rows);
    if (!columns.length) continue;
    totalRows += rows.length;
    const physicalTable = target === 'postgres' ? (POSTGRES_TABLE_MAP[table] || table) : table;
    lines.push('', `-- ${target === 'postgres' ? '来源逻辑库' : '目标逻辑库'}：${database} | 表：${physicalTable} | ${rows.length} 行`);
    const targetTable = target === 'postgres' ? `${quoteIdentifier('bill_inmemory', target)}.${quoteIdentifier(physicalTable, target)}` : quoteIdentifier(table, target);
    lines.push(`INSERT INTO ${targetTable} (${columns.map((column) => quoteIdentifier(column, target)).join(', ')}) VALUES`);
    rows.forEach((row, index) => {
      const suffix = index === rows.length - 1 ? ';' : ',';
      lines.push(`  (${columns.map((column) => sqlLiteral(sourceValue(row, column), target)).join(', ')})${suffix}`);
    });
  }
  if (!totalRows) lines.push('', '-- 当前查询结果没有可导出的数据行。');
  if (target === 'postgres') lines.push('', 'COMMIT;');
  lines.push('', `-- 合计：${totalRows} 行`);
  return lines.join('\n');
}

export { TABLES as INSERT_TABLES };
