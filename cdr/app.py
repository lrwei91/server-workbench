# -*- coding: utf-8 -*-
"""话单文件数据调整工具 - FastAPI 入口与路由"""
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from typing import List, Optional, Any

import engine

STATIC_DIR = Path(__file__).resolve().parent / "static"

app = FastAPI(title="话单文件数据调整工具", docs_url=None, redoc_url=None)


# ---------------------------------------------------------------- 请求模型

class LoadReq(BaseModel):
    filename: str


class UpdateReq(BaseModel):
    updates: dict


class BatchUpdateReq(BaseModel):
    filters: List[dict] = Field(default_factory=list)
    updates: dict = Field(default_factory=dict)
    dry_run: bool = True


class GenerateReq(BaseModel):
    template_idxs: List[int]
    copies_per_template: int = 1
    id_regen: dict = Field(default_factory=dict)
    transforms: List[dict] = Field(default_factory=list)


class ExportReq(BaseModel):
    out_dir: Optional[str] = None
    filename: Optional[str] = None


# ---------------------------------------------------------------- 工具

def _run(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"内部错误: {e}") from e


def _log(action, params, affected=None):
    try:
        engine.log_op(action, params, affected)
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- 页面与静态资源

@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


# ---------------------------------------------------------------- API

@app.get("/api/config")
def api_config():
    return engine.get_config()


@app.get("/api/files")
def api_files():
    return {"files": engine.list_files()}


@app.post("/api/load")
def api_load(req: LoadReq):
    result = _run(engine.load_file, req.filename)
    _log("load", {"filename": req.filename}, result.get("total_records"))
    return result


@app.get("/api/records")
def api_records(page: int = 1, page_size: int = 100, biz_type: Optional[str] = None, filters: Optional[str] = None):
    parsed = []
    if filters:
        try:
            parsed = json.loads(filters)
            assert isinstance(parsed, list)
        except (json.JSONDecodeError, AssertionError) as e:
            raise HTTPException(status_code=400, detail="filters 参数格式错误") from e
    return _run(engine.get_records, page, min(page_size, 500), biz_type, parsed)


@app.get("/api/record/{idx}")
def api_record_get(idx: int):
    return _run(engine.get_record, idx)


@app.post("/api/record/{idx}")
def api_record_update(idx: int, req: UpdateReq):
    result = _run(engine.update_record, idx, req.updates)
    if result.get("ok"):
        _log("update_record", {"idx": idx, "fields": list(req.updates.keys())})
    return result


@app.post("/api/batch-update")
def api_batch_update(req: BatchUpdateReq):
    result = _run(engine.batch_update, req.filters, req.updates, req.dry_run)
    if not req.dry_run:
        _log("batch_update", {"filters": req.filters, "updates": req.updates}, result.get("applied"))
    return result


@app.post("/api/undo")
def api_undo():
    result = _run(engine.undo)
    _log("undo", {}, result.get("reverted"))
    return result


@app.post("/api/batch-generate")
def api_batch_generate(req: GenerateReq):
    result = _run(engine.batch_generate, req.template_idxs, req.copies_per_template, req.id_regen, req.transforms)
    _log("batch_generate",
         {"templates": len(req.template_idxs), "copies": req.copies_per_template, "transforms": req.transforms},
         result.get("generated"))
    return result


@app.post("/api/export")
def api_export(req: ExportReq):
    result = _run(engine.export, req.out_dir, req.filename)
    _log("export", {"out_dir": req.out_dir, "filename": req.filename}, result.get("record_count"))
    return result


@app.get("/api/export-history")
def api_export_history():
    return {"items": engine.export_history()}


@app.post("/api/reset")
def api_reset():
    engine._session.reset()
    _log("reset", {})
    return {"ok": True}


# 静态资源挂载（放在 API 之后，避免吞掉路由）
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.exception_handler(HTTPException)
def http_exc_handler(_, exc):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})
