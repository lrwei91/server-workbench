> 高级附录：保留 2026-11-06 已验证的数据库客户端接力方案。日常使用请看[简单版定价手册](../定价计划查询SQL.md)或[简单版档案手册](../档案查询SQL.md)。

# 档案查询 SQL：一次选批次，逐步查完关联链

验证日期：2026-11-06（北京时间）。以下 SQL 已在当前 PG、MySQL/UDAL 真实连接上验证；业务表保持只读，写操作只作用于当前 PG 会话临时表。

**使用顺序：P0 初始化 → P1 选一批入口 → P2 主链 → P3 旁支 → P4 定价配置往返 → P5 产品定义往返 → P6 闭环结果。** 已有任一环节 ID 时，只替换 P1 入口；后续 SQL 原样执行。

## 1. 图与当前数据库的区别

|项目|已核实内容|
|---|---|
|PG 目标|bill_cnos_jftest 数据库 / bill_inmemory Schema，PostgreSQL 12.4（TelePG）|
|产品规格|prod_inst.product_id，不是上一版的 prod_id|
|销售品定义|CONFIGDB_CNOS_JF_TEST.offer，不是图里的 prod_offer|
|产品定义|CRM3DB.product.prod_id 对应 PG prod_inst.product_id；不在测试配置逻辑库|
|桥接和实例|offer_prod_inst_rel 两端分别连接 prod_inst、prod_offer_inst，样本双向关联成功|
|销售品 A/Z|rela_prod_offer_inst_id 为 A 端，related_prod_offer_inst_id 为 Z 端|
|产品 A/Z|prod_inst_a_id / prod_inst_z_id|
|图中成员分支|当前 PG 的 prod_offer_member_inst、payment_plan 均报表不存在，此处排除该分支的可执行 SQL|
|图的箭头|图注与部分主干方向混用；用等值字段确认引用关系，不据箭头方向限制查询方向|

更完整的配置侧核对见[定价计划查询 SQL](./定价计划查询SQL_高级附录.md)。

## P0. PG 初始化：每个独立批次运行一次

在连接 bill_cnos_jftest 的 PG 查询窗口执行。后续 PG 步骤始终用此窗口、此连接。重连或关闭连接会失去临时表。脚本模式应逐条执行，并在错误时停止。

仅清理 pg_temp 中本手册自己的三张临时表，重置入口和跨库缓存；后续中间结果由 P2 重建。不要在同一批的跨库往返中重复 P0，否则前面的缓存会被清空。

```sql
DROP TABLE IF EXISTS pg_temp.swq_input;
DROP TABLE IF EXISTS pg_temp.swq_cfg;
DROP TABLE IF EXISTS pg_temp.swq_definition;
CREATE TEMP TABLE swq_input(kind text, id text, PRIMARY KEY(kind,id));
CREATE TEMP TABLE swq_cfg(row_key text PRIMARY KEY, offer_id bigint, plan_id bigint,
  combine_id bigint, strategy_id bigint, event_type_id bigint, object_id bigint,
  offer_name text, plan_name text, config_status text);
CREATE TEMP TABLE swq_definition(product_id bigint PRIMARY KEY, product_name text);
```

## P1. 入口二选一

### A. 没有任何 ID：先捞一批有订购关系的产品

直接执行。首批最多 10 个产品实例；本次实际取到 9 个。这个入口仅保证 PG 中存在产品、桥接、销售品实例，配置缺失仍会保留为断点。

```sql
INSERT INTO pg_temp.swq_input
SELECT 'product',p.prod_inst_id::text FROM bill_inmemory.prod_inst p
JOIN bill_inmemory.offer_prod_inst_rel r ON r.prod_inst_id=p.prod_inst_id
JOIN bill_inmemory.prod_offer_inst o ON o.prod_offer_inst_id=r.prod_offer_inst_id
GROUP BY p.prod_inst_id ORDER BY p.prod_inst_id LIMIT 10
ON CONFLICT DO NOTHING;
SELECT * FROM pg_temp.swq_input ORDER BY kind,id;
```

### B. 已经有一个或一批 ID：只填这一处

不要同时执行 A 和 B，除非有意合并入口。示例从两个产品实例起步；同一行可换不同 kind，亦可插入多行混合入口。

```sql
INSERT INTO pg_temp.swq_input(kind,id)
VALUES ('product','38852790'),('product','48243980')
ON CONFLICT DO NOTHING;
```

|你手里已有的数据|kind|id 填写内容|
|---|---|---|
|号码|number|acc_nbr 原值，保留前导零|
|产品实例|product|prod_inst_id|
|产品规格/产品定义|product_spec|PG product_id / CRM product.prod_id|
|客户|customer|owner_cust_id|
|账户|account|account_id，通过 prod_inst_acct 定位产品|
|销售品实例|offer_instance|prod_offer_inst_id|
|销售品规格/销售品定义|offer|PG prod_offer_id / MySQL offer_id|
|产品属性明细行|product_attr|prod_inst_attr_id，不是通用 attr_id|
|产品 A/Z 关系行|product_relation|prod_inst_rel_id|
|销售品属性明细行|offer_attr|prod_offer_inst_attr_id|
|销售品 A/Z 关系行|offer_relation|prod_offer_inst_rel_id|
|订购桥接关系行|bridge|offer_prod_inst_rel_id|
|计划/组合/事件策略/事件/对象|在另一份文档 C1 起步|执行 C2 返回的 pg_seed_sql 自动生成这里的入口|

从配置文档 C3 过来，P0 后直接执行生成的 pg_seed_sql，再执行 P2，跳过本节 A/B。

## P2. 自动批量展开直接订购主链

整段执行，自动复用 P1 的入口。它保留命中产品、桥接关系、销售品实例的现存履历，同时读取这些节点的 A/Z 旁支。

**范围明确：** 产品入口取其订购关系；销售品实例/规格入口反查其订购产品。自动补齐桥接两端，但不持续展开所有用户的所有其他套餐；A/Z 关系只取一跳，继续扩展用 P7。配置侧样本不存在订购关系时，也会保留已找到的销售品实例行。

```sql
DROP TABLE IF EXISTS pg_temp.swq_pids;
DROP TABLE IF EXISTS pg_temp.swq_oids;
DROP TABLE IF EXISTS pg_temp.swq_bridge;
DROP TABLE IF EXISTS pg_temp.swq_products;
DROP TABLE IF EXISTS pg_temp.swq_offers;
DROP TABLE IF EXISTS pg_temp.swq_path;
DROP TABLE IF EXISTS pg_temp.swq_p_rel;
DROP TABLE IF EXISTS pg_temp.swq_o_rel;
CREATE TEMP TABLE swq_pids(id bigint PRIMARY KEY);
CREATE TEMP TABLE swq_oids(id bigint PRIMARY KEY);
INSERT INTO pg_temp.swq_pids
SELECT p.prod_inst_id FROM bill_inmemory.prod_inst p JOIN pg_temp.swq_input i
ON (i.kind='product' AND p.prod_inst_id::text=i.id)
OR (i.kind='number' AND p.acc_nbr=i.id)
OR (i.kind='product_spec' AND p.product_id::text=i.id)
OR (i.kind='customer' AND p.owner_cust_id::text=i.id)
ON CONFLICT DO NOTHING;
INSERT INTO pg_temp.swq_oids
SELECT o.prod_offer_inst_id FROM bill_inmemory.prod_offer_inst o JOIN pg_temp.swq_input i
ON (i.kind='offer_instance' AND o.prod_offer_inst_id::text=i.id)
OR (i.kind='offer' AND o.prod_offer_id::text=i.id)
ON CONFLICT DO NOTHING;
INSERT INTO pg_temp.swq_pids
SELECT t.prod_inst_id FROM bill_inmemory.prod_inst_attr t JOIN pg_temp.swq_input i
ON i.kind='product_attr' AND t.prod_inst_attr_id::text=i.id
WHERE t.prod_inst_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO pg_temp.swq_pids
SELECT t.prod_inst_a_id FROM bill_inmemory.prod_inst_rel t JOIN pg_temp.swq_input i
ON i.kind='product_relation' AND t.prod_inst_rel_id::text=i.id
WHERE t.prod_inst_a_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO pg_temp.swq_pids
SELECT t.prod_inst_z_id FROM bill_inmemory.prod_inst_rel t JOIN pg_temp.swq_input i
ON i.kind='product_relation' AND t.prod_inst_rel_id::text=i.id
WHERE t.prod_inst_z_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO pg_temp.swq_oids
SELECT t.prod_offer_inst_id FROM bill_inmemory.prod_offer_inst_attr t JOIN pg_temp.swq_input i
ON i.kind='offer_attr' AND t.prod_offer_inst_attr_id::text=i.id
WHERE t.prod_offer_inst_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO pg_temp.swq_oids
SELECT t.rela_prod_offer_inst_id FROM bill_inmemory.prod_offer_inst_rel t JOIN pg_temp.swq_input i
ON i.kind='offer_relation' AND t.prod_offer_inst_rel_id::text=i.id
WHERE t.rela_prod_offer_inst_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO pg_temp.swq_oids
SELECT t.related_prod_offer_inst_id FROM bill_inmemory.prod_offer_inst_rel t JOIN pg_temp.swq_input i
ON i.kind='offer_relation' AND t.prod_offer_inst_rel_id::text=i.id
WHERE t.related_prod_offer_inst_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO pg_temp.swq_pids
SELECT t.prod_inst_id FROM bill_inmemory.offer_prod_inst_rel t JOIN pg_temp.swq_input i
ON i.kind='bridge' AND t.offer_prod_inst_rel_id::text=i.id
WHERE t.prod_inst_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO pg_temp.swq_oids
SELECT t.prod_offer_inst_id FROM bill_inmemory.offer_prod_inst_rel t JOIN pg_temp.swq_input i
ON i.kind='bridge' AND t.offer_prod_inst_rel_id::text=i.id
WHERE t.prod_offer_inst_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO pg_temp.swq_pids
SELECT t.prod_inst_id FROM bill_inmemory.prod_inst_acct t JOIN pg_temp.swq_input i
ON i.kind='account' AND t.account_id::text=i.id
WHERE t.prod_inst_id IS NOT NULL ON CONFLICT DO NOTHING;
CREATE TEMP TABLE swq_bridge AS
SELECT r.* FROM bill_inmemory.offer_prod_inst_rel r
WHERE EXISTS(SELECT 1 FROM pg_temp.swq_pids k WHERE k.id=r.prod_inst_id)
   OR EXISTS(SELECT 1 FROM pg_temp.swq_oids k WHERE k.id=r.prod_offer_inst_id);
INSERT INTO pg_temp.swq_pids SELECT prod_inst_id FROM pg_temp.swq_bridge
WHERE prod_inst_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO pg_temp.swq_oids SELECT prod_offer_inst_id FROM pg_temp.swq_bridge
WHERE prod_offer_inst_id IS NOT NULL ON CONFLICT DO NOTHING;
CREATE TEMP TABLE swq_products AS
SELECT p.* FROM bill_inmemory.prod_inst p JOIN pg_temp.swq_pids k ON k.id=p.prod_inst_id;
CREATE TEMP TABLE swq_offers AS
SELECT o.* FROM bill_inmemory.prod_offer_inst o JOIN pg_temp.swq_oids k ON k.id=o.prod_offer_inst_id;
CREATE TEMP TABLE swq_p_rel AS
SELECT r.* FROM bill_inmemory.prod_inst_rel r
WHERE EXISTS(SELECT 1 FROM pg_temp.swq_pids k WHERE k.id=r.prod_inst_a_id OR k.id=r.prod_inst_z_id);
CREATE TEMP TABLE swq_o_rel AS
SELECT r.* FROM bill_inmemory.prod_offer_inst_rel r
WHERE EXISTS(SELECT 1 FROM pg_temp.swq_oids k WHERE k.id=r.rela_prod_offer_inst_id OR k.id=r.related_prod_offer_inst_id);
CREATE TEMP TABLE swq_path AS
SELECT COALESCE(p.prod_inst_id,r.prod_inst_id) AS prod_inst_id,p.product_id,p.acc_nbr,
       p.his_id AS product_his_id,r.offer_prod_inst_rel_id,r.his_id AS bridge_his_id,
       COALESCE(o.prod_offer_inst_id,r.prod_offer_inst_id) AS prod_offer_inst_id,
       o.his_id AS offer_his_id,o.prod_offer_id AS offer_id,
       CASE WHEN p.prod_inst_id IS NULL THEN '产品实例缺失'
            WHEN r.offer_prod_inst_rel_id IS NULL THEN '订购关系缺失'
            WHEN o.prod_offer_inst_id IS NULL THEN '销售品实例缺失'
            ELSE '档案主链已连接' END AS archive_status
FROM pg_temp.swq_products p
FULL JOIN pg_temp.swq_bridge r ON r.prod_inst_id=p.prod_inst_id
FULL JOIN pg_temp.swq_offers o ON o.prod_offer_inst_id=r.prod_offer_inst_id;
SELECT * FROM pg_temp.swq_path ORDER BY prod_inst_id,prod_offer_inst_id;
```

字段说明：

- product_his_id / bridge_his_id / offer_his_id 分别来自各自表，不假设三个表的 his_id 相同。
- 多个现存履历按业务 ID 关联后可能出现组合行，因此结果行数不是用户数，也不是某个时点的有效订购数。
- archive_status 标记产品、桥接、销售品缺失；外连接保留断点，不用内连接静默丢失。
- 查询跨表的多条语句不承诺同一时间快照；需要时先核对数据更新时段。本文不自动过滤状态或生效时间。

## P3. 属性、A/Z 关系、账户：原样接着执行

各条独立返回完整字段，自动使用 P2 中同一批产品和销售品 ID，不需要另抄 ID。

```sql
SELECT a.* FROM bill_inmemory.prod_inst_attr a
JOIN pg_temp.swq_pids k ON k.id=a.prod_inst_id;
SELECT a.* FROM bill_inmemory.prod_offer_inst_attr a
JOIN pg_temp.swq_oids k ON k.id=a.prod_offer_inst_id;
SELECT * FROM pg_temp.swq_p_rel;
SELECT * FROM pg_temp.swq_o_rel;
SELECT a.* FROM bill_inmemory.prod_inst_acct a
JOIN pg_temp.swq_pids k ON k.id=a.prod_inst_id;
SELECT a.* FROM bill_inmemory.account a
WHERE EXISTS(SELECT 1 FROM bill_inmemory.prod_inst_acct r
 JOIN pg_temp.swq_pids k ON k.id=r.prod_inst_id WHERE r.account_id=a.account_id);
```

当前实库缺少 prod_offer_member_inst/payment_plan，所以“客户群/银行群成员→销售品”未纳入上述链路；不要使用上一版中对这两张 PG 表的查询。

## P4. PG → 配置库 → PG：定价链往返

### P4.1 在 PG 生成本批的配置查询

直接执行下段，得到 offer_count 和 config_sql。它按本批全部去重销售品规格生成 IN 列表，不逐个抄 ID。

```sql
SELECT COUNT(*) AS offer_count,
CASE WHEN COUNT(*)>0 THEN 'SELECT o.offer_id,pp.pricing_plan_id,pp.pricing_plan_name,
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
 '') ON CONFLICT (row_key) DO NOTHING;'') AS pg_cache_sql
FROM offer o
LEFT JOIN pricing_plan pp ON pp.pricing_plan_id=o.pricing_plan_id
LEFT JOIN pricing_combine pc ON pc.pricing_plan_id=pp.pricing_plan_id
LEFT JOIN event_pricing_strategy e ON e.event_pricing_strategy_id=pc.event_pricing_strategy_id
LEFT JOIN pricing_object po ON po.pricing_object_id=pc.pricing_object_id
WHERE o.offer_id IN (' ||
 string_agg(offer_id::text,',' ORDER BY offer_id) || ')
ORDER BY o.offer_id,pc.pricing_combine_id;'
ELSE '-- 此批没有销售品规格 ID，先检查档案主链断点' END AS config_sql
FROM (SELECT DISTINCT offer_id FROM pg_temp.swq_path WHERE offer_id IS NOT NULL) ids;
```

### P4.2 在配置库执行生成的 config_sql

切到 **CONFIGDB_CNOS_JF_TEST 连接**，复制完整 config_sql 值执行。结果含销售品、计划、组合、策略、事件类型、对象引用及 config_status。

若 offer_count 为 0，结果是一行提示注释；先检查 P2 断点，别把空批次解释为配置查询成功。

### P4.3 把配置关联缓存带回 PG

复制配置结果中整列 pg_cache_sql，在原 PG 窗口以脚本方式逐条执行。每条都是针对 pg_temp.swq_cfg 的 INSERT，按 row_key 去重；中文名称通过 UTF-8 十六进制编码带回，避免引号和转义破坏语句。

再运行 P6 即可联看档案与定价。若需要完整配置原表字段，使用[定价文档](./定价计划查询SQL_高级附录.md) C1 的同批销售品入口及返回的各 *_sql 列。

## P5. PG → CRM3DB → PG：补齐产品定义

### P5.1 在 PG 生成产品规格查询

```sql
SELECT COUNT(*) AS product_count,
CASE WHEN COUNT(*)>0 THEN 'SELECT prod_id,prod_name,
CONCAT(''INSERT INTO pg_temp.swq_definition VALUES ('',prod_id,'',convert_from(decode('',CHAR(39),HEX(COALESCE(prod_name,'''')),CHAR(39),'','',CHAR(39),''hex'',CHAR(39),''),'',CHAR(39),''UTF8'',CHAR(39),'')) ON CONFLICT (product_id) DO NOTHING;'') AS pg_definition_sql
FROM product WHERE prod_id IN (' ||
 string_agg(product_id::text,',' ORDER BY product_id) || ') ORDER BY prod_id;'
ELSE '-- 此批没有产品规格 ID' END AS crm_sql
FROM (SELECT DISTINCT product_id FROM pg_temp.swq_path WHERE product_id IS NOT NULL) ids;
```

### P5.2 切换真正的 CRM3DB 连接

执行上一步完整 crm_sql。它查询 product.prod_id、prod_name，并返回 pg_definition_sql。

实测在 CONFIGDB_CNOS_JF_TEST 连接中写 CRM3DB.product 前缀仍报路由表错误；因此这里切换客户端连接/逻辑库，而不是只加前缀。

### P5.3 回填 PG 临时表

复制整列 pg_definition_sql 到原 PG 窗口执行，再运行 P6。产品定义查询为空时保留 product_id 和空名称，不用其他环境的同号定义代替。

## P6. 最终闭环结果：随时可重复查询

完成 P2 后可先查档案；P4/P5 导入后再查，会自动补齐定价与产品名称。

```sql
SELECT p.*,d.product_name,c.offer_name,c.plan_id,c.plan_name,c.combine_id,
c.strategy_id,c.event_type_id,c.object_id,c.config_status,
CASE WHEN p.archive_status<>'档案主链已连接' THEN p.archive_status
 WHEN c.offer_id IS NULL THEN '配置未回填或销售品定义未匹配'
 WHEN c.plan_id IS NULL THEN '定价计划缺失'
 WHEN c.combine_id IS NULL THEN '定价组合缺失'
 ELSE '已连接到定价组合' END AS chain_status
FROM pg_temp.swq_path p
LEFT JOIN pg_temp.swq_cfg c ON c.offer_id=p.offer_id
LEFT JOIN pg_temp.swq_definition d ON d.product_id=p.product_id
ORDER BY p.prod_inst_id,p.prod_offer_inst_id,c.combine_id;
```

一行可追溯：号码 → 产品实例/产品规格及名称 → 桥接关系 → 销售品实例/销售品规格及名称 → 计划 → 组合 → 策略/事件类型/对象引用。

chain_status 表示链路连接情况；配置断点继续看 config_status。空名称或空配置可能是尚未导入，也可能是真实缺失，结合 P4/P5 的返回行数判断。

## P7. 想继续查 A/Z 对端：自动把一跳结果追加到入口

这一步是**主动扩大查询范围**，不是默认全网递归。执行下段后重新 P2；接着 P3/P4/P5/P6 即可，P0 和 P1 不重跑。

```sql
INSERT INTO pg_temp.swq_input SELECT 'product',prod_inst_a_id::text FROM pg_temp.swq_p_rel
WHERE prod_inst_a_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO pg_temp.swq_input SELECT 'product',prod_inst_z_id::text FROM pg_temp.swq_p_rel
WHERE prod_inst_z_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO pg_temp.swq_input SELECT 'offer_instance',rela_prod_offer_inst_id::text FROM pg_temp.swq_o_rel
WHERE rela_prod_offer_inst_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO pg_temp.swq_input SELECT 'offer_instance',related_prod_offer_inst_id::text FROM pg_temp.swq_o_rel
WHERE related_prod_offer_inst_id IS NOT NULL ON CONFLICT DO NOTHING;
```

每次只扩展当前一跳；新增节点数量以 swq_input 为准。不要无限重复，群关系可能快速放大结果。

同批重复导入会保留首次缓存；若想重新抓取最新配置，先执行下面的临时缓存清理，再按 P4/P5 回填。不要仅重跑 P6 就认为拿到了远端最新数据。

```sql
TRUNCATE pg_temp.swq_cfg;
TRUNCATE pg_temp.swq_definition;
```

## 2. 本次真实核验结果

|检查|结果|
|---|---|
|PG 会话临时表|创建、写入、查询、删除均成功；只作用于会话|
|首批直接订购样本|最多取 10 个，当前返回 9 个产品实例|
|档案主链|77 条带履历的关联行，28 个销售品规格|
|配置查询与回填|491 条配置关联，28 个销售品均有定义；21 个非空计划 ID，另有缺计划记录|
|产品定义|CRM3DB 返回 1 条产品定义并回填成功|
|正向合并|1352 行，含一对多和履历组合，不是 1352 个用户|
|反向闭环|计划 12000812、12000815 → 销售品 → PG 订购 → 合并，18 行|
|PG 12 类入口|号码、产品、产品规格、客户、账户、销售品实例/规格、两类属性行、两类关系行、桥接行，全部有样本并执行成功|
|A/Z 扩展|自动追加端点后重新查询成功|
|缺失分支|prod_offer_member_inst/payment_plan 已通过直接 SELECT 验证缺表，没有写成可运行查询|

这些计数是核验时快照，后续环境变化后可能不同；“脚本已验证”不等于每个任意输入必然有完整数据。本次没有修改应用代码或业务档案。

本机证据：[执行记录](../../outputs/sql-chain-verify/verified.json)、[结构记录](../../outputs/sql-chain-verify/probe.json)、[查询能力记录](../../outputs/sql-chain-verify/capabilities.json)。outputs 不提交，文档中的 SQL 可独立复制执行。

[PostgreSQL 临时表说明](https://www.postgresql.org/docs/12/sql-createtable.html)：临时表随会话结束清理；本文保留默认的提交后保留行行为，以便多步骤接力。
