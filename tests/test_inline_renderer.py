"""Both real XLSX writers support editing the same primary table structure."""
import json
import os
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

import openpyxl

from sop.xlsx_export import write_export_workbook

ROOT = Path(__file__).resolve().parents[1]
MONTHS = [f"{year}-{month:02}" for year in (2026, 2027) for month in range(1, 13)]
PRODUCTS = [{"id": "a", "brand": "问界", "model": "M5", "version": "Max", "active": True},
            {"id": "b", "brand": "问界", "model": "M5", "version": "Ultra", "active": False, "end_month": "2026-09"},
            {"id": "c", "brand": "智界", "model": "R7", "version": "=1+1", "active": True}]
PLANS = [{"product_id": "a", "month": "2026-08", "sop": 10, "revision": 1},
         {"product_id": "a", "month": "2026-10", "sop": 0, "revision": 1},
         {"product_id": "a", "month": "2026-12", "sop": 30, "revision": 1},
         {"product_id": "b", "month": "2026-08", "sop": 20, "revision": 1},
         {"product_id": "b", "month": "2026-12", "sop": 40, "revision": 1},
         {"product_id": "c", "month": "2026-08", "sop": 5, "revision": 1},
         {"product_id": "c", "month": "2026-10", "sop": 0, "revision": 1}]
LOOKUP = {(p["product_id"], p["month"]): p for p in PLANS}


def sum_known(values):
    values = [v for v in values if v is not None]
    return sum(values) if values else None


def export_payload(months=MONTHS, locks=False, versions=True):
    groups = {}
    for p in PRODUCTS:
        groups.setdefault((p["brand"], p["model"]), []).append(p)
    rows, annual, ids, counts = [], [], [], []
    for (brand, model), group in groups.items():
        sources = [(group, False)] + ([( [p], True) for p in group] if versions else [])
        for members, detail in sources:
            for metric in (["锁单数", "SOP计划量"] if locks else ["SOP计划量"]):
                values = [sum_known(LOOKUP.get((p["id"], m), {}).get("sop") for p in members) if metric == "SOP计划量" else (70 if not detail and m == "2026-08" else None) for m in months]
                totals, known = {}, {}
                for year in {m[:4] for m in months if m.endswith("-12")}:
                    monthly = [sum_known(LOOKUP.get((p["id"], f"{year}-{m:02}"), {}).get("sop") for p in members) for m in range(1, 13)]
                    totals[year] = sum_known(monthly) if metric == "SOP计划量" else None
                    known[year] = sum(v is not None for v in monthly) if metric == "SOP计划量" else 0
                rows.append(["版本明细" if detail else "车型汇总", brand, model, *([members[0]["version"] if detail else ""] if versions else []), metric, *values, ""])
                annual.append(totals); counts.append(known); ids.append(members[0]["id"] if detail else None)
    revisions = {p["id"]: {m: LOOKUP[(p["id"], m)]["revision"] for m in months if (p["id"], m) in LOOKUP}
                 for p in PRODUCTS}
    editable = {p["id"]: [m for m in months if p.get("end_month", "9999-12") >= m] for p in PRODUCTS}
    return {"schema_version": 1, "current_month": "2026-10", "months": list(months), "include_locks": locks,
            "include_versions": versions, "scope": "验收", "rows": rows, "annual_plans": annual,
            "headers": ["层级", "品牌", "车型", *(["版本"] if versions else []), "指标", *months, "数据说明"],
            "roundtrip": {"inline_schema": 2, "token": "0123456789abcdef0123456789abcdef", "products": PRODUCTS,
                "row_product_ids": ids, "annual_known_counts": counts, "plan_revisions_by_product": revisions,
                "editable_months_by_product": editable, "manual_editable_months": list(months)}}


def manifest(book):
    meta = book["_sop_import"]
    return json.loads("".join(row[1] for row in meta.iter_rows(min_row=6, values_only=True)))


class InlineRendererTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(temp.cleanup)
        for name, body in (("export", export_payload()), ("partial", export_payload(["2026-10","2026-12","2027-02"], locks=True)),
                           ("report", export_payload(["2026-12"], versions=False))):
            path = Path(temp.name) / (name + ".xlsx")
            write_export_workbook({**body, "output_path": str(path)})
            setattr(cls, name, path)

    def test_row_identity_and_inactive_rows_remain_attached_to_data(self):
        wb = openpyxl.load_workbook(self.partial)
        sheet, meta = wb["SOP计划"], wb["_sop_import"]
        self.assertEqual(meta.sheet_state, "veryHidden")
        self.assertEqual(meta["B1"].value, 2)
        spec = manifest(wb)
        for row in spec["rows"]:
            r = row["row"]
            self.assertEqual(sheet.cell(r, spec["key_column"]).value, row["key"])
            self.assertEqual(sheet.cell(r, spec["kind_column"]).value, row["kind"])
            if row["kind"] == "product":
                self.assertEqual(sheet.cell(r, spec["product_column"]).value, row["product_id"])
                self.assertEqual([sheet.cell(r, c).value for c in (1, 2, 3)], row["labels"])
                self.assertEqual(sheet.row_dimensions[r].hidden, row["product_id"] == "b")
        self.assertFalse(sheet.protection.sheet, "Excel must permit real row insertion/deletion")
        for c in (spec["product_column"], spec["kind_column"], spec["key_column"]):
            self.assertTrue(sheet.column_dimensions[openpyxl.utils.get_column_letter(c)].hidden)
        plan = next(r for r in spec["rows"] if r["key"] == "plan:c")
        self.assertEqual(sheet.cell(plan["row"], 3).data_type, "s")
        self.assertEqual(sheet.cell(plan["row"], 3).value, "=1+1")

    def test_summary_only_supports_model_inputs_without_extra_area(self):
        wb = openpyxl.load_workbook(self.report)
        self.assertFalse(wb["_sop_import"]["B3"].value)
        sheet = wb["SOP计划"]
        self.assertFalse(sheet.protection.sheet)
        self.assertFalse(sheet["C5"].protection.locked)
        self.assertEqual(sheet["A1"].value, "SOP计划表")
        self.assertEqual(sheet["C1"].value, "2026-12")
        self.assertEqual(sheet["A5"].value, "智界")
        self.assertIn("A5:A6", {str(area) for area in sheet.merged_cells.ranges})
        for letter in "EFG":
            self.assertTrue(sheet.column_dimensions[letter].hidden)
            self.assertEqual(sheet.column_dimensions[letter].width, 0)
        self.assertTrue(all(r["kind"] != "manual_entry" for r in manifest(wb)["rows"]))
        self.assertTrue(manifest(wb)["model_inputs"])

    def test_hidden_flag_is_standard_boolean_without_modern_checkbox_extensions(self):
        for path, versions in ((self.export, True), (self.partial, True), (self.report, False)):
            with self.subTest(path=path.name):
                workbook = openpyxl.load_workbook(path)
                try:
                    flag = workbook["_sop_import"]["B3"]
                    self.assertEqual(flag.data_type, "b")
                    self.assertIs(flag.value, versions)
                finally:
                    workbook.close()
                with zipfile.ZipFile(path) as archive:
                    self.assertFalse(any("featurepropertybag" in name.lower()
                                         for name in archive.namelist()))
                    for name in ("xl/styles.xml", "xl/_rels/workbook.xml.rels", "[Content_Types].xml"):
                        xml = archive.read(name).lower()
                        self.assertNotIn(b"featurepropertybag", xml, name)
                        self.assertNotIn(b"xfcomplement", xml, name)


    @unittest.skipUnless(os.name == "nt" and os.environ.get("SOP_TEST_EXCEL_NATIVE") == "1",
                         "Desktop Excel test is opt-in")
    def test_partial_year_formulas_keep_offscreen_amount_and_recalculate(self):
        book = openpyxl.load_workbook(self.partial)
        try:
            row = next(r["row"] for r in manifest(book)["rows"] if r["key"] == "plan:a")
        finally:
            book.close()
        subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                        str(ROOT / "tests/verify_excel_native.ps1"), "-Paths", str(self.partial),
                        "-AnnualFixtureRow", str(row)], check=True, capture_output=True, timeout=90)


if __name__ == "__main__":
    unittest.main()
