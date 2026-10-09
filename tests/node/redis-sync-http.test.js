'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('../../server/server');
const { PgRedisSync } = require('../../server/pg-redis-sync');

test('sync HTTP validates scope, confirmation, same origin and unknown fields', async (t) => {
  const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body, headers = {}) => {
    const result = await fetch(`${base}/api/redis-sync/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: result.status, body: await result.json() };
  };
  const status = await fetch(`${base}/api/redis-sync/status`).then((result) => result.json());
  assert.equal(status.tables.length, 9); assert.equal(status.schema, 'bill_inmemory'); assert.equal(status.mode, 'existing-record-fields');
  for (const [route, body, code] of [
    ['preview', { key: 'arbitrary:key' }, 'INVALID_REDIS_KEY'],
    ['preview', { key: '42', tables: ['pg_authid'] }, 'INVALID_SYNC_TABLES'],
    ['preview', { key: '42', timestampZone: '+09:00' }, 'INVALID_TIMESTAMP_ZONE'],
    ['preview', { key: '42', sql: 'SELECT fixture' }, 'UNKNOWN_FIELD'],
    ['apply', { previewId: 'fixture', confirmed: false }, 'SYNC_CONFIRM_REQUIRED'],
    ['apply', { previewId: 'fixture', confirmed: 'true' }, 'SYNC_CONFIRM_REQUIRED'],
    ['restore', { backupId: 'fixture', confirmed: false }, 'SYNC_CONFIRM_REQUIRED'],
    ['apply', { previewId: 'fixture', confirmed: true, key: '43' }, 'UNKNOWN_FIELD'],
    ['restore', { backupId: 'fixture', confirmed: true }, 'INVALID_BACKUP_ID'],
  ]) {
    const result = await post(route, body); assert.equal(result.status, 400); assert.equal(result.body.error.code, code);
  }
  const cross = await post('apply', { previewId: 'fixture', confirmed: true }, { Origin: 'https://untrusted.example' });
  assert.equal(cross.status, 403); assert.equal(cross.body.error.code, 'CROSS_ORIGIN_WRITE');
  const fetchSite = await post('restore', { backupId: 'fixture', confirmed: true }, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(fetchSite.status, 403);
  const expired = await post('apply', { previewId: 'fixture', confirmed: true }, { Origin: base });
  assert.equal(expired.status, 409); assert.equal(expired.body.error.code, 'PREVIEW_EXPIRED');

  const originals = Object.fromEntries(['preview', 'apply', 'restore', 'history'].map((name) => [name, PgRedisSync.prototype[name]]));
  const calls = [];
  for (const name of Object.keys(originals)) PgRedisSync.prototype[name] = async (...args) => { calls.push({ name, args }); return { key: 'rate:cpp:42', verified: true }; };
  try {
    for (const [route, body] of [
      ['preview', { key: '42', tables: ['prod_inst'], timestampZone: '+08:00' }],
      ['apply', { previewId: 'fixture', confirmed: true }],
      ['restore', { backupId: 'fixture', confirmed: true }],
      ['history', { key: '42' }],
    ]) {
      const result = await post(route, body, { Origin: base }); assert.equal(result.status, 200); assert.equal(result.body.result.key, 'rate:cpp:42');
    }
    assert.deepEqual(calls.map((item) => item.name), ['preview', 'apply', 'restore', 'history']);
    assert.equal(calls[1].args[0], 'fixture'); assert.equal(calls[1].args[1], true); assert.ok(calls[1].args[2].signal);
  } finally { for (const [name, method] of Object.entries(originals)) PgRedisSync.prototype[name] = method; }
});

test('sync UI uses server previews, explicit confirmation and no browser persistence', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/redis-sync.js'), 'utf8');
  for (const id of ['btnRedisSyncPreview', 'btnRedisSyncApply', 'btnRedisSyncHistory', 'redisSyncTables', 'redisSyncTimezone', 'redisSyncResults']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="btnRedisSyncApply"[^>]*disabled/);
  assert.match(source, /confirm\(selected\.key/); assert.match(source, /previewId: selected\.previewId, confirmed: true/);
  assert.match(source, /data-restore-allowed/); assert.doesNotMatch(source, /localStorage|sessionStorage|innerHTML/);
});
