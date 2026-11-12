> 高级附录：保留 2026-11-06 已验证的数据库客户端接力方案。日常使用请看[简单版定价手册](../定价计划查询SQL.md)或[简单版档案手册](../档案查询SQL.md)。

# 定价计划查询 SQL：批量入口与双向接力

验证日期：2026-11-06（北京时间）。本文 SQL 已通过当前真实连接执行，不是从应用代码摘录的参数模板。

**用途：从计划、销售品、定价组合、事件策略、事件类型或对象中的任一入口，批量查其他配置，并反查 PG 订购档案。只在入口选条件，后续复制结果里的完整 SQL 执行，不逐个抄 ID。**


## 图与实库的核对结论

不是照图照抄表名。本次已连接当前配置的三个目标核验：PG 数据库 bill_cnos_jftest、UDAL 逻辑库 CONFIGDB_CNOS_JF_TEST 和 CRM3DB。

|核对项|实库结论|
|---|---|
|销售品定义 prod_offer|当前两个 MySQL 逻辑库均未找到该表；可用表为 offer。本文销售品定价统一取 CONFIGDB_CNOS_JF_TEST.offer|
|产品规格字段|PG prod_inst 使用 product_id；CRM3DB.product 的主键是 prod_id。上一版 PG SQL 中的 prod_id 应纠正|
|产品定义归属|CRM3DB.product 查询成功；CONFIGDB_CNOS_JF_TEST.product 查询报表不存在|
|销售品规格关联|PG prod_offer_inst.prod_offer_id 对应配置库 offer.offer_id，样本关联成功|
|销售品与产品桥接|offer_prod_inst_rel 同时含 prod_offer_inst_id、prod_inst_id，双向查询已跑通|
|属性与 A/Z 关系|prod_inst_attr、prod_offer_inst_attr、prod_inst_rel、prod_offer_inst_rel 均存在，查询成功|
|销售品成员分支|当前 PG 中 prod_offer_member_inst 查询报表不存在；payment_plan 同样不存在。该分支不列入可执行闭环|
|执行能力|PG 临时表创建、写入、续查成功。UDAL 临时表测试失败；SET 用户变量返回成功但后续 SELECT 读回 NULL；WITH CTE 测试报语法错误|
|图的箭头说明|图中“箭头指向被引用方”与主干部分方向混用。以下采用字段等值关系表达，不把图当作外键约束证明|

已核实的字段关系：

```text
PG prod_inst.product_id                 = CRM3DB product.prod_id
PG offer_prod_inst_rel.prod_inst_id     = PG prod_inst.prod_inst_id
PG offer_prod_inst_rel.prod_offer_inst_id = PG prod_offer_inst.prod_offer_inst_id
PG prod_offer_inst.prod_offer_id        = CONFIG offer.offer_id
CONFIG offer.pricing_plan_id            = CONFIG pricing_plan.pricing_plan_id
CONFIG pricing_combine.pricing_plan_id  = CONFIG pricing_plan.pricing_plan_id
CONFIG pricing_combine.event_pricing_strategy_id = CONFIG event_pricing_strategy.event_pricing_strategy_id
CONFIG pricing_combine.pricing_object_id = CONFIG pricing_object.pricing_object_id
CONFIG pricing_object.pricing_plan_id   = CONFIG pricing_plan.pricing_plan_id
```

对象还有自己的计划归属字段，既要看组合实际引用的对象，也可按计划查全部对象。空对象引用、缺失记录、同一计划对应多个销售品都保留，不强行拼成一对一。

## C0. 客户端执行方式

1. 在 Navicat / DBeaver 保持三个独立查询窗口：PG、CONFIGDB_CNOS_JF_TEST、CRM3DB。
2. 本文 C1/C2 在 **CONFIGDB_CNOS_JF_TEST 连接**执行。不要只在该连接的 SQL 前加 CRM3DB 库名前缀切换：实测仍被 UDAL 路由到配置库；产品定义需要真正切换 CRM3DB 连接。
3. 当前 UDAL 不采用临时表或会话变量接力。每步返回下一步完整 SQL；同批 ID 自动带入。
4. 生成结果中的 SQL 列，请用“复制单元格值/复制选中列”，不要带列标题、CSV 外层引号、行号或截断省略号。整列多行时按 SQL 脚本顺序逐条执行。
5. 配置侧全部为 SELECT；跨库回填只写 PG 会话临时表，不写业务表。
6. 无需先知道 ID，可直接执行 C1 默认的“前 10 个正数计划”入口。若想优先找到有测试订购的数据，从[档案查询 SQL](./档案查询SQL_高级附录.md)的 P1 批量样本开始，再走 P4。

## C1. 首批计划 + 自动生成后续命令

下面整块直接执行。它先捞一批计划，再返回下一步命令。只修改末尾 SEED_BEGIN / SEED_END 中间的入口 SELECT；外层保持不变。

结果列说明：

|列|用途|
|---|---|
|seed_count / batch_status|批次大小和生成状态；0 表示入口没有匹配。列表被 GROUP_CONCAT 截断时 next_sql 留空，并提示缩小批次|
|next_sql|主链结果：计划→销售品→定价组合→策略/事件→实际引用对象；同时生成 PG 回填和订购反查命令|
|plans_sql / offers_sql|原始计划、销售品定义完整字段|
|combines_sql / objects_sql|原始组合、该计划归属的全部对象完整字段；对象列表不限定为某组合已引用对象|
|strategies_sql|该批计划关联事件策略完整字段|


```sql
SELECT seed_count,
CASE WHEN seed_count=0 THEN '入口无匹配计划'
 WHEN CHAR_LENGTH(ids)<>expected_length THEN 'ID列表截断：缩小首批数量后重跑'
 ELSE '就绪：执行 next_sql' END AS batch_status,
CASE WHEN seed_count>0 AND CHAR_LENGTH(ids)=expected_length
 THEN CONCAT('SELECT o.offer_id,pp.pricing_plan_id,pp.pricing_plan_name,
pc.pricing_combine_id,pc.event_pricing_strategy_id,e.event_type_id,
pc.pricing_object_id,po.pricing_object_id AS matched_object_id,
po.pricing_plan_id AS object_plan_id,
CASE WHEN pp.pricing_plan_id IS NULL THEN ''计划定义缺失''
 WHEN pc.pricing_combine_id IS NULL THEN ''定价组合缺失''
 WHEN e.event_pricing_strategy_id IS NULL THEN ''事件策略缺失''
 WHEN pc.pricing_object_id IS NOT NULL AND po.pricing_object_id IS NULL THEN ''对象引用未匹配''
 ELSE ''已关联'' END AS config_status,
CONCAT(''INSERT INTO pg_temp.swq_cfg VALUES ('',
 CHAR(39),COALESCE(o.offer_id,''none''),'':'',COALESCE(pp.pricing_plan_id,''none''),'':'',COALESCE(pc.pricing_combine_id,''none''),CHAR(39),'','',
 COALESCE(o.offer_id,''NULL''),'','',COALESCE(pp.pricing_plan_id,''NULL''),'','',
 COALESCE(pc.pricing_combine_id,''NULL''),'','',COALESCE(pc.event_pricing_strategy_id,''NULL''),'','',
 COALESCE(e.event_type_id,''NULL''),'','',COALESCE(pc.pricing_object_id,''NULL''),'','',
 ''convert_from(decode('',CHAR(39),HEX(COALESCE(o.offer_name,'''')),CHAR(39),'','',CHAR(39),''hex'',CHAR(39),''),'',CHAR(39),''UTF8'',CHAR(39),''),'',
 ''convert_from(decode('',CHAR(39),HEX(COALESCE(pp.pricing_plan_name,'''')),CHAR(39),'','',CHAR(39),''hex'',CHAR(39),''),'',CHAR(39),''UTF8'',CHAR(39),''),'',CHAR(39),CASE WHEN pp.pricing_plan_id IS NULL THEN ''计划定义缺失''
 WHEN pc.pricing_combine_id IS NULL THEN ''定价组合缺失''
 WHEN e.event_pricing_strategy_id IS NULL THEN ''事件策略缺失''
 WHEN pc.pricing_object_id IS NOT NULL AND po.pricing_object_id IS NULL THEN ''对象引用未匹配''
 ELSE ''已关联'' END,CHAR(39),
 '') ON CONFLICT (row_key) DO NOTHING;'') AS pg_cache_sql,
CASE WHEN o.offer_id IS NOT NULL THEN CONCAT(''INSERT INTO pg_temp.swq_input VALUES ('',CHAR(39),''offer'',CHAR(39),'','',CHAR(39),o.offer_id,CHAR(39),'') ON CONFLICT DO NOTHING;'') ELSE ''-- 本计划未关联销售品'' END AS pg_seed_sql
FROM pricing_plan pp
LEFT JOIN offer o ON o.pricing_plan_id=pp.pricing_plan_id
LEFT JOIN pricing_combine pc ON pc.pricing_plan_id=pp.pricing_plan_id
LEFT JOIN event_pricing_strategy e ON e.event_pricing_strategy_id=pc.event_pricing_strategy_id
LEFT JOIN pricing_object po ON po.pricing_object_id=pc.pricing_object_id
WHERE pp.pricing_plan_id IN (',ids,')
ORDER BY pp.pricing_plan_id,o.offer_id,pc.pricing_combine_id;') END AS next_sql,
CASE WHEN seed_count>0 AND CHAR_LENGTH(ids)=expected_length
 THEN CONCAT('SELECT * FROM pricing_plan WHERE pricing_plan_id IN (',ids,');') END AS plans_sql,
CASE WHEN seed_count>0 AND CHAR_LENGTH(ids)=expected_length
 THEN CONCAT('SELECT * FROM offer WHERE pricing_plan_id IN (',ids,');') END AS offers_sql,
CASE WHEN seed_count>0 AND CHAR_LENGTH(ids)=expected_length
 THEN CONCAT('SELECT * FROM pricing_combine WHERE pricing_plan_id IN (',ids,');') END AS combines_sql,
CASE WHEN seed_count>0 AND CHAR_LENGTH(ids)=expected_length
 THEN CONCAT('SELECT * FROM pricing_object WHERE pricing_plan_id IN (',ids,');') END AS objects_sql,
CASE WHEN seed_count>0 AND CHAR_LENGTH(ids)=expected_length
 THEN CONCAT('SELECT DISTINCT e.* FROM event_pricing_strategy e JOIN pricing_combine c ON c.event_pricing_strategy_id=e.event_pricing_strategy_id WHERE c.pricing_plan_id IN (',ids,');') END AS strategies_sql
FROM (
 SELECT COUNT(*) AS seed_count,GROUP_CONCAT(plan_id ORDER BY plan_id SEPARATOR ',') AS ids,
 SUM(CHAR_LENGTH(CAST(plan_id AS CHAR)))+COUNT(*)-1 AS expected_length
 FROM (/* SEED_BEGIN */
SELECT pricing_plan_id AS plan_id FROM pricing_plan
WHERE pricing_plan_id>0 ORDER BY pricing_plan_id LIMIT 10
/* SEED_END */) seed
) batch;
```

### 换入口：只替换上述标记内的 SELECT

以下各段是入口选择器，单独运行可预览计划 ID；要让后续自动接力，将选中的一段替换进 C1 标记区域。示例 ID 均来自本次实库核验，换成你的目标只改这一步。

**已知计划 ID（支持一批）：**

```sql
SELECT pricing_plan_id AS plan_id FROM pricing_plan
WHERE pricing_plan_id IN (12000812,12000815)
```
**已知销售品规格 ID（不是订购实例 ID）：**

```sql
SELECT DISTINCT pricing_plan_id AS plan_id FROM offer
WHERE offer_id IN (905856378,908234408) AND pricing_plan_id IS NOT NULL
```
**已知定价组合 ID：**

```sql
SELECT DISTINCT pricing_plan_id AS plan_id FROM pricing_combine
WHERE pricing_combine_id=820473011
```
**已知事件策略 ID：**

```sql
SELECT DISTINCT pricing_plan_id AS plan_id FROM pricing_combine
WHERE event_pricing_strategy_id=1 ORDER BY pricing_plan_id LIMIT 10
```
**已知事件类型族：**

```sql
SELECT DISTINCT pc.pricing_plan_id AS plan_id
FROM pricing_combine pc
JOIN event_pricing_strategy e ON e.event_pricing_strategy_id=pc.event_pricing_strategy_id
WHERE e.event_type_id>=206080000 AND e.event_type_id<206081000
ORDER BY pc.pricing_plan_id LIMIT 10
```
此例覆盖 206080000～206080999；若只查一个精确事件类型，把入口条件换成 event_type_id 等值条件。LIMIT 10 限的是首批计划，不是结果总量；缩小、扩展或分批仅改入口。

**已知定价对象 ID：**

```sql
SELECT pricing_plan_id AS plan_id FROM pricing_object
WHERE pricing_object_id=612866
```

如果销售品的 pricing_plan_id 为空，上述“销售品→计划”入口返回空，而非证明销售品不存在。档案 P4 的销售品驱动查询会保留该销售品并标明计划缺失；不要把这类断点过滤掉。

## C2. 执行 next_sql，完成配置链

复制 C1 返回的 next_sql 整个单元格到同一配置库窗口执行。结果直接含：

- offer_id、pricing_plan_id、pricing_plan_name；
- pricing_combine_id、event_pricing_strategy_id、event_type_id；
- pricing_object_id、matched_object_id、object_plan_id；
- config_status（缺计划、缺组合、缺策略、对象引用未匹配或已关联）；
- pg_cache_sql、pg_seed_sql（两列完整的 PG 命令）。

此步骤以整批计划为中心展开，所以从一个销售品进入后也可能看到同计划的其他销售品。它不表示这些销售品都被同一个用户订购。

原表更多字段直接执行 C1 的相应 *_sql 列。主链按组合引用定位对象；objects_sql 则列出计划下全部对象，二者目的不同。

## C3. 反查订购用户，并把配置带回 PG 闭环

按顺序操作：

1. **PG 窗口**先执行[档案文档](./档案查询SQL_高级附录.md) P0（初始化一次）。若正在续查同一批、P0 已执行且临时表仍在，则跳过初始化。
2. 从 C2 结果中复制整列 **pg_seed_sql** 到 PG 执行。它自动把这批销售品规格写入入口临时表；重复语句自动去重，无销售品的计划返回 SQL 注释。
3. 复制整列 **pg_cache_sql** 到同一个 PG 窗口执行。它保存计划、组合、策略、事件、对象引用、中文名称及配置状态。
4. 执行档案 P2，再执行 P6，就得到“产品实例/号码→订购关系→销售品实例→销售品规格→计划→组合→策略/事件/对象”的同一张关联结果。
5. 若还要产品定义名称，执行档案 P5 生成的 CRM 查询及回填，再执行 P6。
6. 需要属性、A/Z 关系等旁支，执行档案 P3；继续展开关系端点用 P7。

**不混批：** 开始新的独立任务时先重新 P0；续查同一批时保留临时表。相同连接重连后，重新初始化和导入。不存在一条 SQL 自动跨 PG 和 MySQL 两种连接执行的前提，本手册的跨库动作是“复制整列生成 SQL”，没有手工拆分、拼接 ID。

## 已验证结果与边界

- 配置 7 类入口（抽样、计划、销售品、组合、策略、事件族、对象）及其生成的 next_sql 已实际执行。
- plans_sql、offers_sql、combines_sql、objects_sql、strategies_sql 已执行，返回完整原表数据。
- 以 PG 订购样本反查配置：28 个销售品规格，返回 491 行配置关联，其中保留了缺计划的情况；不是每条数据都具备完整业务关系。
- 以计划 12000812、12000815 反向生成 PG 入口及缓存并执行，最终关联结果 18 行。行数含一对多与现存履历组合，不是用户数。
- 查询成功不等于当前生效资费。本流程保留原始配置，未按资费生效时点、状态或业务优先级自动裁定。
- 入口批次固定后，关联查询不再偷偷附加应用里的 LIMIT 1/3/20；一个计划可能带出很多组合，建议先用 10 个计划试查。客户端结果截断、SQL 超时、生成列截断均应显式检查。
- 当前 UDAL 会话变量、临时表、CTE 测试不满足此链路使用条件；本文不依赖它们。标准 MySQL 的能力不等同于本 UDAL 网关的实际能力。

本机验证记录：[运行结果](../../outputs/sql-chain-verify/verified.json)、[结构核对](../../outputs/sql-chain-verify/probe.json)、[执行能力核对](../../outputs/sql-chain-verify/capabilities.json)。这些文件位于忽略提交的 outputs 中，仅用于本机追溯。SQL 已保存在本文，不依赖运行记录文件执行。
