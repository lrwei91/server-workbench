'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RedisSnapshots, scanPattern } = require('../../server/redis-snapshots');
const { createServer } = require('../../server/server');

const key = 'rate:SERV_SNAPSHOT:35';
const config = { host: 'fixture', port: 16379, db: 2, configured: true };
const buf = (s) => Buffer.from(s);
const fixture = (reply) => {
  const service = new RedisSnapshots({ config });
  const calls = [];
  service.withRedis = (work) => work(async (...parts) => { calls.push(parts); return reply(...parts); });
  return { service, calls };
};

test('snapshot search scopes and escapes matches; sparse scans return a resumable cursor', async () => {
  assert.equal(scanPattern('rate:SERV_SNAPSHOT'), 'rate:SERV_SNAPSHOT:*');
  assert.equal(scanPattern(key), key);
  assert.equal(scanPattern('3[5]*'), 'rate:SERV_SNAPSHOT:*3\\[5\\]\\**');
  const { service, calls } = fixture((_, cursor) => [buf(String(Number(cursor) + 1)),
    cursor === '3' ? [buf(key), buf(key), buf('rate:cpp:35'), Buffer.concat([buf(key), Buffer.from([255])])] : []]);
  assert.deepEqual(await service.search({ query: '35', cursor: '3' }), {
    keys: [key], cursor: '19', target: { host: 'fixture', port: 16379, db: 2 }, batches: 16,
  });
  assert.deepEqual(calls[0], ['SCAN', '3', 'MATCH', 'rate:SERV_SNAPSHOT:*35*', 'COUNT', 500]);
  assert.equal(calls.length, 16);
  await assert.rejects(service.search({ cursor: '18446744073709551616' }), /游标/);
});

test('snapshot detail deduplicates SET rows and preserves binary values as read-only', async () => {
  const { service, calls } = fixture(() => [buf('set'), -1, 5, buf('24'), [[3, buf('abc')], [3, buf('abc')], [1, Buffer.from([255])], [0, buf('')], [65537]]]);
  assert.deepEqual(await service.detail({ key, cursor: '17' }), {
    key, type: 'set', ttl: -1, count: 5, cursor: '24',
    members: [{ size: 3, value: 'abc' }, { size: 1, value: null }, { size: 0, value: '' }, { size: 65537, value: null }],
  });
  assert.deepEqual(calls[0].slice(2), [1, key, '17', 65536]);
  await assert.rejects(service.detail({ key: 'rate:cpp:35' }), /前缀|开头/);
  const strings = fixture(() => [buf('string'), 3000, 0, buf('')]).service;
  assert.deepEqual(await strings.detail({ key }), { key, type: 'string', ttl: 3000, row: { size: 0, value: '' } });
  assert.deepEqual(await fixture(() => [buf('hash'), -1]).service.detail({ key }), { key, type: 'hash', ttl: -1 });
});

test('snapshot mutations pass exact values and report conflicts without a retry', async () => {
  const { service, calls } = fixture((...parts) => ({
    create: 'exists', 'set-string': 'stale', 'add-member': 'ok', 'replace-member': 'duplicate', 'remove-member': 'removed',
  })[parts[4]]);
  const mutate = (body) => service.mutate({ key, confirmed: true, ...body });
  await assert.rejects(mutate({ action: 'create', type: 'set', value: '' }), /成员必填/);
  await assert.rejects(mutate({ action: 'create', type: 'hash', value: 'a' }), /STRING 或 SET/);
  await assert.rejects(mutate({ action: 'create', type: 'string', value: '', confirmed: 'true' }), /确认/);
  assert.equal(calls.length, 0);
  await assert.rejects(mutate({ action: 'create', type: 'string', value: '' }), { code: 'SNAPSHOT_KEY_EXISTS' });
  await assert.rejects(mutate({ action: 'set-string', previous: ' 旧 ', value: '新' }), { code: 'SNAPSHOT_CHANGED' });
  assert.deepEqual(calls[1].slice(2), [1, key, 'set-string', ' 旧 ', '新']);
  await mutate({ action: 'add-member', value: '新增' });
  await assert.rejects(mutate({ action: 'replace-member', previous: '旧', value: '已有' }), { code: 'SNAPSHOT_MEMBER_EXISTS' });
  assert.deepEqual(await mutate({ action: 'remove-member', previous: '' }), { key, removed: true });
});

test('snapshot HTTP rejects other prefixes, missing confirmation and cross-origin writes before any Redis connection', async (t) => {
  const server = createServer({ token: 'snapshot-fixture-token' }); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/redis-snapshot/';
  for (const [path, body, code, headers] of [
    ['detail', { key: 'rate:cpp:35' }, 'INVALID_SNAPSHOT_INPUT'],
    ['search', { query: '35', db: 5 }, 'UNKNOWN_FIELD'],
    ['mutate', { key, action: 'remove-member', previous: 'old' }, 'INVALID_SNAPSHOT_INPUT'],
    ['mutate', { key, action: 'remove-member', previous: 'old', confirmed: true }, 'DESKTOP_SESSION_REQUIRED', { Origin: 'https://untrusted.example' }],
    ['mutate', { key, action: 'remove-member', previous: 'old', confirmed: true }, 'CROSS_ORIGIN_WRITE', { 'Sec-Fetch-Site': 'cross-site' }],
    ['detail', { key }, 'DESKTOP_SESSION_REQUIRED', { 'x-workbench-token': 'wrong-token' }],
  ]) {
    const result = await fetch(base + path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'x-workbench-token': 'snapshot-fixture-token', ...headers } });
    assert.equal(result.status, headers ? 403 : 400);
    assert.equal((await result.json()).error.code, code);
  }
});
