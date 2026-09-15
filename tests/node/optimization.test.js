const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createServer } = require('../../server/server');

test('static resources stream concurrently and keep missing/directory/traversal responses', async (t) => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = path => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path }, res => {
      let body = '';
      res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  const results = await Promise.all(Array.from({ length: 16 }, () => request('/app.js')));
  results.forEach(result => { assert.equal(result.status, 200); assert.match(result.body, /import/); });
  assert.equal((await request('/js/missing-file.js')).status, 404);
  assert.equal((await request('/js/')).status, 404);
  assert.equal((await request('/shared/..\\package.json')).status, 404);
});

for (const protocol of ['http:', 'https:']) {
  test(`CDR proxy selects ${protocol} transport and preserves query/body`, () => {
    const source = fs.readFileSync(require.resolve('../../server/proxy'), 'utf8');
    const calls = [];
    const transport = name => ({ request(options) {
      calls.push({ name, options });
      const request = new EventEmitter(); request.end = () => {}; return request;
    } });
    const context = { URL, module: { exports: {} }, require(name) {
      if (name === './config-loader') return { cdr: { upstream: `${protocol}//localhost:9443` } };
      return transport(name);
    } };
    vm.runInNewContext(source, context);
    let piped = false;
    context.module.exports.proxyToCdr({ url: '/cdr/api/load?x=1', method: 'POST', headers: { 'content-type': 'application/json' }, pipe() { piped = true; } }, {}, '/api/load');
    assert.equal(calls[0].name, protocol.slice(0, -1));
    assert.equal(calls[0].options.path, '/api/load?x=1');
    assert.equal(calls[0].options.headers['content-type'], 'application/json');
    assert.equal(piped, true);
  });
}

test('CDR startup loads files once and restores a loaded session', async () => {
  const source = fs.readFileSync(require.resolve('../../cdr/static/js/main.js'), 'utf8');
  const refresh = source.split('\n').find(line => line.startsWith('async function refreshSession('));
  const init = source.split('\n').find(line => line.startsWith('(async function init()'));
  const counts = { files: 0, records: 0, history: 0 };
  const select = {};
  const context = { state: {}, getJson: async () => ({ loaded: true, filename: 'fixture.json', can_undo: true }), renderSession() {}, $: () => select,
    loadFiles: async () => { counts.files++; }, refreshRecords: async () => { counts.records++; }, loadExportHistory: async () => { counts.history++; }, handleError(error) { throw error; } };
  vm.createContext(context);
  vm.runInContext(refresh, context);
  await vm.runInContext(init, context);
  assert.deepEqual(counts, { files: 1, records: 1, history: 1 });
  assert.equal(select.value, 'fixture.json');
  await vm.runInContext('refreshSession()', context);
  assert.deepEqual(counts, { files: 2, records: 2, history: 2 });
});
