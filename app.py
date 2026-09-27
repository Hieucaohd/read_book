from flask import Flask, render_template


app = Flask(__name__, static_folder="public", static_url_path="")


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    app.run(debug=True)
