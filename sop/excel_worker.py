"""Generate Excel files in a time-limited child of the service interpreter."""
import json
import os
from pathlib import Path
import subprocess
import sys


def render(kind, payload, *, timeout=120):
    command = [sys.executable, str(Path(__file__).resolve()), kind]
    result = subprocess.run(command, input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                            capture_output=True, cwd=Path(__file__).resolve().parents[1],
                            timeout=timeout, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace")[-2000:])


if __name__ == "__main__":
    # Embeddable Windows runtimes may omit the release directory from sys.path.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    sys.stderr.reconfigure(encoding="utf-8")
    if sys.argv[1:] == ["plan"]:
        from sop.xlsx_export import write_export_workbook as write
    elif sys.argv[1:] == ["snapshot"]:
        from sop.xlsx_backup import write_snapshot_workbook as write
    else:
        raise SystemExit("Unknown Excel output")
    write(json.load(sys.stdin.buffer))
