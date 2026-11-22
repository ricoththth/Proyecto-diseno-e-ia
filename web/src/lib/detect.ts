// Detección de sujeto 100 % en el navegador (MediaPipe Tasks Vision, WASM).
// La imagen nunca sale del dispositivo y no hay servidor ni costo por uso.
import type { FaceDetector, ObjectDetector } from "@mediapipe/tasks-vision";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const OBJ_MODEL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

export type Box = { x0: number; y0: number; x1: number; y1: number }; // píxeles
export type Found = { box: Box; label: string; score: number };
export type Detection = {
  boxes: Found[]; // todo lo que vio la IA, para dibujarlo en pantalla
  method: "rostro" | "persona" | "objeto" | "centrado";
  confidence: number;
  detail: string;
  box: Box | null;
  faces: number;
  labels: string[]; // clases detectadas (COCO), para el texto alternativo
};

let faceP: Promise<FaceDetector> | null = null;
let objP: Promise<ObjectDetector> | null = null;

async function vision() {
  const { FilesetResolver } = await import("@mediapipe/tasks-vision");
  return { FilesetResolver, fileset: await FilesetResolver.forVisionTasks(WASM) };
}

function face() {
  return (faceP ??= (async () => {
    const { FaceDetector } = await import("@mediapipe/tasks-vision");
    const { fileset } = await vision();
    return FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL },
      runningMode: "IMAGE",
      minDetectionConfidence: 0.5,
    });
  })());
}

function objects() {
  return (objP ??= (async () => {
    const { ObjectDetector } = await import("@mediapipe/tasks-vision");
    const { fileset } = await vision();
    return ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: OBJ_MODEL },
      runningMode: "IMAGE",
      scoreThreshold: 0.4,
      maxResults: 5,
    });
  })());
}

const union = (bs: Box[]): Box => ({
  x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)),
  x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)),
});

function margin(b: Box, w: number, h: number, fx: number, fy: number): Box {
  const mx = (b.x1 - b.x0) * fx, my = (b.y1 - b.y0) * fy;
  return { x0: Math.max(0, b.x0 - mx), y0: Math.max(0, b.y0 - my), x1: Math.min(w, b.x1 + mx), y1: Math.min(h, b.y1 + my) };
}

/** Rostros -> personas/objetos -> centrado (respaldo), igual que exportador.py. */
export async function detectSubject(img: HTMLImageElement): Promise<Detection> {
  const w = img.naturalWidth, h = img.naturalHeight;

  const od = await objects();
  const dets = od.detect(img).detections.filter((d) => d.boundingBox);
  const labels = dets.map((d) => d.categories[0]?.categoryName ?? "").filter(Boolean);

  const fd = await face();
  const faces = fd.detect(img).detections.filter((d) => d.boundingBox);
  const toBox = (d: { boundingBox?: { originX: number; originY: number; width: number; height: number } }): Box => ({
    x0: d.boundingBox!.originX, y0: d.boundingBox!.originY,
    x1: d.boundingBox!.originX + d.boundingBox!.width, y1: d.boundingBox!.originY + d.boundingBox!.height,
  });
  const boxes: Found[] = [
    ...faces.map((d) => ({ box: toBox(d), label: "rostro", score: d.categories[0]?.score ?? 0 })),
    ...dets.map((d) => ({ box: toBox(d), label: d.categories[0]?.categoryName ?? "objeto", score: d.categories[0]?.score ?? 0 })),
  ];
  if (faces.length) {
    const bs = faces.map((d) => ({
      x0: d.boundingBox!.originX, y0: d.boundingBox!.originY,
      x1: d.boundingBox!.originX + d.boundingBox!.width, y1: d.boundingBox!.originY + d.boundingBox!.height,
    }));
    const conf = Math.max(...faces.map((d) => d.categories[0]?.score ?? 0));
    return { boxes, method: "rostro", confidence: +conf.toFixed(2), detail: `${faces.length} rostro(s)`, faces: faces.length, labels, box: margin(union(bs), w, h, 0.25, 0.35) };
  }

  if (dets.length) {
    const people = dets.filter((d) => d.categories[0]?.categoryName === "person");
    const use = people.length ? people : dets.slice(0, 1);
    const bs = use.map((d) => ({
      x0: d.boundingBox!.originX, y0: d.boundingBox!.originY,
      x1: d.boundingBox!.originX + d.boundingBox!.width, y1: d.boundingBox!.originY + d.boundingBox!.height,
    }));
    const conf = Math.max(...use.map((d) => d.categories[0]?.score ?? 0));
    const name = use[0]?.categories[0]?.categoryName ?? "objeto";
    return {
      boxes, method: people.length ? "persona" : "objeto", confidence: +conf.toFixed(2),
      faces: 0, labels, detail: people.length ? `${people.length} persona(s)` : name, box: margin(union(bs), w, h, 0.08, 0.08),
    };
  }

  return { boxes, method: "centrado", confidence: 0, detail: "sin sujeto fiable, recorte centrado", box: null, faces: 0, labels };
}
