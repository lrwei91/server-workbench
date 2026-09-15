# -*- coding: utf-8 -*-
"""话单文件核心引擎：解析 / 会话 / 校验 / 变换 / 导出

支持的输入：NDJSON 话单文件（JF 混合多业务 / OCG 单一上网话单），末行含 {"TICKET_COUNT": N} 统计行。
"""
import json
import os
import random
import tempfile
import threading
import uuid
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path

from config import SOURCE_DIR, OUTPUT_DIR, LOG_DIR, MAX_RECORDS, UNDO_MAX_CHANGES, UNDO_DEPTH, MAX_PREVIEW

# 路径常量统一由 config.py 提供（与工作台 config.js 口径一致）
TOOL_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = TOOL_DIR.parent.parent

BIZ_TYPE_MAP = {
    47: "SP增值短信",
    3: "家宽上网",
    12: "IMS/VoLTE",
    53: "流媒体增值",
    11: "点对点短信",
    2: "智能网4008",
    8: "上网流量(OCG)",
}

# 时间字段分组：CJ 为 14 位 YYYYMMDDHHMMSS；ORG 为 12 位 YYMMDDHHMMSS(+2 位尾数)
CJ_TIME_FIELDS = {"CJ_START_TIME", "CJ_END_TIME", "DUP_START_TIME", "DUP_END_TIME", "TIME_STAMP"}
ORG_TIME_FIELDS = {"ORG_START_TIME", "ORG_END_TIME", "ONLINE_TIME", "OFFLINE_TIME", "PROC_TIME"}
ALL_TIME_FIELDS = CJ_TIME_FIELDS | ORG_TIME_FIELDS

UNIQUE_FIELDS = {"CDR_KEY", "COLLECT_CDR_ID", "ORG_CDR_ID"}
# 唯一标识字段不能被单条编辑置空；保留旧名称作为内部兼容别名。
ID_FIELDS = UNIQUE_FIELDS
_lock = threading.RLock()


class Session:
    """内存会话（本地单用户，模块级单例）"""

    def __init__(self):
        self.reset()

    def reset(self):
        self.filename = None
        self.records = []            # list[dict]，idx = 列表下标（编辑不改变结构，稳定）
        self.stat_ticket = None      # 源文件统计行值
        self.schema_by_type = {}     # SOURCE_TYPE_ID -> {"fields":[], "vtypes":{}, "common":[]}
        self.biz_counts = {}         # SOURCE_TYPE_ID -> count
        self._next_collect = 0       # COLLECT_CDR_ID 递增
        self._next_rec_seq = 0       # REC_SEQ 递增
        self._next_seq5 = 0          # CDR_KEY 第五段递增
        self._org_used = set()       # 已使用 ORG_CDR_ID
        self.indexes = {"CDR_KEY": {}, "COLLECT_CDR_ID": {}, "ORG_CDR_ID": {}}
        self.undo_stack = []
        self.revision = 0
        self.last_export_revision = None

    @property
    def loaded(self):
        return self.filename is not None


_session = Session()


# ---------------------------------------------------------------- 基础工具

def _infer_vtype(fmeta):
    """由扫描标志推断字段类型：int / float / str"""
    if "types" in fmeta:
        types = fmeta["types"]
        if "str" in types or "other" in types:
            return str
        if "float" in types:
            return float
        if "int" in types:
            return int
        return str
    if fmeta["str"]:
        return str
    if fmeta["int"]:
        return int
    if fmeta["float"]:
        return float
    return str


def _convert(v, vtype):
    if v is None or (isinstance(v, str) and v == ""):
        return None
    try:
        if vtype is int:
            return int(v) if not isinstance(v, bool) else v
        if vtype is float:
            return float(v)
        return str(v)
    except (ValueError, TypeError):
        return None


def validate_time(field, value):
    if value in (None, ""):
        return True
    s = str(value)
    if field in CJ_TIME_FIELDS:
        if len(s) != 14 or not s.isdigit():
            return False
        try:
            datetime.strptime(s, "%Y%m%d%H%M%S")
            return True
        except ValueError:
            return False
    if field in ORG_TIME_FIELDS:
        core = s[:12] if len(s) >= 12 else s
        if len(core) != 12 or not core.isdigit():
            return False
        try:
            datetime.strptime(core, "%y%m%d%H%M%S")
            return True
        except ValueError:
            return False
    return True


def _cmp(a, b):
    try:
        if isinstance(a, str) and isinstance(b, str):
            return -1 if a < b else (1 if a > b else 0)
        return -1 if float(a) < float(b) else (1 if float(a) > float(b) else 0)
    except (ValueError, TypeError):
        sa, sb = str(a), str(b)
        return -1 if sa < sb else (1 if sa > sb else 0)


def _num_eq(a, b):
    """数值相等比较（兼容 int/float 与数字字符串）"""
    if isinstance(a, (int, float)) and not isinstance(a, bool):
        try:
            return float(a) == float(b)
        except (ValueError, TypeError):
            return False
    return a == b


def _match(rec, flt):
    field, op = flt.get("field"), flt.get("op")
    if field not in rec:
        return op == "ne"
    rv = rec[field]
    val = flt.get("value")
    try:
        if op == "eq":
            return _num_eq(rv, val)
        if op == "ne":
            return not _num_eq(rv, val)
        if op == "contains":
            return str(val) in str(rv)
        if op == "lt":
            return _cmp(rv, val) < 0
        if op == "gt":
            return _cmp(rv, val) > 0
        if op == "between":
            return _cmp(rv, val[0]) >= 0 and _cmp(rv, val[1]) <= 0
        if op == "in":
            return any(rv == x for x in val)
    except (TypeError, ValueError, IndexError):
        return False
    return False


def _field_vtype(rec, field):
    st = rec.get("SOURCE_TYPE_ID")
    sch = _session.schema_by_type.get(st)
    if sch and field in sch["vtypes"]:
        return sch["vtypes"][field]
    return str


def _vtype_name(t):
    return {int: "int", float: "float", str: "str"}.get(t, "str")


def _rebuild_indexes():
    """重建唯一字段索引；值映射到 idx 集合，重复值也不会被覆盖。"""
    indexes = {"CDR_KEY": {}, "COLLECT_CDR_ID": {}, "ORG_CDR_ID": {}}
    for idx, rec in enumerate(_session.records):
        for field, mapping in indexes.items():
            value = rec.get(field)
            if value in (None, ""):
                continue
            try:
                mapping.setdefault(value, set()).add(idx)
            except TypeError:
                continue
    _session.indexes = indexes


def _rebuild_org_used():
    _session._org_used = {str(rec.get("ORG_CDR_ID")) for rec in _session.records if rec.get("ORG_CDR_ID") not in (None, "")}


def _refresh_schema():
    """在批量造数/撤销后刷新业务计数和字段类型元数据。"""
    schema_by_type, biz_counts = {}, {}
    for rec in _session.records:
        st = rec.get("SOURCE_TYPE_ID")
        schema_by_type.setdefault(st, {"fmeta": {}, "order": []})
        sch = schema_by_type[st]
        for key, value in rec.items():
            if key not in sch["fmeta"]:
                sch["fmeta"][key] = {"types": set(), "count": 0}
                sch["order"].append(key)
            meta = sch["fmeta"][key]
            meta["count"] += 1
            if value is not None:
                if isinstance(value, bool): meta["types"].add("str")
                elif isinstance(value, int): meta["types"].add("int")
                elif isinstance(value, float): meta["types"].add("float")
                elif isinstance(value, str): meta["types"].add("str")
                else: meta["types"].add("other")
        biz_counts[st] = biz_counts.get(st, 0) + 1
    key_fields = UNIQUE_FIELDS | ALL_TIME_FIELDS | {"SP_ID", "CONN_CODE", "IMSI_NBR", "BILLING_ORG_NBR", "CALLING_ORG_NBR", "CALLED_ORG_NBR", "SERVICE_NBR", "LOGIN_NAME", "VOLUME_UPLINK", "VOLUME_DOWNLINK", "ORG_CALL_AMOUNT", "COMM_CHARGE", "EXT_CHARGE", "SOURCE_TYPE_ID", "RECORD_TYPE", "RATING_GROUP_ID"}
    result = {}
    for st, sch in schema_by_type.items():
        n_recs = biz_counts.get(st, 0) or 1
        fields = list(sch["order"])
        vtypes = {key: _infer_vtype(sch["fmeta"][key]) for key in fields}
        common = [key for key in fields if key in key_fields]
        common.extend([key for key in fields if key not in key_fields and sch["fmeta"][key]["count"] >= n_recs * 0.8][:12])
        result[st] = {"fields": fields, "vtypes": vtypes, "common": common}
    _session.schema_by_type = result
    _session.biz_counts = biz_counts


def _mark_changed():
    _session.revision += 1
    _rebuild_indexes()


def _push_undo(operation):
    changes = operation.get("changes")
    if changes is not None and len(changes) > UNDO_MAX_CHANGES:
        operation["changes"] = changes[-UNDO_MAX_CHANGES:]
    _session.undo_stack.append(operation)
    if len(_session.undo_stack) > UNDO_DEPTH:
        del _session.undo_stack[:-UNDO_DEPTH]


# ---------------------------------------------------------------- 文件与加载

def list_files():
    files = []
    if SOURCE_DIR.exists():
        for p in sorted(SOURCE_DIR.glob("*.json")):
            st = p.stat()
            files.append({
                "name": p.name,
                "size_bytes": st.st_size,
                "size_mb": round(st.st_size / 1048576, 2),
                "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
            })
    return files


def load_file(filename):
    if not isinstance(filename, str) or not filename.strip():
        raise ValueError("文件名不能为空")
    path = (SOURCE_DIR / filename).resolve()
    if path.parent != SOURCE_DIR.resolve():
        raise ValueError("文件名不在源目录: " + filename)
    if not path.exists():
        raise ValueError("文件不存在: " + filename)

    records, stat_ticket = [], None
    with open(path, "r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"第 {line_no} 行 JSON 格式错误：{exc.msg}") from exc
            if isinstance(obj, dict) and set(obj.keys()) == {"TICKET_COUNT"}:
                value = obj.get("TICKET_COUNT")
                if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                    raise ValueError(f"第 {line_no} 行 TICKET_COUNT 必须是非负整数")
                stat_ticket = value
                continue
            if not isinstance(obj, dict):
                raise ValueError(f"第 {line_no} 行必须是 JSON 对象")
            records.append(obj)
            if len(records) > MAX_RECORDS:
                raise ValueError(f"记录数超过上限 {MAX_RECORDS}")

    s = _session
    s.reset()
    s.filename = filename
    s.records = records
    s.stat_ticket = stat_ticket

    # schema 归并 + vtype 推断（每业务类型独立）
    schema_by_type, biz_counts = {}, {}
    for rec in records:
        st = rec.get("SOURCE_TYPE_ID")
        if st not in schema_by_type:
            schema_by_type[st] = {"fmeta": {}, "order": []}
        sch = schema_by_type[st]
        for k, v in rec.items():
            if k not in sch["fmeta"]:
                sch["fmeta"][k] = {"types": set(), "count": 0}
                sch["order"].append(k)
            m = sch["fmeta"][k]
            m["count"] += 1
            if v is not None:
                if isinstance(v, bool):
                    m["types"].add("str")
                elif isinstance(v, int):
                    m["types"].add("int")
                elif isinstance(v, float):
                    m["types"].add("float")
                elif isinstance(v, str):
                    m["types"].add("str")
                else:
                    m["types"].add("other")
        biz_counts[st] = biz_counts.get(st, 0) + 1

    for st, sch in schema_by_type.items():
        fields, vtypes, common = [], {}, []
        n_recs = biz_counts.get(st, 0) or 1
        key_fields = (ID_FIELDS | ALL_TIME_FIELDS
                      | {"SP_ID", "CONN_CODE", "IMSI_NBR", "BILLING_ORG_NBR", "CALLING_ORG_NBR", "CALLED_ORG_NBR",
                         "SERVICE_NBR", "LOGIN_NAME", "VOLUME_UPLINK", "VOLUME_DOWNLINK", "ORG_CALL_AMOUNT",
                         "COMM_CHARGE", "EXT_CHARGE", "SOURCE_TYPE_ID", "RECORD_TYPE", "RATING_GROUP_ID"})
        for k in sch["order"]:
            m = sch["fmeta"][k]
            fields.append(k)
            vtypes[k] = _infer_vtype(m)
            if k in key_fields:
                common.append(k)
        extra = [k for k in sch["order"]
                 if k not in key_fields and sch["fmeta"][k]["count"] >= n_recs * 0.8]
        common.extend(extra[:12])
        schema_by_type[st] = {"fields": fields, "vtypes": vtypes, "common": common}

    s.schema_by_type = schema_by_type
    s.biz_counts = biz_counts

    # ID 递增基值
    collects = [r["COLLECT_CDR_ID"] for r in records if isinstance(r.get("COLLECT_CDR_ID"), int)]
    seqs = [r["REC_SEQ"] for r in records if isinstance(r.get("REC_SEQ"), int)]
    seq5s = []
    for r in records:
        k = r.get("CDR_KEY")
        if isinstance(k, str) and "_" in k:
            parts = k.split("_")
            if len(parts) >= 6 and parts[4].isdigit():
                seq5s.append(int(parts[4]))
    s._next_collect = (max(collects) if collects else 0) + 1
    s._next_rec_seq = (max(seqs) if seqs else 0) + 1
    s._next_seq5 = (max(seq5s) if seq5s else 0) + 1
    _rebuild_org_used()
    _rebuild_indexes()
    s.revision = 1
    s.last_export_revision = None

    biz_summary = []
    for st in sorted(schema_by_type.keys(), key=lambda x: (x is None, str(x))):
        sch = schema_by_type[st]
        biz_summary.append({
            "source_type_id": st,
            "biz_name": BIZ_TYPE_MAP.get(st, "未知类型"),
            "count": biz_counts.get(st, 0),
            "field_count": len(sch["fields"]),
            "fields": sch["fields"],
            "common_fields": sch["common"],
            "vtypes": {k: _vtype_name(v) for k, v in sch["vtypes"].items()},
        })

    warnings = []
    if stat_ticket is not None and stat_ticket != len(records):
        warnings.append(f"统计行 TICKET_COUNT={stat_ticket} 与实际记录数 {len(records)} 不一致")

    return {
        "filename": filename,
        "total_records": len(records),
        "ticket_count_expected": stat_ticket,
        "ticket_count_actual": len(records),
        "has_cdr_key": any("CDR_KEY" in r for r in records),
        "has_collect_cdr_id": any("COLLECT_CDR_ID" in r for r in records),
        "biz_summary": biz_summary,
        "warnings": warnings,
    }


def get_config():
    return {
        "source_dir": str(SOURCE_DIR),
        "output_dir": str(OUTPUT_DIR),
        "biz_type_map": {str(k): v for k, v in BIZ_TYPE_MAP.items()},
        "default_page_size": 100,
        "max_records": MAX_RECORDS,
        "max_preview": MAX_PREVIEW,
    }


def get_session():
    return {
        "loaded": _session.loaded,
        "filename": _session.filename,
        "total_records": len(_session.records),
        "revision": _session.revision,
        "dirty": _session.loaded and _session.revision != _session.last_export_revision,
        "can_undo": bool(_session.undo_stack),
        "max_records": MAX_RECORDS,
    }


# ---------------------------------------------------------------- 浏览

def get_records(page=1, page_size=100, biz_type=None, filters=None):
    if not _session.loaded:
        raise ValueError("请先加载话单文件")
    try:
        page = max(1, int(page))
        page_size = max(1, min(int(page_size), 500))
    except (TypeError, ValueError) as exc:
        raise ValueError("分页参数必须是整数") from exc
    filters = filters or []
    biz_counts = {str(k): v for k, v in _session.biz_counts.items()}

    def keep(r):
        if biz_type is not None and str(r.get("SOURCE_TYPE_ID")) != str(biz_type):
            return False
        return all(_match(r, flt) for flt in filters)

    # Unfiltered browsing needs only a page slice, not a full scan/index allocation.
    idxs = (range(len(_session.records)) if biz_type is None and not filters
            else [i for i, r in enumerate(_session.records) if keep(r)])
    total = len(idxs)
    pages = max(1, (total + page_size - 1) // page_size)
    page = max(1, min(int(page), pages))
    start = (page - 1) * page_size
    page_idxs = idxs[start:start + page_size]

    bt = None
    if biz_type is not None and str(biz_type) != "":
        try:
            bt = int(biz_type)
        except (ValueError, TypeError):
            bt = None
    if bt is not None and bt in _session.schema_by_type:
        sch = _session.schema_by_type[bt]
        fields, common = sch["fields"], sch["common"]
        biz_name = BIZ_TYPE_MAP.get(bt, "未知")
    else:
        fields, common, seen = [], [], set()
        for st, sch in _session.schema_by_type.items():
            for f in sch["fields"]:
                if f not in seen:
                    seen.add(f)
                    fields.append(f)
            for f in sch["common"]:
                if f not in common:
                    common.append(f)
        biz_name = "全部类型"

    records = [{"idx": i, **{k: v for k, v in _session.records[i].items()}} for i in page_idxs]
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": pages,
        "biz_filter_counts": biz_counts,
        "biz_name": biz_name,
        "fields": fields,
        "common_fields": common,
        "records": records,
    }


def get_record(idx):
    if not _session.loaded or idx < 0 or idx >= len(_session.records):
        raise ValueError("记录不存在")
    return {"idx": idx, "record": dict(_session.records[idx])}


# ---------------------------------------------------------------- 单条修改

def update_record(idx, updates):
    if not _session.loaded or idx < 0 or idx >= len(_session.records):
        raise ValueError("记录不存在")
    if not isinstance(updates, dict):
        raise ValueError("修改字段必须是对象")
    if not updates:
        raise ValueError("至少提供一个修改字段")
    rec = _session.records[idx]
    errors, applied, changes = [], [], []

    metadata_dirty = False
    org_dirty = False
    for field, newval in (updates or {}).items():
        if field not in rec:
            errors.append(f"字段 {field} 不存在于该记录")
            continue
        old = rec.get(field)
        if newval == "" or newval is None:
            if field in ID_FIELDS:
                errors.append(f"{field} 不能置空")
                continue
            rec[field] = None
            changes.append((idx, field, old))
            applied.append(field)
            org_dirty = org_dirty or field == "ORG_CDR_ID"
            continue
        vtype = _field_vtype(rec, field)
        nv = _convert(newval, vtype)
        if nv is None:
            errors.append(f"{field} 类型转换失败（期望 {_vtype_name(vtype)}）")
            continue
        if not validate_time(field, nv):
            errors.append(f"{field} 时间格式错误（14位 YYYYMMDDHHMMSS / ORG 12位+2尾）")
            continue
        if field in UNIQUE_FIELDS and nv != old and nv in _session.indexes[field]:
            errors.append(f"{field} 已存在，违反唯一性")
            continue
        rec[field] = nv
        changes.append((idx, field, old))
        applied.append(field)
        metadata_dirty = metadata_dirty or field == "SOURCE_TYPE_ID"
        org_dirty = org_dirty or field == "ORG_CDR_ID"

    if errors:
        for _, f, old in changes:
            _session.records[idx][f] = old
        return {"ok": False, "errors": errors}

    if changes:
        if metadata_dirty:
            _refresh_schema()
        if org_dirty:
            _rebuild_org_used()
        _push_undo({"type": "update", "changes": changes})
        _mark_changed()
    return {"ok": True, "idx": idx, "applied": applied}


# ---------------------------------------------------------------- 批量修改

def batch_update(filters, updates, dry_run=True):
    if not _session.loaded:
        raise ValueError("请先加载话单文件")
    if filters is not None and not isinstance(filters, list):
        raise ValueError("筛选条件必须是数组")
    if updates is not None and not isinstance(updates, dict):
        raise ValueError("修改字段必须是对象")
    filters = filters or []
    updates = updates or {}
    if not dry_run and not filters:
        raise ValueError("批量修改必须提供筛选条件，避免误改全部记录")
    if not updates:
        raise ValueError("至少提供一个修改字段")
    matched = [i for i, r in enumerate(_session.records) if all(_match(r, flt) for flt in filters)]
    skipped, preview, applied, changes = [], [], [], []

    for i in matched:
        rec = _session.records[i]
        for field, newval in updates.items():
            if field not in rec:
                skipped.append({"idx": i, "field": field, "reason": "该业务类型无此字段"})
                continue
            if field in UNIQUE_FIELDS:
                skipped.append({"idx": i, "field": field, "reason": "ID字段请用单条编辑"})
                continue
            old = rec.get(field)
            vtype = _field_vtype(rec, field)
            nv = _convert(newval, vtype)
            if nv is None:
                skipped.append({"idx": i, "field": field, "reason": "类型转换失败"})
                continue
            if not validate_time(field, nv):
                skipped.append({"idx": i, "field": field, "reason": "时间格式错误"})
                continue
            preview.append({"idx": i, "field": field, "old": old, "new": nv})
            if dry_run:
                continue
            rec[field] = nv
            applied.append({"idx": i, "field": field, "new": nv})
            changes.append((i, field, old))

    if not dry_run and changes:
        if any(field == "SOURCE_TYPE_ID" for _, field, _ in changes):
            _refresh_schema()
        if any(field == "ORG_CDR_ID" for _, field, _ in changes):
            _rebuild_org_used()
        _push_undo({"type": "update", "changes": changes})
        _mark_changed()

    return {
        "matched": len(matched),
        "applied": len(applied),
        "skipped_count": len(skipped),
        "skipped": skipped[:MAX_PREVIEW],
        "preview": preview[:MAX_PREVIEW],
    }


def undo():
    if not _session.undo_stack:
        raise ValueError("没有可撤销的操作")
    op = _session.undo_stack.pop()
    if op["type"] == "update":
        n = 0
        metadata_dirty = False
        org_dirty = False
        for idx, field, old in op["changes"]:
            if 0 <= idx < len(_session.records):
                _session.records[idx][field] = old
                metadata_dirty = metadata_dirty or field == "SOURCE_TYPE_ID"
                org_dirty = org_dirty or field == "ORG_CDR_ID"
                n += 1
        if metadata_dirty:
            _refresh_schema()
        if org_dirty:
            _rebuild_org_used()
        _mark_changed()
        return {"ok": True, "reverted": n, "desc": f"回滚 {n} 处字段修改"}
    if op["type"] == "generate":
        start, count = op["start_idx"], op["count"]
        n = min(count, max(0, len(_session.records) - start))
        if n:
            del _session.records[start:start + n]
            _refresh_schema()
            _rebuild_indexes()
            snapshot = op.get("counter_snapshot")
            if snapshot:
                _session._next_collect, _session._next_rec_seq, _session._next_seq5, org_used = snapshot
                _session._org_used = set(org_used)
            else:
                _rebuild_org_used()
            _session.revision += 1
        return {"ok": True, "reverted": n, "desc": f"删除生成的 {n} 条记录"}
    raise ValueError("未知撤销操作类型")


# ---------------------------------------------------------------- 批量造数

def make_cdr_key(rec, seq5):
    """CDR_KEY 派生：{SWITCH_ID}_0_{ORG_CDR_ID[:12]}_{ORG_CDR_ID后8位去前导零}_{seq5}_00"""
    oid = str(rec.get("ORG_CDR_ID", ""))
    seg4 = oid
    if len(oid) >= 8 and oid[-8:].isdigit():
        seg4 = str(int(oid[-8:]))
    return "{}_{}_{}_{}_00".format(rec.get("SWITCH_ID", 0), 0, oid[:12], seg4, seq5)


def _new_org_cdr_id(rec):
    old = str(rec.get("ORG_CDR_ID", ""))
    if len(old) >= 12:
        prefix, suffix = old[:12], (old[12:] or "00000000")
    else:
        prefix, suffix = datetime.now().strftime("%y%m%d%H%M%S"), "00000000"
    try:
        n = int(suffix) + 1
    except (TypeError, ValueError):
        # 非数字尾缀不能参与数值递增，保留长度并从 1 开始探测。
        n = 1
    guard = 0
    while prefix + str(n).zfill(len(suffix)) in _session._org_used and guard < 100000:
        n += 1
        guard += 1
    candidate = prefix + str(n).zfill(len(suffix))
    _session._org_used.add(candidate)
    return candidate


def _regen_ids(rec, regen):
    if regen.get("collect_cdr_id", True) and "COLLECT_CDR_ID" in rec:
        rec["COLLECT_CDR_ID"] = _session._next_collect
        _session._next_collect += 1
    if regen.get("org_cdr_id", True) and "ORG_CDR_ID" in rec:
        if rec.get("SOURCE_TYPE_ID") == 8 and isinstance(rec.get("COLLECT_CDR_ID"), int):
            candidate = str(rec["COLLECT_CDR_ID"])
            if candidate in _session._org_used:
                rec["ORG_CDR_ID"] = _new_org_cdr_id(rec)
            else:
                rec["ORG_CDR_ID"] = candidate  # OCG 镜像
                _session._org_used.add(candidate)
        else:
            rec["ORG_CDR_ID"] = _new_org_cdr_id(rec)
    if regen.get("rec_seq", True) and "REC_SEQ" in rec:
        rec["REC_SEQ"] = _session._next_rec_seq
        _session._next_rec_seq += 1
    if regen.get("cdr_key", True) and "CDR_KEY" in rec:
        rec["CDR_KEY"] = make_cdr_key(rec, _session._next_seq5)
        _session._next_seq5 += 1
    if regen.get("session_uuid", False):
        for f in ("SESSION_ID", "OCS_SESSION_ID", "MSG_ID"):
            if f in rec:
                rec[f] = str(uuid.uuid4()).replace("-", "")


def _random_phone():
    return "1" + random.choice("3456789") + "".join(str(random.randint(0, 9)) for _ in range(9))


def _shift_time(field, old, seconds):
    if old in (None, ""):
        return old
    s = str(old)
    if field in CJ_TIME_FIELDS and len(s) >= 14 and s[:2] in ("19", "20"):
        try:
            dt = datetime.strptime(s[:14], "%Y%m%d%H%M%S")
            return (dt + timedelta(seconds=int(seconds))).strftime("%Y%m%d%H%M%S") + s[14:]
        except ValueError:
            return old
    if field in ORG_TIME_FIELDS:
        core = s[:12]
        try:
            dt = datetime.strptime(core, "%y%m%d%H%M%S")
            return (dt + timedelta(seconds=int(seconds))).strftime("%y%m%d%H%M%S") + s[12:]
        except ValueError:
            return old
    return old


def _apply_transform(rec, tf):
    field = tf.get("field")
    if not field or field not in rec:
        return
    mode = tf.get("mode")
    params = tf.get("params") or {}
    vtype = _field_vtype(rec, field)
    if mode == "set":
        nv = _convert(params.get("value"), vtype)
        if nv is not None:
            rec[field] = nv
    elif mode == "random_phone":
        rec[field] = _random_phone()
    elif mode == "phone_incr":
        old = rec.get(field)
        if old not in (None, ""):
            try:
                rec[field] = str(int(str(old)) + int(params.get("offset", 1)))
            except ValueError:
                pass
    elif mode == "random_range":
        try:
            rec[field] = random.randint(int(params.get("min", 0)), int(params.get("max", 1000)))
        except ValueError:
            pass
    elif mode == "time_shift":
        rec[field] = _shift_time(field, rec.get(field), params.get("seconds", 0))
    elif mode == "uuid":
        rec[field] = str(uuid.uuid4()).replace("-", "")


def batch_generate(template_idxs, copies_per_template, id_regen=None, transforms=None):
    if not _session.loaded:
        raise ValueError("请先加载话单文件")
    if not template_idxs:
        raise ValueError("未选择模板记录")
    try:
        copies = int(copies_per_template or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError("每模板份数必须是整数") from exc
    if copies < 1 or copies > 10000:
        raise ValueError("每模板份数需在 1~10000")
    id_regen = id_regen or {}
    transforms = transforms or []

    template_idxs = list(dict.fromkeys(int(i) for i in template_idxs))
    generated_count = len(template_idxs) * copies
    if len(_session.records) + generated_count > MAX_RECORDS:
        raise ValueError(f"造数将新增 {generated_count} 条，最终总数超过上限 {MAX_RECORDS}")
    start_idx = len(_session.records)
    generated = []
    counter_snapshot = (_session._next_collect, _session._next_rec_seq, _session._next_seq5, set(_session._org_used))
    try:
        for tpl_idx in template_idxs:
            tpl_idx = int(tpl_idx)
            if tpl_idx < 0 or tpl_idx >= start_idx:
                raise ValueError(f"模板记录 {tpl_idx} 不存在")
            tpl = _session.records[tpl_idx]
            for _ in range(copies):
                rec = deepcopy(tpl)
                _regen_ids(rec, id_regen)
                for tf in transforms:
                    _apply_transform(rec, tf)
                generated.append(rec)

        # 变换规则也可能直接修改 ID；在写入会话前统一检查，避免导出阶段才发现重复。
        seen = {field: set(mapping.keys()) for field, mapping in _session.indexes.items()}
        for rec in generated:
            for field in UNIQUE_FIELDS:
                value = rec.get(field)
                if value in (None, ""):
                    continue
                if value in seen[field]:
                    raise ValueError(f"生成后 {field} 重复，未写入会话")
                seen[field].add(value)
    except Exception:
        _session._next_collect, _session._next_rec_seq, _session._next_seq5, org_used = counter_snapshot
        _session._org_used = org_used
        raise

    _session.records.extend(generated)
    new_idxs = list(range(start_idx, start_idx + len(generated)))
    _refresh_schema()
    _rebuild_indexes()
    _rebuild_org_used()
    _push_undo({"type": "generate", "start_idx": start_idx, "count": len(generated), "counter_snapshot": counter_snapshot})
    _session.revision += 1

    return {
        "generated": len(generated),
        "new_idxs": new_idxs[:MAX_PREVIEW],
        "preview": new_idxs[:5],
    }


# ---------------------------------------------------------------- 导出

def _validate_export(dest):
    errors, count, keys, cids, orgids, time_bad = [], 0, set(), set(), set(), []
    ckey_dup = cid_dup = org_dup = False
    json_readable = True
    expected_ticket = None
    try:
        with open(dest, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError as exc:
                    json_readable = False
                    errors.append(f"回读第 {count + 1} 行 JSON 错误：{exc.msg}")
                    continue
                if not isinstance(obj, dict):
                    json_readable = False
                    errors.append(f"回读第 {count + 1} 行不是对象")
                    continue
                if isinstance(obj, dict) and set(obj.keys()) == {"TICKET_COUNT"}:
                    expected_ticket = obj.get("TICKET_COUNT")
                    continue
                count += 1
                if "CDR_KEY" in obj:
                    k = obj["CDR_KEY"]
                    if k in keys:
                        ckey_dup = True
                    keys.add(k)
                if "COLLECT_CDR_ID" in obj:
                    c = obj["COLLECT_CDR_ID"]
                    if c in cids:
                        cid_dup = True
                    cids.add(c)
                if "ORG_CDR_ID" in obj:
                    oid = obj["ORG_CDR_ID"]
                    if oid not in (None, ""):
                        if oid in orgids:
                            org_dup = True
                        orgids.add(oid)
                for tf in ALL_TIME_FIELDS:
                    if tf in obj and obj[tf] not in (None, "") and not validate_time(tf, obj[tf]):
                        time_bad.append(tf)
    except Exception as e:  # noqa: BLE001
        json_readable = False
        errors.append(f"回读解析失败: {e}")

    count_match = expected_ticket == count
    if expected_ticket is None:
        count_match = False
        errors.append("缺少 TICKET_COUNT 统计行")
    elif not count_match:
        errors.append(f"TICKET_COUNT={expected_ticket} 与记录数 {count} 不一致")

    if ckey_dup:
        errors.append("CDR_KEY 存在重复")
    if cid_dup:
        errors.append("COLLECT_CDR_ID 存在重复")
    if org_dup:
        errors.append("ORG_CDR_ID 存在重复")
    if time_bad:
        errors.append(f"时间字段格式错误: {sorted(set(time_bad))}")

    return {
        "ok": not errors,
        "count_match": count_match,
        "cdr_key_unique": not ckey_dup,
        "collect_cdr_id_unique": not cid_dup,
        "org_cdr_id_unique": not org_dup,
        "time_format_ok": not time_bad,
        "json_readable": json_readable,
        "errors": errors,
    }


def export(out_dir=None, filename=None):
    if not _session.loaded:
        raise ValueError("请先加载话单文件")
    out = Path(out_dir) if out_dir else OUTPUT_DIR
    out.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d%H%M%S")
    name = filename or f"{Path(_session.filename).stem}_mod_{ts}.json"
    dest = (out / name).resolve()
    if dest.parent != out.resolve():
        raise ValueError("导出路径不合法")

    # 先写同目录临时文件，完整校验通过后再原子替换，避免半个导出文件被读取。
    fd, temp_name = tempfile.mkstemp(prefix=f".{name}.", suffix=".tmp", dir=str(out))
    os.close(fd)
    temp_path = Path(temp_name)
    try:
      with open(temp_path, "w", encoding="utf-8", newline="\n") as f:
        for rec in _session.records:
            f.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")
        f.write(json.dumps({"TICKET_COUNT": len(_session.records)}, ensure_ascii=False) + "\n")
      validations = _validate_export(temp_path)
      if not validations["ok"]:
          raise ValueError("导出校验失败：" + "; ".join(validations["errors"]))
      os.replace(temp_path, dest)
    finally:
      if temp_path.exists():
          temp_path.unlink()
    _session.last_export_revision = _session.revision
    return {
        "exported_path": str(dest),
        "filename": name,
        "record_count": len(_session.records),
        "ticket_count": len(_session.records),
        "validations": validations,
    }


def export_history():
    if not OUTPUT_DIR.exists():
        return []
    items = []
    for p in sorted(OUTPUT_DIR.glob("*.json"), reverse=True):
        st = p.stat()
        items.append({
            "name": p.name,
            "size_bytes": st.st_size,
            "size_mb": round(st.st_size / 1048576, 2),
            "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        })
    return items[:50]


# ---------------------------------------------------------------- 操作日志

def log_op(action, params=None, affected=None):
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        path = LOG_DIR / f"oplog-{datetime.now():%Y%m%d}.jsonl"
        entry = {
            "ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "action": action,
            "params": params or {},
            "affected": affected,
        }
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass
