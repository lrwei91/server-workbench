INSERT INTO pg_temp.swq_input SELECT 'product',prod_inst_a_id::text FROM pg_temp.swq_p_rel
WHERE prod_inst_a_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO pg_temp.swq_input SELECT 'product',prod_inst_z_id::text FROM pg_temp.swq_p_rel
WHERE prod_inst_z_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO pg_temp.swq_input SELECT 'offer_instance',rela_prod_offer_inst_id::text FROM pg_temp.swq_o_rel
WHERE rela_prod_offer_inst_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO pg_temp.swq_input SELECT 'offer_instance',related_prod_offer_inst_id::text FROM pg_temp.swq_o_rel
WHERE related_prod_offer_inst_id IS NOT NULL ON CONFLICT DO NOTHING;
