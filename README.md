# Server Workbench

面向测试人员的 Windows 优先本地工具工作台，集中处理 SSH/SFTP 文件、HDFS、HBase、数据库档案查询和 CDR 话单。当前交付重点是 PC 端；移动端专用布局、深色模式和运行时迁移不在范围内。

Windows x64 安装包与自动更新分发仓库。测试安装包未进行代码签名。

## 快速开始

Windows App 构建、内置 CDR 与 GitHub 自动更新见 [Windows 桌面版](./docs/windows-desktop.md)。原有浏览器启动方式保留。

1. 安装 Node.js 18+、Python 3.10+，在项目根目录运行（Node 依赖包含 `ssh2`、`mysql2`、`pg` 与 `iconv-lite`）：

   ```powershell
   npm ci
   python -m pip install -r .\cdr\requirements.txt
   ```

2. 复制 `.env.example` 为根目录 `.env`，填写 SSH、MySQL/UDAL、Doris、测试环境 PostgreSQL、工程环境 Voyage Token 及按需使用的 Redis 档案、HDFS/HBase 客户端服务连接信息。`.env` 已被 `.gitignore` 排除，不要提交真实凭据。
3. Windows 双击 `start.bat`，或分别运行 `python .\cdr\server.py` 和 `node .\server\server.js`。
4. 浏览器打开 <http://127.0.0.1:17755>。

启动入口从 PATH 查找 Node/Python，不依赖个人绝对路径。启动前会实际加载 `mysql2`、`pg`、`ssh2` 和 `iconv-lite` 检查依赖；复制或同步造成 `node_modules` 文件损坏时，自动执行 `npm ci` 按锁文件重建。缺少 `.env` 或关键连接项时服务仍可启动，并在连接列表中显示配置状态。

## 功能与安全边界

- 主工作台采用纯白工具主题：一级侧边栏包含「资源浏览与查询」「Redis 档案」「进程日志」「话单工具」；资源页内左侧浏览服务器资源、右侧执行固定只读数据库查询，双栏比例为 1:1.5；固定浅色，PC 视口支持 1024–1920 宽度和浏览器缩放。
- 文件浏览使用结构化 SFTP 接口：目录列表、预览、新建文件/目录、删除文件或空目录、下载。删除需要二次确认，根路径受保护。
- 服务器文件、HDFS 和 HBase 列表支持基于已加载结果的名称/路径/中文备注搜索与排序；常用目录和 HBase 表可收藏到当前浏览器。
- HDFS 支持目录浏览、文件预览/下载、服务器文件上传、在当前目录新建目录/新建空文件，以及文件或空目录二次确认删除。新建目录/文件走 SSH 命令链路（常驻客户端服务暂无这两个接口），要求 SSH 已连接；HDFS 页的「上传」先把本机文件传到服务器当前目录，再弹出确认框指定 HDFS 目标目录；客户端服务模式复用常驻 `FileSystem`，SSH 命令链路保留为显式回退。HBase 表查看支持 20/50/100/200 行样本、RowKey 精确查询、当前样本内查找、结构化行数据和原始结果复制。高级自由命令与日志接口为兼容目的保留在后端，主界面不提供该入口。
- 固定查询按表分源：档案统一从已连接 PostgreSQL 的 `bill_inmemory` 读取，配置定义仍从 MySQL/UDAL 的 `CONFIGDB_CNOS_JF_TEST` 读取。页面不切换 UDAL/Voyage 档案来源；旧来源参数在固定查询HTTP接口中统一归为PG，Schema限定为 `bill_inmemory`。
- 「号码查产品」用手机号、固话或宽带业务号码 `acc_nbr` 定位产品实例。业务号码是产品实例的属性，不等于 `prod_inst_id`，同一号码可能返回多个实例或历史版本。「实例查档案」使用产品实例ID，保留PG现存 `his_id` 版本及根产品/销售品的一跳直接关系；关联节点不展开兄弟实例。销售品定义和定价计划转到MySQL查询，缺失/失败/上限分别展示；详见 [实例档案查询覆盖](./docs/archive-query-coverage.md)。
- 「查询套餐」按规格 `offer_id` 查MySQL套餐定义与定价，再沿PG `prod_offer_inst → offer_prod_inst_rel → prod_inst` 反查订购用户。「查询事件类型」从MySQL读取事件格式、入库路由和定价关联，从PG读取关联销售品/产品实例；默认事件类型为 `206080000`（CDMA集团）。
- 「关系链查询」新增产品→销售品、接入→功能产品、成员→群主、销售品A/Z双向、销售品→产品成员、客户/账户/银行群正向查询、非产品群→成员反查和对端成员诊断。档案查PG，销售品/定价配置查MySQL；结果为原始关系候选，不自动裁定有效履历、默认账户或群内优惠。范围和规则见 [档案查询与关系链](./docs/archive-relations.md)。
- 「阈值查询」以 A 端产品实例 ID 为入口，先读取 A/Z 产品关系，再筛选产品规格 `900178630` 的 Z 端实例，最后返回 20%、40%、80%、100%、150%、200% 六档提醒属性；同样采用固定参数化单表查询。
- 右上角连接入口按环境折叠展示只读连接列表，默认收起；测试环境包含 SSH/SFTP、HDFS/HBase客户端服务、MySQL/UDAL、Doris与PostgreSQL，工程环境保留Voyage连接管理。PostgreSQL用于固定档案查询及Redis同步读取；配置查询使用MySQL，连接相互独立，不执行导出脚本。全部连接信息从本地 `.env` 读取，页面只显示非敏感项和凭据配置状态。部署与内网资料清单见 [HDFS/HBase 常驻客户端接入](./docs/bigdata-client-integration.md)。
- 左侧一级导航「Redis 档案」接受产品实例 ID 或完整 `rate:cpp:` 主键，由 Node 直接读取本地 `.env` 配置的 Redis DB，按“大端长度头 + LZ4 block + JSON”解码并以可展开结构展示。分组与字段同时显示原名和按命名推导的中文释义，原始值与代码值保持不变；业务代码的精确枚举含义仍以数据字典为准。密码不下发浏览器，主键限制为 `rate:cpp:{数字ID}`，单条解压结果默认限制为 16 MiB。
- 「Redis 档案」支持从已连接的测试 PG `bill_inmemory` 生成已有记录字段差异，按 `ID + his_id` 匹配；另列所选表、根产品一跳范围内“PG 有、Redis 无”的记录级差异。确认后仅同步指定 key 的已有字段，写前保存原始值备份、保留 TTL 并回读验证，支持冲突保护和恢复。PG 缺失记录、未映射字段保持原值，不自动新增或删除档案记录；字段无差异不等于完整档案一致。使用与边界见 [PG → Redis 同步](./docs/pg-redis-sync.md)。
- 侧边栏「进程日志」独立页面查看云翼平台 StatefulSet 容器日志并支持工作负载启停：在该页粘贴当前平台 Cookie 后，按集群、命名空间、工作负载、Pod、容器选择目标；命名空间仅显示 `bill-cnos-jf`，StatefulSet 仅显示名称含 `test` 独立段的进程。可查看末尾 100/500/1000 行并手动或每 5 秒自动刷新；每次读取会按目标去重追加到本地 `logs/dcos/<集群>__<命名空间>__<Pod>__<容器>.log`（重复拉取只补新增行、单文件 20 MiB 后轮转为 `.1.log`，状态栏悬停可见文件路径）。注意平台只提供末尾快照，两次拉取之间滚出窗口的行不会补回。选中 StatefulSet 后可按当前 Pod 状态启动或停止（弹窗二次确认，作用范围是整个 StatefulSet）。Cookie 仅留在本次 Node 进程内存，不进入本地命令日志；会话失效后重新粘贴。先在本机 `.env` 设置 `DCOS_BASE_URL`，可用 `DCOS_CLUSTERS=321:ccse-xyha-01` 配置集群，多个集群以逗号分隔。
- MySQL/UDAL 与 Doris 连接固定使用 `utf8mb4`；已被上游错误转码且可无损识别的业务名称会恢复显示并保留“原始值”列。页面及服务生成的时间统一按 UTC+8 展示和记录。
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
├─ bigdata-client-service/   # 内网常驻 Java HDFS/HBase 原生客户端服务
├─ cdr/                      # FastAPI + 内存 CDR 引擎与前端
└─ tests/                    # Node builtin test、Python unittest、fixture
```

## 质量检查

按改动范围选择验证项，具体规则见本地协作指引 `AGENTS.md`（该文件不随仓库分发）。常用命令如下：

首次运行 Python 测试前，执行 `python -m pip install -r cdr/requirements-dev.txt` 安装测试依赖；测试与语法检查统一使用 PATH 中的 `python`。

```powershell
npm run check
npm run test:node
npm run test:python
git diff --check
```

测试不需要真实 SSH/SFTP/HDFS 或凭据；真实远端链路需在本机准备 `.env` 和 `ssh2` 后另行 smoke。

更多说明见 [overview.md](./overview.md) 和 [cdr/README.md](./cdr/README.md)。
