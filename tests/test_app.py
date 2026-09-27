from app import app


def test_home_page():
    client = app.test_client()
    response = client.get("/")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert "Trang Giấy" in html
    assert 'accept="application/pdf,.pdf"' in html
    assert html.count('for="fileInput"') == 2
    assert "/vendor/pdfjs/pdf.min.js" in html


def test_reader_assets():
    client = app.test_client()
    assert client.get("/css/app.css").status_code == 200
    assert client.get("/js/app.js").status_code == 200
    assert client.get("/vendor/pdfjs/pdf.min.js").status_code == 200
    assert client.get("/vendor/pdfjs/pdf.worker.min.js").status_code == 200


def test_health():
    client = app.test_client()
    response = client.get("/health")
    assert response.status_code == 200
    assert response.get_json() == {"status": "ok"}
