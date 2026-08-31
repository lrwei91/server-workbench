# Server Workbench

面向测试人员的 Windows 优先本地工具工作台，集中处理 SSH 命令、SFTP 文件、HDFS 浏览、执行日志和 CDR 话单。当前交付重点是 PC 端；移动端专用布局、深色模式和运行时迁移不在范围内。

## 快速开始

1. 安装 Node.js 18+、Python 3.10+，在项目根目录运行：

   ```powershell
   npm install
   python -m pip install -r .\cdr\requirements.txt
   ```

2. 复制 `config.example.js` 为根目录 `config.js`，填写 SSH 主机、用户名和密码。`config.js` 已被 `.gitignore` 排除，不要提交真实凭据。
3. Windows 双击 `start.bat`，或分别运行 `python .\cdr\server.py` 和 `node .\server\server.js`。
4. 浏览器打开 <http://127.0.0.1:17755>。

启动入口从 PATH 查找 Node/Python，不依赖个人绝对路径。缺少 `config.js` 时服务仍可启动，但会在连接时提示配置问题。

## 功能与安全边界

- 主工作台采用纯白工具主题：黑墨层级、荧光黄主操作/选中、独立成功/警告/错误色；固定浅色，PC 视口支持 1024–1920 宽度和浏览器缩放。
- 文件浏览使用结构化 SFTP 接口：目录列表、预览、新建文件/目录、删除文件或空目录、下载。删除需要二次确认，根路径受保护。
- HDFS 浏览只读，路径使用单引号 shell 转义；高级自由命令仍保留在 `/api/exec`，删除类命令需要确认，根目录递归强删会被拦截。
- 命令输出默认限制 2 MiB，日志异步排队写入并分页读取，页面默认最多挂载 200 条；隐藏页面暂停状态检查和自动刷新，单个刷新请求不会重入。
- 自定义密码只存在当前页面内存；浏览器仅保存主机、端口和用户名。
- CDR 源 NDJSON 只读，修改留在内存；支持版本冲突检测、10 万条记录上限、批量预览/应用一致性、O(1) ID 索引和原子导出校验。

## 目录

```text
server-workbench/
├─ start.bat                 # Windows 启动入口（PATH 查找运行时）
├─ config.example.js         # 无凭据配置样例
├─ package.json / lock        # 可复现 Node 依赖和质量门禁
├─ shared/                   # 共享令牌、图标精灵、请求/DOM/对话框工具
├─ public/                   # PC 主工作台（原生 ES Modules）
├─ server/                   # Node HTTP、SSH、SFTP、HDFS、日志、CDR 代理
├─ cdr/                      # FastAPI + 内存 CDR 引擎与前端
└─ tests/                    # Node builtin test、Python unittest、fixture
```

## 质量检查

```powershell
npm run check
npm run test:node
npm run test:python
git diff --check
```

测试不需要真实 SSH/SFTP/HDFS 或凭据；真实远端链路需在本机准备 `config.js` 和 `ssh2` 后另行 smoke。项目不在本次任务中提交、推送或部署。

更多说明见 [overview.md](./overview.md) 和 [cdr/README.md](./cdr/README.md)。
