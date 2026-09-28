import json
import os
import re
import secrets
import time
import uuid
from datetime import datetime, timezone
from functools import wraps
from threading import Lock

from flask import Flask, jsonify, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from database import db


app = Flask(__name__, static_folder="public", static_url_path="")
secret_key = os.getenv("FLASK_SECRET_KEY")
if os.getenv("VERCEL") and not secret_key:
    raise RuntimeError("FLASK_SECRET_KEY is required in production")
app.config.update(
    SECRET_KEY=secret_key or "local-development-only-change-me",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=bool(os.getenv("VERCEL")),
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 30,
    MAX_CONTENT_LENGTH=1024 * 1024,
)

DEFAULT_SETTINGS = {
    "theme": "sepia",
    "font_size": 19,
    "line_height": 1.7,
    "voca_collection_id": "",
}

_login_attempts = {}
_login_lock = Lock()


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def api_error(message, status=400, code="BAD_REQUEST"):
    return jsonify({"error": {"code": code, "message": message}}), status


def valid_username(username):
    return bool(re.fullmatch(r"[A-Za-z0-9_.-]{3,32}", username))


def client_rate_key(username):
    forwarded = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
    return f"{forwarded or request.remote_addr or 'unknown'}:{username.casefold()}"


def login_rate_limited(username):
    key = client_rate_key(username)
    now = time.time()
    with _login_lock:
        recent = [stamp for stamp in _login_attempts.get(key, []) if now - stamp < 900]
        _login_attempts[key] = recent
        return len(recent) >= 10


def record_login_failure(username):
    key = client_rate_key(username)
    with _login_lock:
        _login_attempts.setdefault(key, []).append(time.time())


def clear_login_failures(username):
    with _login_lock:
        _login_attempts.pop(client_rate_key(username), None)


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            return api_error("Bạn cần đăng nhập.", 401, "UNAUTHORIZED")
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            token = request.headers.get("X-CSRF-Token", "")
            if not token or not secrets.compare_digest(token, session.get("csrf_token", "")):
                return api_error("Phiên bảo mật không hợp lệ. Hãy tải lại trang.", 403, "CSRF_FAILED")
        return view(*args, **kwargs)

    return wrapped


def get_user_settings(user_id):
    result = db.execute("SELECT settings_json FROM user_settings WHERE user_id = ?", (user_id,))
    if not result.rows:
        return DEFAULT_SETTINGS.copy()
    try:
        stored = json.loads(result.rows[0]["settings_json"])
    except (TypeError, ValueError):
        stored = {}
    return {**DEFAULT_SETTINGS, **{key: stored[key] for key in DEFAULT_SETTINGS if key in stored}}


def sanitize_settings(payload):
    settings = {}
    if "theme" in payload:
        if payload["theme"] not in {"light", "sepia", "dark"}:
            raise ValueError("Giao diện không hợp lệ.")
        settings["theme"] = payload["theme"]
    if "font_size" in payload:
        value = int(payload["font_size"])
        if not 14 <= value <= 34:
            raise ValueError("Cỡ chữ không hợp lệ.")
        settings["font_size"] = value
    if "line_height" in payload:
        value = round(float(payload["line_height"]), 2)
        if not 1.35 <= value <= 2.1:
            raise ValueError("Khoảng cách dòng không hợp lệ.")
        settings["line_height"] = value
    if "voca_collection_id" in payload:
        value = str(payload["voca_collection_id"]).strip()
        if len(value) > 200:
            raise ValueError("Bộ từ Voca không hợp lệ.")
        settings["voca_collection_id"] = value
    return settings


@app.before_request
def protect_api_origin():
    if request.path.startswith("/api/") and request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        origin = request.headers.get("Origin")
        if origin and origin.rstrip("/") != request.host_url.rstrip("/"):
            return api_error("Nguồn yêu cầu không hợp lệ.", 403, "INVALID_ORIGIN")


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/health")
def health():
    return {"status": "ok", "database": "turso" if os.getenv("TURSO_DATABASE_URL") else "local"}


@app.post("/api/auth/register")
def register():
    payload = request.get_json(silent=True) or {}
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", ""))
    if not valid_username(username):
        return api_error("Tên đăng nhập cần 3–32 ký tự, chỉ gồm chữ, số, dấu chấm, gạch ngang hoặc gạch dưới.")
    if not 8 <= len(password) <= 128:
        return api_error("Mật khẩu cần từ 8 đến 128 ký tự.")
    user_id = str(uuid.uuid4())
    try:
        db.execute(
            "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
            (user_id, username, generate_password_hash(password, method="scrypt"), utc_now()),
        )
    except Exception as error:
        if "unique" in str(error).lower() or "constraint" in str(error).lower():
            return api_error("Tên đăng nhập này đã được sử dụng.", 409, "USERNAME_EXISTS")
        app.logger.exception("Registration failed")
        return api_error("Không thể tạo tài khoản lúc này.", 503, "DATABASE_ERROR")
    session.clear()
    session.permanent = True
    session["user_id"] = user_id
    session["username"] = username
    session["csrf_token"] = secrets.token_urlsafe(24)
    return jsonify({"user": {"id": user_id, "username": username}, "csrf_token": session["csrf_token"], "settings": DEFAULT_SETTINGS}), 201


@app.post("/api/auth/login")
def login():
    payload = request.get_json(silent=True) or {}
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", ""))
    if login_rate_limited(username):
        return api_error("Quá nhiều lần thử. Vui lòng đợi 15 phút.", 429, "RATE_LIMITED")
    try:
        result = db.execute("SELECT id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE", (username,))
    except Exception:
        app.logger.exception("Login query failed")
        return api_error("Không thể đăng nhập lúc này.", 503, "DATABASE_ERROR")
    user = result.rows[0] if result.rows else None
    if not user or not check_password_hash(user["password_hash"], password):
        record_login_failure(username)
        return api_error("Tên đăng nhập hoặc mật khẩu không đúng.", 401, "INVALID_CREDENTIALS")
    clear_login_failures(username)
    session.clear()
    session.permanent = True
    session["user_id"] = user["id"]
    session["username"] = user["username"]
    session["csrf_token"] = secrets.token_urlsafe(24)
    return jsonify({
        "user": {"id": user["id"], "username": user["username"]},
        "csrf_token": session["csrf_token"],
        "settings": get_user_settings(user["id"]),
    })


@app.post("/api/auth/logout")
@login_required
def logout():
    session.clear()
    return {"status": "ok"}


@app.get("/api/auth/me")
def current_user():
    user_id = session.get("user_id")
    if not user_id:
        return api_error("Bạn chưa đăng nhập.", 401, "UNAUTHORIZED")
    return {
        "user": {"id": user_id, "username": session.get("username")},
        "csrf_token": session.get("csrf_token"),
        "settings": get_user_settings(user_id),
    }


@app.get("/api/settings")
@login_required
def read_settings():
    return {"settings": get_user_settings(session["user_id"])}


@app.put("/api/settings")
@login_required
def update_settings():
    payload = request.get_json(silent=True) or {}
    try:
        updates = sanitize_settings(payload)
    except (TypeError, ValueError) as error:
        return api_error(str(error), 422, "VALIDATION_ERROR")
    settings = {**get_user_settings(session["user_id"]), **updates}
    db.execute(
        """
        INSERT INTO user_settings (user_id, settings_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at
        """,
        (session["user_id"], json.dumps(settings, ensure_ascii=False), utc_now()),
    )
    return {"settings": settings}


if __name__ == "__main__":
    app.run(debug=True)
