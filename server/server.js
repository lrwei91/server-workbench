/** Local HTTP bridge for the PC workbench. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');

const config = require('./config-loader');
const ssh = require('./ssh');
const sftp = require('./sftp');
const hdfs = require('./hdfs');
const hbase = require('./hbase');
const proxy = require('./proxy');
const log = require('./log');
const { manager: database } = require('./database');
const phoneQuery = require('./phone-query');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const MAX_BODY_BYTES = 1024 * 1024;

class RequestError extends Error {
  constructor(status, code, message, retryable = false, details = null) { super(message); this.status = status; this.code = code; this.retryable = retryable; this.details = details; }
}
function errorBody(error) { return { ok: false, error: { code: error.code || 'INTERNAL_ERROR', message: error.message || '服务器内部错误', retryable: Boolean(error.retryable), ...(error.details ? { details: error.details } : {}) } }; }
function sendJson(res, status, body) {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}
function asRequestError(error) {
  if (error instanceof RequestError) return error;
  const raw = String(error?.message || error || '');
  if (/未安装 ssh2/i.test(raw)) return new RequestError(503, 'DEPENDENCY_MISSING', 'Node 依赖 ssh2 未安装，请先运行 npm install', false);
  if (/缺少主机|缺少.*用户名|连接配置/i.test(raw)) return new RequestError(400, 'INVALID_CONNECTION_CONFIG', '请填写有效的 SSH 主机、端口和用户名');
  if (/连接请求已过期/i.test(raw)) return new RequestError(409, 'STALE_CONNECTION_REQUEST', '连接请求已过期，请重试', true);
  if (/认证失败/i.test(raw)) return new RequestError(401, 'AUTH_FAILED', 'SSH 认证失败，请检查用户名和密码', false);
  if (/已拦截|交互式终端/i.test(raw)) return new RequestError(403, 'COMMAND_BLOCKED', raw, false);
  if (/MySQL \/ UDAL 尚未连接|Doris 尚未连接/i.test(raw)) return new RequestError(409, 'DB_NOT_CONNECTED', raw, false);
  if (/尚未连接|NOT_CONNECTED/i.test(raw)) return new RequestError(409, 'NOT_CONNECTED', '尚未连接服务器，请先点击连接');
  if (/连接超时|超时：/i.test(raw)) return new RequestError(504, 'REMOTE_TIMEOUT', raw, true);
  if (/连接被拒绝|网络不可达|无法解析主机/i.test(raw)) return new RequestError(502, 'REMOTE_CONNECTION', raw, true);
  if (/^HDFS .*超时/i.test(raw)) return new RequestError(504, 'HDFS_TIMEOUT', raw, true);
  if (/timeout|timed? out|超时/i.test(raw)) return new RequestError(504, 'REMOTE_TIMEOUT', '远端服务响应超时，请稍后重试', true);
  if (/^HDFS 目标已存在同名文件：/i.test(raw)) return new RequestError(409, 'HDFS_TARGET_EXISTS', raw, false);
  if (/^HDFS 上不存在该路径：|^本地文件不存在或 HDFS 目标目录不存在：/i.test(raw)) return new RequestError(404, 'HDFS_PATH_NOT_FOUND', raw, false);
  if (/^HDFS (?:上传|列目录)失败：/i.test(raw)) return new RequestError(502, 'HDFS_OPERATION_FAILED', raw, true);
  if (/数据源必须是|数据库地址、端口和账号|手机号或接入号码|客户 ID|产品实例 ID/i.test(raw)) return new RequestError(400, 'INVALID_INPUT', raw, false);
  if (/查询已取消/i.test(raw)) return new RequestError(499, 'QUERY_CANCELLED', '查询已取消', false);
  if (/Access denied|ER_ACCESS_DENIED_ERROR/i.test(raw)) return new RequestError(401, 'DB_AUTH_FAILED', '数据库认证失败，请检查账号和密码', false);
  if (/ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|getaddrinfo|connect ETIMEDOUT/i.test(raw)) return new RequestError(502, 'DB_CONNECTION_FAILED', '数据库连接失败，请检查地址、端口和网络', true);
  if (/^(?:HBase .+包含不支持的字符|HBase 路径格式|扫描表路径格式)/i.test(raw)) return new RequestError(400, 'HBASE_INVALID_PATH', raw, false);
  if (/SFTP|SSH|hadoop|hbase|ECONN|EHOST|ENET|channel/i.test(raw)) return new RequestError(502, 'REMOTE_ERROR', '远端服务请求失败，请检查连接后重试', true);
  return new RequestError(500, 'INTERNAL_ERROR', '服务器内部错误，请稍后重试', true);
}
function sendError(res, error) { const normalized = asRequestError(error); sendJson(res, normalized.status, errorBody(normalized)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    const length = Number(req.headers['content-length'] || 0);
    if (length > MAX_BODY_BYTES) return reject(new RequestError(413, 'BODY_TOO_LARGE', '请求体不能超过 1 MiB'));
    let raw = '';
    let bytes = 0;
    let rejected = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (rejected) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) { rejected = true; req.resume(); reject(new RequestError(413, 'BODY_TOO_LARGE', '请求体不能超过 1 MiB')); return; }
      raw += chunk;
    });
    req.on('error', (error) => { if (!rejected) { rejected = true; reject(error); } });
    req.on('end', () => {
      if (rejected) return;
      try { if (!raw.trim()) return resolve({}); const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); resolve(value); }
      catch (_) { rejected = true; reject(new RequestError(400, 'INVALID_JSON', '请求体必须是合法 JSON 对象')); }
    });
  });
}
function assertObject(body, fields = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'INVALID_BODY', '请求体必须是对象');
  const unknown = Object.keys(body).filter((key) => !fields.includes(key));
  if (unknown.length) throw new RequestError(400, 'UNKNOWN_FIELD', `不支持的字段：${unknown.join(', ')}`);
}
// 读取原始二进制请求体（用于本地文件上传），按字节上限保护内存
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const limit = Number(maxBytes) || 1024 * 1024;
    const length = Number(req.headers['content-length'] || 0);
    if (length > limit) return reject(new RequestError(413, 'BODY_TOO_LARGE', `上传文件不能超过 ${Math.round(limit / 1024 / 1024)} MiB`));
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) { req.resume(); return reject(new RequestError(413, 'BODY_TOO_LARGE', `上传文件不能超过 ${Math.round(limit / 1024 / 1024)} MiB`)); }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
function requireString(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new RequestError(400, 'INVALID_INPUT', `${name} 必须是非空字符串`);
  return value.trim();
}
function requireDate(value, name = 'date') {
  const date = requireString(value, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RequestError(400, 'INVALID_DATE', `${name} 必须是 YYYY-MM-DD`);
  return date;
}
function requireConnected() { if (!ssh.conn) throw new RequestError(409, 'NOT_CONNECTED', '尚未连接服务器，请先点击连接'); }
async function runQueryRequest(req, res, work) {
  const controller = new AbortController(); let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
  const abort = () => controller.abort(); const close = () => { if (!res.writableEnded) controller.abort(); };
  req.once('aborted', abort); res.once('close', close);
  try { return await work(controller.signal); }
  catch (error) { if (timedOut) throw new RequestError(504, 'DB_QUERY_TIMEOUT', '数据库聚合查询超过 60 秒', true); throw error; }
  finally { clearTimeout(timer); req.off('aborted', abort); res.off('close', close); }
}
function safeRemotePath(value) {
  const target = ssh.expandTilde(requireString(value, 'path'));
  const normalized = path.posix.normalize(target);
  if (!target || normalized === '/' || normalized === '.') throw new RequestError(400, 'ROOT_PATH_PROTECTED', '根路径不允许执行该操作');
  return target;
}
function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'application/javascript; charset=utf-8';
  return 'application/octet-stream';
}
async function staticFile(res, base, relative) {
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return sendJson(res, 403, errorBody(new RequestError(403, 'FORBIDDEN', '资源路径不合法')));
  let file;
  try {
    file = await fs.promises.open(resolved, 'r');
    if (!(await file.stat()).isFile()) {
      await file.close();
      return sendJson(res, 404, errorBody(new RequestError(404, 'NOT_FOUND', '资源不存在')));
    }
  } catch (error) {
    if (file) await file.close();
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR') return sendJson(res, 404, errorBody(new RequestError(404, 'NOT_FOUND', '资源不存在')));
    throw error;
  }
  res.writeHead(200, { 'Content-Type': contentType(resolved), 'Cache-Control': 'no-cache' });
  pipeline(file.createReadStream(), res, () => {});
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return staticFile(res, PUBLIC_DIR, 'index.html');
  if (req.method === 'GET' && (p === '/style.css' || p === '/app.js')) return staticFile(res, PUBLIC_DIR, p.slice(1));
  if (req.method === 'GET' && p.startsWith('/js/')) return staticFile(res, path.join(PUBLIC_DIR, 'js'), p.slice(4));
  if (req.method === 'GET' && p.startsWith('/shared/')) return staticFile(res, SHARED_DIR, p.slice(8));
  if (p === '/cdr' || p === '/cdr/' || p.startsWith('/cdr/')) return proxy.proxyToCdr(req, res, p === '/cdr' || p === '/cdr/' ? '/' : p.slice(4));

  if (req.method === 'POST' && p === '/api/log/append') {
    const body = await readBody(req); assertObject(body, ['t', 'cmd', 'badge', 'out', 'date']);
    requireString(body.cmd, 'cmd');
    for (const field of ['t', 'badge', 'out']) if (body[field] !== undefined && typeof body[field] !== 'string') throw new RequestError(400, 'INVALID_INPUT', `${field} 必须是字符串`);
    if (body.date !== undefined) requireDate(body.date);
    await log.append(body, body.date);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'GET' && p === '/api/log/list') {
    const rawDate = url.searchParams.get('date');
    const date = rawDate ? requireDate(rawDate) : log.today();
    const limit = Number(url.searchParams.get('limit') || 200);
    const offset = Number(url.searchParams.get('offset') || 0);
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) throw new RequestError(400, 'INVALID_INPUT', '日志分页参数必须是合法整数');
    const result = await log.list(date, { limit, offset });
    return sendJson(res, 200, { ok: true, date, ...result });
  }
  if (req.method === 'GET' && p === '/api/log/dates') return sendJson(res, 200, { ok: true, dates: await log.dates() });
  if (req.method === 'GET' && p === '/api/config') {
    const hdfsTimeoutMs = Math.max(1000, Number(config.hdfsTimeoutMs) || 90000);
    const hbaseTimeoutMs = Math.max(1000, Number(config.hbaseTimeoutMs) || 120000);
    return sendJson(res, 200, {
      ok: true,
      config: ssh.maskConfig(ssh.DEFAULT_CONFIG),
      connections: { ssh: ssh.maskConfig(ssh.DEFAULT_CONFIG), ...database.defaults() },
      configured: !config.isExample,
      errors: config.validate(),
      timeouts: { hdfsListMs: hdfsTimeoutMs * 2 + 10000, hbaseScanMs: hbaseTimeoutMs + 10000 },
    });
  }
  if (req.method === 'GET' && p === '/api/status') return sendJson(res, 200, { ok: true, connected: Boolean(ssh.conn), conn: ssh.connInfo ? ssh.maskConfig(ssh.connInfo) : null, home: ssh.home || null });
  if (req.method === 'GET' && p === '/api/db/status') return sendJson(res, 200, { ok: true, sources: database.status(), defaults: database.defaults() });
  if (req.method === 'POST' && p === '/api/connections/connect') {
    const body = await readBody(req); assertObject(body, []);
    const attempts = await Promise.allSettled([
      ssh.connect(),
      database.connect('udal'),
      database.connect('doris'),
    ]);
    let home = '~';
    if (attempts[0].status === 'fulfilled') {
      try { const result = await ssh.execCommand('echo $HOME'); home = result.stdout?.trim().split('\n').pop() || '~'; } catch (_) {}
      void hdfs.warmupHdfs();
    }
    const safeFailure = (attempt) => attempt.status === 'rejected' ? asRequestError(attempt.reason).message : '';
    const sources = {
      ssh: { connected: attempts[0].status === 'fulfilled', config: attempts[0].status === 'fulfilled' ? attempts[0].value : ssh.maskConfig(ssh.DEFAULT_CONFIG), home, error: safeFailure(attempts[0]) },
      udal: { connected: attempts[1].status === 'fulfilled', config: attempts[1].status === 'fulfilled' ? attempts[1].value : database.defaults().udal, error: safeFailure(attempts[1]) },
      doris: { connected: attempts[2].status === 'fulfilled', config: attempts[2].status === 'fulfilled' ? attempts[2].value : database.defaults().doris, error: safeFailure(attempts[2]) },
    };
    const connectedCount = Object.values(sources).filter((item) => item.connected).length;
    return sendJson(res, 200, { ok: true, status: connectedCount === 3 ? 'complete' : connectedCount ? 'partial' : 'failed', sources });
  }
  if (req.method === 'POST' && p === '/api/db/connect') {
    const body = await readBody(req); assertObject(body, ['source', 'host', 'port', 'username', 'password', 'database']);
    const source = requireString(body.source, 'source');
    for (const field of ['host', 'username', 'password', 'database']) if (body[field] !== undefined && typeof body[field] !== 'string') throw new RequestError(400, 'INVALID_INPUT', `${field} 必须是字符串`);
    if (body.port !== undefined && (!Number.isInteger(Number(body.port)) || Number(body.port) < 1 || Number(body.port) > 65535)) throw new RequestError(400, 'INVALID_INPUT', 'port 必须是 1-65535 的整数');
    const connected = await database.connect(source, body); return sendJson(res, 200, { ok: true, source: source.toLowerCase(), config: connected });
  }
  if (req.method === 'POST' && p === '/api/db/disconnect') {
    const body = await readBody(req); assertObject(body, ['source']); const source = requireString(body.source, 'source'); await database.disconnect(source); return sendJson(res, 200, { ok: true, source: source.toLowerCase() });
  }
  if (req.method === 'POST' && p === '/api/query/phone') {
    const body = await readBody(req); assertObject(body, ['phone']);
    const result = await runQueryRequest(req, res, (signal) => phoneQuery.queryPhone(database, requireString(body.phone, 'phone'), { signal })); return sendJson(res, 200, { ok: true, result });
  }
  if (req.method === 'POST' && p === '/api/query/threshold') {
    const body = await readBody(req); assertObject(body, ['aProductInstanceId']);
    const result = await runQueryRequest(req, res, (signal) => phoneQuery.queryThreshold(database, requireString(body.aProductInstanceId, 'aProductInstanceId'), { signal })); return sendJson(res, 200, { ok: true, result });
  }
  if (req.method === 'POST' && p === '/api/query/customer-products') {
    const body = await readBody(req); assertObject(body, ['customerId']);
    const result = await runQueryRequest(req, res, (signal) => phoneQuery.queryCustomerProducts(database, body.customerId, { signal })); return sendJson(res, 200, { ok: true, result });
  }
  if (req.method === 'POST' && p === '/api/query/account-candidates') {
    const body = await readBody(req); assertObject(body, ['productInstanceId', 'customerId']);
    const result = await runQueryRequest(req, res, (signal) => phoneQuery.queryAccountCandidates(database, body, { signal })); return sendJson(res, 200, { ok: true, result });
  }
  if (req.method === 'POST' && p === '/api/connect') {
    const body = await readBody(req); assertObject(body, ['host', 'port', 'username', 'password']);
    if (body.host !== undefined && typeof body.host !== 'string') throw new RequestError(400, 'INVALID_INPUT', 'host 必须是字符串');
    if (body.port !== undefined && (!Number.isInteger(Number(body.port)) || Number(body.port) < 1 || Number(body.port) > 65535)) throw new RequestError(400, 'INVALID_INPUT', 'port 必须是 1-65535 的整数');
    if (body.username !== undefined && typeof body.username !== 'string') throw new RequestError(400, 'INVALID_INPUT', 'username 必须是字符串');
    if (body.password !== undefined && typeof body.password !== 'string') throw new RequestError(400, 'INVALID_INPUT', 'password 必须是字符串');
    const cfg = await ssh.connect(body);
    let home = '~';
    try { const result = await ssh.execCommand('echo $HOME'); home = result.stdout?.trim().split('\n').pop() || '~'; } catch (_) {}
    void hdfs.warmupHdfs();
    return sendJson(res, 200, { ok: true, config: cfg, home });
  }
  if (req.method === 'POST' && p === '/api/disconnect') { ssh.disconnect(); return sendJson(res, 200, { ok: true }); }
  if (req.method === 'POST' && p === '/api/exec') {
    const body = await readBody(req); assertObject(body, ['cmd', 'timeout', 'confirmed']);
    const cmd = requireString(body.cmd, 'cmd');
    if (ssh.isDangerousCommand(cmd) && body.confirmed !== true) throw new RequestError(409, 'CONFIRMATION_REQUIRED', '删除类命令需要确认', false, { command: cmd });
    requireConnected();
    const result = await ssh.execCommand(cmd, body.timeout);
    return sendJson(res, 200, { ok: true, ...result });
  }
  if (req.method === 'POST' && p === '/api/sftp/list') {
    const body = await readBody(req); assertObject(body, ['path']); requireConnected(); if (body.path !== undefined && typeof body.path !== 'string') throw new RequestError(400, 'INVALID_INPUT', 'path 必须是字符串');
    const target = ssh.expandTilde(body.path || '~'); const abs = await sftp.sftpRealpath(target); const items = await sftp.sftpList(abs);
    return sendJson(res, 200, { ok: true, path: abs, items });
  }
  if (req.method === 'POST' && p === '/api/sftp/preview') {
    const body = await readBody(req); assertObject(body, ['path', 'maxBytes']); requireConnected();
    const target = safeRemotePath(body.path); const result = await sftp.sftpPreview(target, body.maxBytes);
    return sendJson(res, 200, { ok: true, path: target, ...result });
  }
  if (req.method === 'POST' && p === '/api/sftp/mkdir') {
    const body = await readBody(req); assertObject(body, ['path']); requireConnected(); const target = safeRemotePath(body.path); await sftp.sftpMkdir(target); return sendJson(res, 201, { ok: true, path: target });
  }
  if (req.method === 'POST' && p === '/api/sftp/touch') {
    const body = await readBody(req); assertObject(body, ['path']); requireConnected(); const target = safeRemotePath(body.path); await sftp.sftpTouch(target); return sendJson(res, 201, { ok: true, path: target });
  }
  if (req.method === 'POST' && p === '/api/sftp/delete') {
    const body = await readBody(req); assertObject(body, ['path', 'kind', 'confirmed']); requireConnected();
    const kind = body.kind === 'dir' ? 'dir' : body.kind === 'file' ? 'file' : null;
    if (!kind) throw new RequestError(400, 'INVALID_INPUT', 'kind 必须是 file 或 dir');
    if (body.confirmed !== true) throw new RequestError(409, 'CONFIRMATION_REQUIRED', '删除操作需要确认');
    const target = safeRemotePath(body.path); await sftp.sftpDelete(target, kind); return sendJson(res, 200, { ok: true, path: target, kind });
  }
  if (req.method === 'POST' && p === '/api/sftp/upload') {
    requireConnected();
    const dir = ssh.expandTilde(requireString(req.headers['x-target-dir'], 'x-target-dir'));
    const fileName = decodeURIComponent(requireString(req.headers['x-file-name'], 'x-file-name'));
    if (/[\\/]/.test(fileName)) throw new RequestError(400, 'INVALID_INPUT', '文件名不能包含路径分隔符');
    const buffer = await readRawBody(req, config.uploadMaxBytes || 50 * 1024 * 1024);
    if (!buffer.length) throw new RequestError(400, 'EMPTY_FILE', '不能上传空文件');
    const result = await sftp.sftpUpload(dir, fileName, buffer); return sendJson(res, 200, { ok: true, ...result });
  }
  if (req.method === 'GET' && p === '/api/sftp/download') {
    requireConnected(); const filePath = ssh.expandTilde(requireString(url.searchParams.get('path'), 'path')); const fileName = filePath.split('/').filter(Boolean).pop() || 'download.bin';
    return sftp.withSftp(async (channel) => {
      const stat = await new Promise((resolve, reject) => channel.stat(filePath, (err, value) => err ? reject(err) : resolve(value)));
      if (!stat.isFile()) throw new RequestError(400, 'NOT_A_FILE', '该路径不是普通文件');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}` });
      await new Promise((resolve, reject) => { const stream = channel.createReadStream(filePath); stream.on('error', reject); stream.on('end', resolve); stream.pipe(res); });
    });
  }
  if (req.method === 'POST' && p === '/api/hdfs/list') {
    const body = await readBody(req); assertObject(body, ['path']); requireConnected(); const target = String(body.path || '/').trim() || '/'; if (!target.startsWith('/')) throw new RequestError(400, 'INVALID_INPUT', 'HDFS 路径必须以 / 开头'); const items = await hdfs.hdfsList(target); return sendJson(res, 200, { ok: true, path: target, items });
  }
  if (req.method === 'POST' && p === '/api/hdfs/preview') {
    const body = await readBody(req); assertObject(body, ['path', 'maxBytes']); requireConnected(); const target = requireString(body.path, 'path');
    const result = await hdfs.hdfsPreview(target, body.maxBytes); return sendJson(res, 200, { ok: true, path: target, ...result });
  }
  if (req.method === 'POST' && p === '/api/hdfs/upload') {
    const body = await readBody(req); assertObject(body, ['localPath', 'hdfsDir']); requireConnected();
    const localPath = ssh.expandTilde(requireString(body.localPath, 'localPath'));
    const hdfsDir = requireString(body.hdfsDir, 'hdfsDir'); if (!hdfsDir.startsWith('/')) throw new RequestError(400, 'INVALID_INPUT', 'HDFS 目标目录必须以 / 开头');
    const result = await hdfs.hdfsUpload(localPath, hdfsDir); return sendJson(res, 200, { ok: true, ...result });
  }
  if (req.method === 'GET' && p === '/api/hdfs/download') {
    requireConnected(); const hpath = String(url.searchParams.get('path') || '').trim(); if (!hpath.startsWith('/')) throw new RequestError(400, 'INVALID_INPUT', '缺少合法的 HDFS 路径'); const fileName = hpath.split('/').filter(Boolean).pop() || 'download.bin';
    return new Promise((resolve) => ssh.conn.exec('hadoop fs -cat ' + hdfs.shellQuote(hpath), (err, stream) => {
      if (err) { sendError(res, new RequestError(502, 'HDFS_EXEC_FAILED', err.message, true)); return resolve(); }
      let stderr = ''; stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8').slice(0, 8192); }); let sent = false;
      stream.on('data', (chunk) => { if (!sent) { sent = true; res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}` }); } res.write(chunk); });
      stream.on('close', (code) => { if (!sent) sendError(res, new RequestError(/is a directory/i.test(stderr) ? 400 : 404, 'HDFS_DOWNLOAD_FAILED', stderr.trim() || `下载失败（退出码 ${code}）`, true)); else res.end(); resolve(); });
    }));
  }
  if (req.method === 'POST' && p === '/api/hbase/list') {
    const body = await readBody(req); assertObject(body, ['path']); requireConnected(); const target = String(body.path || '/').trim() || '/';
    const result = await hbase.hbaseList(target); return sendJson(res, 200, { ok: true, path: result.path, items: result.items });
  }
  if (req.method === 'POST' && p === '/api/hbase/scan') {
    const body = await readBody(req); assertObject(body, ['path', 'limit']); requireConnected(); const target = requireString(body.path, 'path');
    const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 200); const result = await hbase.hbaseScan(target, limit); return sendJson(res, 200, { ok: true, ...result });
  }
  return sendError(res, new RequestError(404, 'NOT_FOUND', `接口不存在: ${p}`));
}

function createServer() { return http.createServer((req, res) => { handle(req, res).catch((error) => sendError(res, error)); }); }
const server = createServer();
if (require.main === module) {
  const errors = config.validate();
  if (errors.length) console.warn('[配置提示]', errors.join('；'));
  server.listen(config.workbench.port, config.workbench.host, () => console.log(`远程服务器管理工作台已启动: http://${config.workbench.host}:${config.workbench.port}`));
  server.on('error', (error) => { console.error('[服务错误]', error); process.exitCode = 1; });
  const shutdown = () => { void database.closeAll().finally(() => server.close(() => process.exit(0))); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
module.exports = { createServer, handle, RequestError, asRequestError, MAX_BODY_BYTES };
