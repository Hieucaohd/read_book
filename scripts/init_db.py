"""Initialize the account/settings schema locally or on the configured Turso database."""

import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))


def load_local_environment():
    env_file = PROJECT_ROOT / ".env.local"
    if not env_file.exists():
        return
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key, value.strip().strip('"'))


load_local_environment()

from database import db  # noqa: E402


if __name__ == "__main__":
    db.ensure_schema()
    tables = db.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").rows
    print("Database schema ready:", ", ".join(row["name"] for row in tables))
