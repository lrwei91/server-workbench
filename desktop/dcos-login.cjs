'use strict';

// 远端页面不加载 preload；平台 Cookie 只在主进程与本地后端之间传递。
function createDcosLogin({ BrowserWindow, session, parent, getStatus, connect, getCredentials = () => null, fetchImpl = fetch }) {
  let pending = null, loginWindow = null;
  return async function login() {
    if (pending) { loginWindow?.focus(); return pending; }
    pending = (async () => {
      const status = await getStatus();
      if (!status.configured) return { ok: false, message: '请先配置云翼平台地址和集群。' };
      const base = new URL(status.baseUrl);
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return { ok: false, message: '云翼平台地址格式无效。' };
      // 门户与认证服务可能使用不同端口；仅信任配置平台返回的 loginUrl，不放开任意站点。
      const allowedOrigins = new Set([base.origin]);
      let authenticationUrl;
      try {
        const response = await fetchImpl(new URL('/cloudportal/iam/users/current', base), { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (response.status === 401) {
          const payload = await response.json();
          if (typeof payload.loginUrl !== 'string' || !payload.loginUrl.trim()) throw new Error('missing loginUrl');
          const target = new URL(payload.loginUrl, base);
          if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('invalid loginUrl');
          allowedOrigins.add(target.origin);
          authenticationUrl = target;
          // CAS 在 loginUrl.service 声明登录成功后的回调，端口可能与门户/认证均不同。
          const service = target.searchParams.get('service');
          if (service) {
            const callback = new URL(service);
            if (!['http:', 'https:'].includes(callback.protocol) || callback.username || callback.password) throw new Error('invalid CAS service');
            allowedOrigins.add(callback.origin);
          }
        } else if (!response.ok) throw new Error('login discovery failed');
      } catch (_) { return { ok: false, message: '读取平台登录地址失败，请检查网络或使用手动 Cookie 连接。' }; }
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
        // 只允许门户与其声明的认证来源；兼容 Electron 当前 details.url 事件形式。
        const guard = (event, legacyUrl) => {
          if (event.isMainFrame === false) return;
          let target;
          try {
            target = new URL(event.url || legacyUrl);
            if (['http:', 'https:'].includes(target.protocol) && !target.username && !target.password && allowedOrigins.has(target.origin)) return;
          } catch (_) { /* 非 URL 导航同样拦截。 */ }
          event.preventDefault();
          finish({ ok: false, message: `平台登录跳转被拦截${target?.origin && target.origin !== 'null' ? `（${target.origin}）` : ''}，请检查平台登录地址配置。` });
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
        window.webContents.on('did-finish-load', async () => {
          if (!authenticationUrl || finished) return;
          try {
            const current = new URL(window.webContents.getURL());
            if (current.origin !== authenticationUrl.origin || current.pathname !== authenticationUrl.pathname) return;
            const credentials = await getCredentials(base.origin);
            if (!credentials?.username || !credentials?.password || finished) return;
            // 仅填充门户声明的认证页；不提交、不覆盖已输入内容、不持有远端 preload。
            await window.webContents.executeJavaScript(`(() => {
              if (location.origin !== ${JSON.stringify(authenticationUrl.origin)} || location.pathname !== ${JSON.stringify(authenticationUrl.pathname)}) return;
              const user = document.querySelector('input[name="username"], input#username');
              const password = document.querySelector('input[type="password"][name="password"], input[type="password"]#password');
              if (!user || !password || user.value || password.value) return;
              const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              for (const [input, value] of [[user, ${JSON.stringify(credentials.username)}], [password, ${JSON.stringify(credentials.password)}]]) {
                set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
              }
            })()`);
          } catch (_) { /* 自动填充不可用时保留手动登录，不输出凭据。 */ }
        });
        window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
          // ERR_ABORTED 是重定向/页面接管导致的正常取消，不中断后续登录。
          if (isMainFrame && code !== -3) finish({ ok: false, message: `平台登录页加载失败（${code}），请检查地址和网络。` });
        });
        window.on('closed', () => finish({ ok: false, message: '已关闭登录窗口，尚未连接。' }));
        window.loadURL(new URL('/paas/cloudportal/site', base).href).catch((error) => {
          if (error.code !== 'ERR_ABORTED' && error.errno !== -3) finish({ ok: false, message: '平台登录页加载失败，请检查地址和网络。' });
        });
        void check();
      });
    })();
    try { return await pending; }
    finally { pending = null; loginWindow = null; }
  };
}

module.exports = { createDcosLogin };
