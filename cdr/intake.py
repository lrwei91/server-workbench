# -*- coding: utf-8 -*-
"""Local preparation of an iDIS test intake batch. No remote I/O."""
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

import engine

SUFFIXES = {".json", ".txt", ".dat"}
PERIOD_FIELDS = ("CJ_START_TIME", "ORG_START_TIME", "ONLINE_TIME")
INPUT_DIR = "prep/normal/input/591/"
FILE_LIMIT = 10
LINE_LIMIT = 4 * 1024 * 1024


def _file(root, name):
    if Path(name).name != name or any(c in name for c in "/\\:") or Path(name).suffix.lower() not in SUFFIXES:
        raise ValueError("请选择源目录或导出目录中的 .json / .txt / .dat 文件")
    path = root / name
    if path.resolve().parent != root.resolve() or not path.is_file():
        raise ValueError(f"文件不存在或不在所选目录：{name}")
    return path


def list_files(source_dir, output_dir):
    result = {}
    for scope, root in (("source", source_dir), ("export", output_dir)):
        result[scope] = [
            {"name": p.name, "size_bytes": p.stat().st_size}
            for p in sorted(root.iterdir()) if p.suffix.lower() in SUFFIXES
            and p.resolve().parent == root.resolve() and p.is_file()
        ] if root.is_dir() else []
    return result


def _reject_constant(value):
    raise ValueError(f"非标准 JSON 数值 {value}")


def _record_month(field, value):
    value = str(value)
    if field == "CJ_START_TIME":
        if not re.fullmatch(r"[0-9]{14}", value):
            raise ValueError
        core = value
    else:
        if not re.fullmatch(r"[0-9]{12}(?:[0-9]{2})?", value):
            raise ValueError
        core = "20" + value[:12]
    datetime.strptime(core, "%Y%m%d%H%M%S")
    return core[:6]


def _copy_checked(source, dest, period, period_field, seen, remaining):
    ids, count, size, footer = [], 0, 0, None
    digest = hashlib.sha256()
    with source.open("rb") as inp, dest.open("xb") as out:
        line_no = 0
        while (raw := inp.readline(LINE_LIMIT + 1)):
            line_no += 1
            try:
                if footer is not None:
                    raise ValueError("TICKET_COUNT 必须单独放在最后一行")
                if len(raw) > LINE_LIMIT:
                    raise ValueError("单行超过 4 MiB")
                if b"\r" in raw or raw.startswith(b"\xef\xbb\xbf"):
                    raise ValueError("要求 UTF-8 无 BOM、LF 换行")
                try:
                    obj = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
                except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
                    raise ValueError("不是有效的 UTF-8 JSON") from exc
                if not isinstance(obj, dict):
                    raise ValueError("每行必须为一个 JSON 对象")
                if set(obj) == {"TICKET_COUNT"}:
                    footer = obj["TICKET_COUNT"]
                    if type(footer) is not int or footer != count or count == 0:
                        raise ValueError(f"文件尾 TICKET_COUNT 必须等于实际非零记录数（当前 {count}）")
                else:
                    if "TICKET_COUNT" in obj:
                        raise ValueError("TICKET_COUNT 必须单独占一行")
                    count += 1
                    if count > remaining:
                        raise ValueError(f"批次总记录数超过 {engine.MAX_RECORDS}")
                    cid = str(obj.get("COLLECT_CDR_ID", ""))
                    if not re.fullmatch(r"[0-9]{19}", cid):
                        raise ValueError("COLLECT_CDR_ID 必须为 19 位数字")
                    if cid in seen:
                        first_file, first_line = seen[cid]
                        raise ValueError(f"COLLECT_CDR_ID 重复，首次出现于 {first_file} 第 {first_line} 行")
                    org_id = obj.get("ORG_CDR_ID")
                    if type(org_id) not in (str, int) or len(str(org_id)) != 20 or any(c.isspace() for c in str(org_id)):
                        raise ValueError("ORG_CDR_ID 必须为 20 位")
                    try:
                        month = _record_month(period_field, obj.get(period_field))
                    except ValueError as exc:
                        raise ValueError(f"{period_field} 缺失或时间格式错误") from exc
                    if month != period:
                        raise ValueError(f"{period_field} 的月份 {month} 与目标账期 {period} 不一致")
                    seen[cid] = (source.name, line_no)
                    ids.append(cid)
                if not raw.endswith(b"\n"):  # 接受没有结尾换行的文件尾，投递副本统一补 LF。
                    raw += b"\n"
                out.write(raw)
                digest.update(raw)
                size += len(raw)
            except ValueError as exc:
                raise ValueError(f"{source.name} 第 {line_no} 行：{exc}") from exc
    if footer is None:
        raise ValueError(f"{source.name}：缺少 TICKET_COUNT 文件尾")
    return {"source_name": source.name, "name": dest.name, "record_count": count,
            "size_bytes": size, "sha256": digest.hexdigest(), "collect_cdr_ids": ids}


def _write_guides(folder, manifest):
    batch_id = manifest["batch_id"]
    files = manifest["files"]
    names = " ".join(f["name"] for f in files)
    (folder / "SHA256SUMS").write_text(
        "".join(f"{f['sha256']}  data/{f['name']}\n" for f in files), encoding="utf-8", newline="\n")
    # 仅生成待操作人运行的脚本。参数为已确认的 HDFS 暂存父目录；
    # 不覆盖同名、不清理、不自动重试。脚本从 SSH 主机上的包目录运行。
    (folder / "submit.sh").write_text(f"""#!/usr/bin/env bash
set -euo pipefail
parent=${{1:?请传入已确认可写、位于采预扫描目录之外的 HDFS 暂存父目录}}
cd -- "$(dirname -- "$0")"
sha256sum -c SHA256SUMS
target='{INPUT_DIR}'
stage="${{parent%/}}/{batch_id}"
files=({names})
local_files=()
staged_files=()
for name in "${{files[@]}}"; do
  local_files+=("data/$name")
  staged_files+=("$stage/$name")
done
printf 'HDFS 暂存：%s\\n采预入口：%s\\n' "$stage" "$target"
hadoop fs -test -d "$target"
hadoop fs -mkdir "$stage"
hadoop fs -put "${{local_files[@]}}" "$stage/"
hadoop fs -ls "$stage/"
hadoop fs -mv "${{staged_files[@]}}" "$target"
hadoop fs -ls "$target"
""", encoding="utf-8", newline="\n")
    ids = [cid for f in files for cid in f["collect_cdr_ids"]]
    with (folder / "verify.sql").open("w", encoding="utf-8", newline="\n") as out:
        out.write("-- 先从路由配置及入库日志确认实际表名；替换 __ACTUAL_DORIS_TABLE__（含库名）。\n"
                  "-- 涉及多张表时分别查询，按本次 ID 汇总，并核对是否重复或遗漏。\n")
        for start in range(0, len(ids), 500):
            values = ", ".join(f"'{cid}'" for cid in ids[start:start + 500])
            out.write("SELECT COLLECT_CDR_ID, TICKET_TYPE, ERROR_TYPE, CHARGE\n"
                      f"FROM __ACTUAL_DORIS_TABLE__\nWHERE COLLECT_CDR_ID IN ({values});\n\n")
    (folder / "核验说明.md").write_text(f"""# 批量话单入库核验

- 本地批次：`{batch_id}`，{manifest['file_count']} 个文件，{manifest['record_count']} 条话单。
- 账期：{manifest['period']}（核对字段 `{manifest['period_field']}`）；采预入口：`{INPUT_DIR}`。
- 当前状态：仅完成本地准备，尚未投递。

## 投递前

确认 SSH 跳板能运行 Hadoop、HDFS 暂存父目录和 591 入口可写、采预/批价/入库进程有近期日志。
按路由确认目标 Doris 表及账期已存在，并核对号码白名单、COLLECT_CDR_ID 未在环境中使用过。
591 是采预扫描目录，**不是** Doris 表本地网的推导依据。

## 投递和对账

1. 将本批次包上传到测试环境执行 Hadoop 命令的主机；只有 `data/` 内的清单文件会进入 HDFS。
   在 SSH 主机执行 `bash submit.sh <已确认位于扫描目录外的HDFS暂存父目录>`。
   脚本校验 SHA-256，全部 put 到独立暂存目录后，调用一次 mv，再 ls 入口。
   多文件 mv 不是事务；如失败或 ls 时文件已被采预取走，先按清单逐个核对暂存、入口与采预记录，勿盲目重投。
2. 在采预日志找 `createNewBatch scan path finished` 和实际批次号，查
   `get 'ns_bill_cnos_jf_test:preproc_batch_major_info','<实际批次号>'`。
   核对 status/pre_status=105、rcv_files 与文件数一致、rcv_tickets=output_tickets=投递条数，六出口计数之和等于 output_tickets。
   无主表结果时查同命名空间的 pro_preproc_batch_major_info；102/103/104 为在途，110 核对 errstyle/errdetail，重名查 overLoad。
3. 批价核对 status=105，正常+异常等于收件数；异常另查 ERROR_TYPE，排队时查 chargeOutput。
4. 核对 `idis-test-rating-ticket2pg-process-0` Stream Load 日志的实际表名、总记录数和成功数。
   将 `verify.sql` 替换为日志和路由确认的表名后执行 SELECT。按 ID 比对清单，只有日志成功数和实际落表均与投递条数对上才算通过。
   成功数为 0 时先核对目标账期表及列约束，不以日志无 ERROR 判定通过。
5. 将入口清单、采预主表、Stream Load 日志、Doris 查询结果截图放入 `shots/`，结果 JSON 留在批次根目录。

测试环境不做删除；DDL、重启另行申请。
""", encoding="utf-8", newline="\n")


def prepare(files, period, period_field, source_dir, output_dir):
    if not re.fullmatch(r"20[0-9]{2}(?:0[1-9]|1[0-2])", period) or period_field not in PERIOD_FIELDS:
        raise ValueError("请输入有效的 YYYYMM 账期并选择账期核对字段")
    if not 1 <= len(files) <= FILE_LIMIT:
        raise ValueError("单批请选择 1–10 个文件")
    roots = {"source": source_dir, "export": output_dir}
    sources = [_file(roots[scope], name) for scope, name in files]
    if len({p.resolve() for p in sources}) != len(sources):
        raise ValueError("同一个文件只可选择一次")

    now = datetime.now(engine.CN_TZ)
    stamp = now.strftime("%Y%m%d%H%M%S")
    batch_id = f"cdr_{uuid4().hex}_{stamp}"
    output = output_dir / "intake"
    output.mkdir(parents=True, exist_ok=True)
    final = output / batch_id
    seen, entries = {}, []
    with TemporaryDirectory(prefix=".prepare-", dir=output) as temp:
        folder = Path(temp) / batch_id
        (folder / "data").mkdir(parents=True)
        (folder / "shots").mkdir()
        for i, path in enumerate(sources, 1):
            dest = folder / "data" / f"{batch_id}_{i:02d}{path.suffix.lower()}"
            entries.append(_copy_checked(path, dest, period, period_field, seen, engine.MAX_RECORDS - len(seen)))
        manifest = {"batch_id": batch_id, "created_at": now.isoformat(), "status": "prepared",
                    "period": period, "period_field": period_field, "input_dir": INPUT_DIR,
                    "file_count": len(entries), "record_count": len(seen), "files": entries}
        (folder / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                                              encoding="utf-8", newline="\n")
        _write_guides(folder, manifest)
        folder.rename(final)
    return {**manifest, "output_path": str(final), "files": [
        {k: v for k, v in entry.items() if k != "collect_cdr_ids"} for entry in entries]}
