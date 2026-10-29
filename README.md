# Server Workbench

面向测试人员的 Windows 优先本地工具工作台，集中处理 SSH/SFTP 文件、HDFS、HBase、数据库档案查询和 CDR 话单。当前交付重点是 PC 端；移动端专用布局、深色模式和运行时迁移不在范围内。

Windows x64 安装包与自动更新分发仓库。测试安装包未进行代码签名。

## 快速开始

安装并运行 Windows App，构建、内置 CDR 与 GitHub 自动更新见 [Windows 桌面版](./docs/windows-desktop.md)。

1. 安装 Node.js 18+、Python 3.10+，在项目根目录运行（Node 依赖包含 `ssh2`、`mysql2`、`pg` 与 `iconv-lite`）：

   ```powershell
   npm ci
   python -m pip install -r .\cdr\requirements.txt
   ```

2. 复制 `.env.example` 为根目录 `.env`，填写 SSH、MySQL/UDAL、Doris、测试环境 PostgreSQL、工程环境 Voyage Token 及按需使用的 Redis 档案、HDFS/HBase 客户端服务连接信息。`.env` 已被 `.gitignore` 排除，不要提交真实凭据。
3. 开发时运行 `npm run desktop:start`，安装包使用方式见桌面版文档。

## 功能与安全边界

- 主工作台采用浅色工具主题，一级导航包含「资源浏览」「数据库查询」「Redis 档案」「进程日志」「话单工具」五个独立页面。窄窗口自动收为图标导航；切页保留输入、结果与滚动位置，页面地址只记录模块和子页，不包含号码或实例 ID。查询结果按分组阅读，明确的产品实例可带入档案查询或 Redis 页面，由用户发起查询。
- 文件浏览使用结构化 SFTP 接口：目录列表、预览、新建文件/目录、删除文件或空目录、下载。删除需要二次确认，根路径受保护。
- 服务器文件、HDFS 和 HBase 列表支持基于已加载结果的名称/路径/中文备注搜索与排序；常用目录和 HBase 表可收藏到当前浏览器。
- HDFS 支持目录浏览、文件预览/下载、服务器文件上传、在当前目录新建目录/新建空文件，以及文件或空目录二次确认删除。新建目录/文件走 SSH 命令链路（常驻客户端服务暂无这两个接口），要求 SSH 已连接；HDFS 页的「上传」先把本机文件传到服务器当前目录，再弹出确认框指定 HDFS 目标目录；客户端服务模式复用常驻 `FileSystem`，SSH 命令链路保留为显式回退。HBase 表查看支持 20/50/100/200 行样本、RowKey 精确查询、当前样本内查找、结构化行数据和原始结果复制。
- 固定查询支持选择环境：测试环境从 PostgreSQL `bill_inmemory` 查档案、MySQL/UDAL `CONFIGDB_CNOS_JF_TEST` 查配置；工程环境通过已连接的 Voyage 查询，支持 `bill_inmemory` / `crmv3` Schema。连接成功后切到对应查询环境，切换环境或 Schema 会取消旧请求并清空结果，避免混用。关系链查询固定使用测试 PG/MySQL，Redis 同步也仍固定从测试 PG 读取。
- 「号码查产品」用手机号、固话或宽带业务号码 `acc_nbr` 定位产品实例。业务号码是产品实例的属性，不等于 `prod_inst_id`，同一号码可能返回多个实例或历史版本。「实例查档案」使用产品实例ID，保留PG现存 `his_id` 版本及根产品/销售品的一跳直接关系；关联节点不展开兄弟实例。销售品定义和定价计划转到MySQL查询，缺失/失败/上限分别展示；详见 [实例档案查询覆盖](./docs/archive-query-coverage.md)。
- 「查询套餐」按规格 `offer_id` 查MySQL套餐定义与定价，再沿PG `prod_offer_inst → offer_prod_inst_rel → prod_inst` 反查订购用户。「查询事件类型」从MySQL读取事件格式、入库路由和定价关联，从PG读取关联销售品/产品实例；默认事件类型为 `206080000`（CDMA集团）。
- 「关系链查询」新增产品→销售品、接入→功能产品、成员→群主、销售品A/Z双向、销售品→产品成员、客户/账户/银行群正向查询、非产品群→成员反查和对端成员诊断。档案查PG，销售品/定价配置查MySQL；结果为原始关系候选，不自动裁定有效履历、默认账户或群内优惠。范围和规则见 [档案查询与关系链](./docs/archive-relations.md)。
- 「阈值查询」以 A 端产品实例 ID 为入口，先读取 A/Z 产品关系，再筛选产品规格 `900178630` 的 Z 端实例，最后返回 20%、40%、80%、100%、150%、200% 六档提醒属性；同样采用固定参数化单表查询。
- 右上角「连接管理」在右侧抽屉按环境展示只读连接列表，并按当前任务定位相关数据源；测试环境包含 SSH/SFTP、HDFS/HBase客户端服务、MySQL/UDAL、Doris与PostgreSQL，工程环境保留Voyage连接管理。PostgreSQL用于固定档案查询及Redis同步读取；配置查询使用MySQL，连接相互独立，不执行导出脚本。全部连接信息从本地 `.env` 读取，页面只显示非敏感项和凭据配置状态。部署与内网资料清单见 [HDFS/HBase 常驻客户端接入](./docs/bigdata-client-integration.md)。
- 「Redis 档案」分为档案查看、PG 同步、号码索引和同步记录四个标签；档案查看与同步共享目标实例。接受产品实例 ID 或完整 `rate:cpp:` 主键，由 Node 直接读取本地 `.env` 配置的 Redis DB，按“大端长度头 + LZ4 block + JSON”解码并以可展开结构展示。分组与字段同时显示原名和按命名推导的中文释义，原始值与代码值保持不变；业务代码的精确枚举含义仍以数据字典为准。密码不下发浏览器，主键限制为 `rate:cpp:{数字ID}`，单条解压结果默认限制为 16 MiB。
- 「Redis 档案」支持从测试 PG `bill_inmemory` 预览并同步已有字段及根产品直接订购新增记录，按 `ID + his_id` 匹配；新增订购关系与销售品实例列明目标分组和字段值，其他新增类型仅核对。确认后仅写入指定 key，写前备份、保留 TTL 并回读验证，支持冲突保护和整条恢复。PG 缺失记录、未映射字段保持原值，不自动删除；字段无差异不等于完整档案一致。使用与边界见 [PG → Redis 同步](./docs/pg-redis-sync.md)。
- 「Redis 档案」可输入实例 ID 或手机号，定位已有 CPP 并预览缺失的 `rate:account` / `rate:accNbr` SET 索引。分别使用根产品实际 `account` / `accNbr`，确认后按二进制格式新增并回读，已有 key 保留；手机号索引缺失时从测试 PG 定位，多实例由用户选择。仅覆盖所选实例，不创建完整 CPP，详见 [缺失号码索引补建](./docs/redis-indexes.md)。
- 侧边栏「进程日志」查看云翼平台有状态（StatefulSet）和无状态（Deployment）容器日志并支持工作负载启停。桌面版点击「网页登录并连接」，在独立平台窗口完成登录后自动验证并接入；该窗口与 Chrome、工作台页面的会话隔离，仅使用本次应用内存，不保存 Cookie 到磁盘；已配置的自动填充凭据仅以本机 Windows 加密形式保存在应用用户目录，不随安装包分发。首次需在该窗口登录；退出应用后重新登录。桌面应用保留「手动 Cookie 连接」作为备用入口。按集群、命名空间、工作负载、Pod、容器选择目标；命名空间显示当前账号在所选集群中可见的全部名称，工作负载同时取两类全部分页，不再限制 `test` 名称。工作负载下拉框输入即进行不区分大小写的名称包含搜索，支持方向键、Enter 选择和 Escape 收起，并标明类型；输入文字不等于选中目标。选定容器后每 5 秒静默采集并保存，即使切换页面或最小化仍继续；可查看末尾 100/500/1000 行，并手动或每 5 秒自动刷新显示；按目标去重追加到本地 `logs/dcos/<集群>__<命名空间>__<Pod>__<容器>.log`（单文件 20 MiB 后轮转为 `.1.log`）。平台只提供末尾快照，两次拉取之间滚出窗口的行不会补回。启停仍需弹窗二次确认，作用范围是所选类型的整个工作负载，包含列表中的 dev 目标；会话失效后重新连接。先在本机 `.env` 设置 `DCOS_BASE_URL`，可用 `DCOS_CLUSTERS=321:ccse-xyha-01` 配置集群，多个集群以逗号分隔。
- MySQL/UDAL 与 Doris 连接固定使用 `utf8mb4`；已被上游错误转码且可无损识别的业务名称会恢复显示并保留“原始值”列。页面及服务生成的时间统一按 UTC+8 展示和记录。
- 话单页面以记录表格为中心，批量修改、造数及导出记录按需打开抽屉；撤销、导出和未导出状态常驻。源 NDJSON 只读，修改留在内存；修改批量条件会作废预览，替换未导出会话前需确认。支持版本冲突检测、10 万条记录上限、O(1) ID 索引和原子导出校验。

## 目录

```text
server-workbench/
├─ .env.example              # SSH 与数据库连接配置样例
├─ package.json / lock        # 可复现 Node 依赖和检查脚本
├─ shared/                   # 共享令牌、图标精灵、请求/DOM/对话框工具
├─ public/                   # PC 主工作台（原生 ES Modules）
├─ server/                   # Node HTTP、SSH、SFTP、HDFS、数据库/档案查询、CDR 代理
├─ bigdata-client-service/   # 内网常驻 Java HDFS/HBase 原生客户端服务
├─ cdr/                      # FastAPI + 内存 CDR 引擎与前端
└─ tests/                    # Node builtin test、Python unittest、Playwright 浏览器用例、fixture
```

## 质量检查

按改动范围选择验证项，常用命令如下：

首次运行 Python 测试前，执行 `python -m pip install -r cdr/requirements-dev.txt` 安装测试依赖；测试与语法检查统一使用 PATH 中的 `python`。

```powershell
npm run check
npm run test:node
npm run test:python
npx playwright install chromium
npm run test:browser
git diff --check
```

浏览器测试使用锁定的 Playwright 版本（支持项目 Node.js 18 基线），启动隔离的 Node/CDR 服务，以临时话单执行编辑、批量操作、撤销和导出；远端接口使用模拟响应，覆盖路由、取消、过期响应、Redis 确认及布局。测试不需要真实 SSH/SFTP/HDFS 或凭据；真实远端链路需在本机准备 `.env` 和 `ssh2` 后另行 smoke。

更多说明见 [overview.md](./overview.md) 和 [cdr/README.md](./cdr/README.md)。
