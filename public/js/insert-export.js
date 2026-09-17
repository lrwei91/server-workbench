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
  { dataKey: 'offerInstanceAttributes', database: 'CRM3DB', table: 'offer_inst_attr' },
  { dataKey: 'offerInstanceFees', database: 'CRM3DB', table: 'offer_inst_fee_info' },
  { dataKey: 'offers', database: 'CONFIGDB_CNOS_JF_TEST', table: 'offer' },
  { dataKey: 'pricingPlans', database: 'CONFIGDB_CNOS_JF_TEST', table: 'pricing_plan' },
  { dataKey: 'relationships', database: 'CRM3DB', table: 'prod_inst_rel' },
  { dataKey: 'terminalProducts', database: 'CRM3DB', table: 'prod_inst' },
  { dataKey: 'thresholdAttributes', database: 'CRM3DB', table: 'prod_inst_attr' },
]);

function quoteIdentifier(value) { return `\`${String(value).replace(/`/g, '``')}\``; }

export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL';
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? '1' : '0';
  const source = typeof value === 'object' ? JSON.stringify(value) : String(value);
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

export function generateInsertScript(result, { generatedAt = utc8Iso() } = {}) {
  if (result?.source !== 'voyage') throw new Error('仅工程环境 Voyage 查询结果支持生成 INSERT');
  const identifier = result.productInstanceId ? `产品实例 ${result.productInstanceId}` : result.aProductInstanceId ? `A 端产品实例 ${result.aProductInstanceId}` : `号码 ${result.phone || '—'}`;
  const lines = [
    '-- Server Workbench 工程环境数据同步脚本',
    '-- 来源：工程环境 Voyage 在线数据库',
    '-- 目标：测试环境（执行前请再次核对连接环境）',
    `-- 查询：${identifier}`,
    `-- 生成时间：${generatedAt}`,
    '-- 说明：脚本仅包含当前查询已返回的数据；不同逻辑库需在对应连接中分别执行。',
  ];
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
    const rows = sourceRows.filter((row) => { const key = rowIdentity(row); if (seen.has(key)) return false; seen.add(key); return true; });
    const columns = exportColumns(rows);
    if (!columns.length) continue;
    totalRows += rows.length;
    lines.push('', `-- 目标逻辑库：${database} | 表：${table} | ${rows.length} 行`);
    lines.push(`INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES`);
    rows.forEach((row, index) => {
      const suffix = index === rows.length - 1 ? ';' : ',';
      lines.push(`  (${columns.map((column) => sqlLiteral(sourceValue(row, column))).join(', ')})${suffix}`);
    });
  }
  if (!totalRows) lines.push('', '-- 当前查询结果没有可导出的数据行。');
  lines.push('', `-- 合计：${totalRows} 行`);
  return lines.join('\n');
}

export { TABLES as INSERT_TABLES };
