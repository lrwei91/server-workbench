'use strict';

const RANGES = new Set([15, 60, 180, 360, 1440]);
const LIMITS = new Set([100, 500, 1000]);
const LEVELS = new Set(['DEBUG', 'INFO', 'WARN', 'ERROR']);
const FIELDS = ['time', 'body', 'level', 'service_instance_id', 'scope_name', 'trace_id', 'span_id'];
const SERVICE_LIMIT = 1000;
const validService = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });

function rotatedCookie(cookie, headers) {
  const rotated = headers.getSetCookie?.().map(value => value.split(';', 1)[0])
    .find(value => /^grafana_session=[^;\s]+$/.test(value));
  return rotated ? cookie.replace(/(^|;\s*)grafana_session=[^;]*/, (_entry, prefix) => prefix + rotated) : cookie;
}

function makeQuery({ service, minutes, limit, level = '' }, config, now = Date.now()) {
  if (!validService(service) ||
      !RANGES.has(minutes) || !LIMITS.has(limit) || (level !== '' && !LEVELS.has(level))) {
    throw failure(400, 'GRAFANA_INVALID_FILTER', '请检查服务名、时间范围、级别和条数。');
  }
  // 复现仪表板的时间宏与 UTC 转换。SQL 结构固定，只允许上方校验过的过滤值。
  const rawSql = `SELECT time, body, level, service_instance_id, scope_name, trace_id, span_id
FROM (
  SELECT DATE_SUB(timestamp, INTERVAL 8 HOUR) AS time, body, severity_text AS level,
         service_instance_id, scope_name, trace_id, span_id
  FROM oteldb.otel_logs
  WHERE $__timeFilter(timestamp)
    AND service_name = '${service}'${level ? `\n    AND severity_text = '${level}'` : ''}
  ORDER BY timestamp DESC
  LIMIT ${limit}
) AS t ORDER BY time ASC`;
  return queryBody(rawSql, config, minutes, limit, now);
}

function queryBody(rawSql, { datasourceUid, datasourceId }, minutes, limit, now = Date.now()) {
  return {
    from: String(now - minutes * 60000), to: String(now),
    queries: [{ refId: 'A', datasource: { type: 'mysql', uid: datasourceUid }, datasourceId,
      rawSql, format: 'table', intervalMs: 60000, maxDataPoints: limit }],
  };
}

function readFrames(result, limit, fieldNames = FIELDS) {
  if (!Array.isArray(result?.frames)) throw failure(502, 'GRAFANA_BAD_RESPONSE', 'Grafana 日志结果格式异常。');
  const rows = [];
  for (const frame of result.frames) {
    const fields = frame?.schema?.fields;
    const columns = frame?.data?.values;
    if (!Array.isArray(fields) || !Array.isArray(columns) || fields.length !== columns.length) {
      throw failure(502, 'GRAFANA_BAD_RESPONSE', 'Grafana 日志列结构异常。');
    }
    const indices = fieldNames.map(name => fields.findIndex(field => field?.name === name));
    const size = columns[indices[0]]?.length;
    if (indices.some(index => !Array.isArray(columns[index]) || columns[index].length !== size) || rows.length + size > limit) {
      throw failure(502, 'GRAFANA_BAD_RESPONSE', 'Grafana 日志字段或条数异常。');
    }
    for (let i = 0; i < size; i++) rows.push(Object.fromEntries(fieldNames.map((name, field) => [name, columns[indices[field]][i]])));
  }
  return rows;
}

class GrafanaLogs {
  #cookie = '';
  constructor(config, { fetchImpl = fetch } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    try {
      const url = new URL(config.baseUrl);
      if (/^https?:$/.test(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) this.origin = url.origin;
    } catch (_) {}
  }
  status() {
    return { configured: Boolean(this.origin && this.config.datasourceUid && Number.isSafeInteger(this.config.datasourceId)), connected: Boolean(this.#cookie) };
  }
  assertConfigured() {
    if (!this.status().configured) throw failure(503, 'GRAFANA_UNCONFIGURED', '请在本机 .env 配置 Grafana 地址和数据源。');
  }
  loginStatus() {
    return { ...this.status(), baseUrl: this.origin || '' };
  }
  async request(path, cookie, { body, signal } = {}) {
    const headers = { Accept: 'application/json', Cookie: cookie, 'X-Grafana-Org-Id': String(this.config.orgId) };
    if (body) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await this.fetchImpl(this.origin + path, { method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body), redirect: 'manual', signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw failure(502, 'GRAFANA_UNREACHABLE', '连接 Grafana 失败，请检查内网连接。');
    }
    if (response.status === 401 || (response.status >= 300 && response.status < 400)) {
      throw failure(401, 'GRAFANA_LOGIN_REQUIRED', 'Grafana 会话已失效，请登录后重试。');
    }
    if (response.status === 403) throw failure(403, 'GRAFANA_FORBIDDEN', '当前 Grafana 账号没有查询权限。');
    if (!response.ok) throw failure(502, 'GRAFANA_REQUEST_FAILED', `Grafana 请求失败（HTTP ${response.status}）。`);
    const data = await response.json().catch(() => { throw failure(502, 'GRAFANA_BAD_RESPONSE', 'Grafana 返回的不是有效 JSON。'); });
    return { data, cookie: rotatedCookie(cookie, response.headers) };
  }
  async connect(cookie, { signal } = {}) {
    this.assertConfigured();
    if (typeof cookie !== 'string' || !cookie || cookie.length > 16384 || /[\r\n]/.test(cookie)) {
      throw failure(400, 'GRAFANA_INVALID_SESSION', 'Grafana 登录会话格式无效。');
    }
    const { data: user, cookie: verifiedCookie } = await this.request('/api/user', cookie, { signal });
    if (!Number.isSafeInteger(user?.id) || user.id < 1) throw failure(401, 'GRAFANA_LOGIN_REQUIRED', '请先完成 Grafana 登录。');
    signal?.throwIfAborted();
    this.#cookie = verifiedCookie;
    return this.status();
  }
  async #runQuery(body, signal) {
    this.assertConfigured();
    const cookie = this.#cookie;
    if (!cookie) throw failure(401, 'GRAFANA_LOGIN_REQUIRED', '请先登录 Grafana。');
    try {
      const { data: response, cookie: updatedCookie } = await this.request('/api/ds/query?ds_type=mysql', cookie, { body, signal });
      if (this.#cookie === cookie) this.#cookie = updatedCookie;
      const result = response?.results?.A;
      if (result?.status === 403) throw failure(403, 'GRAFANA_FORBIDDEN', '当前 Grafana 账号没有数据源查询权限。');
      if (result?.error || (result?.status != null && result.status !== 200)) throw failure(502, 'GRAFANA_QUERY_FAILED', 'Grafana 数据源查询失败，请在原仪表板核对数据源和查询状态。');
      return result;
    } catch (error) {
      if (error.code === 'GRAFANA_LOGIN_REQUIRED' && this.#cookie === cookie) this.#cookie = '';
      throw error;
    }
  }
  async query(filters, { signal } = {}) {
    const result = await this.#runQuery(makeQuery(filters, this.config), signal);
    return readFrames(result, filters.limit);
  }
  async listServices(minutes, { signal } = {}) {
    if (!RANGES.has(minutes)) throw failure(400, 'GRAFANA_INVALID_FILTER', '请检查时间范围。');
    const limit = SERVICE_LIMIT + 1;
    const rawSql = `SELECT service_name
FROM oteldb.otel_logs
WHERE $__timeFilter(timestamp)
  AND service_name IS NOT NULL AND service_name <> ''
GROUP BY service_name
ORDER BY MAX(timestamp) DESC
LIMIT ${limit}`;
    const result = await this.#runQuery(queryBody(rawSql, this.config, minutes, limit), signal);
    const rows = readFrames(result, limit, ['service_name']);
    const names = new Set(rows.map(row => row.service_name).filter(validService));
    return { services: [...names].slice(0, SERVICE_LIMIT), truncated: rows.length > SERVICE_LIMIT };
  }
}

module.exports = { GrafanaLogs, makeQuery };
