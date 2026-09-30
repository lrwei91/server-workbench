# 工程环境 Voyage 在线数据库

## 已接入协议

工作台通过 Node 后端调用 `POST /api/query/execute`，浏览器不接触 Bearer Token，也不提供自由 SQL 编辑器。默认逻辑库映射如下：

| 工作台逻辑库 | datasource_id | database | schema |
| --- | ---: | --- | --- |
| CRM3DB | 5 | incf_db | bill_inmemory |
| CONFIGDB_CNOS_JF_TEST | 5 | incf_db | bill_inmemory |

查询面板在选择“工程环境 · Voyage”后可进一步选择 `bill_inmemory` 或 `crmv3` Schema，默认为 `bill_inmemory`。后端仅接受这两个白名单值。工程环境始终保持 Voyage 单一来源；“查询套餐”按 `offer_id` 精确读取 `offer_ces`，再查询 `prod_offer_inst`、`offer_prod_inst_rel`、`prod_offer_inst_attr` 和 `prod_inst`，不会读取测试环境 MySQL/UDAL。独立的“查询事件类型”页面使用测试环境事件配置链。

接口返回的 `columns` 与二维 `rows` 会还原为行对象；超过 JavaScript 安全整数范围的裸整数在解析前转换为字符串。HTTP 鉴权失败、接口失败和单条 SQL 的 `error` 分别保留明确状态。

## 本地配置

在根目录 `.env` 填写：

```dotenv
VOYAGE_API_URL=http://134.155.157.3:30010/api/query/execute
VOYAGE_TOKEN=
VOYAGE_TIMEOUT_MS=15000
VOYAGE_CRM_DATASOURCE_ID=5
VOYAGE_CRM_DATABASE=incf_db
VOYAGE_CRM_SCHEMA=bill_inmemory
VOYAGE_CONFIG_DATASOURCE_ID=5
VOYAGE_CONFIG_DATABASE=incf_db
VOYAGE_CONFIG_SCHEMA=bill_inmemory
```

Token 过期后可在连接设置的 Voyage 卡片中输入新 `VOYAGE_TOKEN` 并重新连接。新值会立即写入 Node 进程内存，不写入浏览器存储、日志或 `.env`，也无需重启服务。输入框在每次连接后清空；Node 服务重启后仍使用 `.env` 中的 Token。

## 当前数据边界

`bill_inmemory` 使用工程环境物理表名，Node 层会在发起 Voyage 查询前应用以下固定映射；返回步骤同时展示逻辑表和实际表：

| 测试环境逻辑表 | bill_inmemory 实际表 |
| --- | --- |
| `prod_inst_acct_rel` | `prod_inst_acct` |
| `offer_inst` | `prod_offer_inst` |
| `offer_inst_attr` | `prod_offer_inst_attr` |
| `offer_inst_rel` | `prod_offer_inst_rel` |
| `offer` | `offer_ces` |

`account`、`prod_inst`、`prod_inst_attr`、`prod_inst_rel`、`offer_prod_inst_rel` 保持同名；查询父表，由数据源负责路由 `_p0` 至 `_p11` 分片及 `_z` 反向索引表。工程字段固定映射 `acc_num → acc_nbr`、`offer_inst_id → prod_offer_inst_id`，步骤结果会展示字段映射。`payment_plan` 是账户付费计划，不再当作 `pricing_plan`。

测试环境号码和实例档案继续读取完整产品、账户、销售品、定价计划及扩展档案。工程 `bill_inmemory` 只执行已确认存在的主链：`prod_inst`、`prod_inst_acct`、`account`、`offer_prod_inst_rel`、`prod_offer_inst`、`offer_ces`；实例档案额外读取 `prod_inst_rel`、`prod_inst_attr` 和 `prod_offer_inst_attr`。当前清单中缺失的测试环境扩展表不再发起工程请求。默认映射为 `incf_db / bill_inmemory`，页面可切换到 `incf_db / crmv3`。

若后续取得定价计划所在的 datasource、database 和 schema，只需调整 `VOYAGE_CONFIG_*` 映射或对应固定查询，不影响页面查询契约。
