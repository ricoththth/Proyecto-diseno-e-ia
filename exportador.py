#!/usr/bin/env python3
"""
Exportador multiformato con recorte guiado por detección (PMV).

Recibe UNA imagen y entrega 4 variantes listas para publicar:
  - Instagram Post      1080x1080
  - Instagram Historia  1080x1920
  - LinkedIn            1200x627
  - X                   1200x675

Flujo (coincide con la ficha de flujo humano-IA):
  T2 (IA)  Detectar punto de interés: rostros (OpenCV Haar) -> si no hay,
           saliencia espectral -> si la confianza es baja, recorte centrado.
  T3 (A)   Calcular recorte y redimensionar con Pillow (dimensiones exactas).
  T4 (H)   Revisión humana: el diseñador aprueba o corrige cada formato (--revisar).
  T5 (IA)  Texto alternativo OPCIONAL (se escribe a mano con --alt; no bloquea).
  T6 (A)   Exportar con nombres estandarizados en una carpeta lista para publicar.
  T7 (H)   Registrar tiempos y aprobación (CSV en la carpeta de registro).

Uso rápido:
  python exportador.py mi_pieza.jpg --revisar --revisor "Jeider"
"""
import argparse
import csv
import datetime as dt
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import PIL
from PIL import Image, ImageOps

FORMATOS = {
    "instagram_post": (1080, 1080),
    "instagram_historia": (1080, 1920),
    "linkedin": (1200, 627),
    "x": (1200, 675),
}

UMBRAL_CONFIANZA = 0.35  # por debajo de esto se usa recorte centrado
PESO_MIN_ROSTRO = 4.0    # peso mínimo de la cascada para aceptar un rostro


# --------------------------------------------------------------------------
# T2 · Detección del punto de interés
# --------------------------------------------------------------------------
NOMBRE_CASCADA = "haarcascade_frontalface_default.xml"


def cargar_cascada():
    """Busca la cascada primero en ./modelos (copia incluida en el proyecto) y luego
    en la instalación de OpenCV. OpenCV 5.x ya no la trae en el paquete pip."""
    candidatos = [Path(__file__).resolve().parent / "modelos" / NOMBRE_CASCADA]
    datos = getattr(getattr(cv2, "data", None), "haarcascades", None)
    if datos:
        candidatos.append(Path(datos) / NOMBRE_CASCADA)
    for ruta in candidatos:
        if ruta.exists():
            clasif = cv2.CascadeClassifier(str(ruta))
            if not clasif.empty():
                return clasif
    return None


def detectar_rostros(bgr):
    """Rostros frontales con Haar cascade de OpenCV (local, sin conexión)."""
    clasif = cargar_cascada()
    if clasif is None:
        print("[aviso] No se encontró la cascada de rostros; se usa saliencia.", file=sys.stderr)
        return []
    gris = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    lado_min = max(30, int(min(gris.shape) * 0.05))
    cajas, _, pesos = clasif.detectMultiScale3(
        gris, scaleFactor=1.1, minNeighbors=3, minSize=(lado_min, lado_min),
        outputRejectLevels=True,
    )
    # El peso (confianza interna de la cascada) descarta falsos positivos:
    # en pruebas, rostros reales dieron 5.8-7.3 y un falso positivo 2.4.
    out = []
    for c, p in zip(cajas, np.ravel(pesos)):
        if float(p) >= PESO_MIN_ROSTRO:
            out.append((int(c[0]), int(c[1]), int(c[2]), int(c[3]), float(p)))
    return out  # (x, y, w, h, peso)


def mapa_saliencia(bgr):
    """Saliencia por residuo espectral (Hou & Zhang, 2007) en luminancia + 2 canales
    de color (Lab), con relleno reflejado para evitar artefactos de borde.
    Solo numpy/OpenCV. Devuelve el mapa sin normalizar, a tamaño de la imagen."""
    h, w = bgr.shape[:2]
    S, pad = 128, 16
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    canales = [cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), lab[..., 1], lab[..., 2]]
    acc = np.zeros((S, S), np.float32)
    for c in canales:
        peq = cv2.resize(c, (S, S), interpolation=cv2.INTER_AREA).astype(np.float32)
        peq = cv2.copyMakeBorder(peq, pad, pad, pad, pad, cv2.BORDER_REFLECT)
        f = np.fft.fft2(peq)
        log_amp = np.log(np.abs(f) + 1e-8)
        fase = np.angle(f)
        residuo = log_amp - cv2.blur(log_amp, (3, 3))
        s = np.abs(np.fft.ifft2(np.exp(residuo + 1j * fase))) ** 2
        acc += s[pad:-pad, pad:-pad].astype(np.float32)
    acc = cv2.GaussianBlur(acc, (0, 0), 3)
    return cv2.resize(acc, (w, h), interpolation=cv2.INTER_CUBIC)


def _bbox_con_margen(x0, y0, x1, y1, w, h, fx, fy):
    mx, my = int((x1 - x0) * fx), int((y1 - y0) * fy)
    return (int(max(0, x0 - mx)), int(max(0, y0 - my)),
            int(min(w, x1 + mx)), int(min(h, y1 + my)))


def detectar_interes(bgr, umbral=UMBRAL_CONFIANZA):
    """Devuelve dict con método, bbox (x0,y0,x1,y1), centro (cx,cy) y confianza 0-1.
    Orden: rostros -> saliencia -> recorte centrado (respaldo documentado)."""
    h, w = bgr.shape[:2]

    # 1) Rostros
    rostros = detectar_rostros(bgr)
    if rostros:
        x0 = min(r[0] for r in rostros)
        y0 = min(r[1] for r in rostros)
        x1 = max(r[0] + r[2] for r in rostros)
        y1 = max(r[1] + r[3] for r in rostros)
        mejor_peso = max(r[4] for r in rostros)
        confianza = round(min(1.0, mejor_peso / 8.0), 3)
        if confianza >= umbral:
            # margen para incluir frente/mentón y no cortar al ras
            bbox = _bbox_con_margen(x0, y0, x1, y1, w, h, 0.25, 0.35)
            return {
                "metodo": "rostro", "bbox": bbox,
                "centro": ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2),
                "confianza": confianza, "detalle": f"{len(rostros)} rostro(s)",
            }

    # 2) Saliencia
    sal = mapa_saliencia(bgr)
    pico_sobre_media = float(sal.max() / (sal.mean() + 1e-8))
    norm = sal / (sal.max() + 1e-8)
    mascara = (norm > 0.5).astype(np.uint8)
    fraccion = float(mascara.mean())
    # contraste (¿hay algo que resalte?) x compacidad (¿es una región acotada?)
    contraste = max(0.0, min(1.0, (pico_sobre_media - 1.5) / 5.0))
    compacidad = max(0.0, min(1.0, 1 - fraccion / 0.35))
    confianza = round(contraste * compacidad, 3)

    n, etiquetas, stats, _ = cv2.connectedComponentsWithStats(mascara, connectivity=8)
    if n > 1 and confianza >= umbral:
        mejor = max(range(1, n), key=lambda i: float(norm[etiquetas == i].sum()))
        x, y, bw, bh, _ = [int(v) for v in stats[mejor]]
        bbox = _bbox_con_margen(x, y, x + bw, y + bh, w, h, 0.15, 0.15)
        return {
            "metodo": "saliencia", "bbox": bbox,
            "centro": ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2),
            "confianza": confianza,
            "detalle": f"región saliente ({fraccion:.1%} de la imagen)",
        }

    # 3) Respaldo: recorte centrado
    return {
        "metodo": "centrado", "bbox": None, "centro": (w / 2, h / 2),
        "confianza": confianza,
        "detalle": f"sin punto de interés fiable (confianza {confianza} < umbral {umbral})"
                   " -> recorte centrado de respaldo",
    }


# --------------------------------------------------------------------------
# T3 · Cálculo de recorte y redimensionado
# --------------------------------------------------------------------------
def calcular_recorte(w, h, centro, bbox, tw, th):
    """Ventana más grande con la proporción pedida, centrada en el punto de interés
    y desplazada (si cabe) para que la bbox del sujeto quede completa."""
    ratio = tw / th
    if w / h > ratio:
        ch, cw = h, int(round(h * ratio))
    else:
        cw, ch = w, int(round(w / ratio))

    x0 = int(round(centro[0] - cw / 2))
    y0 = int(round(centro[1] - ch / 2))

    if bbox:
        bx0, by0, bx1, by1 = bbox
        if bx1 - bx0 <= cw:
            x0 = max(bx1 - cw, min(x0, bx0))
        if by1 - by0 <= ch:
            y0 = max(by1 - ch, min(y0, by0))

    x0 = max(0, min(x0, w - cw))
    y0 = max(0, min(y0, h - ch))
    caja = (x0, y0, x0 + cw, y0 + ch)

    sujeto_completo = True
    if bbox:
        sujeto_completo = bbox[0] >= caja[0] and bbox[1] >= caja[1] \
            and bbox[2] <= caja[2] and bbox[3] <= caja[3]
    return caja, sujeto_completo


def exportar_variante(img, caja, tw, th, destino, calidad=95):
    recorte = img.crop(caja).resize((tw, th), Image.LANCZOS)
    if destino.suffix.lower() in (".jpg", ".jpeg"):
        recorte.save(destino, quality=calidad, subsampling=0)
    else:
        recorte.save(destino)
    return recorte


# --------------------------------------------------------------------------
# Registro (T7 y bitácora de salidas de IA)
# --------------------------------------------------------------------------
def anexar_csv(ruta, campos, fila):
    ruta.parent.mkdir(parents=True, exist_ok=True)
    nuevo = not ruta.exists()
    with open(ruta, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=campos)
        if nuevo:
            w.writeheader()
        w.writerow(fila)


def guardar_vista_previa(bgr, info, ruta):
    """Imagen con la región de interés dibujada, para la revisión humana."""
    vis = bgr.copy()
    if info["bbox"]:
        x0, y0, x1, y1 = [int(v) for v in info["bbox"]]
        cv2.rectangle(vis, (x0, y0), (x1, y1), (0, 200, 0), max(2, bgr.shape[1] // 400))
    cx, cy = [int(v) for v in info["centro"]]
    cv2.drawMarker(vis, (cx, cy), (0, 0, 255), cv2.MARKER_CROSS, 40, 3)
    cv2.imwrite(str(ruta), vis)


# --------------------------------------------------------------------------
# Programa principal
# --------------------------------------------------------------------------
def pedir_si_no(msg):
    while True:
        r = input(msg + " [s/n]: ").strip().lower()
        if r in ("s", "si", "sí"):
            return True
        if r in ("n", "no"):
            return False


def main():
    ap = argparse.ArgumentParser(description="Exporta una pieza a 4 formatos con recorte guiado.")
    ap.add_argument("imagen", help="Ruta de la imagen original (JPG/PNG)")
    ap.add_argument("--salida", default="salida", help="Carpeta base de salida (def: ./salida)")
    ap.add_argument("--registro", default="registro", help="Carpeta del registro/bitácora (def: ./registro)")
    ap.add_argument("--formato", choices=["png", "jpg"], default="png")
    ap.add_argument("--umbral", type=float, default=UMBRAL_CONFIANZA, help="Confianza mínima (0-1)")
    ap.add_argument("--revisar", action="store_true", help="Revisión interactiva (T4)")
    ap.add_argument("--revisor", default="", help="Quién aprueba (para la bitácora)")
    ap.add_argument("--alt", default="", help="Texto alternativo (opcional, revisado por la persona)")
    args = ap.parse_args()

    t_ini = time.perf_counter()
    ruta = Path(args.imagen)
    if not ruta.exists():
        sys.exit(f"No existe la imagen: {ruta}")

    # EXIF-aware: respeta la rotación de fotos de celular
    img = ImageOps.exif_transpose(Image.open(ruta)).convert("RGB")
    w, h = img.size
    bgr = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)

    # T2 · detección
    info = detectar_interes(bgr, args.umbral)
    print(f"[IA] método: {info['metodo']} · confianza: {info['confianza']} · {info['detalle']}")

    carpeta = Path(args.salida) / f"{ruta.stem}_listo_para_publicar"
    carpeta.mkdir(parents=True, exist_ok=True)
    guardar_vista_previa(bgr, info, carpeta / "_deteccion.jpg")

    # T3 + T6 · recorte, redimensionado y exportación
    ext = "." + args.formato
    resultados = []
    for nombre, (tw, th) in FORMATOS.items():
        caja, completo = calcular_recorte(w, h, info["centro"], info["bbox"], tw, th)
        destino = carpeta / f"{ruta.stem}_{nombre}_{tw}x{th}{ext}"
        exportar_variante(img, caja, tw, th, destino)
        aviso = ""
        if caja[2] - caja[0] < tw or caja[3] - caja[1] < th:
            aviso = " (ampliada: la original es menor que el tamaño destino)"
        if not completo:
            aviso += " (el sujeto no cabe completo en esta proporción)"
        print(f"[A]  {destino.name}{aviso}")
        resultados.append({
            "formato": nombre, "tw": tw, "th": th, "caja": caja, "archivo": destino,
            "sujeto_completo": completo, "estado": "pendiente", "ajuste": "",
        })
    t_auto = time.perf_counter() - t_ini

    # T5 · texto alternativo opcional (no bloquea la exportación)
    (carpeta / "texto_alternativo.txt").write_text(args.alt + "\n", encoding="utf-8")

    # T4 · revisión humana
    t_rev0 = time.perf_counter()
    if args.revisar:
        print(f"\nAbre la carpeta y revisa cada variante:\n  {carpeta.resolve()}\n")
        for r in resultados:
            ok = pedir_si_no(f"¿{r['formato']} aprobado sin ajuste?")
            if ok:
                r["estado"] = "aprobado_sin_ajuste"
                continue
            while True:
                dato = input("  Nuevo centro del sujeto en % (x,y; ej. 30,50) o Enter para omitir: ").strip()
                if not dato:
                    r["estado"] = "rechazado"
                    break
                try:
                    px, py = [float(v) for v in dato.split(",")]
                    centro = (w * px / 100, h * py / 100)
                    caja, completo = calcular_recorte(w, h, centro, None, r["tw"], r["th"])
                    exportar_variante(img, caja, r["tw"], r["th"], r["archivo"])
                    r["caja"], r["estado"], r["ajuste"] = caja, "ajustado", f"centro manual {px},{py}%"
                    print(f"  Recorte rehecho: {r['archivo'].name}")
                    break
                except ValueError:
                    print("  Formato inválido. Usa dos números separados por coma.")
    t_rev = time.perf_counter() - t_rev0

    # T7 · registro
    ahora = dt.datetime.now().isoformat(timespec="seconds")
    reg = Path(args.registro)
    for r in resultados:
        anexar_csv(reg / "metricas_formatos.csv",
                   ["fecha", "pieza", "formato", "metodo", "confianza", "sujeto_completo_auto",
                    "estado_revision", "ajuste_manual"],
                   {"fecha": ahora, "pieza": ruta.stem, "formato": r["formato"],
                    "metodo": info["metodo"], "confianza": info["confianza"],
                    "sujeto_completo_auto": r["sujeto_completo"],
                    "estado_revision": r["estado"], "ajuste_manual": r["ajuste"]})
    anexar_csv(reg / "tiempos_piezas.csv",
               ["fecha", "pieza", "tiempo_automatico_s", "tiempo_revision_s", "tiempo_total_s"],
               {"fecha": ahora, "pieza": ruta.stem, "tiempo_automatico_s": round(t_auto, 2),
                "tiempo_revision_s": round(t_rev, 2) if args.revisar else "",
                "tiempo_total_s": round(t_auto + (t_rev if args.revisar else 0), 2)})

    # Bitácora de salidas de IA (herramienta/versión, parámetros, salida original,
    # aprobación y cambios humanos)
    salida_json = carpeta / "_deteccion.json"
    salida_json.write_text(json.dumps(
        {"metodo": info["metodo"], "confianza": info["confianza"], "bbox": info["bbox"],
         "centro": info["centro"], "detalle": info["detalle"]}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    cambios = "; ".join(f"{r['formato']}: {r['ajuste']}" for r in resultados if r["ajuste"]) or "ninguno"
    aprobados = sum(r["estado"] == "aprobado_sin_ajuste" for r in resultados)
    anexar_csv(reg / "bitacora_ia.csv",
               ["fecha", "pieza", "tarea", "herramienta_version", "instruccion_parametros",
                "salida_original", "aprobado_por_y_criterio", "cambios_por_persona"],
               {"fecha": ahora, "pieza": ruta.stem, "tarea": "T2 detección de punto de interés",
                "herramienta_version": f"Python {sys.version.split()[0]} · OpenCV {cv2.__version__} · Pillow {PIL.__version__}",
                "instruccion_parametros": f"umbral={args.umbral}; método={info['metodo']}; formato={args.formato}",
                "salida_original": str(salida_json),
                "aprobado_por_y_criterio": (f"{args.revisor or 'sin revisor'}: sujeto/texto/logo completos "
                                            f"({aprobados}/4 sin ajuste)") if args.revisar else "pendiente de revisión",
                "cambios_por_persona": cambios})
    if args.alt:
        anexar_csv(reg / "bitacora_ia.csv",
                   ["fecha", "pieza", "tarea", "herramienta_version", "instruccion_parametros",
                    "salida_original", "aprobado_por_y_criterio", "cambios_por_persona"],
                   {"fecha": ahora, "pieza": ruta.stem, "tarea": "T5 texto alternativo",
                    "herramienta_version": "texto aportado por la persona (--alt)",
                    "instruccion_parametros": "", "salida_original": args.alt,
                    "aprobado_por_y_criterio": args.revisor or "sin revisor",
                    "cambios_por_persona": "ninguno"})

    print(f"\nListo en {t_auto:.2f} s (proceso automático). Carpeta: {carpeta.resolve()}")
    if args.revisar:
        print(f"Revisión: {aprobados}/4 aprobados sin ajuste · {t_rev:.0f} s de revisión.")
    print(f"Registro: {reg.resolve()}")


if __name__ == "__main__":
    main()
