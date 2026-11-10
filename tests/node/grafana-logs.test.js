'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once, EventEmitter } = require('node:events');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { makeQuery } = require('../../server/grafana-logs');
const { createGrafanaLogin } = require('../../desktop/grafana-login.cjs');

test('Grafana SQL is fixed and filters are bounded', () => {
  const filters = { service: 'rating-test', minutes: 60, limit: 500, level: 'WARN' };
  const config = { datasourceUid: 'fixture', datasourceId: 2 };
  const query = makeQuery(filters, config, 1794290823541);
  assert.equal(Number(query.to) - Number(query.from), 3600000);
  assert.deepEqual(query.queries[0].datasource, { uid: 'fixture', type: 'mysql' });
  assert.match(query.queries[0].rawSql, /FROM oteldb\.otel_logs\s+WHERE \$__timeFilter\(timestamp\)/);
  assert.match(query.queries[0].rawSql, /service_name = 'rating-test'\s+AND severity_text = 'WARN'/);
  assert.doesNotMatch(query.queries[0].rawSql, /service_instance_id\s*=/);
  assert.match(query.queries[0].rawSql, /DATE_SUB\(timestamp, INTERVAL 8 HOUR\)/);
  assert.match(query.queries[0].rawSql, /ORDER BY timestamp DESC\s+LIMIT 500$/);
  for (const invalid of [{ service: '' }, { service: "x' OR 1=1" }, { minutes: 2880 }, { limit: 5000 }, { level: "WARN'--" }]) {
    assert.throws(() => makeQuery({ ...filters, ...invalid }, config), { code: 'GRAFANA_INVALID_FILTER' });
  }
});

test('desktop bridge signs in, queries MySQL frames, and clears expired sessions', async t => {
  const upstreamCalls = [];
  const columns = {
    body: ['newest\nsecond line', 'older'], span_id: ['span', ''], time: [1794290700000, 1794290699000],
    scope_name: ['scope', 'scope'], level: ['WARN', 'WARN'], service_instance_id: ['rating-test-0', 'rating-test-1'],
    trace_id: ['trace', ''],
  };
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamCalls.push({ path: req.url, method: req.method, cookie: req.headers.cookie,
      org: req.headers['x-grafana-org-id'], body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/user') {
      res.setHeader('Set-Cookie', 'grafana_session=rotated; Path=/; HttpOnly');
      return res.end(JSON.stringify({ id: 7 }));
    }
    if (upstreamCalls.length === 4) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    if (upstreamCalls.at(-1).body.queries[0].rawSql.startsWith('SELECT service_name')) {
      const sql = upstreamCalls.at(-1).body.queries[0].rawSql;
      const candidates = ['', 'rating-test', 'another-TEST-service', 'only-dev', 'rating-test-748cfdb787-k54g8',
        'rating-test-56f7dd4c66-mtrm8', 'rating-test-0', 'rating-test', null];
      const matching = sql.includes("LOWER(service_name) LIKE '%test%'") ?
        candidates.filter(name => name?.toLowerCase().includes('test')) : candidates;
      return res.end(JSON.stringify({ results: { A: { status: 200, frames: [{
        schema: { fields: [{ name: 'service_name' }] },
        data: { values: [matching] },
      }] } } }));
    }
    res.end(JSON.stringify({ results: { A: { status: 200, frames: [{
      schema: { fields: Object.keys(columns).map(name => ({ name })) }, data: { values: Object.values(columns) },
    }] } } }));
  }).listen(0, '127.0.0.1');
  t.after(() => upstream.close());
  await once(upstream, 'listening');
  process.env.GRAFANA_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  process.env.GRAFANA_DATASOURCE_UID = 'fixture';
  process.env.GRAFANA_DATASOURCE_ID = '2';
  process.env.GRAFANA_ORG_ID = '1';
  process.env.GRAFANA_DEFAULT_INSTANCE = 'ignored-legacy-setting';
  const configDirectory = mkdtempSync(join(tmpdir(), 'grafana-service-aliases-'));
  process.env.WORKBENCH_CONFIG_DIR = configDirectory;
  writeFileSync(join(configDirectory, 'grafana-service-aliases.json'), JSON.stringify({
    'rating-test': '算费测试', 'rating-test-748cfdb787-k54g8': '指定 Pod 备注', 'unlisted-service': '仅本地',
  }));
  const bridge = require('../../server/server').createServer({ token: 'desktop' }).listen(0, '127.0.0.1');
  t.after(() => bridge.close());
  await once(bridge, 'listening');
  const call = async (route, body, authorized = true) => {
    const headers = { 'Content-Type': 'application/json', ...(authorized ? { 'x-workbench-token': 'desktop' } : {}) };
    const res = await fetch(`http://127.0.0.1:${bridge.address().port}/api/grafana/${route}`, {
      headers, method: body ? 'POST' : 'GET', body: body && JSON.stringify(body),
    });
    return [res.status, await res.json()];
  };
  assert.equal((await call('connect', { cookie: 'grafana_session=blocked' }, false))[0], 403);
  assert.deepEqual(await call('status'), [200, { ok: true, configured: true, connected: false, desktop: true }]);
  const filters = { service: 'rating-test', minutes: 180, limit: 100, level: 'WARN' };
  assert.equal((await call('query', filters))[0], 401);
  assert.equal((await call('services?minutes=180'))[0], 401);
  const connected = await call('connect', { cookie: 'grafana_session=initial' });
  assert.deepEqual(connected, [200, { ok: true, configured: true, connected: true }]);
  assert.equal((await call('services?minutes=2880'))[0], 400);
  assert.deepEqual(await call('services?minutes=180'), [200, {
    ok: true,
    services: ['rating-test', 'another-TEST-service', 'rating-test-748cfdb787-k54g8', 'rating-test-56f7dd4c66-mtrm8', 'rating-test-0'],
    aliases: { 'rating-test': '算费测试', 'rating-test-748cfdb787-k54g8': '指定 Pod 备注',
      'rating-test-56f7dd4c66-mtrm8': '算费测试', 'rating-test-0': '算费测试' },
    truncated: false,
  }]);
  const discovery = upstreamCalls[1].body;
  assert.equal(Number(discovery.to) - Number(discovery.from), 10800000);
  assert.match(discovery.queries[0].rawSql, /SELECT service_name[\s\S]*\$__timeFilter\(timestamp\)\s+AND LOWER\(service_name\) LIKE '%test%'\s+GROUP BY service_name\s+ORDER BY MAX\(timestamp\) DESC\s+LIMIT 1001/);
  assert.equal((await call('query', { ...filters, rawSql: 'SELECT 1' }))[0], 400);
  assert.deepEqual(await call('query', filters), [200, { ok: true,
    rows: columns.time.map((_, i) => Object.fromEntries(Object.entries(columns).map(([key, values]) => [key, values[i]]))),
  }]);
  assert.deepEqual(upstreamCalls.map(({ path, method, cookie, org }) => [path, method, cookie, org]), [
    ['/api/user', 'GET', 'grafana_session=initial', '1'],
    ['/api/ds/query?ds_type=mysql', 'POST', 'grafana_session=rotated', '1'],
    ['/api/ds/query?ds_type=mysql', 'POST', 'grafana_session=rotated', '1'],
  ]);
  assert.equal(upstreamCalls[2].body.queries[0].datasourceId, 2);
  const expired = await call('query', filters);
  assert.equal(expired[0], 401);
  assert.equal(expired[1].error.code, 'GRAFANA_LOGIN_REQUIRED');
  assert.equal((await call('status'))[1].connected, false);
  assert.equal(upstreamCalls.length, 4);
});

test('Grafana login isolates the remote window and hands off only the verified session', async () => {
  const cookies = Object.assign(new EventEmitter(), { get: async () => [{ name: 'grafana_session', value: 'fixture' }] });
  const partition = { cookies, setPermissionCheckHandler() {}, setPermissionRequestHandler() {} };
  let win, passed;
  class Window extends EventEmitter {
    constructor(options) {
      super(); win = this; this.options = options;
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: fn => { this.popup = fn; } });
    }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    isDestroyed() { return Boolean(this.destroyed); }
    close() { this.destroyed = true; this.emit('closed'); }
  }
  const login = createGrafanaLogin({
    BrowserWindow: Window,
    session: { fromPartition: (name, options) => {
      assert.equal(name, 'grafana-login'); assert.deepEqual(options, { cache: false }); return partition;
    } },
    getStatus: async () => ({ configured: true, baseUrl: 'http://grafana.test' }),
    connect: async (cookie, signal) => { passed = cookie; assert.equal(signal.aborted, false); return { connected: true }; },
  });
  const pending = login();
  assert.equal(login(), pending);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(win.url, 'http://grafana.test/login');
  assert.deepEqual(win.options.webPreferences, { session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true });
  assert.deepEqual(win.popup(), { action: 'deny' });
  let blocked = false;
  win.webContents.emit('will-redirect', { preventDefault: () => { blocked = true; } }, 'http://other.test');
  assert.equal(blocked, true);
  cookies.emit('changed');
  assert.deepEqual(await pending, { ok: true });
  assert.equal(passed, 'grafana_session=fixture');
  assert.equal(win.isDestroyed(), true);
  assert.equal(cookies.listenerCount('changed'), 0);
  const cancelled = login();
  await new Promise(resolve => setImmediate(resolve));
  win.close();
  assert.equal((await cancelled).ok, false);
  assert.equal(cookies.listenerCount('changed'), 0);
});
