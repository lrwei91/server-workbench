'use strict';

const { RedisSocket, RedisArchiveError } = require('./redis-archive');

const PREFIX = 'rate:SERV_SNAPSHOT:';
const MAX_VALUE_BYTES = 64 * 1024;

const DETAIL = [
  "local kind = redis.call('TYPE', KEYS[1]).ok",
  "if kind == 'none' then return {kind} end",
  "local ttl = redis.call('PTTL', KEYS[1])",
  "if kind == 'string' then",
  "  local size = redis.call('STRLEN', KEYS[1])",
  "  if size > tonumber(ARGV[2]) then return {kind, ttl, size} end",
  "  return {kind, ttl, size, redis.call('GET', KEYS[1])}",
  "end",
  "if kind == 'set' then",
  "  local page = redis.call('SSCAN', KEYS[1], ARGV[1], 'COUNT', 100)",
  "  local rows = {}",
  "  for i, member in ipairs(page[2]) do",
  "    rows[i] = {#member}",
  "    if #member <= tonumber(ARGV[2]) then rows[i][2] = member end",
  "  end",
  "  return {kind, ttl, redis.call('SCARD', KEYS[1]), page[1], rows}",
  "end",
  "return {kind, ttl}",
].join('\n');

const MUTATE = [
  "local key, action = KEYS[1], ARGV[1]",
  "local kind = redis.call('TYPE', key).ok",
  "if action == 'create' then",
  "  if kind ~= 'none' then return 'exists' end",
  "  if ARGV[2] == 'string' then redis.call('SET', key, ARGV[3])",
  "  else redis.call('SADD', key, ARGV[3]) end",
  "  return 'ok'",
  "end",
  "if action == 'set-string' then",
  "  if kind ~= 'string' or redis.call('GET', key) ~= ARGV[2] then return 'stale' end",
  "  local ttl = redis.call('PTTL', key)",
  "  if ttl < 0 then redis.call('SET', key, ARGV[3])",
  "  else redis.call('PSETEX', key, math.max(1, ttl), ARGV[3]) end",
  "  return 'ok'",
  "end",
  "if kind ~= 'set' then return 'stale' end",
  "if action == 'add-member' then",
  "  if redis.call('SADD', key, ARGV[3]) == 0 then return 'duplicate' end",
  "  return 'ok'",
  "end",
  "if redis.call('SISMEMBER', key, ARGV[2]) == 0 then return 'stale' end",
  "if action == 'replace-member' then",
  "  if ARGV[2] == ARGV[3] then return 'ok' end",
  "  if redis.call('SADD', key, ARGV[3]) == 0 then return 'duplicate' end",
  "end",
  "redis.call('SREM', key, ARGV[2])",
  "if redis.call('EXISTS', key) == 0 then return 'removed' end",
  "return 'ok'",
].join('\n');

const fail = (status, code, message, retryable = false) => new RedisArchiveError(status, code, message, retryable);
const invalid = (message) => fail(400, 'INVALID_SNAPSHOT_INPUT', message);
const snapshotKey = (key) => {
  if (typeof key !== 'string' || !key.startsWith(PREFIX) || key.length === PREFIX.length ||
      Buffer.byteLength(key) > 512 || /[\x00-\x1f\x7f]/u.test(key) || Buffer.from(key).toString() !== key) {
    throw invalid('请输入以 rate:SERV_SNAPSHOT: 开头且带有后缀的键名（最多 512 字节）');
  }
  return key;
};
function cursorValue(cursor = '0') {
  if (typeof cursor !== 'string' || !/^(?:0|[1-9]\d{0,19})$/.test(cursor) || BigInt(cursor) > (1n << 64n) - 1n) throw invalid('扫描游标无效，请重新查询');
  return cursor;
}
function scanPattern(input = '') {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 512 || /[\x00-\x1f\x7f]/u.test(input)) throw invalid('搜索词无效');
  const query = input.trim();
  const escape = (s) => s.replace(/([\\*?\[\]])/g, '\\$1');
  if (!query || query === PREFIX.slice(0, -1) || query === PREFIX) return PREFIX + '*';
  return query.startsWith(PREFIX) ? escape(query) : PREFIX + '*' + escape(query) + '*';
}
function inputText(value, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.length) || Buffer.byteLength(value) > MAX_VALUE_BYTES ||
      /[\x00-\x08\x0b-\x1f\x7f]/u.test(value) || Buffer.from(value).toString() !== value) {
    throw invalid('请输入有效的文本' + (allowEmpty ? '' : '（成员必填）') + '，单条最多 64 KiB');
  }
  return value;
}
function row(size, raw) {
  const value = raw?.toString('utf8');
  return { size, value: value !== undefined && !/[\x00-\x08\x0b-\x1f\x7f]/u.test(value) && raw.equals(Buffer.from(value)) ? value : null };
}

class RedisSnapshots {
  constructor(redis) { this.redis = redis; }

  async withRedis(work, signal) {
    const { config, net } = this.redis;
    if (!config.configured) throw fail(409, 'REDIS_NOT_CONFIGURED', '请先配置 Redis 档案连接');
    const socket = new RedisSocket(config, net);
    try {
      await socket.connect(signal);
      try { await socket.command(config.username ? ['AUTH', config.username, config.password] : ['AUTH', config.password], signal); }
      catch (error) {
        if (error.code === 'REDIS_COMMAND_FAILED') throw fail(401, 'REDIS_AUTH_FAILED', 'Redis 认证失败');
        throw error;
      }
      if (config.db) await socket.command(['SELECT', config.db], signal);
      return await work((...parts) => socket.command(parts, signal));
    } catch (error) {
      if (/^(?:ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ETIMEDOUT)$/.test(error.code)) {
        throw fail(502, 'REDIS_CONNECTION_FAILED', 'Redis 连接失败，请检查地址、端口和网络', true);
      }
      throw error;
    } finally { socket.close(); }
  }

  async search({ query, cursor }, signal) {
    const pattern = scanPattern(query);
    let next = cursorValue(cursor);
    const keys = new Set();
    return this.withRedis(async (command) => {
      let batches = 0;
      do {
        const [rawCursor, batch] = await command('SCAN', next, 'MATCH', pattern, 'COUNT', 500);
        next = String(rawCursor); batches++;
        for (const raw of batch) {
          const key = String(raw);
          if (!raw.equals(Buffer.from(key))) continue;
          try { keys.add(snapshotKey(key)); } catch (error) { if (error.code !== 'INVALID_SNAPSHOT_INPUT') throw error; }
        }
      } while (next !== '0' && keys.size < 100 && batches < 16);
      const { host, port, db } = this.redis.config;
      return { keys: [...keys].sort(), cursor: next, target: { host, port, db }, batches };
    }, signal);
  }

  async detail({ key, cursor }, signal) {
    const name = snapshotKey(key), offset = cursorValue(cursor);
    return this.withRedis(async (command) => {
      const [rawType, ttl, size, value, rows] = await command('EVAL', DETAIL, 1, name, offset, MAX_VALUE_BYTES);
      const type = String(rawType);
      if (type === 'string') return { key: name, type, ttl, row: row(size, value) };
      if (type === 'set') {
        const members = rows.map(([bytes, raw]) => row(bytes, raw));
        const seen = new Set();
        return { key: name, type, ttl, count: size, cursor: String(value), members: members.filter(({ value: member }) => {
          if (member === null) return true;
          if (seen.has(member)) return false;
          seen.add(member); return true;
        }) };
      }
      return { key: name, type, ttl };
    }, signal);
  }

  async mutate({ key, action, type, previous, value, confirmed }, signal) {
    const name = snapshotKey(key);
    if (confirmed !== true) throw invalid('请先确认本次 Redis 操作');
    let args;
    switch (action) {
      case 'create':
        if (!['string', 'set'].includes(type)) throw invalid('请选择 STRING 或 SET');
        args = [type, inputText(value, type === 'string')]; break;
      case 'set-string': args = [inputText(previous, true), inputText(value, true)]; break;
      case 'add-member': args = ['', inputText(value)]; break;
      case 'replace-member': args = [inputText(previous, true), inputText(value)]; break;
      case 'remove-member': args = [inputText(previous, true)]; break;
      default: throw invalid('未知的快照操作');
    }
    return this.withRedis(async (command) => {
      const result = String(await command('EVAL', MUTATE, 1, name, action, ...args));
      if (result === 'exists') throw fail(409, 'SNAPSHOT_KEY_EXISTS', '同名键已存在，原数据保留');
      if (result === 'duplicate') throw fail(409, 'SNAPSHOT_MEMBER_EXISTS', '成员已存在，原数据保留');
      if (result === 'stale') throw fail(409, 'SNAPSHOT_CHANGED', '键类型或原值已变化，请刷新后再操作');
      if (!['ok', 'removed'].includes(result)) throw fail(502, 'SNAPSHOT_WRITE_RESULT', 'Redis 返回了未知写入结果，请刷新核对');
      return { key: name, removed: result === 'removed' };
    }, signal);
  }
}

module.exports = { RedisSnapshots, scanPattern };
