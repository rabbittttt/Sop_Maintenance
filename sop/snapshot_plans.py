"""Plan quantities and differences in immutable historical snapshots."""
from .plan_scope import effective_products, is_model_plan, plan_total
from .source_rules import (_generations as source_generations, generation_parent,
                           normalize_generation, project_generation_sources)


def freeze_summary_plans(payload, groups):
    """Freeze effective parent values from the same cutoff, retaining raw input."""
    if not groups:
        return
    products = payload.get("products", [])
    plans = {(row["product_id"], row["month"]): row for row in payload.get("plans", [])}
    rules = {"groups": groups}
    detail, _ = project_generation_sources({"products": [p for p in products if not p.get("summary_generation")]}, "detail", rules)
    for parent in products:
        name = parent.get("summary_generation")
        if not name or name not in groups:
            continue
        members = [p for p in detail["products"] if generation_parent(p, rules) == name]
        member_ids = {p["id"] for p in members}
        parent["summary_member_product_ids"] = sorted(member_ids)
        parent["identity_read_only"] = True
        months = {month for pid, month in plans if pid in member_ids | {parent["id"]}}
        for month in months:
            key = parent["id"], month
            row = dict(plans.get(key, {"product_id": parent["id"], "month": month, "forecast": None, "revision": 0}))
            raw = row.get("sop")
            automatic = plan_total(members, month, plans)
            chosen = effective_products(members, month, plans)
            known = sum(plans.get((p["id"], month), {}).get("sop") is not None for p in chosen)
            present = {normalize_generation(g) for p in members for g in source_generations(p)}
            # Manual model totals explicitly name their generation in model labels.
            present.update(normalize_generation(p["brand"] + " " + p["model"]) for p in members if not source_generations(p))
            missing = any(normalize_generation(g) not in present for g in groups[name])
            row.update(input_sop=raw, auto_sop=automatic, sop=raw if raw is not None else automatic,
                       derived=raw is None, partial=raw is None and (known < len(chosen) or missing),
                       auto_known_members=known, auto_total_members=len(chosen))
            plans[key] = row
    payload["plans"] = list(plans.values())

def compare_plans(a, b):
    before = {(r["product_id"], r["month"]): r for r in a["plans"]}
    after = {(r["product_id"], r["month"]): r for r in b["plans"]}
    items = []
    for pid, month in sorted(before.keys() | after.keys()):
        aa, bb = before.get((pid, month), {}), after.get((pid, month), {})
        if all(aa.get(field) == bb.get(field) for field in ("forecast", "sop", "owner", "reason", "notes")):
            continue
        item = {"product_id": pid, "month": month}
        for field in ("forecast", "sop", "owner", "reason", "notes", "revision"):
            item[f"{field}_before"] = aa.get(field)
            item[f"{field}_after"] = bb.get(field)
        items.append(item)
    return {"items": items, "left": a["snapshot"], "right": b["snapshot"]}
