/**
 * SSH 连接管理与远程命令执行
 *
 * 职责：
 *   1. 维护当前 SSH 连接（conn / connInfo / homeDir）
 *   2. 连接建立 / 断开，错误翻译为友好提示
 *   3. 执行远程命令（exec），拦截交互式命令与自杀式删除
 */
'use strict';

const { Client } = require('ssh2');
const config = require('../config');

// ---------- 内置默认连接配置（从统一 config 读取） ----------
const DEFAULT_CONFIG = {
  host: config.ssh.host,
  port: config.ssh.port,
  username: config.ssh.username,
  password: config.ssh.password,
};

let conn = null;      // 当前 SSH 连接
let connInfo = null;  // 当前使用的连接信息（不含明文密码下发前端）
let homeDir = null;   // 远程用户主目录（连接成功后缓存，用于展开 ~ 路径）

// 部分服务器的 SFTP 不展开 ~ 路径，这里统一在前置处理
function expandTilde(p) {
  if (!homeDir) return p;
  if (p === '~') return homeDir;
  if (p.startsWith('~/')) return homeDir + p.slice(1);
  return p;
}

// 连接信息脱敏（密码不下发明文）
function maskConfig(cfg) {
  return {
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    hasPassword: true, // 密码保存在服务端，不下发明文
  };
}

function disconnect() {
  if (conn) {
    try { conn.end(); } catch (e) { /* ignore */ }
    conn = null;
    connInfo = null;
  }
  homeDir = null;
}

function connect(overrides) {
  return new Promise((resolve, reject) => {
    const cfg = Object.assign({}, DEFAULT_CONFIG, overrides || {});
    if (!cfg.host || !cfg.username) {
      return reject(new Error('缺少主机地址或用户名'));
    }
    disconnect();
    const c = new Client();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { c.end(); } catch (e) { /* ignore */ }
      reject(new Error('连接超时（15 秒）：请确认服务器网络可达、22 端口已开放'));
    }, config.sshTimeoutMs);

    c.on('ready', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn = c;
      connInfo = cfg;
      c.on('close', () => { conn = null; connInfo = null; homeDir = null; });
      c.on('error', () => { /* 连接期间错误由 close 兜底 */ });
      // 缓存主目录，供 ~ 路径展开使用
      c.exec('echo $HOME', (e2, s2) => {
        if (e2) return;
        let h = '';
        s2.on('data', (d) => { h += d.toString('utf8'); });
        s2.on('close', () => { homeDir = (h.trim().split('\n').pop() || null); });
      });
      resolve(maskConfig(cfg));
    });

    c.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const raw = String((err && err.message) || err);
      let friendly = raw;
      if (/All configured authentication methods|authentication/i.test(raw)) {
        friendly = '认证失败：用户名或密码不正确';
      } else if (/ECONNREFUSED/i.test(raw)) {
        friendly = '连接被拒绝：22 端口未开放或 SSH 服务未启动';
      } else if (/ETIMEDOUT|timed? ?out/i.test(raw)) {
        friendly = '连接超时：网络不可达或主机未开机';
      } else if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
        friendly = '无法解析主机地址：请检查 IP 是否正确';
      } else if (/EHOSTUNREACH|ENETUNREACH/i.test(raw)) {
        friendly = '网络不可达：请确认已连入公司内网 / VPN';
      }
      reject(new Error(friendly));
    });

    c.connect({
      host: cfg.host,
      port: Number(cfg.port) || 22,
      username: cfg.username,
      password: cfg.password,
      readyTimeout: config.sshTimeoutMs,
      keepaliveInterval: 15000,
    });
  });
}

// ---------- 命令执行 ----------
// 交互式命令无法在非交互通道里使用，直接拦截并给出替代建议
const INTERACTIVE_RE = /(^|\s|;|&&|\|)(vim|vi|less|more|nano|man|htop|top|tail\s+-f|watch)\b/;
// 绝对禁止的自杀式删除
const FORBIDDEN_RE = /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|\/\*|"\/"|'\/')(\s|$|\*)/;

function execCommand(cmd, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!conn) return reject(new Error('尚未连接服务器：请先点击右上角【连接】按钮'));
    if (FORBIDDEN_RE.test(cmd)) {
      return reject(new Error('已拦截：不允许执行针对根目录的递归强制删除（rm -rf /）'));
    }
    if (INTERACTIVE_RE.test(cmd)) {
      return reject(new Error(
        '该命令需要交互式终端（vim / less / top / tail -f 等），工作台暂不支持。\n' +
        '替代方案：查看文件内容用左侧【查看文件内容】指令；查看进程用【系统 · 运行中的进程】；'
      ));
    }
    const limit = Math.min(Number(timeoutMs) || config.execTimeoutMs, config.execMaxTimeoutMs);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      const t0 = Date.now();
      stream.on('data', (d) => { stdout += d.toString('utf8'); });
      stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      const timer = setTimeout(() => {
        try { stream.close(); } catch (e) { /* ignore */ }
        resolve({ stdout, stderr, code: 124, duration: limit, timedOut: true });
      }, limit);
      stream.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code == null ? 0 : code, duration: Date.now() - t0 });
      });
    });
  });
}

module.exports = {
  DEFAULT_CONFIG,
  expandTilde,
  maskConfig,
  disconnect,
  connect,
  execCommand,
  INTERACTIVE_RE,
  FORBIDDEN_RE,
  // 供其它模块读取连接状态
  get conn() { return conn; },
  get connInfo() { return connInfo; },
};
