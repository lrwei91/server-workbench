const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../public/js/navigation.js'), 'utf8').replace(/^import .*$/mg, '').replace(/export /g, '');
const context = vm.createContext({});
vm.runInContext(source, context);
const parse = hash => JSON.parse(JSON.stringify(vm.runInContext(`parseRoute(${JSON.stringify(hash)})`, context)));
test('routes restore only known modules and subpages', () => {
  assert.deepEqual(parse('#/query/relations'), { page: 'query', tab: 'relations' });
  assert.deepEqual(parse('#/redis/history'), { page: 'redis', tab: 'history' });
  assert.deepEqual(parse('#/logs'), { page: 'logs', tab: '' });
  for (const hash of ['', '#/unknown', '#/query/phone/13800138000', '#/constructor']) assert.deepEqual(parse(hash), { page: 'resources', tab: 'files' });
  assert.deepEqual(parse('#/redis/13800138000'), { page: 'resources', tab: 'files' });
  assert.deepEqual(parse('#/query/unknown'), { page: 'query', tab: 'phone' });
});
