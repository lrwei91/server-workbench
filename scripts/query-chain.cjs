'use strict';

// Local CLI. Business data is SELECT-only; PostgreSQL staging stays in pg_temp.
const fs = require('node:fs');
const path = require('node:path');
const { repairBusinessText } = require('../server/encoding');
const ROOT = path.resolve(__dirname, '..');
const PG_SQL = Object.fromEntries(['init', 'archive', 'expand'].map(k => [k, fs.readFileSync(path.join(__dirname, 'sql-chain', `pg-${k}.sql`), 'utf8')]));
const PG_ENTRY = {
  number: ['prod_inst', 'acc_nbr'], product: ['prod_inst', 'prod_inst_id'], product_spec: ['prod_inst', 'product_id'],
  customer: ['prod_inst', 'owner_cust_id'], account: ['prod_inst_acct', 'account_id'],
  offer_instance: ['prod_offer_inst', 'prod_offer_inst_id'],
  product_attr: ['prod_inst_attr', 'prod_inst_attr_id'], product_relation: ['prod_inst_rel', 'prod_inst_rel_id'],
  offer_attr: ['prod_offer_inst_attr', 'prod_offer_inst_attr_id'], offer_relation: ['prod_offer_inst_rel', 'prod_offer_inst_rel_id'],
  bridge: ['offer_prod_inst_rel', 'offer_prod_inst_rel_id'],
};
const CONFIG_ENTRY = { offer: ['offer', 'offer_id'], plan: ['pricing_plan', 'pricing_plan_id'],
  combine: ['pricing_combine', 'pricing_combine_id'], strategy: ['event_pricing_strategy', 'event_pricing_strategy_id'],
  event: ['event_pricing_strategy', 'event_type_id'], object: ['pricing_object', 'pricing_object_id'] };
const HELP = `用法（在项目目录执行）：
  node scripts/query-chain.cjs --sample archive --limit 10
  node scripts/query-chain.cjs --type product --ids 38852790,48243980
  node scripts/query-chain.cjs --type plan --ids 12000812,12000815
  node scripts/query-chain.cjs --type event-family --ids 206080000

入口：${[...Object.keys(PG_ENTRY), ...Object.keys(CONFIG_ENTRY), 'event-family'].join(', ')}
--sample archive|pricing   无 ID 时抽取一批（默认 archive）
--limit 1..100             仅控制抽样入口数量，默认 10；关联结果不截断
--expand-relations        将 A/Z 对端追加为入口，再展开一次
--out 目录                新建输出目录（默认 outputs 下独立目录，已有目录保持原样）
输出：summary.md、chain.csv、result.json。读取项目 .env，不修改业务表。
`;

function parseArgs(args) {
  const opts = {}; const flags = new Set(['help', 'expand-relations']);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw new Error('参数需要以 -- 开头');
    const key = args[i].slice(2);
    if (!['type', 'ids', 'sample', 'limit', 'out', ...flags].includes(key) || Object.hasOwn(opts, key)) throw new Error(`未知或重复参数：${key}`);
    if (flags.has(key)) opts[key] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`缺少参数值：${key}`); opts[key] = args[++i]; }
  }
  if (opts.help) return { help: true };
  if (opts.type && (opts.sample || opts.limit)) throw new Error('--type 与 --sample/--limit 分开使用');
  if (!opts.type && opts.ids) throw new Error('--ids 需要配合 --type');
  const limit = Number(opts.limit ?? 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit 范围为 1..100');
  if (opts.type && ![...Object.keys(PG_ENTRY), ...Object.keys(CONFIG_ENTRY), 'event-family'].includes(opts.type)) throw new Error('未知入口类型');
  const sample = opts.type ? null : (opts.sample || 'archive');
  if (sample && !['archive', 'pricing'].includes(sample)) throw new Error('--sample 选择 archive 或 pricing');
  let ids = opts.ids ? opts.ids.split(',').map(x => x.trim()) : [];
  if (opts.type && !ids.length) throw new Error('--type 需要 --ids');
  ids = ids.map(id => {
    if (opts.type === 'number') { if (!id || id.length > 128 || /[\x00-\x1f\x7f]/.test(id)) throw new Error('号码格式不正确'); return id; }
    if (!/^-?\d+$/.test(id) || BigInt(id) < -9223372036854775808n || BigInt(id) > 9223372036854775807n) throw new Error('ID 需为 64 位整数');
    if (opts.type === 'event-family' && !/^\d{9}$/.test(id)) throw new Error('事件类型族需填 9 位事件 ID');
    return BigInt(id).toString();
  });
  return { type: opts.type, ids: [...new Set(ids)], sample, limit, expand: !!opts['expand-relations'], out: opts.out };
}
const values = (rows, key) => [...new Set(rows.map(r => r[key]).filter(v => v !== null && v !== undefined).map(String))];
const unique = rows => [...new Map(rows.map(r => [JSON.stringify(r), r])).values()];
const index = (rows, key) => new Map(rows.map(r => [String(r[key]), r]));

function configRows(data, seedPlans) {
  const plans = index(data.plans, 'pricing_plan_id'), strategies = index(data.strategies, 'event_pricing_strategy_id'), objects = index(data.objects, 'pricing_object_id');
  const targets = data.offers.map(o => ({ o, planId: o.pricing_plan_id }));
  for (const id of seedPlans) if (!targets.some(t => String(t.planId) === id)) targets.push({ o: {}, planId: id });
  const rows = [];
  for (const { o, planId } of targets) {
    const p = plans.get(String(planId));
    const combinations = data.combines.filter(c => String(c.pricing_plan_id) === String(planId));
    for (const c of combinations.length ? combinations : [{}]) {
      const e = strategies.get(String(c.event_pricing_strategy_id));
      const status = !p ? '计划定义缺失' : c.pricing_combine_id == null ? '定价组合缺失' : !e ? '事件策略缺失'
        : c.pricing_object_id != null && !objects.has(String(c.pricing_object_id)) ? '对象引用未匹配' : '已关联';
      rows.push({ row_key: [o.offer_id, planId, c.pricing_combine_id].map(v => v ?? 'none').join(':'),
        offer_id: o.offer_id ?? null, plan_id: planId ?? null, combine_id: c.pricing_combine_id ?? null,
        strategy_id: c.event_pricing_strategy_id ?? null, event_type_id: e?.event_type_id ?? null, object_id: c.pricing_object_id ?? null,
        offer_name: repairBusinessText([o])[0].offer_name ?? '', plan_name: p ? repairBusinessText([p])[0].pricing_plan_name : '', config_status: status });
    }
  }
  return [...new Map(rows.map(r => [r.row_key, r])).values()];
}

async function runChain(db, options, report = { data: {}, steps: [] }) {
  const data = report.data;
  async function query(source, name, sql, params = []) {
    const step = { name, source, status: 'running' }; report.steps.push(step); const start = Date.now();
    try { const rows = await db.query(source, sql, params); step.rows = rows.length; step.status = 'ok'; return rows; }
    catch (e) { step.status = 'error'; step.code = e.code || 'QUERY_ERROR'; throw e; }
    finally { step.elapsedMs = Date.now() - start; }
  }
  async function by(source, table, key, ids) {
    const out = []; ids = [...new Set(ids.map(String))];
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const placeholders = batch.map((_, n) => source === 'pg' ? `$${n + 1}` : '?').join(',');
      out.push(...await query(source, `${table}.${key}`, `SELECT * FROM ${source === 'pg' ? 'bill_inmemory.' : ''}${table} WHERE ${key} IN (${placeholders})`, batch));
    }
    return unique(out);
  }
  await query('pg', '初始化会话临时表', PG_SQL.init);
  let seedPlans = [], seedOffers = [], seeds = [];
  if (options.sample === 'archive') {
    data.entry = await query('pg', '抽取有订购的产品', `SELECT p.prod_inst_id FROM bill_inmemory.prod_inst p
JOIN bill_inmemory.offer_prod_inst_rel r ON r.prod_inst_id=p.prod_inst_id
JOIN bill_inmemory.prod_offer_inst o ON o.prod_offer_inst_id=r.prod_offer_inst_id
GROUP BY p.prod_inst_id ORDER BY p.prod_inst_id LIMIT $1`, [options.limit]);
    seeds = values(data.entry, 'prod_inst_id').map(id => ['product', id]);
  } else if (options.sample === 'pricing') {
    data.entry = await query('config', '抽取定价计划', `SELECT * FROM pricing_plan WHERE pricing_plan_id>0 ORDER BY pricing_plan_id LIMIT ${options.limit}`);
    seedPlans = values(data.entry, 'pricing_plan_id');
  } else if (PG_ENTRY[options.type]) {
    const [table, key] = PG_ENTRY[options.type]; data.entry = await by('pg', table, key, options.ids);
    report.unmatchedInputs = options.ids.filter(id => !values(data.entry, key).includes(id));
    seeds = options.ids.map(id => [options.type, id]);
  } else {
    const [table, key] = CONFIG_ENTRY[options.type] || ['event_pricing_strategy', 'event_type_id'];
    if (options.type === 'event-family') {
      data.entry = [];
      for (const id of options.ids) { const start = BigInt(id) / 1000n * 1000n;
        data.entry.push(...await query('config', '事件类型族', 'SELECT * FROM event_pricing_strategy WHERE event_type_id>=? AND event_type_id<?', [String(start), String(start + 1000n)])); }
      data.entry = unique(data.entry);
      report.unmatchedInputs = options.ids.filter(id => !data.entry.some(r => BigInt(r.event_type_id) / 1000n === BigInt(id) / 1000n));
    } else {
      data.entry = await by('config', table, key, options.ids);
      report.unmatchedInputs = options.ids.filter(id => !values(data.entry, key).includes(id));
    }
    if (options.type === 'offer') seedOffers = options.ids;
    else if (options.type === 'plan') seedPlans = options.ids;
    else if (['strategy', 'event', 'event-family'].includes(options.type)) {
      data.entryCombines = await by('config', 'pricing_combine', 'event_pricing_strategy_id', values(data.entry, 'event_pricing_strategy_id'));
      seedPlans = values(data.entryCombines, 'pricing_plan_id');
    } else seedPlans = values(data.entry, 'pricing_plan_id');
  }
  data.offers = unique([...(await by('config', 'offer', 'pricing_plan_id', seedPlans)), ...(await by('config', 'offer', 'offer_id', seedOffers))]);
  seeds.push(...[...new Set([...values(data.offers, 'offer_id'), ...seedOffers])].map(id => ['offer', id]));
  for (const pair of seeds) await query('pg', '保存批次入口', 'INSERT INTO pg_temp.swq_input VALUES ($1,$2) ON CONFLICT DO NOTHING', pair);
  data.paths = await query('pg', '展开直接订购档案', PG_SQL.archive);
  if (options.expand) { await query('pg', '追加一跳A/Z端点', PG_SQL.expand); data.paths = await query('pg', '重新展开档案', PG_SQL.archive); }
  for (const [name, sql] of Object.entries({
    products: 'SELECT * FROM pg_temp.swq_products', offerInstances: 'SELECT * FROM pg_temp.swq_offers', bridges: 'SELECT * FROM pg_temp.swq_bridge',
    productRelations: 'SELECT * FROM pg_temp.swq_p_rel', offerRelations: 'SELECT * FROM pg_temp.swq_o_rel',
    productAttributes: 'SELECT a.* FROM bill_inmemory.prod_inst_attr a JOIN pg_temp.swq_pids k ON k.id=a.prod_inst_id',
    offerAttributes: 'SELECT a.* FROM bill_inmemory.prod_offer_inst_attr a JOIN pg_temp.swq_oids k ON k.id=a.prod_offer_inst_id',
    accountRelations: 'SELECT a.* FROM bill_inmemory.prod_inst_acct a JOIN pg_temp.swq_pids k ON k.id=a.prod_inst_id',
    accounts: 'SELECT a.* FROM bill_inmemory.account a WHERE EXISTS(SELECT 1 FROM bill_inmemory.prod_inst_acct r JOIN pg_temp.swq_pids k ON k.id=r.prod_inst_id WHERE r.account_id=a.account_id)',
  })) data[name] = await query('pg', name, sql);
  data.offers = unique([...data.offers, ...await by('config', 'offer', 'offer_id', values(data.paths, 'offer_id'))]);
  const planIds = [...new Set([...seedPlans, ...values(data.offers, 'pricing_plan_id')])];
  data.plans = await by('config', 'pricing_plan', 'pricing_plan_id', planIds);
  data.combines = await by('config', 'pricing_combine', 'pricing_plan_id', planIds);
  data.strategies = await by('config', 'event_pricing_strategy', 'event_pricing_strategy_id', values(data.combines, 'event_pricing_strategy_id'));
  data.objects = unique([...await by('config', 'pricing_object', 'pricing_plan_id', planIds),
    ...await by('config', 'pricing_object', 'pricing_object_id', values(data.combines, 'pricing_object_id'))]);
  data.definitions = await by('crm', 'product', 'prod_id', [...values(data.products, 'product_id'), ...(options.type === 'product_spec' ? options.ids : [])]);
  if (options.type === 'product_spec') report.unmatchedInputs = options.ids.filter(id =>
    !values(data.products, 'product_id').includes(id) && !values(data.definitions, 'prod_id').includes(id));
  data.configuration = configRows(data, seedPlans);
  for (const row of data.configuration) await query('pg', '暂存配置关联', 'INSERT INTO pg_temp.swq_cfg VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING', Object.values(row));
  for (const row of data.definitions) await query('pg', '暂存产品定义', 'INSERT INTO pg_temp.swq_definition VALUES ($1,$2) ON CONFLICT DO NOTHING', [row.prod_id, repairBusinessText([row])[0].prod_name]);
  report.chain = await query('pg', '合并链路与断点', `SELECT p.prod_inst_id,COALESCE(p.product_id,d.product_id) AS product_id,
p.acc_nbr,p.product_his_id,p.offer_prod_inst_rel_id,p.bridge_his_id,p.prod_offer_inst_id,p.offer_his_id,p.offer_id,p.archive_status,
d.product_name,c.offer_name,c.plan_id,c.plan_name,c.combine_id,
c.strategy_id,c.event_type_id,c.object_id,c.config_status,
CASE WHEN p.prod_inst_id IS NULL AND d.product_id IS NOT NULL THEN '未找到PG产品实例'
 WHEN p.prod_inst_id IS NULL AND p.prod_offer_inst_id IS NULL THEN '未找到PG订购档案'
 WHEN p.archive_status<>'档案主链已连接' THEN p.archive_status
 WHEN c.row_key IS NULL THEN '销售品配置缺失'
 WHEN c.config_status<>'已关联' THEN c.config_status ELSE '已连接' END AS chain_status,
c.offer_id AS config_offer_id
FROM pg_temp.swq_path p FULL JOIN pg_temp.swq_cfg c ON c.offer_id=p.offer_id
FULL JOIN pg_temp.swq_definition d ON d.product_id=p.product_id
ORDER BY p.prod_inst_id,p.prod_offer_inst_id,c.combine_id`);
  report.status = report.chain.length ? 'queried' : 'empty';
  report.warnings = !report.chain.length && data.entry.length ? ['入口记录存在，但直接关联实例/配置未返回；请检查 result.json 的 entry 和 paths。'] : [];
  report.counts = { products: values(data.products, 'prod_inst_id').length, offers: values(data.offers, 'offer_id').length,
    plans: values(data.plans, 'pricing_plan_id').length, paths: data.paths.length, chainRows: report.chain.length };
  return report;
}

async function connect(config, drivers = {}) {
  const pgLib = drivers.pg || require('pg'), mysql = drivers.mysql || require('mysql2/promise');
  const p = config.database.pg, m = config.database.udal; const clients = {};
  const close = async () => { await Promise.allSettled(Object.values(clients).map(c => c.end())); };
  try {
    clients.pg = new pgLib.Client({ host: p.host, port: p.port, user: p.username, password: p.password, database: p.database,
      connectionTimeoutMillis: 15000, statement_timeout: 30000,
      types: { getTypeParser: (oid, format) => [1082, 1114, 1184].includes(oid) ? value => value : pgLib.types.getTypeParser(oid, format) } });
    await clients.pg.connect();
    for (const [key, database] of [['config', 'CONFIGDB_CNOS_JF_TEST'], ['crm', 'CRM3DB']]) clients[key] = await mysql.createConnection({
      host: m.host, port: m.port, user: m.username, password: m.password, database, charset: 'utf8mb4',
      supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, connectTimeout: 15000, multipleStatements: false,
    });
  } catch (e) { await close(); throw e; }
  return { close, async query(source, sql, values = []) {
    if (source !== 'pg') {
      if (!/^SELECT\s/i.test(sql)) throw new Error('配置库仅执行固定 SELECT');
      const [rows] = await clients[source].query({ sql, values, timeout: 30000 }); return rows;
    }
    const result = await clients.pg.query(sql, values); return (Array.isArray(result) ? result.at(-1) : result).rows;
  } };
}

function csv(rows) {
  const columns = [...new Set(rows.flatMap(Object.keys))];
  const cell = value => { let s = value == null ? '' : String(value);
    // CSV quoting alone does not stop formulas or Excel's numeric conversion.
    if (/^[\s]*[=+\-@]/.test(s) || /^\d{16,}$/.test(s) || /^0\d+/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"'; };
  return '\ufeff' + [columns.map(cell).join(','), ...rows.map(r => columns.map(k => cell(r[k])).join(','))].join('\r\n') + '\r\n';
}
function writeReport(dir, report) {
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, 'chain.csv'), csv(report.chain || []));
  const statuses = {};
  for (const r of report.chain || []) statuses[r.chain_status] = (statuses[r.chain_status] || 0) + 1;
  const summary = `# 查数结果\n\n时间：${report.at}\n\n执行状态：${report.status}\n\n` +
    `入口：${report.options.type || 'sample:' + report.options.sample}\n\n` +
    `计数：${JSON.stringify(report.counts || {})}\n\n断点统计：${JSON.stringify(statuses)}\n\n` +
    `未匹配入口：${JSON.stringify(report.unmatchedInputs || [])}\n\n提示：${JSON.stringify(report.warnings || [])}\n\n` +
    (report.errorCode ? `错误：${report.errorCode}；查看 result.json 中最后一个失败步骤。\n\n` : '') +
    'chain.csv 为可阅读链路，result.json 保存完整原表结果、输入和查询步骤。CSV 长数字/前导零加单引号保护，原值以 JSON 为准。\n\n' +
    '结果保留现存履历，行数不是用户数；不自动判断生效时点或默认账户。A/Z 默认仅列一跳关系。业务表只读，临时表随连接关闭清理。三个数据源不共享事务快照。\n\n' +
    '当前环境未覆盖 prod_offer_member_inst、payment_plan。导出含业务数据，请仅保存在本机合适位置。\n';
  fs.writeFileSync(path.join(dir, 'summary.md'), summary);
}
function createOutputDirectory(output) {
  if (output) { const dir = path.resolve(output); fs.mkdirSync(path.dirname(dir), { recursive: true }); fs.mkdirSync(dir); return dir; }
  const base = path.join(ROOT, 'outputs', 'query-chain'); fs.mkdirSync(base, { recursive: true }); return fs.mkdtempSync(path.join(base, 'run-'));
}
async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args); if (options.help) { console.log(HELP); return; }
  const dir = createOutputDirectory(options.out);
  const report = { at: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + ' +08:00', options, status: 'running', data: {}, steps: [] };
  let db;
  try { db = await connect(require('../server/config-loader')); await runChain(db, options, report); }
  catch (e) { report.status = 'failed'; report.errorCode = e.code || 'QUERY_ERROR'; process.exitCode = 1; }
  finally { if (db) await db.close(); writeReport(dir, report); }
  console.log(`状态：${report.status}；结果：${path.join(dir, 'summary.md')}`);
  if (report.counts) console.log(JSON.stringify(report.counts));
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { parseArgs, configRows, runChain, connect, csv, writeReport, createOutputDirectory, main };
