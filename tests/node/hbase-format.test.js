const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const formatterSource = fs.readFileSync(path.resolve(__dirname, '../../public/js/hbase-scan-format.js'), 'utf8');
const formatterUrl = `data:text/javascript;base64,${Buffer.from(formatterSource).toString('base64')}`;

test('monthly ACCUMULATOR scan formats qualifier fields for direct reading', async () => {
  const { formatHbaseScanText } = await import(formatterUrl);
  const raw = [
    "scan 'ns_bill_cnos_jf_test:ACCUMULATOR_202609', {LIMIT => 20}",
    'ROW                                      COLUMN+CELL',
    '18|5664236349 column=f:200_24A_1246_202609_807506_7158761731, timestamp=1789034584620,',
    '             value=907003419_7158761731',
    '23|48243980 column=f:100_SHARE_99_202608_700001_600002, timestamp=1789035503625,',
    '             value=other',
    '2 row(s)',
  ].join('\n');
  const result = formatHbaseScanText('/ns_bill_cnos_jf_test:ACCUMULATOR_202609', raw);
  assert.equal(result.structured, true);
  assert.equal(result.parsedCount, 2);
  assert.match(result.text, /ACCUM（结果）：200（初始化）/);
  assert.match(result.text, /OWNER_TYPE（归属）：24A（独享）/);
  assert.match(result.text, /RATABLE_RESOURCE_ID（量本\/资源类型）：1246/);
  assert.match(result.text, /RESOURCE_CYCLE_ID（量本账期）：202609/);
  assert.match(result.text, /PRICING_PLAN_ID（定价计划）：807506/);
  assert.match(result.text, /PREFER_INST_ID（套餐销售品实例）：7158761731/);
  assert.match(result.text, /ACCUM（结果）：100（结转）/);
  assert.match(result.text, /OWNER_TYPE（归属）：SHARE（共享）/);
  assert.match(result.text, /VALUE_RAW（原始值）：907003419_7158761731/);
  assert.match(result.text, /VALUE_RAW（原始值）：other/);
  assert.match(result.text, /TIMESTAMP：1789034584620（2026-09-10 18:03:04\.620 \+08:00）/);
});

test('TRY_ACCUMULATOR monthly tables reuse qualifier formatting and identify trial data', async () => {
  const { formatHbaseScanText, isMonthlyAccumulatorTable } = await import(formatterUrl);
  const raw = 'row-1 column=f:200_24A_1246_202609_807506_7158761731, timestamp=1789034584620, value=sample';
  for (const table of ['TRY_ACCUMULATOR_202609', 'TRY_ACCUMULATOR_202609_plcatest']) {
    const tablePath = `/ns_bill_cnos_jf_test:${table}`;
    const result = formatHbaseScanText(tablePath, raw);
    assert.equal(isMonthlyAccumulatorTable(tablePath), true);
    assert.equal(result.structured, true);
    assert.equal(result.parsedCount, 1);
    assert.match(result.text, /试算量本初始化 \/ 结转结果/);
    assert.match(result.text, /ACCUM（结果）：200（初始化）/);
    assert.match(result.text, /OWNER_TYPE（归属）：24A（独享）/);
    assert.match(result.text, /RATABLE_RESOURCE_ID（量本\/资源类型）：1246/);
    assert.match(result.text, /VALUE_RAW（原始值）：sample/);
    assert.match(result.text, /TIMESTAMP：1789034584620（2026-09-10 18:03:04\.620 \+08:00）/);
  }
});

test('ACCUMULATOR and TRY_ACCUMULATOR retain every raw value in a multi-cell scan', async () => {
  const { formatHbaseScanText } = await import(formatterUrl);
  const values = [
    '907003419_0_0_20260901000000_20261001000000_0$0$0_9223372036854775807_0_20260901000000',
    '907003419_6527510668_907003419_20260901000000_20261001000000_0$0$0_0_0_20260901000000',
  ];
  const raw = [
    "scan 'ns_bill_cnos_jf_test:TRY_ACCUMULATOR_202609'",
    'ROW COLUMN+CELL',
    `031|6527510668 column=f:200_24K_1320_202609_8067454_6527510668, timestamp=1790242766184, value=${values[0]}`,
    `031|6527510668 column=f:200_24K_1321_202609_8067454_6527510668, timestamp=1790242766482, value=${values[0]}`,
    '031|6527510668 column=f:200_24K_2002_202609_8067454_6527510668, timestamp=1790242766571,',
    `             value=${values[0]}`,
    `031|6527510668 column=f:200_24K_3002_202609_8067454_6527510668, timestamp=1790242766603, value=${values[0]}`,
    `032|48243980 column=f:200_24A_1246_202609_8067454_6527510668, timestamp=1790242766407, value=${values[1]}`,
    '2 row(s)',
  ].join('\n');
  for (const table of ['ACCUMULATOR_202609', 'TRY_ACCUMULATOR_202609']) {
    const result = formatHbaseScanText(`/ns_bill_cnos_jf_test:${table}`, raw);
    assert.equal(result.structured, true);
    assert.equal(result.parsedCount, 5);
    assert.equal(result.text.split(`VALUE_RAW（原始值）：${values[0]}`).length - 1, 4);
    assert.equal(result.text.split(`VALUE_RAW（原始值）：${values[1]}`).length - 1, 1);
    assert.match(result.text, /TIMESTAMP：1790242766184（2026-09-24 17:39:26\.184 \+08:00）/);
  }
});

test('other HBase tables keep their original scan display', async () => {
  const { formatHbaseScanText } = await import(formatterUrl);
  const raw = 'row-1 column=f:200_24A_1246_202609_807506_7158761731, timestamp=1';
  const result = formatHbaseScanText('/ns_cnos:TICKET_DATA_597_2606', raw);
  assert.deepEqual(result, { text: raw, structured: false, parsedCount: 0, skippedCount: 0 });
});

test('monthly ACCUMULATOR_DETAIL scan formats MS and SM RowKey fields', async () => {
  const { formatHbaseScanText, parseAccumulatorDetailRowKey } = await import(formatterUrl);
  const raw = [
    "scan 'ns_bill_cnos_jf_test:ACCUMULATOR_DETAIL_202606', {LIMIT => 20}",
    'ROW  COLUMN+CELL',
    '06|MS_6743857310_200_24K_1321_202606_8067454_6743857310_6390648110 column=f:,',
    'timestamp=1788427117379, value=907003419_6743857310_907003419_13932_0',
    '06|MS_6743857310_200_24K_3002_202606_8067454_6743857310_907003419_13932_0 column=f:,',
    'timestamp=1788427121062, value=907003419_6743857310_907003419_13932_0',
    '43|SM_6390648110_200_24K_6743857310_1321_202606_8067454_6743857310 column=f:,',
    'timestamp=1788427124030, value=9070030419_6743857310_907003419_13932',
    '3 row(s)',
  ].join('\n');
  const result = formatHbaseScanText('/ns_bill_cnos_jf_test:ACCUMULATOR_DETAIL_202606', raw);
  assert.equal(result.structured, true);
  assert.equal(result.parsedCount, 3);
  assert.match(result.text, /DETAIL_TYPE（明细类型）：MS/);
  assert.match(result.text, /DETAIL_TYPE（明细类型）：SM/);
  assert.match(result.text, /ACCUM（结果）：200（初始化）/);
  assert.match(result.text, /OWNER_TYPE（归属）：24K（共享）/);
  assert.match(result.text, /RATABLE_RESOURCE_ID（量本\/资源类型）：1321/);
  assert.match(result.text, /RESOURCE_CYCLE_ID（量本账期）：202606/);
  assert.match(result.text, /PRICING_PLAN_ID（定价计划）：8067454/);
  assert.match(result.text, /PREFER_INST_ID（套餐销售品实例）：6743857310/);
  assert.match(result.text, /ROW_KEY 附加段：6743857310 \/ 907003419 \/ 13932 \/ 0/);
  assert.match(result.text, /VALUE：9070030419_6743857310_907003419_13932/);
  assert.match(result.text, /TIMESTAMP：1788427117379（2026-09-03 17:18:37\.379 \+08:00）/);
  assert.deepEqual(parseAccumulatorDetailRowKey('bad-row-key'), null);
});

test('TRY_ACCUMULATOR_DETAIL monthly tables reuse RowKey formatting', async () => {
  const { formatHbaseScanText, isMonthlyAccumulatorDetailTable } = await import(formatterUrl);
  const raw = '06|MS_6743857310_200_24K_1321_202606_8067454_6743857310 column=f:, timestamp=1788427117379, value=sample';
  for (const table of ['TRY_ACCUMULATOR_DETAIL_202606', 'TRY_ACCUMULATOR_DETAIL_202606_plcatest']) {
    const tablePath = `/ns_bill_cnos_jf_test:${table}`;
    const result = formatHbaseScanText(tablePath, raw);
    assert.equal(isMonthlyAccumulatorDetailTable(tablePath), true);
    assert.equal(result.structured, true);
    assert.equal(result.parsedCount, 1);
    assert.match(result.text, /试算量本明细/);
    assert.match(result.text, /DETAIL_TYPE（明细类型）：MS/);
    assert.match(result.text, /ACCUM（结果）：200（初始化）/);
    assert.match(result.text, /VALUE：sample/);
    assert.match(result.text, /TIMESTAMP：1788427117379（2026-09-03 17:18:37\.379 \+08:00）/);
  }
});

test('TICKET dispatch tables format seven-part RowKeys and lifecycle state', async () => {
  const { formatHbaseScanText, parseTicketDispatchRowKey } = await import(formatterUrl);
  const raw = [
    "scan 'ns_bill_cnos_jf_test:TICKET_DISPATCHED_FILE', {LIMIT => 20}",
    'ROW  COLUMN+CELL',
    '01|/apps/bill_cnos_jf_test/cal/normal/chargeOutput/202609/04/0/1/1000000017_0_590.normal|20260904143701245|MERGE|CAL_NOR|590|6 column=f:, timestamp=1788503823660, value=0|-1',
    '01|/apps/bill_cnos_jf_test/cal/normal/chargeOutput/202609/04/0/1/1000000017_0_590.normal|20260904143701245|STRA|CAL_NOR|590|6 column=f:, timestamp=1788503823747, value=0|-1',
    '2 row(s)',
  ].join('\n');
  const done = formatHbaseScanText('/ns_bill_cnos_jf_test:TICKET_DISPATCHED_FILE', raw);
  assert.equal(done.structured, true);
  assert.equal(done.parsedCount, 2);
  assert.match(done.text, /话单分发记录（已处理，已解析 2 条）/);
  assert.match(done.text, /SOURCE_PATH（来源文件）：\/apps\/bill_cnos_jf_test\/cal\/normal\/chargeOutput/);
  assert.match(done.text, /DISPATCH_TIME_KEY（分发时间键）：20260904143701245/);
  assert.match(done.text, /DISPATCH_TYPE（分发类型）：MERGE（合账）/);
  assert.match(done.text, /DISPATCH_TYPE（分发类型）：STRA（策略中心）/);
  assert.match(done.text, /PROCESS_SCENE（处理场景）：CAL_NOR/);
  assert.match(done.text, /CODE_6（第 6 段）：590/);
  assert.match(done.text, /SEGMENT_7（第 7 段）：6/);
  assert.match(done.text, /VALUE_RAW（原始值）：0\|-1/);
  assert.match(done.text, /TIMESTAMP：1788503823660（2026-09-04 14:37:03\.660 \+08:00）/);

  const pendingRaw = [
    "scan 'ns_bill_cnos_jf_test:TICKET_DISPATCH_FILE', {LIMIT => 20}",
    'ROW  COLUMN+CELL',
    '02|IBS|CAL_NOR|590|20260902111938756|6|/apps/bill_cnos_jf_test/cal/normal/chargeOutput/202609/02/0/1/1000000008_0_590.normal column=f:, timestamp=1788319190628, value=CREATE|0|-1',
    '1 row(s)',
  ].join('\n');
  const pending = formatHbaseScanText('/ns_bill_cnos_jf_test:TICKET_DISPATCH_FILE', pendingRaw);
  assert.match(pending.text, /话单分发记录（未处理，已解析 1 条）/);
  assert.match(pending.text, /SOURCE_STAGE（来源标识）：IBS/);
  assert.match(pending.text, /PROCESS_SCENE（处理场景）：CAL_NOR/);
  assert.match(pending.text, /CODE_4（第 4 段）：590/);
  assert.match(pending.text, /DISPATCH_TIME_KEY（分发时间键）：20260902111938756/);
  assert.match(pending.text, /SEGMENT_6（第 6 段）：6/);
  assert.match(pending.text, /SOURCE_PATH（来源文件）：\/apps\/bill_cnos_jf_test\/cal\/normal\/chargeOutput/);
  assert.match(pending.text, /VALUE_RAW（原始值）：CREATE\|0\|-1/);
  assert.deepEqual(parseTicketDispatchRowKey('too|short'), null);
});

test('batch major tables group batch_info qualifiers by batch id', async () => {
  const { formatHbaseScanText, isBatchInfoTable } = await import(formatterUrl);
  const raw = [
    "scan 'ns_bill_cnos_jf_test:rating_batch_major_info', {LIMIT => 2}",
    'ROW  COLUMN+CELL',
    '1000000008 column=batch_info:batch_type, timestamp=1788319190731, value=102',
    '1000000008 column=batch_info:create_time, timestamp=1788319190731, value=20260902111938756',
    '1000000008 column=batch_info:out_normal_count, timestamp=1788319190731, value=1',
    '1000000008 column=batch_info:pre_status, timestamp=1788319190731, value=110',
    '1000000008 column=batch_info:status, timestamp=1788319190731, value=105',
    '1 row(s)',
  ].join('\n');
  const result = formatHbaseScanText('/ns_bill_cnos_jf_test:rating_batch_major_info', raw);
  assert.equal(isBatchInfoTable('/ns_bill_cnos_jf_test:rating_batch_major_info'), true);
  assert.equal(result.structured, true);
  assert.equal(result.parsedCount, 1);
  assert.match(result.text, /批价批次主表（已完成，已解析 1 个批次）/);
  assert.match(result.text, /BATCH_ID（批次 ID）：1000000008/);
  assert.match(result.text, /BATCH_TYPE（批次类型）：102/);
  assert.match(result.text, /STATUS（当前状态）：105（成功）/);
  assert.match(result.text, /PRE_STATUS（前序状态）：110（格式异常）/);
  assert.match(result.text, /CREATE_TIME（创建时间）：2026-09-02 11:19:38\.756（原始：20260902111938756）/);
  assert.match(result.text, /OUT_NORMAL_COUNT（正常输出数）：1/);
  assert.match(result.text, /TIMESTAMP：1788319190731（2026-09-02 11:19:50\.731 \+08:00）/);

  const empty = formatHbaseScanText('/ns_bill_cnos_jf_test:pro_rating_batch_major_info', "scan 'ns_bill_cnos_jf_test:pro_rating_batch_major_info', {LIMIT => 20}\nROW  COLUMN+CELL\n0 row(s)");
  assert.equal(empty.structured, true);
  assert.match(empty.text, /批价批次主表（在途）/);
  assert.match(empty.text, /当前样本暂无记录/);
});

test('batch minor tables split direction, file paths and result segments', async () => {
  const { formatHbaseScanText } = await import(formatterUrl);
  const raw = [
    "scan 'ns_bill_cnos_jf_test:preproc_batch_minor_info', {LIMIT => 2}",
    'ROW  COLUMN+CELL',
    '1000000001_in column=batch_info:/apps/prep/input/a.json|/apps/prep/working/a.normal, timestamp=1788163400298, value=0|1|/apps/prep/errstyle/a.err',
    '1000000001_out column=batch_info:/apps/prep/upload/a.normal|/apps/prep/output/a.normal, timestamp=1788163400399, value=1|0',
    '2 row(s)',
  ].join('\n');
  const result = formatHbaseScanText('/ns_bill_cnos_jf_test:preproc_batch_minor_info', raw);
  assert.equal(result.structured, true);
  assert.equal(result.parsedCount, 2);
  assert.match(result.text, /采预批次子表（已完成，已解析 2 条文件记录）/);
  assert.match(result.text, /BATCH_ID（批次 ID）：1000000001/);
  assert.match(result.text, /DIRECTION（方向）：in（输入）/);
  assert.match(result.text, /INPUT_SOURCE_PATH（输入源文件）：\/apps\/prep\/input\/a\.json/);
  assert.match(result.text, /WORKING_PATH（处理文件）：\/apps\/prep\/working\/a\.normal/);
  assert.match(result.text, /RESULT_SEGMENT_1（结果段 1）：0/);
  assert.match(result.text, /RESULT_PATH（结果文件）：\/apps\/prep\/errstyle\/a\.err/);
  assert.match(result.text, /DIRECTION（方向）：out（输出）/);
  assert.match(result.text, /OUTPUT_TARGET_PATH（输出目标文件）：\/apps\/prep\/output\/a\.normal/);
  assert.match(result.text, /TIMESTAMP：1788163400298（2026-08-31 16:03:20\.298 \+08:00）/);
});

test('HBase cell timestamps retain raw values when conversion is invalid or imprecise', async () => {
  const { formatHbaseTimestamp } = await import(formatterUrl);
  assert.equal(formatHbaseTimestamp(1790236653475), '1790236653475（2026-09-24 15:57:33.475 +08:00）');
  assert.equal(formatHbaseTimestamp('0'), '0（1970-01-01 08:00:00.000 +08:00）');
  assert.equal(formatHbaseTimestamp('-1'), '-1（1970-01-01 07:59:59.999 +08:00）');
  assert.equal(formatHbaseTimestamp('18446744073709551615'), '18446744073709551615');
  assert.equal(formatHbaseTimestamp('not-a-timestamp'), 'not-a-timestamp');
  assert.equal(formatHbaseTimestamp('8640000000000000'), '8640000000000000');
});

test('malformed ACCUMULATOR qualifier falls back to original output', async () => {
  const { formatHbaseScanText } = await import(formatterUrl);
  const raw = 'row-1 column=f:200_24A_too_short, timestamp=1';
  const result = formatHbaseScanText('/ns_cnos:ACCUMULATOR_202609', raw);
  assert.equal(result.structured, false);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.text, raw);
});

test('malformed TRY_ACCUMULATOR records retain raw output', async () => {
  const { formatHbaseScanText } = await import(formatterUrl);
  const qualifierRaw = 'row-1 column=f:200_24A_too_short, timestamp=1';
  const qualifierResult = formatHbaseScanText('/ns_cnos:TRY_ACCUMULATOR_202609', qualifierRaw);
  assert.deepEqual(qualifierResult, { text: qualifierRaw, structured: false, parsedCount: 0, skippedCount: 1 });

  const detailRaw = 'bad-row-key column=f:, timestamp=1, value=sample';
  const detailResult = formatHbaseScanText('/ns_cnos:TRY_ACCUMULATOR_DETAIL_202609', detailRaw);
  assert.deepEqual(detailResult, { text: detailRaw, structured: false, parsedCount: 0, skippedCount: 1 });
});
