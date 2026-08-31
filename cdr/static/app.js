/* 话单文件数据调整工具 - 前端逻辑（原生 JS，零依赖） */
"use strict";

const $ = (id) => document.getElementById(id);

// 字段名 → 中文名（覆盖 JF/OCG 常见字段；未在表中的字段不显示中文）
const FIELD_ZH = {
  // 号码 / 用户
  CALLING_ORG_NBR: "主叫号码", CALLED_ORG_NBR: "被叫号码", BILLING_ORG_NBR: "计费号码",
  IMSI_NBR: "IMSI", CALLED_IMSI_NBR: "被叫IMSI", PUSERID: "用户ID",
  SERVED_MSISDN: "服务MSISDN", LOGIN_NAME: "登录账号", LOGIN_NAME_3G: "3G登录账号",
  S_CALLING_IMEI: "主叫IMEI",
  // 业务 / 服务
  SP_ID: "SP标识", CONN_CODE: "服务号", CONTENT_CODE: "内容码",
  CONTENT_TYPE_3G: "3G内容类型", COMBINE_SERVICE_ID: "组合业务号",
  SERVICE_TYPE_ID: "业务类型", SERVICE_TYPE_3G: "3G业务类型",
  SERVICE_TYPE_EXTENTION_CODE: "业务类型扩展码", SERVICETYPEEXTENTION: "业务扩展",
  SERVICE_NBR: "业务号码", SERVICE_NUM_3G: "3G业务号", SERVICECAPABILITY: "业务能力",
  ADD_ACC_NBR: "接入号码", MOBILECARDFEETYPE: "手机卡类型",
  BILLING_NBR: "计费号码", BILLING_PARTY_FLAG: "计费方标志",
  BILLING_USER_TYPE: "计费用户类型", BILLING_CLASS: "计费类",
  // 短信 / 网关
  MSGCENTERNUM: "短信中心号", MSGGATEWAYNUM: "短信网关号", FWMSGGATEWAYNUM: "防火墙网关号",
  SMS_CENTER_ID: "短信中心ID", SMS_DEAL_FLAG: "短信处理标志",
  MSG_ID: "短信ID", MSG_TYPE_ID: "消息类型ID", SISMG: "SMS网关标识",
  // 时间
  CJ_START_TIME: "计费开始时间", CJ_END_TIME: "计费结束时间",
  ORG_START_TIME: "原始开始时间", ORG_END_TIME: "原始结束时间",
  DUP_START_TIME: "去重开始时间", DUP_END_TIME: "去重结束时间",
  PROC_TIME: "处理时间", TIME_STAMP: "时间戳",
  ONLINE_TIME: "上线时间", OFFLINE_TIME: "下线时间",
  // 流量 / 计数
  VOLUME_UPLINK: "上行流量(字节)", VOLUME_DOWNLINK: "下行流量(字节)",
  INPUT_PACKETS: "入包数", OUTPUT_PACKETS: "出包数",
  COUNT_3G: "3G计数", PAGES: "页数", SPEED: "速率",
  // 金额 / 计费
  COMM_CHARGE: "通信费(厘)", INFO_CHARGE: "信息费(厘)", SP_BENIFIT_CHARGE: "SP分成(厘)",
  ORG_CALL_AMOUNT: "原始通话量", ORG_BILLING_AMOUNT: "原始计费金额",
  BASE_CHARGE: "基础费", EXT_CHARGE: "额外费", EXT_ADD_CHARGE: "额外加收",
  CARD_CHARGE: "卡费", PRE_DISCOUNT_CHARGE: "折扣前费",
  CHARGE_MODE: "计费模式", CHARGE_RESULT: "计费结果", CHARGE_TYPE: "计费类型",
  ORG_BILLING_TYPE: "原始计费类型", ORG_PAY_TYPE: "原始付费类型",
  CHARGECURRENCY: "计费币种", CDR_TYPE: "CDR类型", RECORD_TYPE: "记录类型",
  RECORD_FLAG: "记录标志", SUB_RECORD_TYPE: "子记录类型",
  ADJUST_METHOD: "调整方法", ADJUST_VALUE: "调整值",
  // 区域 / 归属
  CALLING_AREA_CODE: "主叫区号", CALLED_AREA_CODE: "被叫区号",
  CALLING_BELONG_AREA_CODE: "主叫归属区号", CALLED_BELONG_AREA_CODE: "被叫归属区号",
  CALLING_ROAM_AREA_CODE: "主叫漫游区号", ROAM_AREA_CODE: "漫游区号",
  ACCT_ROAM_AREA_CODE: "账户漫游区号", CARD_BELONG_AREA_CODE: "卡归属区号",
  CARD_CALLED_AREA_CODE: "卡被叫区号", CARD_CALLING_AREA_CODE: "卡主叫区号",
  VISIT_CITY: "访问城市", LATN_ID: "本地网ID", LATN_ORG_AUDITING_ID: "归属审计ID",
  PROVINCE_ID: "省份ID", SPPROVINCEID: "SP省份ID",
  // ID / 主键
  CDR_KEY: "CDR主键", COLLECT_CDR_ID: "采集流水ID", ORG_CDR_ID: "原始CDR ID",
  CDR_BATCH_ID: "CDR批次ID", EXCH_ID: "交换机ID", SWITCH_ID: "交换机ID",
  TSP_ID: "TSP标识", REC_SEQ: "记录序号", REC_V: "记录版本",
  REC_VERSION: "记录版本号", REC_LOG: "处理日志", SUM_ID: "汇总ID",
  SESSION_ID: "会话ID", OCS_SESSION_ID: "OCS会话ID", SOURCE_UUID: "源UUID",
  SOURCE_TYPE_ID: "业务来源ID", ASSORT_INFO: "业务分组信息",
  PROCESS_STAMP: "处理戳", ORG_CHARGE_ID: "原始计费ID",
  // 文件 / 会话
  ORG_FILE_NAME: "源文件名", ORG_SESSION_ID: "原始会话ID",
  // 网络 / 网元
  NAS_IP: "NAS IP", NAS_PORT: "NAS端口", NAS_PORT_ID: "NAS端口ID", NAS_PORT_TYPE: "NAS端口类型",
  USER_IP: "用户IP", SGSNIP: "SGSN IP", PCF_IP: "PCF IP",
  PGW: "PGW地址", SGW: "SGW地址", BSC_ID: "基站ID",
  VCI: "VCI", VPI: "VPI", VLAN_ID: "VLAN ID",
  URL_ADDR: "URL地址", TRANSPARENT_PARAM: "透传参数",
  // 漫游
  ROAM_TYPE: "漫游类型", ROAM_ORG_TYPE: "漫游源类型",
  VOLTE_ROAMING_CC: "VoLTE漫游CC", VOLTE_ROAMING_MCC: "VoLTE漫游MCC", VOLTE_ROAMING_MNC: "VoLTE漫游MNC",
  IMS_SIGN_FLAG: "IMS签约标志",
  // IMS / VoLTE 字段
  EVENT_TYPE_ID: "事件类型", F_NBR: "FNBR",
  LOCAL_RCORD_NBR: "本地记录号", RCORD_NBR: "记录号", OLD_UUID: "旧UUID",
  NI_PDP: "NI PDP", OFFER_NBR: "销售品编号",
  S_PROD_INST_ID: "产品实例ID", S_PROD_OFFER_INST_ID: "销售品实例ID",
  S_ACCT_ITEM_TYPE_ID_1: "科目类型1", S_ACCT_ITEM_TYPE_ID_2: "科目类型2", S_ACCT_ITEM_TYPE_ID_3: "科目类型3",
  OLD_ACCT_ITEM_TYPE_ID_1: "旧科目类型1", OLD_ACCT_ITEM_TYPE_ID_2: "旧科目类型2", OLD_ACCT_ITEM_TYPE_ID_3: "旧科目类型3",
  OLD_CHARGE_1: "旧费用1", OLD_CHARGE_2: "旧费用2", OLD_CHARGE_3: "旧费用3",
  BILLING_AMOUNT_1: "计费金额1", BILLING_AMOUNT_2: "计费金额2",
  CHARGE_1: "费用1", CHARGE_2: "费用2", CHARGE_3: "费用3",
  PAY_MODE: "付费模式", RATING_GROUP_ID: "评级组ID",
  // 智能网 / SCP
  SCP_INFO: "SCP信息", SCP_GROUP: "SCP组", SCP_SERVICE_TYPE: "SCP业务类型",
  TOLL_DEST_CODE: "长途目的码",
  // 业务 / 增值
  EVENT_ID: "事件ID", ORDER_NUM: "订单号",
  CP_ID: "CP标识", CHANEL_PLAYER_ID: "渠道播放ID", MEDIATYPE: "媒体类型",
  RINGDOWNLOADWAY: "彩铃下载方式", OCS_SESSION_ID: "OCS会话ID",
  STREAMNO: "流号", SUBSCRIPTIONID: "订阅ID",
  // 上网/家宽补充
  BEARER_TYPE: "承载类型", BEAR_SERVICE_CODE: "承载业务码",
  INTERMIT_CAUSE: "中断原因", MODERATOR_FLAG: "仲裁标志", NETWORK_NAME: "网络名",
  PLACE_FLAG: "位置标志", PLACE_TYPE: "位置类型", PLACE_ATTR: "位置属性",
  PRODUCT_NAME: "产品名", TEL_SERVICE_CODE: "电信业务码",
  COLLECT_DEAL_FLAG: "采集处理标志",
  // 流媒体/增值
  OPERATEWAY: "操作方式", GIFTPKG: "礼包",
  M_CHGTP: "计费类型标记",
  // 统计行
  TICKET_COUNT: "票据计数",
};

const S = {
  config: null, files: [], filename: null, loaded: false,
  page: 1, pageSize: 100, bizType: null, colMode: "common",
  filters: [],           // 记录区筛选
  fields: [], commonFields: [], vtypes: {}, allVtypes: {},  // allVtypes[source_type_id] -> {field:type}
  records: [], total: 0, totalPages: 0, bizFilterCounts: {},
  selected: new Set(),   // 造数模板 idx
  drawerIdx: null, drawerData: null,
  undoHistory: [],
};

const OPTS = { eq: "等于", ne: "不等于", contains: "包含", lt: "小于", gt: "大于", between: "介于", in: "属于" };
const MODES = {
  set: "设为固定值", random_phone: "随机手机号", phone_incr: "号码递增",
  random_range: "随机整数区间", time_shift: "时间偏移(秒)", uuid: "UUID",
};

/* ---------------- API ---------------- */
async function api(path, opts) {
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}
const get = (p) => api(p);
const post = (p, b) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });

/* ---------------- 初始化 ---------------- */
async function init() {
  try {
    S.config = await get("api/config");
    $("srcDir").textContent = "源目录: " + S.config.source_dir;
    $("outDir").value = S.config.output_dir;
    await refreshFiles();
  } catch (e) { alert("初始化失败: " + e.message); }
}

async function refreshFiles() {
  const d = await get("api/files");
  S.files = d.files;
  const sel = $("fileSelect");
  sel.innerHTML = "";
  S.files.forEach(f => {
    const o = document.createElement("option");
    o.value = f.name;
    o.textContent = `${f.name} (${f.size_mb}MB, ${f.mtime})`;
    sel.appendChild(o);
  });
  sel.disabled = !S.files.length;
}

/* ---------------- 加载 ---------------- */
async function doLoad() {
  const name = $("fileSelect").value;
  if (!name) { $("loadMsg").textContent = "请选择文件"; return; }
  $("loadMsg").textContent = "加载中…";
  try {
    const d = await post("api/load", { filename: name });
    S.filename = name; S.loaded = true; S.page = 1; S.bizType = null; S.selected.clear();
    S.bizFilterCounts = {};
    S.allVtypes = {};                                       // 缓存各业务类型 vtypes
    (d.biz_summary || []).forEach(b => {
      S.allVtypes[b.source_type_id] = b.vtypes || {};
      S.allVtypes["__all__"] = S.allVtypes["__all__"] || {};
      Object.assign(S.allVtypes["__all__"], b.vtypes || {});
    });
    renderStats(d);
    renderBizTabs(d.biz_summary);
    $("opCard").classList.remove("hidden");
    $("exportCard").classList.remove("hidden");
    await refreshRecords();
    $("loadMsg").textContent = `已加载 ${d.total_records} 条记录`;
  } catch (e) { $("loadMsg").textContent = "加载失败: " + e.message; }
}

function renderStats(d) {
  $("stats").classList.remove("hidden");
  $("statCards").innerHTML = [
    ["总记录数", d.total_records], ["统计行 TICKET_COUNT", d.ticket_count_expected],
    ["业务类型数", d.biz_summary.length], ["含 CDR_KEY", d.has_cdr_key ? "是" : "否"],
  ].map(([k, v]) => `<div class="stat-item"><div class="v">${v}</div><div class="k">${k}</div></div>`).join("");
  const max = Math.max(1, ...d.biz_summary.map(b => b.count));
  $("bizBars").innerHTML = d.biz_summary.map(b => `
    <div class="biz-row"><span class="lbl">${b.biz_name}</span>
    <div class="bar" style="width:${Math.max(6, (b.count / max) * 320)}px">${b.count}</div></div>`).join("");
  const warn = d.warnings || [];
  $("warnings").classList.toggle("hidden", !warn.length);
  $("warnings").textContent = "⚠ " + warn.join("；");
}

/* ---------------- 业务类型 Tab ---------------- */
function renderBizTabs(bizSummary) {
  const tabs = $("bizTabs");
  tabs.classList.remove("hidden");
  let html = `<div class="tab ${S.bizType === null ? "active" : ""}" data-biz="">全部</div>`;
  bizSummary.forEach(b => {
    html += `<div class="tab ${S.bizType === String(b.source_type_id) ? "active" : ""}" data-biz="${b.source_type_id}">
      ${b.biz_name}<span class="n">${b.count}</span></div>`;
  });
  tabs.innerHTML = html;
  tabs.querySelectorAll(".tab").forEach(t => t.onclick = () => {
    S.bizType = t.dataset.biz === "" ? null : t.dataset.biz;
    S.page = 1;
    renderBizTabs(bizSummary);
    refreshRecords();
  });
  $("filterBar").classList.remove("hidden");
  if (!$("filterRows").children.length) addFilterRow();
}

/* ---------------- 筛选 ---------------- */
function fieldOptions(selected) {
  return S.fields.map(f => `<option value="${f}" ${f === selected ? "selected" : ""}>${f}${S.vtypes[f] ? " [" + S.vtypes[f] + "]" : ""}</option>`).join("");
}

// 刷新所有现有字段下拉框（保留当前选择）
function refreshFieldSelects() {
  const sels = [];
  ["filterRows", "buFilters", "buUpdates", "genTransforms"].forEach(id => {
    const box = $(id);
    if (!box) return;
    box.querySelectorAll(".ffield, .ufield, .tfield").forEach(sel => sels.push(sel));
  });
  sels.forEach(sel => {
    const cur = sel.value;
    const optionsHtml = fieldOptions(cur);
    if (optionsHtml) {
      sel.innerHTML = optionsHtml;
      // 若保留的值不在新选项里，重置为第一个
      if (cur && !sel.querySelector(`option[value="${cur}"]`)) sel.value = S.fields[0] || "";
    } else {
      sel.innerHTML = `<option value="">（未加载数据）</option>`;
    }
  });
}

function addFilterRow(containerId, f) {
  const box = $(containerId);
  const row = document.createElement("div");
  row.className = "frow";
  row.innerHTML = `
    <select class="fsel ffield"></select>
    <select class="fsel fop">
      ${Object.entries(OPTS).map(([v, l]) => `<option value="${v}" ${f && f.op === v ? "selected" : ""}>${l}</option>`).join("")}
    </select>
    <input class="fval fval1" placeholder="值">
    <input class="fval fval2 hidden" placeholder="最大值">
    <button class="del">✕</button>`;
  row.querySelector(".ffield").innerHTML = fieldOptions(f && f.field);
  if (f && f.value !== undefined) {
    if (Array.isArray(f.value)) { row.querySelector(".fval1").value = f.value[0]; row.querySelector(".fval2").value = f.value[1]; }
    else row.querySelector(".fval1").value = f.value;
  }
  const sync = () => {
    const op = row.querySelector(".fop").value;
    row.querySelector(".fval2").classList.toggle("hidden", op !== "between");
    row.querySelector(".fval2").classList.toggle("hidden", op !== "between");
  };
  row.querySelector(".fop").onchange = sync; sync();
  row.querySelector(".del").onclick = () => { row.remove(); };
  row.querySelectorAll("input,select").forEach(el => el.onchange = () => { /* live */ });
  box.appendChild(row);
}

function collectFilters(containerId) {
  const rows = $(containerId).querySelectorAll(".frow");
  const out = [];
  rows.forEach(r => {
    const field = r.querySelector(".ffield").value;
    const op = r.querySelector(".fop").value;
    const v1 = r.querySelector(".fval1").value;
    if (!field) return;
    let val;
    if (op === "between") { const v2 = r.querySelector(".fval2").value; val = [v1, v2]; }
    else if (op === "in") { val = v1.split(",").map(s => s.trim()).filter(Boolean); }
    else val = v1;
    if (op !== "between" && (val === "" || (Array.isArray(val) && !val.length))) return;
    out.push({ field, op, value: val });
  });
  return out;
}

/* ---------------- 记录浏览 ---------------- */
async function refreshRecords() {
  if (!S.loaded) return;
  S.filters = collectFilters("filterRows");
  const qs = new URLSearchParams({
    page: S.page, page_size: S.pageSize, biz_type: S.bizType || "",
    filters: JSON.stringify(S.filters),
  });
  try {
    const d = await get("api/records?" + qs.toString());
    S.records = d.records; S.total = d.total; S.totalPages = d.total_pages;
    S.fields = d.fields; S.commonFields = d.common_fields;
    S.bizFilterCounts = d.biz_filter_counts;
    // 根据当前 bizType 取对应的 vtypes（"全部"用合并视图）
    const bt = S.bizType !== null && S.bizType !== "" ? Number(S.bizType) : "__all__";
    S.vtypes = S.allVtypes[bt] || {};
    refreshFieldSelects();
    renderTable();
    renderPager();
    $("recCount").textContent = `共 ${d.total} 条 / ${d.total_pages} 页`;
    const hasRows = S.records.length > 0;
    $("tableWrap").classList.toggle("hidden", !hasRows);
    $("pager").classList.toggle("hidden", !hasRows);
    $("tplCount").textContent = `已选模板: ${S.selected.size} 条`;
    $("opCard").classList.remove("hidden");
  } catch (e) { alert("查询失败: " + e.message); }
}

function visibleFields() {
  return S.colMode === "all" ? S.fields : (S.commonFields.length ? S.commonFields : S.fields);
}

function renderTable() {
  const cols = visibleFields();
  const thead = $("recThead"), tbody = $("recTbody");
  thead.innerHTML = `<tr>
    <th rowspan="2" style="width:34px"></th>
    ${cols.map(c => `<th>${c}</th>`).join("")}
  </tr><tr>
    ${cols.map(c => `<th class="zh">${FIELD_ZH[c] || ""}</th>`).join("")}
  </tr>`;
  if (!S.records.length) { tbody.innerHTML = ""; return; }
  tbody.innerHTML = S.records.map(r => {
    const tds = cols.map(c => {
      const v = r[c];
      const txt = v === null || v === undefined ? '<span class="td-null">∅</span>' : String(v);
      return `<td title="${c}: ${txt}">${txt}</td>`;
    }).join("");
    const sel = S.selected.has(r.idx) ? "sel" : "";
    return `<tr class="row-click ${sel}" data-idx="${r.idx}">
      <td><input type="checkbox" class="rowck" data-idx="${r.idx}" ${S.selected.has(r.idx) ? "checked" : ""}></td>
      ${tds}</tr>`;
  }).join("");
  tbody.querySelectorAll("tr").forEach(tr => {
    const idx = Number(tr.dataset.idx);
    tr.querySelector("td:first-child input").onclick = (ev) => {
      ev.stopPropagation();
      if (S.selected.has(idx)) S.selected.delete(idx); else S.selected.add(idx);
      tr.classList.toggle("sel", S.selected.has(idx));
      $("tplCount").textContent = `已选模板: ${S.selected.size} 条`;
    };
    tr.onclick = () => openDrawer(idx);
  });
}

function renderPager() {
  const p = $("pager");
  if (S.totalPages <= 1) { p.innerHTML = ""; return; }
  p.innerHTML = `
    <button id="pgFirst">«</button><button id="pgPrev">‹</button>
    <span>第 ${S.page} / ${S.totalPages} 页</span>
    <button id="pgNext">›</button><button id="pgLast">»</button>`;
  $("pgFirst").onclick = () => { S.page = 1; refreshRecords(); };
  $("pgPrev").onclick = () => { S.page = Math.max(1, S.page - 1); refreshRecords(); };
  $("pgNext").onclick = () => { S.page = Math.min(S.totalPages, S.page + 1); refreshRecords(); };
  $("pgLast").onclick = () => { S.page = S.totalPages; refreshRecords(); };
}

/* ---------------- 编辑抽屉 ---------------- */
async function openDrawer(idx) {
  try {
    const d = await get("api/record/" + idx);
    S.drawerIdx = idx; S.drawerData = d.record;
    const rec = d.record;
    const rows = Object.keys(rec).map(f => {
      const v = rec[f];
      const val = v === null || v === undefined ? "" : v;
      return `<div class="frow2" data-f="${f}">
        <span class="fname" title="${f}">${f}</span>
        <input class="fedit" value="${String(val).replace(/"/g, "&quot;")}">
        <span class="ftype">${typeof v === "number" ? (Number.isInteger(v) ? "int" : "float") : "str"}</span>
      </div>`;
    }).join("");
    $("drawerTitle").textContent = `编辑记录 #${idx}`;
    $("drawerBody").innerHTML = rows;
    $("drawerMsg").textContent = "";
    $("drawer").classList.remove("hidden");
    $("overlay").classList.remove("hidden");
  } catch (e) { alert("打开失败: " + e.message); }
}

function closeDrawer() {
  $("drawer").classList.add("hidden");
  $("overlay").classList.add("hidden");
  S.drawerIdx = null;
}

async function saveDrawer() {
  const updates = {};
  $("drawerBody").querySelectorAll(".frow2").forEach(row => {
    const f = row.dataset.f;
    updates[f] = row.querySelector(".fedit").value;
  });
  try {
    const d = await post("api/record/" + S.drawerIdx, { updates });
    if (d.ok) {
      $("drawerMsg").textContent = "✓ 已保存";
      $("drawerMsg").className = "msg ok";
      closeDrawer();
      refreshRecords();
    } else {
      $("drawerMsg").textContent = d.errors.join("；");
      $("drawerMsg").className = "msg err";
    }
  } catch (e) { $("drawerMsg").textContent = "保存失败: " + e.message; $("drawerMsg").className = "msg err"; }
}

/* ---------------- 批量修改 ---------------- */
function buAddFilter() {
  const box = $("buFilters");
  const row = document.createElement("div");
  row.className = "frow";
  row.innerHTML = `
    <select class="fsel ffield"></select>
    <select class="fsel fop">${Object.entries(OPTS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
    <input class="fval fval1" placeholder="值"><input class="fval fval2 hidden" placeholder="最大值">
    <button class="del">✕</button>`;
  row.querySelector(".ffield").innerHTML = fieldOptions();
  const sync = () => row.querySelector(".fval2").classList.toggle("hidden", row.querySelector(".fop").value !== "between");
  row.querySelector(".fop").onchange = sync;
  row.querySelector(".del").onclick = () => row.remove();
  box.appendChild(row);
}

function buAddUpdate() {
  const box = $("buUpdates");
  const row = document.createElement("div");
  row.className = "frow";
  row.innerHTML = `<span>设置</span>
    <select class="fsel ufield"></select>
    <span>=</span><input class="fval uval" placeholder="新值">
    <button class="del">✕</button>`;
  row.querySelector(".ufield").innerHTML = fieldOptions();
  row.querySelector(".del").onclick = () => row.remove();
  box.appendChild(row);
}

async function buRun(dryRun) {
  const filters = collectFilters("buFilters");
  const updates = {};
  $("buUpdates").querySelectorAll(".frow").forEach(r => {
    const f = r.querySelector(".ufield").value;
    if (f) updates[f] = r.querySelector(".uval").value;
  });
  if (!Object.keys(updates).length) { $("buResult").textContent = "请至少添加一个修改项"; return; }
  try {
    const d = await post("api/batch-update", { filters, updates, dry_run: dryRun });
    $("buResult").textContent = JSON.stringify({
      匹配: d.matched, 应用: d.applied, 跳过: d.skipped_count,
      预览: d.preview.slice(0, 20), 跳过明细: d.skipped.slice(0, 10),
    }, null, 1);
    if (!dryRun) {
      $("undoMsg").textContent = `✓ 已应用 ${d.applied} 处，可撤销`;
      refreshRecords();
    }
  } catch (e) { $("buResult").textContent = "错误: " + e.message; }
}

async function doUndo() {
  try {
    const d = await post("api/undo", {});
    $("undoMsg").textContent = `✓ ${d.desc}`;
    refreshRecords();
  } catch (e) { $("undoMsg").textContent = e.message; }
}

/* ---------------- 批量造数 ---------------- */
function genAddTransform() {
  const box = $("genTransforms");
  const row = document.createElement("div");
  row.className = "frow";
  row.innerHTML = `
    <select class="fsel tfield"></select>
    <select class="fsel tmode">
      ${Object.entries(MODES).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
    </select>
    <input class="fval tparams" placeholder="参数(如 3600 / 100,10000 / 值)">
    <button class="del">✕</button>`;
  row.querySelector(".tfield").innerHTML = fieldOptions();
  row.querySelector(".del").onclick = () => row.remove();
  box.appendChild(row);
}

function collectTransforms() {
  const out = [];
  $("genTransforms").querySelectorAll(".frow").forEach(r => {
    const field = r.querySelector(".tfield").value;
    const mode = r.querySelector(".tmode").value;
    const raw = r.querySelector(".tparams").value;
    if (!field) return;
    const params = {};
    if (mode === "set") params.value = raw;
    else if (mode === "time_shift") params.seconds = Number(raw) || 0;
    else if (mode === "random_range") {
      const [a, b] = raw.split(",");
      params.min = Number(a) || 0; params.max = Number(b) || 1000;
    }
    else if (mode === "phone_incr") params.offset = Number(raw) || 1;
    out.push({ field, mode, params });
  });
  return out;
}

async function doGenerate() {
  if (!S.selected.size) { $("genMsg").textContent = "请先在记录表格勾选模板"; return; }
  const copies = Number($("genCopies").value) || 1;
  const id_regen = {
    collect_cdr_id: $("rgCollect").checked,
    org_cdr_id: $("rgOrg").checked,
    rec_seq: $("rgRecSeq").checked,
    cdr_key: $("rgCdrKey").checked,
    session_uuid: $("rgUuid").checked,
  };
  const transforms = collectTransforms();
  try {
    const d = await post("api/batch-generate", {
      template_idxs: [...S.selected], copies_per_template: copies, id_regen, transforms,
    });
    $("genResult").textContent = JSON.stringify({
      生成条数: d.generated, 新记录idx: d.new_idxs.slice(0, 30), 样例: d.preview,
    }, null, 1);
    $("genMsg").textContent = `✓ 已生成 ${d.generated} 条（可撤销）`;
    S.selected.clear();
    $("tplCount").textContent = "已选模板: 0 条";
    refreshRecords();
  } catch (e) { $("genMsg").textContent = "生成失败: " + e.message; }
}

/* ---------------- 导出 ---------------- */
async function doExport() {
  const out_dir = $("outDir").value.trim() || null;
  const filename = $("outName").value.trim() || null;
  $("exportMsg").textContent = "导出中…";
  try {
    const d = await post("api/export", { out_dir, filename });
    const v = d.validations;
    const lines = [
      "导出文件: " + d.exported_path,
      "记录数: " + d.record_count + " | TICKET_COUNT: " + d.ticket_count,
      "校验: " + (v.ok ? "✅ 全部通过" : "❌ 存在错误"),
      "  · 记录数一致: " + v.count_match,
      "  · CDR_KEY 唯一: " + v.cdr_key_unique,
      "  · COLLECT_CDR_ID 唯一: " + v.collect_cdr_id_unique,
      "  · 时间格式: " + v.time_format_ok,
      "  · 回读可解析: " + v.json_readable,
    ];
    if (v.errors.length) lines.push("错误明细:", ...v.errors.map(e => "  - " + e));
    $("exportResult").textContent = lines.join("\n");
    $("exportMsg").textContent = v.ok ? "✓ 导出成功" : "导出完成，但校验有异常";
    refreshExportHistory();
  } catch (e) { $("exportMsg").textContent = "导出失败: " + e.message; }
}

async function refreshExportHistory() {
  try {
    const d = await get("api/export-history");
    $("exportHistory").innerHTML = d.items.length
      ? d.items.map(i => `<div>${i.name} — ${i.size_mb}MB — ${i.mtime}</div>`).join("")
      : "<div>暂无导出记录</div>";
  } catch (e) { /* ignore */ }
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  $("loadBtn").onclick = doLoad;
  $("addFilterBtn").onclick = () => addFilterRow("filterRows");
  $("applyFilterBtn").onclick = () => { S.page = 1; refreshRecords(); };
  $("resetFilterBtn").onclick = () => { $("filterRows").innerHTML = ""; addFilterRow("filterRows"); S.page = 1; refreshRecords(); };
  $("colMode").onchange = (e) => { S.colMode = e.target.value; renderTable(); };
  $("pageSizeSel").onchange = (e) => { S.pageSize = Number(e.target.value); S.page = 1; refreshRecords(); };

  $("buAddFilter").onclick = buAddFilter;
  $("buAddUpdate").onclick = buAddUpdate;
  $("buPreview").onclick = () => buRun(true);
  $("buApply").onclick = () => buRun(false);
  $("undoBtn").onclick = doUndo;

  $("genAddTransform").onclick = genAddTransform;
  $("genBtn").onclick = doGenerate;

  $("exportBtn").onclick = doExport;
  $("drawerClose").onclick = closeDrawer;
  $("overlay").onclick = closeDrawer;
  $("drawerSave").onclick = saveDrawer;
  $("drawerBody").addEventListener("keydown", (e) => { if (e.key === "Enter") saveDrawer(); });

  // 初始各面板加一行
  addFilterRow("filterRows");
  buAddFilter();
  buAddUpdate();
  genAddTransform();
  refreshExportHistory();
}

document.addEventListener("DOMContentLoaded", () => { bind(); init(); });
