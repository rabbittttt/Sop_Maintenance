"""Merge Excel plan changes and catalog edits in one database transaction."""
import json
import re
import uuid

from .plan_scope import is_model_plan
from .source_rules import normalize_generation, generation_parent
from .store import (ConflictError, ValidationError, TZ, catalog_name_key, display_version, horizon,
                    quantity, stamp, text_field, validate_month)


def import_workbook_plans(store, body, *, before_commit=None):
    """Import known cells and named entry rows as one catalog/plan transaction.

    Blank entry cells do not clear existing plans. Cell conflicts are checked against the exported baseline and
    the latest database value. An explicit zero is a plan quantity.
    """
    if not isinstance(body, dict):
        raise ValidationError("表格导入格式无效。")
    entries, changes = body.get("entries", []), body.get("changes", [])
    catalog_changes = body.get("catalog_changes", [])
    entry_tracking_token = body.get("entry_tracking_token")
    if entry_tracking_token is not None and (not isinstance(entry_tracking_token, str)
            or not re.fullmatch(r"[0-9a-f]{32}", entry_tracking_token)):
        raise ValidationError("新增版本的导入跟踪标识无效，请重新导出。")
    if (not isinstance(entries, list) or len(entries) > 2000 or not isinstance(changes, list) or len(changes) > 20000
            or not isinstance(catalog_changes, list) or len(catalog_changes) > 2000):
        raise ValidationError("表格导入记录过多或格式无效。")
    choice = body.get("choice")
    if choice not in {None, "db", "workbook"}:
        raise ValidationError("表格冲突处理选项无效。")
    owner = text_field(body.get("owner") or "Excel计划表", "负责人", 100)
    reason = text_field(body.get("reason") or "表格同步", "变更原因")
    notes = text_field(body.get("notes"), "备注", 5000)
    with store.lock:
        store.ensure_daily_snapshots()
        store.read_sales()
        store.db.execute("BEGIN IMMEDIATE")
        try:
            current_stamp = stamp(store.clock())
            current_month = store.clock().astimezone(TZ).strftime("%Y-%m")
            plan_end = horizon(current_month, store.settings()["bridge_m6"])
            if before_commit is not None:
                before_commit()
            catalog_updated, deactivated = store._merge_workbook_catalog(
                catalog_changes, choice, current_stamp, current_month)
            names = {}
            for product in store._catalog_items():
                names.setdefault(catalog_name_key(product), []).append(product)
            created, resolved, proposed = set(), [], {}
            for index, entry in enumerate(entries):
                if not isinstance(entry, dict) or not isinstance(entry.get("plans", []), list):
                    raise ValidationError("新增车型/版本行格式无效。")
                labels = {}
                for field, label in (("brand", "品牌"), ("model", "车型"), ("version", "版本名称")):
                    value = text_field(entry.get(field), label, 200)
                    if field == "version":
                        value = display_version(value, "")
                    if not value:
                        raise ValidationError(f"新增车型/版本行请填写{label}。")
                    labels[field] = value
                if is_model_plan(labels):
                    if not re.search(r"20\d{2}款", labels["model"]):
                        raise ValidationError("车型计划请填写带年款的车型，例如 M5 2026款。")
                    labels["plan_level"] = "model"
                name_key = catalog_name_key(labels)
                candidates = names.get(name_key, [])
                requested_parent = entry.get("parent_generation")
                rules = store._generation_rules()
                if is_model_plan(labels):
                    current_summaries = {normalize_generation(name) for name in rules["groups"]}
                    # New named input must not resolve to a hidden historical
                    # parent. Stable-ID changes still preserve its old plans.
                    candidates = [p for p in candidates if not p.get("summary_generation")
                                  or normalize_generation(p["summary_generation"]) in current_summaries]
                actual_parent = generation_parent(labels, rules)
                if requested_parent is not None and requested_parent != actual_parent:
                    raise ValidationError("新增单代际不属于所选汇总车型，请核对共享规则和年款。")
                singles = [p for p in candidates if not p.get("summary_generation")]
                matches = singles if singles or requested_parent is not None else candidates
                if len(matches) > 1:
                    raise ValidationError("相同品牌、车型和版本对应多个来源代际，请在已有明细行填写，不能自动合并。")
                entry_plans = []
                for plan in entry.get("plans", []):
                    if not isinstance(plan, dict):
                        raise ValidationError("新增版本的计划量格式无效。")
                    month = validate_month(plan.get("month"))
                    if month > plan_end:
                        raise ValidationError(f"{month}已超出当前开放计划范围。")
                    value = quantity(plan.get("sop"))
                    baseline = quantity(plan.get("baseline_sop"))
                    if value is not None or baseline is not None:
                        entry_plans.append((month, value, baseline))
                start = min([current_month] + [month for month, _, _ in entry_plans])
                if not matches:
                    pid = "manual_" + uuid.uuid4().hex
                    overrides = {**labels, "lifecycle_set": True}
                    store.db.execute("""INSERT INTO product_catalog
                        (id,source_json,overrides_json,active,source_present,revision,created_at,updated_at,start_month)
                        VALUES (?,?,?,?,?,?,?,?,?)""", (pid, "{}", json.dumps(overrides, ensure_ascii=False), 1, 0, 1, current_stamp, current_stamp, start))
                    created.add(pid)
                    product = store._catalog_product(store.db.execute("SELECT * FROM product_catalog WHERE id=?", (pid,)).fetchone())
                    names[name_key] = [product]
                else:
                    product = matches[0]
                    pid = product["id"]
                    if pid in created and start < product["start_month"]:
                        store.db.execute("UPDATE product_catalog SET start_month=? WHERE id=?", (start, pid))
                        product["start_month"] = start
                resolved.append(pid)
                for month, value, baseline in entry_plans:
                    key = (pid, month)
                    if key in proposed and (value, baseline) != proposed[key][:2]:
                        raise ValidationError("重复填写的同一车型版本月份计划量或基准不一致，请合并为一行。")
                    proposed[key] = (value, baseline, index)
            if len(changes) + len(proposed) > 20000:
                raise ValidationError("同一次表格导入最多支持 20000 条计划变更。")
            ordinary = {}
            for change in changes:
                if not isinstance(change, dict):
                    raise ValidationError("计划变更格式无效。")
                key = (change.get("product_id"), change.get("month"))
                if key in ordinary:
                    raise ValidationError("同一次保存包含重复记录。")
                if key[0] in deactivated:
                    raise ValidationError("同一次导入不能同时删除版本行并修改该版本计划，请分开处理。")
                ordinary[key] = change
            combined, conflicts = list(changes), []
            for (pid, month), (value, baseline, index) in proposed.items():
                if pid in deactivated:
                    raise ValidationError("同一次导入不能同时删除版本行并修改该版本计划，请分开处理。")
                key = (pid, month)
                if key in ordinary:
                    if ordinary[key].get("sop") != value:
                        raise ValidationError("新增区与已有明细行填写了不同的同一月份计划量，请先统一。")
                    continue
                row = store.db.execute("SELECT * FROM plans WHERE product_id=? AND month=?", key).fetchone()
                previous = dict(row) if row else {}
                database_value = previous.get("sop")
                if value == baseline or value == database_value:
                    continue
                if database_value != baseline:
                    conflicts.append({"product_id": pid, "month": month, "baseline": baseline,
                                      "workbook": value, "database": database_value,
                                      "current": previous or None, "manual_entry": index})
                    if choice != "workbook":
                        continue
                combined.append({"product_id": pid, "month": month, "sop": value,
                                 "forecast": previous.get("forecast"), "revision": previous.get("revision", 0),
                                 "notes": previous.get("notes", notes)})
            if conflicts and choice is None:
                raise ConflictError(conflicts)
            catalog = {p["id"]: p for p in store._catalog_items()}
            prepared, owner, reason, notes = store._changes(
                {"changes": combined, "owner": owner, "reason": reason, "notes": notes},
                "plan", products=catalog, allow_empty=True)
            saved = store._apply_changes(prepared, "plan", owner, reason, notes)
            if created or catalog_updated:
                store._record_catalog(owner, "表格维护车型与版本")
            products = [catalog[pid] for pid in resolved]
            if entry_tracking_token is not None:
                # Downloads keep no server-writable file after import. Remember
                # newly assigned IDs in the same transaction, so a later old
                # copy cannot silently create a second ID for that entry.
                exists = store.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='plan_download_entry_imports'").fetchone()
                if not exists:
                    raise ValidationError("导出表的新增版本跟踪尚未就绪，请刷新后重试。")
                tracked_row = store.db.execute("SELECT payload FROM plan_download_entry_imports WHERE token=?",
                                              (entry_tracking_token,)).fetchone()
                try:
                    tracked = json.loads(tracked_row["payload"]) if tracked_row else {}
                except (TypeError, json.JSONDecodeError) as error:
                    raise ValidationError("新增版本的导入跟踪记录无效，请重新导出。") from error
                if not isinstance(tracked, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in tracked.items()):
                    raise ValidationError("新增版本的导入跟踪记录无效，请重新导出。")
                for entry, pid in zip(entries, resolved):
                    name = json.dumps(catalog_name_key(entry), ensure_ascii=False, separators=(",", ":"))
                    if name in tracked and tracked[name] != pid:
                        raise ValidationError("这个旧文件中的新增版本已登记或改名，请重新导出最新表格后修改。")
                    tracked[name] = pid
                store.db.execute("INSERT OR REPLACE INTO plan_download_entry_imports(token,payload) VALUES (?,?)",
                                (entry_tracking_token, json.dumps(tracked, ensure_ascii=False, sort_keys=True)))
            store.db.execute("COMMIT")
        except Exception:
            store.db.execute("ROLLBACK")
            raise
        return {"ok": True, "items": saved, "saved_count": len(saved),
                "products": products, "created_count": len(created),
                "catalog_updated_count": len(catalog_updated), "deactivated_count": len(deactivated)}
