# 档案查询 SQL（简单版）

适用：当前测试环境。2026-11-06 实库核验。

**自动查完用一条命令；看懂关系用下面的短 SQL。** 不再手工维护临时表，不再复制跨库回填语句。

## 1. 一条命令自动查完整条链

已知产品实例，支持一批：

```powershell
node "D:\Project\server-workbench\scripts\query-chain.cjs" --type product --ids 38852790,48243980
```

没有 ID，先捞最多 10 个有订购关系的产品：

```powershell
node "D:\Project\server-workbench\scripts\query-chain.cjs" --sample archive --limit 10
```

已有销售品实例：

```powershell
node "D:\Project\server-workbench\scripts\query-chain.cjs" --type offer_instance --ids 7431695554
```

命令可直接在 PowerShell 执行。沿用项目 Node.js 18+ 和已安装依赖，读取项目 .env 的现有连接，无需打开工作台页面。

脚本自动完成：
```text
入口 → 产品/销售品实例 → 订购关系
                  ├─ 产品与销售品属性
                  ├─ A/Z 关系、产品账户关系、账户
                  ├─ MySQL 销售品定义 → 计划 → 组合 → 策略/对象
                  └─ CRM3DB 产品定义
最终按字段关联，输出一张链路表及原表数据
```

终端会显示结果目录：
- summary.md：执行状态、数量和断点，先看它。
- chain.csv：完整关联路径，适合打开查看。
- result.json：全部原始字段、各表履历、查询步骤与未匹配输入。

结果默认进入 outputs/query-chain 的独立新目录，已有文件保持原样。CSV 对长数字/前导零加单引号保护，精确原值以 JSON 为准；导出业务数据请妥善保管。

## 2. 按顺序看懂：产品 → 订购关系 → 销售品实例

以下短 SQL 用已核验的产品 38852790 演示。它们适合单步阅读、排障；想自动接力，使用上面的命令。

### 第一步：产品实例是什么？

**连接：PG bill_cnos_jftest。**

```sql
SELECT prod_inst_id, acc_nbr, product_id, his_id
FROM bill_inmemory.prod_inst
WHERE prod_inst_id = 38852790;
```

记住：acc_nbr 是号码，prod_inst_id 是实例，product_id 是产品规格。它们不是同一个 ID。

没有实例 ID 时，可以先看一批：

```sql
SELECT prod_inst_id, acc_nbr, product_id
FROM bill_inmemory.prod_inst
ORDER BY prod_inst_id
LIMIT 10;
```

### 第二步：这个产品订购了哪些销售品实例？

**同一 PG 连接。**

```sql
SELECT prod_inst_id, prod_offer_inst_id, his_id
FROM bill_inmemory.offer_prod_inst_rel
WHERE prod_inst_id = 38852790;
```

offer_prod_inst_rel 是桥接表，两端分别是产品实例和销售品实例。

### 第三步：这些销售品实例对应哪些销售品规格？

**同一 PG 连接。** 直接关联，不逐个填写上一步的实例 ID。

```sql
SELECT r.prod_inst_id, o.prod_offer_inst_id, o.prod_offer_id
FROM bill_inmemory.offer_prod_inst_rel r
LEFT JOIN bill_inmemory.prod_offer_inst o
  ON o.prod_offer_inst_id = r.prod_offer_inst_id
WHERE r.prod_inst_id = 38852790;
```

这里的 prod_offer_id 才是去 MySQL 查 offer 的规格 ID。

### 第四步：接上销售品定义和定价计划

**连接：CONFIGDB_CNOS_JF_TEST。** 下面展示该样本中的一个销售品：

```sql
SELECT offer_id, offer_name, pricing_plan_id
FROM offer
WHERE offer_id = 905856378;
```

后面怎么查计划、组合和策略，见[定价计划查询 SQL](./定价计划查询SQL.md)。自动脚本会批量带入第三步全部规格，不需要手动切库传 ID。

### 第五步：产品定义在哪？

**真正切到 CRM3DB 连接。** 第一条样本的 product_id 为 800000002：

```sql
SELECT prod_id, prod_name
FROM product
WHERE prod_id = 800000002;
```

字段对应：PG prod_inst.product_id = CRM3DB product.prod_id。脚本会自动查询并补入 product_name。

## 3. 旁支也用短 SQL

### 产品属性

**PG：**

```sql
SELECT *
FROM bill_inmemory.prod_inst_attr
WHERE prod_inst_id = 38852790;
```

### 产品 A/Z 双向关系

**PG：** A/Z 任一端命中都保留；不要直接把 A 端当作已经确认的群主。

```sql
SELECT *
FROM bill_inmemory.prod_inst_rel
WHERE prod_inst_a_id = 38852790
   OR prod_inst_z_id = 38852790;
```

### 销售品属性与 A/Z 关系

**PG：** 使用销售品实例 ID，而不是销售品规格 ID。

```sql
SELECT *
FROM bill_inmemory.prod_offer_inst_attr
WHERE prod_offer_inst_id = 7431695554;
```

```sql
SELECT *
FROM bill_inmemory.prod_offer_inst_rel
WHERE rela_prod_offer_inst_id = 7431695554
   OR related_prod_offer_inst_id = 7431695554;
```

### 产品关联账户

**PG：** 关联角色等完整字段保留在脚本 result.json 中，查询不自动裁定默认账户。

```sql
SELECT a.*
FROM bill_inmemory.prod_inst_acct r
JOIN bill_inmemory.account a ON a.account_id = r.account_id
WHERE r.prod_inst_id = 38852790;
```

## 4. 反向入口：有销售品，也能查用户

**PG：** 用销售品规格反查所有匹配的订购产品。

```sql
SELECT o.prod_offer_inst_id, r.prod_inst_id, p.acc_nbr
FROM bill_inmemory.prod_offer_inst o
LEFT JOIN bill_inmemory.offer_prod_inst_rel r
  ON r.prod_offer_inst_id = o.prod_offer_inst_id
LEFT JOIN bill_inmemory.prod_inst p ON p.prod_inst_id = r.prod_inst_id
WHERE o.prod_offer_id = 905856378;
```

自动执行同一方向：

```powershell
node "D:\Project\server-workbench\scripts\query-chain.cjs" --type offer --ids 905856378
```

## 5. 已有任意节点，如何填命令？

统一格式：--type 入口类型 --ids 一个或多个值。多个值用逗号隔开；除了号码，ID 按整数处理，超长整数保留字符串精度。

|已知数据|--type|ID 对应字段|
|---|---|---|
|号码|number|acc_nbr（原值，保留前导零）|
|产品实例|product|prod_inst_id|
|产品规格|product_spec|product_id / CRM prod_id|
|客户|customer|owner_cust_id|
|账户|account|account_id|
|销售品实例|offer_instance|prod_offer_inst_id|
|销售品规格|offer|prod_offer_id / MySQL offer_id|
|产品属性行|product_attr|prod_inst_attr_id|
|产品关系行|product_relation|prod_inst_rel_id|
|销售品属性行|offer_attr|prod_offer_inst_attr_id|
|销售品关系行|offer_relation|prod_offer_inst_rel_id|
|桥接关系行|bridge|offer_prod_inst_rel_id|

计划、组合、事件策略、事件类型、对象入口见另一份手册。

默认只取当前节点的一跳 A/Z 关系，不继续扩张所有对端的订购。需要把这些对端也作为新入口，再加一个选项：

```powershell
node "D:\Project\server-workbench\scripts\query-chain.cjs" --type product --ids 38852790 --expand-relations
```

每次运行只追加一跳，不递归全网。--limit 仅用于 --sample；已指定 ID 的关联结果不受该抽样参数影响。较宽的产品规格/客户/事件入口可能带出很多数据，建议先从具体实例开始。

## 6. 结果怎么看，哪些地方还没有覆盖？

- chain_status / config_status：看断在哪一环，空值不会被自动补造。
- 未找到 PG 订购档案：配置找到但 PG 路径为空；配置行仍保留。
- 未找到 PG 产品实例：产品定义在 CRM 中存在，但 PG 没有匹配实例；product_spec 入口仍保留产品定义。
- unmatchedInputs：入口值没有命中入口表，和查询失败分开记录。
- summary.md 显示 failed 时，查看 result.json 最后一个 error 步骤；脚本返回非零退出码，并保留已读数据。
- 各表 his_id 单独保留。一对多和不同履历组合会增加行数，不表示新增了用户。
- 数据不是跨库同一快照，也不自动判定计费时点是否有效。
- 实库产品规格字段是 product_id；图里的 prod_offer 应按当前环境使用 offer。
- 当前 PG 缺少 prod_offer_member_inst 和 payment_plan，客户群/银行群成员分支没有列入自动闭环。
- 业务表只读；独立连接中的临时表随连接关闭清理。脚本不会修改现有档案。

## 7. 本轮验证

- 抽取直接订购样本：9 个产品实例、28 个销售品规格、21 个计划，最终 1352 行（含履历和一对多）。
- 指定 38852790、48243980：2 个产品实例，最终 210 行。
- 计划 12000812、12000815 反查：26 行，包含无 PG 订购的配置行。
- 原始关联与旧已验证流程一致；脚本额外保留配置侧无订购的结果，避免把“没订购”误报为“没配置”。
- 本文和定价手册的短 SQL 已逐条在实库执行；额外验证了无订购产品定义、销售品实例入口、A/Z 扩展、空入口。Node 回归 185 项通过。

只想用数据库客户端、不运行脚本时，可查看[高级附录](./sql-chain-advanced/档案查询SQL_高级附录.md)。正常查数无需阅读其中的临时表和生成 SQL。
