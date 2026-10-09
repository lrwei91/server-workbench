const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createServer } = require('../../server/server');
const runtime = require('../../desktop/runtime.cjs');
const { configureUpdates } = require('../../desktop/updates.cjs');
const builder = require('../../electron-builder.cjs');

test('desktop auth protects static, Node APIs and CDR proxy without changing browser mode', async (t) => {
  const server = createServer({ token: 'test-secret' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/', '/api/health', '/cdr/api/session']) assert.equal((await fetch(origin + route)).status, 403);
  const headers = { 'x-workbench-token': 'test-secret' };
  assert.equal((await fetch(origin + '/api/health', { headers })).status, 200);
  assert.equal((await fetch(origin + '/api/health', { headers: { ...headers, origin: 'https://example.com' } })).status, 403);
});

test('desktop config is separate, preserves existing env and pins child paths/credentials', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-desktop-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const example = path.join(directory, 'example'); fs.writeFileSync(example, 'SSH_HOST=sample');
  const envPath = runtime.prepareDirectories(directory, example);
  fs.writeFileSync(envPath, 'SSH_HOST=user'); runtime.prepareDirectories(directory, example);
  assert.equal(fs.readFileSync(envPath, 'utf8'), 'SSH_HOST=user');
  runtime.writeSettings(directory, { backendPort: 12345, sourceDir: 'chosen', automaticUpdates: false });
  assert.equal(runtime.readSettings(directory).backendPort, 12345);
  const env = runtime.childEnvironment(directory, { CDR_PORT: '1', CDR_SOURCE_DIR: 'env-source', WORKBENCH_HOST: '0.0.0.0', CDR_SESSION_TOKEN: 'bad' }, { sourceDir: 'chosen' }, 23456, 'ephemeral');
  assert.equal(env.WORKBENCH_HOST, '127.0.0.1'); assert.equal(env.CDR_PORT, '23456');
  assert.equal(env.CDR_SESSION_TOKEN, 'ephemeral'); assert.equal(env.CDR_SOURCE_DIR, 'chosen');
  assert.equal(env.WORKBENCH_CONFIG_DIR, directory); assert.equal(env.CDR_OUTPUT_DIR, path.join(directory, 'outputs'));
});

function fixture({ available = true, packaged = true, approved = true } = {}) {
  const updater = new EventEmitter(); const calls = [];
  updater.checkForUpdates = async () => { calls.push('check'); return { cancellationToken: available ? {} : null, updateInfo: { version: '1.1.0', releaseNotes: '<b>notes</b>' } }; };
  updater.downloadUpdate = async () => { calls.push('download'); updater.emit('update-downloaded'); };
  const controller = configureUpdates({ updater, packaged, notify: async () => calls.push('notify'), confirm: async () => approved, install: async () => calls.push('install'), progress: () => {}, log: () => {} });
  return { updater, calls, controller };
}
test('update waits for confirmation/download, never installs on ordinary quit', async () => {
  const { updater, calls, controller } = fixture();
  await controller.check();
  assert.deepEqual(calls, ['check', 'download', 'install']);
  assert.equal(updater.autoInstallOnAppQuit, false); assert.equal(updater.autoDownload, false);
  assert.equal(updater.allowDowngrade, false);
});
test('update declines and dev/latest checks do not download', async () => {
  for (const options of [{ approved: false }, { packaged: false }, { available: false }]) {
    const { calls, controller } = fixture(options); await controller.check(true);
    assert.ok(!calls.includes('download')); assert.ok(!calls.includes('install'));
  }
});
test('update recovers check state after network failure', async () => {
  const { updater, calls, controller } = fixture();
  updater.checkForUpdates = async () => { throw new Error('network'); };
  await controller.check(true); await controller.check(true);
  assert.deepEqual(calls, ['notify', 'notify']);
});
test('update keeps discovery dialog busy against repeated checks', async () => {
  const updater = new EventEmitter(); let checks = 0; let release;
  updater.checkForUpdates = async () => { checks++; return { cancellationToken: {}, updateInfo: { version: '1.1.0' } }; };
  const controller = configureUpdates({ updater, packaged: true, notify: async () => {}, confirm: () => new Promise((resolve) => { release = resolve; }), install: async () => {}, progress: () => {}, log: () => {} });
  const first = controller.check(); await new Promise((resolve) => setImmediate(resolve));
  await controller.check(true); assert.equal(checks, 1);
  release(false); await first;
});
test('config loader uses desktop env and writable logs, not installed directory', (t) => {
  const { spawnSync } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, '.env'), 'WORKBENCH_PORT=24567\nSSH_HOST=desktop-fixture\n');
  const child = spawnSync(process.execPath, ['-e', 'const c=require("./server/config-loader"); console.log(JSON.stringify({port:c.workbench.port,host:c.ssh.host,logs:c.resolveLogDir()}))'], { cwd: path.join(__dirname, '../..'), env: { ...process.env, WORKBENCH_CONFIG_DIR: directory, WORKBENCH_DATA_DIR: directory }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { port: 24567, host: 'desktop-fixture', logs: path.join(directory, 'logs') });
});
test('installer uses public GitHub NSIS and explicit resource allowlist', () => {
  assert.equal(builder.publish[0].owner, 'lrwei91'); assert.equal(builder.publish[0].repo, 'server-workbench');
  assert.equal(builder.win.target[0].target, 'nsis'); assert.deepEqual(builder.win.target[0].arch, ['x64']);
  assert.equal(builder.nsis.deleteAppDataOnUninstall, false);
  assert.ok(builder.files.includes('.env.example')); assert.ok(!builder.files.includes('.env'));
  assert.ok(!builder.files.includes('config.js')); assert.ok(!builder.files.includes('logs/**/*'));
});
test('quit/update protects dirty session and failed state check before shutdown', async () => {
  let prompts = 0;
  const confirm = async () => { prompts++; return false; };
  assert.equal(await runtime.confirmSessionClose(async () => ({ dirty: false }), confirm), true);
  assert.equal(prompts, 0);
  assert.equal(await runtime.confirmSessionClose(async () => ({ dirty: true }), confirm), false);
  assert.equal(await runtime.confirmSessionClose(async () => { throw new Error('offline'); }, confirm), false);
  assert.equal(prompts, 2);
  assert.equal(await runtime.confirmSessionClose(async () => ({ dirty: true }), async () => true), true);
});
