'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

function readSettings(directory) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, 'desktop.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function writeSettings(directory, settings) {
  const target = path.join(directory, 'desktop.json');
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(settings, null, 2));
  fs.renameSync(`${target}.tmp`, target);
}
function prepareDirectories(directory, example) {
  fs.mkdirSync(directory, { recursive: true });
  for (const name of ['logs', 'source', 'outputs']) fs.mkdirSync(path.join(directory, name), { recursive: true });
  const env = path.join(directory, '.env');
  if (!fs.existsSync(env)) fs.copyFileSync(example, env, fs.constants.COPYFILE_EXCL);
  return env;
}
function childEnvironment(directory, fileEnv, settings, cdrPort, cdrToken) {
  return {
    ...process.env, ...fileEnv,
    WORKBENCH_CONFIG_DIR: directory, WORKBENCH_DATA_DIR: directory,
    WORKBENCH_HOST: '127.0.0.1',
    CDR_PORT: String(cdrPort), CDR_UPSTREAM: `http://127.0.0.1:${cdrPort}`,
    CDR_SESSION_TOKEN: cdrToken,
    CDR_SOURCE_DIR: settings.sourceDir || fileEnv.CDR_SOURCE_DIR || path.join(directory, 'source'),
    CDR_OUTPUT_DIR: fileEnv.CDR_OUTPUT_DIR || path.join(directory, 'outputs'),
    CDR_LOG_DIR: path.join(directory, 'logs', 'cdr'),
  };
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
async function waitForService(url, token, alive, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive()) throw new Error('本地服务提前退出，请查看桌面日志');
    try {
      const response = await fetch(url, { headers: { 'x-cdr-token': token }, signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch (_) { /* 等待服务实际就绪，不复用其他进程。 */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('本地服务启动超时，请查看桌面日志');
}
function notesText(notes) {
  if (typeof notes === 'string') return notes.replace(/<[^>]*>/g, '').slice(0, 4000);
  if (Array.isArray(notes)) return notes.map((item) => notesText(item.note)).join('\n').slice(0, 4000);
  return '';
}
async function confirmSessionClose(getSession, confirm) {
  let state;
  try { state = await getSession(); }
  catch (_) { return confirm('话单会话状态待确认', '本地服务未返回会话状态。仍要退出？'); }
  return !state.dirty || confirm('话单尚未导出', '当前话单会话尚未导出。继续将丢弃内存中的会话，请先取消并导出，或确认继续。');
}
module.exports = { readSettings, writeSettings, prepareDirectories, childEnvironment, freePort, waitForService, notesText, confirmSessionClose };
