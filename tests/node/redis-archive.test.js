'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RedisArchiveService,
  decodeRedisArchiveValue,
  decompressLz4Block,
  normalizeRedisArchiveKey,
  parseResp,
} = require('../../server/redis-archive');

function literalLz4(input) {
  const value = Buffer.from(input);
  const extension = [];
  let remaining = Math.max(0, value.length - 15);
  while (remaining >= 255) { extension.push(255); remaining -= 255; }
  if (value.length >= 15) extension.push(remaining);
  return Buffer.concat([Buffer.from([Math.min(15, value.length) << 4, ...extension]), value]);
}

function archiveFixture(data) {
  const decoded = Buffer.concat([Buffer.from('03fa8a11', 'hex'), Buffer.from(JSON.stringify(data))]);
  const header = Buffer.alloc(4); header.writeUInt32BE(decoded.length);
  return Buffer.concat([header, literalLz4(decoded)]);
}

test('normalizes rate:cpp keys and rejects arbitrary Redis keys', () => {
  assert.deepEqual(normalizeRedisArchiveKey('103386066'), { key: 'rate:cpp:103386066', productInstanceId: '103386066' });
  assert.deepEqual(normalizeRedisArchiveKey('rate:cpp:103386066'), { key: 'rate:cpp:103386066', productInstanceId: '103386066' });
  assert.throws(() => normalizeRedisArchiveKey('rate:account:1'), /产品实例 ID/);
});

test('decodes length-prefixed LZ4 Redis archive values into JSON', () => {
  const data = { prodInsts: [{ prodInstId: 103386066, account: '18960519366' }], title: '福建档案' };
  const raw = archiveFixture(data);
  const result = decodeRedisArchiveValue(raw);
  assert.deepEqual(result.data, data);
  assert.equal(result.decodedBytes, Buffer.byteLength(JSON.stringify(data)) + 4);
  assert.equal(result.compressedBytes, raw.length);
  assert.equal(result.prefixHex, '03fa8a11');
});

test('LZ4 decoder rejects invalid offsets and declared lengths', () => {
  assert.throws(() => decompressLz4Block(Buffer.from([0x00, 0x00, 0x00]), 4), /回溯偏移量无效/);
  const raw = archiveFixture({ ok: true }); raw.writeUInt32BE(32 * 1024 * 1024, 0);
  assert.throws(() => decodeRedisArchiveValue(raw, { maxDecodedBytes: 1024 }), /超出限制/);
});

test('RESP parser preserves binary bulk strings', () => {
  const result = parseResp(Buffer.from([0x24, 0x33, 0x0d, 0x0a, 0x00, 0xff, 0x7b, 0x0d, 0x0a]));
  assert.deepEqual(result.value, Buffer.from([0x00, 0xff, 0x7b]));
  assert.equal(result.next, 9);
});

test('Redis archive service masks credentials and reports missing config', async () => {
  const service = new RedisArchiveService({ host: '', password: 'secret' });
  assert.deepEqual(service.defaults(), { host: '', port: 16379, db: 0, configured: false, hasCredential: true, timeoutMs: 15000, maxDecodedBytes: 16 * 1024 * 1024 });
  await assert.rejects(service.query('1'), (error) => error.code === 'REDIS_NOT_CONFIGURED' && error.status === 409);
});
