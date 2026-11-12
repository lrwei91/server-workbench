# 定价计划查询 SQL（简单版）

适用：当前测试环境。2026-11-06 实库核验。

**看懂链路就看下面的短 SQL；想一次查完就运行脚本。** 正文不再放 SQL 拼接、编码转换或临时表回填。

## 1. 一条命令自动查完

按定价计划批量查询，并反查订购用户：

```powershell
node "D:\Project\server-workbench\scripts\query-chain.cjs" --type plan --ids 12000812,12000815
```

只有销售品规格 ID：

```powershell
node "D:\Project\server-workbench\scripts\query-chain.cjs" --type offer --ids 905856378,908234408
```

没有 ID，先抽 10 个计划：

```powershell
node "D:\Project\server-workbench\scripts\query-chain.cjs" --sample pricing --limit 10
```

脚本自动传递 ID，分别查询 CONFIGDB_CNOS_JF_TEST、PG 和 CRM3DB，不需要复制中间结果。没有 PG 订购的配置也保留，标为“未找到PG订购档案”。

连接直接使用项目现有 .env 中的 PG_* / UDAL_* 配置，沿用项目 Node.js 18+ 环境与依赖；无需启动工作台页面或填写新密码。仅查询业务表，处理中使用独立 PG 连接的会话临时表。

输出位置会打印在终端，默认保存在 outputs/query-chain 下的新目录：

|文件|先看什么|
|---|---|
|summary.md|是否成功、数量、断点和未匹配入口|
|chain.csv|整条关联链，适合用表格查看|
|result.json|每张表的完整原始字段、输入与每步结果，适合详细排查|

CSV 长数字和前导零会加单引号，避免 Excel 改值；原值以 JSON 为准。导出包含业务数据，留在合适的本机目录。

## 2. 只记这条关系

```text
销售品 offer
    └─ pricing_plan_id → 定价计划 pricing_plan
                             └─ pricing_plan_id → 定价组合 pricing_combine
                                                    ├─ event_pricing_strategy_id → 事件策略
                                                    └─ pricing_object_id → 定价对象

销售品 offer_id → PG 销售品实例 prod_offer_id → 订购关系 → 产品实例/号码
```

后面的短 SQL 用一组已核验 ID 演示关联。它们用于理解或单步排查，不承担自动传值；自动模式使用第 1 节脚本。

## 3. 按顺序看懂：销售品 → 计划 → 组合 → 策略/对象

### 第一步：销售品对应哪个计划？

**连接：CONFIGDB_CNOS_JF_TEST。** 看返回的 pricing_plan_id。

```sql
SELECT offer_id, offer_name, pricing_plan_id
FROM offer
WHERE offer_id = 905856378;
```

此样本对应计划 8036046。

### 第二步：看计划定义

**同一连接。**

```sql
SELECT *
FROM pricing_plan
WHERE pricing_plan_id = 8036046;
```

### 第三步：看计划包含哪些定价组合

**同一连接。** 每行组合给出事件策略和可选的对象引用。

```sql
SELECT pricing_combine_id, event_pricing_strategy_id, pricing_object_id
FROM pricing_combine
WHERE pricing_plan_id = 8036046;
```

### 第四步：批量查这些组合的事件策略

**同一连接。** 用 JOIN 自动接上第三步，不逐个复制策略 ID。

```sql
SELECT DISTINCT e.*
FROM event_pricing_strategy e
JOIN pricing_combine c
  ON c.event_pricing_strategy_id = e.event_pricing_strategy_id
WHERE c.pricing_plan_id = 8036046;
```

### 第五步：看组合实际引用的定价对象

**同一连接。**

```sql
SELECT DISTINCT o.*
FROM pricing_object o
JOIN pricing_combine c
  ON c.pricing_object_id = o.pricing_object_id
WHERE c.pricing_plan_id = 8036046;
```

某些组合的 pricing_object_id 为空，表示该行没有对象引用，不必强行找一个对象。

若要看“计划名下所有对象”，而不只是组合已引用的对象：

```sql
SELECT *
FROM pricing_object
WHERE pricing_plan_id = 8036046;
```

## 4. 反过来查，也只改入口

### 有计划，查销售品

```sql
SELECT offer_id, offer_name, pricing_plan_id
FROM offer
WHERE pricing_plan_id IN (12000812, 12000815);
```

**要继续查订购用户，运行第 1 节的 plan 命令**，脚本会自动切到 PG。手工查看 PG 语句见[档案查询 SQL](./档案查询SQL.md)。

### 有事件类型，查关联计划

**连接：CONFIGDB_CNOS_JF_TEST。** 下例是精确事件类型，不是事件类型族。

```sql
SELECT DISTINCT c.pricing_plan_id
FROM pricing_combine c
JOIN event_pricing_strategy e
  ON e.event_pricing_strategy_id = c.event_pricing_strategy_id
WHERE e.event_type_id = 206080100
ORDER BY c.pricing_plan_id
LIMIT 10;
```

这里 LIMIT 10 是手工预览上限。自动脚本按指定入口查询关联数据，不套用该预览上限；事件入口可能关联很多计划，日常建议先用具体计划或销售品 ID。

### 脚本入口对照

把命令中的 --type 和 --ids 换成对应值即可；多个 ID 用逗号分隔，保留为字符串。

|手里有什么|--type|--ids 示例|
|---|---|---|
|定价计划|plan|12000812,12000815|
|销售品规格|offer|905856378|
|定价组合|combine|820473011|
|事件策略|strategy|1|
|精确事件类型|event|206080100|
|9 位事件类型族|event-family|206080000|
|定价对象|object|612866|

event-family 会取前 6 位对应的 1000 个细分码范围；它不是只查输入的一个事件。组合、策略、事件、对象入口会先定位计划，再展开这些计划的销售品和组合。

## 5. 如何看断点

- 未匹配入口：输入 ID 在入口表未找到，和“某一步查询报错”分开看。
- 计划定义缺失 / 定价组合缺失 / 事件策略缺失 / 对象引用未匹配：保留已有数据，直接定位缺失环节。
- 未找到 PG 订购档案：配置存在，但这次 PG 未找到对应订购；不是配置不存在。
- 执行状态 failed：查看 result.json 最后一个 error 步骤；已读取的数据会保留，终端返回非零退出码。
- queried 只表示查询完成，不表示所有链路都完整，更不表示当前资费有效。

## 6. 已核验边界

- 当前定义表是 offer，不是图中的 prod_offer。
- PG prod_offer_inst.prod_offer_id 对应 offer.offer_id。
- 产品定义要走 CRM3DB.product；在配置连接中加 CRM3DB 前缀不等同于真正切换逻辑库。
- 当前 PG 缺少 prod_offer_member_inst、payment_plan，本脚本不查询这两张表。
- 同一计划可对应多个销售品、组合、履历；结果行数不是用户数。不自动判断有效期、默认账户或最终优惠。
- 自动脚本按批次 100 个 ID 分段请求，但不截掉后续 ID；--limit 只用于抽样入口。大范围查询建议缩小入口，单语句超时 30 秒。

本轮已实跑：计划 12000812、12000815 反查结果 26 行，其中保留配置侧没有 PG 订购的行；旧高级方案只展示有 PG 路径的 18 行，两者口径不同。

需要纯数据库客户端的自动接力方案，再看[高级附录](./sql-chain-advanced/定价计划查询SQL_高级附录.md)；日常无需阅读其中的生成 SQL。
