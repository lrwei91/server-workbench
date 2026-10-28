'use strict';

// 远端页面不加载 preload；平台 Cookie 只在主进程与本地后端之间传递。
function createDcosLogin({ BrowserWindow, session, parent, getStatus, connect }) {
  let pending = null, loginWindow = null;
  return async function login() {
    if (pending) { loginWindow?.focus(); return pending; }
    pending = (async () => {
      const status = await getStatus();
      if (!status.configured) return { ok: false, message: '请先配置云翼平台地址和集群。' };
      const base = new URL(status.baseUrl);
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return { ok: false, message: '云翼平台地址格式无效。' };
      const platformSession = session.fromPartition('dcos-login', { cache: false });
      platformSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      platformSession.setPermissionCheckHandler(() => false);
      return new Promise((resolve) => {
        const controller = new AbortController();
        let finished = false, checking = false;
        const window = new BrowserWindow({ parent, width: 1160, height: 800, title: '云翼平台 · 登录后自动连接', webPreferences: { session: platformSession, nodeIntegration: false, contextIsolation: true, sandbox: true } });
        loginWindow = window;
        window.setMenuBarVisibility(false);
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        // 只允许该平台来源导航，不把登录会话交给其他站点。
        const guard = (event, url) => {
          try { if (new URL(url).origin === base.origin) return; } catch (_) { /* 非 URL 导航同样拦截。 */ }
          event.preventDefault();
        };
        window.webContents.on('will-navigate', guard);
        window.webContents.on('will-redirect', guard);
        const finish = (result) => {
          if (finished) return;
          finished = true; clearInterval(timer); controller.abort();
          platformSession.cookies.removeListener('changed', check);
          resolve(result);
          if (!window.isDestroyed()) window.close();
        };
        const check = async () => {
          if (finished || checking) return;
          checking = true;
          try {
            const cookies = await platformSession.cookies.get({ url: new URL('/dcos/cluster/namespace/list', base).href });
            const cookie = cookies.map((item) => `${item.name}=${item.value}`).join('; ');
            if (!cookie || finished) return;
            const result = await connect(cookie, controller.signal);
            if (!finished && result.connected) finish({ ok: true, status: result });
          } catch (_) { /* 登录中、会话未生效或暂时网络异常：继续等待，不输出凭据。 */ }
          finally { checking = false; }
        };
        const timer = setInterval(() => void check(), 2000);
        platformSession.cookies.on('changed', check);
        window.webContents.on('did-finish-load', check);
        window.on('closed', () => finish({ ok: false, message: '已关闭登录窗口，尚未连接。' }));
        window.loadURL(new URL('/paas/cloudportal/site', base).href).catch(() => finish({ ok: false, message: '平台登录页加载失败，请检查地址和网络。' }));
        void check();
      });
    })();
    try { return await pending; }
    finally { pending = null; loginWindow = null; }
  };
}

module.exports = { createDcosLogin };
