"""Exercise the real Excel download writer using disposable, synthetic records."""
import tempfile
import unittest
from pathlib import Path

import openpyxl


def payload(locks=True, versions=True):
    months = ["2026-08", "2026-10", "2026-12", "2027-02"]
    records = [
        ("车型汇总", "问界", "M5", "", "锁单数", [120, None, 0, None], 150, "交车锁单原数，未分摊版本"),
        ("车型汇总", "问界", "M5", "", "SOP计划量", [30, 0, 70, None], 700, "部分月份缺项，仅已知合计"),
        ("版本明细", "问界", "M5", "同名版本", "锁单数", [None] * 4, None, "版本锁单缺失，未分摊"),
        ("版本明细", "问界", "M5", "同名版本", "锁单数", [None] * 4, None, "版本锁单缺失，同名版本第二项"),
        ("版本明细", "问界", "M5", "同名版本", "SOP计划量", [10, 0, 30, None], 300, "同名版本第一项"),
        ("版本明细", "问界", "M5", "同名版本", "SOP计划量", [20, None, 40, None], 400, "同名版本第二项"),
        ("车型汇总", "智界", "M5", "", "锁单数", [50, 0, None, None], 50, "交车锁单原数，未分摊版本"),
        ("车型汇总", "智界", "M5", "", "SOP计划量", [5, 0, None, None], 100, "2027-02未适用"),
        ("版本明细", "智界", "M5", "=1+1", "锁单数", [None] * 4, None, "来源缺失"),
        ("版本明细", "智界", "M5", "=1+1", "SOP计划量", [5, 0, None, None], 100, "2027-02未适用"),
    ]
    records = [r for r in records if (locks or r[4] != "锁单数") and (versions or r[0] != "版本明细")]
    rows = [[r[0], r[1], r[2], *([r[3]] if versions else []), r[4], *r[5], r[7]] for r in records]
    return {"schema_version": 1, "current_month": "2026-10", "months": months,
            "include_locks": locks, "include_versions": versions, "scope": "测试范围",
            "headers": ["层级", "品牌", "车型", *(["版本"] if versions else []), "指标", *months, "数据说明"],
            "rows": rows, "annual_plans": [{"2026": r[6]} for r in records]}


class ExportWorkbookTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from sop.xlsx_export import write_export_workbook
        tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(tmp.cleanup)
        cls.outputs = {}
        for locks in (True, False):
            for versions in (True, False):
                path = Path(tmp.name) / f"{locks}-{versions}.xlsx"
                write_export_workbook({**payload(locks, versions), "output_path": str(path)})
                cls.outputs[locks, versions] = path

    def test_all_option_combinations_keep_values_style_and_formula_totals(self):
        for (locks, versions), path in self.outputs.items():
            with self.subTest(locks=locks, versions=versions):
                values = openpyxl.load_workbook(path, data_only=True)
                formulas = openpyxl.load_workbook(path, data_only=False)
                self.assertEqual(values.sheetnames, ["SOP计划"])
                s, f = values.active, formulas.active
                first = 3 + int(versions)
                self.assertEqual(f.freeze_panes, f"{openpyxl.utils.get_column_letter(first)}5")
                self.assertEqual(s["A3"].fill.fgColor.rgb, "000871B8")
                self.assertEqual(s.cell(4, first).fill.fgColor.rgb, "006F8498")
                self.assertEqual(s.cell(4, first + 3).value, "2026总计")
                self.assertEqual(s.cell(5, first + 3).fill.fgColor.rgb, "00FFF8E4")
                # Only chosen months are shown, with the full calendar year SOP after December.
                self.assertEqual([s.cell(4, first + i).value for i in range(5)], ["8月", "10月", "12月", "2026总计", "2月"])
                self.assertEqual(s.max_column, first + 4, "No extra metric/notes column")
                self.assertEqual(s["A1"].value, "SOP计划表")
                self.assertEqual(s.cell(1, first).value, "2026-08—2027-02")
                self.assertFalse(any(c.value in ("指标", "数据说明", "说明索引") for row in s for c in row))
                total = next(r for r in range(5, s.max_row + 1) if s.cell(r, 1).value == "总计")
                self.assertEqual([s.cell(total, first + i).value for i in range(5)], [35, 0, 70, 800, None])
                if locks:
                    lock_total = next(r for r in range(5, s.max_row + 1) if s.cell(r, 1).value == "锁单总计")
                    self.assertEqual([s.cell(lock_total, first + i).value for i in range(5)], [170, 0, 0, 200, None])
                else:
                    self.assertFalse(any(isinstance(c.value, str) and "锁单" in c.value for row in s if row[0].row > 4 for c in row))
                model_rows = [r for r in range(5, s.max_row + 1) if s.cell(r, 2).value == "M5 合计"]
                self.assertEqual(len(model_rows), 2, "same model labels in different brands must remain separate")
                brand_rows = [r for r in range(5, s.max_row + 1) if s.cell(r, 2).value in ("问界 合计", "智界 合计")]
                for row in brand_rows:
                    self.assertIn(f"{openpyxl.utils.get_column_letter(first)}{row}", f.cell(total, first).value)
                self.assertEqual(s.cell(total, first).font.color.rgb, "00B62025")
                self.assertEqual(s.row_dimensions[total].height, 28)
                self.assertEqual(s.row_dimensions[2].height, 29)
                self.assertFalse(s.sheet_view.showGridLines)
                self.assertTrue(s.protection.sheet)
                self.assertFalse(any(c.data_type == "e" for row in s for c in row))
                if versions:
                    self.assertEqual(s.cell(5, first).fill.fgColor.rgb, '00F0F2F4')
                    duplicate_rows = [r for r in range(5, s.max_row + 1) if s.cell(r, 3).value == "同名版本"]
                    self.assertEqual(len(duplicate_rows), 2)
                    if locks:
                        lock_rows = [r for r in range(5, s.max_row + 1) if s.cell(r, 3).value == "同名版本（锁单数）"]
                        self.assertEqual(len(lock_rows), 2)
                        self.assertLess(max(lock_rows), min(duplicate_rows))
                    literal = [c for row in f for c in row if c.value in ("=1+1", "=1+1（锁单数）")]
                    self.assertEqual(len(literal), 2 if locks else 1)
                    self.assertTrue(all(c.data_type == "s" for c in literal))
                else:
                    self.assertFalse(any(c.value in ("同名版本", "=1+1") for row in s for c in row))

    def test_safe_integer_contract_and_overflow(self):
        body = payload(False, False)
        body["rows"] = body["rows"][:1]
        body["annual_plans"] = body["annual_plans"][:1]
        body["rows"][0][4] = 2**53 - 1
        from sop.export import PlanExport
        with PlanExport().generate(body) as result:
            book = openpyxl.load_workbook(result.path, data_only=True)
            try:
                self.assertEqual(book.active["C5"].value, 2**53-1)
            finally:
                book.close()
        from sop.export import validate_export
        from sop.store import ValidationError
        for invalid in (1.5, True, -1, 2**53):
            body["rows"][0][4] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                validate_export(body)
        body["rows"][0][4] = 2**53 - 1
        body["rows"].append(["车型汇总", "智界", "M5", "SOP计划量", 1, 0, None, None, ""])
        body["annual_plans"].append({"2026": None})
        from sop.xlsx_export import write_export_workbook
        with tempfile.TemporaryDirectory() as folder, self.assertRaisesRegex(ValueError, "安全整数"):
            write_export_workbook({**body, "output_path": str(Path(folder) / "overflow.xlsx")})
