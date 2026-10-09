'use strict';

const config = require('./config-loader');

const SOURCE_DEFAULTS = {
  udal: { label: 'MySQL / UDAL', ...config.database.udal },
  doris: { label: 'Doris', ...config.database.doris },
  pg: { label: 'PostgreSQL', ...config.database.pg },
};

function normalizeSource(value) {
  const source = String(value || '').trim().toLowerCase();
  if (!SOURCE_DEFAULTS[source]) throw new Error('数据源必须是 udal、doris 或 pg');
  return source;
}

function maskConfig(config) {
  return { host: config.host, port: config.port, username: config.username, database: config.database || '', hasPassword: Boolean(config.password) };
}

class DatabaseManager {
  constructor(mysql, pg) {
    this.mysql = mysql;
    this.pg = pg;
    this.sources = new Map();
    this.generations = new Map();
  }

  defaults() {
    return Object.fromEntries(Object.entries(SOURCE_DEFAULTS).map(([key, value]) => [key, { label: value.label, ...maskConfig(value) }]));
  }

  status() {
    const result = {};
    for (const [key, defaults] of Object.entries(SOURCE_DEFAULTS)) {
      const entry = this.sources.get(key);
      result[key] = { connected: Boolean(entry), label: defaults.label, config: entry ? maskConfig(entry.config) : null };
    }
    return result;
  }

  async connect(sourceValue, raw = {}) {
    const source = normalizeSource(sourceValue);
    const defaults = SOURCE_DEFAULTS[source];
    const generation = (this.generations.get(source) || 0) + 1;
    this.generations.set(source, generation);
    await this.disconnect(source);
    const config = {
      host: String(raw.host || defaults.host).trim(),
      port: Number(raw.port || defaults.port),
      username: String(raw.username || defaults.username).trim(),
      password: typeof raw.password === 'string' ? raw.password : defaults.password || '',
      database: typeof raw.database === 'string' ? raw.database.trim() : defaults.database || '',
    };
    if (!config.host || !config.username || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('数据库地址、端口和账号必须填写正确');
    if (source === 'pg' && !config.database) throw new Error('PostgreSQL 数据库名必须填写');
    const pools = new Map();
    try {
      if (source === 'pg') {
        const pool = new this.pg.Pool({ host: config.host, port: config.port, user: config.username, password: config.password, database: config.database, max: 2, connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000 });
        pools.set(config.database, pool);
        await pool.query('SELECT 1 AS ok');
      } else {
        for (const database of defaults.databases) {
          const selectedDb = database || config.database || undefined;
          const pool = this.mysql.createPool({
            host: config.host, port: config.port, user: config.username, password: config.password,
            ...(selectedDb ? { database: selectedDb } : {}),
            waitForConnections: true, connectionLimit: source === 'udal' ? 4 : 2, queueLimit: 0,
            multipleStatements: false, connectTimeout: 15000, enableKeepAlive: true,
            charset: 'utf8mb4',
            supportBigNumbers: true, bigNumberStrings: true, dateStrings: true,
          });
          pools.set(selectedDb || '', pool);
          await pool.query({ sql: 'SELECT 1 AS ok', timeout: 15000 });
        }
      }
      if (this.generations.get(source) !== generation) throw new Error('数据库连接请求已过期');
      this.sources.set(source, { config, pools });
      return maskConfig(config);
    } catch (error) {
      await Promise.allSettled([...pools.values()].map((pool) => pool.end()));
      throw error;
    }
  }

  async disconnect(sourceValue) {
    const source = normalizeSource(sourceValue);
    const entry = this.sources.get(source);
    this.sources.delete(source);
    if (entry) await Promise.allSettled([...entry.pools.values()].map((pool) => pool.end()));
  }

  async closeAll() {
    await Promise.allSettled(Object.keys(SOURCE_DEFAULTS).map((source) => this.disconnect(source)));
  }

  // 仅供固定档案同步读取使用，不开放任意 PG SQL 的 HTTP 入口。
  async withPgSnapshot(work, { signal } = {}) {
    const entry = this.sources.get('pg');
    if (!entry) throw Object.assign(new Error('请先连接测试环境 PostgreSQL'), { status: 409, code: 'PG_NOT_CONNECTED' });
    const pool = entry.pools.values().next().value;
    const client = await pool.connect();
    let released = false;
    const abort = () => { if (!released) { released = true; client.release(true); } };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) { abort(); throw Object.assign(new Error('查询已取消'), { status: 499, code: 'QUERY_CANCELLED' }); }
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '15s'");
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      const types = { getTypeParser: (oid, format) => [1082, 1114, 1184].includes(oid) ? (value) => value : this.pg.types.getTypeParser(oid, format) };
      const result = await work({ query: (text, values = []) => client.query({ text, values, types }) });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (!released) await client.query('ROLLBACK').catch(() => {});
      if (signal?.aborted) throw Object.assign(new Error('查询已取消'), { status: 499, code: 'QUERY_CANCELLED' });
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (!released) { released = true; client.release(); }
    }
  }

  async query(sourceValue, database, sql, values = [], options = {}) {
    const source = normalizeSource(sourceValue);
    const entry = this.sources.get(source);
    if (!entry) throw new Error(`${SOURCE_DEFAULTS[source].label} 尚未连接`);
    if (source === 'pg') throw new Error('PostgreSQL 当前仅用于连接状态检查');
    const pool = entry.pools.get(database || '') || entry.pools.values().next().value;
    if (!pool) throw new Error(`数据源 ${source} 没有可用连接`);
    if (options.signal?.aborted) throw Object.assign(new Error('查询已取消'), { code: 'QUERY_CANCELLED' });
    const connection = await pool.getConnection();
    if (options.signal?.aborted) { connection.destroy(); throw Object.assign(new Error('查询已取消'), { code: 'QUERY_CANCELLED' }); }
    let aborted = false;
    const abort = () => { aborted = true; connection.destroy(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const [rows] = await connection.query({ sql, values, timeout: Number(options.timeout) || 15000 });
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      if (aborted || options.signal?.aborted) throw Object.assign(new Error('查询已取消'), { code: 'QUERY_CANCELLED' });
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (!aborted) connection.release();
    }
  }
}

function createDatabaseManager(mysql = require('mysql2/promise'), pg = require('pg')) { return new DatabaseManager(mysql, pg); }
const manager = createDatabaseManager();

module.exports = { SOURCE_DEFAULTS, DatabaseManager, createDatabaseManager, manager, normalizeSource, maskConfig };
