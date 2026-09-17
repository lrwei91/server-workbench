'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
const localPath = path.join(root, 'config.js');
const examplePath = path.join(root, 'config.example.js');
let loadedFrom = localPath;
let config;

// 只在本地配置不存在时回退到样例；样例依赖缺失或语法错误不能被静默吞掉。
if (fs.existsSync(localPath)) config = require(localPath);
else { loadedFrom = examplePath; config = require(examplePath); }

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
  const value = raw || {};
  const workbench = value.workbench || {};
  const ssh = value.ssh || {};
  const archive = value.archive || {};
  const voyage = value.voyage || {};
  const cdr = value.cdr || {};
  const logs = value.logs || {};
  return {
    ...value,
    workbench: { host: envText('WORKBENCH_HOST', workbench.host || '127.0.0.1'), port: envNumber('WORKBENCH_PORT', Number(workbench.port) || 17755) },
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
    },
    archive: {
      pageUrl: envText('ARCHIVE_PAGE_URL', archive.pageUrl || 'http://134.155.157.3:30006/inmemory-manager/inmemory-manager-frontend/dataop').trim(),
      apiUrl: envText('ARCHIVE_API_URL', archive.apiUrl || '').trim(),
      authToken: envText('ARCHIVE_AUTH_TOKEN', archive.authToken || ''),
      timeoutMs: envNumber('ARCHIVE_TIMEOUT_MS', Number(archive.timeoutMs) || 60000),
    },
    voyage: {
      apiUrl: envText('VOYAGE_API_URL', voyage.apiUrl || 'http://134.155.157.3:30010/api/query/execute').trim(),
      token: envText('VOYAGE_TOKEN', voyage.token || ''),
      timeoutMs: envNumber('VOYAGE_TIMEOUT_MS', Number(voyage.timeoutMs) || 15000),
      mappings: {
        CRM3DB: {
          datasourceId: envNumber('VOYAGE_CRM_DATASOURCE_ID', Number(voyage.mappings?.CRM3DB?.datasourceId) || 5),
          database: envText('VOYAGE_CRM_DATABASE', voyage.mappings?.CRM3DB?.database || 'incf_db').trim(),
          schema: envText('VOYAGE_CRM_SCHEMA', voyage.mappings?.CRM3DB?.schema || 'crmv3').trim(),
        },
        CONFIGDB_CNOS_JF_TEST: {
          datasourceId: envNumber('VOYAGE_CONFIG_DATASOURCE_ID', Number(voyage.mappings?.CONFIGDB_CNOS_JF_TEST?.datasourceId) || 5),
          database: envText('VOYAGE_CONFIG_DATABASE', voyage.mappings?.CONFIGDB_CNOS_JF_TEST?.database || 'incf_db').trim(),
          schema: envText('VOYAGE_CONFIG_SCHEMA', voyage.mappings?.CONFIGDB_CNOS_JF_TEST?.schema || 'crmv3').trim(),
        },
      },
    },
    cdr: { upstream: envText('CDR_UPSTREAM', cdr.upstream || `http://${cdr.host || '127.0.0.1'}:${Number(cdr.port) || 8000}`) },
    hdfsTimeoutMs: Number(value.hdfsTimeoutMs) || 90000,
    hbaseTimeoutMs: Number(value.hbaseTimeoutMs) || 120000,
    logs: {
      dir: logs.dir || './logs',
      maxDays: Number(logs.maxDays) || 30,
      maxEntries: Number(logs.maxEntries) || 10000,
    },
  };
}

const normalized = normalize(config);
const isExample = path.resolve(loadedFrom) === path.resolve(examplePath);

function validate() {
  const errors = [];
  if (!normalized.ssh.host || !normalized.ssh.username) errors.push('缺少 SSH_HOST 或 SSH_USERNAME，请在项目根目录 .env 中填写');
  for (const [source, item] of Object.entries(normalized.database)) if (!item.host || !item.username) errors.push(`缺少 ${source.toUpperCase()}_HOST 或 ${source.toUpperCase()}_USERNAME，请在项目根目录 .env 中填写`);
  if (!Number.isInteger(normalized.workbench.port) || normalized.workbench.port < 1 || normalized.workbench.port > 65535) errors.push('workbench.port 必须是 1-65535 的整数');
  return errors;
}

function resolveLogDir() {
  const value = normalized.logs.dir;
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

module.exports = { ...normalized, loadedFrom: fs.existsSync(envPath) ? envPath : loadedFrom, isExample: !fs.existsSync(envPath), validate, resolveLogDir, root, envPath, exists: fs.existsSync(envPath), parseEnv };
