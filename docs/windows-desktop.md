# Windows 桌面版与 GitHub 更新

## 交付范围

- Windows 10/11 x64；Electron 窗口 + 独立 Node 服务 + PyInstaller onedir CDR 服务。
- 目标机器无需安装 Node/Python。现有 `start.bat` / 浏览器开发方式保留。
- 安装包使用 NSIS，默认按用户安装；自动更新来自 `lrwei91/server-workbench` 的公开 GitHub Releases。
- 首版不包含新版启动失败自动回退；问题版本采用更高版本号修复发布。

## 开发与构建

推荐构建环境：Windows x64、Node 22、Python 3.12。

```powershell
npm ci
python -m venv .venv-desktop
.\.venv-desktop\Scripts\python.exe -m pip install -r desktop/requirements-build.txt -r cdr/requirements-dev.txt
$env:WORKBENCH_PYTHON = "$PWD\.venv-desktop\Scripts\python.exe"
npm run desktop:start

$env:WORKBENCH_BUILD_PYTHON = "$PWD\.venv-desktop\Scripts\python.exe"
npm test
npm run desktop:dist
```

`desktop:pack` 生成免安装测试目录；`desktop:dist` 生成 `dist/Server-Workbench-<version>-x64-Setup.exe`、blockmap 和 `latest.yml`。这些命令使用 `--publish never`，不上传远端。

Python 依赖按现有 CDR requirements 安装；构建工具版本固定，CDR 业务依赖仍沿用项目当前的非锁定策略。正式发布请保留 CI 构建日志。

桌面包排除 ssh2 的可选 CPU 探测/原生加密加速模块，使用其内置 JS/WASM 实现，不依赖目标机编译工具链。后续新增必需 native 依赖时需重新评估 Electron ABI 重建策略。

## 用户配置与数据

安装版通过 Electron `app.getPath('userData')` 获取目录，通常为 `%APPDATA%/server-workbench`；菜单「打开配置与日志目录」显示实际位置。开发版使用 `%APPDATA%/Server Workbench Dev`，与正式版分离。

首次启动仅复制 `.env.example`，不自动导入源码目录的 `.env/config.js`，避免把个人凭据带入安装包。

- `.env`：菜单编辑连接配置，重启生效；沿用已有字段。
- `desktop.json`：自动检查偏好、用户选择的源目录和首次分配的 Node 端口。
- `source/`：默认话单源目录；菜单可选择外部目录，源文件仍只读。
- `outputs/`：默认导出目录；`.env` 的 `CDR_OUTPUT_DIR` 可指定其他目录。
- `logs/`：Node、DCOS、CDR 和桌面日志。
- Chromium 持久会话：收藏/localStorage 保留。Node 端口首次随机分配后持久化，避免换 origin 丢失收藏。端口被占用时启动报错，不连接其他进程；检查 `desktop.json` 和占用进程，变更端口会改变收藏存储 origin。

升级不覆盖用户配置、源文件和日志；卸载也保留用户数据。旧浏览器版收藏不会自动迁移到桌面版。

## 运行与退出

主进程先启动 CDR，带随机会话令牌确认就绪，再启动 Node 服务及窗口。服务仅监听环回地址，Node/CDR 分别校验随机令牌，renderer 不取得令牌；桌面窗口关闭 Node 集成，开启 sandbox/contextIsolation，限制导航、权限与 CSP。

普通退出与更新安装前都检查 `/cdr/api/session` 的 `dirty`：取消可返回导出，确认继续会丢弃内存会话。状态读取失败也提示确认。普通退出不会偷偷安装已下载更新。

关闭时通知 Node 清理连接并终止 CDR；有超时兜底。进程崩溃时展示日志路径。仍需在目标设备验证强制结束、断电等异常场景。

## 更新与发布

启动 30 秒后检查，此后每 24 小时检查；菜单可以关闭自动检查或手动检查。发现新版后显示版本与说明，确认下载，下载完成再确认安装；任务栏显示进度。开发模式禁用更新。

安装与校验由 `electron-updater` 6.x 完成。构建配置保留 Windows 更新签名验证；正式分发建议设置一致的 Authenticode 签名证书。未签名测试包可能出现 SmartScreen 提示，不应把本地构建成功视为签名验收。

`.github/workflows/windows-release.yml`：

1. 手动运行：测试、构建、上传 Actions artifact，不创建 Release。
2. 推送 `v<package.json版本>` tag：同样构建，创建/更新 draft Release，上传 exe、blockmap、latest.yml。
3. 下载 draft 安装包验收后，人工将 draft 发布。draft 不作为客户端可用更新。

版本和 tag 必须一致；更新文件必须出自同一次构建。不要覆盖已经公开的同版本资产。发布 Token 仅由 CI 注入，安装包不携带 Token。

Actions 签名 secrets：`WINDOWS_CSC_LINK`（证书链接或 base64 PFX）、`WINDOWS_CSC_KEY_PASSWORD`。不填可构建未签名测试包；证书从未纳入本仓库。

客户端要求更新仓库公开且可访问；若将来使用私有仓库，应另行设计分发服务，不在客户端内置 PAT。

## 发布前验收

- 干净 Windows，无 Node/Python：安装、启动、CDR 文件浏览/加载/导出。
- 1366×768 检查主工作台与话单页；缩放和目录选择可操作。
- 修改话单后关闭窗口/安装更新：取消保留会话，确认前可先导出。
- 退出后无残留 Node/CDR 进程；重开配置与收藏仍在。
- 从已安装旧版升级到公开新版：下载校验、安装重启、配置保留。
- 断网、GitHub 不可达、端口占用、下载失败：错误提示且原版本继续可用。
- 审查安装包内容，无真实 `.env`、`config.js`、日志、源话单、导出和发布 Token。

本地 smoke：设置 `WORKBENCH_DESKTOP_SMOKE=1` 后启动，会捕获页面到用户数据目录 `smoke/workbench.png`、记录 `SMOKE_READY` 并自动退出；仅用于验证启动链，非完整升级验收。
