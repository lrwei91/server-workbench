'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { RedisArchiveService, parseResp } = require('../../server/redis-archive');
const { encodeArchive, decodeArchive, stringifyLosslessJson } = require('../../server/archive-codec');
const { RedisIndexes, indexCandidates, CREATE_INDEXES_SCRIPT } = require('../../server/redis-indexes');
const { createServer } = require('../../server/server');

const archive = (data) => encodeArchive(data, Buffer.from([3]));
const root = { prodInstId: 42, hisId: 0, areaCode: '0597', account: 'login123', accNbr: '13800138000' };
function reply(value) {
  if (value === null) return Buffer.from('$-1\r\n');
  if (Array.isArray(value)) return Buffer.concat([Buffer.from(`*${value.length}\r\n`), ...value.map(reply)]);
  if (typeof value === 'number') return Buffer.from(`:${value}\r\n`);
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return Buffer.concat([Buffer.from(`$${raw.length}\r\n`), raw, Buffer.from('\r\n')]);
}
async function fixture(t) {
  const keys = new Map([['rate:cpp:42', archive({ prodInsts: [root] })]]);
  const state = { keys, commands: [], writes: 0, pgCalls: [], pgRows: [], race: false, sourceChange: false, mismatch: false, drop: false };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const parsed = parseResp(buffer); if (!parsed) break; buffer = buffer.subarray(parsed.next);
        const p = parsed.value, cmd = p[0].toString(), key = p[1]?.toString(); state.commands.push(cmd);
        const value = keys.get(key);
        if (['AUTH', 'SELECT'].includes(cmd)) socket.write(reply('OK'));
        else if (cmd === 'GET') socket.write(reply(value ?? null));
        else if (cmd === 'TYPE') socket.write(reply(value === undefined ? 'none' : Array.isArray(value) ? 'set' : 'string'));
        else if (cmd === 'SCARD') socket.write(reply(value?.length || 0));
        else if (cmd === 'SMEMBERS') socket.write(reply(state.mismatch ? [archive({ bad: true })] : value || []));
        else if (cmd === 'EVAL') {
          assert.equal(key, CREATE_INDEXES_SCRIPT);
          const count = Number(p[2]), targets = p.slice(3, 3 + count).map(String), args = p.slice(3 + count);
          if (state.sourceChange) keys.set(targets[0], archive({ prodInsts: [{ ...root, account: 'changed' }] }));
          if (state.race) keys.set(targets[targets.length - 1], [archive({ preserve: true })]);
          if (!keys.get(targets[0])?.equals(args[0])) socket.write(reply([-1]));
          else if (targets.slice(1).some((k) => keys.has(k))) socket.write(reply([-2, targets.findIndex((k, i) => i > 0 && keys.has(k)) + 1]));
          else {
            let pos = 1;
            for (const k of targets.slice(1)) { const length = Number(args[pos++]); keys.set(k, args.slice(pos, pos + length)); pos += length; state.writes++; }
            if (state.drop) socket.destroy(); else socket.write(reply([1]));
          }
        } else socket.write(Buffer.from('-ERR unsupported fixture command\r\n'));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const auditDir = await fs.mkdtemp(path.join(os.tmpdir(), 'redis-indexes-'));
  t.after(async () => { sockets.forEach((socket) => socket.destroy()); await new Promise((resolve) => server.close(resolve)); await fs.rm(auditDir, { recursive: true, force: true }); });
  const redis = new RedisArchiveService({ host: '127.0.0.1', port: server.address().port, db: 2, password: 'fixture-secret', timeoutMs: 500 });
  const database = { withPgSnapshot: async (work) => work({ query: async (sql, params) => { state.pgCalls.push({ sql, params }); return { rows: state.pgRows }; } }) };
  const indexes = new RedisIndexes({ redis, database, auditDir });
  return { indexes, state, auditDir, redis };
}

test('index mapping uses distinct root fields, all root versions, deduplication and lossless IDs', () => {
  const id = '9223372036854775801';
  const { groups, warnings } = indexCandidates({ prodInsts: [{ ...root, prodInstId: BigInt(id) }, { ...root, prodInstId: BigInt(id), hisId: 1 }, { ...root, prodInstId: 7 }], prodInstsSecondStep: [{ ...root, prodInstId: BigInt(id), account: 'wrong-scope' }] }, id);
  assert.equal(groups.length, 2); assert.equal(groups[0].key, 'rate:account:login123'); assert.equal(groups[1].key, 'rate:accNbr:13800138000');
  assert.equal(groups[0].members.length, 1); assert.equal(groups[0].members[0].servId, BigInt(id)); assert.deepEqual(warnings, []);
  assert.match(stringifyLosslessJson(groups[0].members[0]), /"servId":9223372036854775801/);
  assert.equal(indexCandidates({ prodInsts: [{ ...root, account: null }] }, '42').groups.length, 1);
  const versions = indexCandidates({ prodInsts: [root, { ...root, hisId: 1, areaCode: '0591' }] }, '42');
  assert.equal(versions.groups[0].members.length, 2); assert.equal(versions.groups[1].members.length, 2);
  assert.throws(() => indexCandidates({ prodInsts: [] }, '42'), { code: 'INDEX_ROOT_MISSING' });
  assert.throws(() => indexCandidates({ prodInsts: [{ ...root, areaCode: null }] }, '42'), { code: 'INDEX_AREA_MISSING' });
});

test('preview is read-only; apply creates binary SETs, reads back, audits and consumes token', async (t) => {
  const { indexes, state, auditDir } = await fixture(t);
  const before = Buffer.from(state.keys.get('rate:cpp:42'));
  const p = await indexes.preview('42');
  assert.equal(p.missingKeys, 2); assert.equal(p.canApply, true); assert.equal(state.writes, 0); assert.ok(!state.commands.includes('EVAL'));
  assert.equal(p.target.host, '127.0.0.1'); assert.equal(p.target.db, 2);
  assert.doesNotMatch(JSON.stringify(p), /fixture-secret|encoded|fingerprint/);
  const result = await indexes.apply(p.previewId, true);
  assert.equal(result.verified, true); assert.equal(result.createdKeys.length, 2); assert.equal(state.writes, 2);
  assert.deepEqual(state.keys.get('rate:cpp:42'), before);
  assert.deepEqual(decodeArchive(state.keys.get('rate:account:login123')[0]).data, { areaCode: '0597', servId: 42, account: 'login123' });
  assert.deepEqual(decodeArchive(state.keys.get('rate:accNbr:13800138000')[0]).data, { areaCode: '0597', servId: 42, accNbr: '13800138000' });
  assert.equal(JSON.parse(await fs.readFile(path.join(auditDir, `${result.auditId}.json`))).status, 'verified');
  await assert.rejects(indexes.apply(p.previewId, true), { code: 'INDEX_PREVIEW_EXPIRED' });
});

test('existing keys of any type remain untouched and are excluded from creation', async (t) => {
  const { indexes, state } = await fixture(t); const existing = Buffer.from('existing-not-a-set'); state.keys.set('rate:account:login123', existing);
  const p = await indexes.preview('42'); assert.equal(p.missingKeys, 1); assert.equal(p.groups[0].type, 'string');
  await indexes.apply(p.previewId, true); assert.deepEqual(state.keys.get('rate:account:login123'), existing); assert.equal(state.writes, 1);
  const next = await indexes.preview('42'); assert.equal(next.canApply, false);
  await assert.rejects(indexes.apply(next.previewId, true), { code: 'INDEX_NOTHING_MISSING' });
});

test('source changes and destination races stop the complete batch without partial creation', async (t) => {
  const { indexes, state } = await fixture(t);
  let p = await indexes.preview('42'); state.sourceChange = true;
  await assert.rejects(indexes.apply(p.previewId, true), { code: 'INDEX_SOURCE_CHANGED' }); assert.equal(state.writes, 0);
  state.sourceChange = false; state.keys.set('rate:cpp:42', archive({ prodInsts: [root] }));
  p = await indexes.preview('42'); state.race = true;
  await assert.rejects(indexes.apply(p.previewId, true), { code: 'INDEX_TARGET_CHANGED' }); assert.equal(state.writes, 0); assert.equal(state.keys.has('rate:account:login123'), false);
});

test('confirmation, expiry, connection changes and missing/invalid source prevent writes', async (t) => {
  const { indexes, state, redis } = await fixture(t);
  let p = await indexes.preview('42');
  await assert.rejects(indexes.apply(p.previewId, 'true'), { code: 'INDEX_CONFIRM_REQUIRED' });
  indexes.clock = () => Date.now() + 600001;
  await assert.rejects(indexes.apply(p.previewId, true), { code: 'INDEX_PREVIEW_EXPIRED' }); indexes.clock = Date.now;
  p = await indexes.preview('42'); redis.config.db = 3;
  await assert.rejects(indexes.apply(p.previewId, true), { code: 'INDEX_PREVIEW_EXPIRED' }); redis.config.db = 2;
  await assert.rejects(indexes.preview('43'), { code: 'INDEX_CPP_MISSING' });
  await assert.rejects(indexes.preview('0'), { code: 'INVALID_INDEX_INPUT' });
  state.keys.set('rate:cpp:42', Buffer.from('corrupted'));
  await assert.rejects(indexes.preview('42')); assert.equal(state.writes, 0);
});

test('lost write response and readback mismatch keep uncertain evidence and block replay', async (t) => {
  const { indexes, state, auditDir } = await fixture(t);
  for (const mode of ['drop', 'mismatch']) {
    state.keys.delete('rate:account:login123'); state.keys.delete('rate:accNbr:13800138000');
    const p = await indexes.preview('42'); state[mode] = true;
    let caught; try { await indexes.apply(p.previewId, true); } catch (error) { caught = error; }
    assert.equal(caught.details.status, 'uncertain');
    assert.equal(JSON.parse(await fs.readFile(path.join(auditDir, `${caught.details.auditId}.json`))).status, 'uncertain');
    await assert.rejects(indexes.apply(p.previewId, true), { code: 'INDEX_PREVIEW_EXPIRED' }); state[mode] = false;
  }
});

test('audit persistence failure stops creation before sending Lua', async (t) => {
  const { indexes, state, auditDir } = await fixture(t);
  const p = await indexes.preview('42');
  const file = path.join(auditDir, 'not-a-directory'); await fs.writeFile(file, 'fixture'); indexes.auditDir = file;
  await assert.rejects(indexes.apply(p.previewId, true));
  assert.equal(state.writes, 0); assert.equal(state.commands.includes('EVAL'), false);
});

test('phone resolves existing accNbr first; missing index uses bounded parameterized PG lookup', async (t) => {
  const { indexes, state } = await fixture(t);
  state.pgRows = [{ prod_inst_id: '42' }, { prod_inst_id: '43' }];
  let result = await indexes.lookup('phone', '13800138000');
  assert.equal(result.candidates.length, 2); assert.match(state.pgCalls[0].sql, /bill_inmemory\.prod_inst WHERE acc_nbr = \$1/); assert.match(state.pgCalls[0].sql, /LIMIT 101/); assert.deepEqual(state.pgCalls[0].params, ['13800138000']);
  state.keys.set('rate:accNbr:13800138000', [archive({ areaCode: '0597', servId: 42, accNbr: '13800138000' })]);
  result = await indexes.lookup('phone', '13800138000'); assert.equal(result.candidates[0].productInstanceId, '42'); assert.equal(state.pgCalls.length, 1);
  state.keys.set('rate:accNbr:13800138000', [archive({ areaCode: '0597', servId: 42, accNbr: 'wrong' })]);
  await assert.rejects(indexes.lookup('phone', '13800138000'), { code: 'INDEX_MEMBER_INVALID' });
  state.keys.delete('rate:accNbr:13800138000'); state.pgRows = Array.from({ length: 101 }, (_, i) => ({ prod_inst_id: String(i + 1) }));
  await assert.rejects(indexes.lookup('phone', '13800138000'), { code: 'INDEX_SCOPE_TOO_LARGE' });
  await assert.rejects(indexes.lookup('automatic', '42'), { code: 'INVALID_INDEX_INPUT' });
  assert.equal(state.writes, 0);
});

test('index HTTP routes enforce schema, confirmation and same-origin writes', async (t) => {
  const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body, headers = {}) => {
    const res = await fetch(`${base}/api/redis-index/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  for (const [route, body, code] of [
    ['lookup', { inputType: 'guess', value: '42' }, 'INVALID_INDEX_INPUT'],
    ['preview', { productInstanceId: 'other:key' }, 'INVALID_REDIS_KEY'],
    ['preview', { productInstanceId: '42', members: [] }, 'UNKNOWN_FIELD'],
    ['apply', { previewId: 'fixture', confirmed: false }, 'INDEX_CONFIRM_REQUIRED'],
    ['apply', { previewId: 'fixture', confirmed: 'true' }, 'INDEX_CONFIRM_REQUIRED'],
  ]) { const result = await post(route, body); assert.equal(result.status, 400); assert.equal(result.body.error.code, code); }
  assert.equal((await post('apply', { previewId: 'fixture', confirmed: true }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await post('apply', { previewId: 'fixture', confirmed: true }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('apply', { previewId: 'fixture', confirmed: true }, { Origin: base })).body.error.code, 'INDEX_PREVIEW_EXPIRED');
  const originals = Object.fromEntries(['lookup', 'preview', 'apply'].map((name) => [name, RedisIndexes.prototype[name]])); const calls = [];
  try {
    for (const name of Object.keys(originals)) RedisIndexes.prototype[name] = async (...args) => { calls.push({ name, args }); return { verified: true }; };
    assert.equal((await post('lookup', { inputType: 'instance', value: '42' })).status, 200);
    assert.equal((await post('preview', { productInstanceId: '42' })).status, 200);
    assert.equal((await post('apply', { previewId: 'fixture', confirmed: true }, { Origin: base })).body.result.verified, true);
    assert.deepEqual(calls.map((call) => call.name), ['lookup', 'preview', 'apply']); assert.ok(calls[0].args[2].signal); assert.equal(calls[2].args[1], true);
  } finally { Object.assign(RedisIndexes.prototype, originals); }
});

test('index page wires separate inputs, request invalidation, confirmation and no browser persistence', async () => {
  const html = await fs.readFile(path.join(__dirname, '../../public/index.html'), 'utf8');
  const source = await fs.readFile(path.join(__dirname, '../../public/js/redis-indexes.js'), 'utf8');
  const main = await fs.readFile(path.join(__dirname, '../../public/js/main.js'), 'utf8');
  for (const id of ['redisIndexForm', 'redisIndexType', 'redisIndexInput', 'redisIndexCandidate', 'btnRedisIndexPreview', 'btnRedisIndexApply', 'btnRedisIndexCancel', 'redisIndexState', 'redisIndexResults']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="btnRedisIndexApply"[^>]*disabled/);
  assert.match(main, /initRedisIndexes\(redisActions\)/);
  assert.match(source, /gate\.cancel\(\)/); assert.match(source, /request\.isCurrent\(\)/); assert.match(source, /preview !== selected/);
  assert.match(source, /previewId: selected\.previewId, confirmed: true/);
  assert.match(source, /group\.status === 'created'/); assert.doesNotMatch(source, /innerHTML|localStorage|sessionStorage/);
});
