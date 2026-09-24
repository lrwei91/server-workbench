/**
 * HDFS（hadoop fs）浏览与下载
 *
 * 职责：
 *   1. 执行 hadoop fs -ls 并解析为结构化条目
 *   2. 冷启动预热（连接后后台跑一次，避免用户首次浏览撞 60s+ 冷启动）
 */
'use strict';

const ssh = require('./ssh');
const config = require('./config-loader');

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
  const safePath = String(hdfsPath || '/').trim();
  if (!safePath.startsWith('/')) throw new Error('HDFS 路径必须以 / 开头');
  // 连接建立后可能仍在预热 Hadoop 客户端；先复用这次冷启动，避免与真实列表并发争抢 SSH/HDFS 资源。
  if (warmupPromise) await warmupPromise;
  let r = await ssh.execCommand('hadoop fs -ls ' + shellQuote(safePath), config.hdfsTimeoutMs || 90000);
  if (r.timedOut || (r.code !== 0 && !(r.stdout || '').trim())) {
    // 冷启动超时或偶发失败：重试一次，进程已热，通常秒回
    r = await ssh.execCommand('hadoop fs -ls ' + shellQuote(safePath), config.hdfsTimeoutMs || 90000);
  }
  const out = (r.stdout || '');
  const err = (r.stderr || '');
  if (r.code !== 0) {
    if (/No such file or directory/i.test(err) || /No such file or directory/i.test(out)) {
      throw new Error('HDFS 上不存在该路径：' + safePath + '（注意与本地磁盘路径是两回事）');
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

async function hdfsPreview(hdfsPath, maxBytes = 262144) {
  const safePath = String(hdfsPath || '').trim();
  if (!safePath.startsWith('/')) throw new Error('HDFS 路径必须以 / 开头');
  const limit = Math.min(Math.max(Number(maxBytes) || 262144, 1), 262144);
  if (warmupPromise) await warmupPromise;
  const r = await ssh.execCommand(`hadoop fs -cat ${shellQuote(safePath)} | head -c ${limit + 1}`, config.hdfsTimeoutMs || 90000);
  const out = String(r.stdout || ''); const err = String(r.stderr || '').trim();
  if (r.timedOut || r.code === 124) throw new Error('HDFS 文件预览超时，请稍后重试');
  if (r.code !== 0) {
    if (/No such file or directory/i.test(err) || /No such file or directory/i.test(out)) throw new Error('HDFS 上不存在该路径：' + safePath);
    if (/is a directory/i.test(err)) throw new Error('HDFS 预览目标不是普通文件：' + safePath);
    throw new Error('HDFS 文件预览失败：' + (err || ('退出码 ' + r.code)));
  }
  return { text: out.slice(0, limit), size: Buffer.byteLength(out), truncated: Buffer.byteLength(out) > limit || Boolean(r.truncated) };
}

async function hdfsUpload(localPath, hdfsDir) {
  if (!localPath || typeof localPath !== 'string') throw new Error('本地文件路径不能为空');
  const cleanDir = String(hdfsDir || '/').trim();
  if (!cleanDir.startsWith('/')) throw new Error('HDFS 目标目录必须以 / 开头');
  const target = cleanDir.endsWith('/') ? cleanDir : cleanDir + '/';
  const fileName = localPath.split('/').filter(Boolean).pop() || '';
  // hadoop fs -put 把本地（远程服务器上的）文件复制到 HDFS 目录；超时放宽为 90s（大文件+冷启动更慢）
  // 若连接后的后台预热尚未结束，先等待预热，避免首次上传与预热争抢 NameNode/认证资源。
  if (warmupPromise) await warmupPromise;
  const r = await ssh.execCommand('hadoop fs -put ' + shellQuote(localPath) + ' ' + shellQuote(target), config.hdfsTimeoutMs || 90000);
  const err = (r.stderr || '').trim();
  const out = (r.stdout || '').trim();
  if (r.timedOut || r.code === 124) {
    throw new Error('HDFS 上传超时（Hadoop 客户端冷启动较慢，大文件更慢），请稍后重试');
  }
  if (r.code !== 0) {
    if (/File exists/.test(err) || /already exists/i.test(err)) {
      throw new Error('HDFS 目标已存在同名文件：' + target + fileName);
    }
    if (/No such file or directory/i.test(err) || /No such file or directory/i.test(out)) {
      throw new Error('本地文件不存在或 HDFS 目标目录不存在：' + cleanDir);
    }
    throw new Error('HDFS 上传失败：' + (err || ('退出码 ' + r.code)));
  }
  return { localPath, fileName, hdfsDir: cleanDir, hdfsPath: target + fileName };
}

async function hdfsDelete(hdfsPath, kind) {
  const safePath = String(hdfsPath || '').trim();
  if (!safePath.startsWith('/')) throw new Error('HDFS 路径必须以 / 开头');
  if (safePath === '/') throw new Error('HDFS 根目录不允许删除');
  if (kind !== 'file' && kind !== 'dir') throw new Error('HDFS 删除类型必须是 file 或 dir');
  if (warmupPromise) await warmupPromise;
  const operation = kind === 'dir' ? '-rmdir' : '-rm';
  const r = await ssh.execCommand(`hadoop fs ${operation} ${shellQuote(safePath)}`, config.hdfsTimeoutMs || 90000);
  const out = String(r.stdout || ''); const err = String(r.stderr || '').trim();
  if (r.timedOut || r.code === 124) throw new Error('HDFS 删除超时，请稍后重试');
  if (r.code !== 0) {
    if (/No such file or directory/i.test(err) || /No such file or directory/i.test(out)) throw new Error('HDFS 上不存在该路径：' + safePath);
    if (/Directory is not empty|NonEmptyDirectoryException/i.test(err)) throw new Error('HDFS 目录非空，只允许删除空目录：' + safePath);
    if (/Is a directory/i.test(err) || /not a directory/i.test(err)) throw new Error('HDFS 删除目标类型不匹配：' + safePath);
    throw new Error('HDFS 删除失败：' + (err || ('退出码 ' + r.code)));
  }
  return { path: safePath, kind, deleted: true };
}

// 把「当前目录 + 名称」拼成一个合法的 HDFS 目标路径，名称只允许单层
function hdfsEntryPath(hdfsDir, name) {
  const dir = String(hdfsDir || '').trim();
  if (!dir.startsWith('/')) throw new Error('HDFS 目录必须以 / 开头');
  const entry = String(name == null ? '' : name).trim();
  if (!entry) throw new Error('名称不能为空');
  if (/[\\/]/.test(entry) || entry === '.' || entry === '..') throw new Error('名称不能包含路径分隔符，也不能是 . 或 ..');
  const base = dir.endsWith('/') ? dir : dir + '/';
  return base + entry;
}

async function hdfsMkdir(hdfsDir, name) {
  const target = hdfsEntryPath(hdfsDir, name);
  if (warmupPromise) await warmupPromise;
  const r = await ssh.execCommand('hadoop fs -mkdir ' + shellQuote(target), config.hdfsTimeoutMs || 90000);
  const out = String(r.stdout || ''); const err = String(r.stderr || '').trim();
  if (r.timedOut || r.code === 124) throw new Error('HDFS 新建目录超时（Hadoop 客户端冷启动较慢），请稍后重试');
  if (r.code !== 0) {
    if (/File exists|AlreadyExists|FileAlreadyExists/i.test(err) || /File exists/i.test(out)) throw new Error('HDFS 目标已存在：' + target);
    if (/No such file or directory/i.test(err) || /No such file or directory/i.test(out)) throw new Error('HDFS 父目录不存在：' + String(hdfsDir).trim());
    if (/Permission denied|AccessControlException/i.test(err)) throw new Error('HDFS 权限不足，无法在该目录新建：' + String(hdfsDir).trim());
    throw new Error('HDFS 新建目录失败：' + (err || ('退出码 ' + r.code)));
  }
  return { path: target, kind: 'dir', created: true };
}

async function hdfsTouch(hdfsDir, name) {
  const target = hdfsEntryPath(hdfsDir, name);
  if (warmupPromise) await warmupPromise;
  // -touchz 创建长度为 0 的空文件；同名文件已存在时会报错，不覆盖
  const r = await ssh.execCommand('hadoop fs -touchz ' + shellQuote(target), config.hdfsTimeoutMs || 90000);
  const out = String(r.stdout || ''); const err = String(r.stderr || '').trim();
  if (r.timedOut || r.code === 124) throw new Error('HDFS 新建文件超时（Hadoop 客户端冷启动较慢），请稍后重试');
  if (r.code !== 0) {
    if (/File exists|AlreadyExists|FileAlreadyExists/i.test(err) || /File exists/i.test(out)) throw new Error('HDFS 目标已存在：' + target);
    if (/No such file or directory/i.test(err) || /No such file or directory/i.test(out)) throw new Error('HDFS 父目录不存在：' + String(hdfsDir).trim());
    if (/Permission denied|AccessControlException/i.test(err)) throw new Error('HDFS 权限不足，无法在该目录新建：' + String(hdfsDir).trim());
    throw new Error('HDFS 新建文件失败：' + (err || ('退出码 ' + r.code)));
  }
  return { path: target, kind: 'file', created: true };
}

// 连接建立后预热 HDFS：后台跑一次让 JVM/认证/NameNode 连接先热起来，避免用户首次操作撞冷启动
function warmupHdfs() {
  if (!ssh.conn || warmupPromise) return warmupPromise;
  warmupPromise = ssh.execCommand('hadoop fs -ls /apps', config.hdfsTimeoutMs || 90000)
    .catch(() => null)
    .finally(() => { warmupPromise = null; });
  return warmupPromise;
}

let warmupPromise = null;

module.exports = {
  shellQuote,
  parseHdfsLsLine,
  hdfsEntryPath,
  hdfsList,
  hdfsPreview,
  hdfsUpload,
  hdfsMkdir,
  hdfsTouch,
  hdfsDelete,
  warmupHdfs,
};
