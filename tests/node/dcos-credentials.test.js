const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readDcosCredentials } = require('../../desktop/dcos-credentials.cjs');

test('自动填充优先读取当前用户配置，每次重读，拒绝跨平台与不完整配置', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcos-credentials-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storage = { isEncryptionAvailable: () => true, decryptString: () => JSON.stringify({ origin: 'http://platform.test:8081', username: 'old', password: 'old' }) };
  const write = text => fs.writeFileSync(path.join(dir, '.env'), text);
  const base = 'DCOS_BASE_URL=http://platform.test:8081\n';
  fs.writeFileSync(path.join(dir, 'dcos-credentials.bin'), 'encrypted-fixture');
  write(base + 'DCOS_USERNAME=fixture\nDCOS_PASSWORD="test#value"\n');
  assert.deepEqual(readDcosCredentials(dir, 'http://platform.test:8081', storage), { username: 'fixture', password: 'test#value' });
  assert.equal(readDcosCredentials(dir, 'http://other.test', storage), null);
  write(base + 'DCOS_USERNAME=fixture\n');
  assert.equal(readDcosCredentials(dir, 'http://platform.test:8081', storage), null);
  write(base);
  assert.equal(readDcosCredentials(dir, 'http://platform.test:8081', storage).username, 'old');
  assert.equal(readDcosCredentials(dir, 'http://other.test', storage), null);
  assert.equal(readDcosCredentials(dir, 'http://platform.test:8081', { isEncryptionAvailable: () => false }), null);
});
