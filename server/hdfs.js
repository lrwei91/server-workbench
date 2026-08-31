/**
 * HDFS（hadoop fs）浏览与下载
 *
 * 职责：
 *   1. 执行 hadoop fs -ls 并解析为结构化条目
 *   2. 冷启动预热（连接后后台跑一次，避免用户首次浏览撞 60s+ 冷启动）
 */
'use strict';

const ssh = require('./ssh');
const config = require('../config');

// 单引号 shell 转义，防止路径中的特殊字符被解释
function shellQuote(s) {
  return "'" + String(s == null ? '' : s).replace(/'/g, "'\\''") + "'";
}

// 解析 hadoop fs -ls 的输出行
// 例：drwxr-xr-x   - billtest hdfs          0 2026-08-31 15:02 /apps/xxx
function parseHdfsLsLine(line) {
  const m = line.match(/^([\-dlbcpsrwxsStT+]{10,})\s+(\d+|-)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/);
  if (!m) return null;
  const full = m[8].trim();
  const name = full.split('/').filter(Boolean).pop() || '/';
  return {
    name,
    path: full,
    isDir: m[1][0] === 'd',
    perms: m[1],
    owner: m[3],
    group: m[4],
    size: parseInt(m[5], 10) || 0,
    mtime: m[6] + ' ' + m[7],
  };
}

async function hdfsList(hdfsPath) {
  // Hadoop 客户端冷启动极慢（首次可达 60~70s：JVM 初始化 + Kerberos 认证 + 连 NameNode），
  // 热启动仅 2~3s。因此：超时放宽到 90s，并在超时/失败时自动重试一次（此时进程已热）。
  let r = await ssh.execCommand('hadoop fs -ls ' + shellQuote(hdfsPath), config.hdfsTimeoutMs);
  if (r.timedOut || (r.code !== 0 && !(r.stdout || '').trim())) {
    // 冷启动超时或偶发失败：重试一次，进程已热，通常秒回
    r = await ssh.execCommand('hadoop fs -ls ' + shellQuote(hdfsPath), config.hdfsTimeoutMs);
  }
  const out = (r.stdout || '');
  const err = (r.stderr || '');
  if (r.code !== 0 && !out.trim()) {
    if (/No such file or directory/i.test(err) || /No such file or directory/i.test(out)) {
      throw new Error('HDFS 上不存在该路径：' + hdfsPath + '（注意与本地磁盘路径是两回事）');
    }
    if (r.timedOut || r.code === 124) {
      throw new Error('HDFS 列目录超时（Hadoop 客户端冷启动较慢），请稍等几秒后点「刷新」重试');
    }
    throw new Error('HDFS 列目录失败：' + (err.trim() || ('退出码 ' + r.code)));
  }
  const items = [];
  out.split('\n').forEach((line) => {
    const it = parseHdfsLsLine(line);
    if (it) items.push(it);
  });
  items.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  return items;
}

// 连接建立后预热 HDFS：后台跑一次让 JVM/认证/NameNode 连接先热起来，避免用户首次操作撞冷启动
function warmupHdfs() {
  if (!ssh.conn) return;
  ssh.execCommand('hadoop fs -ls /apps', config.hdfsTimeoutMs).catch(() => { /* 预热失败静默，不影响使用 */ });
}

module.exports = {
  shellQuote,
  parseHdfsLsLine,
  hdfsList,
  warmupHdfs,
};
