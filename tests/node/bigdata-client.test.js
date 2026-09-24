const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { BigdataClientManager, formBody } = require('../../server/bigdata-client');

function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }

test('client service uses SSH forwarded channels, fixed routes, and masked configuration', async () => {
  const calls = [];
  const service = http.createServer((req, res) => {
    let body = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body });
      const payload = req.url === '/health'
        ? { status: 'ok', mode: 'client' }
        : req.url === '/v1/hdfs/preview'
          ? { base64: Buffer.from('档案').toString('base64'), truncated: false, readAt: '2026-09-18T00:00:00Z' }
          : req.url === '/v1/hbase/scan'
            ? { rows: [{ rowKey: '9223372036854775807', cells: [{ family: 'f', qualifier: 'q', timestamp: '18446744073709551615', value: 'base64:AAE=', encoding: 'base64' }] }], text: '9223372036854775807 column=f:q, timestamp=18446744073709551615, value=base64:AAE=', truncated: true }
          : { path: '/', items: [], cached: body.includes('refresh=true'), readAt: '2026-09-18T00:00:00Z' };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload));
    });
  });
  await listen(service); const port = service.address().port;
  const fakeSsh = { conn: { forwardOut(_srcHost, _srcPort, _host, _port, callback) { const socket = net.connect(port, '127.0.0.1'); socket.once('connect', () => callback(null, socket)); socket.once('error', callback); } } };
  const manager = new BigdataClientManager({ config: { remoteHost: '127.0.0.1', remotePort: port, token: 'SECRET_TOKEN', defaultMode: 'ssh', timeoutMs: 2000, listCacheMs: 30000 }, ssh: fakeSsh });
  try {
    assert.equal(manager.defaults().hasToken, true); assert.equal(Object.hasOwn(manager.defaults(), 'token'), false);
    await manager.connect(); assert.equal(manager.status().connected, true); assert.equal(manager.status().mode, 'client');
    const list = await manager.hbaseList('/', { refresh: true }); assert.equal(list.cached, true);
    const preview = await manager.hdfsPreview('/apps/a', 256); assert.equal(preview.text, '档案'); assert.equal(Object.hasOwn(preview, 'base64'), false);
    await manager.hdfsUpload('/data/a.json', '/apps/input');
    await manager.hdfsDelete('/apps/input/a.json', 'file');
    const scan = await manager.hbaseScan('/ns:t', 200); assert.equal(scan.rows[0].rowKey, '9223372036854775807'); assert.equal(scan.rows[0].cells[0].timestamp, '18446744073709551615'); assert.equal(scan.rows[0].cells[0].encoding, 'base64'); assert.equal(scan.truncated, true);
    assert.equal(calls.every((call) => call.auth === 'Bearer SECRET_TOKEN'), true);
    assert.match(calls.find((call) => call.url === '/v1/hbase/list').body, /refresh=true/);
    assert.equal(new URLSearchParams(calls.find((call) => call.url === '/v1/hdfs/upload').body).get('localPath'), '/data/a.json');
    assert.equal(new URLSearchParams(calls.find((call) => call.url === '/v1/hdfs/delete').body).get('kind'), 'file');
    manager.useSshMode(); assert.equal(manager.status().mode, 'ssh'); assert.equal(manager.status().connected, false);
  } finally { manager.disconnect(); await close(service); }
});

test('client request cancellation closes work and sends a remote cancel request', async () => {
  let cancelled = false;
  const service = http.createServer((req, res) => {
    if (req.url === '/v1/requests/cancel') { cancelled = true; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"cancelled":true}'); return; }
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return; }
    setTimeout(() => { if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"rows":[]}'); } }, 1000);
  });
  await listen(service); const port = service.address().port;
  const fakeSsh = { conn: { forwardOut(_a, _b, _c, _d, callback) { const socket = net.connect(port, '127.0.0.1'); socket.once('connect', () => callback(null, socket)); socket.once('error', callback); } } };
  const manager = new BigdataClientManager({ config: { remoteHost: '127.0.0.1', remotePort: port, token: 'TOKEN', defaultMode: 'ssh', timeoutMs: 2000 }, ssh: fakeSsh });
  try {
    await manager.connect(); const controller = new AbortController();
    const pending = manager.hbaseScan('/ns:t', 20, { signal: controller.signal }); setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, (error) => error.code === 'QUERY_CANCELLED');
    await new Promise((resolve) => setTimeout(resolve, 80)); assert.equal(cancelled, true);
  } finally { manager.disconnect(); await close(service); }
});

test('form encoding preserves exact RowKey and large string identifiers', () => {
  const encoded = formBody({ rowKey: 'A|B+C/中文', productInstanceId: '9223372036854775807' });
  const params = new URLSearchParams(encoded); assert.equal(params.get('rowKey'), 'A|B+C/中文'); assert.equal(params.get('productInstanceId'), '9223372036854775807');
});

test('client tunnel falls back to a fixed SSH exec relay when direct-tcpip is disabled', async () => {
  const service = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok","mode":"client"}');
  });
  await listen(service); const port = service.address().port; let relayCommand = '';
  const fakeSsh = { conn: {
    forwardOut(_a, _b, _c, _d, callback) { callback(new Error('open failed')); },
    exec(command, callback) {
      relayCommand = command;
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => callback(null, socket)); socket.once('error', callback);
    },
  } };
  const manager = new BigdataClientManager({ config: { remoteHost: '127.0.0.1', remotePort: port, token: 'TOKEN', defaultMode: 'ssh', timeoutMs: 2000 }, ssh: fakeSsh });
  try {
    await manager.connect();
    assert.equal(manager.status().connected, true);
    assert.equal(relayCommand, `exec nc 127.0.0.1 ${port}`);
  } finally { manager.disconnect(); await close(service); }
});
