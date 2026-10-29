const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDcosLogin } = require('../../desktop/dcos-login.cjs');

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(connect, { loginUrl = 'http://platform.test:9001/auth/login', discoveryStatus = 401, getCredentials } = {}) {
  const windows = [], partitions = [], urls = [], discovery = [];
  let values = [];
  const cookies = new EventEmitter();
  cookies.get = async ({ url }) => { urls.push(url); return values; };
  const platform = { cookies, setPermissionRequestHandler(fn) { this.permission = fn; }, setPermissionCheckHandler(fn) { this.checkPermission = fn; } };
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = (fn) => { this.popup = fn; }; windows.push(this); }
    setMenuBarVisibility() {}
    loadURL(url) { this.url = url; return Promise.resolve(); }
    isDestroyed() { return this.closed; }
    close() { this.closed = true; this.emit('closed'); }
    focus() { this.focused = true; }
  }
  const login = createDcosLogin({ BrowserWindow: Window, session: { fromPartition(name) { partitions.push(name); return platform; } }, parent: {}, getStatus: async () => ({ configured: true, baseUrl: 'http://platform.test:8081' }), connect,
    getCredentials,
    fetchImpl: async (url, options) => { discovery.push({ url, options }); return { status: discoveryStatus, ok: discoveryStatus === 200, json: async () => ({ loginUrl }) }; },
  });
  return { login, windows, partitions, urls, cookies, platform, discovery, setCookies(next) { values = next; cookies.emit('changed'); } };
}

test('自动填充只进入声明的认证路径，不提交表单或向门户页传递凭据', async () => {
  const origins = [], scripts = [];
  const f = fixture(async () => ({ connected: false }), { getCredentials: origin => { origins.push(origin); return { username: 'fixture-user', password: 'fixture-password' }; } });
  const pending = f.login(); await tick();
  const contents = f.windows[0].webContents;
  contents.executeJavaScript = async script => scripts.push(script);
  for (const url of ['http://platform.test:8081/paas/cloudportal/site', 'http://platform.test:9001/other']) {
    contents.getURL = () => url; contents.emit('did-finish-load'); await tick();
  }
  assert.equal(scripts.length, 0); assert.equal(origins.length, 0);
  contents.getURL = () => 'http://platform.test:9001/auth/login'; contents.emit('did-finish-load'); await tick();
  assert.deepEqual(origins, ['http://platform.test:8081']); assert.equal(scripts.length, 1);
  assert.match(scripts[0], /user.value \|\| password.value/);
  assert.equal(scripts[0].includes('.submit('), false);
  assert.equal(scripts[0].includes('.click('), false);
  f.windows[0].close(); await pending;
});

test('网页登录隔离内存会话，只将平台适用的 Cookie 交本地验证，成功自动关闭', async () => {
  const calls = [];
  const f = fixture(async (cookie) => { calls.push(cookie); return { connected: true, baseUrl: 'http://platform.test:8081' }; });
  const first = f.login(); await tick();
  const repeated = f.login(); await tick();
  assert.equal(f.windows.length, 1); assert.equal(f.windows[0].focused, true);
  assert.deepEqual(f.partitions, ['dcos-login']);
  assert.equal(f.windows[0].options.webPreferences.preload, undefined);
  assert.equal(f.windows[0].options.webPreferences.sandbox, true);
  assert.equal(f.windows[0].options.webPreferences.nodeIntegration, false);
  assert.equal(f.windows[0].url, 'http://platform.test:8081/paas/cloudportal/site');
  assert.equal(f.platform.checkPermission(), false);
  assert.deepEqual(f.windows[0].popup(), { action: 'deny' });
  assert.equal(f.discovery[0].url.href, 'http://platform.test:8081/cloudportal/iam/users/current');
  assert.equal(f.discovery[0].options.redirect, 'error');
  assert.equal(f.discovery[0].options.headers.Cookie, undefined);
  f.setCookies([{ name: 'SESSION', value: 'fixture-secret' }]);
  const result = await first;
  assert.deepEqual(await repeated, result);
  assert.deepEqual(calls, ['SESSION=fixture-secret']);
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  assert.equal(f.urls[0], 'http://platform.test:8081/dcos/cluster/namespace/list');
  assert.equal(f.windows[0].closed, true); assert.equal(f.cookies.listenerCount('changed'), 0);
});

test('允许平台声明的跨端口登录及返回门户，兼容 details.url，不放开其他来源', async () => {
  const f = fixture(async () => ({ connected: false }));
  const pending = f.login(); await tick();
  let blocked = false;
  const preventDefault = () => { blocked = true; };
  for (const url of ['http://platform.test:8081/paas/cloudportal/console/#/overview', 'http://platform.test:9001/auth/login']) {
    f.windows[0].webContents.emit('will-navigate', { url, isMainFrame: true, preventDefault });
    f.windows[0].webContents.emit('will-redirect', { url, isMainFrame: true, preventDefault });
  }
  // 平台认证链接也可能采用独立身份站点，来源由平台接口声明而非端口通配。
  f.windows[0].webContents.emit('will-navigate', { preventDefault }, 'http://platform.test:8081/paas/cloudportal/site');
  assert.equal(blocked, false);
  f.windows[0].webContents.emit('will-redirect', { url: 'http://platform.test:9002/auth/login', isMainFrame: true, preventDefault });
  const result = await pending;
  assert.equal(blocked, true); assert.equal(result.ok, false);
  assert.match(result.message, /跳转被拦截/);
});

test('无效认证地址或发现接口失败明确提示，不打开空白窗口', async () => {
  for (const options of [{ loginUrl: 'javascript:alert(1)' }, { loginUrl: '' }, { loginUrl: 'http://user:secret@auth.test/login' }, { discoveryStatus: 503 }]) {
    const f = fixture(async () => ({ connected: true }), options);
    assert.equal((await f.login()).ok, false); assert.equal(f.windows.length, 0);
  }
});

test('完整 CAS 三来源链放行 service 回调，不放开同主机其他端口', async () => {
  const loginUrl = 'http://platform.test:9001/auth/login?service=' + encodeURIComponent('http://platform.test:8787/cas?client_name=it_paas');
  const f = fixture(async () => ({ connected: false }), { loginUrl });
  const pending = f.login(); await tick();
  let blocked = false;
  for (const url of [loginUrl, 'http://platform.test:8787/cas?ticket=fixture', 'http://platform.test:8081/paas/cloudportal/console/#/overview']) {
    f.windows[0].webContents.emit('will-redirect', { url, isMainFrame: true, preventDefault() { blocked = true; } });
  }
  assert.equal(blocked, false);
  f.windows[0].webContents.emit('will-navigate', { url: 'http://platform.test:8788/cas', isMainFrame: true, preventDefault() { blocked = true; } });
  assert.equal((await pending).ok, false); assert.equal(blocked, true);
  const invalid = fixture(async () => ({ connected: true }), { loginUrl: 'http://platform.test:9001/auth/login?service=javascript%3Aalert(1)' });
  assert.equal((await invalid.login()).ok, false); assert.equal(invalid.windows.length, 0);
});

test('独立认证站点仅按平台返回地址放行，Cookie 仍仅读取门户 API 适用范围', async () => {
  const f = fixture(async () => ({ connected: true }), { loginUrl: 'https://identity.test/auth/login?redirect=portal' });
  const pending = f.login(); await tick();
  let blocked = false;
  f.windows[0].webContents.emit('will-redirect', { url: 'https://identity.test/auth/login', isMainFrame: true, preventDefault() { blocked = true; } });
  assert.equal(blocked, false);
  f.setCookies([{ name: 'SESSION', value: 'fixture' }]);
  assert.equal((await pending).ok, true);
  assert.ok(f.urls.every(url => url === 'http://platform.test:8081/dcos/cluster/namespace/list'));
});

test('主页面加载异常明确提示，正常重定向取消不终止登录', async () => {
  const f = fixture(async () => ({ connected: false }));
  const pending = f.login(); await tick();
  f.windows[0].webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://platform.test:8081/', true);
  assert.equal(f.windows[0].closed, undefined);
  f.windows[0].webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'http://platform.test:9001/auth/login', true);
  assert.match((await pending).message, /加载失败（-105）/);
  assert.equal(f.cookies.listenerCount('changed'), 0);
});

test('登录中验证失败继续等待，关闭会取消正在执行的验证并清理监听', async () => {
  let calls = 0, signal;
  const f = fixture(async (_cookie, nextSignal) => {
    calls++; signal = nextSignal;
    if (calls === 1) throw new Error('not logged in');
    return new Promise((resolve) => nextSignal.addEventListener('abort', () => resolve({ connected: false }), { once: true }));
  });
  const pending = f.login(); await tick();
  f.setCookies([{ name: 'SESSION', value: 'pre-login' }]); await tick();
  assert.equal(f.windows[0].closed, undefined);
  f.setCookies([{ name: 'SESSION', value: 'post-login' }]); await tick();
  f.windows[0].close();
  assert.equal((await pending).ok, false); assert.equal(signal.aborted, true);
  assert.equal(f.cookies.listenerCount('changed'), 0);
});
