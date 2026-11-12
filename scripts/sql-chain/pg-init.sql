DROP TABLE IF EXISTS pg_temp.swq_input;
DROP TABLE IF EXISTS pg_temp.swq_cfg;
DROP TABLE IF EXISTS pg_temp.swq_definition;
CREATE TEMP TABLE swq_input(kind text, id text, PRIMARY KEY(kind,id));
CREATE TEMP TABLE swq_cfg(row_key text PRIMARY KEY, offer_id bigint, plan_id bigint,
  combine_id bigint, strategy_id bigint, event_type_id bigint, object_id bigint,
  offer_name text, plan_name text, config_status text);
CREATE TEMP TABLE swq_definition(product_id bigint PRIMARY KEY, product_name text);
