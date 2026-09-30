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

export function formatHbaseTimestamp(value) {
  const raw = String(value ?? '—');
  if (!/^-?\d+$/.test(raw)) return raw;
  const milliseconds = Number(raw);
  if (!Number.isSafeInteger(milliseconds)) return raw;
  const date = new Date(milliseconds + 8 * 60 * 60 * 1000);
  if (Number.isNaN(date.getTime())) return raw;
  return `${raw}（${date.toISOString().replace('T', ' ').replace('Z', ' +08:00')}）`;
}

function parseHbaseCells(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const cells = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marker = lines[index].indexOf(' column=');
    if (marker < 0) continue;
    const rowKey = lines[index].slice(0, marker).trim();
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
  return { text: lines.join('\n').trimEnd(), structured: true, parsedCount: records.length, skippedCount };
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
  return { text: lines.join('\n').trimEnd(), structured: true, parsedCount: records.length, skippedCount };
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
  [...rows.entries()].forEach(([rowKey, rowCells], index) => {
    const values = new Map(rowCells.map((cell) => [cell.qualifier, cell.value]));
    const known = new Set(BATCH_MAJOR_FIELDS.map(([name]) => name));
    lines.push(`[${index + 1}] BATCH_ID（批次 ID）：${rowKey}`);
    const visible = BATCH_MAJOR_FIELDS.filter(([name]) => values.has(name)).map(([name, label]) => `${label}：${formatBatchMajorValue(name, values.get(name))}`);
    for (let offset = 0; offset < visible.length; offset += 2) lines.push(`    ${visible.slice(offset, offset + 2).join('    ')}`);
    rowCells.filter((cell) => !known.has(cell.qualifier)).forEach((cell) => lines.push(`    ${cell.qualifier.toUpperCase()}：${cell.value}`));
    lines.push(`    TIMESTAMP：${formatHbaseTimestamp(rowCells[0]?.timestamp)}`, '');
  });
  const parsedCells = [...rows.values()].reduce((total, row) => total + row.length, 0);
  return { text: lines.join('\n').trimEnd(), structured: true, parsedCount: rows.size, skippedCount: Math.max(0, cells.length - parsedCells) };
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
  return { text: lines.join('\n').trimEnd(), structured: true, parsedCount: records.length, skippedCount: Math.max(0, cells.length - records.length) };
}

function formatBatchInfoScan(tablePath, raw) {
  const info = batchTableInfo(tablePath);
  const cells = parseHbaseCells(raw);
  return info.level === 'major' ? formatBatchMajorScan(info, cells, raw) : formatBatchMinorScan(info, cells, raw);
}

export function formatHbaseScanText(tablePath, rawText) {
  const raw = String(rawText || '');
  const isTrial = /^TRY_/i.test(tableNameFromPath(tablePath));
  if (!raw) {
    return { text: raw, structured: false, parsedCount: 0, skippedCount: 0 };
  }
  if (isMonthlyAccumulatorDetailTable(tablePath)) return formatAccumulatorDetailScan(raw, isTrial);
  if (isTicketDispatchTable(tablePath)) return formatTicketDispatchScan(tablePath, raw);
  if (isBatchInfoTable(tablePath)) return formatBatchInfoScan(tablePath, raw);
  if (!isMonthlyAccumulatorTable(tablePath)) return { text: raw, structured: false, parsedCount: 0, skippedCount: 0 };

  const cells = parseHbaseCells(raw).filter((cell) => cell.family === 'f' && cell.qualifier && cell.timestamp !== '—');
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
  return { text: lines.join('\n').trimEnd(), structured: true, parsedCount: records.length, skippedCount };
}
