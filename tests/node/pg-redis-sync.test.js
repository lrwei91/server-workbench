'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseResp, encodeCommand, RedisArchiveService, decompressLz4Block, decodeRedisArchiveValue } = require('../../server/redis-archive');
const { parseLosslessJson, stringifyLosslessJson, decodeArchive, encodeArchive, compressLz4Block } = require('../../server/archive-codec');
const { PgRedisSync, validateOptions, convertPgValue, buildCandidate, SNAPSHOT_SCRIPT, REPLACE_SCRIPT } = require('../../server/pg-redis-sync');
const { DatabaseManager } = require('../../server/database');

const prefix = Buffer.from('03ca9f23', 'hex');
const original = { prodInsts: [{ prodInstId: 42, hisId: 0, account: 'before', statusDate: 0, ownerCustId: 9223372036854775801n }], other: [{ keep: '原样 😀' }] };
const columns = { prod_inst_id: 'bigint', his_id: 'bigint', account: 'character varying', status_date: 'timestamp without time zone', owner_cust_id: 'bigint' };
const source = () => ({ prod_inst: { columns: { ...columns }, rows: [{ prod_inst_id: '42', his_id: '0', account: 'after', status_date: '1970-01-01 08:00:00', owner_cust_id: '9223372036854775801' }] } });

function response(value) {
  if (value === null) return Buffer.from('$-1\r\n');
  if (Array.isArray(value)) return Buffer.concat([Buffer.from(`*${value.length}\r\n`), ...value.map(response)]);
  if (typeof value === 'number') return Buffer.from(`:${value}\r\n`);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return Buffer.concat([Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from('\r\n')]);
}

async function fixture(t, { ttl = -1 } = {}) {
  const raw = encodeArchive(original, prefix);
  const state = { raw, expiresAt: ttl < 0 ? -1 : Date.now() + ttl, writes: 0, rows: source(), commands: [], mismatch: false };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const parsed = parseResp(buffer); if (!parsed) break; buffer = buffer.subarray(parsed.next);
        const parts = parsed.value, cmd = parts[0].toString(); state.commands.push(cmd);
        if (cmd === 'AUTH' || cmd === 'SELECT') socket.write(response('OK'));
        else if (cmd === 'GET') socket.write(response(state.mismatch ? Buffer.from('changed-after-write') : state.raw));
        else if (cmd === 'EVAL' && parts[1].toString() === SNAPSHOT_SCRIPT) {
          const now = Date.now(); const remaining = state.expiresAt < 0 ? -1 : state.expiresAt - now;
          socket.write(response([state.raw, remaining, String(Math.floor(now / 1000)), String(now % 1000 * 1000)]));
        } else if (cmd === 'EVAL' && parts[1].toString() === REPLACE_SCRIPT) {
          if (!state.raw?.equals(parts[4])) socket.write(response([0]));
          else if (parts[6].toString() === 'sync' && Math.abs(state.expiresAt - Number(parts[7])) > 2) socket.write(response([-3]));
          else if (parts[6].toString() === 'restore' && Number(parts[7]) >= 0 && Number(parts[7]) <= Date.now()) socket.write(response([-2]));
          else {
            if (parts[6].toString() === 'restore') state.expiresAt = Number(parts[7]);
            state.raw = Buffer.from(parts[5]); state.writes += 1; socket.write(response([1, state.expiresAt]));
          }
        } else socket.write(Buffer.from('-ERR unknown command\r\n'));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-sync-'));
  t.after(async () => { sockets.forEach((socket) => socket.destroy()); await new Promise((resolve) => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const redis = new RedisArchiveService({ host: '127.0.0.1', port: server.address().port, db: 2, password: 'fixture', timeoutMs: 1000 });
  const database = { sources: new Map([['pg', { config: { host: 'fixture', database: 'fixture' } }]]),
    withPgSnapshot: async (work) => work({ query: async (sql) => {
      if (sql.startsWith('SELECT table_name')) return { rows: Object.entries(state.rows).flatMap(([table_name, value]) => Object.entries(value.columns).map(([column_name, data_type]) => ({ table_name, column_name, data_type }))) };
      const table = /FROM bill_inmemory\.(\w+)/.exec(sql)[1]; return { rows: structuredClone(state.rows[table]?.rows || []) };
    } }) };
  const sync = new PgRedisSync({ database, redis, backupDir: dir });
  return { state, sync, raw, dir };
}

test('binary RESP commands preserve nulls, high bytes and CRLF', () => {
  const bytes = Buffer.from([0, 255, 13, 10, 128]);
  assert.deepEqual(parseResp(encodeCommand(['SET', 'rate:cpp:42', bytes])).value[2], bytes);
});

test('archive roundtrip preserves bigint, unicode, envelope and size bounds', () => {
  const encoded = encodeArchive(original, prefix);
  const decoded = decodeArchive(encoded);
  assert.deepEqual(decoded.data, original); assert.equal(decoded.prefix[0], 3);
  assert.notDeepEqual(decoded.prefix, prefix); // 示例头的旧长度应重新计算，而非固定复制。
  const longer = encodeArchive({ ...original, extra: '长度已变化'.repeat(30) }, prefix);
  assert.notDeepEqual(decodeArchive(longer).prefix, decoded.prefix);
  assert.deepEqual(parseLosslessJson('{"n":9223372036854775801,"s":"9223372036854775801","v":-9223372036854775801}'), { n: 9223372036854775801n, s: '9223372036854775801', v: -9223372036854775801n });
  assert.match(stringifyLosslessJson(original), /"ownerCustId":9223372036854775801/);
  assert.throws(() => encodeArchive(original, prefix, 10), { code: 'ARCHIVE_TOO_LARGE' });
  assert.throws(() => encodeArchive(original, Buffer.from([4])), { code: 'ARCHIVE_ENVELOPE' });
  assert.throws(() => parseLosslessJson('{"n":1.1234567890123456789}'), { code: 'ARCHIVE_NUMBER_PRECISION' });
  assert.deepEqual(parseLosslessJson('{"n":1e3}'), { n: 1000 });
});

test('time interpretation is explicit and independent of host timezone', () => {
  assert.equal(convertPgValue('1970-01-01 08:00:00', 0, 'timestamp without time zone', '+08:00'), 0);
  assert.equal(convertPgValue('1970-01-01 08:00:00', 0, 'timestamp without time zone', 'Z'), 28800000);
  assert.equal(convertPgValue('1970-01-01 00:00:00+00', 0, 'timestamp with time zone', '+08:00'), 0);
  assert.throws(() => convertPgValue('infinity', 0, 'timestamp without time zone', '+08:00'), { code: 'FIELD_TIME' });
  assert.throws(() => convertPgValue('1970-01-01 08:00:00.000001', 0, 'timestamp without time zone', '+08:00'), { code: 'FIELD_TIME' });
  assert.throws(() => convertPgValue('9007199254740993.01', 0, 'numeric', '+08:00'), { code: 'FIELD_PRECISION' });
});

test('raw LZ4 encoder handles literals, overlap, long sequences and 64KiB windows', () => {
  for (const length of [0, 1, 5, 12, 14, 15, 16, 270, 65535, 100000]) {
    for (const input of [randomBytes(length), Buffer.alloc(length, 65), Buffer.from('abc0123'.repeat(Math.ceil(length / 7))).subarray(0, length)]) {
      assert.deepEqual(decompressLz4Block(compressLz4Block(input), length), input);
    }
  }
});

test('reader follows computed Kryo length even when varint contains JSON-open byte', () => {
  let data, encoded;
  for (let length = 7000; length < 9000; length++) {
    data = { text: 'x'.repeat(length), integer: 9223372036854775801n };
    encoded = encodeArchive(data, prefix);
    if (decodeArchive(encoded).prefix.includes(123)) break;
  }
  assert.equal(decodeArchive(encoded).prefix.includes(123), true);
  assert.equal(decodeRedisArchiveValue(encoded).data.integer, '9223372036854775801');
  assert.equal(decodeRedisArchiveValue(encoded).data.text, data.text);
});

test('candidate uses ID and hisId; preserves absent versions, unknown groups and fields', () => {
  const data = structuredClone(original); data.prodInsts.push({ prodInstId: 42, hisId: 1, account: 'historical' }); data.prodInsts[0].onlyInRedis = 'keep';
  const candidate = buildCandidate(data, source(), validateOptions({ tables: ['prod_inst'] }), '42');
  assert.equal(candidate.canApply, true); assert.equal(candidate.changedFields, 1);
  assert.equal(candidate.data.prodInsts[0].account, 'after'); assert.equal(candidate.data.prodInsts[0].onlyInRedis, 'keep');
  assert.equal(candidate.data.prodInsts[1].account, 'historical'); assert.deepEqual(candidate.data.other, original.other);
  assert.equal(candidate.groups[0].missing, 1); assert.deepEqual(candidate.unrecognized, ['other']);
});

test('scope changes, conflicting duplicates and missing roots block apply', () => {
  const rows = source(); rows.prod_inst.rows.push({ ...rows.prod_inst.rows[0], account: 'conflict' });
  assert.equal(buildCandidate(original, rows, validateOptions(), '42').canApply, false);
  const data = { prodInsts: [{ prodInstId: 43, hisId: 0, account: 'before' }] };
  assert.match(buildCandidate(data, source(), validateOptions(), '44').blockers.join(), /目标产品实例/);
  const relations = { prodInstRels: [{ prodInstRelId: 1, hisId: 0, prodInstAId: 42 }] };
  const relationSource = { ...source(), prod_inst_rel: { columns: { prod_inst_rel_id: 'bigint', his_id: 'bigint', prod_inst_a_id: 'bigint' }, rows: [{ prod_inst_rel_id: '1', his_id: '0', prod_inst_a_id: '99' }] } };
  assert.match(buildCandidate(relations, relationSource, validateOptions(), '42').blockers.join(), /关联范围/);
});

test('preview is read-only, apply backs up first, verifies bytes, restores and preserves TTL', async (t) => {
  const { sync, state, raw, dir } = await fixture(t, { ttl: 60000 });
  const expiry = state.expiresAt;
  const preview = await sync.preview('42', { tables: ['prod_inst'] });
  assert.equal(state.writes, 0); assert.equal(preview.canApply, true); assert.equal(preview.changedFields, 1);
  await assert.rejects(sync.apply(preview.previewId, false), { code: 'SYNC_CONFIRM_REQUIRED' });
  const applied = await sync.apply(preview.previewId, true);
  assert.equal(applied.verified, true); assert.equal(state.writes, 1); assert.equal(state.expiresAt, expiry);
  const backup = JSON.parse(await fs.readFile(path.join(dir, `${applied.backupId}.json`), 'utf8'));
  assert.deepEqual(Buffer.from(backup.before, 'base64'), raw); assert.equal(backup.status, 'applied');
  assert.equal(decodeArchive(state.raw).data.prodInsts[0].account, 'after');
  assert.equal(decodeArchive(state.raw).data.prodInsts[0].ownerCustId, 9223372036854775801n);
  assert.equal((await sync.history('42'))[0].backupId, applied.backupId);
  const restored = await sync.restore(applied.backupId, true);
  assert.equal(restored.verified, true); assert.deepEqual(state.raw, raw); assert.equal(state.expiresAt, expiry);
  assert.equal((await sync.history('42'))[0].status, 'restored');
});

test('apply rejects stale Redis and PG, expired previews and changed connections', async (t) => {
  const { sync, state } = await fixture(t);
  let preview = await sync.preview('42', { tables: ['prod_inst'] });
  const raw = state.raw; state.raw = encodeArchive({ ...original, extra: true }, prefix);
  await assert.rejects(sync.apply(preview.previewId, true), { code: 'REDIS_CHANGED' });
  state.raw = raw; state.rows.prod_inst.rows[0].account = 'changed-since-preview';
  await assert.rejects(sync.apply(preview.previewId, true), { code: 'PG_CHANGED' });
  preview = await sync.preview('42', { tables: ['prod_inst'] }); sync.previews.get(preview.previewId).created -= 600001;
  await assert.rejects(sync.apply(preview.previewId, true), { code: 'PREVIEW_EXPIRED' });
  preview = await sync.preview('42', { tables: ['prod_inst'] }); sync.database.sources.get('pg').config.database = 'other';
  await assert.rejects(sync.apply(preview.previewId, true), { code: 'SYNC_CONNECTION_CHANGED' });
  assert.equal(state.writes, 0);
});

test('external expiry changes invalidate a preview without writing', async (t) => {
  const { sync, state } = await fixture(t, { ttl: 60000 });
  const preview = await sync.preview('42', { tables: ['prod_inst'] });
  state.expiresAt += 30000;
  await assert.rejects(sync.apply(preview.previewId, true), { code: 'REDIS_TTL_CHANGED' });
  assert.equal(state.writes, 0);
});

test('no differences never write; backup failure never writes', async (t) => {
  const { sync, state } = await fixture(t); state.rows.prod_inst.rows[0].account = 'before';
  let preview = await sync.preview('42', { tables: ['prod_inst'] }); assert.equal(preview.changedFields, 0);
  await assert.rejects(sync.apply(preview.previewId, true), { code: 'SYNC_NOT_READY' });
  state.rows.prod_inst.rows[0].account = 'after'; preview = await sync.preview('42', { tables: ['prod_inst'] });
  sync.writeBackup = async () => { throw Error('fixture-disk-full'); };
  await assert.rejects(sync.apply(preview.previewId, true), /fixture-disk-full/); assert.equal(state.writes, 0);
});

test('uncertain readback retains backup; restore rejects later modifications and elapsed expiry', async (t) => {
  const { sync, state, dir } = await fixture(t);
  const preview = await sync.preview('42', { tables: ['prod_inst'] }); state.mismatch = true;
  let id;
  await assert.rejects(sync.apply(preview.previewId, true), (error) => { id = error.details.backupId; return error.code === 'READBACK_MISMATCH'; });
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, `${id}.json`))).status, 'uncertain');
  state.mismatch = false;
  const after = state.raw; state.raw = encodeArchive({ ...original, external: true }, prefix);
  await assert.rejects(sync.restore(id, true), { code: 'REDIS_CHANGED' });
  state.raw = after;
  const backup = await sync.readBackup(id); backup.expiresAt = 1; await sync.writeBackup(backup);
  await assert.rejects(sync.restore(id, true), { code: 'BACKUP_EXPIRED' });
  await assert.rejects(sync.readBackup('../outside'), { code: 'INVALID_BACKUP_ID' });
});

test('PG snapshot uses one read-only transaction and releases connection on error', async () => {
  const calls = []; let released = 0;
  const client = { query: async (value) => { calls.push(value); return { rows: [] }; }, release: () => { released += 1; } };
  const manager = new DatabaseManager({}, { types: { getTypeParser: () => (value) => value } });
  manager.sources.set('pg', { pools: new Map([['db', { connect: async () => client }]]) });
  await manager.withPgSnapshot(async (reader) => reader.query('SELECT fixture', ['42']));
  assert.match(calls[0], /REPEATABLE READ READ ONLY/); assert.equal(calls.at(-1), 'COMMIT');
  assert.equal(calls.find((item) => typeof item === 'object').types.getTypeParser(1114)('2026-01-01 00:00:00'), '2026-01-01 00:00:00');
  await assert.rejects(manager.withPgSnapshot(async () => { throw Error('fixture'); }), /fixture/);
  assert.equal(calls.at(-1), 'ROLLBACK'); assert.equal(released, 2);
});
