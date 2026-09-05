'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const localPath = path.join(root, 'config.js');
const examplePath = path.join(root, 'config.example.js');
let loadedFrom = localPath;
let config;

// 只在本地配置不存在时回退到样例；样例依赖缺失或语法错误不能被静默吞掉。
if (fs.existsSync(localPath)) config = require(localPath);
else { loadedFrom = examplePath; config = require(examplePath); }

function normalize(raw) {
  const value = raw || {};
  const workbench = value.workbench || {};
  const ssh = value.ssh || {};
  const cdr = value.cdr || {};
  const logs = value.logs || {};
  return {
    ...value,
    workbench: { host: workbench.host || '127.0.0.1', port: Number(workbench.port) || 17755 },
    ssh: {
      host: typeof ssh.host === 'string' ? ssh.host.trim() : '',
      port: Number(ssh.port) || 22,
      username: typeof ssh.username === 'string' ? ssh.username.trim() : '',
      password: typeof ssh.password === 'string' ? ssh.password : '',
      timeoutMs: Number(ssh.timeoutMs || value.sshTimeoutMs) || 15000,
      execTimeoutMs: Number(ssh.execTimeoutMs || value.execTimeoutMs) || 30000,
      execMaxTimeoutMs: Number(ssh.execMaxTimeoutMs || value.execMaxTimeoutMs) || 120000,
      execMaxOutputBytes: Number(ssh.execMaxOutputBytes || value.execMaxOutputBytes) || 2 * 1024 * 1024,
    },
    cdr: { upstream: cdr.upstream || `http://${cdr.host || '127.0.0.1'}:${Number(cdr.port) || 8000}` },
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
  if (!normalized.ssh.host || !normalized.ssh.username) errors.push('缺少 SSH host 或 username，请复制 config.example.js 为 config.js 并填写');
  if (!Number.isInteger(normalized.workbench.port) || normalized.workbench.port < 1 || normalized.workbench.port > 65535) errors.push('workbench.port 必须是 1-65535 的整数');
  return errors;
}

function resolveLogDir() {
  const value = normalized.logs.dir;
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

module.exports = { ...normalized, loadedFrom, isExample, validate, resolveLogDir, root, exists: fs.existsSync(localPath) };
