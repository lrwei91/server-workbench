const test = require('node:test');
const assert = require('node:assert/strict');
const { ArchiveService, ArchiveServiceError, normalizeArchiveKey, maskConfig } = require('../../server/archive-service');

function configured(extra = {}) {
  return { pageUrl: 'http://HOST/dataop', apiUrl: 'http://HOST/api/archive', authToken: 'TOKEN', timeoutMs: 1000, ...extra };
}

test('archive keys accept product instance ids and canonical rate keys without losing precision', () => {
  assert.deepEqual(normalizeArchiveKey(' 35772967 '), { key: 'rate:cpp:35772967', productInstanceId: '35772967' });
  assert.deepEqual(normalizeArchiveKey('rate:cpp:900719925474099312345'), { key: 'rate:cpp:900719925474099312345', productInstanceId: '900719925474099312345' });
  assert.throws(() => normalizeArchiveKey('other:35772967'), (error) => error.code === 'INVALID_ARCHIVE_KEY');
});

test('archive configuration masks credentials and pending configuration never calls an adapter', async () => {
  let called = false;
  const adapter = { connect: async () => { called = true; }, disconnect: async () => {}, query: async () => ({ found: false }) };
  const service = new ArchiveService({ pageUrl: 'http://HOST/dataop', apiUrl: '', authToken: 'TOKEN' }, adapter);
  const masked = maskConfig(service.config);
  assert.equal(masked.hasCredential, true); assert.equal(Object.hasOwn(masked, 'authToken'), false);
  await assert.rejects(service.connect(), (error) => error.code === 'ARCHIVE_NOT_CONFIGURED');
  assert.equal(called, false);
});

test('archive adapter returns normalized nested data, empty results, and unsupported shapes', async () => {
  const responses = new Map([
    ['rate:cpp:1', { found: true, data: { account: { id: '900719925474099312345' }, products: [{ id: '1' }] } }],
    ['rate:cpp:2', { found: false }],
    ['rate:cpp:3', Buffer.from([0, 1, 2])],
  ]);
  const adapter = { connect: async () => {}, disconnect: async () => {}, query: async (key) => responses.get(key) };
  const service = new ArchiveService(configured(), adapter); await service.connect();
  const complete = await service.query('1'); assert.equal(complete.status, 'complete'); assert.equal(complete.data.account.id, '900719925474099312345'); assert.match(complete.readAt, /\+08:00$/);
  const empty = await service.query('rate:cpp:2'); assert.equal(empty.status, 'empty'); assert.equal(empty.data, null);
  const unsupported = await service.query('3'); assert.equal(unsupported.status, 'unsupported'); assert.equal(unsupported.data, null);
});

test('archive query supports caller cancellation and disconnect cancellation', async () => {
  const adapter = {
    connect: async () => {}, disconnect: async () => {},
    query: async (_key, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  };
  const service = new ArchiveService(configured(), adapter); await service.connect();
  const caller = new AbortController(); const cancelled = service.query('1', { signal: caller.signal }); caller.abort();
  await assert.rejects(cancelled, (error) => error.code === 'QUERY_CANCELLED');
  const disconnected = service.query('2'); await service.disconnect();
  await assert.rejects(disconnected, (error) => error.code === 'QUERY_CANCELLED'); assert.equal(service.status().connected, false);
});

test('archive adapter preserves authentication failures and enforces timeout', async () => {
  const denied = new ArchiveService(configured(), { connect: async () => { throw new ArchiveServiceError(401, 'ARCHIVE_AUTH_FAILED', '鉴权失败'); }, disconnect: async () => {} });
  await assert.rejects(denied.connect(), (error) => error.code === 'ARCHIVE_AUTH_FAILED');
  const hanging = new ArchiveService(configured({ timeoutMs: 1000 }), {
    connect: async () => {}, disconnect: async () => {},
    query: async (_key, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  });
  await hanging.connect();
  await assert.rejects(hanging.query('1'), (error) => error.code === 'ARCHIVE_QUERY_TIMEOUT' && error.status === 504);
});
