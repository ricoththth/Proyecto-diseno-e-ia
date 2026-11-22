// Quitar fondo con segmentación de personas (MediaPipe ImageSegmenter, en el navegador).
import type { ImageSegmenter } from "@mediapipe/tasks-vision";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const SEG_MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

let segP: Promise<ImageSegmenter> | null = null;
function segmenter() {
  return (segP ??= (async () => {
    const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(WASM);
    return ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: SEG_MODEL },
      runningMode: "IMAGE",
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
  })());
}

/** Devuelve la imagen con el fondo transparente. `hint` = punto (px) que seguro es la persona. */
export async function cutout(img: HTMLImageElement, hint: { x: number; y: number }): Promise<HTMLCanvasElement> {
  const w = img.naturalWidth, h = img.naturalHeight;
  const seg = await segmenter();
  const res = seg.segment(img);
  const mask = res.categoryMask!;
  const data = mask.getAsUint8Array();
  const mw = mask.width, mh = mask.height;
  const at = (x: number, y: number) => data[Math.min(mh - 1, Math.floor((y / h) * mh)) * mw + Math.min(mw - 1, Math.floor((x / w) * mw))]!;
  const person = at(hint.x, hint.y); // el valor que cubre al sujeto (no asumo 0/1)

  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d")!;
  x.drawImage(img, 0, 0);
  const px = x.getImageData(0, 0, w, h);
  for (let j = 0; j < h; j++) {
    const row = Math.min(mh - 1, Math.floor((j / h) * mh)) * mw;
    for (let i = 0; i < w; i++) {
      if (data[row + Math.min(mw - 1, Math.floor((i / w) * mw))] !== person) px.data[(j * w + i) * 4 + 3] = 0;
    }
  }
  x.putImageData(px, 0, 0);
  mask.close();
  return c;
}
