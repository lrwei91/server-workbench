import json
import tempfile
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "cdr"))
import engine  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
import app as cdr_app  # noqa: E402


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.old = (engine.SOURCE_DIR, engine.OUTPUT_DIR, engine.LOG_DIR)
        engine.SOURCE_DIR = self.root
        engine.OUTPUT_DIR = self.root / "out"
        engine.LOG_DIR = self.root / "log"
        engine._session.reset()

    def tearDown(self):
        engine.SOURCE_DIR, engine.OUTPUT_DIR, engine.LOG_DIR = self.old
        engine._session.reset()
        self.tmp.cleanup()

    def write(self, name, lines):
        (self.root / name).write_text("\n".join(json.dumps(item, ensure_ascii=False) for item in lines) + "\n", encoding="utf-8")

    def test_mixed_numeric_infers_float_and_bad_ndjson_reports_line(self):
        self.write("ok.json", [{"SOURCE_TYPE_ID": 3, "VALUE": 1}, {"SOURCE_TYPE_ID": 3, "VALUE": 1.5}, {"TICKET_COUNT": 2}])
        result = engine.load_file("ok.json")
        self.assertEqual(result["total_records"], 2)
        self.assertIs(engine._session.schema_by_type[3]["vtypes"]["VALUE"], float)
        (self.root / "bad.json").write_text('{"SOURCE_TYPE_ID":3}\nnot-json\n', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "第 2 行"):
            engine.load_file("bad.json")
        self.assertEqual(engine._session.filename, "ok.json")  # 解析失败不会替换当前会话

    def test_generation_ids_and_schema_refresh(self):
        self.write("ids.json", [{"SOURCE_TYPE_ID": 3, "COLLECT_CDR_ID": 7, "REC_SEQ": 9, "ORG_CDR_ID": "260831120000AB", "CDR_KEY": "1_0_260831120000_1_1_00"}, {"TICKET_COUNT": 1}])
        engine.load_file("ids.json")
        result = engine.batch_generate([0], 1)
        self.assertEqual(result["generated"], 1)
        generated = engine._session.records[-1]
        self.assertEqual(generated["COLLECT_CDR_ID"], 8)
        self.assertEqual(len(engine._session.biz_counts), 1)
        engine.undo()
        regenerated = engine.batch_generate([0], 1)
        self.assertEqual(engine._session.records[-1]["COLLECT_CDR_ID"], 8)
        self.assertEqual(regenerated["generated"], 1)

    def test_org_id_is_unique_and_cannot_be_cleared(self):
        self.write("org.json", [{"SOURCE_TYPE_ID": 3, "ORG_CDR_ID": "260831120000AB"}, {"TICKET_COUNT": 1}])
        engine.load_file("org.json")
        result = engine.update_record(0, {"ORG_CDR_ID": ""})
        self.assertFalse(result["ok"])
        self.assertIn("不能置空", result["errors"][0])

    def test_batch_preview_matches_apply_and_requires_filter(self):
        self.write("batch.json", [{"SOURCE_TYPE_ID": 3, "VALUE": 1}, {"SOURCE_TYPE_ID": 3, "VALUE": 2}, {"TICKET_COUNT": 2}])
        engine.load_file("batch.json")
        filters = [{"field": "VALUE", "op": "eq", "value": 1}]
        preview = engine.batch_update(filters, {"VALUE": "3"}, True)
        applied = engine.batch_update(filters, {"VALUE": "3"}, False)
        self.assertEqual(len(preview["preview"]), applied["applied"])
        with self.assertRaisesRegex(ValueError, "筛选条件"):
            engine.batch_update([], {"VALUE": "4"}, False)

    def test_atomic_export_validation(self):
        self.write("export.json", [{"SOURCE_TYPE_ID": 3, "VALUE": 1}, {"TICKET_COUNT": 1}])
        engine.load_file("export.json")
        result = engine.export()
        self.assertTrue(result["validations"]["ok"])
        self.assertTrue(result["validations"]["org_cdr_id_unique"])
        self.assertTrue(Path(result["exported_path"]).exists())
        self.assertTrue(engine.get_session()["dirty"] is False)

    def test_api_revision_conflict_and_generate_cap(self):
        self.write("api.json", [{"SOURCE_TYPE_ID": 3, "VALUE": 1}, {"TICKET_COUNT": 1}])
        client = TestClient(cdr_app.app)
        self.assertEqual(client.post("/api/load", json={"filename": "api.json"}).status_code, 200)
        revision = client.get("/api/session").json()["revision"]
        self.assertEqual(client.post("/api/record/0", json={"updates": {"VALUE": "2"}, "expected_revision": revision}).status_code, 200)
        conflict = client.post("/api/record/0", json={"updates": {"VALUE": "3"}, "expected_revision": revision})
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()["error"]["code"], "REVISION_CONFLICT")
        old_limit = engine.MAX_RECORDS
        engine.MAX_RECORDS = 1
        try:
            with self.assertRaisesRegex(ValueError, "超过上限"):
                engine.batch_generate([0], 1)
        finally:
            engine.MAX_RECORDS = old_limit


if __name__ == "__main__":
    unittest.main()
