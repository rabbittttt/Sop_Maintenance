"""Independent model/month demand plans imported through the webpage."""
from __future__ import annotations

import hashlib
import io
import json
import uuid

from .brand import brand_order_key
from .model_table import parse_model_table
from .plan_scope import MODEL_PLAN_LABEL
from .source_rules import normalize_generation, product_display_model
from .store import TZ, ValidationError, catalog_name_key, horizon, month_range, stamp, text_field, validate_month


def create_schema(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS demand_plans (
            model_key TEXT NOT NULL, brand TEXT NOT NULL, model TEXT NOT NULL,
            month TEXT NOT NULL, quantity INTEGER NOT NULL, revision INTEGER NOT NULL,
            owner TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(model_key,month));
        CREATE TABLE IF NOT EXISTS demand_import_requests (
            fingerprint TEXT PRIMARY KEY, result TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS demand_export_baselines (
            token TEXT PRIMARY KEY, payload TEXT NOT NULL);
    """)


def model_key(brand, model):
    normalized = catalog_name_key({"brand": normalize_generation(brand),
                                   "model": normalize_generation(model), "version": ""})[:2]
    return json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))


def revision(store):
    with store.lock:
        return store.db.execute("SELECT COALESCE(MAX(id),0) FROM events WHERE entity='demand'").fetchone()[0]


def state(store):
    return {"demand_plans": [dict(row) for row in store.db.execute(
                "SELECT brand,model,month,quantity,revision,owner,updated_at FROM demand_plans ORDER BY brand,model,month")],
            "demand_revision": revision(store)}


def _parse(content):
    from .roundtrip import _read_workbook
    with _read_workbook(content) as workbook:
        visible = [sheet for sheet in workbook if sheet.sheet_state == "visible"]
        sheet = next((workbook[name] for name in ("要货计划", "SOP计划") if name in workbook.sheetnames),
                     visible[0] if len(visible) == 1 else None)
        if sheet is None:
            raise ValidationError("请选择含一张要货计划主表的 Excel，保留品牌、车型年款和月份。")
        metric_column = None
        for row in sheet.iter_rows(max_row=20, values_only=True):
            labels = [str(value or "").strip() for value in row]
            if "品牌" in labels and "车型" in labels:
                metric_column = labels.index("指标") + 1 if "指标" in labels else None
                break
        demand_labels = {"要货计划", "要货计划量"}
        explicit = metric_column is not None and any(
            str(row[0] or "").strip() in demand_labels
            for row in sheet.iter_rows(min_col=metric_column, max_col=metric_column, values_only=True))
        token = str(workbook['_demand_import']['A1'].value or '') if '_demand_import' in workbook.sheetnames else None
        return token, parse_model_table(sheet,
            metric_labels=demand_labels if explicit else demand_labels | {"SOP计划量", "SOP计划", "计划量"},
            skip_other_metrics=explicit)


def import_content(store, content, *, base_revision, owner):
    if isinstance(base_revision, bool) or not isinstance(base_revision, int) or base_revision < 0:
        raise ValidationError("要货计划版本缺失，请刷新页面后重新导入。")
    owner = text_field(owner, "维护人", 100)
    if not owner:
        raise ValidationError("请填写维护人。")
    token, entries = _parse(content)
    fingerprint = hashlib.sha256(content + json.dumps([base_revision, owner], ensure_ascii=False).encode()).hexdigest()
    with store.lock:
        store.ensure_daily_snapshots()
        store.db.execute("BEGIN IMMEDIATE")
        try:
            replay = store.db.execute("SELECT result FROM demand_import_requests WHERE fingerprint=?", (fingerprint,)).fetchone()
            if replay:
                store.db.execute("COMMIT")
                return {**json.loads(replay["result"]), "replayed": True}
            if base_revision != revision(store):
                store.db.execute("ROLLBACK")
                return {"ok": False, "status": "conflict", "demand_revision": revision(store),
                        "error": "要货计划已被其他人更新，请刷新页面后重新核对并导入。"}
            baseline = None
            if token is not None:
                saved = store.db.execute("SELECT payload FROM demand_export_baselines WHERE token=?", (token,)).fetchone()
                if saved is None:
                    raise ValidationError("要货计划导出标识无法识别，请在当前看板重新导出后核对。")
                baseline = json.loads(saved['payload'])
            current = stamp(store.clock())
            end = horizon(current[:7], store.settings()["bridge_m6"])
            names = {model_key(p["brand"], product_display_model(p)): p for p in store._catalog_items()}
            prepared, new_models, seen = [], {}, set()
            for entry in entries:
                key = model_key(entry["brand"], entry["model"])
                matched = names.get(key)
                brand = matched["brand"] if matched else normalize_generation(entry["brand"])
                model = product_display_model(matched) if matched else normalize_generation(entry["model"])
                for plan in entry["plans"]:
                    month = validate_month(plan["month"])
                    if month > end:
                        raise ValidationError(f"{month} 已超出当前开放的计划范围。")
                    identity = key, month
                    if identity in seen:
                        raise ValidationError(f"重复填写同一车型和月份：{brand} {model} {month}。")
                    seen.add(identity)
                    old = store.db.execute("SELECT * FROM demand_plans WHERE model_key=? AND month=?", identity).fetchone()
                    before = dict(old) if old else None
                    value = plan["sop"]
                    if baseline is not None:
                        original = baseline.get(key, {}).get(month)
                        if value == original:
                            continue
                        database = before['quantity'] if before else None
                        if database != original and database != value:
                            store.db.execute("ROLLBACK")
                            return {"ok": False, "status": "conflict", "reload_workbook": True, "demand_revision": revision(store),
                                    "error": f"{brand} {model} {month} 在导出后已有更新，请重新导出并核对该月份。",
                                    "conflicts": [{"brand": brand, "model": model, "month": month,
                                                   "baseline": original, "workbook": value, "database": database}]}
                    if before and before["quantity"] == value:
                        continue
                    prepared.append((key, brand, model, month, value, before))
                if not matched:
                    new_models[key] = {"brand": brand, "model": model, "version": MODEL_PLAN_LABEL, "plan_level": "model"}
            for labels in new_models.values():
                store.db.execute("""INSERT INTO product_catalog
                    (id,source_json,overrides_json,active,source_present,revision,created_at,updated_at,start_month,end_month)
                    VALUES (?,?,?,1,0,1,?,?,?,NULL)""",
                    ("manual_" + uuid.uuid4().hex, "{}", json.dumps(labels, ensure_ascii=False), current, current, current[:7]))
            if new_models:
                store._validate_model_plan_catalog()
                store._ensure_catalog_fields()
                store._record_catalog(owner, "要货计划导入新增车型")
            for key, brand, model, month, value, before in prepared:
                row = {"model_key": key, "brand": brand, "model": model, "month": month, "quantity": value,
                       "revision": (before["revision"] if before else 0) + 1, "owner": owner, "updated_at": current}
                store.db.execute("INSERT OR REPLACE INTO demand_plans VALUES (?,?,?,?,?,?,?,?)", tuple(row.values()))
                store.db.execute("""INSERT INTO events
                    (entity,action,product_id,month,entity_key,before_json,after_json,owner,reason,notes,recorded_at)
                    VALUES ('demand',?,?,?,?,?,?,?,?,?,?)""",
                    ("update" if before else "create", key, month, json.dumps([key, month], ensure_ascii=False),
                     json.dumps(before, ensure_ascii=False) if before else None, json.dumps(row, ensure_ascii=False),
                     owner, "要货计划Excel导入", "", current))
            result = {"ok": True, "status": "imported", "imported": len(prepared), "created": len(new_models),
                      "demand_revision": revision(store)}
            store.db.execute("INSERT INTO demand_import_requests VALUES (?,?)", (fingerprint, json.dumps(result)))
            store.db.execute("COMMIT")
            return result
        except Exception:
            if store.db.in_transaction:
                store.db.execute("ROLLBACK")
            raise


def export_content(store, body):
    from .export import MAX_QUANTITY_CELLS
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
    with store.lock:
        current = store.clock().astimezone(TZ).strftime("%Y-%m")
        months = body.get("months", month_range(current[:4] + "-01", horizon(current, store.settings()["bridge_m6"])))
        if not isinstance(months, list) or not 1 <= len(months) <= 120:
            raise ValidationError("请选择1至120个导出月份。")
        months = sorted(validate_month(month) for month in months)
        if len(set(months)) != len(months):
            raise ValidationError("导出月份不能重复。")
        records = state(store)["demand_plans"]
        models = body.get("models")
        if models is None:
            sales = store.read_sales()
            products = [*sales["products"], *sales.get("generation_members", {}).get("products", [])]
            models = [{"brand": p["brand"], "model": product_display_model(p)} for p in products]
            models.extend({"brand": r["brand"], "model": r["model"]} for r in records)
        if not isinstance(models, list) or len(models) > 15000:
            raise ValidationError("导出车型范围无效。")
        names = {}
        for item in models:
            if not isinstance(item, dict):
                raise ValidationError("导出车型格式无效。")
            brand, model = text_field(item.get("brand"), "品牌", 200), text_field(item.get("model"), "车型", 200)
            if not brand or not model:
                raise ValidationError("导出车型须包含品牌和车型年款。")
            names[model_key(brand, model)] = brand, model
        if not names:
            raise ValidationError("暂无可导出的车型，请先新增车型或导入要货计划。")
        quantity_columns = len(months) + sum(month.endswith("-12") for month in months)
        if len(names) * quantity_columns > MAX_QUANTITY_CELLS:
            raise ValidationError("要货计划导出范围过大，请减少车型或月份。")
        values = {(model_key(row["brand"], row["model"]), row["month"]): row["quantity"] for row in records}
        ordered = sorted(names.items(), key=lambda item: (brand_order_key(item[1][0]), item[1][1]))
    columns = []
    for month in months:
        columns.append(("month", month))
        if month.endswith("-12"):
            columns.append(("year", month[:4]))
    book = Workbook()
    sheet = book.active
    sheet.title = "要货计划"
    sheet.append(["要货计划表"])
    sheet.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(columns) + 2)
    sheet.cell(1, 1).font = Font(name="微软雅黑", size=18, bold=True, color="17446C")
    sheet.cell(1, 1).alignment = Alignment(horizontal="center")
    sheet.row_dimensions[1].height = 32
    sheet.append(["品牌", "车型", *[value if kind == "month" else value + "总计" for kind, value in columns]])
    blue, gray, total = PatternFill("solid", fgColor="0878B8"), PatternFill("solid", fgColor="EEEEEE"), PatternFill("solid", fgColor="FFF4D6")
    side = Side(style="thin", color="C5CBD3")
    border = Border(left=side, right=side, top=side, bottom=side)
    for cell in sheet[2]:
        cell.fill = blue
        cell.font = Font(name="微软雅黑", bold=True, color="FFFFFF", size=11)
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = border
    sheet.row_dimensions[2].height = 26
    brand_start, previous_brand = 3, None
    for number, (key, (brand, model)) in enumerate(ordered, 3):
        if previous_brand is not None and previous_brand != brand:
            if number - brand_start > 1:
                sheet.merge_cells(start_row=brand_start, start_column=1, end_row=number - 1, end_column=1)
            brand_start = number
        previous_brand = brand
        row = [brand, model]
        for kind, value in columns:
            if kind == "month":
                row.append(values.get((key, value)))
            else:
                known = [values[(key, f"{value}-{month:02d}")] for month in range(1, 13) if (key, f"{value}-{month:02d}") in values]
                row.append(sum(known) if known else None)
        sheet.append(row)
        for col in range(1, len(columns) + 3):
            cell = sheet.cell(number, col)
            if cell.column <= 2:
                cell.data_type = "s"
            cell.font = Font(name="微软雅黑", size=11, bold=True)
            cell.alignment = Alignment(horizontal="center", vertical="center")
            cell.border = border
            cell.number_format = "0" if cell.column > 2 else "General"
            if cell.column > 2:
                kind, value = columns[cell.column - 3]
                if kind == "year":
                    cell.fill = total
                    cell.font = Font(name="微软雅黑", size=11, bold=True, color="C00000")
                elif value < current:
                    cell.fill = gray
        sheet.row_dimensions[number].height = 24
    if len(ordered) + 3 - brand_start > 1:
        sheet.merge_cells(start_row=brand_start, start_column=1, end_row=len(ordered) + 2, end_column=1)
    sheet.column_dimensions["A"].width = 11
    sheet.column_dimensions["B"].width = 29
    for column in range(3, len(columns) + 3):
        sheet.column_dimensions[get_column_letter(column)].width = 13
    sheet.freeze_panes = "C3"
    sheet.sheet_view.showGridLines = False
    sheet.page_setup.orientation = "landscape"
    sheet.print_title_rows = "1:2"
    token = uuid.uuid4().hex
    metadata = book.create_sheet('_demand_import')
    metadata['A1'] = token
    metadata.sheet_state = 'veryHidden'
    baseline = {key: {month: values.get((key, month)) for month in months} for key in names}
    stream = io.BytesIO()
    book.save(stream)
    book.close()
    with store.lock:
        store.db.execute("INSERT INTO demand_export_baselines VALUES (?,?)", (token, json.dumps(baseline, ensure_ascii=False)))
    return stream.getvalue(), "要货计划.xlsx"
