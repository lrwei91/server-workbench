# -*- coding: utf-8 -*-
"""CDR FastAPI 服务：输入校验、会话版本和统一错误响应。"""
import json
from pathlib import Path
from typing import Any, List, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

import engine

STATIC_DIR = Path(__file__).resolve().parent / "static"
SHARED_DIR = Path(__file__).resolve().parent.parent / "shared"
app = FastAPI(title="话单文件数据调整工具", docs_url=None, redoc_url=None)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LoadReq(StrictModel):
    filename: str = Field(min_length=1, max_length=255)


class UpdateReq(StrictModel):
    updates: dict[str, Any] = Field(default_factory=dict)
    expected_revision: Optional[int] = Field(default=None, ge=0)


class BatchUpdateReq(StrictModel):
    filters: List[dict[str, Any]] = Field(default_factory=list)
    updates: dict[str, Any] = Field(default_factory=dict)
    dry_run: bool = True
    expected_revision: Optional[int] = Field(default=None, ge=0)


class GenerateReq(StrictModel):
    template_idxs: List[int] = Field(min_length=1, max_length=10000)
    copies_per_template: int = Field(default=1, ge=1, le=10000)
    id_regen: dict[str, bool] = Field(default_factory=dict)
    transforms: List[dict[str, Any]] = Field(default_factory=list)
    expected_revision: Optional[int] = Field(default=None, ge=0)


class ExportReq(StrictModel):
    out_dir: Optional[str] = Field(default=None, max_length=1024)
    filename: Optional[str] = Field(default=None, max_length=255)
    expected_revision: Optional[int] = Field(default=None, ge=0)


class RevisionConflict(Exception):
    def __init__(self, expected, actual): self.expected, self.actual = expected, actual


def _run(fn, *args, **kwargs):
    try:
        with engine._lock:
            return fn(*args, **kwargs)
    except RevisionConflict:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"code": "INVALID_INPUT", "message": str(exc), "retryable": False}) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "message": str(exc), "retryable": False}) from exc
    except Exception as exc:  # noqa: BLE001
        # 对外不泄露路径、堆栈或底层凭据；日志由启动器处理。
        raise HTTPException(status_code=500, detail={"code": "INTERNAL_ERROR", "message": "服务内部错误，请稍后重试", "retryable": True}) from exc


def _check_revision(expected):
    if expected is not None and expected != engine._session.revision:
        raise RevisionConflict(expected, engine._session.revision)


def _log(action, params, affected=None):
    try: engine.log_op(action, params, affected)
    except Exception: pass


@app.get("/", include_in_schema=False)
def index(): return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/config")
def api_config(): return _run(engine.get_config)


@app.get("/api/session")
def api_session(): return _run(engine.get_session)


@app.get("/api/files")
def api_files(): return _run(lambda: {"files": engine.list_files()})


@app.post("/api/load")
def api_load(req: LoadReq):
    result = _run(engine.load_file, req.filename); _log("load", {"filename": req.filename}, result.get("total_records")); return result


@app.get("/api/records")
def api_records(page: int = 1, page_size: int = 100, biz_type: Optional[str] = None, filters: Optional[str] = None):
    if page < 1 or page_size < 1 or page_size > 500: raise HTTPException(status_code=400, detail={"code": "INVALID_INPUT", "message": "分页参数范围错误", "retryable": False})
    parsed = []
    if filters:
        try:
            parsed = json.loads(filters)
            if not isinstance(parsed, list) or any(not isinstance(item, dict) for item in parsed): raise ValueError
        except (json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail={"code": "INVALID_FILTERS", "message": "filters 参数格式错误", "retryable": False}) from exc
    return _run(engine.get_records, page, page_size, biz_type, parsed)


@app.get("/api/record/{idx}")
def api_record_get(idx: int): return _run(engine.get_record, idx)


@app.post("/api/record/{idx}")
def api_record_update(idx: int, req: UpdateReq):
    with engine._lock:
        _check_revision(req.expected_revision)
        result = _run(engine.update_record, idx, req.updates)
    if result.get("ok"): _log("update_record", {"idx": idx, "fields": list(req.updates)}, result.get("applied"))
    return result


@app.post("/api/batch-update")
def api_batch_update(req: BatchUpdateReq):
    with engine._lock:
        # 预览也绑定当前 revision，避免用户在预览后悄悄换入另一份会话数据。
        _check_revision(req.expected_revision)
        result = _run(engine.batch_update, req.filters, req.updates, req.dry_run)
    if not req.dry_run and result.get("applied"): _log("batch_update", {"filters": req.filters, "updates": req.updates}, result.get("applied"))
    return result


@app.post("/api/undo")
def api_undo(expected_revision: Optional[int] = Query(default=None, ge=0)):
    with engine._lock:
        _check_revision(expected_revision); result = _run(engine.undo)
    _log("undo", {}, result.get("reverted")); return result


@app.post("/api/batch-generate")
def api_batch_generate(req: GenerateReq):
    with engine._lock:
        _check_revision(req.expected_revision); result = _run(engine.batch_generate, req.template_idxs, req.copies_per_template, req.id_regen, req.transforms)
    _log("batch_generate", {"templates": len(req.template_idxs), "copies": req.copies_per_template, "transforms": req.transforms}, result.get("generated")); return result


@app.post("/api/export")
def api_export(req: ExportReq):
    with engine._lock:
        _check_revision(req.expected_revision); result = _run(engine.export, req.out_dir, req.filename)
    _log("export", {"out_dir": req.out_dir, "filename": req.filename}, result.get("record_count")); return result


@app.get("/api/export-history")
def api_export_history(): return _run(lambda: {"items": engine.export_history()})


@app.post("/api/reset")
def api_reset(expected_revision: Optional[int] = Query(default=None, ge=0)):
    with engine._lock:
        _check_revision(expected_revision); engine._session.reset()
    _log("reset", {}); return {"ok": True}


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
if SHARED_DIR.exists(): app.mount("/shared", StaticFiles(directory=str(SHARED_DIR)), name="shared")


@app.exception_handler(RevisionConflict)
async def revision_conflict_handler(_: Request, exc: RevisionConflict):
    return JSONResponse(status_code=409, content={"ok": False, "error": {"code": "REVISION_CONFLICT", "message": "会话已被其他操作更新，请刷新后重试", "retryable": True, "details": {"expected": exc.expected, "actual": exc.actual}}})


@app.exception_handler(HTTPException)
async def http_exc_handler(_: Request, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else {"code": "HTTP_ERROR", "message": str(exc.detail), "retryable": exc.status_code >= 500}
    detail.setdefault("retryable", exc.status_code >= 500)
    return JSONResponse(status_code=exc.status_code, content={"ok": False, "error": detail})


@app.exception_handler(RequestValidationError)
async def validation_handler(_: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422, content={"ok": False, "error": {"code": "VALIDATION_ERROR", "message": "请求字段校验失败", "retryable": False, "details": exc.errors()}})
