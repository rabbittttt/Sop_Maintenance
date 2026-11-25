"""Start the built release against an isolated database and round-trip an actual download."""
import base64
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import URLError
from urllib.request import Request, urlopen

import openpyxl

from scripts.build_release import ROOT, build_release


class ReleaseSmokeTest(unittest.TestCase):
    def test_packaged_service_can_edit_and_reimport_a_download(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            release = root / "release"
            manifest = build_release(ROOT, release)
            names = {entry["path"] for entry in manifest["files"]}
            self.assertFalse(any(p.startswith("scripts/") for p in names))
            data = root / "data"
            data.mkdir()
            (data / "sales.json").write_text(json.dumps({
                "meta": {}, "products": [{"id": "fixture", "brand": "智界", "model": "A", "version": "Max",
                                           "generation": "智界 A 2027款"}],
                "sales": [], "model_sales": []}), encoding="utf-8")
            env = {**os.environ, "PLANHUB_DATA_ROOT": str(root), "SOP_DATA_DIR": str(data),
                   "SOP_LOG_DIR": str(root / "logs"), "SHARED_DATA_ROOT": str(root / "shared"),
                   "SOP_SOURCE_DIR": str(root / "input"), "SOP_SHARED_CONFIG": str(ROOT / "tests/fixtures/shared_config.py")}
            env["PYTHONIOENCODING"] = "cp1252:strict"
            executable = sys.executable
            if os.name == "nt" and sys.prefix != sys.base_prefix:
                # Launch the worker directly so its PID and lifetime match Popen.
                env["__PYVENV_LAUNCHER__"] = sys.executable
                executable = sys._base_executable
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]

            def request(path, body=None):
                payload = None if body is None else json.dumps(body).encode()
                req = Request(f"http://127.0.0.1:{port}/" + path, data=payload, headers={"Content-Type": "application/json"})
                with urlopen(req, timeout=15) as response:
                    return response.read()

            with (root / "launch.log").open("wb") as log:
                proc = subprocess.Popen([executable, str(release / "server.py"), "--port", str(port)],
                                        cwd=root, env=env, stdout=log, stderr=log)
                try:
                    for _ in range(100):
                        if proc.poll() is not None:
                            self.fail((root / "launch.log").read_text(encoding="utf-8", errors="replace"))
                        try:
                            health = json.loads(request("api/health"))
                            break
                        except URLError:
                            time.sleep(.1)
                    else:
                        self.fail("The packaged service did not start")
                    self.assertEqual(health["pid"], proc.pid)
                    self.assertEqual(Path(health["workspace"]), release)
                    launch_log = (root / "launch.log").read_text(encoding="utf-8")
                    self.assertIn("SOP管理已就绪", launch_log)
                    html = request("").decode()
                    for module in ("plan-excel.js", "option-split.js", "history.js", "app.js"):
                        self.assertIn(module, html)
                        self.assertEqual(request(module), (release / "web" / module).read_bytes())
                    state = json.loads(request("api/state"))
                    item = next(p for p in state["products"] if p["id"] == "fixture")
                    month = state["current_month"]
                    rows = [["车型汇总", item["brand"], item["model"], "", "SOP计划量", None, ""],
                            ["版本明细", item["brand"], item["model"], item["version"], "SOP计划量", None, ""]]
                    body = {"schema_version": 1, "current_month": month, "months": [month], "include_versions": True,
                            "include_locks": False, "scope": "packaged fixture", "headers":
                            ["层级", "品牌", "车型", "版本", "指标", month, "数据说明"], "rows": rows,
                            "annual_plans": [{month[:4]: None} if month.endswith("-12") else {} for _ in rows],
                            "selected_product_ids": [item["id"]], "row_product_ids": [None, item["id"]]}
                    workbook = openpyxl.load_workbook(io.BytesIO(request("api/plans/export-xlsx", body)))
                    try:
                        sheet = workbook["SOP计划"]
                        row = next(r[0].row for r in sheet if any(c.value == "plan:fixture" for c in r))
                        sheet.cell(row, 4).value = 3000
                        contents = io.BytesIO()
                        workbook.save(contents)
                    finally:
                        workbook.close()
                    result = json.loads(request("api/plans/import-xlsx", {"filename": "fixture.xlsx",
                        "content_base64": base64.b64encode(contents.getvalue()).decode()}))
                    self.assertEqual(result["imported"], 1, result)
                    plans = json.loads(request("api/state"))["plans"]
                    self.assertTrue(any(p["product_id"] == "fixture" and p["month"] == month and p["sop"] == 3000 for p in plans))
                finally:
                    proc.terminate()
                    proc.wait(timeout=10)
