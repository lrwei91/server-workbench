'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const configDir = process.env.WORKBENCH_CONFIG_DIR || root;
const envPath = path.join(configDir, '.env');

// 内置默认值；本机连接信息只从 .env 读取。
const DEFAULTS = {
  ssh: { host: '', port: 22, username: '', password: '', timeoutMs: 15000, execTimeoutMs: 30000, execMaxTimeoutMs: 120000, execMaxOutputBytes: 2 * 1024 * 1024 },
  hdfsTimeoutMs: 90000,
  hbaseTimeoutMs: 120000,
  cdr: { upstream: 'http://127.0.0.1:8000' },
  logs: { dir: './logs' },
};

function parseEnv(text) {
  const result = {};
  for (const rawLine of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch (_) { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    result[match[1]] = value;
  }
  return result;
}

const fileEnv = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {};
const env = { ...fileEnv, ...process.env };
function envText(name, fallback = '') { return env[name] === undefined ? fallback : String(env[name]); }
function envNumber(name, fallback) { const value = Number(env[name]); return Number.isFinite(value) && value > 0 ? value : fallback; }

function normalize(raw) {
  const value = { ...raw };
  const ssh = value.ssh || {};
  const redisArchive = value.redisArchive || {};
  const voyage = value.voyage || {};
  const bigdataClient = value.bigdataClient || {};
  const cdr = value.cdr || {};
  const logs = value.logs || {};
  return {
    ...value,
    ssh: {
      host: envText('SSH_HOST', typeof ssh.host === 'string' ? ssh.host : '').trim(),
      port: envNumber('SSH_PORT', Number(ssh.port) || 22),
      username: envText('SSH_USERNAME', typeof ssh.username === 'string' ? ssh.username : '').trim(),
      password: envText('SSH_PASSWORD', typeof ssh.password === 'string' ? ssh.password : ''),
      timeoutMs: Number(ssh.timeoutMs || value.sshTimeoutMs) || 15000,
      execTimeoutMs: Number(ssh.execTimeoutMs || value.execTimeoutMs) || 30000,
      execMaxTimeoutMs: Number(ssh.execMaxTimeoutMs || value.execMaxTimeoutMs) || 120000,
      execMaxOutputBytes: Number(ssh.execMaxOutputBytes || value.execMaxOutputBytes) || 2 * 1024 * 1024,
    },
    database: {
      udal: {
        host: envText('UDAL_HOST').trim(), port: envNumber('UDAL_PORT', 8901), username: envText('UDAL_USERNAME').trim(), password: envText('UDAL_PASSWORD'),
        databases: envText('UDAL_DATABASES', 'CRM3DB,CONFIGDB_CNOS_JF_TEST').split(',').map((item) => item.trim()).filter(Boolean),
      },
      doris: {
        host: envText('DORIS_HOST').trim(), port: envNumber('DORIS_PORT', 9030), username: envText('DORIS_USERNAME').trim(), password: envText('DORIS_PASSWORD'),
        database: envText('DORIS_DATABASE').trim(), databases: [null],
      },
      pg: {
        host: envText('PG_HOST').trim(), port: envNumber('PG_PORT', 5432), username: envText('PG_USERNAME').trim(), password: envText('PG_PASSWORD'),
        database: envText('PG_DATABASE').trim(), databases: [null],
      },
    },
    redisArchive: {
      host: envText('REDIS_ARCHIVE_HOST', redisArchive.host || '').trim(),
      port: envNumber('REDIS_ARCHIVE_PORT', Number(redisArchive.port) || 16379),
      db: Math.max(0, Number(envText('REDIS_ARCHIVE_DB', redisArchive.db ?? 0)) || 0),
      username: envText('REDIS_ARCHIVE_USERNAME', redisArchive.username || '').trim(),
      password: envText('REDIS_ARCHIVE_PASSWORD', redisArchive.password || ''),
      timeoutMs: envNumber('REDIS_ARCHIVE_TIMEOUT_MS', Number(redisArchive.timeoutMs) || 15000),
      maxDecodedBytes: envNumber('REDIS_ARCHIVE_MAX_DECODED_BYTES', Number(redisArchive.maxDecodedBytes) || 16 * 1024 * 1024),
    },
    voyage: {
      apiUrl: envText('VOYAGE_API_URL', voyage.apiUrl || 'http://134.155.157.3:30010/api/query/execute').trim(),
      token: envText('VOYAGE_TOKEN', voyage.token || ''),
      timeoutMs: envNumber('VOYAGE_TIMEOUT_MS', Number(voyage.timeoutMs) || 15000),
      mappings: {
        CRM3DB: {
          datasourceId: envNumber('VOYAGE_CRM_DATASOURCE_ID', Number(voyage.mappings?.CRM3DB?.datasourceId) || 5),
          database: envText('VOYAGE_CRM_DATABASE', voyage.mappings?.CRM3DB?.database || 'incf_db').trim(),
          schema: envText('VOYAGE_CRM_SCHEMA', voyage.mappings?.CRM3DB?.schema || 'bill_inmemory').trim(),
        },
        CONFIGDB_CNOS_JF_TEST: {
          datasourceId: envNumber('VOYAGE_CONFIG_DATASOURCE_ID', Number(voyage.mappings?.CONFIGDB_CNOS_JF_TEST?.datasourceId) || 5),
          database: envText('VOYAGE_CONFIG_DATABASE', voyage.mappings?.CONFIGDB_CNOS_JF_TEST?.database || 'incf_db').trim(),
          schema: envText('VOYAGE_CONFIG_SCHEMA', voyage.mappings?.CONFIGDB_CNOS_JF_TEST?.schema || 'bill_inmemory').trim(),
        },
      },
    },
    bigdataClient: {
      remoteHost: envText('BIGDATA_CLIENT_REMOTE_HOST', bigdataClient.remoteHost || '127.0.0.1').trim(),
      remotePort: envNumber('BIGDATA_CLIENT_REMOTE_PORT', Number(bigdataClient.remotePort) || 17880),
      token: envText('BIGDATA_CLIENT_TOKEN', bigdataClient.token || ''),
      defaultMode: envText('BIGDATA_CLIENT_DEFAULT_MODE', bigdataClient.defaultMode || 'ssh').trim().toLowerCase() === 'client' ? 'client' : 'ssh',
      timeoutMs: envNumber('BIGDATA_CLIENT_TIMEOUT_MS', Number(bigdataClient.timeoutMs) || 30000),
      listCacheMs: envNumber('BIGDATA_CLIENT_LIST_CACHE_MS', Number(bigdataClient.listCacheMs) || 30000),
    },
    cdr: { upstream: envText('CDR_UPSTREAM', cdr.upstream || `http://${cdr.host || '127.0.0.1'}:${Number(cdr.port) || 8000}`), sessionToken: envText('CDR_SESSION_TOKEN') },
    hdfsTimeoutMs: Number(value.hdfsTimeoutMs) || 90000,
    hbaseTimeoutMs: Number(value.hbaseTimeoutMs) || 120000,
    logs: {
      dir: process.env.WORKBENCH_DATA_DIR ? path.join(process.env.WORKBENCH_DATA_DIR, 'logs') : logs.dir || './logs',
    },
  };
}

const normalized = normalize(DEFAULTS);

function validate() {
  const errors = [];
  if (!normalized.ssh.host || !normalized.ssh.username) errors.push('缺少 SSH_HOST 或 SSH_USERNAME，请在项目根目录 .env 中填写');
  for (const [source, item] of Object.entries(normalized.database)) if (!item.host || !item.username) errors.push(`缺少 ${source.toUpperCase()}_HOST 或 ${source.toUpperCase()}_USERNAME，请在项目根目录 .env 中填写`);
  if (normalized.bigdataClient.defaultMode === 'client' && !normalized.bigdataClient.token) errors.push('BIGDATA_CLIENT_DEFAULT_MODE=client 时必须配置 BIGDATA_CLIENT_TOKEN');
  return errors;
}

function resolveLogDir() {
  const value = normalized.logs.dir;
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

module.exports = { ...normalized, isExample: !fs.existsSync(envPath), validate, resolveLogDir, root, envPath, exists: fs.existsSync(envPath), parseEnv };
