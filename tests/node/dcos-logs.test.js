'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fsSync = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { DcosLogs } = require('../../server/dcos-logs');

async function fixture(handler, work) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await work(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const config = (baseUrl, timeoutMs = 1000) => ({ baseUrl, clusters: [{ id: 321, name: 'ccse-xyha-01' }], timeoutMs });
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

test('云翼日志链路映射并仅在服务端保存 Cookie', async () => {
  const calls = [];
  await fixture((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), cookie: req.headers.cookie });
    assert.equal(req.headers.cookie, 'JSESSIONID=test; SESSION=test');
    if (url.pathname.endsWith('/namespace/list')) return json(res, { code: 0, data: [{ namespaceName: 'other', clusterId: 321 }, { namespaceName: 'bill-cnos-jf', clusterId: 321 }] });
    if (url.pathname.includes('/workload/page/')) {
      let body = ''; req.on('data', (part) => { body += part; });
      return req.on('end', () => {
        assert.deepEqual(JSON.parse(body), { workloadKind: 'StatefulSet', appName: '', workloadNames: ['test'] });
        json(res, { code: 0, data: { records: [{ workloadName: 'idis-prep-ss', workloadKind: 'StatefulSet', runningPodNum: 1 }, { workloadName: 'idis-test-prep-ss', workloadKind: 'StatefulSet', runningPodNum: 1 }], total: 2, current: 1 } });
      });
    }
    if (url.pathname.endsWith('/pods/')) return json(res, { code: 0, data: [{ podName: 'prep-ss-0', podStatus: 'Running', containers: [{ name: 'container1' }] }] });
    if (url.pathname.endsWith('/containerLogs')) return json(res, { code: 0, data: ['first line', 'second line'] });
    json(res, {}, 404);
  }, async (baseUrl) => {
    const service = new DcosLogs(config(baseUrl));
    assert.equal(service.status().connected, false);
    await assert.rejects(service.namespaces(321), { code: 'DCOS_NOT_CONNECTED' });
    const connected = await service.connect('Cookie: JSESSIONID=test; SESSION=test');
    assert.equal(connected.connected, true);
    assert.equal(JSON.stringify(connected).includes('JSESSIONID'), false);
    assert.deepEqual(await service.namespaces(321), [{ name: 'bill-cnos-jf', clusterId: 321 }]);
    assert.deepEqual(await service.workloads(321, 'bill-cnos-jf', { pageNow: 1, pageSize: 10, search: 'prep' }), { records: [{ name: 'idis-test-prep-ss', kind: 'StatefulSet', runningPodNum: 1 }], total: 1, pageNow: 1, pageSize: 10 });
    assert.deepEqual(await service.pods(321, 'bill-cnos-jf', 'prep-ss'), [{ name: 'prep-ss-0', status: 'Running', containers: ['container1'] }]);
    const logs = await service.logs(321, 'bill-cnos-jf', 'prep-ss-0', 'container1', 100);
    assert.deepEqual(logs.lines, ['first line', 'second line']);
    assert.ok(Date.parse(logs.readAt));
    assert.equal(calls.find((call) => call.path.includes('/workload/page/')).method, 'POST');
    assert.equal(calls.find((call) => call.path.includes('/workload/page/')).query.pageNow, '1');
    assert.equal(calls.find((call) => call.path.includes('/workload/page/')).query.pageSize, '100');
    assert.equal(calls.find((call) => call.path.endsWith('/containerLogs')).query.tailingLines, '100');
    service.disconnect(); assert.equal(service.status().connected, false);
  });
});

test('空日志、会话过期和非法行数', async () => {
  await fixture((req, res) => {
    if (req.url.includes('containerLogs')) return json(res, { code: 0, data: [] });
    if (req.url.includes('namespace/list')) return json(res, { code: 0, data: [] });
    json(res, {}, 401);
  }, async (baseUrl) => {
    const service = new DcosLogs(config(baseUrl));
    await service.connect('JSESSIONID=test');
    assert.deepEqual((await service.logs(321, 'ns', 'pod', 'container', 500)).lines, []);
    await assert.rejects(service.logs(321, 'ns', 'pod', 'container', 5), { code: 'DCOS_INVALID_LINES' });
    await assert.rejects(service.pods(321, 'ns', 'workload'), { code: 'DCOS_SESSION_EXPIRED' });
    assert.equal(service.status().connected, false);
  });
});

test('命名空间列表兼容平台直接数组、列表包装和空结果', async () => {
  for (const payload of [
    [{ namespaceName: 'other' }, { namespaceName: 'bill-cnos-jf', clusterId: 321 }],
    { records: [{ namespaceName: 'bill-cnos-jf' }, { namespaceName: 'other' }] },
    { list: [{ name: 'bill-cnos-jf' }] },
    null,
  ]) {
    await fixture((_req, res) => json(res, { code: 0, data: payload }), async (baseUrl) => {
      const service = new DcosLogs(config(baseUrl)); service.cookie = 'JSESSIONID=test';
      const result = await service.namespaces(321);
      assert.deepEqual(result, payload === null ? [] : [{ name: 'bill-cnos-jf', clusterId: 321 }]);
    });
  }
  await fixture((_req, res) => json(res, { code: 0, data: { unexpected: true } }), async (baseUrl) => {
    const service = new DcosLogs(config(baseUrl)); service.cookie = 'JSESSIONID=test';
    await assert.rejects(service.namespaces(321), { code: 'DCOS_INVALID_RESPONSE' });
  });
});

test('StatefulSet 筛选跨上游分页后再计算搜索结果总数', async () => {
  const pages = [];
  await fixture((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    pages.push(Number(url.searchParams.get('pageNow')));
    const second = url.searchParams.get('pageNow') === '2';
    json(res, { code: 0, data: { records: second
      ? [{ workloadName: 'idis-test-prep', workloadKind: 'StatefulSet' }]
      : [{ workloadName: 'idis-test-rating', workloadKind: 'StatefulSet' }], total: 101 } });
  }, async (baseUrl) => {
    const service = new DcosLogs(config(baseUrl)); service.cookie = 'JSESSIONID=test';
    const result = await service.workloads(321, 'bill-cnos-jf', { pageNow: 1, pageSize: 1, search: 'prep' });
    assert.deepEqual(pages, [1, 2]);
    assert.equal(result.total, 1);
    assert.deepEqual(result.records.map((item) => item.name), ['idis-test-prep']);
  });
});

test('云翼请求支持超时和主动取消', async () => {
  await fixture((req, res) => { req.on('close', () => { if (!res.writableEnded) res.end(); }); }, async (baseUrl) => {
    const service = new DcosLogs(config(baseUrl, 30));
    service.cookie = 'JSESSIONID=test';
    await assert.rejects(service.namespaces(321), { code: 'DCOS_TIMEOUT' });
    const controller = new AbortController();
    const cancelled = service.namespaces(321, { signal: controller.signal });
    controller.abort();
    await assert.rejects(cancelled, { code: 'DCOS_CANCELLED' });
  });
});

test('容器日志去重后追加到本地文件，进程重启后按文件尾部续接', async () => {
  const dir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'dcos-logs-'));
  let payload = ['a', 'b', 'c'];
  await fixture((req, res) => {
    if (req.url.includes('containerLogs')) return json(res, { code: 0, data: payload });
    json(res, {}, 404);
  }, async (baseUrl) => {
    const service = new DcosLogs(config(baseUrl), { logDir: dir });
    service.cookie = 'JSESSIONID=test';
    const first = await service.logs(321, 'bill-cnos-jf', 'prep-ss-0', 'container1', 100);
    assert.equal(first.saved.appended, 3);
    payload = ['b', 'c', 'd'];
    const second = await service.logs(321, 'bill-cnos-jf', 'prep-ss-0', 'container1', 100);
    assert.equal(second.saved.appended, 1); // 只有 d 是新增
    const content = fsSync.readFileSync(nodePath.join(dir, nodePath.basename(first.saved.path)), 'utf8');
    assert.equal(content, 'a\nb\nc\nd\n');
    // 新实例（模拟重启）：内存无尾部，回读文件尾部继续去重
    const restarted = new DcosLogs(config(baseUrl), { logDir: dir });
    restarted.cookie = 'JSESSIONID=test';
    payload = ['c', 'd', 'e'];
    const third = await restarted.logs(321, 'bill-cnos-jf', 'prep-ss-0', 'container1', 100);
    assert.equal(third.saved.appended, 1);
    assert.equal(fsSync.readFileSync(nodePath.join(dir, nodePath.basename(first.saved.path)), 'utf8'), 'a\nb\nc\nd\ne\n');
    // 不同目标各自独立成文件
    payload = ['x'];
    const other = await restarted.logs(321, 'bill-cnos-jf', 'prep-ss-1', 'container1', 100);
    assert.equal(other.saved.appended, 1);
    assert.notEqual(other.saved.path, first.saved.path);
  });
});

test('同一目标的并发读取串行落盘，不重复追加', async () => {
  const dir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'dcos-logs-'));
  await fixture((req, res) => {
    if (req.url.includes('containerLogs')) return json(res, { code: 0, data: ['a', 'b', 'c'] });
    json(res, {}, 404);
  }, async (baseUrl) => {
    const service = new DcosLogs(config(baseUrl), { logDir: dir });
    service.cookie = 'JSESSIONID=test';
    const [first, second] = await Promise.all([
      service.logs(321, 'ns', 'pod', 'container1', 100),
      service.logs(321, 'ns', 'pod', 'container1', 100),
    ]);
    assert.equal(first.saved.appended + second.saved.appended, 3); // 一次完整写入，另一次无新增
    assert.equal(fsSync.readFileSync(nodePath.join(dir, nodePath.basename(first.saved.path)), 'utf8'), 'a\nb\nc\n');
  });
});

test('工作负载启停映射云翼固定接口且 POST 空体不带 Content-Type', async () => {
  const calls = [];
  await fixture((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push({ method: req.method, path: url.pathname, contentType: req.headers['content-type'] || '', cookie: req.headers.cookie });
    if (/^\/dcos\/workload\/(?:start|stop)\//.test(url.pathname)) return json(res, { code: 0, data: null });
    json(res, {}, 404);
  }, async (baseUrl) => {
    const service = new DcosLogs(config(baseUrl));
    service.cookie = 'JSESSIONID=test';
    const stopped = await service.workloadAction('stop', 321, 'bill-cnos-jf', 'idis-test-rating-ticket2hbase-process');
    assert.equal(stopped.action, 'stop');
    assert.equal(stopped.clusterId, 321);
    assert.ok(Date.parse(stopped.respondedAt));
    const started = await service.workloadAction('start', 321, 'bill-cnos-jf', 'idis-test-prep-ss');
    assert.equal(started.action, 'start');
    assert.deepEqual(calls.map((call) => call.method), ['POST', 'POST']);
    assert.equal(calls[0].path, '/dcos/workload/stop/321/namespace/bill-cnos-jf/workloadKind/StatefulSet/workloadName/idis-test-rating-ticket2hbase-process');
    assert.equal(calls[1].path, '/dcos/workload/start/321/namespace/bill-cnos-jf/workloadKind/StatefulSet/workloadName/idis-test-prep-ss');
    assert.equal(calls[0].contentType, '');
    assert.equal(calls[0].cookie, 'JSESSIONID=test');
    await assert.rejects(service.workloadAction('restart', 321, 'ns', 'workload'), { code: 'DCOS_INVALID_ACTION' });
    await assert.rejects(service.workloadAction('stop', 999, 'ns', 'workload'), { code: 'DCOS_INVALID_CLUSTER' });
  });
});
