const test = require('node:test');
const assert = require('node:assert/strict');
const { VoyageManager, compileSql, parseVoyageJson } = require('../../server/voyage');

function config(overrides = {}) {
  return {
    apiUrl: 'http://voyage.example/api/query/execute', token: 'SECRET_TOKEN', timeoutMs: 1000,
    mappings: {
      CRM3DB: { datasourceId: 5, database: 'incf_db', schema: 'crmv3' },
      CONFIGDB_CNOS_JF_TEST: { datasourceId: 5, database: 'incf_db', schema: 'crmv3' },
    },
    ...overrides,
  };
}
function response(payload, status = 200) { return { ok: status >= 200 && status < 300, status, async text() { return typeof payload === 'string' ? payload : JSON.stringify(payload); } }; }
function success(columns = ['prod_inst_id', 'acc_num'], rows = [['9007199254740993', '13338297988']]) {
  return { code: 0, data: [{ columns, rows, affected_rows: 0, duration_ms: 1, statement: 'select' }], message: 'ok' };
}

test('Voyage config is masked and fixed parameters are quoted without exposing the token', () => {
  const manager = new VoyageManager(config(), async () => response(success()));
  assert.equal(manager.defaults().hasToken, true); assert.equal(manager.defaults().configured, true);
  assert.equal(JSON.stringify(manager.status()).includes('SECRET_TOKEN'), false);
  assert.equal(compileSql('select * from t where a=? and b=?', ["a'b", 12]), "select * from t where a='a''b' and b='12'");
  assert.throws(() => compileSql('select ?', []), /数量不足/);
  assert.throws(() => compileSql('select 1', ['extra']), /数量不匹配/);
});

test('Voyage connect probes the service and query normalizes column arrays into objects', async () => {
  const requests = [];
  const manager = new VoyageManager(config(), async (url, options) => { requests.push({ url, options }); return response(success(['prod_inst_id', 'acc_num'], [[48243980, '15305972490']])); });
  await manager.connect();
  const rows = await manager.query('voyage', 'CRM3DB', 'select * from prod_inst where prod_inst_id=?', ['48243980']);
  assert.equal(rows[0].prod_inst_id, '48243980'); assert.equal(rows[0].acc_num, '15305972490');
  const body = JSON.parse(requests.at(-1).options.body);
  assert.deepEqual({ datasource_id: body.datasource_id, database: body.database, schema: body.schema, limit: body.limit }, { datasource_id: 5, database: 'incf_db', schema: 'crmv3', limit: 1000 });
  assert.match(body.sql, /prod_inst_id='48243980'/); assert.equal(requests.at(-1).options.headers.Authorization, 'Bearer SECRET_TOKEN');
  await manager.disconnect(); assert.equal(manager.status().connected, false);
});

test('Voyage preserves unsafe JSON integers and accepts empty row sets', async () => {
  const parsed = parseVoyageJson('{"code":0,"data":[{"columns":["prod_inst_id"],"rows":[[9007199254740993]]}]}');
  assert.equal(parsed.data[0].rows[0][0], '9007199254740993');
  const manager = new VoyageManager(config(), async () => response(success(['prod_inst_id'], [])));
  await manager.connect(); assert.deepEqual(await manager.query('voyage', 'CRM3DB', 'select 1', []), []);
});

test('Voyage surfaces statement errors and authentication failures with stable codes', async () => {
  const statementManager = new VoyageManager(config(), async () => response({ code: 0, data: [{ columns: null, rows: null, error: 'query error: relation does not exist', statement: 'select' }], message: 'ok' }));
  await assert.rejects(statementManager.connect(), (error) => error.code === 'VOYAGE_QUERY_FAILED' && /relation/.test(error.message));
  const authManager = new VoyageManager(config(), async () => response({ message: 'unauthorized' }, 401));
  await assert.rejects(authManager.connect(), (error) => error.code === 'VOYAGE_AUTH_FAILED' && error.status === 401);
});

test('Voyage cancellation aborts the active request', async () => {
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
  const manager = new VoyageManager(config(), fetchImpl); manager.connected = true;
  const controller = new AbortController(); const pending = manager.query('voyage', 'CRM3DB', 'select 1', [], { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, (error) => error.code === 'QUERY_CANCELLED');
});
