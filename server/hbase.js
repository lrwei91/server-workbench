/**
 * HBase 浏览器（只读）
 *
 * 职责：
 *   1. 执行 hbase shell 命令并解析结构化输出
 *   2. 列出 namespace / namespace 下的表 / 扫描表数据
 *
 * 说明：
 *   - HBase shell 输出带 SLF4J 启动日志、版本号、Took 耗时等杂讯，解析时只取
 *     header（NAMESPACE / TABLE）与 row(s) 之间的区域。
 *   - 扫描结果直接返回原始文本和输出截断标志，不做复杂结构化（HBase shell 的表格式行/列/值/时间戳
 *     混在一起，整段输出即可满足排障查看）。
 */
'use strict';

const ssh = require('./ssh');
const config = require('./config-loader');
const HBASE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

// 单引号 shell 转义（从 hdfs.js 复用思路）
function shellQuote(s) {
  return "'" + String(s == null ? '' : s).replace(/'/g, "'\\''") + "'";
}

function requireHbaseName(value, label) {
  const name = String(value || '');
  if (!HBASE_NAME_RE.test(name)) throw new Error(`${label}包含不支持的字符`);
  return name;
}

async function hbaseExec(command) {
  const fullCmd = 'echo ' + shellQuote(command) + ' | hbase shell';
  // HBase shell 启动也慢（JVM），且 scan 可能慢，超时放宽到 120s
  const r = await ssh.execCommand(fullCmd, config.hbaseTimeoutMs || 120000);
  if (r.timedOut || r.code === 124) throw new Error('HBase shell 执行超时（JVM 冷启动较慢），请稍后重试');
  if (r.code !== 0) throw new Error('HBase shell 执行失败：' + (r.stderr || r.stdout || ('退出码 ' + r.code)));
  return { text: r.stdout || '', truncated: Boolean(r.truncated) };
}

// 解析 list_namespace / list_namespace_tables 输出：
//   banner 里也可能有 Took 行，故结束标记（row(s)/Took）只在 header 之后才生效
function parseList(output, header) {
  const lines = String(output).split('\n').map((l) => l.trim()).filter(Boolean);
  const items = [];
  let collecting = false;
  for (const line of lines) {
    if (line === header) { collecting = true; continue; }
    if (collecting && (/^\d+ row\(s\)/.test(line) || /^Took [\d.]+ second/.test(line))) break;
    if (collecting && line && !line.startsWith('SLF4J') && !line.includes('HBase Shell') && !line.includes('Version ')) {
      items.push(line);
    }
  }
  return items;
}

async function hbaseList(hbasePath) {
  const p = String(hbasePath || '/').trim() || '/';
  // 根路径：列出 namespace
  if (p === '/' || p === '') {
    const { text: out } = await hbaseExec('list_namespace');
    const namespaces = parseList(out, 'NAMESPACE');
    return {
      path: '/',
      items: namespaces.map((name) => ({ name, isDir: true, path: '/' + name, mtime: '' })),
    };
  }
  // /namespace 路径：列出该 namespace 下的表
  const match = p.match(/^\/([^/]+)$/);
  if (!match) throw new Error('HBase 路径格式应为 / 或 /namespace');
  const ns = requireHbaseName(match[1], 'HBase namespace');
  const { text: out } = await hbaseExec('list_namespace_tables ' + shellQuote(ns));
  const tables = parseList(out, 'TABLE');
  return {
    path: '/' + ns,
    items: tables.map((name) => ({ name, isDir: false, path: '/' + ns + ':' + name, mtime: '' })),
  };
}

async function hbaseScan(tablePath, limit = 20) {
  const clean = String(tablePath || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = clean.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('扫描表路径格式应为 /namespace:table');
  const ns = requireHbaseName(parts[0], 'HBase namespace');
  const table = requireHbaseName(parts[1], 'HBase 表名');
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const result = await hbaseExec('scan \'' + ns + ':' + table + '\', {LIMIT => ' + capped + '}');
  return { table: ns + ':' + table, limit: capped, text: stripBanner(result.text), truncated: result.truncated };
}

// 剥离 HBase shell 的启动 banner（HBase Shell 提示、Version、首个 Took 等），
// 只保留从实际命令回显开始的内容，使 scan 结果更干净。
function stripBanner(output) {
  const lines = String(output).split('\n');
  const start = lines.findIndex((l) => /^list_namespace$|^list_namespace_tables|^scan /.test(l.trim()));
  if (start >= 0) return lines.slice(start).join('\n').replace(/\n+$/, '');
  return output;
}

module.exports = { hbaseList, hbaseScan };
