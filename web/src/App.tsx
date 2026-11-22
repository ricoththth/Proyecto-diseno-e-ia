import { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { detectSubject, type Box, type Found } from "./lib/detect";
import { cutout } from "./lib/segment";
import { drawTitle } from "./lib/overlay";
import { altText, palette, type Swatch } from "./lib/extras";

const FORMATS = [
  { id: "ig-post", name: "Instagram Post", w: 1080, h: 1080 },
  { id: "ig-story", name: "Instagram Historia", w: 1080, h: 1920 },
  { id: "linkedin", name: "LinkedIn", w: 1200, h: 627 },
  { id: "x", name: "X", w: 1200, h: 675 },
] as const;


type Focus ={ x: number; y: number }; // 0..1 centro del recorte

type Src = HTMLImageElement | HTMLCanvasElement;
const dim = (s: Src): [number, number] => (s instanceof HTMLImageElement ? [s.naturalWidth, s.naturalHeight] : [s.width, s.height]);
const TONES = ["#a3e635", "#a78bfa", "#fb923c", "#171717"];

function cropRect(img: Src, w: number, h: number, f: Focus) {
  const [iw, ih] = dim(img);
  const r = w / h;
  let cw = iw, ch = iw / r;
  if (ch > ih) { ch = ih; cw = ih * r; }
  const sx = Math.min(Math.max(f.x * iw - cw / 2, 0), iw - cw);
  const sy = Math.min(Math.max(f.y * ih - ch / 2, 0), ih - ch);
  return { sx, sy, cw, ch };
}

// Ventana de recorte centrada en la caja del sujeto y desplazada para que quede completa.
function focusForBox(img: Src, w: number, h: number, b: Box): Focus {
  const [iw, ih] = dim(img);
  const { cw, ch } = cropRect(img, w, h, { x: 0.5, y: 0.5 });
  const fit = (c: number, lo: number, hi: number, win: number, max: number) => {
    let s = c - win / 2;
    if (hi - lo <= win) s = Math.min(Math.max(s, hi - win), lo);
    return Math.min(Math.max(s, 0), max - win) + win / 2;
  };
  return { x: fit((b.x0 + b.x1) / 2, b.x0, b.x1, cw, iw) / iw, y: fit((b.y0 + b.y1) / 2, b.y0, b.y1, ch, ih) / ih };
}

// Dibuja el recorte (y el titular, si hay) en un lienzo ya dimensionado.
function paint(c: HTMLCanvasElement, src: Src, fmt: { id: string; w: number; h: number }, f: Focus, subject: Box | null, text: string) {
  const { sx, sy, cw, ch } = cropRect(src, fmt.w, fmt.h, f);
  const x = c.getContext("2d")!;
  x.clearRect(0, 0, c.width, c.height);
  x.drawImage(src, sx, sy, cw, ch, 0, 0, c.width, c.height);
  const frac = subject ? { x0: (subject.x0 - sx) / cw, y0: (subject.y0 - sy) / ch, x1: (subject.x1 - sx) / cw, y1: (subject.y1 - sy) / ch } : null;
  drawTitle(c, text, fmt.id === "ig-story", frac);
}

function render(src: Src, fmt: { id: string; w: number; h: number }, f: Focus, subject: Box | null, text: string) {
  const c = document.createElement("canvas");
  c.width = fmt.w; c.height = fmt.h;
  paint(c, src, fmt, f, subject, text);
  return c;
}

export default function App() {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [name, setName] = useState("imagen");
  const [focus, setFocus] = useState<Record<string, Focus>>({});
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [ia, setIa] = useState<string>("");
  const [alt, setAlt] = useState("");
  const [colors, setColors] = useState<Swatch[]>([]);
  const [safe, setSafe] = useState(true);
  const [adjusted, setAdjusted] = useState<Record<string, boolean>>({});
  const [boxes, setBoxes] = useState<Found[]>([]);
  const [subject, setSubject] = useState<Box | null>(null);
  const [title, setTitle] = useState("");
  const [bg, setBg] = useState<string>("original"); // original | transparent | #hex
  const [cut, setCut] = useState<HTMLCanvasElement | null>(null);
  const [segBusy, setSegBusy] = useState(false);
  const [segErr, setSegErr] = useState(false);
  const log = useRef({ t0: 0, ms: 0, method: "", conf: 0, detail: "" });

  // Detección con IA en el navegador (MediaPipe, sin servidor ni costo).
  const detect = async (i: HTMLImageElement) => {
    setIa("Analizando con IA…");
    const t = performance.now();
    const pal = palette(i);
    setColors(pal);
    try {
      const d = await detectSubject(i);
      setFocus(Object.fromEntries(FORMATS.map((f) => [f.id, d.box ? focusForBox(i, f.w, f.h, d.box) : { x: 0.5, y: 0.5 }])));
      setBoxes(d.boxes);
      setSubject(d.box);
      setIa(`IA: ${d.method} · confianza ${d.confidence} · ${d.detail}`);
      setAlt(altText(d.labels, d.faces, pal.map((p) => p.hex)));
      log.current = { ...log.current, ms: Math.round(performance.now() - t), method: d.method, conf: d.confidence, detail: d.detail };
    } catch {
      setIa("IA no disponible: recorte centrado");
      setAlt(altText([], 0, pal.map((p) => p.hex)));
    }
  };

  const load = (file: File) => {
    const url = URL.createObjectURL(file);
    const i = new Image();
    i.onload = () => {
      setImg(i);
      setName(file.name.replace(/\.[^.]+$/, ""));
      setFocus(Object.fromEntries(FORMATS.map((f) => [f.id, { x: 0.5, y: 0.5 }])));
      setApproved({});
      setAdjusted({});
      setAlt("");
      setBoxes([]); setSubject(null); setCut(null); setBg("original"); setTitle(""); setSegErr(false);
      log.current = { t0: performance.now(), ms: 0, method: "", conf: 0, detail: "" };
      void detect(i);
    };
    i.src = url;
  };

  const work = useMemo<Src | null>(() => {
    if (!img) return null;
    if (bg === "original" || !cut) return img;
    if (bg === "transparent") return cut;
    const c = document.createElement("canvas");
    c.width = cut.width; c.height = cut.height;
    const x = c.getContext("2d")!;
    x.fillStyle = bg; x.fillRect(0, 0, c.width, c.height); x.drawImage(cut, 0, 0);
    return c;
  }, [img, cut, bg]);

  const quitarFondo = async () => {
    if (!img) return;
    setSegBusy(true); setSegErr(false);
    try {
      const hint = subject ? { x: (subject.x0 + subject.x1) / 2, y: (subject.y0 + subject.y1) / 2 } : { x: img.naturalWidth / 2, y: img.naturalHeight / 2 };
      setCut(await cutout(img, hint));
      setBg("transparent");
    } catch { setSegErr(true); }
    setSegBusy(false);
  };

  const download = async () => {
    if (!img || !work) return;
    setBusy(true);
    const png = bg === "transparent";
    const zip = new JSZip();
    for (const f of FORMATS) {
      const c = render(work, f, focus[f.id] ?? { x: 0.5, y: 0.5 }, subject, title);
      const b = await new Promise<Blob>((r) => c.toBlob((x) => r(x!), png ? "image/png" : "image/jpeg", 0.92));
      zip.file(`${name}_${f.id}_${f.w}x${f.h}.${png ? "png" : "jpg"}`, b);
    }
    const sinAjuste = FORMATS.filter((f) => approved[f.id] && !adjusted[f.id]).length;
    zip.file(`${name}_alt.txt`, alt);
    zip.file(`${name}_bitacora_ia.json`, JSON.stringify({
      fecha: new Date().toISOString(), pieza: name, herramienta: "MediaPipe FaceDetector + EfficientDet-Lite0 + SelfieSegmenter (en el navegador)",
      metodo: log.current.method, confianza: log.current.conf, detalle: log.current.detail, tiempo_ia_ms: log.current.ms,
      tiempo_hasta_descarga_s: Math.round((performance.now() - log.current.t0) / 1000),
      formatos: FORMATS.map((f) => ({ formato: f.id, aprobado: !!approved[f.id], ajustado_a_mano: !!adjusted[f.id] })),
      aprobados_sin_ajuste: sinAjuste, meta_aprobacion_3_de_4: sinAjuste >= 3,
      texto_alternativo: alt, paleta: colors,
      detecciones: boxes.map((b) => ({ clase: b.label, confianza: +b.score.toFixed(2) })),
      fondo: bg === "original" ? "original" : bg === "transparent" ? "quitado con IA (transparente)" : `quitado con IA + color ${bg}`, titular: title || null,
    }, null, 2));
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name}_formatos.zip`;
    a.click();
    setBusy(false);
  };

  const count = Object.values(approved).filter(Boolean).length;

  return (
    <div className="min-h-screen bg-background font-sans text-foreground">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 pt-5 font-mono text-xs uppercase tracking-widest">
        <span className="font-display text-2xl normal-case tracking-normal">Exportador<span className="text-tangerine">.</span></span>
        <span className="hidden sm:inline">Diseño e IA</span>
        <span>{img ? `${count}/4 aprobados` : "Listo"}</span>
      </header>

      {!img ? (
        <main className="mx-auto max-w-6xl px-6 pb-16 pt-10">
          <div className="grid grid-cols-12 gap-x-6 border-b border-ink pb-3 font-mono text-[11px] uppercase tracking-widest">
            <span className="col-span-4">Nº 01 — Herramienta</span>
            <span className="col-span-4">Laura Rico · Jeider Bedoya</span>
            <span className="col-span-4 text-right">Bogotá, 2026</span>
          </div>
          <h1 className="mt-10 font-display text-[18vw] leading-[0.8] tracking-tight lg:text-[13rem]">
            Una foto,<br />cuatro <span className="italic text-tangerine">cortes.</span>
          </h1>

          <div className="mt-12 grid grid-cols-12 gap-6">
            <p className="col-span-12 text-xl leading-snug md:col-span-4">
              Subes una imagen y te devolvemos las versiones para Instagram, Historias, LinkedIn y X, con las medidas exactas. Tú decides dónde cae el centro.
            </p>
            <button
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) load(f); }}
              className="crop-marks col-span-12 flex min-h-56 flex-col justify-between border border-dashed border-ink p-6 text-left transition-colors hover:bg-lime md:col-span-8"
            >
              <span className="font-mono text-[11px] uppercase tracking-widest">Soltar archivo · JPG / PNG / WEBP</span>
              <span className="font-display text-5xl">Elegir imagen →</span>
            </button>
          </div>

          <ol className="mt-16 grid grid-cols-2 border-t border-ink md:grid-cols-4">
            {FORMATS.map((f, i) => (
              <li key={f.id} className="border-b border-ink py-5 pr-4 md:border-b-0 md:border-r md:pl-4 md:first:pl-0 md:last:border-r-0">
                <div className="font-mono text-[11px] text-muted-foreground">0{i + 1}</div>
                <div className="mt-6 flex h-24 items-end">
                  <div className={["bg-lime", "bg-lavender", "bg-tangerine", "bg-ink"][i]} style={{ height: 96 * Math.min(1, f.h / f.w), width: 96 * Math.min(1, f.w / f.h) * (f.w > f.h ? 1.4 : 1) }} />
                </div>
                <div className="mt-4 text-lg">{f.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{f.w} × {f.h}</div>
              </li>
            ))}
          </ol>
        </main>
      ) : (
        <main className="mx-auto max-w-6xl px-6 py-10">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">{name}</span>
              <h1 className="mt-4 font-display text-6xl leading-none">Revisa cada <span className="italic">formato.</span></h1>
              <p className="mt-2 text-muted-foreground">Haz clic sobre la vista para mover el centro del recorte.</p>
              {ia && <p className="mt-3 inline-block bg-lime px-3 py-1 font-mono text-xs uppercase tracking-widest">{ia}</p>}
            </div>
            <div className="flex gap-2 font-mono text-xs uppercase tracking-widest">
              <button onClick={() => inputRef.current?.click()} className="rounded-sm border border-ink bg-paper px-5 py-3 hover:bg-lime">Otra imagen</button>
              <button onClick={download} disabled={busy} className="rounded-sm bg-ink px-5 py-3 text-primary-foreground hover:bg-tangerine hover:text-ink disabled:opacity-50">
                {busy ? "Generando…" : "Descargar ZIP ↓"}
              </button>
            </div>
          </div>
          <section className="card-pop mb-5 grid gap-6 p-5 md:grid-cols-2">
            <div>
              <h2 className="font-mono text-xs uppercase tracking-widest">Visión de la IA</h2>
              <div className="relative mt-3 inline-block max-w-full leading-[0]">
                <img src={img.src} alt="" className="max-h-72 max-w-full" />
                {FORMATS.map((f, i) => {
                  const [iw, ih] = dim(img);
                  const { sx, sy, cw, ch } = cropRect(img, f.w, f.h, focus[f.id] ?? { x: 0.5, y: 0.5 });
                  return <div key={f.id} className="pointer-events-none absolute border border-dashed" style={{ left: `${(sx / iw) * 100}%`, top: `${(sy / ih) * 100}%`, width: `${(cw / iw) * 100}%`, height: `${(ch / ih) * 100}%`, borderColor: TONES[i] === "#171717" ? "#ffffff" : TONES[i] }} />;
                })}
                {boxes.map((b, i) => {
                  const [iw, ih] = dim(img);
                  return (
                    <div key={i} className="pointer-events-none absolute border-2 border-lime" style={{ left: `${(b.box.x0 / iw) * 100}%`, top: `${(b.box.y0 / ih) * 100}%`, width: `${((b.box.x1 - b.box.x0) / iw) * 100}%`, height: `${((b.box.y1 - b.box.y0) / ih) * 100}%` }}>
                      <span className="absolute -top-4 left-0 whitespace-nowrap bg-ink px-1 font-mono text-[10px] leading-4 text-lime">{b.label} {Math.round(b.score * 100)}%</span>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Verde: lo que detectó la IA. Punteado: ventana de recorte de cada formato.</p>
            </div>
            <div>
              <h2 className="font-mono text-xs uppercase tracking-widest">Estudio con IA</h2>
              <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-widest">
                {!cut ? (
                  <button onClick={quitarFondo} disabled={segBusy} className="rounded-sm border border-ink px-3 py-2 hover:bg-lime disabled:opacity-50">{segBusy ? "Segmentando…" : "Quitar fondo con IA"}</button>
                ) : (
                  <>
                    <button onClick={() => setBg("original")} className={`rounded-sm border border-ink px-3 py-2 ${bg === "original" ? "bg-lime" : "hover:bg-muted"}`}>Original</button>
                    <button onClick={() => setBg("transparent")} className={`rounded-sm border border-ink px-3 py-2 ${bg === "transparent" ? "bg-lime" : "hover:bg-muted"}`}>Transparente</button>
                    {colors.map((c) => <button key={c.hex} onClick={() => setBg(c.hex)} title={`Fondo ${c.hex}`} className={`h-8 w-8 rounded-sm border ${bg === c.hex ? "border-2 border-ink" : "border-ink/40"}`} style={{ background: c.hex }} />)}
                  </>
                )}
              </div>
              {segErr && <p className="mt-2 text-xs text-destructive">No se pudo segmentar (¿sin conexión para descargar el modelo?).</p>}
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Titular (la IA elige dónde ponerlo)" className="mt-4 w-full border border-ink bg-paper px-3 py-2 text-base" />
              <p className="mt-2 text-xs text-muted-foreground">La IA busca la zona con menos detalle, evita el rostro y la interfaz de Historias, y elige blanco o negro por contraste. Con fondo transparente el ZIP sale en PNG.</p>
            </div>
          </section>
          <section className="card-pop mb-5 grid gap-6 p-5 md:grid-cols-3">
            <div>
              <h2 className="font-mono text-xs uppercase tracking-widest">Texto alternativo (IA)</h2>
              <p className="mt-3 text-sm leading-snug">{alt || "Generando…"}</p>
              {alt && <button onClick={() => void navigator.clipboard?.writeText(alt)} className="mt-3 rounded-sm border border-ink px-3 py-1 font-mono text-[11px] uppercase tracking-widest hover:bg-lime">Copiar</button>}
            </div>
            <div>
              <h2 className="font-mono text-xs uppercase tracking-widest">Paleta y contraste</h2>
              <div className="mt-3 flex gap-2">
                {colors.map((c) => (
                  <div key={c.hex} className="flex h-16 w-full flex-col justify-end p-1 font-mono text-[10px]" style={{ background: c.hex, color: c.ink }} title={`Texto ${c.ink === "#ffffff" ? "blanco" : "negro"} · contraste ${c.ratio}:1`}>
                    <span>{c.hex}</span><span>{c.ratio}:1</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Color de texto con mejor contraste WCAG (≥4.5 es legible).</p>
            </div>
            <div>
              <h2 className="font-mono text-xs uppercase tracking-widest">Métricas del PMV</h2>
              <p className="mt-3 text-sm">Aprobados sin ajuste: <b>{FORMATS.filter((f) => approved[f.id] && !adjusted[f.id]).length}/4</b> (meta ≥3)</p>
              <p className="text-sm">Tiempo de la IA: <b>{log.current.ms ? `${log.current.ms} ms` : "…"}</b></p>
              <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={safe} onChange={(e) => setSafe(e.target.checked)} /> Zona segura de Historias</label>
              <p className="mt-2 text-xs text-muted-foreground">El ZIP incluye la bitácora de IA (JSON) y el texto alternativo.</p>
            </div>
          </section>
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            {FORMATS.map((f, i) => (
              <FormatCard
                key={f.id}
                tone={["bg-lime", "bg-lavender", "bg-tangerine", "bg-ink"][i]!}
                img={work ?? img}
                subject={subject}
                text={title}
                fmt={f}
                safe={safe && f.id === "ig-story"}
                focus={focus[f.id] ?? { x: 0.5, y: 0.5 }}
                approved={!!approved[f.id]}
                onFocus={(p) => { setAdjusted((s) => ({ ...s, [f.id]: true })); setFocus((s) => ({ ...s, [f.id]: p })); setApproved((s) => ({ ...s, [f.id]: false })); }}
                onApprove={() => setApproved((s) => ({ ...s, [f.id]: !s[f.id] }))}
                onReset={() => setFocus((s) => ({ ...s, [f.id]: { x: 0.5, y: 0.5 } }))}
              />
            ))}
          </div>
        </main>
      )}
      <input ref={inputRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); e.target.value = ""; }} />
    </div>
  );
}

function FormatCard({ tone, img, subject, text, fmt, safe, focus, approved, onFocus, onApprove, onReset }: {
  tone: string; img: Src; subject: Box | null; text: string; fmt: (typeof FORMATS)[number]; safe: boolean; focus: Focus; approved: boolean;
  onFocus: (f: Focus) => void; onApprove: () => void; onReset: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ w: 0, h: 0 });
  // Tamaño exacto del lienzo dentro de la caja (para que el overlay coincida con la imagen).
  useEffect(() => {
    const el = holder.current; if (!el) return;
    const calc = () => {
      const cs = getComputedStyle(el);
      const aw = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const ah = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const k = Math.min(aw / fmt.w, ah / fmt.h);
      setFit({ w: Math.floor(fmt.w * k), h: Math.floor(fmt.h * k) });
    };
    calc();
    const ro = new ResizeObserver(calc); ro.observe(el);
    return () => ro.disconnect();
  }, [fmt]);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const scale = 600 / Math.max(fmt.w, fmt.h);
    c.width = Math.round(fmt.w * scale); c.height = Math.round(fmt.h * scale);
    paint(c, img, fmt, focus, subject, text);
  }, [img, fmt, focus, subject, text]);

  const click = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const { sx, sy, cw, ch } = cropRect(img, fmt.w, fmt.h, focus);
    const px = sx + ((e.clientX - r.left) / r.width) * cw;
    const py = sy + ((e.clientY - r.top) / r.height) * ch;
    const [iw, ih] = dim(img);
    onFocus({ x: px / iw, y: py / ih });
  };

  return (
    <section className="card-pop flex flex-col p-4">
      <div className="flex items-baseline justify-between font-mono text-xs uppercase tracking-widest">
        <span>{fmt.name}</span>
        <span className="text-muted-foreground">{fmt.w}×{fmt.h}</span>
      </div>
      <div ref={holder} className={`mt-4 crop-marks flex h-72 items-center justify-center p-5 ${tone}`}>
        <div className="relative shrink-0" style={{ width: fit.w, height: fit.h }}>
          <canvas ref={ref} onClick={click} className="block h-full w-full cursor-crosshair" />
          {safe && (
            <>
              <div className="pointer-events-none absolute inset-x-0 top-0 flex items-end justify-center border-b border-dashed border-white bg-black/45 pb-0.5 font-mono text-[9px] uppercase text-white" style={{ height: "13%" }}>perfil / UI</div>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-start justify-center border-t border-dashed border-white bg-black/45 pt-0.5 font-mono text-[9px] uppercase text-white" style={{ height: "17.7%" }}>responder / enviar</div>
            </>
          )}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 font-mono text-xs uppercase tracking-widest">
        <button onClick={onReset} className="rounded-sm border border-ink py-2 hover:bg-muted">Centrar</button>
        <button onClick={onApprove} className={`rounded-sm border border-ink py-2 ${approved ? "bg-lime" : "hover:bg-muted"}`}>
          {approved ? "Aprobado ✓" : "Aprobar"}
        </button>
      </div>
    </section>
  );
}
