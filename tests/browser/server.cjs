'use strict';
// Isolated local services: no developer credentials, no writes to business files.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-browser-'));
let cdr, server, closing = false;
async function close() {
  if (closing) return; closing = true;
  server?.closeAllConnections(); server?.close();
  if (cdr && cdr.exitCode === null) { cdr.kill(); await new Promise(resolve => { cdr.once('exit', resolve); setTimeout(resolve, 3000).unref(); }); }
  fs.rmSync(directory, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', close); process.on('SIGINT', close);
(async () => {
  const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const cdrPort = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const source = path.join(directory, 'source'); fs.mkdirSync(source);
  for (const name of ['sample.json', 'other.json']) fs.copyFileSync(path.join(root, 'tests/fixtures/sample.ndjson'), path.join(source, name));
  Object.assign(process.env, { WORKBENCH_CONFIG_DIR: directory, WORKBENCH_DATA_DIR: directory, CDR_UPSTREAM: `http://127.0.0.1:${cdrPort}`, CDR_PORT: String(cdrPort), CDR_SOURCE_DIR: source, CDR_OUTPUT_DIR: path.join(directory, 'exports'), CDR_LOG_DIR: path.join(directory, 'cdr-logs'), CDR_SESSION_TOKEN: '', WORKBENCH_SESSION_TOKEN: '' });
  fs.writeFileSync(path.join(directory, '.env'), '');
  cdr = spawn(process.env.WORKBENCH_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['cdr/server.py'], { cwd: root, env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
  cdr.on('error', error => { console.error(error); void close(); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`${process.env.CDR_UPSTREAM}/api/session`)).ok; } catch (_) {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('CDR test server did not become ready');
  server = require('../../server/server').createServer();
  server.listen(Number(process.env.WORKBENCH_E2E_PORT || 18755), '127.0.0.1');
})().catch(error => { console.error(error); void close(); });
