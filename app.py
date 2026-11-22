"""Versión web sencilla del exportador. Uso: python app.py  ->  http://localhost:5000"""
import base64
import io
import zipfile

import cv2
import numpy as np
from flask import Flask, request, send_file, render_template_string
from PIL import Image, ImageOps

from exportador import FORMATOS, detectar_interes, calcular_recorte

app = Flask(__name__)

PAGINA = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Exportador multiformato</title>
<style>body{font-family:system-ui;max-width:960px;margin:2rem auto;padding:0 1rem}
.g{display:flex;flex-wrap:wrap;gap:1rem}figure{margin:0}img{max-height:260px;border:1px solid #ccc}
button,a.b{padding:.6rem 1rem;background:#222;color:#fff;border:0;border-radius:6px;text-decoration:none;cursor:pointer}
small{color:#555}</style>
<h1>Exportador multiformato</h1>
<p>Sube una pieza y recibe 4 variantes con recorte guiado por detección.</p>
<form method=post enctype=multipart/form-data>
<input type=file name=imagen accept="image/*" required> <button>Exportar</button></form>
{% if fotos %}
<p><small>Método: <b>{{metodo}}</b> · confianza {{conf}}. Revisa cada recorte antes de publicar.</small></p>
<div class=g>{% for n,d in fotos %}<figure><img src="data:image/png;base64,{{d}}"><figcaption>{{n}}</figcaption></figure>{% endfor %}</div>
<p><a class=b href="/zip/{{token}}">Descargar ZIP</a></p>{% endif %}"""

ZIPS = {}  # token -> bytes (memoria local, uso de un solo usuario)


@app.route("/", methods=["GET", "POST"])
def inicio():
    if request.method == "GET":
        return render_template_string(PAGINA)
    img = ImageOps.exif_transpose(Image.open(request.files["imagen"].stream)).convert("RGB")
    w, h = img.size
    info = detectar_interes(cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR))
    fotos, buf = [], io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for nombre, (tw, th) in FORMATOS.items():
            caja, _ = calcular_recorte(w, h, info["centro"], info["bbox"], tw, th)
            out = img.crop(caja).resize((tw, th), Image.LANCZOS)
            b = io.BytesIO(); out.save(b, "PNG")
            z.writestr(f"{nombre}_{tw}x{th}.png", b.getvalue())
            fotos.append((f"{nombre} {tw}×{th}", base64.b64encode(b.getvalue()).decode()))
    token = str(len(ZIPS))
    ZIPS[token] = buf.getvalue()
    return render_template_string(PAGINA, fotos=fotos, metodo=info["metodo"],
                                  conf=info["confianza"], token=token)


@app.route("/zip/<token>")
def descargar(token):
    return send_file(io.BytesIO(ZIPS[token]), as_attachment=True, download_name="piezas.zip")


@app.after_request
def cors(r):  # permite que el front (Lovable) llame a esta API
    r.headers["Access-Control-Allow-Origin"] = "*"
    r.headers["Access-Control-Allow-Headers"] = "*"
    return r


@app.route("/api/detectar", methods=["POST", "OPTIONS"])
def api_detectar():
    """Solo detección: devuelve método, confianza y el centro sugerido (0-1) por formato."""
    if request.method == "OPTIONS":
        return "", 204
    img = ImageOps.exif_transpose(Image.open(request.files["imagen"].stream)).convert("RGB")
    w, h = img.size
    info = detectar_interes(cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR))
    focos = {}
    for nombre, (tw, th) in FORMATOS.items():
        caja, _ = calcular_recorte(w, h, info["centro"], info["bbox"], tw, th)
        focos[nombre] = [(caja[0] + caja[2]) / 2 / w, (caja[1] + caja[3]) / 2 / h]
    return {"metodo": info["metodo"], "confianza": info["confianza"],
            "detalle": info["detalle"], "focos": focos}


@app.route("/api/exportar", methods=["POST", "OPTIONS"])
def api_exportar():
    """multipart: imagen [, cx, cy en 0-1 para fijar el centro a mano].
    Devuelve JSON con método de IA, confianza y las 4 variantes en base64."""
    if request.method == "OPTIONS":
        return "", 204
    img = ImageOps.exif_transpose(Image.open(request.files["imagen"].stream)).convert("RGB")
    w, h = img.size
    info = detectar_interes(cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR))
    centro, bbox, metodo = info["centro"], info["bbox"], info["metodo"]
    if request.form.get("cx") and request.form.get("cy"):
        centro = (float(request.form["cx"]) * w, float(request.form["cy"]) * h)
        bbox, metodo = None, "manual"
    out = []
    for nombre, (tw, th) in FORMATOS.items():
        caja, _ = calcular_recorte(w, h, centro, bbox, tw, th)
        b = io.BytesIO()
        img.crop(caja).resize((tw, th), Image.LANCZOS).save(b, "PNG")
        out.append({"formato": nombre, "ancho": tw, "alto": th,
                    "png_base64": base64.b64encode(b.getvalue()).decode()})
    return {"metodo": metodo, "confianza": info["confianza"], "detalle": info["detalle"],
            "centro": [centro[0] / w, centro[1] / h], "variantes": out}


if __name__ == "__main__":
    app.run(debug=False)
