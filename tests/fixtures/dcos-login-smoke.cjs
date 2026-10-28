// 手动桌面验收：electron tests/fixtures/dcos-login-smoke.cjs；仅连接本地模拟平台。
const { app, BrowserWindow, ipcMain, session } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { createDcosLogin } = require('../../desktop/dcos-login.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dcos-desktop-smoke-'));
app.setPath('userData', directory);
let upstream, backend;
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
app.whenReady().then(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/paas/cloudportal/site') {
      res.setHeader('Content-Type', 'text/html;charset=utf-8');
      return res.end('<h1>云翼模拟登录</h1><p>此页仅用于本地验收，无真实账号或密码。</p><form action="/login" method="post"><button>完成模拟登录</button></form>');
    }
    if (req.url === '/login') { res.writeHead(302, { 'Set-Cookie': 'SESSION=smoke; HttpOnly; Path=/', Location: '/paas/cloudportal/site' }); return res.end(); }
    if (req.headers.cookie !== 'SESSION=smoke') { res.writeHead(401); return res.end(); }
    res.setHeader('Content-Type', 'application/json');
    const send = (data) => res.end(JSON.stringify({ code: 0, data }));
    if (req.url.startsWith('/dcos/cluster/namespace/list')) return send([{ namespaceName: 'bill-cnos-jf' }]);
    if (req.url.startsWith('/dcos/workload/page/')) {
      let body = ''; req.on('data', (part) => { body += part; });
      return req.on('end', () => { const { workloadKind } = JSON.parse(body); send({ records: [{ workloadName: workloadKind === 'Deployment' ? 'rating-backend-test' : 'rating-process-dev', workloadKind, runningPodNum: 1 }], total: 1 }); });
    }
    if (req.url.startsWith('/dcos/workload/pods/')) return send([{ podName: 'smoke-pod', podStatus: 'Running', containers: [{ name: 'main' }] }]);
    if (req.url.startsWith('/dcos/workload/containerLogs')) return send(['本地模拟日志：登录桥接与工作负载选择验收成功']);
    res.writeHead(404); res.end();
  });
  process.env.DCOS_BASE_URL = await listen(upstream);
  process.env.DCOS_CLUSTERS = '321:smoke-cluster';
  process.env.WORKBENCH_CONFIG_DIR = directory;
  process.env.WORKBENCH_DATA_DIR = directory;
  backend = require('../../server/server').createServer({ token: 'smoke-token' });
  const origin = await listen(backend);
  const localSession = session.fromPartition('smoke-workbench');
  localSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => { details.requestHeaders['x-workbench-token'] = 'smoke-token'; callback({ requestHeaders: details.requestHeaders }); });
  const win = new BrowserWindow({ width: 1366, height: 768, title: 'DCOS 登录验收', webPreferences: { session: localSession, preload: path.resolve(__dirname, '../../desktop/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.setMenuBarVisibility(false);
  const api = async (route, options = {}) => {
    const response = await fetch(`${origin}/api/dcos/${route}`, { ...options, headers: { 'x-workbench-token': 'smoke-token', 'Content-Type': 'application/json' } });
    const result = await response.json(); if (!result.ok) throw new Error('smoke authentication pending'); return result;
  };
  const login = createDcosLogin({ BrowserWindow, session, parent: win, getStatus: () => api('status'), connect: (cookie, signal) => api('connect', { method: 'POST', body: JSON.stringify({ cookie }), signal }) });
  ipcMain.handle('dcos:login', (event) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return { ok: false };
    return login();
  });
  await win.loadURL(origin);
  win.show();
  console.log('DCOS_LOGIN_SMOKE_READY');
});
app.on('window-all-closed', () => { backend?.closeAllConnections(); backend?.close(); upstream?.closeAllConnections(); upstream?.close(); app.quit(); });
