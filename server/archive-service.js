'use strict';

const DEFAULT_TIMEOUT_MS = 60000;

class ArchiveServiceError extends Error {
  constructor(status, code, message, retryable = false, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

function utc8Iso(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

function normalizeArchiveKey(value) {
  const text = String(value ?? '').trim();
  const match = /^(?:rate:cpp:)?([0-9]+)$/.exec(text);
  if (!match) throw new ArchiveServiceError(400, 'INVALID_ARCHIVE_KEY', '请输入产品实例 ID 或 rate:cpp:{产品实例ID}');
  return { key: `rate:cpp:${match[1]}`, productInstanceId: match[1] };
}

function maskConfig(config = {}) {
  return {
    pageUrl: String(config.pageUrl || ''),
    apiUrl: String(config.apiUrl || ''),
    configured: Boolean(String(config.apiUrl || '').trim()),
    hasCredential: Boolean(String(config.authToken || '')),
    timeoutMs: Math.max(1000, Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS),
  };
}

class PendingArchiveAdapter {
  async connect() {
    throw new ArchiveServiceError(501, 'ARCHIVE_ADAPTER_PENDING', '内存档案接口协议待适配，请补充内网请求资料');
  }
  async disconnect() {}
  async query() {
    throw new ArchiveServiceError(501, 'ARCHIVE_ADAPTER_PENDING', '内存档案接口协议待适配，请补充内网请求资料');
  }
}

class ArchiveService {
  constructor(config = {}, adapter = new PendingArchiveAdapter()) {
    this.config = { ...config, timeoutMs: Math.max(1000, Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS) };
    this.adapter = adapter;
    this.connected = false;
    this.generation = 0;
    this.active = new Set();
  }

  defaults() { return maskConfig(this.config); }
  status() { return { connected: this.connected, config: this.defaults() }; }

  async connect() {
    if (!String(this.config.apiUrl || '').trim()) throw new ArchiveServiceError(409, 'ARCHIVE_NOT_CONFIGURED', '内存档案接口待配置，请补充 ARCHIVE_API_URL');
    const generation = ++this.generation;
    await this.disconnectActive();
    try {
      await this.adapter.connect({ ...this.config });
      if (generation !== this.generation) throw new ArchiveServiceError(409, 'STALE_ARCHIVE_CONNECTION', '内存档案连接请求已过期，请重试', true);
      this.connected = true;
      return this.status();
    } catch (error) {
      if (generation === this.generation) this.connected = false;
      throw error;
    }
  }

  async disconnectActive() {
    for (const controller of this.active) controller.abort();
    this.active.clear();
    await this.adapter.disconnect?.();
  }

  async disconnect() {
    ++this.generation;
    this.connected = false;
    await this.disconnectActive();
  }

  async query(value, { signal } = {}) {
    if (!this.connected) throw new ArchiveServiceError(409, 'ARCHIVE_NOT_CONNECTED', '内存档案服务尚未连接');
    const identity = normalizeArchiveKey(value);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    this.active.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.timeoutMs);
    try {
      const response = await this.adapter.query(identity.key, { signal: controller.signal });
      const base = { environment: 'project', ...identity, readAt: utc8Iso() };
      if (response?.found === false) return { ...base, status: 'empty', data: null };
      if (response?.found === true && response.data !== undefined && response.data !== null && typeof response.data === 'object' && !Buffer.isBuffer(response.data)) {
        return { ...base, status: 'complete', data: response.data };
      }
      return { ...base, status: 'unsupported', data: null };
    } catch (error) {
      if (timedOut) throw new ArchiveServiceError(504, 'ARCHIVE_QUERY_TIMEOUT', '内存档案查询超过 60 秒', true);
      if (controller.signal.aborted) throw new ArchiveServiceError(499, 'QUERY_CANCELLED', '查询已取消');
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      this.active.delete(controller);
    }
  }
}

module.exports = { DEFAULT_TIMEOUT_MS, ArchiveServiceError, PendingArchiveAdapter, ArchiveService, normalizeArchiveKey, maskConfig, utc8Iso };
