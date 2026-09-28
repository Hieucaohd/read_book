import os
import uuid

os.environ["DATABASE_PATH"] = ":memory:"

from app import app  # noqa: E402


def test_home_page():
    client = app.test_client()
    response = client.get("/")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert "Trang Giấy" in html
    assert 'accept="application/pdf,.pdf"' in html
    assert html.count('for="fileInput"') == 3
    assert "/vendor/pdfjs/pdf.min.js" in html
    assert 'id="vocaSheet"' in html
    assert 'id="selectionSaveButton"' in html
    assert 'id="authGate"' in html
    assert 'id="localLibrary"' in html


def test_reader_assets():
    client = app.test_client()
    assert client.get("/css/app.css").status_code == 200
    javascript = client.get("/js/app.js")
    assert javascript.status_code == 200
    source = javascript.get_data(as_text=True)
    assert "updateCurrentBookProgress" in source
    assert 'window.addEventListener("pagehide"' in source
    assert client.get("/vendor/pdfjs/pdf.min.js").status_code == 200
    assert client.get("/vendor/pdfjs/pdf.worker.min.js").status_code == 200


def test_health():
    client = app.test_client()
    response = client.get("/health")
    assert response.status_code == 200
    assert response.get_json() == {"status": "ok", "database": "local"}


def test_register_settings_logout_and_login():
    client = app.test_client()
    username = f"reader_{uuid.uuid4().hex[:8]}"
    password = "correct-horse-battery-staple"

    registered = client.post("/api/auth/register", json={"username": username, "password": password})
    assert registered.status_code == 201
    payload = registered.get_json()
    assert payload["user"]["username"] == username
    csrf_token = payload["csrf_token"]

    rejected = client.put("/api/settings", json={"theme": "dark"})
    assert rejected.status_code == 403

    updated = client.put(
        "/api/settings",
        json={"theme": "dark", "font_size": 23, "line_height": 1.8},
        headers={"X-CSRF-Token": csrf_token},
    )
    assert updated.status_code == 200
    assert updated.get_json()["settings"]["theme"] == "dark"

    logged_out = client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf_token})
    assert logged_out.status_code == 200
    assert client.get("/api/auth/me").status_code == 401

    logged_in = client.post("/api/auth/login", json={"username": username, "password": password})
    assert logged_in.status_code == 200
    assert logged_in.get_json()["settings"]["font_size"] == 23


def test_registration_validation_and_origin_protection():
    client = app.test_client()
    invalid = client.post("/api/auth/register", json={"username": "x", "password": "short"})
    assert invalid.status_code == 400

    cross_origin = client.post(
        "/api/auth/login",
        json={"username": "someone", "password": "password123"},
        headers={"Origin": "https://attacker.example"},
    )
    assert cross_origin.status_code == 403
