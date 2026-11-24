"""Edit synthetic Excel downloads in their on-disk representation."""
import copy
import re
import zipfile
import xml.etree.ElementTree as ET

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def col_name(index):
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def edit_cell(path, reference, value, sheet=1, formula=False):
    """Simulate a user's saved Excel cell edit inside a disposable test fixture."""
    with zipfile.ZipFile(path) as archive:
        contents = {name: archive.read(name) for name in archive.namelist()}
    filename = f"xl/worksheets/sheet{sheet}.xml"
    root = ET.fromstring(contents[filename])
    cell = root.find(f".//{{{NS}}}c[@r='{reference}']")
    if cell is None:
        raise AssertionError("Fixture cell does not exist: " + reference)
    for child in list(cell):
        cell.remove(child)
    cell.attrib.pop("t", None)
    if formula:
        ET.SubElement(cell, f"{{{NS}}}f").text = str(value)
    elif isinstance(value, str):
        cell.set("t", "inlineStr")
        ET.SubElement(ET.SubElement(cell, f"{{{NS}}}is"), f"{{{NS}}}t").text = value
    elif value is not None:
        ET.SubElement(cell, f"{{{NS}}}v").text = str(value)
    contents[filename] = ET.tostring(root, encoding="utf-8")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in contents.items():
            archive.writestr(name, content)


def change_rows(path, at, *, insert=None, delete=False, copy_from=None):
    """Simulate a user's whole-row insert/copy/delete in a disposable ZIP fixture."""
    with zipfile.ZipFile(path) as archive:
        content = {name: archive.read(name) for name in archive.namelist()}
    root = ET.fromstring(content["xl/worksheets/sheet1.xml"])
    data = root.find(f"{{{NS}}}sheetData")
    copied = next((copy.deepcopy(row) for row in data if int(row.attrib["r"]) == copy_from), None)
    for row in list(data):
        old = int(row.attrib["r"])
        if delete and old == at:
            data.remove(row)
            continue
        new = old + (1 if not delete and old >= at else -1 if delete and old > at else 0)
        row.set("r", str(new))
        for cell in row:
            cell.set("r", re.sub(r"\d+$", str(new), cell.attrib["r"]))
    if not delete:
        row = copied if copied is not None else ET.Element(f"{{{NS}}}row")
        row.set("r", str(at))
        for cell in row:
            cell.set("r", re.sub(r"\d+$", str(at), cell.attrib["r"]))
        if insert:
            for column, value in insert.items():
                cell = ET.SubElement(row, f"{{{NS}}}c", {"r": f"{column}{at}"})
                if isinstance(value, str):
                    cell.set("t", "inlineStr")
                    ET.SubElement(ET.SubElement(cell, f"{{{NS}}}is"), f"{{{NS}}}t").text = value
                elif value is not None:
                    ET.SubElement(cell, f"{{{NS}}}v").text = str(value)
        data.append(row)
    data[:] = sorted(data, key=lambda r: int(r.attrib["r"]))
    content["xl/worksheets/sheet1.xml"] = ET.tostring(root, encoding="utf-8")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, raw in content.items():
            archive.writestr(name, raw)
