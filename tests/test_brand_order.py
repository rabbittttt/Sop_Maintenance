"""Brand ordering is shared by the catalog and both editable Excel writers."""
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import openpyxl

from sop.brand import BRAND_ORDER, brand_order_key
from sop.roundtrip import PlanRoundtrip
from sop.store import SOPStore, TZ
from sop.xlsx_export import _layout, write_export_workbook
from tests import test_inline_renderer as fixtures
from tests.xlsx_edits import edit_cell


PRODUCTS = [{"id": str(index), "brand": brand, "model": f"M{index}", "version": "V1", "active": True}
            for index, brand in enumerate(("问界", "OtherZ", "尊界", "享界", "智界", "尚界", "OtherA"))]
PRODUCTS += [{"id": "z2", "brand": "智界", "model": "M4", "version": "V2", "active": True},
             {"id": "za", "brand": "智界", "model": "A", "version": "V1", "active": True}]
PLANS = [{"product_id": product["id"], "month": "2026-10", "sop": index + 1, "revision": 1}
         for index, product in enumerate(PRODUCTS)]
LOOKUP = {(plan["product_id"], plan["month"]): plan for plan in PLANS}
EXPECTED = [*BRAND_ORDER, "OtherA", "OtherZ"]


def payloads(products=PRODUCTS, **options):
    with patch.multiple(fixtures, PRODUCTS=products, PLANS=PLANS, LOOKUP=LOOKUP):
        return fixtures.export_payload(**options)


def brands_from_sheet(sheet):
    return list(dict.fromkeys(cell.value for row in sheet.iter_rows(min_row=5, max_col=1)
                              for cell in row if cell.value in EXPECTED))


def assert_brand_blocks(test, sheet):
    """Each brand spans its models, metrics and subtotal exactly once in A."""
    areas = list(sheet.merged_cells.ranges)
    for brand in EXPECTED:
        labels = [row[0].row for row in sheet.iter_rows(min_row=5, max_col=1)
                  if row[0].value == brand]
        test.assertEqual(len(labels), 1, brand)
        first = labels[0]
        last = next(row[1].row for row in sheet.iter_rows(min_row=first, max_col=2)
                    if row[1].value == brand + " 合计")
        test.assertIn(f"A{first}:A{last}", {str(area) for area in areas}, brand)
        intersecting = [area for area in areas if area.min_col == 1
                        and area.min_row >= 5 and area.min_row <= last and area.max_row >= first]
        test.assertEqual(len(intersecting), 1, brand)


class BrandOrderTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="sop-brand-order-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        source = self.root / "sales.json"
        source.write_text(json.dumps({"meta": {}, "products": PRODUCTS, "sales": []}, ensure_ascii=False),
                          encoding="utf-8")
        self.store = SOPStore(self.root / "test.sqlite3", source,
                              lambda: datetime(2026, 10, 28, 12, tzinfo=TZ))
        self.addCleanup(self.store.close)

    def test_catalog_orders_all_brands_and_retains_model_version_sorting(self):
        actual = self.store.list_products()["items"]
        self.assertEqual(list(dict.fromkeys(item["brand"] for item in actual)), EXPECTED)
        expected = sorted(PRODUCTS, key=lambda item: (brand_order_key(item["brand"]),
                                                     item["model"], item["version"], item["id"]))
        self.assertEqual([item["id"] for item in actual], [item["id"] for item in expected])

    def test_download_layout_preserves_brand_order_and_model_blocks(self):
        expected_ids = ["4", "z2", "za", "3", "2", "5", "0", "6", "1"]
        for locks in (False, True):
            for versions in (False, True):
                with self.subTest(locks=locks, versions=versions):
                    body = payloads(locks=locks, versions=versions)
                    layout = _layout(body)
                    labels = [row["labels"][1] for row in layout["rows"]
                              if row["kind"] == "brand_total" and row["metric"] == "SOP计划量"]
                    self.assertEqual(labels, [brand + " 合计" for brand in EXPECTED])
                    if versions:
                        ids = [row["product_id"] for row in layout["rows"]
                               if row["kind"] == "product" and row["metric"] == "SOP计划量"]
                        self.assertEqual(ids, expected_ids)
                    path = self.root / f"layout-{locks}-{versions}.xlsx"
                    write_export_workbook({**body, "output_path": str(path)})
                    book = openpyxl.load_workbook(path)
                    try:
                        assert_brand_blocks(self, book["SOP计划"])
                    finally:
                        book.close()


    def test_filtered_download_import_preserves_excluded_wenjie(self):
        self.store.save_plans({"owner": "test", "changes": [
            {**plan, "forecast": None, "revision": 0} for plan in PLANS]})
        selected = [product for product in PRODUCTS if product["brand"] != "问界"]
        body = payloads(products=selected)
        body["selected_product_ids"] = [product["id"] for product in selected]
        body["row_product_ids"] = body.pop("roundtrip")["row_product_ids"]
        service = PlanRoundtrip(self.store)
        clean, context = service.prepare(body)
        path = self.root / "selected.xlsx"
        write_export_workbook({**clean, "roundtrip": context, "output_path": str(path)})
        service.register(path, context)
        book = openpyxl.load_workbook(path)
        try:
            spec = fixtures.manifest(book)
            row = next(item["row"] for item in spec["rows"] if item.get("product_id") == "4")
            self.assertNotIn("问界", brands_from_sheet(book["SOP计划"]))
        finally:
            book.close()
        edit_cell(path, f"M{row}", 55)
        result = service.import_content(path.read_bytes())
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["imported"], 1)
        wenjie = next(item for item in self.store.list_products()["items"] if item["id"] == "0")
        self.assertTrue(wenjie["active"])
        self.assertEqual(self.store.db.execute(
            "SELECT sop FROM plans WHERE product_id='0' AND month='2026-10'").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
