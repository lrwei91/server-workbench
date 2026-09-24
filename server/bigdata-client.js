/** HDFS/HBase 常驻客户端服务适配器：通过现有 SSH 会话创建逐请求加密通道。 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const config = require('./config-loader');
const ssh = require('./ssh');

class BigdataClientError extends Error {
  constructor(message, { status = 502, code = 'BIGDATA_CLIENT_ERROR', retryable = true } = {}) {
    super(message); this.status = status; this.code = code; this.retryable = retryable;
  }
}

function requestId() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function formBody(values = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null) params.set(key, String(value));
  return params.toString();
}

class BigdataClientManager {
  constructor(options = {}) {
    this.config = { ...config.bigdataClient, ...(options.config || {}) };
    this.ssh = options.ssh || ssh;
    this.mode = this.config.defaultMode === 'client' ? 'client' : 'ssh';
    this.connected = false;
    this.inflight = new Map();
  }

  defaults() {
    return {
      remoteHost: this.config.remoteHost,
      remotePort: Number(this.config.remotePort),
      timeoutMs: Number(this.config.timeoutMs),
      listCacheMs: Number(this.config.listCacheMs),
      defaultMode: this.config.defaultMode,
      configured: Boolean(this.config.remoteHost && this.config.remotePort && this.config.token),
      hasToken: Boolean(this.config.token),
    };
  }

  status() { if (!this.ssh.conn) this.connected = false; return { connected: this.connected, mode: this.mode, config: this.defaults() }; }
  usingClient() { return this.mode === 'client'; }

  async connect() {
    if (!this.defaults().configured) throw new BigdataClientError('HDFS/HBase 客户端服务待配置，请补充 BIGDATA_CLIENT_TOKEN', { status: 400, code: 'BIGDATA_CLIENT_NOT_CONFIGURED', retryable: false });
    if (!this.ssh.conn) throw new BigdataClientError('请先连接 SSH，客户端服务通过 SSH 加密通道访问', { status: 409, code: 'SSH_NOT_CONNECTED', retryable: false });
    this.mode = 'client';
    try {
      const health = await this.request('/health', {}, { method: 'GET', allowDisconnected: true, timeoutMs: Math.min(Number(this.config.timeoutMs) || 30000, 15000) });
      if (!health || health.status !== 'ok') throw new Error('健康检查响应无效');
      this.connected = true;
      return this.status();
    } catch (error) {
      this.connected = false;
      if (error instanceof BigdataClientError) throw error;
      throw new BigdataClientError(`HDFS/HBase 客户端服务连接失败：${error.message}`);
    }
  }

  useSshMode() { this.disconnect(); this.mode = 'ssh'; return this.status(); }
  disconnect() {
    this.connected = false;
    const active = [...this.inflight.entries()];
    for (const [, entry] of active) entry.destroy?.();
    this.inflight.clear();
    for (const [id] of active) void this.cancelRemote(id);
    return this.status();
  }

  async openTunnel() {
    const activeConnection = this.ssh.conn;
    if (!activeConnection) throw new BigdataClientError('SSH 加密通道未连接', { status: 409, code: 'SSH_NOT_CONNECTED', retryable: false });
    return new Promise((resolve, reject) => {
      activeConnection.forwardOut('127.0.0.1', 0, this.config.remoteHost, Number(this.config.remotePort), (error, stream) => {
        if (!error) return resolve(stream);
        // 部分内网 sshd 禁止 direct-tcpip，但仍允许普通 exec channel。
        // 通过固定 nc 命令建立同样位于 SSH 加密会话内的字节流，不暴露 Token 或自由命令入口。
        const host = String(this.config.remoteHost || '');
        const port = Number(this.config.remotePort);
        if (!/^[A-Za-z0-9._:-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || typeof activeConnection.exec !== 'function') {
          return reject(new BigdataClientError(`建立客户端服务通道失败：${error.message}`));
        }
        activeConnection.exec(`exec nc ${host} ${port}`, (execError, execStream) => {
          if (execError) reject(new BigdataClientError(`建立客户端服务通道失败：${execError.message}`));
          else resolve(execStream);
        });
      });
    });
  }

  async cancelRemote(id) {
    try { await this.request('/v1/requests/cancel', { id }, { allowDisconnected: true, timeoutMs: 3000, skipCancel: true }); } catch (_) {}
  }

  async request(endpoint, values = {}, options = {}) {
    if (!options.allowDisconnected && (!this.connected || !this.usingClient())) throw new BigdataClientError('HDFS/HBase 客户端服务尚未连接', { status: 409, code: 'BIGDATA_CLIENT_NOT_CONNECTED', retryable: false });
    const id = options.requestId || requestId();
    const method = options.method || 'POST';
    const body = method === 'GET' ? '' : formBody(values);
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || this.config.timeoutMs) || 30000);
    const channel = await this.openTunnel();
    return new Promise((resolve, reject) => {
      let settled = false; let responseBytes = 0; const chunks = [];
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); this.inflight.delete(id); if (error) reject(error); else resolve(value); };
      const agent = new http.Agent({ keepAlive: false }); agent.createConnection = () => channel;
      const req = http.request({ method, path: endpoint, host: this.config.remoteHost, port: Number(this.config.remotePort), agent, headers: { Authorization: `Bearer ${this.config.token}`, 'X-Request-Id': id, 'X-Request-Timeout-Ms': String(timeoutMs), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', 'Content-Length': Buffer.byteLength(body) } : {}) } }, (res) => {
        res.on('data', (chunk) => { responseBytes += chunk.length; if (responseBytes <= 16 * 1024 * 1024) chunks.push(chunk); else req.destroy(new Error('响应超过 16 MiB')); });
        res.on('end', () => {
          let payload = {}; const raw = Buffer.concat(chunks).toString('utf8');
          try { payload = raw ? JSON.parse(raw) : {}; } catch (_) { return finish(new BigdataClientError('客户端服务返回了非 JSON 响应', { code: 'BIGDATA_CLIENT_INVALID_RESPONSE' })); }
          if ((res.statusCode || 500) >= 400) return finish(new BigdataClientError(payload?.error?.message || payload?.message || `客户端服务请求失败（HTTP ${res.statusCode}）`, { status: res.statusCode || 502, code: payload?.error?.code || 'BIGDATA_CLIENT_REQUEST_FAILED', retryable: (res.statusCode || 500) >= 500 }));
          finish(null, payload);
        });
      });
      const destroy = () => { try { req.destroy(); } catch (_) {} try { channel.destroy(); } catch (_) {} };
      this.inflight.set(id, { destroy });
      const onAbort = () => { destroy(); if (!options.skipCancel) void this.cancelRemote(id); finish(new BigdataClientError('查询已取消', { status: 499, code: 'QUERY_CANCELLED', retryable: false })); };
      const timer = setTimeout(() => { destroy(); if (!options.skipCancel) void this.cancelRemote(id); finish(new BigdataClientError(`客户端服务请求超时（${Math.round(timeoutMs / 1000)} 秒）`, { status: 504, code: 'BIGDATA_CLIENT_TIMEOUT' })); }, timeoutMs);
      req.on('error', (error) => finish(error instanceof BigdataClientError ? error : new BigdataClientError(`客户端服务请求失败：${error.message}`)));
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) return onAbort();
      if (body) req.write(body);
      req.end();
    });
  }

  async hdfsList(path, { signal } = {}) { return this.request('/v1/hdfs/list', { path }, { signal }); }
  async hdfsPreview(path, maxBytes = 262144, { signal } = {}) {
    const result = await this.request('/v1/hdfs/preview', { path, maxBytes: Math.min(Math.max(Number(maxBytes) || 262144, 1), 262144) }, { signal });
    if (result.base64 !== undefined) result.text = Buffer.from(String(result.base64), 'base64').toString('utf8');
    delete result.base64;
    return result;
  }
  async hdfsUpload(localPath, hdfsDir, { signal } = {}) { return this.request('/v1/hdfs/upload', { localPath, hdfsDir }, { signal, timeoutMs: Math.max(Number(this.config.timeoutMs) || 30000, 200000) }); }
  async hdfsDelete(path, kind, { signal } = {}) { return this.request('/v1/hdfs/delete', { path, kind }, { signal }); }
  async hbaseList(path, { refresh = false, signal } = {}) { return this.request('/v1/hbase/list', { path, refresh: refresh ? 'true' : 'false' }, { signal }); }
  async hbaseScan(path, limit = 20, { signal } = {}) { return this.request('/v1/hbase/scan', { path, limit: Math.min(Math.max(Number(limit) || 20, 1), 200) }, { signal, timeoutMs: Math.max(Number(this.config.timeoutMs) || 30000, 120000) }); }
  async hbaseGet(path, rowKey, { signal } = {}) { return this.request('/v1/hbase/get', { path, rowKey }, { signal }); }

  async pipeHdfsDownload(path, response, { signal } = {}) {
    if (!this.connected || !this.usingClient()) throw new BigdataClientError('HDFS/HBase 客户端服务尚未连接', { status: 409, code: 'BIGDATA_CLIENT_NOT_CONNECTED', retryable: false });
    const id = requestId(); const channel = await this.openTunnel(); const query = new URLSearchParams({ path }).toString();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.inflight.delete(id); if (error) reject(error); else resolve(); };
      const agent = new http.Agent({ keepAlive: false }); agent.createConnection = () => channel;
      const req = http.request({ method: 'GET', path: `/v1/hdfs/download?${query}`, host: this.config.remoteHost, port: Number(this.config.remotePort), agent, headers: { Authorization: `Bearer ${this.config.token}`, 'X-Request-Id': id, 'X-Request-Timeout-Ms': String(Math.max(Number(this.config.timeoutMs) || 30000, 120000)) } }, (remote) => {
        if ((remote.statusCode || 500) >= 400) { const chunks = []; remote.on('data', (c) => chunks.push(c)); remote.on('end', () => finish(new BigdataClientError(Buffer.concat(chunks).toString('utf8') || `下载失败（HTTP ${remote.statusCode}）`, { status: remote.statusCode || 502 }))); return; }
        response.writeHead(200, { 'Content-Type': remote.headers['content-type'] || 'application/octet-stream', ...(remote.headers['content-length'] ? { 'Content-Length': remote.headers['content-length'] } : {}), 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.split('/').filter(Boolean).pop() || 'download.bin')}` });
        remote.on('error', finish); remote.on('end', () => finish()); remote.pipe(response);
      });
      const destroy = () => { try { req.destroy(); } catch (_) {} try { channel.destroy(); } catch (_) {} };
      this.inflight.set(id, { destroy });
      const onAbort = () => { destroy(); void this.cancelRemote(id); finish(new BigdataClientError('查询已取消', { status: 499, code: 'QUERY_CANCELLED', retryable: false })); };
      const timer = setTimeout(() => { destroy(); void this.cancelRemote(id); finish(new BigdataClientError('HDFS 下载超时', { status: 504, code: 'BIGDATA_CLIENT_TIMEOUT' })); }, Math.max(Number(this.config.timeoutMs) || 30000, 120000));
      signal?.addEventListener('abort', onAbort, { once: true }); req.on('error', (error) => finish(new BigdataClientError(`HDFS 下载失败：${error.message}`))); req.end();
    });
  }
}

const manager = new BigdataClientManager();
module.exports = { BigdataClientManager, BigdataClientError, manager, formBody };
