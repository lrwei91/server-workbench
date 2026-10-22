# PostgreSQL → Redis 档案字段与直接订购同步

## 使用

1. 重启本地工作台服务（桌面开发模式重新启动；已打包应用需重新构建后使用）。
2. 在「Redis 档案」页点击「连接 PostgreSQL」，连接测试环境 PG。
3. 输入产品实例 ID 或 `rate:cpp:产品实例ID`，修改 PG 后先提交事务。
4. 点击「从 PG 生成差异预览」。可展开选择固定表范围与 PG 无时区时间解释。
5. 核对字段差异、待追加条数、目标分组及新增字段值，再点击「确认同步到 Redis」，在弹窗确认目标 key 与写入数量。
6. 查看回读验证结果与备份标识；需要撤销时打开「同步记录 / 恢复」。

连接复用本地 `PG_*`、`REDIS_ARCHIVE_*` 配置，Redis DB 以配置为准。凭据仅在 Node 侧使用。

## 当前范围

此工具支持**已有档案字段更新及根产品直接订购追加**，不是全库复制或完整档案重建。

| Redis 分组及 First/Second/Third/Fourth/Fifth/SixthStep、StepZ 变体 | PG 表 | ID 字段 |
| --- | --- | --- |
| prodInsts | prod_inst | prod_inst_id |
| prodInstAttrs | prod_inst_attr | prod_inst_attr_id |
| prodInstRels | prod_inst_rel | prod_inst_rel_id |
| prodInstAcctRels | prod_inst_acct | prod_inst_acct_id |
| offerProdInstRels | offer_prod_inst_rel | offer_prod_inst_rel_id |
| offerInsts | prod_offer_inst | prod_offer_inst_id |
| offerInstAttrs | prod_offer_inst_attr | prod_offer_inst_attr_id |
| offerInstRels | prod_offer_inst_rel | prod_offer_inst_rel_id |
| accounts | account | account_id |

- Schema 固定为 `bill_inmemory`，按 `ID + his_id` 匹配历史版本。
- Redis 已存在且有同名 snake_case PG 列的字段参与更新。`parentProdInstId` 等组装上下文字段保持原值。
- PG 缺失记录、未映射字段、未识别分组保留原值，并在预览中列明；PG 的缺失不视为删除。
- 预览另列“PG 有、Redis 无”记录级差异：从根产品反查订购关系，再查销售品实例、属性及直接销售品一跳；产品一跳、属性、账户按所选表覆盖。以 ID + his_id 跨 Step 分组匹配，保留全部历史版本（包括 NULL），不筛选当前有效期。
- 其中根产品的 `offer_prod_inst_rel` 及其直接关联 `prod_offer_inst` 纳入追加。基础组已存在则使用基础组；Step 档案分别写入 `offerProdInstRelsFirstStep`、`offerInstsFirstStep`。基础组与 FirstStep 同时存在、目标非数组时阻断。已有其他 Step 记录不搬移、不重复追加。
- 新增字段对齐订阅者 OfferInst/OfferProdInstRel Bean，并包含已有同类记录的字段集合；值来自 PG，不复制旧套餐值。`offer_id` 兼容映射为 `prodOfferId`；时间和大整数沿用既有转换规则。模板含 `parentProdInstId` 时由根产品 ID 生成；其他缺少映射的上下文字段、必填状态/时间/主键缺失、PG 冲突重复记录会阻断整次同步。
- 新增订购关系与实例应同时选表；关系对应的销售品已在 Redis 时可单独追加关系。关系缺少可写入或已存在的销售品实例时阻断，避免半套订购。0 处字段差异且有待追加记录时也可确认同步。
- 其他新增类型（属性、账户、关联产品和间接销售品等）仅核对并列明原因，不自动追加；既有记录删除、修改主键或关联端点仍需另行核对。确认框明确待写入及仅核对数量。
- 记录级范围不是全库或完整档案组装；查询字段缺失会显式标注覆盖不完整，总读取超过 5000 行停止预览，列表超过 200 条显示总数及截断提示。0 条字段差异不代表 PG 与 Redis 完整一致。
- 同一 PG 业务键存在内容冲突的重复记录、字段类型或精度异常时，预览展示阻断项。
- 修改共享记录时，本工具只刷新用户指定的一个 Redis key；其他包含该记录的 key 需分别预览同步。

## 时间、整数和编码

- PG `timestamp without time zone` 默认按北京时间 `+08:00` 解释；可显式选择 UTC，不依赖机器时区。
- `timestamp with time zone` 要求显式时区（Z、±HH、±HHMM、±HH:MM），按实际时刻转换成 epoch 毫秒。日历日期及时间分量严格校验，异常值停在预览阶段。
- 兼容 PG 1–6 位小数秒：按毫秒精度截断，不四舍五入（`.007267 → .007`，epoch 前同样按时间轴向下至毫秒）。存在非零亚毫秒部分时，预览另列字段、PG 原值、带时区的毫秒时间及目标 epoch 值，确认框提示精度转换数量；PG 原始值保持不变。
- 大整数通过 BigInt 保留，写回 JSON 数字类型；浏览器预览用字符串无损展示。高精度数值发生舍入风险时阻断。
- 当前写入协议限定已核验的 `4 字节大端解压长度 + raw LZ4 block + Kryo String`。
- Kryo 头包含 Java UTF-16 字符长度加一，随 JSON 内容重算；UTF8 编码按 Kryo 的逐 Java 字符规则处理，包括代理对。该实现不复制固定十六进制前缀。
- 编码后先做解码自检，再进入备份/写入；沿用配置的默认 16 MiB 解压长度上限。
- 协议依据：[Kryo Output 源码](https://github.com/EsotericSoftware/kryo/blob/master/src/com/esotericsoftware/kryo/io/Output.java)、[LZ4 block 规范](https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md)。

## 一致性和恢复

- PG 固定查询在单连接的只读 Repeatable Read 事务中完成，无通用 SQL 执行 HTTP 入口。
- 预览仅保存在本次 Node 内存中，10 分钟有效，最多保留最近 5 份。
- 应用前重新读取 PG 和 Redis；预览后的目标值、新增订购内容/成员、Redis 原值、过期时间或连接配置变化，需要重新预览。
- 旧 Redis 原始二进制、摘要、字段/新增条数和绝对过期时间先保存到 `logs/pg-redis-sync/`，成功落盘后才写入；恢复整条旧值，也撤销本次追加记录。
- Lua 脚本原子比较旧值、写新值及保留过期时间；随后 GET 回读核对实际二进制并解码。需要 Redis `GET/PTTL/TIME/EVAL/SET/PEXPIREAT` 权限。
- 备份结果为待确认、已验证、未写入、待核对或已恢复。写入后断网或回读冲突时保留备份，先核对当前档案再恢复。
- 恢复只接受当前 Redis 摘要仍等于此次同步结果的情况，避免覆盖后续修改；按原绝对过期时间恢复，不延长 TTL。原过期时间已到则停止。
- 备份包含业务数据，应留在本机受控目录；`logs/` 已被 Git 忽略。当前由用户按需要保留/清理，不自动删除。

本工具没有 PG/Redis 跨库事务，也不刷新计费进程内存缓存。Redis 回读成功与计费程序实际消费验收是两项独立检查。

## 接口

- `GET /api/redis-sync/status`：固定表范围。
- `POST /api/redis-sync/preview`：`key`、可选 `tables`、可选 `timestampZone`。
- `POST /api/redis-sync/apply`：`previewId`、`confirmed:true`。
- `POST /api/redis-sync/history`：`key`，最近 20 份当前连接的备份摘要。
- `POST /api/redis-sync/restore`：`backupId`、`confirmed:true`。

写接口校验同源请求，预览 token 与备份绑定当前 PG/Redis 连接。接口不返回凭据或备份原始二进制。

## 验证

运行 `npm run check`、`npm run test:node` 与 `git diff --check`。同步专项测试使用本地假 TCP Redis 与 PG 固定样例，覆盖二进制 RESP、Kryo 长度/Unicode、LZ4、历史版本、差异、缺失保留、确认、备份、TTL、并发冲突与恢复；测试不访问真实测试环境。假 TCP Redis 与固定样例只覆盖上列协议编码与同步流程，真实链路的同步与回读按「使用」和「一致性和恢复」章节在测试环境执行。
