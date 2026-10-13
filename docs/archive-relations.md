# 档案查询与关系链

## 查询来源

|内容|来源|主要表|
|---|---|---|
|产品、账户、实例关系及属性|PostgreSQL `bill_inmemory`|prod_inst、prod_inst_rel、prod_inst_attr、prod_inst_acct、account|
|销售品实例、实例属性和关系|PostgreSQL `bill_inmemory`|prod_offer_inst、prod_offer_inst_attr、prod_offer_inst_rel、offer_prod_inst_rel|
|非产品成员及支付方案|PostgreSQL `bill_inmemory`|prod_offer_member_inst、payment_plan|
|套餐定义、定价计划、事件配置|MySQL/UDAL `CONFIGDB_CNOS_JF_TEST`|offer、pricing_plan、event_pricing_strategy、pricing_combine、事件格式及路由表|

阈值查询的六档提醒值来自PG `prod_inst_attr`，属于实例属性，不因原界面使用“配置”二字就转查MySQL。`payment_plan`是支付方案，`pricing_plan`是定价计划，二者不互相映射。PG现存 `offer_ces` 不再作为固定查询中的套餐配置来源。

## 号码与实例

业务号码（手机、固话、宽带）是 `prod_inst.acc_nbr`；产品实例标识是 `prod_inst_id`。号码用于定位产品实例，不是实例本身，也不保证只有一条记录：不同实例和履历可能共享该号码。实例档案查现存版本，不按当前状态筛掉历史，不等同于计费时间点的有效履历。

## 新增关系场景

接口 `POST /api/query/relations` 仅接受固定 `mode`、`id` 以及对端检查的 `peerProductInstanceId` / 可选 `peerAccountId`。`GET /api/query/relations/catalog` 返回场景与链路说明。页面各场景的输入标签随所选模式变化。

|mode|输入|链路|
|---|---|---|
|product-offers|产品实例ID|产品→订购关系→销售品实例→MySQL销售品与定价|
|function-offers|接入产品实例ID|产品关系A→Z（100600）→功能产品→销售品；列出10030候选|
|group-offers|成员产品实例ID|产品关系Z→A→群主候选→销售品|
|offer-links-a|A端销售品实例ID|rela_prod_offer_inst_id→related_prod_offer_inst_id|
|offer-links-z|Z端销售品实例ID|related_prod_offer_inst_id→rela_prod_offer_inst_id|
|offer-members|销售品实例ID|直接产品关系→产品；候选A→Z再展开一层|
|function-members|组合功能销售品实例ID|功能产品→产品关系Z→A→主产品候选|
|customer-offers|已核实默认电信账户ID|account.cust_id→CLASS_ID=1 / MEMBER_ID→销售品|
|account-offers|已核实默认电信账户ID|CLASS_ID=137 / MEMBER_ID→销售品|
|bank-offers|已核实默认电信账户ID|payment_plan银行ID与账号组合→CLASS_ID=2001→销售品|
|account-products|账户ID|prod_inst_acct→产品实例；保留账户关系类型|
|group-members|非产品群销售品实例ID|成员表→客户/账户/银行→账户关系→产品|
|inner-call|销售品实例ID＋对端产品实例ID|直接成员、对端群主候选、Z端销售品成员；可附对端默认账户检查三类非产品群|

关系诊断与“实例查档案”范围不同：前者明确按所选链路反查成员，后者维持根节点一跳、关联节点不展开兄弟的边界。诊断每分支最多500行、每组关联ID最多100个、累计读取最多5000行，触达上限标为部分完成。群主/功能产品类型、默认账户枚举以及状态/时间/角色过滤仍需用实际数据字典判断。未核对的物理表或字段错误在对应步骤展示，不将错误当无记录。

## 可选包规则提示

- 30030引用可选、30010产品关联可选：接入产品直接入口取价，销售品A→Z取价入口过滤。
- 30020销售品关联可选：A→Z取价入口取，接入产品直接入口不是正常路径。
- 群内关系检查是另一流程，可能需要检查Z端30010成员；不能照搬取价过滤。

界面保留原始候选并附规则提示，不据这些关系直接宣称用户当前享受该优惠。尤其对端检查中的Z端记录未直接按IBS类型筛掉；需结合返回销售品实例、MySQL定义与类型提示核对30010。文档未明确的排序和连续性时间字段映射未猜写为自动判定逻辑。

## 读取与验证边界

PG固定SELECT使用驱动位置参数 `$1...`、明确Schema、只读Repeatable Read事务、15秒单语句超时，保留日期和大整数原值。当前每次PG语句独立只读事务，整条关系链不承诺同一快照；跨MySQL/PG更不表示一个全局事务。用户取消释放PG客户端，不提交档案写操作。

节点历史保留以数据库现存 `his_id` 为准；不补造已清理历史。已有实例档案分页路径继续使用主键+his_id；新增关系诊断采用有界候选查询，非全量成员导出。真实数据库表结构/权限、默认账户枚举和本地网特例需部署后验证。
