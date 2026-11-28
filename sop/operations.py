"""Read the existing business ledgers as one chronological activity feed."""

import json
from functools import lru_cache

from .store import ValidationError

PAGE_SIZE = 50
EVENT_NAMES = {"plan": "SOP计划", "demand": "要货计划", "shipment": "发货实绩"}
ENTITIES = {*EVENT_NAMES, "catalog", "committee", "reconcile"}
STATUSES = {"pending": "待结算", "settled": "已结算", "corrected": "已更正"}


def _decode_cursor(value):
    try:
        stamp, entity, entry, batch = json.loads(value)
        if (not isinstance(stamp, str) or len(stamp) > 50 or entity not in ENTITIES
                or type(entry) is not int or not 0 < entry < 2**63
                or not isinstance(batch, str) or len(batch) > 128):
            raise ValueError
        return stamp, entity, entry, batch
    except (ValueError, TypeError, RecursionError):
        raise ValidationError("操作记录翻页位置无效。") from None


def _page_keys(db, entity, cursor):
    sources = [
        "SELECT recorded_at, entity, id AS entry, '' AS batch FROM events",
        "SELECT recorded_at, 'catalog' AS entity, id AS entry, '' AS batch FROM catalog_versions",
        "SELECT recorded_at, 'committee' AS entity, id AS entry, '' AS batch FROM committee_decisions",
    ]
    # Reconciliation creates its tables only when first used.
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reconcile_audit'").fetchone():
        sources.append("SELECT created_at AS recorded_at, 'reconcile' AS entity, revision AS entry, "
                       "round_id AS batch FROM reconcile_audit")
    sql = "SELECT * FROM (" + " UNION ALL ".join(sources) + ") WHERE 1=1"
    args = []
    if entity:
        sql += " AND entity=?"
        args.append(entity)
    if cursor:
        sql += " AND (recorded_at, entity, entry, batch) < (?,?,?,?)"
        args.extend(_decode_cursor(cursor))
    sql += " ORDER BY recorded_at DESC, entity DESC, entry DESC, batch DESC LIMIT ?"
    return db.execute(sql, [*args, PAGE_SIZE + 1]).fetchall()


def _event(db, key, catalog_at):
    row = db.execute("SELECT * FROM events WHERE id=?", (key["entry"],)).fetchone()
    entity = row["entity"]
    after = json.loads(row["after_json"])
    before = json.loads(row["before_json"] or "{}")
    if entity == "demand":
        subject = " ".join((after["brand"], after["model"]))
    else:
        product = catalog_at(row["recorded_at"]).get(row["product_id"], {})
        subject = product.get("name") or row["product_id"]
    fields = {"plan": [("sop", "SOP计划量"), ("forecast", "预测销量"), ("notes", "备注")],
              "demand": [("quantity", "要货计划量")],
              "shipment": [("quantity", "实际发货量"), ("status", "结算状态"), ("source", "来源"), ("batch", "批次")]}
    changes = []
    for field, label in fields[entity]:
        old, new = before.get(field), after.get(field)
        if old == new or (old in (None, "") and new in (None, "")):
            continue
        old = STATUSES.get(old, old) if field == "status" else old
        new = STATUSES.get(new, new) if field == "status" else new
        changes.append(f"{label} {old if old not in (None, '') else '—'} → {new if new not in (None, '') else '—'}")
    action = ("新增" if row["action"] == "create" else "修改") + EVENT_NAMES[entity]
    return row["owner"], action, subject, row["month"], "；".join(changes), row["reason"]


def _catalog(db, entry, snapshot):
    row = db.execute("SELECT owner, reason FROM catalog_versions WHERE id=?", (entry,)).fetchone()
    prior = db.execute("SELECT MAX(id) FROM catalog_versions WHERE id < ?", (entry,)).fetchone()[0]
    before, after = snapshot(prior), snapshot(entry)
    added = [p for pid, p in after.items() if pid not in before]
    changed = [p for pid, p in after.items() if pid in before and p != before[pid]]
    removed = [p for pid, p in before.items() if pid not in after]
    parts = []
    for label, items in (("新增", added), ("变更", changed), ("移出", removed)):
        if items:
            names = "、".join(p.get("name") or p["id"] for p in items[:3])
            parts.append(f"{label} {len(items)} 项（{names}{'等' if len(items) > 3 else ''}）")
    return row["owner"], "更新车型目录", "车型与版本", "", "；".join(parts), row["reason"]


def _committee(db, entry):
    row = db.execute("SELECT period, level, owner, model_count, scope, brands FROM committee_decisions WHERE id=?",
                     (entry,)).fetchone()
    start, end = db.execute("SELECT MIN(month), MAX(month) FROM committee_amounts WHERE decision_id=?", (entry,)).fetchone()
    level = ("一级", "二级", "三级")[row["level"] - 1]
    scope = f"{row['model_count']} 个车型" + (f" · {start} 至 {end}" if start and end else "")
    if row["scope"] == "brands":
        scope = "、".join(json.loads(row["brands"])) + " · " + scope
    elif row["scope"] == "models":
        models = db.execute("""SELECT DISTINCT brand, model FROM committee_amounts
                            WHERE decision_id=? ORDER BY brand, model LIMIT 3""", (entry,))
        labels = "、".join(f"{brand} {model}" for brand, model in models)
        scope = labels + ("等" if row["model_count"] > 3 else "") + " · " + scope
    return row["owner"], "保存计委决策", level + "计委", row["period"], scope, ""


def _reconcile(db, batch, revision):
    row = db.execute("""SELECT a.owner, r.name, a.action, a.payload FROM reconcile_audit a
        JOIN reconcile_rounds r ON r.id=a.round_id WHERE a.round_id=? AND a.revision=?""", (batch, revision)).fetchone()
    action = row["action"]
    data = json.loads(row["payload"])
    if action in ("create", "baseline"):
        detail = f"基准版本 {data['baseline_version']}"
    elif action == "records":
        detail = f"更新 {len(data)} 条记录"
    else:
        detail = f"{len(data.get('sources', []))} 份资料 · {len(data.get('records', []))} 条记录"
    actions = {"create": "新建对账", "baseline": "更新对账基准", "records": "修改对账记录",
               "import": "导入对账资料", "restore": "恢复对账资料"}
    return row["owner"], actions[action], row["name"], "", detail, ""


def list_operations(store, entity=None, cursor=None):
    if entity and entity not in ENTITIES:
        raise ValidationError("未知的操作类型。")
    if cursor and len(cursor) > 512:
        raise ValidationError("操作记录翻页位置无效。")
    db = store.db

    @lru_cache(maxsize=2)
    def snapshot(entry):
        if entry is None:
            return {}
        row = db.execute("SELECT payload FROM catalog_versions WHERE id=?", (entry,)).fetchone()
        return {p["id"]: p for p in json.loads(row["payload"])}

    @lru_cache(maxsize=PAGE_SIZE)
    def catalog_id_at(stamp):
        row = db.execute("SELECT id FROM catalog_versions WHERE recorded_at<=? ORDER BY recorded_at DESC,id DESC LIMIT 1",
                         (stamp,)).fetchone()
        return row[0] if row else None

    def catalog_at(stamp):
        return snapshot(catalog_id_at(stamp))

    with store.lock:
        keys = _page_keys(db, entity, cursor)
        items = []
        for key in keys[:PAGE_SIZE]:
            kind, entry = key["entity"], key["entry"]
            if kind in EVENT_NAMES:
                values = _event(db, key, catalog_at)
            elif kind == "catalog":
                values = _catalog(db, entry, snapshot)
            elif kind == "committee":
                values = _committee(db, entry)
            else:
                values = _reconcile(db, key["batch"], entry)
            items.append(dict(zip(("owner", "action", "subject", "month", "detail", "reason"), values),
                              entity=kind, recorded_at=key["recorded_at"]))
        next_cursor = json.dumps(tuple(keys[PAGE_SIZE - 1]), ensure_ascii=False) if len(keys) > PAGE_SIZE else None
        return {"items": items, "next_cursor": next_cursor}
