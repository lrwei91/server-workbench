# Server Workbench 项目总览

本项目当前采用 Node.js + FastAPI + 原生 ES Modules 双运行时，面向 Windows/PC 工具场景。Node 负责本地 HTTP、SSH、SFTP、HDFS、数据库查询和 CDR 代理；FastAPI 负责话单内存模型。两者通过同源 `/cdr/` 代理连接。

## 运行结构

```text
浏览器（PC）
  └─ Node server/server.js :17755
       ├─ public/ + shared/
       ├─ SSH / SFTP / HDFS
       ├─ MySQL/UDAL + Doris + Voyage 在线数据库连接与固定只读查询
       ├─ 工程环境内存档案服务适配层
       ├─ 兼容保留的自由命令与本地日志接口
       └─ /cdr/* 反向代理
            └─ FastAPI cdr/server.py :8000
                 └─ cdr/engine.py（最多 100,000 条内存记录）
```

`start.bat` 只从 PATH 查找 `node`、`python`/`py`，不包含个人绝对路径。`.env.example` 展示连接结构，复制成未纳入 Git 的 `.env` 后填写真实连接信息。Node 启动时会报告配置缺失，接口仅返回掩码后的连接状态。

## 前端架构

- `shared/tokens.css` 是纯白工具覆盖：画布/表面白、黑墨层级、荧光黄主操作与选中、蓝色焦点、独立状态色，视觉旋钮按 4/3/6 控制密度、圆角和阴影。
- `shared/ui.js` 提供统一请求错误模型、可区分的超时/主动取消、DOM 节点创建、状态播报、格式化和原生 `dialog` 焦点进入/恢复。
- `shared/icons.svg` 为图标精灵。主工作台和 CDR 前端均使用 `textContent`/节点构造渲染远端数据，不把文件名、路径、字段值拼入 `innerHTML`。
- 主工作台保持稳定 PC 双栏，资源浏览与数据库查询宽度比例为 1:1.5；连接弹窗按环境分组并默认收起，测试环境展示 SSH、MySQL/UDAL 和 Doris 独立连接，工程环境展示 Voyage 在线数据库与内存档案服务。SSH 状态位于资源浏览标题区，查询来源状态位于查询面板。
- 右侧固定档案查询可选择测试环境 UDAL 或工程环境 Voyage，并以手机号或产品实例 ID 为入口；Node 层依次读取 CRM 产品/账户/销售品实例和配置侧销售品/定价计划，再按关联 ID 聚合展示。实例档案进一步读取 `acc_prod_inst_id`、双向 `prod_inst_rel`、实例属性与扩展表，以及销售品实例属性/费用；结果区仅渲染有数据的分类，失败步骤单独保留。同客户其他产品和账户候选沿用当前来源按需查询。Voyage 当前映射到 `datasource_id=5 / incf_db / crmv3`，单个关联分支失败时保留其他成功结果并返回“部分完成”。Voyage 档案结果可在浏览器端按固定数据分类映射回对应表并生成 `INSERT` 预览，同一目标表的数据会合并去重，并保留 `NULL`、日期字符串和大整数精度；该功能只复制脚本，不执行数据库写入。
- 阈值查询以 A 端产品实例 ID 为入口，分步读取 `prod_inst_rel`、产品规格为 `900178630` 的 `prod_inst`，以及六个固定档位属性对应的 `prod_inst_attr`，避免 UDAL 子查询路由限制。
- 内存档案查询接受产品实例 ID 或完整 `rate:cpp:` 主键，通过独立适配器读取工程环境整套档案；当前仅提供待配置实现和离线模拟测试，不访问页面入口，也不在工作台中直连 Redis 或解释二进制值。
- 主工作台的三类资源列表在已加载数据上本地搜索/排序并保留收藏；HBase 查看窗口只读取指定行数的样本，查找和高亮不触发额外扫描。月度 `ACCUMULATOR_<账期>` 在前端拆解列族 `f` 的 Qualifier；`ACCUMULATOR_DETAIL_<账期>` 拆解 MS/SM RowKey；未处理和已处理话单分发表分别按各自七段 RowKey 拆解来源标识/文件、时间键、分发类型、处理场景和附加编码；采预/批价的在途与已完成主表按批次 ID 汇总 `batch_info` 字段，子表拆解输入/输出方向、来源/目标路径及结果段；原始结果仍用于复制。
- CDR 以「文件与会话 → 记录浏览 → 批量修改/造数 → 导出」顺序组织，字段错误、加载/空/错误状态和影响数量均在原位反馈。

当前默认聚焦 PC 场景，移动端专用布局和深色模式不属于默认实现范围；CSS 仅保留窄视口兜底，PC 缩放不应裁切主要操作。

## 后端契约与性能

### Node

- 请求体限制 1 MiB，非法 JSON/未知字段返回真实 HTTP 状态和 `{ok:false,error:{code,message,retryable}}`。
- `/api/exec` 是明确的高级自由命令入口；交互式命令和根目录递归强删拦截，删除类命令需 `confirmed:true`。所有参数化路径使用单引号 shell 转义。
- `/api/connect`、`/api/db/connect` 与 `/api/voyage/connect` 从本地 `.env` 读取配置，分别管理 SSH、MySQL/UDAL、Doris 与工程环境 Voyage 会话；`/api/query/*` 只接受固定参数。MySQL 使用驱动占位符，Voyage 适配器对标量参数做 SQL 字面量转义后调用固定执行接口。每条 SQL 15 秒、整次手机号查询 60 秒，分步最多 500 行、整次最多 5,000 行。
- `/api/voyage/status|connect|disconnect` 仅返回脱敏配置和连接状态；Bearer Token 只由 Node 从 `.env` 读取。适配器把 `columns + rows` 还原为对象，保留不安全大整数为字符串，并把 HTTP、鉴权和语句级错误分开报告。
- `/api/archive/status|connect|disconnect` 独立管理工程环境档案服务，`/api/query/archive` 返回固定的环境、主键、产品实例、状态、读取时间和结构化数据契约；凭据仅在 Node 侧使用。真实协议确认后替换适配器即可。
- UDAL 按逻辑库建立 `utf8mb4` 连接，不在查询中写库名前缀；结果中的大整数、金额和日期保留字符串。可无损识别的 UTF-8/GB18030 历史错码业务名称恢复显示并保留原始值。分支失败、关联缺失与空结果分别返回，跨库结果不表示同一事务快照。
- 浏览器日期格式化、查询元数据、SFTP 修改时间、Node 日志日期和 CDR 生成时间均显式使用 UTC+8；数据库业务日期字符串保持原值并标注 UTC+8，不做二次偏移。
- `/api/sftp/list|preview|mkdir|touch|delete|download` 使用结构化 SFTP；删除区分 file/空 dir，根路径保护。
- `/api/hdfs/list` 沿用后端一次重试，`/api/config` 将 HDFS 列表和 HBase 查询的实际执行时限下发给前端；`/api/hbase/scan` 保留原请求格式并返回 `truncated` 元数据。
- 命令 stdout/stderr 共用 2 MiB 预算并返回 `truncated`；日志通过异步队列写 JSONL，过期清理每天最多一次，读取支持 `limit/offset`，默认 200 条。
- 目录刷新、HDFS 刷新和自动刷新有 AbortController/代际门禁；页面隐藏时暂停，单个刷新请求不会重入。

### CDR

- `load_file` 逐行验证 NDJSON，只接受对象并在错误中报告行号；完整解析成功后才替换会话。
- 字段类型采用观察集合：整数+浮点推断为 float，字符串/其他混合推断为 str；ID 使用 O(1) 索引。
- 会话 revision 随修改递增，`GET /api/session` 支持刷新恢复；写操作可携带 `expected_revision`，冲突返回 409。
- 批量预览与实际应用共用转换/时间校验；无筛选的批量修改拒绝执行。造数先计算总量，超过 100,000 条拒绝；撤销栈有深度和变更预算。
- 导出先写同目录临时文件，验证 JSON 可读、`TICKET_COUNT`、ID 唯一性和时间格式，全部通过后 `os.replace` 原子替换。

## 测试与限制

Node builtin tests 覆盖 shell 转义、危险删除、真实错误状态、日志分页；Python unittest 覆盖非法 NDJSON、混合类型、ID 生成、批量一致性、版本/容量/原子导出等。测试使用假数据和临时目录，不接触真实凭据。

浏览器验收按受影响流程和布局变化选择环境，规则见 [AGENTS.md](./AGENTS.md)。真实 SSH/SFTP/HDFS smoke 需要本机 `.env` 和已安装 `ssh2`。
