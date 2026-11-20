"""Persist personal planning views for the authenticated account."""
from __future__ import annotations

import json
import string
import uuid

from .store import ValidationError, text_field


MAX_VIEWS = 100
MAX_CONFIG_BYTES = 256 * 1024
ASCII_LOWER = str.maketrans(string.ascii_uppercase, string.ascii_lowercase)
ACTION_FIELDS = {
    "save": {"name", "config"},
    "select": {"id"},
    "delete": {"id"},
    "import": {"views", "active"},
}


def create_schema(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS user_views (
            account TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL,
            PRIMARY KEY(account, id), UNIQUE(account, name));
        CREATE TABLE IF NOT EXISTS user_view_selection (
            account TEXT PRIMARY KEY, active TEXT NOT NULL);
    """)


def _account(principal):
    if not principal:
        raise ValidationError("无法确认当前登录账号。")
    # Avoid Unicode folds that can collapse different SAM account names, e.g. ß and ss.
    return principal.translate(ASCII_LOWER)


def _view_name(value):
    name = text_field(value, "视图名称", 60)
    if not name or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValidationError("请填写有效的视图名称。")
    try:
        name.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValidationError("视图名称含有无效字符。") from error
    return name


def _view_config(value):
    if not isinstance(value, dict):
        raise ValidationError("视图配置格式不正确。")
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) <= MAX_CONFIG_BYTES:
            return encoded
    except (ValueError, RecursionError) as error:
        raise ValidationError("视图配置格式不正确。") from error
    raise ValidationError("视图配置过大。")


def _view_id(value, *, optional=False):
    if not isinstance(value, str) or len(value) > 100 or (not value and not optional):
        raise ValidationError("视图标识无效。")
    return value


def _read(db, account):
    rows = db.execute("""
        SELECT v.id, v.name, v.config, s.active
        FROM (SELECT ? AS account) AS requested
        LEFT JOIN user_view_selection AS s USING(account)
        LEFT JOIN user_views AS v USING(account)
        ORDER BY v.rowid
    """, (account,)).fetchall()
    return {
        "views": [{"id": row["id"], "name": row["name"], "config": json.loads(row["config"])}
                  for row in rows if row["id"] is not None],
        "active": rows[0]["active"] or "",
    }


def get_views(store, principal):
    account = _account(principal)
    with store.lock:
        return _read(store.db, account)


def _set_active(db, account, view_id):
    db.execute("""
        INSERT INTO user_view_selection(account, active) VALUES (?, ?)
        ON CONFLICT(account) DO UPDATE SET active = excluded.active
    """, (account, view_id))


def _write_view(db, account, known_ids, name, config, *, replace=False):
    if name in known_ids:
        view_id = known_ids[name]
        if replace:
            db.execute("UPDATE user_views SET config = ? WHERE account = ? AND id = ?",
                       (config, account, view_id))
        return view_id
    if len(known_ids) >= MAX_VIEWS:
        raise ValidationError(f"每个账号最多保存 {MAX_VIEWS} 个视图。")
    view_id = uuid.uuid4().hex
    db.execute("INSERT INTO user_views(account, id, name, config) VALUES (?, ?, ?, ?)",
               (account, view_id, name, config))
    known_ids[name] = view_id
    return view_id


def _import_views(body):
    views = body["views"]
    if not isinstance(views, list) or len(views) > MAX_VIEWS:
        raise ValidationError(f"每次最多导入 {MAX_VIEWS} 个本机视图。")
    seen_ids = set()
    items = []
    for view in views:
        if not isinstance(view, dict) or set(view) != {"id", "name", "config"}:
            raise ValidationError("本机视图格式不正确。")
        old_id = _view_id(view["id"])
        if old_id in seen_ids:
            raise ValidationError("本机视图有重复的标识。")
        seen_ids.add(old_id)
        items.append((old_id, _view_name(view["name"]), _view_config(view["config"])))
    return items


def update_views(store, principal, body):
    account = _account(principal)
    action = body.get("action")
    if not isinstance(action, str) or action not in ACTION_FIELDS or set(body) - {"action"} != ACTION_FIELDS[action]:
        raise ValidationError("视图操作或参数无效。")
    if action == "save":
        name, config = _view_name(body["name"]), _view_config(body["config"])
    elif action == "import":
        imports = _import_views(body)
        preferred_id = _view_id(body["active"], optional=True)
    else:
        view_id = _view_id(body["id"], optional=action == "select")

    with store.lock:
        db = store.db
        db.execute("BEGIN IMMEDIATE")
        try:
            known_ids = dict(db.execute("SELECT name, id FROM user_views WHERE account = ?", (account,)))
            extras = {}
            if action == "save":
                view_id = _write_view(db, account, known_ids, name, config, replace=True)
                _set_active(db, account, view_id)
                extras["id"] = view_id
            elif action == "import":
                before = len(known_ids)
                imported_ids = {old_id: _write_view(db, account, known_ids, name, config)
                                for old_id, name, config in imports}
                selection = db.execute("SELECT 1 FROM user_view_selection WHERE account = ?", (account,)).fetchone()
                if selection is None and preferred_id in imported_ids:
                    _set_active(db, account, imported_ids[preferred_id])
                extras["imported"] = len(known_ids) - before
            else:
                if view_id and view_id not in known_ids.values():
                    raise ValidationError("视图不存在或已删除。")
                if action == "select":
                    _set_active(db, account, view_id)
                else:
                    db.execute("DELETE FROM user_views WHERE account = ? AND id = ?", (account, view_id))
                    db.execute("UPDATE user_view_selection SET active = '' WHERE account = ? AND active = ?",
                               (account, view_id))
            result = {**_read(db, account), **extras}
            db.execute("COMMIT")
            return result
        except BaseException:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
