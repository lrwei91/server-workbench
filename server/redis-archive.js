'use strict';

const net = require('net');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_DECODED_BYTES = 16 * 1024 * 1024;

class RedisArchiveError extends Error {
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

function normalizeRedisArchiveKey(value) {
  const text = String(value ?? '').trim();
  const match = /^(?:rate:cpp:)?([0-9]+)$/.exec(text);
  if (!match) throw new RedisArchiveError(400, 'INVALID_REDIS_KEY', '请输入产品实例 ID 或 rate:cpp:{产品实例ID}');
  return { key: `rate:cpp:${match[1]}`, productInstanceId: match[1] };
}

function maskRedisArchiveConfig(config = {}) {
  const host = String(config.host || '').trim();
  const password = String(config.password || '');
  return {
    host,
    port: Number(config.port) || 16379,
    db: Math.max(0, Number(config.db) || 0),
    configured: Boolean(host && password),
    hasCredential: Boolean(password),
    timeoutMs: Math.max(1000, Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS),
    maxDecodedBytes: Math.max(1024, Number(config.maxDecodedBytes) || DEFAULT_MAX_DECODED_BYTES),
  };
}

function encodeCommand(parts) {
  const chunks = [Buffer.from(`*${parts.length}\r\n`)];
  for (const part of parts) {
    const value = Buffer.from(String(part));
    chunks.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n'));
  }
  return Buffer.concat(chunks);
}

function parseResp(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf('\r\n', offset + 1);
  if (lineEnd < 0) return null;
  const header = buffer.subarray(offset + 1, lineEnd).toString('utf8');
  if (type === '+' || type === '-' || type === ':') {
    return { value: type === ':' ? Number(header) : header, error: type === '-', next: lineEnd + 2 };
  }
  if (type === '$') {
    const length = Number(header);
    if (length === -1) return { value: null, next: lineEnd + 2 };
    if (!Number.isInteger(length) || length < 0) throw new RedisArchiveError(502, 'REDIS_PROTOCOL_ERROR', 'Redis 返回了非法 Bulk String 长度');
    const start = lineEnd + 2;
    if (buffer.length < start + length + 2) return null;
    return { value: buffer.subarray(start, start + length), next: start + length + 2 };
  }
  if (type === '*') {
    const count = Number(header);
    if (count === -1) return { value: null, next: lineEnd + 2 };
    if (!Number.isInteger(count) || count < 0) throw new RedisArchiveError(502, 'REDIS_PROTOCOL_ERROR', 'Redis 返回了非法数组长度');
    let next = lineEnd + 2;
    const value = [];
    for (let index = 0; index < count; index += 1) {
      const item = parseResp(buffer, next);
      if (!item) return null;
      value.push(item.value);
      next = item.next;
    }
    return { value, next };
  }
  throw new RedisArchiveError(502, 'REDIS_PROTOCOL_ERROR', `Redis 返回了未知 RESP 类型 ${type}`);
}

function readLength(input, state, base) {
  let length = base;
  if (base !== 15) return length;
  while (true) {
    if (state.offset >= input.length) throw new RedisArchiveError(502, 'REDIS_DECODE_FAILED', 'LZ4 长度字段被截断');
    const value = input[state.offset++];
    length += value;
    if (value !== 255) return length;
  }
}

function decompressLz4Block(input, outputLength) {
  if (!Buffer.isBuffer(input)) input = Buffer.from(input || []);
  if (!Number.isInteger(outputLength) || outputLength < 0) throw new RedisArchiveError(502, 'REDIS_DECODE_FAILED', 'LZ4 解压长度无效');
  const output = Buffer.alloc(outputLength);
  const state = { offset: 0 };
  let outputOffset = 0;
  while (state.offset < input.length) {
    const token = input[state.offset++];
    const literalLength = readLength(input, state, token >>> 4);
    if (state.offset + literalLength > input.length || outputOffset + literalLength > output.length) throw new RedisArchiveError(502, 'REDIS_DECODE_FAILED', 'LZ4 字面量长度越界');
    input.copy(output, outputOffset, state.offset, state.offset + literalLength);
    state.offset += literalLength;
    outputOffset += literalLength;
    if (state.offset === input.length) break;
    if (state.offset + 2 > input.length) throw new RedisArchiveError(502, 'REDIS_DECODE_FAILED', 'LZ4 偏移量被截断');
    const matchOffset = input[state.offset] | (input[state.offset + 1] << 8);
    state.offset += 2;
    if (matchOffset < 1 || matchOffset > outputOffset) throw new RedisArchiveError(502, 'REDIS_DECODE_FAILED', 'LZ4 回溯偏移量无效');
    const matchLength = readLength(input, state, token & 0x0f) + 4;
    if (outputOffset + matchLength > output.length) throw new RedisArchiveError(502, 'REDIS_DECODE_FAILED', 'LZ4 匹配长度越界');
    for (let index = 0; index < matchLength; index += 1) output[outputOffset + index] = output[outputOffset - matchOffset + index];
    outputOffset += matchLength;
  }
  if (outputOffset !== output.length || state.offset !== input.length) throw new RedisArchiveError(502, 'REDIS_DECODE_FAILED', 'LZ4 解压结果长度不匹配');
  return output;
}

function decodeRedisArchiveValue(raw, { maxDecodedBytes = DEFAULT_MAX_DECODED_BYTES } = {}) {
  if (!Buffer.isBuffer(raw) || raw.length < 5) throw new RedisArchiveError(502, 'REDIS_DECODE_FAILED', 'Redis 档案值过短');
  const decodedBytes = raw.readUInt32BE(0);
  if (decodedBytes < 5 || decodedBytes > maxDecodedBytes) throw new RedisArchiveError(502, 'REDIS_DECODE_FAILED', `Redis 档案声明的解压长度 ${decodedBytes} 超出限制`);
  const decoded = decompressLz4Block(raw.subarray(4), decodedBytes);
  const jsonOffset = decoded.indexOf(0x7b);
  if (jsonOffset < 0) throw new RedisArchiveError(502, 'REDIS_DECODE_FAILED', '解压结果中没有找到 JSON');
  let payload = decoded.subarray(jsonOffset);
  if (payload.length >= 3 && payload[0] === 0x7b && payload[1] === 0x7b && payload[2] === 0x22) payload = payload.subarray(1);
  try {
    return {
      data: JSON.parse(payload.toString('utf8')),
      compressedBytes: raw.length,
      decodedBytes,
      prefixHex: decoded.subarray(0, jsonOffset).toString('hex'),
    };
  } catch (_) {
    throw new RedisArchiveError(502, 'REDIS_DECODE_FAILED', 'LZ4 解压成功，但档案 JSON 解析失败');
  }
}

class RedisSocket {
  constructor(config, netModule = net) {
    this.config = config;
    this.net = netModule;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
  }

  connect(signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new RedisArchiveError(499, 'QUERY_CANCELLED', '查询已取消'));
      const socket = this.net.createConnection({ host: this.config.host, port: this.config.port });
      this.socket = socket;
      const timer = setTimeout(() => socket.destroy(new RedisArchiveError(504, 'REDIS_QUERY_TIMEOUT', 'Redis 连接超时', true)), this.config.timeoutMs);
      const abort = () => socket.destroy(new RedisArchiveError(499, 'QUERY_CANCELLED', '查询已取消'));
      signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener?.('abort', abort); };
      socket.once('connect', () => { cleanup(); resolve(); });
      socket.once('error', (error) => { cleanup(); reject(error); });
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('error', (error) => this.failPending(error));
      socket.on('close', () => this.failPending(new RedisArchiveError(502, 'REDIS_CONNECTION_CLOSED', 'Redis 连接已断开', true)));
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.pending.length) {
      let result;
      try { result = parseResp(this.buffer); } catch (error) { this.failPending(error); this.socket?.destroy(); return; }
      if (!result) return;
      this.buffer = this.buffer.subarray(result.next);
      const pending = this.pending.shift();
      if (result.error) pending.reject(new RedisArchiveError(502, 'REDIS_COMMAND_FAILED', String(result.value), false));
      else pending.resolve(result.value);
    }
  }

  failPending(error) {
    while (this.pending.length) this.pending.shift().reject(error);
  }

  command(parts, signal) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) return reject(new RedisArchiveError(502, 'REDIS_CONNECTION_CLOSED', 'Redis 连接不可用', true));
      if (signal?.aborted) return reject(new RedisArchiveError(499, 'QUERY_CANCELLED', '查询已取消'));
      const timer = setTimeout(() => { this.socket.destroy(); reject(new RedisArchiveError(504, 'REDIS_QUERY_TIMEOUT', 'Redis 查询超时', true)); }, this.config.timeoutMs);
      const abort = () => { this.socket.destroy(); reject(new RedisArchiveError(499, 'QUERY_CANCELLED', '查询已取消')); };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.push({
        resolve: (value) => { clearTimeout(timer); signal?.removeEventListener?.('abort', abort); resolve(value); },
        reject: (error) => { clearTimeout(timer); signal?.removeEventListener?.('abort', abort); reject(error); },
      });
      this.socket.write(encodeCommand(parts));
    });
  }

  close() { this.socket?.destroy(); this.socket = null; }
}

class RedisArchiveService {
  constructor(config = {}, netModule = net) {
    this.config = { ...config, ...maskRedisArchiveConfig(config), username: String(config.username || ''), password: String(config.password || '') };
    this.net = netModule;
  }

  defaults() { return maskRedisArchiveConfig(this.config); }

  async query(value, { signal } = {}) {
    const identity = normalizeRedisArchiveKey(value);
    if (!this.config.configured) throw new RedisArchiveError(409, 'REDIS_NOT_CONFIGURED', 'Redis 档案连接待配置，请填写 REDIS_ARCHIVE_HOST 和 REDIS_ARCHIVE_PASSWORD');
    const connection = new RedisSocket(this.config, this.net);
    try {
      await connection.connect(signal);
      try {
        await connection.command(this.config.username ? ['AUTH', this.config.username, this.config.password] : ['AUTH', this.config.password], signal);
      } catch (error) {
        if (error.code === 'REDIS_COMMAND_FAILED') throw new RedisArchiveError(401, 'REDIS_AUTH_FAILED', 'Redis 认证失败，请检查账号和密码');
        throw error;
      }
      if (this.config.db) await connection.command(['SELECT', this.config.db], signal);
      const raw = await connection.command(['GET', identity.key], signal);
      const base = { environment: 'redis', ...identity, readAt: utc8Iso(), encoding: 'lz4-json' };
      if (raw === null) return { ...base, status: 'empty', data: null };
      const decoded = decodeRedisArchiveValue(raw, { maxDecodedBytes: this.config.maxDecodedBytes });
      return { ...base, status: 'complete', ...decoded };
    } catch (error) {
      if (error instanceof RedisArchiveError) throw error;
      const message = String(error?.message || error || '');
      if (/ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|getaddrinfo|ETIMEDOUT/i.test(message)) throw new RedisArchiveError(502, 'REDIS_CONNECTION_FAILED', 'Redis 连接失败，请检查地址、端口和网络', true);
      throw new RedisArchiveError(502, 'REDIS_QUERY_FAILED', 'Redis 查询失败，请稍后重试', true);
    } finally {
      connection.close();
    }
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_DECODED_BYTES,
  RedisArchiveError,
  RedisArchiveService,
  RedisSocket,
  normalizeRedisArchiveKey,
  maskRedisArchiveConfig,
  encodeCommand,
  parseResp,
  decompressLz4Block,
  decodeRedisArchiveValue,
  utc8Iso,
};
