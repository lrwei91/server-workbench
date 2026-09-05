const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const ssh = require('../../server/ssh');
const sftp = require('../../server/sftp');
const log = require('../../server/log');
const hdfs = require('../../server/hdfs');
const hbase = require('../../server/hbase');
const { createServer, asRequestError, MAX_BODY_BYTES } = require('../../server/server');

function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({ host: address.address, port: address.port, method, path, headers: body === undefined ? {} : { 'content-type': 'application/json' } }, (res) => {
      let data = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    }); req.on('error', reject); if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body)); req.end();
  });
}

test('shell quoting protects single quotes and command danger detection is broad', () => {
  assert.equal(ssh.shellQuote("a'b"), "'a'\\''b'");
  assert.equal(ssh.isDangerousCommand('rmdir /tmp/a'), true);
  assert.equal(ssh.isDangerousCommand('format /dev/sda'), true);
  assert.equal(ssh.FORBIDDEN_RE.test('rm -rf /'), true);
  assert.equal(ssh.FORBIDDEN_RE.test('sudo rm -f -r /'), true);
  assert.equal(ssh.FORBIDDEN_RE.test('rm -rf /tmp/work'), false);
});

test('HDFS listing parser returns structured safe entries', () => {
  const item = hdfs.parseHdfsLsLine('drwxr-xr-x   - user group          0 2026-08-31 15:02 /apps/a folder');
  assert.equal(item.isDir, true); assert.equal(item.name, 'a folder'); assert.equal(item.path, '/apps/a folder');
  assert.equal(hdfs.parseHdfsLsLine('not an hdfs line'), null);
});

test('HDFS operation errors keep actionable status and message', () => {
  const missing = asRequestError(new Error('本地文件不存在或 HDFS 目标目录不存在：/apps/input'));
  assert.equal(missing.status, 404); assert.equal(missing.code, 'HDFS_PATH_NOT_FOUND');
  assert.match(missing.message, /HDFS 目标目录不存在/);
  const exists = asRequestError(new Error('HDFS 目标已存在同名文件：/apps/input/a.json'));
  assert.equal(exists.status, 409); assert.equal(exists.code, 'HDFS_TARGET_EXISTS');
  const failed = asRequestError(new Error('HDFS 上传失败：Connection reset by peer'));
  assert.equal(failed.status, 502); assert.equal(failed.code, 'HDFS_OPERATION_FAILED');
  assert.equal(failed.retryable, true);
  const timeout = asRequestError(new Error('HDFS 上传超时（Hadoop 客户端冷启动较慢）'));
  assert.equal(timeout.status, 504); assert.equal(timeout.code, 'HDFS_TIMEOUT');
  assert.match(timeout.message, /冷启动/);
});

test('HBase scan keeps the requested limit and SSH truncation metadata', async () => {
  const originalExec = ssh.execCommand;
  const calls = [];
  ssh.execCommand = async (command, timeout) => {
    calls.push({ command, timeout });
    return { code: 0, stdout: "scan 'ns:t', {LIMIT => 50}\nrow-1\n", stderr: '', truncated: true };
  };
  try {
    const result = await hbase.hbaseScan('/ns:t', 50);
    assert.equal(result.table, 'ns:t');
    assert.equal(result.limit, 50);
    assert.equal(result.truncated, true);
    assert.match(result.text, /row-1/);
    assert.match(calls[0].command, /hbase shell/);
  } finally { ssh.execCommand = originalExec; }
});

test('HTTP errors have real status and normalized shape', async () => {
  const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const missing = await request(server, 'GET', '/api/nope');
    assert.equal(missing.status, 404); assert.equal(missing.body.ok, false); assert.equal(missing.body.error.code, 'NOT_FOUND');
    const danger = await request(server, 'POST', '/api/exec', { cmd: 'rm -f /tmp/x' });
    assert.equal(danger.status, 409); assert.equal(danger.body.error.code, 'CONFIRMATION_REQUIRED');
    const invalid = await request(server, 'POST', '/api/exec', '{bad');
    assert.equal(invalid.status, 400); assert.equal(invalid.body.error.code, 'INVALID_JSON');
    const invalidDate = await request(server, 'GET', '/api/log/list?date=not-a-date');
    assert.equal(invalidDate.status, 400); assert.equal(invalidDate.body.error.code, 'INVALID_DATE');
    const unknown = await request(server, 'POST', '/api/exec', { cmd: 'echo ok', extra: true });
    assert.equal(unknown.status, 400); assert.equal(unknown.body.error.code, 'UNKNOWN_FIELD');
    const tooLarge = await request(server, 'POST', '/api/exec', 'x'.repeat(MAX_BODY_BYTES + 1));
    assert.equal(tooLarge.status, 413); assert.equal(tooLarge.body.error.code, 'BODY_TOO_LARGE');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('connection generation gate and structured SFTP operations use one channel', async () => {
  const ssh2 = require('ssh2');
  const originalClient = ssh2.Client;
  let clientCount = 0;
  class FakeSftp extends EventEmitter {
    constructor() { super(); this.calls = []; }
    stat(remotePath, cb) { cb(null, { isDirectory: () => remotePath === '/tmp' }); }
    readdir(_remotePath, cb) { cb(null, [{ filename: 'z.txt', attrs: { mode: 0o100644, size: 2, mtime: 1 }, longname: '-rw-r--r-- z.txt' }, { filename: 'dir', attrs: { mode: 0o040755, size: 0, mtime: 1 }, longname: 'drwxr-xr-x dir' }]); }
    realpath(remotePath, cb) { cb(null, remotePath); }
    mkdir(remotePath, _attrs, cb) { this.calls.push(['mkdir', remotePath]); cb(null); }
    open(remotePath, flags, cb) { this.calls.push(['open', remotePath, flags]); cb(null, { remotePath }); }
    close(handle, cb) { this.calls.push(['close', handle.remotePath]); cb(null); }
    unlink(remotePath, cb) { this.calls.push(['unlink', remotePath]); cb(null); }
    rmdir(remotePath, cb) { this.calls.push(['rmdir', remotePath]); cb(null); }
  }
  class FakeClient extends EventEmitter {
    constructor() { super(); this.sftpChannel = new FakeSftp(); this.delay = clientCount++ === 0 ? 30 : 0; }
    connect() { setTimeout(() => this.emit('ready'), this.delay); }
    exec(_command, cb) { const stream = new EventEmitter(); stream.stderr = new EventEmitter(); setTimeout(() => { cb(null, stream); stream.emit('data', Buffer.from('/home/test\n')); stream.emit('close', 0); }, 0); }
    sftp(cb) { cb(null, this.sftpChannel); }
    end() { this.emit('close'); }
  }
  ssh2.Client = FakeClient;
  try {
    const first = ssh.connect({ host: 'first', username: 'tester', password: 'secret' });
    const second = ssh.connect({ host: 'second', username: 'tester', password: 'secret' });
    await assert.rejects(first, /过期/);
    const connected = await second;
    assert.equal(connected.host, 'second');
    const items = await sftp.sftpList('/tmp');
    assert.deepEqual(items.map((item) => item.name), ['dir', 'z.txt']);
    await sftp.sftpMkdir('/tmp/new');
    await sftp.sftpTouch('/tmp/new.txt');
    await sftp.sftpDelete('/tmp/new.txt', 'file');
    await sftp.sftpDelete('/tmp/empty', 'dir');
    assert.deepEqual((ssh.conn.sftpChannel).calls, [['mkdir', '/tmp/new'], ['open', '/tmp/new.txt', 'wx'], ['close', '/tmp/new.txt'], ['unlink', '/tmp/new.txt'], ['rmdir', '/tmp/empty']]);
  } finally {
    ssh.disconnect();
    ssh2.Client = originalClient;
  }
});

test('log queue writes asynchronously and paginates newest entries', async () => {
  const date = log.today(); await log.append({ t: '00:00:01', cmd: 'test-node', badge: '成功', out: 'safe output' }, date);
  const result = await log.list(date, { limit: 1 });
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0].cmd, 'test-node'); assert.equal(result.total >= 1, true); assert.equal(typeof result.hasMore, 'boolean');
});
