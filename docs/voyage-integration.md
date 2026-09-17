# 工程环境 Voyage 在线数据库

## 已接入协议

工作台通过 Node 后端调用 `POST /api/query/execute`，浏览器不接触 Bearer Token，也不提供自由 SQL 编辑器。默认逻辑库映射如下：

| 工作台逻辑库 | datasource_id | database | schema |
| --- | ---: | --- | --- |
| CRM3DB | 5 | incf_db | crmv3 |
| CONFIGDB_CNOS_JF_TEST | 5 | incf_db | crmv3 |

接口返回的 `columns` 与二维 `rows` 会还原为行对象；超过 JavaScript 安全整数范围的裸整数在解析前转换为字符串。HTTP 鉴权失败、接口失败和单条 SQL 的 `error` 分别保留明确状态。

## 本地配置

在根目录 `.env` 填写：

```dotenv
VOYAGE_API_URL=http://134.155.157.3:30010/api/query/execute
VOYAGE_TOKEN=
VOYAGE_TIMEOUT_MS=15000
VOYAGE_CRM_DATASOURCE_ID=5
VOYAGE_CRM_DATABASE=incf_db
VOYAGE_CRM_SCHEMA=crmv3
VOYAGE_CONFIG_DATASOURCE_ID=5
VOYAGE_CONFIG_DATABASE=incf_db
VOYAGE_CONFIG_SCHEMA=crmv3
```

Token 过期后更新 `.env` 并重启 Node 服务，再在连接设置中单独连接 Voyage。

## 当前数据边界

手机号查询和实例档案查询均使用固定单表链读取 `prod_inst`、`product`、`prod_inst_acct_rel`、`account`、`offer_prod_inst_rel`、`offer_inst`、`offer` 与 `pricing_plan`。当前映射为 `incf_db / crmv3`；具体表的存在状态以实际查询结果为准，某个关联表报错时，前面成功取得的数据继续展示，整次结果标记为“部分完成”。

若后续取得定价计划所在的 datasource、database 和 schema，只需调整 `VOYAGE_CONFIG_*` 映射或对应固定查询，不影响页面查询契约。
