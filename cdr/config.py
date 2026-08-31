# -*- coding: utf-8 -*-
"""话单功能模块 - 配置

集中管理 cdr 模块的路径与常量，与 Node 端 config.js 保持口径一致：
  - 端口由环境变量 CDR_PORT 透传（对应 config.js 的 config.cdr.port）
  - 话单源目录 / 输出目录 / 日志目录在此统一定义
"""
import os
from pathlib import Path

CDR_DIR = Path(__file__).resolve().parent
WORKBENCH_DIR = CDR_DIR.parent                 # server-workbench/
PROJECT_ROOT = WORKBENCH_DIR.parent            # 项目根（计费系统/）

# 话单源目录（只读）：项目根下的 数据/话单文件
SOURCE_DIR = Path(os.environ.get("CDR_SOURCE_DIR", PROJECT_ROOT / "数据" / "话单文件")).expanduser().resolve()
# 导出输出目录
OUTPUT_DIR = Path(os.environ.get("CDR_OUTPUT_DIR", PROJECT_ROOT / "outputs" / "cdr_tool")).expanduser().resolve()
# 操作日志目录
LOG_DIR = Path(os.environ.get("CDR_LOG_DIR", CDR_DIR / "data" / "logs")).expanduser().resolve()

# 服务端口（由 start.bat 通过环境变量 CDR_PORT 注入，与 config.js 的 config.cdr.port 一致）
PORT = int(os.environ.get("CDR_PORT", "8000"))

# 内存模型预算。10 万条以内的全量筛选实测可保持毫秒级响应，不引入 SQLite。
MAX_RECORDS = int(os.environ.get("CDR_MAX_RECORDS", "100000"))
UNDO_MAX_CHANGES = int(os.environ.get("CDR_UNDO_MAX_CHANGES", "200000"))
UNDO_DEPTH = int(os.environ.get("CDR_UNDO_DEPTH", "50"))
MAX_PREVIEW = int(os.environ.get("CDR_MAX_PREVIEW", "200"))
