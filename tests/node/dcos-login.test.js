const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDcosLogin } = require('../../desktop/dcos-login.cjs');

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(connect) {
  const windows = [], partitions = [], urls = [];
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
  const login = createDcosLogin({ BrowserWindow: Window, session: { fromPartition(name) { partitions.push(name); return platform; } }, parent: {}, getStatus: async () => ({ configured: true, baseUrl: 'http://platform.test:8081' }), connect });
  return { login, windows, partitions, urls, cookies, platform, setCookies(next) { values = next; cookies.emit('changed'); } };
}

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
  let blocked = false;
  f.windows[0].webContents.emit('will-navigate', { preventDefault() { blocked = true; } }, 'https://other.test');
  assert.equal(blocked, true);
  f.setCookies([{ name: 'SESSION', value: 'fixture-secret' }]);
  const result = await first;
  assert.deepEqual(await repeated, result);
  assert.deepEqual(calls, ['SESSION=fixture-secret']);
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  assert.equal(f.urls[0], 'http://platform.test:8081/dcos/cluster/namespace/list');
  assert.equal(f.windows[0].closed, true); assert.equal(f.cookies.listenerCount('changed'), 0);
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
