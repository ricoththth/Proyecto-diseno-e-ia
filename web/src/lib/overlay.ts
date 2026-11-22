// Titular sobre la imagen: la IA busca la zona más tranquila (menos detalle), evita el sujeto
// y la zona de interfaz de Historias, y elige blanco/negro por contraste WCAG.

export type Frac = { x0: number; y0: number; x1: number; y1: number }; // 0..1 del lienzo

const lum = (r: number, g: number, b: number) => {
  const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

export function drawTitle(c: HTMLCanvasElement, text: string, story: boolean, subject: Frac | null) {
  const t = text.trim();
  if (!t) return null;
  const W = c.width, H = c.height;
  const gw = 64, gh = Math.max(8, Math.round((gw * H) / W));
  const s = document.createElement("canvas");
  s.width = gw; s.height = gh;
  const sx = s.getContext("2d", { willReadFrequently: true })!;
  sx.drawImage(c, 0, 0, gw, gh);
  const d = sx.getImageData(0, 0, gw, gh).data;
  const L: number[] = [];
  for (let i = 0; i < d.length; i += 4) L.push(0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!);

  // candidatas: arriba y abajo (en Historias se alejan de la UI de Instagram)
  const zones: { z: "arriba" | "abajo"; r: Frac }[] = story
    ? [{ z: "arriba", r: { x0: 0.08, y0: 0.16, x1: 0.92, y1: 0.4 } }, { z: "abajo", r: { x0: 0.08, y0: 0.58, x1: 0.92, y1: 0.82 } }]
    : [{ z: "arriba", r: { x0: 0.08, y0: 0.06, x1: 0.92, y1: 0.32 } }, { z: "abajo", r: { x0: 0.08, y0: 0.68, x1: 0.92, y1: 0.94 } }];

  const stats = (r: Frac) => {
    let n = 0, sum = 0, e = 0;
    for (let y = Math.max(1, Math.floor(r.y0 * gh)); y < Math.min(gh - 1, Math.ceil(r.y1 * gh)); y++)
      for (let x = Math.max(1, Math.floor(r.x0 * gw)); x < Math.min(gw - 1, Math.ceil(r.x1 * gw)); x++) {
        const v = L[y * gw + x]!;
        e += Math.abs(v - L[y * gw + x + 1]!) + Math.abs(v - L[(y + 1) * gw + x]!);
        sum += v; n++;
      }
    return { energy: n ? e / n : 999, mean: n ? sum / n : 128 };
  };
  const overlap = (a: Frac, b: Frac) => {
    const w = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
    const h = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    return (w * h) / ((a.x1 - a.x0) * (a.y1 - a.y0));
  };
  const scored = zones.map((z) => {
    const st = stats(z.r);
    return { ...z, ...st, score: st.energy + 400 * (subject ? overlap(z.r, subject) : 0) };
  }).sort((a, b) => a.score - b.score);
  const best = scored[0]!;

  // color por contraste
  const Y = (best.mean / 255) ** 2.2; // gris codificado -> luminancia relativa
  const white = 1.05 / (Y + 0.05), black = (Y + 0.05) / 0.05;
  const color = white >= black ? "#ffffff" : "#000000";

  // texto en varias líneas
  const maxW = W * 0.84;
  let size = Math.round(W * (W >= H ? 0.075 : 0.085));
  let lines: string[] = [];
  for (let k = 0; k < 8; k++) {
    c.getContext("2d")!.font = `${size}px "Instrument Serif", Georgia, serif`;
    const ctx = c.getContext("2d")!;
    lines = [];
    let cur = "";
    for (const word of t.split(/\s+/)) {
      const test = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = word; } else cur = test;
    }
    lines.push(cur);
    if (lines.length * size * 1.05 <= (best.r.y1 - best.r.y0) * H) break;
    size = Math.round(size * 0.85);
  }
  const ctx = c.getContext("2d")!;
  ctx.font = `${size}px "Instrument Serif", Georgia, serif`;
  ctx.fillStyle = color;
  ctx.textBaseline = "top";
  ctx.shadowBlur = 0;
  ctx.lineJoin = "round";
  ctx.lineWidth = size * 0.14;
  ctx.strokeStyle = color === "#ffffff" ? "rgba(0,0,0,.55)" : "rgba(255,255,255,.6)"; // halo para que se lea sobre cualquier detalle
  const blockH = lines.length * size * 1.05;
  const top = best.z === "arriba" ? best.r.y0 * H : best.r.y1 * H - blockH;
  lines.forEach((ln, i) => {
    ctx.strokeText(ln, W * 0.08, top + i * size * 1.05);
    ctx.fillText(ln, W * 0.08, top + i * size * 1.05);
  });
  return { zona: best.z, color, contraste: +Math.max(white, black).toFixed(1) };
}
