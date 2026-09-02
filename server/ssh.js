/** SSH connection lifecycle and bounded remote command execution. */
'use strict';

const config = require('./config-loader');

let Client;
function getClient() {
  if (!Client) {
    try { ({ Client } = require('ssh2')); }
    catch (err) { throw new Error('未安装 ssh2 依赖，请先运行 npm install'); }
  }
  return Client;
}

const DEFAULT_CONFIG = { host: config.ssh.host, port: config.ssh.port, username: config.ssh.username, password: config.ssh.password };
let conn = null;
let connInfo = null;
let homeDir = null;
let connectGeneration = 0;

function shellQuote(value) { return `'${String(value == null ? '' : value).replace(/'/g, `'\\''`)}'`; }
function expandTilde(value) {
  const p = String(value == null ? '' : value);
  if (!homeDir) return p;
  if (p === '~') return homeDir;
  if (p.startsWith('~/')) return homeDir + p.slice(1);
  return p;
}
function maskConfig(cfg) { return { host: cfg.host, port: Number(cfg.port) || 22, username: cfg.username, hasPassword: Boolean(cfg.password) }; }
function disconnect() {
  connectGeneration += 1;
  const old = conn;
  conn = null;
  connInfo = null;
  homeDir = null;
  if (old) { try { old.end(); } catch (_) {} }
}
function friendlyConnectionError(raw) {
  const text = String(raw || '连接失败');
  if (/All configured authentication methods|authentication/i.test(text)) return '认证失败：用户名或密码不正确';
  if (/ECONNREFUSED/i.test(text)) return '连接被拒绝：22 端口未开放或 SSH 服务未启动';
  if (/ETIMEDOUT|timed? ?out/i.test(text)) return '连接超时：网络不可达或主机未开机';
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return '无法解析主机地址：请检查 IP 是否正确';
  if (/EHOSTUNREACH|ENETUNREACH/i.test(text)) return '网络不可达：请确认已连入公司内网 / VPN';
  return text;
}
function connect(overrides = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...overrides };
  if (!cfg.host || !cfg.username) return Promise.reject(new Error('缺少主机地址或用户名，请先填写连接配置'));
  const ClientCtor = getClient();
  disconnect();
  const attempt = connectGeneration;
  return new Promise((resolve, reject) => {
    const c = new ClientCtor();
    let settled = false;
    let timer;
    const finishError = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { c.end(); } catch (_) {}
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    timer = setTimeout(() => finishError(new Error(`连接超时（${Math.round(config.ssh.timeoutMs / 1000)} 秒）：请确认服务器网络可达、22 端口已开放`)), config.ssh.timeoutMs);
    c.on('ready', () => {
      if (settled || attempt !== connectGeneration) return finishError(new Error('连接请求已过期'));
      settled = true;
      clearTimeout(timer);
      conn = c;
      connInfo = cfg;
      c.on('close', () => { if (conn === c) { conn = null; connInfo = null; homeDir = null; } });
      c.on('error', () => {});
      c.exec('echo $HOME', (err, stream) => {
        if (err || !stream) return;
        let output = '';
        stream.on('data', (chunk) => { output += chunk.toString('utf8'); });
        stream.on('close', () => { if (conn === c) homeDir = output.trim().split('\n').pop() || null; });
      });
      resolve(maskConfig(cfg));
    });
    c.on('error', (err) => finishError(new Error(friendlyConnectionError(err?.message || err))));
    try {
      c.connect({ host: cfg.host, port: Number(cfg.port) || 22, username: cfg.username, password: cfg.password, readyTimeout: config.ssh.timeoutMs, keepaliveInterval: 15000 });
    } catch (err) { finishError(err); }
  });
}

const INTERACTIVE_RE = /(^|\s|;|&&|\||\n)(?:vim|vi|less|more|nano|man|htop|top|tail\s+-f|watch)\b/i;
// 只拦截明确指向根目录的递归强制删除，允许用户在确认后处理普通路径。
const FORBIDDEN_RE = /(?:^|[;&|\n])\s*(?:sudo\s+)?rm\b(?=[^;&|\n]*\s(?:-[A-Za-z]*r[A-Za-z]*|--recursive)(?:\s|$))(?=[^;&|\n]*\s(?:-[A-Za-z]*f[A-Za-z]*|--force)(?:\s|$))[^;&|\n]*\s+['"]?\/(?:\*)?['"]?(?=\s|$)/i;
const DANGEROUS_RE = /(?:^|[;&|\n])\s*(?:sudo\s+)?(?:rm|rmdir|del|erase|format)\b/i;
function isDangerousCommand(cmd) { return DANGEROUS_RE.test(String(cmd || '')); }

function execCommand(command, timeoutMs) {
  const cmd = String(command || '');
  return new Promise((resolve, reject) => {
    const active = conn;
    if (!active) return reject(new Error('尚未连接服务器：请先点击右上角【连接】按钮'));
    if (FORBIDDEN_RE.test(cmd)) return reject(new Error('已拦截：不允许执行针对根目录的递归强制删除（rm -rf /）'));
    if (INTERACTIVE_RE.test(cmd)) return reject(new Error('该命令需要交互式终端（vim / less / top / tail -f 等），工作台暂不支持。'));
    const limit = Math.min(Number(timeoutMs) || config.ssh.execTimeoutMs, config.ssh.execMaxTimeoutMs);
    const maxBytes = Math.max(1024, Number(config.ssh.execMaxOutputBytes) || 2 * 1024 * 1024);
    active.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let truncated = false;
      const started = Date.now();
      const append = (target, chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        if (bytes >= maxBytes) { truncated = true; return target; }
        const room = maxBytes - bytes;
        const used = buf.subarray(0, room);
        bytes += used.length;
        if (used.length < buf.length) truncated = true;
        return target + used.toString('utf8');
      };
      active.on?.('error', () => {});
      stream.on('data', (chunk) => { stdout = append(stdout, chunk); });
      stream.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
      let finished = false;
      const finish = (result) => { if (finished) return; finished = true; clearTimeout(timer); resolve({ ...result, duration: Date.now() - started, truncated }); };
      const timer = setTimeout(() => { try { stream.close(); } catch (_) {} finish({ stdout, stderr, code: 124, timedOut: true }); }, limit);
      stream.on('close', (code) => finish({ stdout, stderr, code: code == null ? 0 : code, timedOut: false }));
      stream.on('error', (streamErr) => { if (!finished) { clearTimeout(timer); reject(streamErr); } });
    });
  });
}

module.exports = { DEFAULT_CONFIG, expandTilde, maskConfig, shellQuote, disconnect, connect, execCommand, isDangerousCommand, INTERACTIVE_RE, FORBIDDEN_RE, get conn() { return conn; }, get connInfo() { return connInfo; }, get home() { return homeDir; } };
