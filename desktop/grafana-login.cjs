'use strict';

function createGrafanaLogin({ BrowserWindow, session, parent, getStatus, connect }) {
  let pending;
  let window;
  return function loginGrafana() {
    if (pending) {
      if (window && !window.isDestroyed()) window.focus();
      return pending;
    }
    pending = (async () => {
      const status = await getStatus();
      if (!status.configured) return { ok: false, message: '请先在本机 .env 配置 Grafana。' };
      const origin = new URL(status.baseUrl).origin;
      const loginSession = session.fromPartition('grafana-login', { cache: false });
      loginSession.setPermissionCheckHandler(() => false);
      loginSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
      return new Promise(resolve => {
        const controller = new AbortController();
        const win = window = new BrowserWindow({
          parent, width: 880, height: 680, title: '登录 Grafana', autoHideMenuBar: true,
          webPreferences: { session: loginSession, nodeIntegration: false, contextIsolation: true, sandbox: true },
        });
        const guard = (event, url) => {
          try { if (new URL(url).origin === origin) return; } catch (_) {}
          event.preventDefault();
        };
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('will-frame-navigate', event => guard(event, event.url));
        win.webContents.on('will-redirect', (event, url) => guard(event, event.url ?? url));
        let checking = false;
        function finish(result) {
          if (controller.signal.aborted) return;
          controller.abort();
          clearInterval(timer);
          loginSession.cookies.removeListener('changed', probe);
          if (!win.isDestroyed()) win.close();
          resolve(result);
        }
        async function probe() {
          if (checking || controller.signal.aborted) return;
          checking = true;
          try {
            const cookies = await loginSession.cookies.get({ url: origin + '/api/ds/query' });
            const cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ');
            if (cookie && !controller.signal.aborted && (await connect(cookie, controller.signal)).connected) finish({ ok: true });
          } catch (_) { /* 登录页仍打开，可继续登录。 */ }
          finally { checking = false; }
        }
        const timer = setInterval(probe, 2000);
        loginSession.cookies.on('changed', probe);
        win.webContents.on('did-finish-load', probe);
        win.once('closed', () => finish({ ok: false, message: '已取消 Grafana 登录。' }));
        win.loadURL(origin + '/login').catch(error => {
          if (error?.code !== 'ERR_ABORTED') finish({ ok: false, message: 'Grafana 登录页加载失败，请检查内网连接和平台地址。' });
        });
      });
    })().finally(() => { window = null; pending = null; });
    return pending;
  };
}

module.exports = { createGrafanaLogin };
