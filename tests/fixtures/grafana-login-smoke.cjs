// Run via electron tests/fixtures/grafana-login-smoke.cjs; no real platform or credentials.
'use strict';
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGrafanaLogin } = require('../../desktop/grafana-login.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-grafana-smoke-'));
app.setPath('userData', directory);
const servers = [];
const listen = server => new Promise((resolve, reject) => {
  servers.push(server);
  server.once('error', reject).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});

const timeout = setTimeout(() => {
  console.error('Grafana desktop smoke timed out');
  app.exit(1);
}, 20000);
app.on('will-quit', () => { clearTimeout(timeout); for (const server of servers) server.close(); });
app.whenReady().then(async () => {
  process.env.GRAFANA_BASE_URL = await listen(http.createServer(async (req, res) => {
    if (req.url === '/login') {
      res.writeHead(302, { 'Set-Cookie': 'grafana_session=smoke; Path=/; HttpOnly; SameSite=Lax', Location: '/dashboard' });
      return res.end();
    }
    if (req.url === '/dashboard') return res.end('Grafana fixture');
    if (req.headers.cookie !== 'grafana_session=smoke') { res.writeHead(401); return res.end(); }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/user') return res.end(JSON.stringify({ id: 1 }));
    if (req.url === '/api/ds/query?ds_type=mysql' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { queries } = JSON.parse(Buffer.concat(chunks));
      if (queries[0].rawSql.startsWith('SELECT service_name')) {
        return res.end(JSON.stringify({ results: { A: { status: 200, frames: [{
          schema: { fields: [{ name: 'service_name' }] }, data: { values: [['other-test-service', 'smoke-test-service']] },
        }] } } }));
      }
      const fields = ['time', 'body', 'level', 'service_instance_id', 'scope_name', 'trace_id', 'span_id'].map(name => ({ name }));
      return res.end(JSON.stringify({ results: { A: { status: 200, frames: [{ schema: { fields }, data: {
        values: [[1794290700000], ['Grafana smoke log'], ['INFO'], ['smoke-0'], ['scope'], [''], ['']],
      } }] } } }));
    }
    res.writeHead(404);
    res.end();
  }));
  process.env.GRAFANA_DATASOURCE_UID = 'smoke';
  process.env.WORKBENCH_CONFIG_DIR = directory;
  process.env.WORKBENCH_DATA_DIR = directory;
  const origin = await listen(require('../../server/server').createServer({ token: 'smoke' }));
  const local = session.fromPartition('smoke-workbench');
  local.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, reply) => {
    reply({ requestHeaders: { ...details.requestHeaders, 'x-workbench-token': 'smoke' } });
  });
  const parent = new BrowserWindow({ show: false, webPreferences: {
    session: local, preload: path.resolve(__dirname, '../../desktop/preload.cjs'), sandbox: true, contextIsolation: true,
  } });
  const api = async (route, options) => {
    const res = await fetch(`${origin}/api/grafana/${route}`, { ...options, headers: { 'x-workbench-token': 'smoke' } });
    assert.equal(res.status, 200);
    return res.json();
  };
  const login = createGrafanaLogin({
    BrowserWindow: class extends BrowserWindow { constructor(opts) { super({ ...opts, show: false }); } },
    session, parent, getStatus: () => api('login-status'),
    connect: (cookie, signal) => api('connect', { method: 'POST', body: JSON.stringify({ cookie }), signal }),
  });
  ipcMain.handle('grafana:login', event => {
    assert.equal(event.senderFrame, parent.webContents.mainFrame);
    return login();
  });
  await parent.loadURL(`${origin}/#/businessLogs`);
  const result = await parent.webContents.executeJavaScript(`(async () => {
    const login = document.getElementById('grafanaLogin');
    const button = document.getElementById('grafanaLogSearch');
    const services = document.getElementById('grafanaLogService');
    const wait = async (ready) => { while (!ready()) await new Promise(resolve => setTimeout(resolve, 25)); };
    await wait(() => !login.disabled);
    login.click();
    await wait(() => !services.disabled);
    if (services.value || !button.disabled) throw new Error('Unexpected initial service selection');
    services.focus();
    services.value = 'MOKE';
    services.dispatchEvent(new Event('input', { bubbles: true }));
    const matches = document.querySelectorAll('#grafanaServiceOptions [role="option"]');
    if (matches.length !== 1 || matches[0].textContent !== 'smoke-test-service') throw new Error('Unexpected filtered services');
    matches[0].click();
    await wait(() => !button.disabled);
    button.click();
    await wait(() => document.querySelector('#grafanaLogResults pre'));
    return { body: document.querySelector('#grafanaLogResults pre').textContent, cookie: document.cookie };
  })()`);
  assert.deepEqual(result, { body: 'Grafana smoke log', cookie: '' });
  console.log('GRAFANA_LOGIN_SMOKE_OK');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
