/** Asynchronous local command log queue with bounded reads. */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config-loader');

const LOG_DIR = config.resolveLogDir();
const MAX_DAYS = Math.max(1, Number(config.logs.maxDays) || 30);
const DEFAULT_LIMIT = Math.min(200, Math.max(1, Number(config.logs.maxEntries) || 200));
let writeQueue = Promise.resolve();
let lastCleanupDay = '';

function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function logPath(date) { if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('日期格式错误，应为 YYYY-MM-DD'); return path.join(LOG_DIR, date + '.log'); }
async function ensureDir() { await fs.promises.mkdir(LOG_DIR, { recursive: true }); }
async function cleanupExpired() {
  const day = today();
  if (lastCleanupDay === day) return;
  lastCleanupDay = day;
  try {
    const cutoff = Date.now() - MAX_DAYS * 24 * 3600 * 1000;
    const names = await fs.promises.readdir(LOG_DIR).catch(() => []);
    await Promise.all(names.map(async (name) => {
      const match = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (!match) return;
      if (new Date(match[1] + 'T00:00:00').getTime() < cutoff) await fs.promises.unlink(path.join(LOG_DIR, name)).catch(() => {});
    }));
  } catch (error) { console.warn('[日志清理失败]', error?.message || error); }
}
function append(entry, date) {
  const d = date || today();
  const line = JSON.stringify({ t: entry?.t || '', cmd: entry?.cmd || '', badge: entry?.badge || '', out: entry?.out || '' }) + '\n';
  writeQueue = writeQueue.then(async () => { await ensureDir(); await fs.promises.appendFile(logPath(d), line, 'utf8'); await cleanupExpired(); }).catch((error) => { console.warn('[日志写入失败]', error?.message || error); });
  return writeQueue;
}
async function list(date, options = {}) {
  const raw = await fs.promises.readFile(logPath(date), 'utf8').catch((error) => { if (error?.code === 'ENOENT') return ''; throw error; });
  const limit = Math.min(200, Math.max(1, Number(options.limit) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(options.offset) || 0);
  const entries = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const value = JSON.parse(s);
      if (value && typeof value === 'object' && !Array.isArray(value)) entries.push({ t: value.t || '', cmd: value.cmd || '', badge: value.badge || '', out: value.out || '' });
    } catch (_) {}
  }
  const start = Math.max(0, entries.length - offset - limit);
  const end = Math.max(0, entries.length - offset);
  return { entries: entries.slice(start, end), total: entries.length, offset, limit, hasMore: start > 0 };
}
async function dates() {
  const names = await fs.promises.readdir(LOG_DIR).catch(() => []);
  return names.filter((name) => /^\d{4}-\d{2}-\d{2}\.log$/.test(name)).map((name) => name.slice(0, -4)).sort().reverse();
}
module.exports = { LOG_DIR, today, append, list, dates, cleanupExpired };
