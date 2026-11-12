const ACCUMULATOR_TABLE_RE = /^(?:TRY_)?ACCUMULATOR_\d{6}(?:_plcatest)?$/i;
const ACCUMULATOR_DETAIL_TABLE_RE = /^(?:TRY_)?ACCUMULATOR_DETAIL_\d{6}(?:_plcatest)?$/i;
const DISPATCH_TABLE_RE = /^TICKET_(DISPATCH|DISPATCHED)_FILE$/i;
const BATCH_INFO_TABLE_RE = /^(pro_)?(preproc|rating)_batch_(major|minor)_info$/i;

function tableNameFromPath(tablePath) {
  return String(tablePath || '').replace(/^\/+/, '').split(':').pop() || '';
}

export function isMonthlyAccumulatorTable(tablePath) {
  return ACCUMULATOR_TABLE_RE.test(tableNameFromPath(tablePath));
}

export function isMonthlyAccumulatorDetailTable(tablePath) {
  return ACCUMULATOR_DETAIL_TABLE_RE.test(tableNameFromPath(tablePath));
}

export function isTicketDispatchTable(tablePath) {
  return DISPATCH_TABLE_RE.test(tableNameFromPath(tablePath));
}

export function isTicketNormalTable(tablePath) {
  return /^TICKET_NORMAL(?:_\d{6})?$/i.test(tableNameFromPath(tablePath));
}

export function isBatchInfoTable(tablePath) {
  return BATCH_INFO_TABLE_RE.test(tableNameFromPath(tablePath));
}

export function parseAccumulatorQualifier(qualifier) {
  const parts = String(qualifier || '').split('_');
  if (parts.length !== 6 || parts.some((part) => !part)) return null;
  const [accum, ownerType, ratableResourceId, resourceCycleId, pricingPlanId, preferInstId] = parts;
  return { accum, ownerType, ratableResourceId, resourceCycleId, pricingPlanId, preferInstId };
}

function accumMeaning(value) {
  if (value === '100') return '结转';
  if (value === '200') return '初始化';
  return '其他编码';
}

function ownerMeaning(value) {
  return value === '24A' ? '独享' : '共享';
}

function resultTable(records) {
  const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
  return { columns, rows: records.map((record) => columns.map((column) => String(record[column] ?? '—'))) };
}

function accumulatorBusinessTime(raw) {
  const match = String(raw).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})?$/);
  if (!match) return raw;
  const [, y, m, d, h, min, sec, ms] = match;
  return `${raw}（${y}-${m}-${d} ${h}:${min}:${sec}${ms ? `.${ms}` : ''}）`;
}

// Monthly master Value contract: AccumulatorUtil.getMaterValue / parseMasterValue.
// Detail tables use a different contract and deliberately do not enter this parser.
export function parseAccumulatorMasterValue(raw, resourceCycleId) {
  const parts = String(raw).split('_');
  const permanent = resourceCycleId === '0';
  if (parts.length !== (permanent ? 12 : 9) || parts.some((part) => !part)) {
    return { 'VALUE解析状态': '格式未匹配，保留原始值' };
  }
  const offset = permanent ? 1 : 0;
  const resource = parts[5 + offset].split('$');
  const values = {
    '销售品规格': parts[0], 'T01销售品实例': parts[1], 'T01销售品规格': parts[2],
    '生效时间': accumulatorBusinessTime(parts[3]), '失效时间': accumulatorBusinessTime(parts[4]),
    ...(permanent ? { '当前周期（currentCycleId）': parts[5], '上期使用量（lastValue）': parts[7], '上上期使用量（lastLastValue）': parts[8] } : {}),
    '赠送量（limitValue）': parts[permanent ? 9 : 6],
    '永久周期标识（permanenceCycleId）': parts[permanent ? 10 : 7],
    '审计时间（tAuditTime）': accumulatorBusinessTime(parts[permanent ? 11 : 8]),
    '使用量原始段（resourceValue）': parts[5 + offset],
    'VALUE解析状态': [1, 3, 4, 6].includes(resource.length) ? '已解析' : '使用量子段格式未匹配，保留原始段',
  };
  if (![1, 3, 4, 6].includes(resource.length)) return values;
  values['使用量'] = resource[0];
  if (resource.length === 3 || resource.length === 6) {
    values['阶梯档次（ladderClass）'] = resource[1];
    values['实际费用（totalRealCharge）'] = resource[2];
  }
  if (resource.length === 4 || resource.length === 6) {
    const start = resource.length === 4 ? 1 : 3;
    values['流量子值（flowValue）'] = resource[start];
    values['时长子值（durationValue）'] = resource[start + 1];
    values['短信子值（msgValue）'] = resource[start + 2];
  }
  return values;
}

function accumulatorTableRecord({ cell, fields }, detail = false) {
  if (!detail) {
    const value = parseAccumulatorMasterValue(cell.value, fields.resourceCycleId);
    return {
      '费用类型（ACCUM）': `${fields.accum}（${fields.accum === '100' ? '转赠积量' : fields.accum === '200' ? '普通积量' : '未映射编码'}）`,
      '属主标识': cell.rowKey.includes('|') ? cell.rowKey.split('|').slice(1).join('|') : cell.rowKey,
      '属主类型（OWNER_TYPE）': fields.ownerType === '24A' ? '24A（原子产品实例）' : fields.ownerType,
      '账期周期（表名）': cell.tableCycle || '—',
      '积量周期（RESOURCE_CYCLE_ID）': fields.resourceCycleId,
      '销售品实例（PREFER_INST_ID）': fields.preferInstId,
      '定价计划（PRICING_PLAN_ID）': fields.pricingPlanId,
      '积量类型（RATABLE_RESOURCE_ID）': fields.ratableResourceId,
      '使用量': value['使用量'] ?? '—', '赠送量（limitValue）': value['赠送量（limitValue）'] ?? '—',
      ...value,
      'ACCUM原解析说明': accumMeaning(fields.accum),
      ROW_KEY: cell.rowKey, 'VALUE_RAW（原始值）': cell.value,
      TIMESTAMP: formatHbaseTimestamp(cell.timestamp), QUALIFIER: `${cell.family}:${cell.qualifier}`,
    };
  }
  return {
    ROW_KEY: cell.rowKey,
    ...(detail ? { 'ROW_PREFIX（前缀）': fields.prefix, 'DETAIL_TYPE（明细类型）': fields.detailType } : {}),
    'ACCUM（结果）': `${fields.accum}（${accumMeaning(fields.accum)}）`,
    'OWNER_TYPE（归属）': `${fields.ownerType}（${ownerMeaning(fields.ownerType)}）`,
    'RATABLE_RESOURCE_ID（量本/资源类型）': fields.ratableResourceId,
    'RESOURCE_CYCLE_ID（量本账期）': fields.resourceCycleId,
    'PRICING_PLAN_ID（定价计划）': fields.pricingPlanId,
    'PREFER_INST_ID（套餐销售品实例）': fields.preferInstId,
    ...(detail ? { 'ROW_KEY 附加段': fields.extraSegments.join(' / ') } : {}),
    'VALUE_RAW（原始值）': cell.value,
    TIMESTAMP: formatHbaseTimestamp(cell.timestamp),
    QUALIFIER: `${cell.family}:${cell.qualifier}`,
  };
}

export function formatHbaseTimestamp(value) {
  const raw = String(value ?? '—');
  if (!/^-?\d+$/.test(raw)) return raw;
  const milliseconds = Number(raw);
  if (!Number.isSafeInteger(milliseconds)) return raw;
  const date = new Date(milliseconds + 8 * 60 * 60 * 1000);
  if (Number.isNaN(date.getTime())) return raw;
  return `${raw}（${date.toISOString().replace('T', ' ').replace('Z', ' +08:00')}）`;
}

function parseHbaseCells(raw, inheritRowKey = false) {
  const lines = String(raw || '').split(/\r?\n/);
  const cells = [];
  let previousRowKey = '';
  for (let index = 0; index < lines.length; index += 1) {
    const marker = lines[index].indexOf(' column=');
    if (marker < 0) continue;
    const explicitRowKey = lines[index].slice(0, marker).trim();
    if (explicitRowKey) previousRowKey = explicitRowKey;
    const rowKey = explicitRowKey || (inheritRowKey ? previousRowKey : '');
    let metadata = lines[index].slice(marker + 1).trim();
    for (let next = index + 1; next < lines.length; next += 1) {
      if (lines[next].includes(' column=') || /^\s*\d+ row\(s\)/.test(lines[next]) || /^\s*Took /.test(lines[next])) break;
      metadata += ` ${lines[next].trim()}`;
    }
    const column = metadata.match(/^column=([^:,\s]+):([^,\s]*),/);
    const family = column?.[1];
    const qualifier = column?.[2];
    const timestamp = metadata.match(/timestamp=([^,\s]+)/)?.[1] || '—';
    const value = metadata.match(/value=(.*)$/)?.[1]?.trim() || '—';
    if (qualifier !== undefined) cells.push({ rowKey, family, qualifier, timestamp, value });
  }
  return cells;
}

// doEventTypeField(203020000): labels only, never positional or type conversions.
const TICKET_NORMAL_FIELD_LABELS = {
  EVENT_TYPE_ID: '计费事件类型标识',
  TICKET_ID: '计费话单标识',
  ERROR_TYPE: '异常类型',
  COLLECT_CDR_ID: '采集话单序列号',
  ORG_CDR_ID: '原始话单文件号',
  DEAL_CYCLE_ID: '处理周期标识',
  DEAL_TIME: '处理时间',
  PROCESS_STAMP: '过程戳',
  REDO_FLAG: '重做标志',
  SWITCH_ID: '交换局标识（采集点标识）',
  THIRD_PARTY_ORG_NBR: '第三方原始号码',
  LATN_ID: '计费号码所属本地网',
  SERV_ID: '计费号码产品标识',
  BUREAU_ID: '分局标识',
  ACCESS_CODE_BILLING: '计费接入码',
  START_TIME: '通话开始时间',
  CALL_AMOUNT: '使用量',
  BILLING_AMOUNT: '计费量',
  ACCT_ITEM_TYPE_ID: '帐目类型标识',
  CHARGE: '标准费用',
  RECORD_TYPE: '记录类型',
  PARTNER_ID: '对方运营商标识',
  PAGES: '张数',
  ORG_BILLING_AMOUNT: '原始计费量',
  PAY_TYPE: '付费方式',
  ORG_ACCT_ITEM_TYPE_ID: '原始帐目类型标识',
  EXT_SERVICE_TYPE: '外来帐单服务类型',
  LATN_ORG_ID: '来源地区标识',
  INDB_TIME: '入库时间',
  CDR_BATCH_ID: '汇集点序列号',
  DISTRIBUTOR_ID: '转售商标识',
  COLLECT_BSN_ID: 'dcs采集话单序列号',
  ORG_FILE_ID: 'dcs原始文件ID号',
  MERGE_ACCT_ITEM: '账目项',
  ORG_FILE_NAME: '源文件名',
  DCS_CHARGE_START_TIME: 'DCS批价时间',
  ORI_ERROR_TYPE: '排重后异常类型',
  SOURCE_TYPE_ID: '源业务类型标识',
  COLLECT_FILE_NAME: '采集上传文件名',
  BLACK_TYPE: '黑户类型',
  DCS_PREP_START_TIME: '采预接收时间',
  DCS_CHARGE_END_TIME: '批价完成时间',
  DCS_PREP_END_TIME: '采预结束时间',
  CJ_START_TIME: '采集开始时间',
  CJ_END_TIME: '采集结束时间',
  DUP_START_TIME: '排重接收时间',
  DUP_END_TIME: '排重结束时间',
};

// Source-event names from the supplied dictionary; do not infer names by ID prefix.
const TICKET_EVENT_TYPE_NAMES = new Map([
  ['201010000', '长市话详单（源事件）'],
  ['202010000', '互联网拨号'],
  ['203010000', '一机多号从号清单'],
  ['203020000', '外来帐目'],
  ['203030000', '信息台清单'],
  ['204030000', '160'],
  ['204060000', '168'],
  ['204210000', '协同通信/统一通信语音'],
  ['204220000', '协同通信_短信'],
  ['204310000', '视讯通信业务'],
  ['204330000', '结算_短信(源事件)'],
  ['204340000', '声讯话单'],
  ['204350000', '彩铃话单(结算四期)'],
  ['204360000', '彩话话单'],
  ['204370000', '互联星空(源事件)'],
  ['204380000', '号码百事通'],
  ['204390000', '虚拟传真'],
  ['204400000', '新视通'],
  ['204410000', '商务领航（源事件）'],
  ['204460000', 'VT可视电话(源事件)'],
  ['204470000', '全国商务领航（源事件）'],
  ['204490000', '云主机管理平台话单'],
  ['204510000', '集团下发Itv增值业务话单'],
  ['205060000', '智能网(源事件)'],
  ['206070000', 'C网语音(源事件)'],
  ['206080000', 'CDMA分组域(源事件)'],
  ['206110000', '点对点短信业务(源事件)'],
  ['206120000', 'CDMA业务域(源事件)'],
  ['206190000', '综合VPN业务(源事件)'],
  ['208520000', '语音国际漫游(源事件)'],
  ['208530000', '分组域国际漫游(源事件)'],
  ['208540000', '短信国际漫游(源事件)'],
  ['208550000', '国际漫游套餐费(源事件)'],
]);

function parseTicketNormalValue(cell) {
  if (cell.family !== 'd' || cell.qualifier !== '' || (cell.encoding && cell.encoding !== 'utf8')) return null;
  try {
    // Match quoted strings first so numeric JSON tokens can be kept as text without rounding.
    const value = JSON.parse(cell.value.replace(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      (token) => token.startsWith('"') ? token : JSON.stringify(token)));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_) { return null; }
}

function formatTicketNormalScan(raw, rows) {
  const cells = Array.isArray(rows)
    ? rows.flatMap((row) => (row.cells || []).map((cell) => ({ ...cell, rowKey: row.rowKey })))
    : parseHbaseCells(raw, true).filter((cell) => cell.rowKey);
  const skippedCount = Array.isArray(rows) ? 0 : Math.max(0, raw.split(/\r?\n/).filter((line) => line.includes(' column=')).length - cells.length);
  if (!cells.length) return { text: raw, structured: false, parsedCount: 0, skippedCount };
  const payloads = cells.map(parseTicketNormalValue);
  const fields = Object.entries(TICKET_NORMAL_FIELD_LABELS).filter(([key]) => payloads.some((payload) => payload && Object.hasOwn(payload, key)));
  return {
    text: raw, structured: true, parsedCount: cells.length, skippedCount,
    table: resultTable(cells.map((cell, index) => ({
      ...Object.fromEntries(fields.map(([key, label]) => {
        const value = payloads[index]?.[key];
        const eventName = key === 'EVENT_TYPE_ID' ? TICKET_EVENT_TYPE_NAMES.get(value) : undefined;
        if (eventName) return [key + '（' + label + '）', `${value}（${eventName}）`];
        return [key + '（' + label + '）', value === null ? 'null' : typeof value === 'object' ? '见原始值' : value];
      })),
      ROW_KEY: cell.rowKey,
      'FAMILY（列族）': cell.family,
      QUALIFIER: cell.qualifier,
      TIMESTAMP: formatHbaseTimestamp(cell.timestamp),
      'VALUE_RAW（原始值）': cell.value,
    }))),
  };
}

export function parseAccumulatorDetailRowKey(rowKey) {
  const [prefix, payload, ...unexpected] = String(rowKey || '').split('|');
  if (!prefix || !payload || unexpected.length) return null;
  const [detailType, ...parts] = payload.split('_');
  if (detailType === 'MS' && parts.length >= 7) {
    const [keyId, accum, ownerType, ratableResourceId, resourceCycleId, pricingPlanId, preferInstId, ...tail] = parts;
    if ([keyId, accum, ownerType, ratableResourceId, resourceCycleId, pricingPlanId, preferInstId].some((part) => !part)) return null;
    return { prefix, detailType, accum, ownerType, ratableResourceId, resourceCycleId, pricingPlanId, preferInstId, extraSegments: [keyId, ...tail] };
  }
  if (detailType === 'SM' && parts.length >= 8) {
    const [keyId, accum, ownerType, relatedId, ratableResourceId, resourceCycleId, pricingPlanId, preferInstId, ...tail] = parts;
    if ([keyId, accum, ownerType, relatedId, ratableResourceId, resourceCycleId, pricingPlanId, preferInstId].some((part) => !part)) return null;
    return { prefix, detailType, accum, ownerType, ratableResourceId, resourceCycleId, pricingPlanId, preferInstId, extraSegments: [keyId, relatedId, ...tail] };
  }
  return null;
}

function formatAccumulatorDetailScan(raw, isTrial = false) {
  const cells = parseHbaseCells(raw);
  const records = cells.map((cell) => ({ cell, fields: parseAccumulatorDetailRowKey(cell.rowKey) })).filter((record) => record.fields);
  if (!records.length) return { text: raw, structured: false, parsedCount: 0, skippedCount: cells.length };

  const lines = [
    `${isTrial ? '试算' : ''}量本明细（已解析 ${records.length} 条）`,
    '字段来源：RowKey；Qualifier 为空。复制按钮仍复制原始 scan 输出。',
    '',
  ];
  records.forEach(({ cell, fields }, index) => {
    lines.push(
      `[${index + 1}] ROW_KEY：${cell.rowKey}`,
      `    ROW_PREFIX（前缀）：${fields.prefix}    DETAIL_TYPE（明细类型）：${fields.detailType}`,
      `    ACCUM（结果）：${fields.accum}（${accumMeaning(fields.accum)}）    OWNER_TYPE（归属）：${fields.ownerType}（${ownerMeaning(fields.ownerType)}）`,
      `    RATABLE_RESOURCE_ID（量本/资源类型）：${fields.ratableResourceId}    RESOURCE_CYCLE_ID（量本账期）：${fields.resourceCycleId}`,
      `    PRICING_PLAN_ID（定价计划）：${fields.pricingPlanId}    PREFER_INST_ID（套餐销售品实例）：${fields.preferInstId}`,
      `    ROW_KEY 附加段：${fields.extraSegments.join(' / ') || '—'}`,
      `    VALUE：${cell.value}    TIMESTAMP：${formatHbaseTimestamp(cell.timestamp)}`,
      '',
    );
  });
  const skippedCount = Math.max(0, cells.length - records.length);
  if (skippedCount) lines.push(`另有 ${skippedCount} 条记录未按 MS/SM RowKey 格式解析，请复制原始结果核对。`);
  return { text: lines.join('\n').trimEnd(), structured: true, parsedCount: records.length, skippedCount, table: resultTable(records.map((record) => accumulatorTableRecord(record, true))) };
}

export function parseTicketDispatchRowKey(rowKey, tablePath = '') {
  const parts = String(rowKey || '').split('|');
  if (parts.length !== 7 || parts.some((part) => !part)) return null;
  const tableName = tableNameFromPath(tablePath).toUpperCase();
  const pendingLayout = tableName === 'TICKET_DISPATCH_FILE' || (!tableName && !parts[1].startsWith('/') && parts[6].startsWith('/'));
  if (pendingLayout) {
    const [rowPrefix, sourceStage, processScene, code4, dispatchTimeKey, segment6, sourcePath] = parts;
    return { layout: 'pending', rowPrefix, sourceStage, processScene, code4, dispatchTimeKey, segment6, sourcePath };
  }
  const [rowPrefix, sourcePath, dispatchTimeKey, dispatchType, processScene, code6, segment7] = parts;
  return { layout: 'dispatched', rowPrefix, sourcePath, dispatchTimeKey, dispatchType, processScene, code6, segment7 };
}

function dispatchTypeMeaning(value) {
  if (value === 'STRA') return '策略中心';
  if (value === 'MR') return '话单入库';
  if (value === 'MERGE') return '合账';
  return '其他类型';
}

function formatTicketDispatchScan(tablePath, raw) {
  const cells = parseHbaseCells(raw);
  const records = cells.map((cell) => ({ cell, fields: parseTicketDispatchRowKey(cell.rowKey, tablePath) })).filter((record) => record.fields);
  if (!records.length) return { text: raw, structured: false, parsedCount: 0, skippedCount: cells.length };

  const tableName = tableNameFromPath(tablePath).toUpperCase();
  const tableState = tableName === 'TICKET_DISPATCHED_FILE' ? '已处理' : '未处理';
  const table = resultTable(records.map(({ cell, fields }) => ({
    'TABLE_STATE（表状态）': tableState,
    'ROW_PREFIX（来源/分区编码）': fields.rowPrefix,
    ...(fields.layout === 'pending' ? {
      'SOURCE_STAGE（来源标识）': fields.sourceStage, 'CODE_4（第 4 段）': fields.code4, 'SEGMENT_6（第 6 段）': fields.segment6,
    } : {
      'DISPATCH_TYPE（分发类型）': `${fields.dispatchType}（${dispatchTypeMeaning(fields.dispatchType)}）`,
      'CODE_6（第 6 段）': fields.code6, 'SEGMENT_7（第 7 段）': fields.segment7,
    }),
    'PROCESS_SCENE（处理场景）': fields.processScene,
    'DISPATCH_TIME_KEY（分发时间键）': fields.dispatchTimeKey,
    'SOURCE_PATH（来源文件）': fields.sourcePath,
    'VALUE_RAW（原始值）': cell.value, TIMESTAMP: formatHbaseTimestamp(cell.timestamp), ROW_KEY: cell.rowKey,
  })));
  const lines = [
    `话单分发记录（${tableState}，已解析 ${records.length} 条）`,
    '字段来源：RowKey；Qualifier 为空。复制按钮仍复制原始 scan 输出。',
    '',
  ];
  records.forEach(({ cell, fields }, index) => {
    lines.push(`[${index + 1}] TABLE_STATE（表状态）：${tableState}    ROW_PREFIX（来源/分区编码）：${fields.rowPrefix}`);
    if (fields.layout === 'pending') {
      lines.push(
        `    SOURCE_STAGE（来源标识）：${fields.sourceStage}    PROCESS_SCENE（处理场景）：${fields.processScene}`,
        `    CODE_4（第 4 段）：${fields.code4}    DISPATCH_TIME_KEY（分发时间键）：${fields.dispatchTimeKey}`,
        `    SEGMENT_6（第 6 段）：${fields.segment6}`,
        `    SOURCE_PATH（来源文件）：${fields.sourcePath}`,
      );
    } else {
      lines.push(
        `    SOURCE_PATH（来源文件）：${fields.sourcePath}`,
        `    DISPATCH_TIME_KEY（分发时间键）：${fields.dispatchTimeKey}`,
        `    DISPATCH_TYPE（分发类型）：${fields.dispatchType}（${dispatchTypeMeaning(fields.dispatchType)}）    PROCESS_SCENE（处理场景）：${fields.processScene}`,
        `    CODE_6（第 6 段）：${fields.code6}    SEGMENT_7（第 7 段）：${fields.segment7}`,
      );
    }
    lines.push(
      `    VALUE_RAW（原始值）：${cell.value}    TIMESTAMP：${formatHbaseTimestamp(cell.timestamp)}`,
      `    ROW_KEY：${cell.rowKey}`,
      '',
    );
  });
  const skippedCount = Math.max(0, cells.length - records.length);
  if (skippedCount) lines.push(`另有 ${skippedCount} 条记录未按 7 段 RowKey 格式解析，请复制原始结果核对。`);
  return { text: lines.join('\n').trimEnd(), structured: true, parsedCount: records.length, skippedCount, table };
}

const BATCH_MAJOR_FIELDS = [
  ['batch_type', 'BATCH_TYPE（批次类型）'],
  ['status', 'STATUS（当前状态）'],
  ['pre_status', 'PRE_STATUS（前序状态）'],
  ['create_time', 'CREATE_TIME（创建时间）'],
  ['status_time', 'STATUS_TIME（状态时间）'],
  ['node_id', 'NODE_ID（节点）'],
  ['partition_id', 'PARTITION_ID（分区）'],
  ['create_pid', 'CREATE_PID（创建进程）'],
  ['pid', 'PID（处理进程）'],
  ['path_date', 'PATH_DATE（路径时间）'],
  ['rcv_files', 'RCV_FILES（接收文件数）'],
  ['rcv_tickets', 'RCV_TICKETS（接收话单数）'],
  ['output_files', 'OUTPUT_FILES（输出文件数）'],
  ['output_tickets', 'OUTPUT_TICKETS（输出话单数）'],
  ['input_start_date', 'INPUT_START_DATE（输入开始时间）'],
  ['input_end_date', 'INPUT_END_DATE（输入结束时间）'],
  ['output_start_date', 'OUTPUT_START_DATE（输出开始时间）'],
  ['output_end_date', 'OUTPUT_END_DATE（输出结束时间）'],
  ['deal_time_interval', 'DEAL_TIME_INTERVAL（处理耗时）'],
  ['process_tps', 'PROCESS_TPS（处理 TPS）'],
  ['out_normal_count', 'OUT_NORMAL_COUNT（正常输出数）'],
  ['out_abnormal_count', 'OUT_ABNORMAL_COUNT（异常输出数）'],
  ['out_black_count', 'OUT_BLACK_COUNT（黑名单输出数）'],
  ['out_free_count', 'OUT_FREE_COUNT（免费输出数）'],
  ['out_noroute_count', 'OUT_NOROUTE_COUNT（无路由输出数）'],
  ['out_refuse_count', 'OUT_REFUSE_COUNT（拒绝输出数）'],
];

function batchStateMeaning(value) {
  return ({
    100: '初始化',
    101: '新建',
    102: '处理中',
    103: '上传中',
    104: '发布中',
    105: '成功',
    106: '回滚中',
    107: '回滚成功',
    108: '失败',
    109: '恢复成功',
    110: '格式异常',
    111: '文件回滚中',
  })[value] || '未知状态';
}

function formatCompactTimestamp(value) {
  const raw = String(value || '');
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})$/);
  if (!match) return raw;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  return `${year}-${month}-${day} ${hour}:${minute}:${second}.${millisecond}（原始：${raw}）`;
}

function formatBatchMajorValue(name, value) {
  if (name === 'status' || name === 'pre_status') return `${value}（${batchStateMeaning(value)}）`;
  if (['create_time', 'status_time', 'path_date', 'input_start_date', 'input_end_date', 'output_start_date', 'output_end_date'].includes(name)) return formatCompactTimestamp(value);
  return value;
}

function batchTableInfo(tablePath) {
  const match = tableNameFromPath(tablePath).match(BATCH_INFO_TABLE_RE);
  if (!match) return null;
  return {
    state: match[1] ? '在途' : '已完成',
    stage: match[2].toLowerCase() === 'preproc' ? '采预' : '批价',
    level: match[3].toLowerCase(),
  };
}

function formatBatchMajorScan(info, cells, raw) {
  const rows = new Map();
  cells.filter((cell) => cell.family === 'batch_info').forEach((cell) => {
    if (!rows.has(cell.rowKey)) rows.set(cell.rowKey, []);
    rows.get(cell.rowKey).push(cell);
  });
  if (!rows.size) {
    if (/\b0 row\(s\)/.test(raw)) return { text: `${info.stage}批次主表（${info.state}）\n当前样本暂无记录。`, structured: true, parsedCount: 0, skippedCount: 0 };
    return { text: raw, structured: false, parsedCount: 0, skippedCount: cells.length };
  }

  const lines = [`${info.stage}批次主表（${info.state}，已解析 ${rows.size} 个批次）`, '字段来源：RowKey 为批次 ID；列族 batch_info 的 Qualifier 为字段名。复制按钮仍复制原始 scan 输出。', ''];
  const tableRecords = [];
  [...rows.entries()].forEach(([rowKey, rowCells], index) => {
    const values = new Map(rowCells.map((cell) => [cell.qualifier, cell.value]));
    const known = new Set(BATCH_MAJOR_FIELDS.map(([name]) => name));
    tableRecords.push({
      'BATCH_ID（批次 ID）': rowKey,
      ...Object.fromEntries(BATCH_MAJOR_FIELDS.filter(([name]) => values.has(name)).map(([name, label]) => [label, formatBatchMajorValue(name, values.get(name))])),
      ...Object.fromEntries(rowCells.filter((cell) => !known.has(cell.qualifier)).map((cell, fieldIndex) => [`${cell.qualifier}（扩展字段 ${fieldIndex + 1}）`, cell.value])),
      TIMESTAMP: formatHbaseTimestamp(rowCells[0]?.timestamp),
    });
    lines.push(`[${index + 1}] BATCH_ID（批次 ID）：${rowKey}`);
    const visible = BATCH_MAJOR_FIELDS.filter(([name]) => values.has(name)).map(([name, label]) => `${label}：${formatBatchMajorValue(name, values.get(name))}`);
    for (let offset = 0; offset < visible.length; offset += 2) lines.push(`    ${visible.slice(offset, offset + 2).join('    ')}`);
    rowCells.filter((cell) => !known.has(cell.qualifier)).forEach((cell) => lines.push(`    ${cell.qualifier.toUpperCase()}：${cell.value}`));
    lines.push(`    TIMESTAMP：${formatHbaseTimestamp(rowCells[0]?.timestamp)}`, '');
  });
  const parsedCells = [...rows.values()].reduce((total, row) => total + row.length, 0);
  return { text: lines.join('\n').trimEnd(), structured: true, parsedCount: rows.size, skippedCount: Math.max(0, cells.length - parsedCells), table: resultTable(tableRecords) };
}

function parseBatchMinorCell(cell) {
  const match = cell.rowKey.match(/^(.*)_(in|out)$/i);
  const paths = cell.qualifier.split('|');
  if (!match || !match[1] || paths.length !== 2 || paths.some((path) => !path)) return null;
  const resultParts = cell.value === '—' ? [] : cell.value.split('|');
  return {
    batchId: match[1],
    direction: match[2].toLowerCase(),
    sourcePath: paths[0],
    targetPath: paths[1],
    result1: resultParts[0] || '—',
    result2: resultParts[1] || '—',
    resultPath: resultParts.slice(2).join('|') || '—',
  };
}

function formatBatchMinorScan(info, cells, raw) {
  const batchCells = cells.filter((cell) => cell.family === 'batch_info');
  const records = batchCells.map((cell) => ({ cell, fields: parseBatchMinorCell(cell) })).filter((record) => record.fields);
  if (!records.length) {
    if (/\b0 row\(s\)/.test(raw)) return { text: `${info.stage}批次子表（${info.state}）\n当前样本暂无记录。`, structured: true, parsedCount: 0, skippedCount: 0 };
    return { text: raw, structured: false, parsedCount: 0, skippedCount: cells.length };
  }

  const lines = [`${info.stage}批次子表（${info.state}，已解析 ${records.length} 条文件记录）`, '字段来源：RowKey、列族 batch_info 的 Qualifier 路径段及 Value 结果段。复制按钮仍复制原始 scan 输出。', ''];
  records.forEach(({ cell, fields }, index) => {
    const directionText = fields.direction === 'in' ? '输入' : '输出';
    const sourceLabel = fields.direction === 'in' ? 'INPUT_SOURCE_PATH（输入源文件）' : 'OUTPUT_SOURCE_PATH（输出源文件）';
    const targetLabel = fields.direction === 'in' ? 'WORKING_PATH（处理文件）' : 'OUTPUT_TARGET_PATH（输出目标文件）';
    lines.push(
      `[${index + 1}] BATCH_ID（批次 ID）：${fields.batchId}    DIRECTION（方向）：${fields.direction}（${directionText}）`,
      `    ${sourceLabel}：${fields.sourcePath}`,
      `    ${targetLabel}：${fields.targetPath}`,
      `    RESULT_SEGMENT_1（结果段 1）：${fields.result1}    RESULT_SEGMENT_2（结果段 2）：${fields.result2}`,
      `    RESULT_PATH（结果文件）：${fields.resultPath}`,
      `    TIMESTAMP：${formatHbaseTimestamp(cell.timestamp)}    ROW_KEY：${cell.rowKey}`,
      '',
    );
  });
  const table = resultTable(records.map(({ cell, fields }) => ({
    'BATCH_ID（批次 ID）': fields.batchId,
    'DIRECTION（方向）': `${fields.direction}（${fields.direction === 'in' ? '输入' : '输出'}）`,
    'SOURCE_PATH（来源文件）': fields.sourcePath, 'TARGET_PATH（目标文件）': fields.targetPath,
    'RESULT_SEGMENT_1（结果段 1）': fields.result1, 'RESULT_SEGMENT_2（结果段 2）': fields.result2,
    'RESULT_PATH（结果文件）': fields.resultPath, 'VALUE_RAW（原始值）': cell.value,
    TIMESTAMP: formatHbaseTimestamp(cell.timestamp), ROW_KEY: cell.rowKey,
  })));
  return { text: lines.join('\n').trimEnd(), structured: true, parsedCount: records.length, skippedCount: Math.max(0, cells.length - records.length), table };
}

function formatBatchInfoScan(tablePath, raw) {
  const info = batchTableInfo(tablePath);
  const cells = parseHbaseCells(raw);
  return info.level === 'major' ? formatBatchMajorScan(info, cells, raw) : formatBatchMinorScan(info, cells, raw);
}

export function formatHbaseScanText(tablePath, rawText, rows) {
  const raw = String(rawText || '');
  const isTrial = /^TRY_/i.test(tableNameFromPath(tablePath));
  if (!raw) {
    return { text: raw, structured: false, parsedCount: 0, skippedCount: 0 };
  }
  if (isMonthlyAccumulatorDetailTable(tablePath)) return formatAccumulatorDetailScan(raw, isTrial);
  if (isTicketDispatchTable(tablePath)) return formatTicketDispatchScan(tablePath, raw);
  if (isTicketNormalTable(tablePath)) return formatTicketNormalScan(raw, rows);
  if (isBatchInfoTable(tablePath)) return formatBatchInfoScan(tablePath, raw);
  if (!isMonthlyAccumulatorTable(tablePath)) return { text: raw, structured: false, parsedCount: 0, skippedCount: 0 };

  const tableCycle = tableNameFromPath(tablePath).match(/_(\d{6})(?:_plcatest)?$/i)?.[1];
  const cells = parseHbaseCells(raw).filter((cell) => cell.family === 'f' && cell.qualifier && cell.timestamp !== '—').map((cell) => ({ ...cell, tableCycle }));
  const qualifierCount = cells.length;
  const records = cells.map((cell) => ({ cell, fields: parseAccumulatorQualifier(cell.qualifier) })).filter((record) => record.fields);

  if (!records.length) {
    return { text: raw, structured: false, parsedCount: 0, skippedCount: qualifierCount };
  }

  const lines = [
    `${isTrial ? '试算' : ''}量本初始化 / 结转结果（已解析 ${records.length} 条）`,
    '字段来源：列族 f → Qualifier；复制按钮仍复制原始 scan 输出。',
    '',
  ];
  records.forEach(({ cell, fields }, index) => {
    lines.push(
      `[${index + 1}] ROW_KEY：${cell.rowKey || '—'}`,
      `    ACCUM（结果）：${fields.accum}（${accumMeaning(fields.accum)}）    OWNER_TYPE（归属）：${fields.ownerType}（${ownerMeaning(fields.ownerType)}）`,
      `    RATABLE_RESOURCE_ID（量本/资源类型）：${fields.ratableResourceId}    RESOURCE_CYCLE_ID（量本账期）：${fields.resourceCycleId}`,
      `    PRICING_PLAN_ID（定价计划）：${fields.pricingPlanId}    PREFER_INST_ID（套餐销售品实例）：${fields.preferInstId}`,
      `    VALUE_RAW（原始值）：${cell.value}`,
      `    TIMESTAMP：${formatHbaseTimestamp(cell.timestamp)}    QUALIFIER：f:${cell.qualifier}`,
      '',
    );
  });
  const skippedCount = Math.max(0, qualifierCount - records.length);
  if (skippedCount) lines.push(`另有 ${skippedCount} 个 f 列 Qualifier 未按 6 段格式解析，请复制原始结果核对。`);
  return { text: lines.join('\n').trimEnd(), structured: true, parsedCount: records.length, skippedCount, table: resultTable(records.map((record) => accumulatorTableRecord(record))) };
}
