# -*- coding: utf-8 -*-
"""话单功能模块 - 服务入口

作为远程服务器管理工作台的 cdr 内聚功能模块运行，由工作台 start.bat 拉起，
不再作为独立工具（不自动开浏览器、不自动顺延端口）。

端口由环境变量 CDR_PORT 指定（与工作台 config.js 的 config.cdr.port 保持一致），
默认 8000。工作台通过 Node 反向代理 /cdr/ 同源嵌入本服务的前端页面。
"""
import os

import uvicorn

from config import PORT


def main():
    # 端口优先取环境变量 CDR_PORT（start.bat 注入，与 config.js 的 config.cdr.port 一致）
    port = int(os.environ.get("CDR_PORT", PORT))
    import app  # noqa: F401  确保 app 模块被加载
    uvicorn.run(app.app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
