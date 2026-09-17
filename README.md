# Server Workbench

面向测试人员的 Windows 优先本地工具工作台，集中处理 SSH/SFTP 文件、HDFS、HBase、数据库档案查询和 CDR 话单。当前交付重点是 PC 端；移动端专用布局、深色模式和运行时迁移不在范围内。

## 快速开始

1. 安装 Node.js 18+、Python 3.10+，在项目根目录运行（Node 依赖包含 `ssh2`、`mysql2` 与 `iconv-lite`）：

   ```powershell
   npm install
   python -m pip install -r .\cdr\requirements.txt
   ```

2. 复制 `.env.example` 为根目录 `.env`，填写 SSH、MySQL/UDAL、Doris、工程环境 Voyage Token 及按需使用的内存档案服务连接信息。`.env` 已被 `.gitignore` 排除，不要提交真实凭据。
3. Windows 双击 `start.bat`，或分别运行 `python .\cdr\server.py` 和 `node .\server\server.js`。
4. 浏览器打开 <http://127.0.0.1:17755>。

启动入口从 PATH 查找 Node/Python，不依赖个人绝对路径。缺少 `.env` 或关键连接项时服务仍可启动，并在连接列表中显示配置状态。

## 功能与安全边界

- 主工作台采用纯白工具主题：左侧浏览服务器资源，右侧执行固定只读数据库查询，桌面双栏比例为 1:1.5；固定浅色，PC 视口支持 1024–1920 宽度和浏览器缩放。
- 文件浏览使用结构化 SFTP 接口：目录列表、预览、新建文件/目录、删除文件或空目录、下载。删除需要二次确认，根路径受保护。
- 服务器文件、HDFS 和 HBase 列表支持基于已加载结果的名称/路径/中文备注搜索与排序；常用目录和 HBase 表可收藏到当前浏览器。
- HDFS 浏览只读，文件内容在预览窗口显示；HBase 表查看支持 20/50/100/200 行样本、当前样本内查找和原始结果复制。高级自由命令与日志接口为兼容目的保留在后端，主界面不再提供入口。
- 「查询手机号」和「实例查档案」可选择测试环境 MySQL/UDAL 或工程环境 Voyage，分别以号码或产品实例 ID 为入口，按 `CRM3DB` 与 `CONFIGDB_CNOS_JF_TEST` 的固定单表关联链读取产品、套餐/销售品、账户合同和定价计划；实例档案额外读取接入实例、双向实例关系、实例属性/状态/扩展信息、号码与资源关系及销售品实例属性/费用。由后端聚合结果，不开放自由 SQL；没有数据的分类不显示空表。任一关联表缺失时该步骤会明确标记失败，其余档案仍返回为“部分完成”。工程环境查询结果可按对应逻辑库和表生成 `INSERT` 脚本，在弹窗中核对并一键复制；工作台只生成文本，不直接写入测试库。
- 「阈值查询」以 A 端产品实例 ID 为入口，先读取 A/Z 产品关系，再筛选产品规格 `900178630` 的 Z 端实例，最后返回 20%、40%、80%、100%、150%、200% 六档提醒属性；同样采用固定参数化单表查询。
- 右上角连接入口按环境折叠展示只读连接列表，默认收起；测试环境包含 SSH、MySQL/UDAL 与 Doris，工程环境包含 Voyage 在线数据库和内存档案服务，五者独立连接。SSH 状态显示在资源浏览标题区，各查询来源状态显示在查询面板。全部连接信息从本地 `.env` 读取，页面只显示非敏感项和凭据配置状态。Voyage 接入说明见 [工程环境 Voyage 在线数据库](./docs/voyage-integration.md)。
- 「内存档案查询」接受产品实例 ID 或 `rate:cpp:{产品实例ID}`，通过工程环境适配器返回结构化档案；当前真实请求协议待内网资料补齐，页面明确显示待配置/待适配状态。接入资料见 [工程环境内存档案接入清单](./docs/archive-integration.md)。
- 数据库连接固定使用 `utf8mb4`；已被上游错误转码且可无损识别的业务名称会恢复显示并保留“原始值”列。页面及服务生成的时间统一按 UTC+8 展示和记录。
- CDR 源 NDJSON 只读，修改留在内存；支持版本冲突检测、10 万条记录上限、批量预览/应用一致性、O(1) ID 索引和原子导出校验。

## 目录

```text
server-workbench/
├─ start.bat                 # Windows 启动入口（PATH 查找运行时）
├─ .env.example              # SSH 与数据库连接配置样例
├─ package.json / lock        # 可复现 Node 依赖和检查脚本
├─ shared/                   # 共享令牌、图标精灵、请求/DOM/对话框工具
├─ public/                   # PC 主工作台（原生 ES Modules）
├─ server/                   # Node HTTP、SSH、SFTP、HDFS、数据库/档案查询、CDR 代理
├─ cdr/                      # FastAPI + 内存 CDR 引擎与前端
└─ tests/                    # Node builtin test、Python unittest、fixture
```

## 质量检查

按改动范围选择验证项，具体规则见 [AGENTS.md](./AGENTS.md)。常用命令如下：

首次运行 Python 测试前，执行 `python -m pip install -r cdr/requirements-dev.txt` 安装测试依赖；测试与语法检查统一使用 PATH 中的 `python`。

```powershell
npm run check
npm run test:node
npm run test:python
git diff --check
```

测试不需要真实 SSH/SFTP/HDFS 或凭据；真实远端链路需在本机准备 `.env` 和 `ssh2` 后另行 smoke。

更多说明见 [overview.md](./overview.md) 和 [cdr/README.md](./cdr/README.md)。
