import base64
import os
import sqlite3
import threading
from dataclasses import dataclass
from typing import Any

import requests


@dataclass
class Result:
    rows: list[dict[str, Any]]
    affected: int = 0


def _encode_value(value: Any) -> dict[str, Any]:
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "integer", "value": "1" if value else "0"}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}
    if isinstance(value, float):
        return {"type": "float", "value": value}
    if isinstance(value, bytes):
        return {"type": "blob", "base64": base64.b64encode(value).decode("ascii")}
    return {"type": "text", "value": str(value)}


def _decode_value(value: dict[str, Any]) -> Any:
    value_type = value.get("type")
    if value_type == "null":
        return None
    if value_type == "integer":
        return int(value["value"])
    if value_type == "float":
        return float(value["value"])
    if value_type == "blob":
        return base64.b64decode(value["base64"])
    return value.get("value")


class TursoDatabase:
    def __init__(self, url: str, token: str):
        self.url = url.replace("libsql://", "https://", 1).rstrip("/")
        self.token = token

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> Result:
        statement = {
            "sql": sql,
            "args": [_encode_value(value) for value in params],
            "want_rows": True,
        }
        response = requests.post(
            f"{self.url}/v2/pipeline",
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            json={"baton": None, "requests": [{"type": "execute", "stmt": statement}, {"type": "close"}]},
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
        stream_result = payload["results"][0]
        if stream_result.get("type") == "error":
            error = stream_result.get("error", {})
            raise RuntimeError(error.get("message", "Turso query failed"))
        result = stream_result["response"]["result"]
        columns = [column.get("name") for column in result.get("cols", [])]
        rows = [
            {name: _decode_value(value) for name, value in zip(columns, row)}
            for row in result.get("rows", [])
        ]
        return Result(rows=rows, affected=int(result.get("affected_row_count", 0)))


class LocalDatabase:
    def __init__(self, path: str):
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.lock = threading.Lock()

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> Result:
        with self.lock:
            cursor = self.connection.execute(sql, params)
            rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
            affected = cursor.rowcount if cursor.rowcount >= 0 else 0
            self.connection.commit()
        return Result(rows=rows, affected=affected)


def create_database():
    url = os.getenv("TURSO_DATABASE_URL")
    token = os.getenv("TURSO_AUTH_TOKEN")
    if url and token:
        return TursoDatabase(url, token)
    path = os.getenv("DATABASE_PATH", os.path.join("instance", "read_book.db"))
    if path != ":memory:":
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    return LocalDatabase(path)


SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    """,
)


class DatabaseManager:
    def __init__(self):
        self.database = create_database()
        self.initialized = False
        self.lock = threading.Lock()

    def ensure_schema(self):
        if self.initialized:
            return
        with self.lock:
            if self.initialized:
                return
            for statement in SCHEMA:
                self.database.execute(statement)
            self.initialized = True

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> Result:
        self.ensure_schema()
        return self.database.execute(sql, params)


db = DatabaseManager()
