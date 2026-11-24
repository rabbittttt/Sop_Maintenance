"""Visual contract captured from the synthetic pre-retirement maintenance template."""
from copy import copy
from hashlib import sha256
import json
from xml.etree.ElementTree import tostring

import openpyxl
from openpyxl.utils import get_column_letter


def template_signatures(path):
    book = openpyxl.load_workbook(path)
    try:
        sheet = book["SOP计划"]
        # Internal identity columns can differ across formats. Their visibility is checked separately.
        cols = sheet.max_column
        cells = [cell for row in sheet.iter_rows(max_col=cols-3) for cell in row]
        aspects = {
            "shape": [sheet.max_row, cols, sheet.freeze_panes, sheet.sheet_view.showGridLines,
                      sorted(str(merge) for merge in sheet.merged_cells.ranges), sheet.protection.sheet],
            "dimensions": [[sheet.column_dimensions[get_column_letter(i)].width,
                            sheet.column_dimensions[get_column_letter(i)].hidden] for i in range(1, cols+1)]
                          + [[sheet.row_dimensions[i].height, sheet.row_dimensions[i].hidden] for i in range(1, sheet.max_row+1)],
            "values_and_formulas": [c.value for c in cells],
            "number_formats": [c.number_format for c in cells],
            "validations": tostring(sheet.data_validations.to_tree()).decode(),
        }
        for aspect in ("font", "fill", "border", "alignment", "protection"):
            aspects[aspect] = [tostring(copy(getattr(c, aspect)).to_tree()).decode() for c in cells]
        return {name: sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
                for name, value in aspects.items()}
    finally:
        book.close()


HISTORICAL_TEMPLATE = {'alignment': 'df673dea0317aa1bb653ac53fd74228a7028e81f1b4d925ce02023348dcf8f4d',
 'border': '65229c59f056c5e72e0382fce556c20fb9033b4ab2cd1a53a774ed6e866a4c53',
 'dimensions': '5fd7de88ecb66ca86a502edf7f2a6a412b3031c52dc88fe84d23d6a20a7f8031',
 'fill': 'f54e1dcdb5c0de5b9a03bbdbda4cfc095c6eb803c51a2f21ac4846a0d24acb04',
 'font': 'bd971ad9c76d5ee1f0c1a46910f492990d126c1aa79aad804cd87e72d39b769c',
 'number_formats': 'c66f9b3df4de5d79c0fe87f0523a6272131b1b5e34ab92a8f4354c9b93d359ad',
 'protection': '23fed539418126cdfa1744358698124fb190b6ec305ae5706215a171c437f8d0',
 'shape': '98d5a3d0edab91f9ee51c1ddb4b9dd3d1837322c2c9f5b7ecedeb3f670845314',
 'validations': 'b86f62214eb8b60f340c5c16718dab0157e48eb33331727c0d67fd0699f8be3b',
 'values_and_formulas': '26d0e2acb61ef2e1441819187284d1813f516d2bea04c888fddf229c12b9d0c4'}
