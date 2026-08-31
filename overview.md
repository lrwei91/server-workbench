# 远程服务器管理工作台 · 项目总览

> 面向测试人员的免命令行远程服务器管理工具，围绕"增、删、查"操作，降低使用门槛。

## 目录结构（统一收拢在 server-workbench 下，功能解耦）

```
server-workbench/
├── start.bat          # 唯一入口：一键拉起 Node 桥接 + 话单功能后端，自动开浏览器
├── overview.md        # 本总览文档
├── config.js          # Node 端统一配置（唯一配置源）
├── logs/              # 执行日志持久化（按日期命名 logs/YYYY-MM-DD.log，自动生成）
├── server/            # Node 桥接服务（后端，功能拆模块）
│   ├── server.js      # 主入口：HTTP 路由 + 服务启动
│   ├── ssh.js         # SSH 连接管理与远程命令执行
│   ├── sftp.js        # SFTP 文件浏览（通道复用 + 列目录 + 下载）
│   ├── hdfs.js        # HDFS（hadoop fs）浏览
│   ├── log.js         # 执行日志持久化（写盘/读取/列日期）
│   └── proxy.js       # cdr（话单功能）反向代理
├── public/            # 工作台前端（CSS/JS 已拆出）
│   ├── index.html     # 页面结构
│   ├── style.css      # 样式
│   └── app.js         # 前端逻辑
└── cdr/               # 话单功能模块（Python FastAPI，端口 8000）
    ├── server.py      # 服务入口（纯服务，不再自动开浏览器）
    ├── config.py      # 模块配置（路径常量 + 端口，与 config.js 口径一致）
    ├── app.py         # FastAPI 路由
    ├── engine.py      # 核心引擎（解析/会话/校验/变换/导出）
    ├── static/        # 话单功能前端（视觉令牌已对齐工作台）
    └── data/logs/     # 操作日志
```

> 已把原 `tools/cdr-tool/` 收拢为 `server-workbench/cdr/`，并去掉其"独立工具"形态
> （`run.py` 自动开浏览器/端口顺延/工具标题 → `server.py` 纯服务入口），
> 收敛为项目内一个内聚功能模块。后端 `server.js` 按职责拆成 5 个模块，
> 前端 `index.html` 拆出 `style.css` + `app.js`，Node 端与 Python 端配置统一收口。

## 交付清单

| 位置 | 说明 |
|---|---|
| `start.bat` | 一键启动：拉起本地桥接服务（Node）+ 话单工具后端（Python），并自动打开工作台页面 |
| `server/` | Node 桥接服务（127.0.0.1:17755）：SSH / SFTP / HDFS / 话单工具代理（分模块） |
| `public/` | 工作台前端（index.html + style.css + app.js） |
| `cdr/` | 话单工具后端（Python FastAPI，端口 8000），经 `/cdr/` 反向代理同源嵌入 |
| `overview.md` | 本总览文档 |

## 功能模块与实现方式

### 1. 远程连接
- 默认配置预置于 `server/ssh.js` 的 `DEFAULT_CONFIG`（10.11.2.99:22 / cnos_jf，密码仅存服务端不下发明文）
- 连接失败自动翻译为友好提示（内网不可达 / 认证失败 / 端口未开放 / 超时）并附排查建议
- 修改配置走【连接设置】弹窗，自定义配置存浏览器 localStorage

### 2. 快捷指令（数据驱动 · 顶栏按钮弹窗）
- `COMMANDS` 数组定义四组指令：查看 / 增建 / 删除 / 系统，共 15 个
- 带参数的指令弹出收集窗口，实时预览最终命令；删除类强制二次确认弹窗（显示完整路径）
- 底部输入框支持直接敲命令：↑↓ 历史、快速输入 chips、删除命令自动走确认流程
- 弹窗内两个主 Tab（按服务器 / HDFS 场景拆分）：
  - **服务器**：四组指令（查看/增建/删除/系统）点选执行，针对服务器本地命令
  - **HDFS**：13 条 HDFS 速查表（hadoop fs -ls/-cat/-du/-df 等 + 1 条 hbase shell），点命令/复制按钮复制，点执行直接在服务器跑
- 入口：右上角【快捷指令】按钮，弹窗展示（左侧不再占用 Tab）

### 3. 文件浏览器（SFTP）
- 双击目录进入、点击文件查看内容、行内 下载 / 删除 / 进入 操作
- 新建文件夹 / 新建文件 / 跳转路径 / 上级 / 刷新 工具栏
- 连接成功后缓存 `$HOME`，所有入口统一展开 `~` 路径（该服务器 SFTP 不支持 `~` 展开）

### 4. 日志展示（含持久化）
- 每条命令独立日志块：时间戳 + 命令 + 耗时 + 成功/失败徽标
- 输出语法高亮：ls 权限/目录/链接/大小/日期着色（兼容 SELinux `.` 后缀）、df/free/ps 表头加粗、错误行红色
- 单块 复制 / 保存为 txt；顶栏一键导出全部会话日志
- 查看文件类日志块支持 10 秒自动刷新（替代 tail -f）
- **日志持久化**（新增）：每条命令执行完自动写入本地文件 `logs/YYYY-MM-DD.log`（按日期命名，每行一条 JSON）；页面刷新后自动恢复当天日志，不再丢失
  - 后端 `server/log.js`：追加写盘（写入队列串行化防并发损坏）、按日期读取、列出已有日期、超 90 天自动清理
  - 接口：`POST /api/log/append`（追加）、`GET /api/log/list?date=`（读取某天）、`GET /api/log/dates`（列日期）
  - 前端：命令执行完（成功/失败/连接）自动落盘；`restoreLogs()` 页面加载时恢复当天日志；清屏仅清视图，日志文件保留

### 5. 安全防护
- 删除类命令未确认时服务端直接拒绝（HTTP 409）
- `rm -rf /` 根目录递归删除绝对拦截
- vim / top / tail -f 等交互式命令拦截并给出替代建议
- 服务仅监听 127.0.0.1，不对外网暴露

### 6. HDFS 浏览器（第四个 Tab，只读可视化）
- 解决"HDFS 路径必须敲 `hadoop fs -ls` 命令行"的问题：点选式浏览集群目录
- 实现：后端 `/api/hdfs/list` 执行 `hadoop fs -ls` 并解析输出为结构化条目（类型/权限/属主/大小/时间/完整路径）；`/api/hdfs/download` 用 `hadoop fs -cat` 流式转发（二进制安全）
- 交互与【文件】页一致：面包屑、上级/刷新/跳转、双击进目录、点文件查看前 256KB（走日志区高亮展示）、行内下载
- 常用目录快捷 chips：/apps、话单 prep（/apps/bill_cnos_jf_test/prep）、旧 prep、bill_cnos_jf、dcs、cal
- 刻意只读不提供增删（HDFS 数据安全考虑）；当前目录记忆在 localStorage
- 与【文件】页的本质区别：HDFS 页看的是集群分布式文件系统（话单数据），文件页看的是服务器本地磁盘（日志/配置），两者路径互不相通

### 7. 计费速查面板（数据来自开发提供的排障资料，2026-08 · 顶栏按钮弹窗）
- **HDFS 目录速查**：8 条本机实测路径（计费根 / 话单预处理测试·旧 / 试算 / bill_cnos_jf / 大流量提醒 / dcs / cal），点「进入」切到 HDFS 页并直达该目录
- **话单类型 ↔ 表名映射**：20 条（含事件类型 ID / 业务 / TICKET 表名），支持按表后缀（地市+账期，默认 597_2606）一键生成 `select count(*)` SQL 并复制到数据库客户端执行
- **HBase 表速查**：分发表 / 量本表 / 批次表 / 采预排重表四张卡片，表名说明 + 预置 scan 命令【执行】【复制】；scan 通过 `echo "…" | hbase shell` 非交互执行（timeout 90s）
- **计费服务速查**：8 条服务（批价 5 + 策略中心 3），含职责与结果表说明，可一键 `ps -ef | grep 服务名` 查进程
- **全局搜索框**：跨 HDFS 目录 / 话单表 / HBase / 服务四个区块过滤
- **环境参数可配置**（localStorage 持久化）：HBase 命名空间、HBase 账期、话单表后缀
- 入口：右上角【计费速查】按钮，弹窗展示（左侧不再占用 Tab）

### 8. 话单功能（cdr 模块 · 顶栏按钮弹窗）
- 把话单文件数据调整工具（原 `tools/cdr-tool/`，现收敛为项目内 `cdr/` 功能模块）整合进工作台，右上角新增【话单工具】按钮，点击弹全屏弹窗，iframe 同源嵌入
- 功能：浏览/筛选话单文件（JF 混合 6 类业务 / OCG 上网）、单条/批量修改、批量造数（ID 重生成 + 字段变换）、导出自动重算 TICKET_COUNT + 完整性校验（CDR_KEY/COLLECT_CDR_ID 唯一、时间格式、回读可解析）
- 实现：`server/proxy.js` 提供 `/cdr/` 反向代理，把请求转发给 cdr 模块的 FastAPI 服务（127.0.0.1:8000）；cdr 前端用相对路径（`api/*`、`static/*`），经同源代理后 iframe 内页面与 API 自动路由，零改造
- 服务未启动时 iframe 显示友好降级提示页（HTTP 503），不影响工作台其它功能
- 启动：`start.bat` 通过环境变量 `CDR_PORT=8000`（与 `config.js` 的 `config.cdr.port` 一致）后台拉起 `cdr/server.py`（纯服务入口，不自动开浏览器、不自动顺延端口）
- 数据安全：源文件只读，修改仅存内存，导出才落盘到 `outputs/cdr_tool/`

### 9. 布局结构
- 左侧 Tab 仅保留「服务器文件」「HDFS」两个浏览页（原「文件」改名「服务器文件」，强调本地磁盘 vs 集群的对照）
- 底部命令输入 chips 与 datalist 自动补全跟随 Tab 切换：
  - 「服务器文件」Tab：ls / pwd / df / free / ps / uptime 等本地命令
  - 「HDFS」Tab：hadoop fs -ls / -du / -df / -cat / -head / -tail / -count 等集群命令
- 右上角按钮：快捷指令 · 计费速查 · 话单工具 · 连接设置 · 连接（依次排列）

## 实测发现的环境差异（重要）

| 项目 | 开发资料（生产） | 测试服务器 10.11.2.99 实测 |
|---|---|---|
| HBase namespace | `ns_cnos` | **`ns_aibcp_dev`**（ns_cnos 不存在；ns_bill_cnos_jf 等均为空） |
| 量本表名 | `ACCUMULATOR_*` | **`ACCUMULATION_*`**（ACCUMULATION_0 / _202409 / _202410） |
| 排重表账期 | 202608 | 实测数据为 202409 / 202410 |
| TICKET_OTHER | 无后缀单表 | 测试环境按月分表（TICKET_OTHER_202409） |
| 分发表 / 批次表 / TICKET_ABNORMAL | — | 与资料完全吻合 ✓ |
| HDFS 话单目录 | 截图来源机器为 `/apps/bill_cnos_jf/prep/`（root@ecos-jfsryc-sc-az3-3） | **`/apps/bill_cnos_jf_test/prep/normal/`**（本机无前者；子目录为 errstyle/input/upload/working；另有独立 `/apps/prep/{normal,trycalc}`） |

分发表 STRA scan 已在 `ns_aibcp_dev:TICKET_DISPATCH_FILE` 上真实执行通过（当前 0 行为正常业务状态）。

HDFS 浏览器已端到端验证：列目录（多层）、不存在路径友好报错、下载 `/apps/bill_cnos_jf/usage/usage-mq.txt`（592 B，HTTP 200 内容正确）、`hadoop fs -cat | head -c` 预览。注意本机 `cnos_jf` 用户 PATH 无 `hdfs` 命令，一律用 `hadoop fs`。

## 模块边界与调用关系（cdr 整合重构后）

### 双运行时架构（合理分工，非割裂）

| 运行时 | 职责 | 目录 | 入口 |
|---|---|---|---|
| Node（ssh2） | SSH/SFTP 远程命令、HDFS 浏览、HTTP 路由、`/cdr/` 反向代理 | `server/` | `server/server.js`（:17755） |
| Python（FastAPI） | 话单文件解析引擎（加载/改数/造数/校验/导出） | `cdr/` | `cdr/server.py`（:8000） |

两个运行时通过**反向代理**而非进程内调用衔接，边界清晰、可独立重启、互不阻塞。

### 调用链路

```
浏览器 (工作台 public/)
   │  /cdr/ 及其子路径
   ▼
Node server/proxy.js  ── HTTP 反向代理 ──▶  cdr/server.py (FastAPI :8000)
   │                                          ├─ app.py   路由
   │                                          └─ engine.py 核心引擎
   ▼
远程服务器 (ssh.js/sftp.js/hdfs.js)
```

- **前端**：`public/index.html` 右上角【话单工具】按钮 → 全屏弹窗 iframe 加载 `/cdr/`，经 Node 代理同源嵌入 cdr 的 `static/index.html`
- **后端**：cdr 前端相对路径 `api/*` 经代理自动路由到 FastAPI，零改造
- **降级**：cdr 服务未启动时，代理返回 HTTP 503，iframe 显示友好提示页，不影响工作台其它功能

### 对外接口

| 接口 | 提供方 | 消费方 | 说明 |
|---|---|---|---|
| `GET /cdr/*` | Node `proxy.js` | 工作台 iframe | 反向代理 cdr 前端静态资源与 API |
| `/api/*` | cdr `app.py` | cdr 前端 | 话单文件加载/改数/造数/导出/校验 |
| `config.js` | Node 端统一配置 | `server/{server,ssh,hdfs,proxy}.js` | host/port、ssh 默认连接、各超时值 |
| `cdr/config.py` | Python 端配置 | `cdr/{server,engine}.py` | 路径常量（源/输出/日志）、端口 |
| `CDR_PORT` 环境变量 | `start.bat` 注入 | `cdr/server.py` | 端口透传，与 `config.cdr.port` 保持一致 |

### 配置统一收口（消除散落硬编码）

- **Node 端**：唯一配置源 `config.js`，`ssh.js`/`hdfs.js`/`proxy.js`/`server.js` 全部通过 `require('../config')` 读取，替代各自硬编码的 host/port/超时值
- **Python 端**：`cdr/config.py` 集中定义 `SOURCE_DIR`/`OUTPUT_DIR`/`LOG_DIR`/`PORT`，`engine.py`/`server.py` 从 config 导入
- **端口一致性**：Node `config.cdr.port`（8000）与 Python `CDR_PORT` 环境变量、`config.py` 的 `PORT` 三处对齐，改动只需改一处（config）

### 视觉统一（消除两套设计令牌）

cdr 前端 `static/style.css` 的设计令牌已对齐工作台 `public/style.css`：主色 `--accent:#3d5a80`、`--ok/--err/--warn`、`--border/--border-strong`、`--accent-weak` 等取值统一，顶栏由深色改为与工作台一致的浅色面板风格，表头/行悬停统一用 `--accent-weak`。cdr 作为内嵌弹窗，视觉与工作台浑然一体。

### 相对路径修复（消除 iframe 同源嵌入的割裂）

cdr 前端原用**绝对路径**（`/static/style.css`、`/static/app.js`、`/api/*`），经 `/cdr/` 代理嵌入 iframe 时会绕过代理直打工作台 17755 端口而 404，导致话单工具在弹窗内**样式与脚本全部失效**（仅直连 8000 正常）。已统一改为**相对路径**（`static/…`、`api/…`），基于当前文档 URL 解析：

- 代理嵌入 `…/cdr/` → 解析为 `/cdr/static/…`、`/cdr/api/…`，经代理正确转发到 FastAPI ✓
- 独立直连 `…/` → 解析为 `/static/…`、`/api/…`，同样正确 ✓

两种场景一次改对、互不干扰，话单工具作为内嵌功能模块彻底摆脱了"移植遗留"的路由隐患。

## 技术要点

- **架构**：浏览器 → 本地 Node 桥接（ssh2 库）→ 远程 SSH 服务器；话单功能走 Python FastAPI，经 Node 反向代理同源嵌入
- **功能解耦**：后端拆 `server/{server,ssh,sftp,hdfs,proxy}.js` 五模块（各司其职，主入口组织路由）；前端拆 `public/{index.html,style.css,app.js}` 三文件
- **配置统一**：Node 端唯一配置源 `config.js`，Python 端 `cdr/config.py`，消除散落硬编码；端口经 `CDR_PORT` 环境变量透传保持一致
- **cdr 内聚模块**：去除独立工具形态（`run.py` 自动开浏览器/端口顺延 → `server.py` 纯服务入口），作为项目内相对独立但自然融入的功能模块存在
- **依赖外置**：ssh2 安装在 WorkBuddy 托管 node workspace，`start.bat` 通过 `NODE_PATH` 引用，OneDrive 项目目录内无 node_modules
- **SFTP 通道复用**：连接级缓存单个 SFTP channel（用 conn 引用做代际判断，断开/重连自动失效重建），避免每次列目录新开通道导致服务器 MaxSessions 上限报 "Channel open failure"
- **参数快照**：参数化命令执行时快照输入值，避免"自动刷新"闭包被后续弹窗覆盖
- **HDFS 冷启动优化**：Hadoop 客户端冷启动可达 60s+（实测首次 `hadoop fs -ls` 68s，热启动 2~3s）。连接成功后后台 `warmupHdfs()` 预热；列表超时放宽至 90s；超时/失败自动重试一次。优化后预热列表 2.8s 秒回

## 使用流程（测试人员视角）

1. 双击 `start.bat` → 自动拉起 Node 桥接 + 话单工具后端，浏览器打开工作台
2. 点右上角【连接】→ 自动登录并进入主目录 `/data/cnos_jf`
3. 左侧【服务器文件】浏览本地磁盘、【HDFS】浏览集群话单目录
4. 底部快速输入 chips 跟随 Tab 切换（本地命令 vs hadoop fs）
5. 右上角【快捷指令】点选执行增删查、或底部输入框直接敲命令
6. 右上角【计费速查】查话单表 / HBase 表 / 服务 / HDFS 目录
7. 右上角【话单工具】浏览/改数/造数/导出校验测试话单文件
8. 右侧查看结果，可复制、保存、导出全部日志

## 遗留事项

- 技能沉淀（SkillManage）因当前环境工具不可用未执行，实现要点已记录于工作区记忆 `2026-08-31.md`
- 密码明文预置于 `server/ssh.js`（按需求要求），请勿将目录整体外发；如需更换服务器或账号，改 `DEFAULT_CONFIG` 即可
