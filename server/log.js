/**
 * 执行日志持久化模块
 *
 * 把工作台里的命令执行日志写入本地文件（按日期命名 logs/YYYY-MM-DD.log），
 * 实现「刷新不丢、按日期分文件、本地同步更新」：
 *   - append()   追加一条日志（同步写盘，写入队列串行化，避免并发写损坏）
 *   - list()     读取某一天的日志（按行解析为结构化条目）
 *   - dates()    列出已有日志的日期（供前端展示历史）
 *
 * 日志行格式（每行一条，JSON，方便解析与容错）：
 *   {"t":"HH:MM:SS","cmd":"...","badge":"成功 · 0.1s","out":"..."}
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

// 日志目录（相对 server-workbench 根）
const LOG_DIR = path.join(__dirname, '..', config.logs.dir);
const MAX_DAYS = config.logs.maxDays || 90;

// 写入队列：串行化写盘，避免并发 append 交错写入损坏文件
let writeQueue = Promise.resolve();

function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function logPath(date) {
  // 校验日期格式，防止路径注入（只允许 YYYY-MM-DD）
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    throw new Error('日期格式错误，应为 YYYY-MM-DD');
  }
  return path.join(LOG_DIR, date + '.log');
}

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * 追加一条日志（异步，内部串行化写盘）。
 * @param {object} entry {t, cmd, badge, out}
 * @param {string} [date] 日期，默认今天
 */
function append(entry, date) {
  const d = date || today();
  const line = JSON.stringify({
    t: entry.t || '',
    cmd: entry.cmd || '',
    badge: entry.badge || '',
    out: entry.out || '',
  });

  writeQueue = writeQueue.then(() => {
    ensureDir();
    fs.appendFileSync(logPath(d), line + '\n', 'utf8');
  }).catch((err) => {
    console.error('[日志写入失败]', err && err.message ? err.message : err);
  });

  // 异步清理过期日志（不阻塞主流程）
  writeQueue = writeQueue.then(cleanupExpired).catch(() => {});
  return writeQueue;
}

/**
 * 读取某一天的日志，按行解析为结构化条目。
 * 容错：非法行（非 JSON 或字段缺失）跳过，不影响其它行。
 */
function list(date) {
  const p = logPath(date);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') {
        entries.push({
          t: o.t || '',
          cmd: o.cmd || '',
          badge: o.badge || '',
          out: o.out || '',
        });
      }
    } catch (e) { /* 跳过非法行 */ }
  }
  return entries;
}

/**
 * 列出已有日志文件的日期（降序，最新在前）。
 */
function dates() {
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs.readdirSync(LOG_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .map((f) => f.replace(/\.log$/, ''))
    .sort()
    .reverse();
}

/**
 * 清理超过 maxDays 的过期日志文件。
 */
function cleanupExpired() {
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const cutoff = Date.now() - MAX_DAYS * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (!m) continue;
      const fileTime = new Date(m[1] + 'T00:00:00').getTime();
      if (fileTime < cutoff) {
        fs.unlinkSync(path.join(LOG_DIR, f));
      }
    }
  } catch (e) {
    console.error('[日志清理失败]', e && e.message ? e.message : e);
  }
}

module.exports = {
  LOG_DIR,
  today,
  append,
  list,
  dates,
};
