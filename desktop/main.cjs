'use strict';
const { app, BrowserWindow, Menu, dialog, shell, utilityProcess, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const runtime = require('./runtime.cjs');
const { configureUpdates } = require('./updates.cjs');
const { parseEnv } = require('../server/config-loader');

// 与安装版分离，避免开发运行污染用户的正式配置和收藏。
if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'Server Workbench Dev'));
if (process.env.WORKBENCH_DESKTOP_SMOKE === '1' && process.env.WORKBENCH_SMOKE_DIR) app.setPath('userData', path.resolve(process.env.WORKBENCH_SMOKE_DIR));
const directory = app.getPath('userData');
let win, backend, cdr, origin, settings, updates, updateTimer, firstCheck;
let allowQuit = false, quitting = false, stopping = false;
let workbenchToken;
function log(message) {
  fs.mkdirSync(path.join(directory, 'logs'), { recursive: true });
  const target = path.join(directory, 'logs', 'desktop.log');
  if (fs.existsSync(target) && fs.statSync(target).size > 5 * 1024 * 1024) fs.renameSync(target, `${target}.1`);
  fs.appendFileSync(target, `${new Date().toISOString()} ${String(message)}\n`);
}
function messageBox(options) { return win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options); }
function notify(title, message) { return messageBox({ type: 'info', title, message }); }
async function confirm(title, message) {
  return (await messageBox({ type: 'question', title, message, buttons: ['取消', '继续'], defaultId: 0, cancelId: 0 })).response === 1;
}
function saveSettings() { runtime.writeSettings(directory, settings); }
function scheduleUpdates() {
  clearTimeout(firstCheck); clearInterval(updateTimer);
  if (!settings.automaticUpdates || !app.isPackaged) return;
  firstCheck = setTimeout(() => void updates.check(), 30000);
  updateTimer = setInterval(() => void updates.check(), 86400000);
}
function menu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '工作台', submenu: [
      { label: '编辑连接配置（重启生效）', click: async () => { const error = await shell.openPath(path.join(directory, '.env')); if (error) await notify('配置文件位置', path.join(directory, '.env')); } },
      { label: '选择话单源目录（重启生效）', click: async () => {
        const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: settings.sourceDir || path.join(directory, 'source') });
        if (!result.canceled) { settings.sourceDir = result.filePaths[0]; saveSettings(); await notify('话单源目录已保存', '退出后重新打开工作台生效。'); }
      } },
      { label: '打开导出目录', click: () => shell.openPath(cdrOutputDir) },
      { label: '打开配置与日志目录', click: () => shell.openPath(directory) },
      { type: 'separator' }, { label: '退出', accelerator: 'Alt+F4', click: () => void requestQuit() },
    ] },
    { label: '查看', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { label: '更新', submenu: [
      { label: '检查更新', click: () => void updates.check(true) },
      { label: '自动检查更新', type: 'checkbox', checked: settings.automaticUpdates, click: (item) => { settings.automaticUpdates = item.checked; saveSettings(); scheduleUpdates(); } },
      { label: '关于', click: () => notify('Server Workbench', `版本 ${app.getVersion()}\nWindows x64\n更新来源：lrwei91/server-workbench GitHub Releases`) },
    ] },
  ]));
}
let cdrOutputDir;
async function stopServices() {
  stopping = true;
  clearTimeout(firstCheck); clearInterval(updateTimer);
  const waits = [];
  if (backend && backend.pid) waits.push(new Promise((resolve) => {
    const timer = setTimeout(() => { backend.kill(); resolve(); }, 5000);
    backend.once('exit', () => { clearTimeout(timer); resolve(); });
    backend.postMessage('stop');
  }));
  if (cdr && cdr.exitCode === null && cdr.signalCode === null) waits.push(new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    cdr.once('exit', () => { clearTimeout(timer); resolve(); });
    cdr.kill();
  }));
  await Promise.all(waits);
}
async function requestQuit(installUpdate = false) {
  if (quitting) return;
  quitting = true;
  try {
    if (origin && !stopping) {
      const proceed = await runtime.confirmSessionClose(async () => {
        const response = await fetch(`${origin}/cdr/api/session`, { headers: { 'x-workbench-token': workbenchToken }, signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error('会话检查失败');
        return response.json();
      }, confirm);
      if (!proceed) return;
    }
    await stopServices(); allowQuit = true;
    if (installUpdate) autoUpdater.quitAndInstall(false, true);
    else app.quit();
  } finally { quitting = false; }
}
async function unexpectedExit(service) {
  if (stopping) return;
  log(`${service} exited unexpectedly`);
  await notify('本地服务已退出', `${service} 异常退出。请查看日志，然后重新启动工作台。`);
  await requestQuit();
}
async function start() {
  const envPath = runtime.prepareDirectories(directory, path.join(app.getAppPath(), '.env.example'));
  settings = { automaticUpdates: true, ...runtime.readSettings(directory) };
  if (!settings.backendPort) { settings.backendPort = await runtime.freePort(); saveSettings(); }
  const fileEnv = parseEnv(fs.readFileSync(envPath, 'utf8'));
  const cdrPort = await runtime.freePort();
  const cdrToken = randomBytes(32).toString('hex');
  workbenchToken = randomBytes(32).toString('hex');
  const env = runtime.childEnvironment(directory, fileEnv, settings, cdrPort, cdrToken);
  cdrOutputDir = env.CDR_OUTPUT_DIR;
  for (const value of [env.CDR_SOURCE_DIR, env.CDR_OUTPUT_DIR, env.CDR_LOG_DIR]) fs.mkdirSync(value, { recursive: true });
  const executable = app.isPackaged ? path.join(process.resourcesPath, 'cdr-service', 'cdr-service.exe') : process.env.WORKBENCH_PYTHON || 'python';
  cdr = spawn(executable, app.isPackaged ? [] : [path.join(app.getAppPath(), 'cdr', 'server.py')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  cdr.stdout.on('data', (chunk) => log(`[CDR] ${chunk}`)); cdr.stderr.on('data', (chunk) => log(`[CDR] ${chunk}`));
  cdr.on('error', (error) => log(error));
  cdr.once('exit', () => { if (origin) void unexpectedExit('CDR'); });
  await runtime.waitForService(`http://127.0.0.1:${cdrPort}/api/session`, cdrToken, () => Boolean(cdr.pid) && cdr.exitCode === null && cdr.signalCode === null);
  backend = utilityProcess.fork(path.join(__dirname, 'backend.cjs'), [], { env: { ...env, WORKBENCH_DESKTOP_PORT: String(settings.backendPort), WORKBENCH_SESSION_TOKEN: workbenchToken }, stdio: 'pipe', serviceName: 'Workbench Backend' });
  backend.stdout.on('data', (chunk) => log(`[Node] ${chunk}`)); backend.stderr.on('data', (chunk) => log(`[Node] ${chunk}`));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Node 服务启动超时')), 15000);
    backend.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Node 服务退出：${code}`)); });
    backend.once('message', (message) => { clearTimeout(timer); if (message.type === 'ready') resolve(message.port); else reject(new Error('Node 服务启动消息异常')); });
  });
  backend.on('exit', () => { if (origin) void unexpectedExit('Node'); });
  origin = `http://127.0.0.1:${port}`;
  // 首次分配的端口持久化，收藏/localStorage 在升级和重启后仍使用同一 origin。
  const browserSession = session.fromPartition('persist:workbench');
  browserSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
    details.requestHeaders['x-workbench-token'] = workbenchToken;
    callback({ requestHeaders: details.requestHeaders });
  });
  browserSession.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => callback({ responseHeaders: {
    ...details.responseHeaders,
    'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"],
  } }));
  // 保留现有复制功能，只允许本站写剪贴板，其他设备/读取权限拒绝。
  browserSession.setPermissionRequestHandler((contents, permission, callback) => callback(permission === 'clipboard-sanitized-write' && contents.getURL().startsWith(`${origin}/`)));
  browserSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permission === 'clipboard-sanitized-write' && requestingOrigin === origin);
  win = new BrowserWindow({ width: 1366, height: 768, minWidth: 1024, minHeight: 600, show: false, backgroundColor: '#ffffff', title: 'Server Workbench', webPreferences: { session: browserSession, nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guard = (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-frame-navigate', (event) => { if (new URL(event.url).origin !== origin) event.preventDefault(); });
  win.on('close', (event) => { if (!allowQuit) { event.preventDefault(); void requestQuit(); } });
  updates = configureUpdates({ updater: autoUpdater, packaged: app.isPackaged, notify, confirm, install: () => requestQuit(true), progress: (value) => { if (!win.isDestroyed()) win.setProgressBar(value); }, log });
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  menu();
  await win.loadURL(origin);
  win.show(); scheduleUpdates();
  if (process.env.WORKBENCH_DESKTOP_SMOKE === '1') {
    const result = await win.webContents.executeJavaScript('({title:document.title, width:innerWidth, body:document.body.innerText.slice(0,200)})');
    const screenshot = await win.webContents.capturePage();
    fs.mkdirSync(path.join(directory, 'smoke'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'smoke', 'workbench.png'), screenshot.toPNG());
    const cdrResult = await win.webContents.executeJavaScript(`(async () => {
      const response = await fetch('/cdr/api/session');
      if (!response.ok) throw new Error('CDR proxy: ' + response.status);
      const state = await response.json();
      document.querySelector('[data-primary-page="cdr"]').click();
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const frame = document.querySelector('#cdrFrame');
        if (frame.src && frame.contentDocument?.readyState === 'complete' && frame.contentDocument.body?.innerText.includes('导出')) return {state, title: frame.contentDocument.title};
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('CDR frame startup timeout');
    })()`);
    fs.writeFileSync(path.join(directory, 'smoke', 'cdr.png'), (await win.webContents.capturePage()).toPNG());
    log(`SMOKE_CDR ${JSON.stringify(cdrResult)}`);
    log(`SMOKE_READY ${JSON.stringify(result)}`);
    setTimeout(() => void requestQuit(), 1000);
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('before-quit', (event) => { if (!allowQuit) { event.preventDefault(); void requestQuit(); } });
  app.whenReady().then(start).catch(async (error) => { log(error.stack || error); await notify('工作台启动失败', `${error.message}\n日志：${path.join(directory, 'logs')}`); await stopServices(); allowQuit = true; app.quit(); });
}
