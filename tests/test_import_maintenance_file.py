"""Excel imports update the database without writing the historical server-side file."""
import io
import os
import unittest
from unittest.mock import patch

import openpyxl

from sop.paths import PLAN_WORKBOOK_NAME
from sop.roundtrip import PlanRoundtrip
from sop.store import ValidationError
from tests import test_model_export_roundtrip as support
from tests.xlsx_edits import edit_cell


class ImportMaintenanceFileTest(unittest.TestCase):
    def setUp(self):
        self.f = support.ModelExportRoundtripTest()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.project = self.f.root / "SOP维护"
        self.project.mkdir()
        self.shared = self.f.root / "工作台数据" / "shared"
        self.shared.mkdir(parents=True)
        environment = patch.dict(os.environ, {"SHARED_DATA_ROOT": "../工作台数据/shared", "SOP_PLAN_DIR": ""})
        environment.start()
        self.addCleanup(environment.stop)
        self.path = self.shared / "SOP计划" / PLAN_WORKBOOK_NAME
        self.path.parent.mkdir(parents=True)
        self.f.service = PlanRoundtrip(self.f.store)
        self.assertEqual(list(self.path.parent.iterdir()), [])

    def plain(self, *rows):
        book = openpyxl.Workbook()
        sheet = book.active
        sheet.title = "SOP计划"
        sheet.append(["品牌", "车型", "2026-10", "2027-03"])
        for row in rows:
            sheet.append(row)
        content = io.BytesIO()
        book.save(content)
        book.close()
        return content.getvalue()

    def assert_no_maintenance(self):
        self.assertFalse(self.path.exists())
        self.assertEqual(list(self.path.parent.iterdir()), [])
        self.assertFalse((self.project / "input_file").exists())

    def assert_database_values(self, expected):
        self.assert_no_maintenance()
        for (product, month), quantity in expected.items():
            self.assertEqual(self.f.value(product, month), quantity)

    def test_start_web_save_and_download_leave_the_shared_plan_directory_empty(self):
        revision = self.f.store.db.execute(
            "SELECT revision FROM plans WHERE product_id='c' AND month='2026-10'").fetchone()[0]
        result = self.f.store.save_plans({"owner": "网页", "changes": [{
            "product_id": "c", "month": "2026-10", "sop": 6, "forecast": None, "revision": revision}]})
        self.f.export()
        self.assert_no_maintenance()

    def test_plain_import_updates_only_database(self):
        parent = self.f.model_id("Together 2026款")
        first = self.plain(["智界", "Together 2026款", 321, 0])
        result = self.f.service.import_content(first)
        self.assertTrue(result["ok"], result)
        self.assert_database_values({(parent, "2026-10"): 321, (parent, "2027-03"): 0})
        second = self.plain(["智界", "Together 2026款", 322, 0])
        conflict = self.f.service.import_content(second)
        self.assertEqual(conflict["status"], "conflict")
        updated = self.f.service.import_content(second, choice="workbook", confirmation_token=conflict['confirmation_token'])
        self.assertTrue(updated["ok"], updated)
        self.assert_database_values({(parent, "2026-10"): 322, (parent, "2027-03"): 0})
        self.assertEqual((self.f.value("a"), self.f.value("b")), (10, 20))

    def test_tracked_import_updates_database_without_copy(self):
        parent = self.f.model_id("Together 2026款")
        for amount in (123, 456):
            with self.subTest(amount=amount):
                self.f.export()
                if amount == 123:
                    self.assert_no_maintenance()
                edit_cell(self.f.path, self.f.address("Together 2026款"), amount)
                result = self.f.import_file()
                self.assertTrue(result["ok"], result)
                self.assert_database_values({(parent, "2026-10"): amount})

    def assert_repeat_preserves_database_and_directory(self, content):
        parent = self.f.model_id("Together 2026款")
        previous_service = PlanRoundtrip(self.f.store)
        first = previous_service.import_content(content)
        self.assertTrue(first["ok"], first)
        self.assertEqual(first["imported"], 1)
        self.assert_no_maintenance()
        revision = self.f.store.db.execute(
            "SELECT revision FROM plans WHERE product_id=? AND month='2026-10'", (parent,)).fetchone()[0]
        repeated = self.f.service.import_content(content)
        self.assertTrue(repeated["ok"], repeated)
        self.assertEqual((repeated["imported"], repeated["created"]), (0, 0))
        self.assert_database_values({(parent, "2026-10"): 321})
        self.assertEqual(self.f.store.db.execute(
            "SELECT revision FROM plans WHERE product_id=? AND month='2026-10'", (parent,)).fetchone()[0], revision)

    def test_reimporting_an_already_accepted_plain_file_preserves_values_without_writing_files(self):
        self.assert_repeat_preserves_database_and_directory(self.plain(["智界", "Together 2026款", 321]))

    def test_reimporting_an_already_accepted_tracked_file_preserves_values_without_writing_files(self):
        self.f.export()
        edit_cell(self.f.path, self.f.address("Together 2026款"), 321)
        self.assert_repeat_preserves_database_and_directory(self.f.path.read_bytes())

    def test_invalid_plain_input_and_unresolved_conflict_do_not_create_a_file(self):
        parent = self.f.model_id("Together 2026款")
        invalid = self.plain(["智界", "Together 2026款", 321], ["享界", "Future 2027款", "=1+1"])
        with self.assertRaises(ValidationError):
            self.f.service.import_content(invalid)
        self.assertIsNone(self.f.value(parent))
        self.assert_no_maintenance()
        self.f.save(parent, 80)
        result = self.f.service.import_content(self.plain(["智界", "Together 2026款", 99]))
        self.assertEqual(result["status"], "conflict")
        self.assertEqual(self.f.value(parent), 80)
        self.assert_no_maintenance()

    def test_unresolved_tracked_conflict_does_not_create_a_file(self):
        parent = self.f.model_id("Together 2026款")
        self.f.export()
        edit_cell(self.f.path, self.f.address("Together 2026款"), 99)
        self.f.save(parent, 85)
        result = self.f.import_file()
        self.assertEqual(result["status"], "conflict")
        self.assertEqual(self.f.value(parent), 85)
        self.assert_no_maintenance()

    def test_existing_server_copy_is_never_replaced(self):
        self.path.write_bytes(b"retired workbook")
        result = self.f.service.import_content(self.plain(["智界", "Together 2026款", 321]))
        self.assertTrue(result["ok"], result)
        self.f.export()
        self.assertEqual(self.path.read_bytes(), b"retired workbook")


if __name__ == "__main__":
    unittest.main()
