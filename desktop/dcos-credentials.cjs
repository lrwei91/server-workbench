'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('../server/config-loader');

// 每次打开登录窗口重新读取本机配置；凭据不经过工作台 renderer 或日志。
function readDcosCredentials(directory, platformOrigin, safeStorage) {
  try {
    const env = parseEnv(fs.readFileSync(path.join(directory, '.env'), 'utf8'));
    if (env.DCOS_USERNAME || env.DCOS_PASSWORD) {
      if (!env.DCOS_USERNAME || !env.DCOS_PASSWORD || new URL(env.DCOS_BASE_URL).origin !== platformOrigin) return null;
      return { username: env.DCOS_USERNAME, password: env.DCOS_PASSWORD };
    }
  } catch (_) { return null; }
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const saved = JSON.parse(safeStorage.decryptString(fs.readFileSync(path.join(directory, 'dcos-credentials.bin'))));
    return saved.origin === platformOrigin ? saved : null;
  } catch (_) { return null; }
}
module.exports = { readDcosCredentials };
