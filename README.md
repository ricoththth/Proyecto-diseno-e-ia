# Exportador multiformato con recorte guiado por IA (PMV)

Script de línea de comandos que recibe una imagen y entrega 4 variantes listas para publicar:

| Formato | Tamaño |
|---|---|
| Instagram Post | 1080×1080 |
| Instagram Historia | 1080×1920 |
| LinkedIn | 1200×627 |
| X | 1200×675 |

Corre en local, sin nube ni costo (Python + OpenCV + Pillow).

## Instalación

```bash
pip install -r requirements.txt
```

La cascada de rostros (`modelos/haarcascade_frontalface_default.xml`) va incluida, porque OpenCV 5.x ya no la trae en el paquete pip.

## Uso

```bash
# Básico
python exportador.py mi_pieza.jpg

# Con revisión humana (T4) y texto alternativo escrito por la persona (T5)
python exportador.py mi_pieza.jpg --revisar --revisor "Jeider" --alt "Descripción de la imagen"
```

Opciones: `--salida` (def. `./salida`), `--registro` (def. `./registro`), `--formato png|jpg`, `--umbral 0.35`.

Resultado en `salida/<pieza>_listo_para_publicar/`:
- 4 imágenes con nombre `<pieza>_<plataforma>_<ancho>x<alto>.png`
- `_deteccion.jpg` (región de interés dibujada, para revisar) y `_deteccion.json`
- `texto_alternativo.txt` (vacío si no se pasó `--alt`; no bloquea nada)

## Cómo decide el recorte (T2)

1. **Rostros** (OpenCV Haar). Se descartan los falsos positivos por el peso de la detección.
2. **Saliencia** (residuo espectral, luminancia + color) si no hay rostro fiable.
3. **Recorte centrado** (respaldo documentado) si la confianza es menor al umbral (0.35).

Luego toma la ventana más grande con la proporción pedida, centrada en el sujeto y desplazada para que quede completo si cabe.

## Revisión humana (T4)

Con `--revisar`, para cada formato se pregunta si el recorte se aprueba sin ajuste. Si no, se puede indicar un nuevo centro en % (`x,y`) y se rehace ese recorte.

## Registro (T7 y bitácora de IA) en `registro/`

- `bitacora_ia.csv`: fecha, herramienta y versión, parámetros, salida original, quién aprobó y con qué criterio, cambios hechos por una persona.
- `metricas_formatos.csv`: método, confianza, aprobación por formato.
- `tiempos_piezas.csv`: tiempo automático y de revisión por pieza.

## Prueba de la métrica con las 3 piezas reales

1. Cronometren a mano (Canva/Photoshop) los 4 formatos de cada pieza, en minutos.
2. Corran `python exportador.py pieza.jpg --revisar --revisor "Nombre"` y revisen de verdad cada formato (el cronómetro de revisión corre mientras responden).
3. Calculen las métricas:

```bash
python resumen_metricas.py --manual "pieza1=15,pieza2=18,pieza3=20"
```

Meta: ≥50 % de reducción de tiempo y ≥3 de 4 formatos aprobados sin ajuste por pieza.

## Límites (alcance del PMV)

Sin interfaz gráfica, sin lotes y sin publicación directa. El texto alternativo es manual: no hay API de descripción de imágenes integrada, así que ninguna imagen sale del equipo. El detector de rostros es frontal; con rostros de perfil o muy pequeños cae a saliencia o a recorte centrado.

## Web (sin servidor)

La carpeta `web/` es la interfaz completa: React + Tailwind, con la IA corriendo **en el navegador**
(MediaPipe: rostros y personas), texto alternativo, paleta con contraste, zona segura de Historias y
bitácora de IA dentro del ZIP. No necesita Python ni backend.

```
cd web
npm install
npm run dev      # desarrollo
npm run build    # genera web/dist
```

Se publica sola en GitHub Pages con cada push a `main` (Settings → Pages → Source: GitHub Actions).
`app.py` y `exportador.py` quedan como la versión de línea de comandos con bitácora y métricas.
