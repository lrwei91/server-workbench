'use strict';

const { randomUUID, createHash } = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { RedisSocket, RedisArchiveError, normalizeRedisArchiveKey, utc8Iso } = require('./redis-archive');
const { encodeArchive, decodeArchive, stringifyLosslessJson } = require('./archive-codec');

// Check the source and every missing destination before creating any member.
const CREATE_INDEXES_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {-1} end
for i = 2, #KEYS do
  if redis.call('EXISTS', KEYS[i]) ~= 0 then return {-2, i} end
end
local pos = 2
for i = 2, #KEYS do
  local count = tonumber(ARGV[pos]); pos = pos + 1
  for j = 1, count do
    redis.call('SADD', KEYS[i], ARGV[pos]); pos = pos + 1
  end
end
return {1}`;

const fail = (status, code, message, details) => new RedisArchiveError(status, code, message, false, details);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const safe = (value) => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));
const keyValue = (value) => {
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  const text = String(value);
  return text.length > 0 && text.length <= 200 && !/[\s\x00-\x1f\x7f]/u.test(text) ? text : null;
};

function indexCandidates(data, productInstanceId) {
  const roots = Array.isArray(data.prodInsts) ? data.prodInsts.filter((row) => row && String(row.prodInstId) === productInstanceId) : [];
  if (!roots.length) throw fail(409, 'INDEX_ROOT_MISSING', 'CPP 的 prodInsts 中没有对应根产品实例，请先核对档案');
  const groups = new Map(), warnings = new Set();
  for (const row of roots) {
    const areaCode = keyValue(row.areaCode);
    if (!areaCode || !/^\d{3,6}$/.test(areaCode)) throw fail(409, 'INDEX_AREA_MISSING', '根产品实例缺少有效 areaCode，请先核对档案');
    for (const field of ['account', 'accNbr']) {
      const value = keyValue(row[field]);
      if (!value) { warnings.add(`${field} 为空或格式异常，未生成对应索引；两种号码不互相替代。`); continue; }
      const key = `rate:${field}:${value}`;
      const member = { areaCode, servId: BigInt(productInstanceId), [field]: value };
      if (!groups.has(key)) groups.set(key, { key, field, members: new Map() });
      groups.get(key).members.set(stringifyLosslessJson(member), member);
    }
  }
  if (groups.size > 100) throw fail(413, 'INDEX_SCOPE_TOO_LARGE', '该实例历史索引超过 100 个 key，请先核对档案范围');
  return { groups: [...groups.values()].map((group) => ({ ...group, members: [...group.members.values()] })), warnings: [...warnings] };
}

class RedisIndexes {
  constructor({ redis, database, auditDir, clock = Date.now }) {
    this.redis = redis; this.database = database; this.auditDir = auditDir; this.clock = clock; this.previews = new Map();
  }

  fingerprint() { return digest(JSON.stringify(this.redis.config)); }

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
    } finally { connection.close(); }
  }

  async lookup(inputType, rawValue, { signal } = {}) {
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!['instance', 'phone'].includes(inputType) || !/^(?:rate:cpp:)?\d{1,20}$/.test(value) || (inputType === 'phone' && !/^\d{1,20}$/.test(value))) throw fail(400, 'INVALID_INDEX_INPUT', '请选择实例 ID 或手机号，并输入纯数字；实例支持 rate:cpp 主键');
    if (inputType === 'instance') return { source: 'Redis CPP', candidates: [{ productInstanceId: normalizeRedisArchiveKey(value).productInstanceId }] };
    const ids = await this.withRedis(async (connection) => {
      const key = `rate:accNbr:${value}`;
      const type = String(await connection.command(['TYPE', key], signal));
      if (type === 'none') return [];
      if (type !== 'set') throw fail(409, 'INDEX_WRONG_TYPE', '该 accNbr 索引不是 SET，请先核对已有 key');
      if (await connection.command(['SCARD', key], signal) > 100) throw fail(413, 'INDEX_SCOPE_TOO_LARGE', '号码索引超过 100 个成员，请使用实例 ID');
      const members = await connection.command(['SMEMBERS', key], signal);
      return [...new Set(members.map((raw) => {
        const item = decodeArchive(raw, this.redis.config.maxDecodedBytes).data;
        if (!/^\d{1,20}$/.test(String(item.servId)) || item.accNbr !== value) throw fail(409, 'INDEX_MEMBER_INVALID', '已有 accNbr 成员与输入号码不匹配，请先核对');
        return String(item.servId);
      }))];
    }, signal);
    if (ids.length) return { source: 'Redis accNbr 索引', candidates: ids.map((productInstanceId) => ({ productInstanceId })) };
    const rows = await this.database.withPgSnapshot(async (client) => (await client.query('SELECT DISTINCT prod_inst_id::text AS prod_inst_id FROM bill_inmemory.prod_inst WHERE acc_nbr = $1 ORDER BY prod_inst_id LIMIT 101', [value])).rows, { signal });
    if (rows.length > 100) throw fail(413, 'INDEX_SCOPE_TOO_LARGE', 'PG 中匹配超过 100 个实例，请使用实例 ID');
    return { source: '测试 PG bill_inmemory（号码索引缺失时定位）', candidates: rows.map((row) => ({ productInstanceId: String(row.prod_inst_id) })) };
  }

  async preview(value, { signal } = {}) {
    const identity = normalizeRedisArchiveKey(value);
    if (identity.productInstanceId.length > 19 || BigInt(identity.productInstanceId) <= 0n || BigInt(identity.productInstanceId) > 9223372036854775807n) throw fail(400, 'INVALID_INDEX_INPUT', '产品实例 ID 应为正 bigint');
    const result = await this.withRedis(async (connection) => {
      const raw = await connection.command(['GET', identity.key], signal);
      if (!raw) throw fail(404, 'INDEX_CPP_MISSING', 'Redis 尚无该 CPP 完整档案；本功能仅补建索引，请先导入完整档案');
      const decoded = decodeArchive(raw, this.redis.config.maxDecodedBytes);
      const { groups, warnings } = indexCandidates(decoded.data, identity.productInstanceId);
      for (const group of groups) {
        group.type = String(await connection.command(['TYPE', group.key], signal));
        group.status = group.type === 'none' ? 'missing' : 'existing';
        group.encoded = group.members.map((member) => {
          const bytes = encodeArchive(member, Buffer.from([3]), this.redis.config.maxDecodedBytes);
          if (stringifyLosslessJson(decodeArchive(bytes).data) !== stringifyLosslessJson(member)) throw fail(500, 'INDEX_ENCODE_VERIFY', '索引编码自检失败');
          return bytes;
        });
      }
      return { ...identity, raw, groups, warnings };
    }, signal);
    for (const [id, item] of this.previews) if (this.clock() - item.created > 600000) this.previews.delete(id);
    while (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value);
    const previewId = randomUUID();
    this.previews.set(previewId, { ...result, created: this.clock(), fingerprint: this.fingerprint() });
    const { host, port, db } = this.redis.defaults();
    return safe({ previewId, key: result.key, productInstanceId: result.productInstanceId, readAt: utc8Iso(), target: { host, port, db }, warnings: result.warnings,
      scope: '仅使用所选 CPP 的根 prodInsts（含现存历史版本）；不扫描其他实例，不保证共享号码的全库成员覆盖。',
      groups: result.groups.map(({ key, field, type, status, members }) => ({ key, field, type, status, members })),
      missingKeys: result.groups.filter((group) => group.status === 'missing').length, canApply: result.groups.some((group) => group.status === 'missing'), expiresInSeconds: 600 });
  }

  async apply(previewId, confirmed, { signal } = {}) {
    if (confirmed !== true) throw fail(400, 'INDEX_CONFIRM_REQUIRED', '新增索引需要明确确认');
    const item = this.previews.get(previewId);
    if (!item || this.clock() - item.created > 600000 || item.fingerprint !== this.fingerprint()) throw fail(409, 'INDEX_PREVIEW_EXPIRED', '预览已过期或连接变化，请重新查询预览');
    const missing = item.groups.filter((group) => group.status === 'missing');
    if (!missing.length) throw fail(409, 'INDEX_NOTHING_MISSING', '没有缺失 key，已有内容保持原样');
    this.previews.delete(previewId); // Never replay a write after a lost response.
    const auditId = randomUUID(), file = path.join(this.auditDir, `${auditId}.json`);
    const audit = safe({ auditId, createdAt: utc8Iso(), status: 'pending', connection: item.fingerprint, sourceKey: item.key, sourceSha256: digest(item.raw),
      targets: missing.map(({ key, members, encoded }) => ({ key, members, encodedHex: encoded.map((raw) => raw.toString('hex')) })) });
    await fs.mkdir(this.auditDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(audit), { flag: 'wx', mode: 0o600 });
    let sent = false;
    try {
      const result = await this.withRedis(async (connection) => {
        const parts = ['EVAL', CREATE_INDEXES_SCRIPT, missing.length + 1, item.key, ...missing.map((group) => group.key), item.raw];
        for (const group of missing) parts.push(group.encoded.length, ...group.encoded);
        sent = true;
        const response = await connection.command(parts, signal);
        if (response[0] === -1) { sent = false; throw fail(409, 'INDEX_SOURCE_CHANGED', 'CPP 已变化或过期，请重新预览'); }
        if (response[0] === -2) { sent = false; throw fail(409, 'INDEX_TARGET_CHANGED', '预览中的缺失 key 已被其他操作创建；本次没有写入，请重新预览'); }
        for (const group of missing) {
          const actual = await connection.command(['SMEMBERS', group.key], signal);
          const actualHex = actual.map((raw) => { decodeArchive(raw, this.redis.config.maxDecodedBytes); return raw.toString('hex'); }).sort();
          if (JSON.stringify(actualHex) !== JSON.stringify(group.encoded.map((raw) => raw.toString('hex')).sort())) throw fail(409, 'INDEX_READBACK_MISMATCH', '新增后成员回读与预览不一致，请核对当前 key');
        }
        return { auditId, verified: true, createdKeys: missing.map((group) => group.key), members: missing.reduce((sum, group) => sum + group.encoded.length, 0) };
      }, signal);
      audit.status = 'verified'; await fs.writeFile(file, JSON.stringify(audit), { mode: 0o600 });
      return result;
    } catch (error) {
      audit.status = sent ? 'uncertain' : 'not-applied';
      await fs.writeFile(file, JSON.stringify(audit), { mode: 0o600 }).catch(() => {});
      throw fail(error.status || 502, error.code || 'INDEX_WRITE_FAILED', sent ? `${error.message}；写入结果待核对，请先重新查询，勿直接重试。` : error.message, { auditId, status: audit.status });
    }
  }
}

module.exports = { RedisIndexes, indexCandidates, CREATE_INDEXES_SCRIPT };
