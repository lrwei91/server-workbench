'use strict';

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const LOGICAL_DATABASES = ['CRM3DB', 'CONFIGDB_CNOS_JF_TEST'];

class VoyageError extends Error {
  constructor(status, code, message, retryable = false, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

function normalizeMapping(value = {}) {
  return {
    datasourceId: Number(value.datasourceId),
    database: String(value.database || '').trim(),
    schema: String(value.schema || '').trim(),
  };
}

function maskConfig(config = {}) {
  const crm = normalizeMapping(config.mappings?.CRM3DB);
  const configuration = normalizeMapping(config.mappings?.CONFIGDB_CNOS_JF_TEST);
  const validMapping = (mapping) => Number.isInteger(mapping.datasourceId) && mapping.datasourceId > 0 && Boolean(mapping.database && mapping.schema);
  return {
    apiUrl: String(config.apiUrl || ''),
    configured: Boolean(String(config.apiUrl || '').trim() && String(config.token || '').trim() && validMapping(crm) && validMapping(configuration)),
    hasToken: Boolean(String(config.token || '').trim()),
    timeoutMs: Math.max(1000, Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS),
    mappings: { CRM3DB: crm, CONFIGDB_CNOS_JF_TEST: configuration },
  };
}

function quoteSqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (Buffer.isBuffer(value) || typeof value === 'object') throw new VoyageError(400, 'INVALID_QUERY_PARAMETER', 'Voyage 查询参数必须是标量');
  return `'${String(value).replace(/'/g, "''")}'`;
}

function compileSql(sql, values = []) {
  let index = 0;
  const compiled = String(sql || '').replace(/\?/g, () => {
    if (index >= values.length) throw new VoyageError(400, 'INVALID_QUERY_PARAMETER', 'Voyage 查询参数数量不足');
    return quoteSqlValue(values[index++]);
  });
  if (index !== values.length) throw new VoyageError(400, 'INVALID_QUERY_PARAMETER', 'Voyage 查询参数数量不匹配');
  return compiled;
}

// JSON.parse 会先把超大整数转换为 Number；这里仅把字符串外的不安全整数包成字符串。
function preserveUnsafeIntegers(text) {
  let output = ''; let inString = false; let escaped = false;
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      index += 1; continue;
    }
    if (char === '"') { inString = true; output += char; index += 1; continue; }
    if (char === '-' || /[0-9]/.test(char)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
      if (match) {
        const token = match[0];
        if (!/[.eE]/.test(token) && !Number.isSafeInteger(Number(token))) output += JSON.stringify(token);
        else output += token;
        index += token.length; continue;
      }
    }
    output += char; index += 1;
  }
  return output;
}

function parseVoyageJson(text) {
  try { return JSON.parse(preserveUnsafeIntegers(String(text || ''))); }
  catch (_) { throw new VoyageError(502, 'VOYAGE_INVALID_RESPONSE', 'Voyage 返回了不可识别的 JSON', true); }
}

function normalizeRows(statement) {
  if (!Array.isArray(statement?.columns) || !Array.isArray(statement?.rows)) throw new VoyageError(502, 'VOYAGE_INVALID_RESPONSE', 'Voyage 查询响应缺少 columns 或 rows', true);
  return statement.rows.map((values) => {
    if (!Array.isArray(values)) throw new VoyageError(502, 'VOYAGE_INVALID_RESPONSE', 'Voyage 查询行格式不正确', true);
    return Object.fromEntries(statement.columns.map((column, index) => {
      const value = values[index];
      return [column, typeof value === 'number' && /(?:^|_)(?:id|nbr)$|_id_/i.test(column) ? String(value) : value];
    }));
  });
}

class VoyageManager {
  constructor(config = {}, fetchImpl = globalThis.fetch) {
    this.config = { ...config, timeoutMs: Math.max(1000, Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS) };
    this.fetch = fetchImpl;
    this.connected = false;
    this.generation = 0;
    this.active = new Set();
  }

  defaults() { return maskConfig(this.config); }
  status() { return { connected: this.connected, config: this.defaults() }; }

  validateConfig() {
    const masked = this.defaults();
    if (!masked.apiUrl || !masked.hasToken) throw new VoyageError(409, 'VOYAGE_NOT_CONFIGURED', 'Voyage 在线数据库待配置，请填写 VOYAGE_TOKEN');
    for (const logical of LOGICAL_DATABASES) {
      const mapping = masked.mappings[logical];
      if (!Number.isInteger(mapping.datasourceId) || mapping.datasourceId < 1 || !mapping.database || !mapping.schema) throw new VoyageError(409, 'VOYAGE_NOT_CONFIGURED', `Voyage ${logical} 数据源映射不完整`);
    }
  }

  async connect() {
    this.validateConfig();
    const generation = ++this.generation;
    await this.abortActive();
    try {
      await this.execute('CRM3DB', 'SELECT 1 AS ok', [], { timeout: this.config.timeoutMs, allowDisconnected: true });
      if (generation !== this.generation) throw new VoyageError(409, 'STALE_VOYAGE_CONNECTION', 'Voyage 连接请求已过期，请重试', true);
      this.connected = true;
      return this.status();
    } catch (error) {
      if (generation === this.generation) this.connected = false;
      throw error;
    }
  }

  async abortActive() {
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }

  async disconnect() { ++this.generation; this.connected = false; await this.abortActive(); }

  async query(source, logicalDatabase, sql, values = [], options = {}) {
    if (String(source || '').toLowerCase() !== 'voyage') throw new VoyageError(400, 'INVALID_INPUT', 'Voyage 数据源标识不正确');
    if (!this.connected) throw new VoyageError(409, 'VOYAGE_NOT_CONNECTED', 'Voyage 在线数据库尚未连接');
    return this.execute(logicalDatabase, sql, values, options);
  }

  async execute(logicalDatabase, sql, values = [], options = {}) {
    const mapping = this.defaults().mappings[logicalDatabase];
    if (!mapping) throw new VoyageError(400, 'INVALID_INPUT', `Voyage 不支持逻辑库 ${logicalDatabase}`);
    if (!options.allowDisconnected && !this.connected) throw new VoyageError(409, 'VOYAGE_NOT_CONNECTED', 'Voyage 在线数据库尚未连接');
    const controller = new AbortController(); const abort = () => controller.abort(); let timedOut = false;
    if (options.signal?.aborted) controller.abort(); else options.signal?.addEventListener('abort', abort, { once: true });
    this.active.add(controller);
    const timeoutMs = Math.max(1000, Number(options.timeout) || this.config.timeoutMs);
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await this.fetch(this.config.apiUrl, {
        method: 'POST', signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.token}` },
        body: JSON.stringify({ datasource_id: mapping.datasourceId, database: mapping.database, schema: mapping.schema, sql: compileSql(sql, values), limit: 1000 }),
      });
      const raw = await response.text();
      if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new VoyageError(502, 'VOYAGE_RESPONSE_TOO_LARGE', 'Voyage 查询响应超过 8 MiB', false);
      if (response.status === 401 || response.status === 403) throw new VoyageError(401, 'VOYAGE_AUTH_FAILED', 'Voyage Token 已失效，请更新本地 .env', false);
      if (!response.ok) throw new VoyageError(502, 'VOYAGE_HTTP_ERROR', `Voyage 请求失败（HTTP ${response.status}）`, response.status >= 500);
      const payload = parseVoyageJson(raw);
      if (payload?.code !== 0 || !Array.isArray(payload?.data)) throw new VoyageError(502, 'VOYAGE_API_ERROR', String(payload?.message || 'Voyage 查询失败'), true);
      const rows = [];
      for (const statement of payload.data) {
        if (statement?.error) throw new VoyageError(502, 'VOYAGE_QUERY_FAILED', String(statement.error), false, { statement: statement.statement || '' });
        rows.push(...normalizeRows(statement));
      }
      return rows;
    } catch (error) {
      if (timedOut) throw new VoyageError(504, 'VOYAGE_TIMEOUT', `Voyage 查询超过 ${Math.round(timeoutMs / 1000)} 秒`, true);
      if (controller.signal.aborted) throw Object.assign(new Error('查询已取消'), { code: 'QUERY_CANCELLED' });
      if (error instanceof VoyageError) throw error;
      throw new VoyageError(502, 'VOYAGE_CONNECTION_FAILED', 'Voyage 在线数据库请求失败，请检查内网连接', true);
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener?.('abort', abort); this.active.delete(controller);
    }
  }
}

module.exports = { DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES, LOGICAL_DATABASES, VoyageError, VoyageManager, compileSql, preserveUnsafeIntegers, parseVoyageJson, normalizeRows, maskConfig };
