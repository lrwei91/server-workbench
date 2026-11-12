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
