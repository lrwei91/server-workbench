import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "cdr"))
import app as cdr_app
import engine
import intake


def record(n=1, **updates):
    return {"COLLECT_CDR_ID": 1000000000000000000 + n, "ORG_CDR_ID": f"261101000000{n:08d}",
            "CJ_START_TIME": "20261101000000", "ORG_START_TIME": "26110100000001", **updates}


def ndjson(*objects):
    return b"".join(json.dumps(obj).encode("utf-8") + b"\n" for obj in objects)


class IntakeTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.source = Path(tmp.name) / "source"
        self.output = Path(tmp.name) / "output"
        self.source.mkdir()
        self.output.mkdir()

    def prepare(self, files, period="202611", field="CJ_START_TIME"):
        return intake.prepare(files, period, field, self.source, self.output)

    def test_package_preserves_sources_and_exact_ids(self):
        source = ndjson(record(), {"TICKET_COUNT": 1}).rstrip(b"\n")
        (self.source / "a.TXT").write_bytes(source)
        (self.output / "b.dat").write_bytes(ndjson(record(2), {"TICKET_COUNT": 1}))
        (self.source / "ignore.csv").touch()
        self.assertEqual([f["name"] for f in intake.list_files(self.source, self.output)["source"]], ["a.TXT"])
        result = self.prepare([("source", "a.TXT"), ("export", "b.dat")], field="ORG_START_TIME")
        folder = Path(result["output_path"])
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual((manifest["file_count"], manifest["record_count"], manifest["status"]), (2, 2, "prepared"))
        self.assertEqual(manifest["input_dir"], "prep/normal/input/591/")
        self.assertEqual(len(list((folder / "data").iterdir())), 2)
        self.assertEqual((self.source / "a.TXT").read_bytes(), source)
        first = manifest["files"][0]
        data = (folder / "data" / first["name"]).read_bytes()
        self.assertEqual(data, source + b"\n")
        self.assertEqual(first["size_bytes"], len(data))
        self.assertEqual(first["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(first["collect_cdr_ids"], ["1000000000000000001"])
        self.assertNotIn("collect_cdr_ids", result["files"][0])
        sql = (folder / "verify.sql").read_text(encoding="utf-8")
        self.assertIn("'1000000000000000001', '1000000000000000002'", sql)
        self.assertIn("__ACTUAL_DORIS_TABLE__", sql)
        script = (folder / "submit.sh").read_text(encoding="utf-8")
        self.assertLess(script.index("sha256sum -c"), script.index("hadoop fs -put"))
        self.assertLess(script.index("hadoop fs -put"), script.index("hadoop fs -mv"))
        self.assertEqual(script.count("hadoop fs -mv"), 1)
        self.assertNotIn("hadoop fs -rm", script)
        self.assertTrue((folder / "shots").is_dir())

    def test_invalid_inputs_leave_no_package(self):
        valid = ndjson(record(), {"TICKET_COUNT": 1})
        for data, message in [
            (b"\xef\xbb\xbf" + valid, "UTF-8 无 BOM"),
            (valid.replace(b"\n", b"\r\n"), "LF 换行"),
            (b"\xff\n", "有效的 UTF-8 JSON"),
            (valid + b"\n", "最后一行"),
            (ndjson(record()), "缺少 TICKET_COUNT"),
            (ndjson(record(), {"TICKET_COUNT": True}), "实际非零记录数"),
            (ndjson(record(), {"TICKET_COUNT": 2}), "实际非零记录数"),
            (ndjson(record(COLLECT_CDR_ID=1), {"TICKET_COUNT": 1}), "19 位"),
            (ndjson(record(ORG_CDR_ID="short"), {"TICKET_COUNT": 1}), "20 位"),
            (ndjson(record(CJ_START_TIME="20261131000000"), {"TICKET_COUNT": 1}), "时间格式"),
            (ndjson(record(CJ_START_TIME="20261001000000"), {"TICKET_COUNT": 1}), "与目标账期"),
        ]:
            with self.subTest(message=message):
                (self.source / "a.json").write_bytes(data)
                with self.assertRaisesRegex(ValueError, message):
                    self.prepare([("source", "a.json")])
                self.assertEqual(list((self.output / "intake").iterdir()), [])

    def test_duplicate_id_across_files_and_record_limit(self):
        (self.source / "a.json").write_bytes(ndjson(record(), {"TICKET_COUNT": 1}))
        second = self.source / "b.dat"
        second.write_bytes(ndjson(record(COLLECT_CDR_ID="1000000000000000001"), {"TICKET_COUNT": 1}))
        files = [("source", "a.json"), ("source", "b.dat")]
        with self.assertRaisesRegex(ValueError, "b.dat 第 1 行.*重复.*a.json"):
            self.prepare(files)
        second.write_bytes(ndjson(record(2), {"TICKET_COUNT": 1}))
        with patch.object(engine, "MAX_RECORDS", 1):
            with self.assertRaisesRegex(ValueError, "总记录数超过 1"):
                self.prepare(files)

    def test_api_rejects_bad_paths_and_leaves_session_unchanged(self):
        (self.source / "a.json").write_bytes(ndjson(record(), {"TICKET_COUNT": 1}))
        with patch.multiple(engine, SOURCE_DIR=self.source, OUTPUT_DIR=self.output):
            client = TestClient(cdr_app.app)
            before = client.get("/api/session").json()
            self.assertEqual(client.get("/api/intake/files").json()["source"][0]["name"], "a.json")
            payload = {"period": "202611", "period_field": "CJ_START_TIME"}
            post = lambda names: client.post("/api/intake/prepare", json={
                **payload, "files": [{"scope": "source", "name": name} for name in names],
            })
            self.assertEqual(post(["a.json"] * 11).status_code, 422)
            self.assertEqual(post(["a.json"] * 2).status_code, 400)
            self.assertEqual(post(["../a.json"]).status_code, 400)
            self.assertEqual(post(["a.json"]).status_code, 200)
            self.assertEqual(client.get("/api/session").json(), before)
