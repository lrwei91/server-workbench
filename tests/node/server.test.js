const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const ssh = require('../../server/ssh');
const sftp = require('../../server/sftp');
const log = require('../../server/log');
const hdfs = require('../../server/hdfs');
const hbase = require('../../server/hbase');
const config = require('../../server/config-loader');
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

test('HDFS listing never treats partial stdout with a failed exit code as success', async () => {
  const originalExec = ssh.execCommand;
  ssh.execCommand = async () => ({
    code: 1,
    stdout: '-rw-r--r--   1 user group 1 2026-08-31 15:02 /apps/partial.txt\n',
    stderr: 'RemoteException: listing interrupted',
    timedOut: false,
  });
  try {
    await assert.rejects(hdfs.hdfsList('/apps'), /HDFS 列目录失败：RemoteException/);
  } finally { ssh.execCommand = originalExec; }
});

test('HDFS preview is structured, bounded, and reports truncation', async () => {
  const originalExec = ssh.execCommand;
  ssh.execCommand = async (command) => ({ code: 0, stdout: 'x'.repeat(262145), stderr: '', truncated: false });
  try {
    const result = await hdfs.hdfsPreview('/apps/a.txt', 262144);
    assert.equal(result.text.length, 262144); assert.equal(result.truncated, true);
  } finally { ssh.execCommand = originalExec; }
});

test('HBase paths reject shell control characters before SSH execution', async () => {
  const originalExec = ssh.execCommand;
  let called = false;
  ssh.execCommand = async () => { called = true; return { code: 0, stdout: '', stderr: '' }; };
  try {
    await assert.rejects(hbase.hbaseScan("/ns:t'; list_namespace"), /HBase 表名包含不支持的字符/);
    await assert.rejects(hbase.hbaseList('/ns/extra'), /HBase 路径格式/);
    await assert.rejects(hbase.hbaseList("/ns'; list_namespace"), /HBase namespace包含不支持的字符/);
    assert.equal(called, false);
  } finally { ssh.execCommand = originalExec; }
});

test('HBase path errors map to 400 and HBase shell failures map to 502', () => {
  const invalid = asRequestError(new Error('HBase 表名包含不支持的字符'));
  assert.equal(invalid.status, 400); assert.equal(invalid.code, 'HBASE_INVALID_PATH'); assert.equal(invalid.retryable, false);
  const failed = asRequestError(new Error('HBase shell 执行失败：Master is initializing'));
  assert.equal(failed.status, 502); assert.equal(failed.code, 'REMOTE_ERROR'); assert.equal(failed.retryable, true);
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
    const invalidDb = await request(server, 'POST', '/api/db/connect', { source: 'oracle', host: 'HOST', port: 1, username: 'USER', password: '' });
    assert.equal(invalidDb.status, 400); assert.equal(invalidDb.body.error.code, 'INVALID_INPUT');
    const disconnectedQuery = await request(server, 'POST', '/api/query/phone', { phone: '13338297988' });
    assert.equal(disconnectedQuery.status, 409); assert.equal(disconnectedQuery.body.error.code, 'DB_NOT_CONNECTED');
    const disconnectedThreshold = await request(server, 'POST', '/api/query/threshold', { aProductInstanceId: '48243980' });
    assert.equal(disconnectedThreshold.status, 409); assert.equal(disconnectedThreshold.body.error.code, 'DB_NOT_CONNECTED');
    const voyageStatus = await request(server, 'GET', '/api/voyage/status');
    assert.equal(voyageStatus.status, 200); assert.equal(Object.hasOwn(voyageStatus.body.config, 'token'), false);
    const disconnectedVoyage = await request(server, 'POST', '/api/query/phone', { phone: '13338297988', source: 'voyage' });
    assert.equal(disconnectedVoyage.status, 409); assert.equal(disconnectedVoyage.body.error.code, 'VOYAGE_NOT_CONNECTED');
    const disconnectedVoyageInstance = await request(server, 'POST', '/api/query/product-instance', { productInstanceId: '48243980', source: 'voyage' });
    assert.equal(disconnectedVoyageInstance.status, 409); assert.equal(disconnectedVoyageInstance.body.error.code, 'VOYAGE_NOT_CONNECTED');
    const archiveStatus = await request(server, 'GET', '/api/archive/status');
    assert.equal(archiveStatus.status, 200); assert.equal(Object.hasOwn(archiveStatus.body.config, 'authToken'), false);
    const disconnectedArchive = await request(server, 'POST', '/api/query/archive', { key: '35772967' });
    assert.equal(disconnectedArchive.status, 409); assert.equal(disconnectedArchive.body.error.code, 'ARCHIVE_NOT_CONNECTED');
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
  const date = '2099-12-31';
  const fixturePath = path.join(log.LOG_DIR, `${date}.log`);
  try {
    await fs.promises.unlink(fixturePath).catch(() => {});
    await log.append({ t: '00:00:01', cmd: 'test-node', badge: '成功', out: 'safe output' }, date);
    const result = await log.list(date, { limit: 1 });
    assert.equal(result.entries.length, 1); assert.equal(result.entries[0].cmd, 'test-node'); assert.equal(result.total, 1); assert.equal(result.hasMore, false);
  } finally { await fs.promises.unlink(fixturePath).catch(() => {}); }
});

test('fixed query panel replaces command and log interactions', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/main.js'), 'utf8');
  assert.match(html, /<h1>数据库查询<\/h1>/); assert.match(html, /查询手机号/); assert.match(html, /实例查档案/); assert.match(html, /id="productInstanceQueryForm"/); assert.match(html, /阈值查询/); assert.match(html, /内存档案查询/); assert.match(html, /Voyage 在线数据库/); assert.match(html, /id="querySourceSelect"/); assert.match(html, /id="connectionDialog"/);
  assert.match(html, /id="insertDialog"/); assert.match(html, /id="insertSqlCopy"/); assert.match(html, /一键复制/);
  assert.doesNotMatch(html, /Redis|cacheRedis|data-cache-/);
  assert.doesNotMatch(html, /id="cmdInput"|id="logFlow"|id="btnCmds"|id="commandsDialog"/);
  assert.match(source, /postJson\('\/api\/query\/phone'/); assert.match(source, /postJson\('\/api\/query\/product-instance'/); assert.match(source, /postJson\('\/api\/query\/threshold'/); assert.match(source, /postJson\('\/api\/query\/archive'/); assert.match(source, /postJson\('\/api\/voyage\/connect'/); assert.match(source, /generateInsertScript\(result\)/); assert.match(source, /\/api\/hdfs\/preview/);
  assert.doesNotMatch(source, /\/api\/cache\/|state\.cache|CACHE_FIELDS/);
  assert.doesNotMatch(source, /postJson\('\/api\/exec'|postJson\('\/api\/log\/append'|\/api\/log\/list/);
});

test('query tabs preserve independent results until explicitly cleared', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/main.js'), 'utf8');
  assert.equal((html.match(/data-query-result="(?:phone|productInstance|threshold|archive)"/g) || []).length, 4);
  assert.match(source, /function queryResultRoot\(query = state\.activeQuery\)/);
  assert.match(source, /function syncActiveQueryView\(\)/);
  const switchFunction = source.match(/function switchQueryTab\(query\) \{[^\n]+\}/)?.[0] || '';
  assert.match(switchFunction, /syncActiveQueryView\(\)/);
  assert.doesNotMatch(switchFunction, /clearQueryResult/);
  assert.match(source, /queryResultRoot\('phone'\)\.replaceChildren/);
  assert.match(source, /queryResultRoot\('productInstance'\)\.replaceChildren/);
  assert.match(source, /queryResultRoot\('threshold'\)\.replaceChildren/);
  assert.match(source, /queryResultRoot\('archive'\)\.replaceChildren/);
});

test('query result sections show source tables and long errors preserve vertical scrolling', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/main.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../public/style.css'), 'utf8');
  assert.match(source, /resultSection\('产品实例',[^\n]+table: resultTable\('productInstances'\)/);
  assert.match(source, /resultSection\('定价计划',[^\n]+table: resultTable\('pricingPlans'\)/);
  assert.match(source, /resultSection\('档位提醒配置',[^\n]+table: resultTable\('thresholdAttributes'\)/);
  assert.match(source, /`\$\{title\} · \$\{rows\?\.length \|\| 0\} 条\$\{tableSuffix\}`/);
  assert.match(source, /数据表: tableForStep\(step\.name\)/);
  assert.match(css, /\.query-results \{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/);
  assert.match(css, /\.query-table-wrap \{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/);
  assert.match(css, /\.query-step span \{[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word;/);
});

test('workbench keeps a 1 to 1.5 desktop ratio and the phone query action on one line', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../public/style.css'), 'utf8');
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1\.5fr\)/);
  assert.match(css, /\.query-input-row \.wb-button \{[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/);
  assert.match(css, /dialog#connectionDialog\[open\][^{]*\{[^}]*width:\s*min\(1200px,\s*calc\(100vw - 32px\)\);[^}]*max-width:\s*none;/);
});

test('connection settings use independent read-only source controls and keep credentials out of browser storage', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/main.js'), 'utf8');
  const dialog = html.match(/<dialog id="connectionDialog"[\s\S]*?<\/dialog>/)?.[0] || '';
  assert.match(dialog, /<details class="connection-environment" data-connection-environment="test"><summary[^>]*><span>测试环境<\/span>/);
  assert.match(dialog, /<details class="connection-environment" data-connection-environment="project"><summary><span>工程环境<\/span>/);
  assert.doesNotMatch(dialog, /<details[^>]*\bopen\b/); assert.match(dialog, /data-connection-source="voyage"/); assert.match(dialog, /Voyage 在线数据库/); assert.match(dialog, /data-connection-source="archive"/); assert.match(dialog, /内存档案服务/);
  assert.match(dialog, /data-connection-source="ssh"/); assert.match(dialog, /data-connection-source="udal"/); assert.match(dialog, /data-connection-source="doris"/);
  assert.equal((dialog.match(/data-connection-connect="(?:ssh|udal|doris|voyage|archive)"/g) || []).length, 5); assert.doesNotMatch(dialog, /<input\b|type="password"|id="btnConnectAll"|data-db-disconnect/);
  assert.doesNotMatch(html, /id="settingsDialog"|id="dbSettingsDialog"|id="btnSettings"|id="btnDbSettings"/);
  assert.match(source, /postJson\('\/api\/connect', \{\}/); assert.match(source, /postJson\('\/api\/db\/connect', \{ source \}/); assert.match(source, /postJson\('\/api\/voyage\/connect', \{\}/); assert.match(source, /postJson\('\/api\/archive\/connect', \{\}/); assert.doesNotMatch(source, /\/api\/connections\/connect|wb_conn_cfg|wb_db_cfg|sessionPassword|DB_FIELDS/);
});

test('SSH connection status is rendered inside the resource explorer instead of the top bar', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  const topbar = html.match(/<header class="topbar">[\s\S]*?<\/header>/)?.[0] || '';
  const explorer = html.match(/<section class="explorer-panel"[\s\S]*?<div class="tabs"/)?.[0] || '';
  assert.doesNotMatch(topbar, /id="statusDot"|id="statusText"|class="connection"/);
  assert.match(explorer, /class="resource-connection"/); assert.match(explorer, /id="statusDot"/); assert.match(explorer, /id="statusText"/);
});

test('local env parser supports quoted credentials without exposing them through config masks', () => {
  assert.deepEqual(config.parseEnv('SSH_HOST=HOST\nSSH_PASSWORD="a#b$1"\nexport SSH_PORT=22\n'), { SSH_HOST: 'HOST', SSH_PASSWORD: 'a#b$1', SSH_PORT: '22' });
  const masked = ssh.maskConfig(config.ssh); assert.equal(masked.hasPassword, Boolean(config.ssh.password)); assert.equal(Object.hasOwn(masked, 'password'), false);
});

test('server-generated resource timestamps use an explicit UTC+8 offset', () => {
  assert.equal(sftp.utc8IsoFromEpochSeconds(0), '1970-01-01T08:00:00.000+08:00');
  assert.match(log.today(new Date('2026-09-15T17:00:00.000Z')), /^2026-09-16$/);
});

test('resource refresh keeps one visible countdown and ignores duplicate in-flight refreshes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/main.js'), 'utf8');
  const loadingFunction = source.match(/function startResourceLoading\(kind\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(loadingFunction, /status\(`\$\{meta\.label\} · \$\{currentResourcePath\(kind\)\} · \$\{message\}`\)/);
  assert.doesNotMatch(loadingFunction, /announce\(resourceStatusNode\(kind\), message/);
  assert.match(source, /if \(!state\.connected \|\| resourceState\(kind\)\.loading\) return null;/);
  assert.match(source, /\$\('#hdfsPathInput'\)\.value = state\.hdfsCwd/);
});

test('HDFS quick paths distinguish test and production rating directories', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  assert.match(html, /data-hdfs-path="\/apps\/bill_cnos_jf_test\/cal">批价 cal（测试）/);
  assert.match(html, /data-hdfs-path="\/apps\/bill_cnos_jf\/cal">批价 cal（生产）/);
});
