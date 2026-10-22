'use strict';

const fs = require('fs/promises');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { RedisArchiveError, RedisSocket, normalizeRedisArchiveKey, utc8Iso } = require('./redis-archive');
const { decodeArchive, encodeArchive, stringifyLosslessJson, canonicalNumber } = require('./archive-codec');

const SCHEMA = 'bill_inmemory';
const TABLES = [
  { group: 'prodInsts', table: 'prod_inst', pk: 'prod_inst_id', field: 'prodInstId' },
  { group: 'prodInstAttrs', table: 'prod_inst_attr', pk: 'prod_inst_attr_id', field: 'prodInstAttrId' },
  { group: 'prodInstRels', table: 'prod_inst_rel', pk: 'prod_inst_rel_id', field: 'prodInstRelId' },
  { group: 'prodInstAcctRels', table: 'prod_inst_acct', pk: 'prod_inst_acct_id', field: 'prodInstAcctId' },
  { group: 'offerProdInstRels', table: 'offer_prod_inst_rel', pk: 'offer_prod_inst_rel_id', field: 'offerProdInstRelId' },
  { group: 'offerInsts', table: 'prod_offer_inst', pk: 'prod_offer_inst_id', field: 'prodOfferInstId' },
  { group: 'offerInstAttrs', table: 'prod_offer_inst_attr', pk: 'prod_offer_inst_attr_id', field: 'prodOfferInstAttrId' },
  { group: 'offerInstRels', table: 'prod_offer_inst_rel', pk: 'prod_offer_inst_rel_id', field: 'prodOfferInstRelId' },
  { group: 'accounts', table: 'account', pk: 'account_id', field: 'accountId' },
];
const GROUP_SUFFIX = /(?:First|Second|Third|Fourth|Fifth|Sixth)StepZ?$/;
const SCOPE_FIELDS = new Set(['prodInstId', 'prodInstAId', 'prodInstZId', 'prodOfferInstId', 'relaProdOfferInstId', 'relatedProdOfferInstId', 'accountId', 'parentProdInstId']);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const snake = (value) => value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const fail = (status, code, message, details) => new RedisArchiveError(status, code, message, false, details);
const display = (value) => typeof value === 'bigint' ? value.toString() : value;
const jsonSafe = (value) => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item));

// 原值比较、写入及 TTL 更新在同一 Redis 脚本中完成，避免预览后的并发覆盖。
const SNAPSHOT_SCRIPT = `local v=redis.call('GET',KEYS[1]); local ttl=redis.call('PTTL',KEYS[1]); local t=redis.call('TIME'); return {v or false,ttl,t[1],t[2]}`;
const REPLACE_SCRIPT = `
local current=redis.call('GET',KEYS[1])
if not current or current~=ARGV[1] then return {0} end
local ttl=redis.call('PTTL',KEYS[1])
local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local expiry=-1
if ARGV[3]=='restore' then
  expiry=tonumber(ARGV[4])
  if expiry>=0 and expiry<=now then return {-2} end
elseif ttl>=0 then expiry=now+ttl end
if ARGV[3]=='sync' and math.abs(expiry-tonumber(ARGV[4]))>2 then return {-3} end
redis.call('SET',KEYS[1],ARGV[2])
if expiry>=0 then redis.call('PEXPIREAT',KEYS[1],expiry) end
return {1,expiry}
`;

function validateOptions(options = {}) {
  const tables = options.tables === undefined ? TABLES.map((item) => item.table) : options.tables;
  if (!Array.isArray(tables) || !tables.length || tables.some((item) => !TABLES.some((profile) => profile.table === item))) throw fail(400, 'INVALID_SYNC_TABLES', '请选择固定档案表范围');
  const timestampZone = options.timestampZone || '+08:00';
  if (!['+08:00', 'Z'].includes(timestampZone)) throw fail(400, 'INVALID_TIMESTAMP_ZONE', '时间解释仅支持北京时间或 UTC');
  return { tables: [...new Set(tables)].sort(), timestampZone };
}

function numericValue(value, original) {
  const text = String(value);
  if (typeof original === 'string') return text;
  if (/^-?\d+$/.test(text)) {
    const integer = BigInt(text);
    return integer <= BigInt(Number.MAX_SAFE_INTEGER) && integer >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(text) : integer;
  }
  const number = Number(text);
  // 拒绝会舍入的高精度 decimal，不把金额精度损失写进档案。
  if (!Number.isFinite(number) || canonicalNumber(number) !== canonicalNumber(text)) throw fail(409, 'FIELD_PRECISION', '字段数值精度需要人工核对');
  return number;
}

function convertPgValue(value, original, type, timestampZone, onTimeAdjustment) {
  if (value === null) return null;
  if (/^timestamp/.test(type)) {
    const rawValue = String(value).trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(rawValue);
    if (!match) throw fail(409, 'FIELD_TIME', '字段时间格式需要核对');
    const [, year, month, day, hour, minute, second, fraction = '', offset] = match;
    const y = Number(year), m = Number(month), d = Number(day);
    const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (y === 0 || m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) throw fail(409, 'FIELD_TIME', '字段日历日期或时分秒需要核对');
    const withoutZone = type === 'timestamp without time zone';
    if ((withoutZone && offset) || (!withoutZone && !offset)) throw fail(409, 'FIELD_TIME', '字段时区与 PG 类型不一致');
    let zone = withoutZone ? timestampZone : offset;
    if (/^[+-]\d{2}$/.test(zone)) zone += ':00';
    else if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
    const text = `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(3, '0').slice(0, 3)}${zone}`;
    const milliseconds = Date.parse(text);
    if (!Number.isSafeInteger(milliseconds)) throw fail(409, 'FIELD_TIME', '字段时间超出毫秒范围');
    // Redis/Java Long 使用毫秒；PG 微秒向下截至毫秒，保留原值供预览核对，不进位。
    if (/[1-9]/.test(fraction.slice(3))) onTimeAdjustment?.({ rawValue, normalizedValue: text, targetValue: milliseconds });
    return typeof original === 'string' ? String(milliseconds) : milliseconds;
  }
  if (['bigint', 'integer', 'smallint', 'numeric', 'real', 'double precision'].includes(type)) return numericValue(value, original);
  if (type === 'boolean') return Boolean(value);
  if (['string', 'number', 'bigint'].includes(typeof original)) return typeof original === 'string' ? String(value) : numericValue(value, original);
  if (original === null && ['character varying', 'character', 'text'].includes(type)) return String(value);
  throw fail(409, 'FIELD_TYPE', '字段类型需要人工核对');
}

function recordTimeAdjustment(candidate, identity, adjustment) {
  candidate.timeAdjustmentCount += 1;
  if (candidate.timeAdjustments.length < 200) candidate.timeAdjustments.push({ ...identity, ...adjustment });
}

function buildCandidate(data, tableData, options, productInstanceId) {
  const next = structuredClone(data), changes = [], blockers = [], groups = [], unrecognized = [];
  const timeInfo = { timeAdjustmentCount: 0, timeAdjustments: [] };
  let changedFields = 0, rootFound = false;
  for (const [group, records] of Object.entries(next)) {
    const profile = TABLES.find((item) => item.group === group.replace(GROUP_SUFFIX, ''));
    if (!profile || !Array.isArray(records)) { unrecognized.push(group); continue; }
    if (!options.tables.includes(profile.table)) continue;
    const source = tableData[profile.table];
    const summary = { group, table: profile.table, records: records.length, matched: 0, missing: 0, changed: 0, preservedFields: [], missingIds: [] };
    groups.push(summary);
    if (!source || !source.columns[profile.pk]) { blockers.push(`${profile.table} 的表结构或主键字段缺失`); continue; }
    const index = new Map();
    for (const row of source.rows) {
      const identity = `${row[profile.pk]}:${source.columns.his_id ? row.his_id : ''}`;
      if (!index.has(identity)) index.set(identity, []);
      index.get(identity).push(row);
    }
    for (const [position, record] of records.entries()) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) { blockers.push(`${group}[${position}] 不是档案记录`); continue; }
      const id = String(record[profile.field] ?? '');
      if (!/^\d+$/.test(id) || (source.columns.his_id && !Object.hasOwn(record, 'hisId'))) { blockers.push(`${group}[${position}] 缺少 ID 或 hisId`); continue; }
      const identity = `${id}:${source.columns.his_id ? record.hisId : ''}`;
      const candidates = index.get(identity) || [];
      if (!candidates.length) {
        summary.missing += 1;
        if (summary.missingIds.length < 20 && !summary.missingIds.includes(identity)) summary.missingIds.push(identity);
        continue; // PG 的缺失不等同于业务删除，保留 Redis 记录。
      }
      if (candidates.length > 1 && candidates.some((row) => stringifyLosslessJson(row) !== stringifyLosslessJson(candidates[0]))) { blockers.push(`${profile.table} ${identity} 有冲突的重复记录`); continue; }
      const row = candidates[0]; summary.matched += 1;
      if (profile.table === 'prod_inst' && id === productInstanceId) rootFound = true;
      let changedRecord = false;
      for (const [field, before] of Object.entries(record)) {
        const column = snake(field), type = source.columns[column];
        if (!type || field === 'parentProdInstId') { if (!summary.preservedFields.includes(field)) summary.preservedFields.push(field); continue; }
        let after;
        try { after = convertPgValue(row[column], before, type, options.timestampZone, (adjustment) => recordTimeAdjustment(timeInfo, { group, table: profile.table, id, hisId: display(record.hisId), field, column }, adjustment)); }
        catch (error) { blockers.push(`${group}[${position}].${field}：${error.message}`); continue; }
        if (stringifyLosslessJson(before) === stringifyLosslessJson(after)) continue;
        if (field === profile.field || field === 'hisId' || SCOPE_FIELDS.has(field)) { blockers.push(`${group}[${position}].${field} 的关联范围已变化，需重建规则`); continue; }
        record[field] = after; changedFields += 1; changedRecord = true;
        if (changes.length < 200) changes.push({ group, table: profile.table, id, hisId: display(record.hisId), position, field, column, before: display(before), after: display(after) });
      }
      if (changedRecord) summary.changed += 1;
    }
  }
  // 即使用户仅选属性表，也必须独立验证源产品存在；服务层读取根表。
  if (!rootFound) rootFound = tableData.prod_inst?.rows.some((row) => String(row.prod_inst_id) === productInstanceId);
  if (!rootFound) blockers.push('PG 中未匹配到目标产品实例');
  return { data: next, changes, changedFields, groups, unrecognized, ...timeInfo, blockers: [...new Set(blockers)], canApply: changedFields > 0 && blockers.length === 0 };
}

// 一跳发现与追加规则分离；只有已定义组装规则的直接订购参与追加。
async function compareRecordScope(client, data, tableData, options, productInstanceId) {
  const warnings = [], scoped = {}, records = [];
  let count = 0;
  const read = async (table, columns, ids) => {
    const profile = TABLES.find((item) => item.table === table), source = tableData[table];
    const keys = [...new Set(ids.map(String).filter((id) => /^\d+$/.test(id)))];
    if (!keys.length) return [];
    if (![profile.pk, ...columns].every((column) => source?.columns[column])) {
      warnings.push(`${table} 查询字段缺失，记录级覆盖不完整`); return [];
    }
    if (keys.length > 5000) throw fail(413, 'SYNC_SCOPE_TOO_LARGE', '记录级比对关联 ID 超过 5000');
    const rows = (await client.query(`SELECT * FROM ${SCHEMA}.${table} WHERE (${columns.map((column) => `${column} = ANY($1::bigint[])`).join(' OR ')}) ORDER BY ${profile.pk}${source.columns.his_id ? ', his_id NULLS FIRST' : ''} LIMIT 5001`, [keys])).rows;
    count += rows.length;
    if (count > 5000) throw fail(413, 'SYNC_SCOPE_TOO_LARGE', '记录级比对超过 5000 行，请缩小档案范围');
    scoped[table] = rows;
    source.scopeRows = rows;
    return rows;
  };
  const values = (rows, columns) => rows.flatMap((row) => columns.map((column) => row[column])).filter((id) => id != null);
  const products = new Set([productInstanceId]);
  if (options.tables.some((table) => ['prod_inst', 'prod_inst_rel', 'prod_inst_attr', 'prod_inst_acct', 'account'].includes(table))) {
    const relations = await read('prod_inst_rel', ['prod_inst_a_id', 'prod_inst_z_id'], [productInstanceId]);
    values(relations, ['prod_inst_a_id', 'prod_inst_z_id']).forEach((id) => products.add(String(id)));
  }
  if (options.tables.includes('prod_inst')) await read('prod_inst', ['prod_inst_id'], [...products]);
  if (options.tables.includes('prod_inst_attr')) await read('prod_inst_attr', ['prod_inst_id'], [...products]);
  if (options.tables.some((table) => ['prod_inst_acct', 'account'].includes(table))) {
    const relations = await read('prod_inst_acct', ['prod_inst_id'], [...products]);
    if (options.tables.includes('account')) await read('account', ['account_id'], values(relations, ['account_id']));
  }
  if (options.tables.some((table) => ['offer_prod_inst_rel', 'prod_offer_inst', 'prod_offer_inst_attr', 'prod_offer_inst_rel'].includes(table))) {
    const relations = await read('offer_prod_inst_rel', ['prod_inst_id'], [productInstanceId]);
    if (relations.some((row) => row.prod_offer_inst_id == null)) warnings.push('订购关系缺少 prod_offer_inst_id，销售品覆盖不完整');
    const direct = values(relations, ['prod_offer_inst_id']), offers = new Set(direct.map(String));
    if (options.tables.some((table) => ['prod_offer_inst', 'prod_offer_inst_attr', 'prod_offer_inst_rel'].includes(table))) {
      const links = await read('prod_offer_inst_rel', ['rela_prod_offer_inst_id', 'related_prod_offer_inst_id'], direct);
      values(links, ['rela_prod_offer_inst_id', 'related_prod_offer_inst_id']).forEach((id) => offers.add(String(id)));
    }
    if (options.tables.includes('prod_offer_inst')) await read('prod_offer_inst', ['prod_offer_inst_id'], [...offers]);
    if (options.tables.includes('prod_offer_inst_attr')) await read('prod_offer_inst_attr', ['prod_offer_inst_id'], [...offers]);
  }
  for (const profile of TABLES.filter((item) => options.tables.includes(item.table))) {
    const hasHistory = Boolean(tableData[profile.table]?.columns.his_id);
    const identity = (id, hisId) => JSON.stringify([String(id), hasHistory ? String(hisId ?? null) : '']);
    const existing = new Set(Object.entries(data).filter(([group, rows]) => Array.isArray(rows) && group.replace(GROUP_SUFFIX, '') === profile.group)
      .flatMap(([, rows]) => rows.filter((row) => row && typeof row === 'object').map((row) => identity(row[profile.field], row.hisId))));
    const seen = new Set();
    for (const row of scoped[profile.table] || []) {
      const key = identity(row[profile.pk], row.his_id);
      if (existing.has(key) || seen.has(key)) continue;
      seen.add(key);
      records.push({ table: profile.table, group: profile.group, id: String(row[profile.pk]), hisId: row.his_id == null ? null : String(row.his_id) });
    }
  }
  tableData.scopeRecords = records;
  return { scope: 'root-direct-relations', complete: warnings.length === 0, warnings: [...new Set(warnings)], pgOnlyCount: records.length, pgOnlyRecords: records.slice(0, 200), truncated: records.length > 200 };
}

// 与订阅者 OfferInst / OfferProdInstRel Bean 对齐；不继承另一条订购的值。
const SUBSCRIPTION_FIELDS = {
  offer_prod_inst_rel: 'offerProdInstRelId prodOfferInstId prodInstId roleCd dcsStatusCd statusDate effDate expDate areaId recUpdateDate hisId updateDate',
  prod_offer_inst: 'prodOfferInstId prodOfferId dcsStatusCd statusDate effDate expDate trialEffDate trialExpDate areaId regionCd recUpdateDate offerSubType dcsIbsOfferType hisId updateDate',
};
const STRING_FIELDS = new Set(['roleCd', 'dcsStatusCd', 'regionCd', 'offerSubType', 'dcsIbsOfferType']);
function appendSubscriptions(candidate, source, options, root) {
  const additions = [], unresolved = [];
  const identity = (id, hisId) => `${id}:${hisId ?? null}`;
  const rootRelations = (source.offer_prod_inst_rel?.scopeRows || []).filter((row) => String(row.prod_inst_id) === root);
  const directIds = new Set(rootRelations.map((row) => String(row.prod_offer_inst_id)));
  const hasOffer = (id) => Object.entries(candidate.data).some(([group, rows]) => group.replace(GROUP_SUFFIX, '') === 'offerInsts'
    && Array.isArray(rows) && rows.some((row) => row && String(row.prodOfferInstId) === String(id)));
  for (const item of source.scopeRecords || []) {
    const profile = TABLES.find((entry) => entry.table === item.table);
    const table = source[item.table];
    const rows = (table.scopeRows || []).filter((row) => identity(row[profile.pk], row.his_id) === identity(item.id, item.hisId));
    const row = rows[0];
    let reason = '';
    if (!SUBSCRIPTION_FIELDS[item.table] || !row || (item.table === 'offer_prod_inst_rel' ? String(row.prod_inst_id) !== root : !directIds.has(item.id))) reason = '仅核对：当前追加范围为根产品的直接订购关系及销售品实例';
    else if (rows.some((entry) => stringifyLosslessJson(entry) !== stringifyLosslessJson(row))) reason = '同 ID + his_id 存在冲突的 PG 记录';
    else if (item.table === 'prod_offer_inst' && !options.tables.includes('offer_prod_inst_rel')) reason = '追加销售品实例需同时选择 offer_prod_inst_rel';
    else if (item.table === 'offer_prod_inst_rel' && !options.tables.includes('prod_offer_inst') && !hasOffer(row.prod_offer_inst_id)) reason = '追加订购关系需同时选择 prod_offer_inst 或已有对应 Redis 销售品实例';
    if (reason) { item.action = 'review'; item.reason = reason; unresolved.push(item); continue; }
    const base = profile.group;
    const stepStyle = Object.keys(candidate.data).some((group) => GROUP_SUFFIX.test(group));
    const target = Object.hasOwn(candidate.data, base) ? base : `${base}${stepStyle ? 'FirstStep' : ''}`;
    item.targetGroup = target;
    try {
      if (Object.hasOwn(candidate.data, base) && Object.hasOwn(candidate.data, `${base}FirstStep`)) throw Error('基础分组与 FirstStep 同时存在，请先核对写入位置');
      if (Object.hasOwn(candidate.data, target) && !Array.isArray(candidate.data[target])) throw Error('目标分组不是数组');
      const templates = Object.entries(candidate.data).filter(([group, value]) => group.replace(GROUP_SUFFIX, '') === base && Array.isArray(value)).flatMap(([, value]) => value);
      const fields = new Set([...SUBSCRIPTION_FIELDS[item.table].split(' '), ...templates.flatMap((record) => Object.keys(record || {}))]);
      const required = [profile.field, 'hisId', 'prodOfferInstId', 'dcsStatusCd', 'statusDate', 'effDate', 'expDate', item.table === 'prod_offer_inst' ? 'prodOfferId' : 'prodInstId'];
      const record = {};
      for (const field of fields) {
        if (field === 'parentProdInstId') { record[field] = numericValue(root, 0); continue; }
        // 部分 PG 档案沿用 offer_id 列名，订阅者 JSON 字段固定为 prodOfferId。
        const column = field === 'prodOfferId' && !table.columns.prod_offer_id ? 'offer_id' : snake(field);
        const type = table.columns[column];
        if (!type) {
          if (required.includes(field) || templates.some((record) => Object.hasOwn(record, field))) throw Error(`${field} 缺少已确认的 PG 映射`);
          continue;
        }
        if (!Object.hasOwn(row, column)) throw Error(`${column} 未返回值`);
        if (required.includes(field) && field !== 'hisId' && row[column] == null) throw Error(`${column} 为 NULL`);
        try {
          record[field] = convertPgValue(row[column], STRING_FIELDS.has(field) ? '' : null, type, options.timestampZone,
            (adjustment) => recordTimeAdjustment(candidate, { group: target, table: item.table, id: item.id, hisId: item.hisId, field, column }, adjustment));
        } catch (error) { throw Error(`${field} (${column})：${error.message}`); }
      }
      item.action = 'append';
      additions.push({ ...item, record });
    } catch (error) { item.action = 'review'; item.reason = error.message; unresolved.push(item); }
  }
  // 关系与实例必须形成完整配对；某一条转换失败时整次预览阻断，避免半套订购。
  for (const addition of additions.filter((item) => item.table === 'offer_prod_inst_rel')) {
    const id = String(addition.record.prodOfferInstId);
    if (!hasOffer(id) && !additions.some((item) => item.table === 'prod_offer_inst' && item.id === id)) {
      candidate.blockers.push(`订购关系 ${addition.id} 缺少可写入的销售品实例 ${id}`);
    }
  }
  for (const item of unresolved) {
    if (SUBSCRIPTION_FIELDS[item.table] && (item.table === 'offer_prod_inst_rel' || directIds.has(item.id))) candidate.blockers.push(`${item.table} ${item.id}：${item.reason}`);
  }
  for (const item of additions) {
    (candidate.data[item.targetGroup] ||= []).push(item.record);
  }
  candidate.addedRecords = additions.length;
  candidate.additions = additions;
  candidate.unresolvedRecords = unresolved.length;
  candidate.blockers = [...new Set(candidate.blockers)];
  candidate.canApply = (candidate.changedFields > 0 || additions.length > 0) && candidate.blockers.length === 0;
}

class PgRedisSync {
  constructor({ database, redis, backupDir, clock = Date.now }) {
    this.database = database; this.redis = redis; this.backupDir = backupDir; this.clock = clock;
    this.previews = new Map(); this.busy = new Set();
  }

  async withRedis(work, signal) {
    const config = this.redis.config;
    if (!config.configured) throw fail(409, 'REDIS_NOT_CONFIGURED', '请先配置 Redis 档案连接');
    const connection = new RedisSocket(config, this.redis.net);
    try {
      await connection.connect(signal);
      try { await connection.command(config.username ? ['AUTH', config.username, config.password] : ['AUTH', config.password], signal); }
      catch (error) { if (error.code === 'REDIS_COMMAND_FAILED') throw fail(401, 'REDIS_AUTH_FAILED', 'Redis 认证失败'); throw error; }
      if (config.db) await connection.command(['SELECT', config.db], signal);
      return await work(connection);
    } catch (error) {
      if (error instanceof RedisArchiveError) throw error;
      throw fail(502, 'REDIS_SYNC_CONNECTION', 'Redis 同步连接失败，请检查连接状态');
    } finally { connection.close(); }
  }

  async snapshot(key, signal) {
    return this.withRedis(async (connection) => {
      const [raw, ttl, seconds, micros] = await connection.command(['EVAL', SNAPSHOT_SCRIPT, 1, key], signal);
      if (!raw) throw fail(404, 'REDIS_ARCHIVE_MISSING', 'Redis 中尚无该档案，本工具仅更新已有档案');
      const now = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
      return { raw, ttl, expiresAt: ttl >= 0 ? now + ttl : -1 };
    }, signal);
  }

  connectionFingerprint() {
    const pg = this.database.sources.get('pg')?.config;
    return hash(JSON.stringify([pg || null, this.redis.config])); // 仅哈希留存，不向浏览器暴露配置。
  }

  async readPg(data, options, productInstanceId, signal) {
    return this.database.withPgSnapshot(async (client) => {
      const names = TABLES.map((profile) => profile.table);
      const metadata = await client.query('SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY table_name, ordinal_position', [SCHEMA, names]);
      const result = Object.fromEntries(names.map((table) => [table, { columns: {}, rows: [] }]));
      for (const column of metadata.rows) result[column.table_name].columns[column.column_name] = column.data_type;
      for (const profile of TABLES.filter((item) => options.tables.includes(item.table) || item.table === 'prod_inst')) {
        const source = result[profile.table];
        if (!source.columns[profile.pk]) continue;
        const records = Object.entries(data).filter(([group, value]) => Array.isArray(value) && group.replace(GROUP_SUFFIX, '') === profile.group).flatMap(([, value]) => value);
        const ids = [...new Set(records.map((row) => String(row?.[profile.field] ?? '')).filter((id) => /^\d+$/.test(id)))];
        if (profile.table === 'prod_inst' && !ids.includes(productInstanceId)) ids.push(productInstanceId);
        if (ids.length > 5000) throw fail(413, 'SYNC_SCOPE_TOO_LARGE', '单表匹配 ID 数超过 5000');
        if (ids.length) source.rows = (await client.query(`SELECT * FROM ${SCHEMA}.${profile.table} WHERE ${profile.pk} = ANY($1::bigint[]) ORDER BY ${profile.pk}${source.columns.his_id ? ', his_id' : ''}`, [ids])).rows;
      }
      result.recordComparison = await compareRecordScope(client, data, result, options, productInstanceId);
      return result;
    }, { signal });
  }

  async compute(keyValue, options, signal) {
    const identity = normalizeRedisArchiveKey(keyValue);
    const snapshot = await this.snapshot(identity.key, signal);
    const decoded = decodeArchive(snapshot.raw, this.redis.config.maxDecodedBytes);
    const source = await this.readPg(decoded.data, options, identity.productInstanceId, signal);
    const candidate = buildCandidate(decoded.data, source, options, identity.productInstanceId);
    appendSubscriptions(candidate, source, options, identity.productInstanceId);
    const after = candidate.canApply ? encodeArchive(candidate.data, decoded.prefix, this.redis.config.maxDecodedBytes) : snapshot.raw;
    if (candidate.canApply && stringifyLosslessJson(decodeArchive(after, this.redis.config.maxDecodedBytes).data) !== stringifyLosslessJson(candidate.data)) throw fail(500, 'ENCODE_VERIFY_FAILED', '档案编码自检失败');
    return { ...identity, snapshot, decoded, source, candidate, after };
  }

  async preview(keyValue, rawOptions = {}, { signal } = {}) {
    const options = validateOptions(rawOptions);
    const result = await this.compute(keyValue, options, signal);
    for (const [id, item] of this.previews) if (this.clock() - item.created > 600000) this.previews.delete(id);
    while (this.previews.size >= 5) this.previews.delete(this.previews.keys().next().value);
    const previewId = randomUUID();
    this.previews.set(previewId, { ...result, options, created: this.clock(), fingerprint: this.connectionFingerprint() });
    return jsonSafe({ previewId, key: result.key, productInstanceId: result.productInstanceId, readAt: utc8Iso(), schema: SCHEMA, options,
      changedFields: result.candidate.changedFields, changes: result.candidate.changes, changesTruncated: result.candidate.changedFields > result.candidate.changes.length,
      addedRecords: result.candidate.addedRecords, additions: result.candidate.additions.slice(0, 200), additionsTruncated: result.candidate.addedRecords > 200, unresolvedRecords: result.candidate.unresolvedRecords,
      timeAdjustmentCount: result.candidate.timeAdjustmentCount, timeAdjustments: result.candidate.timeAdjustments, timeAdjustmentsTruncated: result.candidate.timeAdjustmentCount > 200,
      groups: result.candidate.groups, unrecognized: result.candidate.unrecognized, blockers: result.candidate.blockers, canApply: result.candidate.canApply,
      recordComparison: result.source.recordComparison,
      beforeBytes: result.snapshot.raw.length, afterBytes: result.after.length, ttlMs: result.snapshot.ttl,
      prefixHex: result.decoded.prefix.toString('hex'), expiresInSeconds: 600, mode: 'fields-and-direct-subscriptions' });
  }

  async exclusive(key, work) {
    if (this.busy.has(key)) throw fail(409, 'SYNC_BUSY', '该档案正在同步或恢复');
    this.busy.add(key);
    try { return await work(); } finally { this.busy.delete(key); }
  }

  async writeBackup(backup, { create = false } = {}) {
    await fs.mkdir(this.backupDir, { recursive: true });
    const file = path.join(this.backupDir, `${backup.backupId}.json`);
    if (create) await fs.writeFile(file, JSON.stringify(backup), { flag: 'wx', mode: 0o600 });
    else { const temp = `${file}.${randomUUID()}.tmp`; await fs.writeFile(temp, JSON.stringify(backup), { mode: 0o600 }); await fs.rename(temp, file); }
  }

  async replace(key, before, after, mode, expiresAt, signal) {
    return this.withRedis(async (connection) => {
      const response = await connection.command(['EVAL', REPLACE_SCRIPT, 1, key, before, after, mode, expiresAt], signal);
      if (response[0] === 0) throw fail(409, 'REDIS_CHANGED', 'Redis 档案已变化或过期，请重新预览');
      if (response[0] === -2) throw fail(409, 'BACKUP_EXPIRED', '旧档案原过期时间已到，恢复已停止');
      if (response[0] === -3) throw fail(409, 'REDIS_TTL_CHANGED', 'Redis 过期时间已变化，请重新预览');
      const actual = await connection.command(['GET', key], signal);
      if (!actual?.equals(after)) throw fail(409, 'READBACK_MISMATCH', '写入后的 Redis 回读与目标值不一致，请检查备份和当前档案');
      decodeArchive(actual, this.redis.config.maxDecodedBytes);
      return { verified: true, expiresAt: response[1] };
    }, signal);
  }

  async apply(previewId, confirmed, { signal } = {}) {
    if (confirmed !== true) throw fail(400, 'SYNC_CONFIRM_REQUIRED', '同步需要明确确认');
    const preview = this.previews.get(previewId);
    if (!preview || this.clock() - preview.created > 600000) throw fail(409, 'PREVIEW_EXPIRED', '预览已过期，请重新生成');
    if (!preview.candidate.canApply) throw fail(409, 'SYNC_NOT_READY', '预览无可同步差异或存在阻断项');
    return this.exclusive(preview.key, async () => {
      if (preview.fingerprint !== this.connectionFingerprint()) throw fail(409, 'SYNC_CONNECTION_CHANGED', '连接配置已变化，请重新预览');
      const current = await this.compute(preview.key, preview.options, signal);
      if (!current.snapshot.raw.equals(preview.snapshot.raw)) throw fail(409, 'REDIS_CHANGED', 'Redis 档案已变化，请重新预览');
      if (Math.abs(current.snapshot.expiresAt - preview.snapshot.expiresAt) > 2) throw fail(409, 'REDIS_TTL_CHANGED', 'Redis 过期时间已变化，请重新预览');
      if (!current.candidate.canApply || !current.after.equals(preview.after)) throw fail(409, 'PG_CHANGED', 'PG 数据或映射结果已变化，请重新预览');
      const backup = { backupId: randomUUID(), key: preview.key, createdAt: utc8Iso(), fingerprint: preview.fingerprint, before: current.snapshot.raw.toString('base64'),
        beforeHash: hash(current.snapshot.raw), afterHash: hash(current.after), expiresAt: current.snapshot.expiresAt, changedFields: current.candidate.changedFields, addedRecords: current.candidate.addedRecords, status: 'pending' };
      await this.writeBackup(backup, { create: true }); // 原始二进制已落盘才进入写入。
      this.previews.delete(previewId);
      try {
        const result = await this.replace(preview.key, current.snapshot.raw, current.after, 'sync', current.snapshot.expiresAt, signal);
        backup.status = 'applied';
        await this.writeBackup(backup);
        return { key: preview.key, backupId: backup.backupId, changedFields: backup.changedFields, addedRecords: backup.addedRecords, ...result, completedAt: utc8Iso() };
      } catch (error) {
        backup.status = ['REDIS_CHANGED', 'REDIS_TTL_CHANGED', 'BACKUP_EXPIRED'].includes(error.code) ? 'not-applied' : 'uncertain';
        await this.writeBackup(backup).catch(() => {});
        throw fail(error.status || 502, error.code || 'SYNC_FAILED', error.message, { backupId: backup.backupId, outcome: backup.status });
      }
    });
  }

  async readBackup(backupId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(backupId)) throw fail(400, 'INVALID_BACKUP_ID', '备份标识格式错误');
    try { return JSON.parse(await fs.readFile(path.join(this.backupDir, `${backupId}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw fail(404, 'BACKUP_NOT_FOUND', '备份不存在'); throw error; }
  }

  async history(keyValue) {
    const { key } = normalizeRedisArchiveKey(keyValue);
    let files;
    try { files = await fs.readdir(this.backupDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const backups = [];
    for (const file of files.filter((item) => /^[0-9a-f-]+\.json$/.test(item))) {
      const item = await this.readBackup(file.slice(0, -5));
      if (item.key === key && item.fingerprint === this.connectionFingerprint()) backups.push({ backupId: item.backupId, key: item.key, createdAt: item.createdAt, status: item.status, changedFields: item.changedFields, addedRecords: item.addedRecords || 0, expiresAt: item.expiresAt });
    }
    return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
  }

  async restore(backupId, confirmed, { signal } = {}) {
    if (confirmed !== true) throw fail(400, 'SYNC_CONFIRM_REQUIRED', '恢复需要明确确认');
    const backup = await this.readBackup(backupId);
    normalizeRedisArchiveKey(backup.key);
    if (backup.fingerprint !== this.connectionFingerprint()) throw fail(409, 'SYNC_CONNECTION_CHANGED', '备份所属连接与当前连接不同');
    if (!['applied', 'uncertain', 'pending'].includes(backup.status)) throw fail(409, 'BACKUP_NOT_APPLIED', '该备份当前状态不支持恢复');
    return this.exclusive(backup.key, async () => {
      const current = await this.snapshot(backup.key, signal);
      if (hash(current.raw) !== backup.afterHash) throw fail(409, 'REDIS_CHANGED', 'Redis 已被后续修改，请核对后再恢复');
      const before = Buffer.from(backup.before, 'base64');
      if (hash(before) !== backup.beforeHash) throw fail(409, 'BACKUP_CORRUPT', '备份完整性校验失败');
      decodeArchive(before, this.redis.config.maxDecodedBytes);
      const result = await this.replace(backup.key, current.raw, before, 'restore', backup.expiresAt, signal);
      backup.status = 'restored'; backup.restoredAt = utc8Iso(); await this.writeBackup(backup);
      return { key: backup.key, backupId, ...result, completedAt: backup.restoredAt };
    });
  }
}

module.exports = { PgRedisSync, TABLES, SCHEMA, validateOptions, convertPgValue, buildCandidate, SNAPSHOT_SCRIPT, REPLACE_SCRIPT };
