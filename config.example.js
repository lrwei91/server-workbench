/**
 * 复制为项目根目录 config.js 后填写本机连接配置。
 * config.js 已加入 .gitignore，不要把密码写入仓库或 localStorage。
 */
module.exports = {
  workbench: { host: '127.0.0.1', port: 17755 },
  ssh: {
    host: '',
    port: 22,
    username: '',
    password: '',
    timeoutMs: 15000,
    execTimeoutMs: 30000,
    execMaxTimeoutMs: 120000,
    execMaxOutputBytes: 2 * 1024 * 1024,
  },
  hdfsTimeoutMs: 90000,
  cdr: { upstream: 'http://127.0.0.1:8000' },
  logs: { dir: './logs', maxDays: 30, maxEntries: 10000 },
};
