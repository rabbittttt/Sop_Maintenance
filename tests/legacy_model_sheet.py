"""Representative unmarked rows from the historical two-header model workbook."""
from openpyxl import Workbook
from sop.plan_scope import MODEL_PLAN_LABEL


def historical_model_sheet(model, *, include_model, quantity=None):
    book = Workbook()
    sheet = book.active
    sheet.title = "SOP计划"
    sheet["A1"] = "SOP计划表"
    sheet.append([])
    sheet.append(["品牌", "车型", "版本", "2026年"])
    sheet.merge_cells("D3:O3")
    sheet.append([None, None, None] + [f"{i}月" for i in range(1, 13)])
    sheet.append(["智界", model, "Max"])
    sheet.append([None, None, "Pro"])
    sheet["M5"], sheet["M6"] = 10, 20
    if include_model:
        sheet.append([None, None, MODEL_PLAN_LABEL])
        sheet["M7"] = quantity
    end = 7 if include_model else 6
    sheet.merge_cells(f"B5:B{end}")
    sheet.append([None, model + " 合计"])
    sheet.cell(end+1, 13, "=SUM(M5:M6)")
    sheet.merge_cells(f"A5:A{end+1}")
    return book
