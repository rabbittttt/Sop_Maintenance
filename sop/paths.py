"""Shared paths for the editable plan and raw sales workbooks."""

import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PLAN_WORKBOOK_NAME = "SOP计划维护.xlsx"


def project_path(root, value):
    """Resolve relative configuration against the project, not the launch cwd."""
    path = Path(value).expanduser()
    return path if path.is_absolute() else (Path(root).resolve() / path).resolve()


def _shared_data_root(root):
    if os.environ.get("SHARED_DATA_ROOT"):
        return project_path(root, os.environ["SHARED_DATA_ROOT"])
    shared_root = Path(root).resolve().parent / "共享数据"
    if shared_root.exists():
        if not shared_root.is_dir():
            raise NotADirectoryError(f"共享数据根路径不是目录：{shared_root}")
        return shared_root
    return None


def source_directory(root):
    if os.environ.get("SOP_SOURCE_DIR"):
        return project_path(root, os.environ["SOP_SOURCE_DIR"])
    shared_root = _shared_data_root(root)
    return shared_root / "订单汇总" if shared_root is not None else Path(root) / "input_file"


def runtime_data_directory(root):
    return project_path(root, os.environ["SOP_DATA_DIR"]) if os.environ.get("SOP_DATA_DIR") else persistent_directory(root)


def plan_workbook_path(root):
    if os.environ.get("SOP_PLAN_DIR"):
        return project_path(root, os.environ["SOP_PLAN_DIR"]) / PLAN_WORKBOOK_NAME
    shared_root = _shared_data_root(root)
    directory = shared_root / "SOP计划" if shared_root is not None else Path(root) / "input_file"
    return directory / PLAN_WORKBOOK_NAME


def sales_source_files(source_dir):
    """Return raw sales files; the editable SOP workbook is not a sales source."""
    return sorted(
        path for path in Path(source_dir).glob("*.xlsx")
        if not path.name.startswith("~$")
        and path.name.casefold() != PLAN_WORKBOOK_NAME.casefold()
        and not path.name.lower().endswith(".pending.xlsx")
    )


def persistent_directory(root):
    root = Path(root).resolve()
    value = os.environ.get("PLANHUB_DATA_ROOT", "").strip()
    base = (root / value).resolve() if value else root.parent / "工作台数据"
    destination = base / "database" / "sop"
    if not destination.exists() and (root / "data" / "sop.sqlite3").exists():
        raise RuntimeError("旧持久数据尚未迁移，请先停止服务并运行门户的数据迁移工具；不会创建空库。")
    return destination
