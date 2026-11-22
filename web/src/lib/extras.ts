// Complementos de IA que corren en el navegador: texto alternativo, paleta y contraste.

const ES: Record<string, [string, string]> = {
  person: ["persona", "personas"], bicycle: ["bicicleta", "bicicletas"], car: ["auto", "autos"],
  motorcycle: ["moto", "motos"], bus: ["bus", "buses"], truck: ["camión", "camiones"],
  bird: ["pájaro", "pájaros"], cat: ["gato", "gatos"], dog: ["perro", "perros"], horse: ["caballo", "caballos"],
  bottle: ["botella", "botellas"], cup: ["taza", "tazas"], chair: ["silla", "sillas"], couch: ["sofá", "sofás"],
  "potted plant": ["planta", "plantas"], bed: ["cama", "camas"], "dining table": ["mesa", "mesas"],
  tv: ["televisor", "televisores"], laptop: ["portátil", "portátiles"], "cell phone": ["celular", "celulares"],
  book: ["libro", "libros"], clock: ["reloj", "relojes"], backpack: ["mochila", "mochilas"],
  handbag: ["bolso", "bolsos"], umbrella: ["paraguas", "paraguas"], bench: ["banca", "bancas"],
  boat: ["bote", "botes"], airplane: ["avión", "aviones"], bowl: ["tazón", "tazones"], vase: ["florero", "floreros"],
};

/** Texto alternativo en español a partir de lo detectado (sin enviar nada a la nube). */
export function altText(labels: string[], faces: number, hex: string[]): string {
  const count: Record<string, number> = {};
  for (const l of labels) count[l] = (count[l] ?? 0) + 1;
  const parts = Object.entries(count).map(([k, n]) => `${n} ${(ES[k] ?? [k, k])[n > 1 ? 1 : 0]}`);
  const sujeto = faces > 0 && !count["person"] ? [`${faces} ${faces > 1 ? "rostros" : "rostro"}`] : parts;
  const base = sujeto.length ? `Imagen con ${sujeto.join(", ")}` : "Imagen sin sujeto principal identificable";
  return `${base}. Tonos dominantes: ${hex.slice(0, 3).join(", ")}.`;
}

export type Swatch = { hex: string; ink: "#000000" | "#ffffff"; ratio: number };

const lum = (r: number, g: number, b: number) => {
  const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const hex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** Paleta dominante por k-means y color de texto (blanco/negro) con mejor contraste WCAG. */
export function palette(img: HTMLImageElement, k = 5): Swatch[] {
  const c = document.createElement("canvas");
  c.width = c.height = 48;
  const x = c.getContext("2d")!;
  x.drawImage(img, 0, 0, 48, 48);
  const d = x.getImageData(0, 0, 48, 48).data;
  const px: number[][] = [];
  for (let i = 0; i < d.length; i += 4) px.push([d[i]!, d[i + 1]!, d[i + 2]!]);
  let cen = Array.from({ length: k }, (_, i) => px[Math.floor(((i + 0.5) * px.length) / k)]!.slice());
  const sizes = new Array(k).fill(0);
  for (let it = 0; it < 8; it++) {
    const sum = cen.map(() => [0, 0, 0, 0]);
    for (const p of px) {
      let b = 0, bd = Infinity;
      cen.forEach((m, j) => { const dd = (p[0]! - m[0]!) ** 2 + (p[1]! - m[1]!) ** 2 + (p[2]! - m[2]!) ** 2; if (dd < bd) { bd = dd; b = j; } });
      const s = sum[b]!; s[0]! += p[0]!; s[1]! += p[1]!; s[2]! += p[2]!; s[3]!++;
    }
    cen = sum.map((s, j) => (s[3]! ? [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!] : cen[j]!));
    sum.forEach((s, j) => (sizes[j] = s[3]!));
  }
  return cen
    .map((m, j) => ({ m, n: sizes[j] as number }))
    .sort((a, b) => b.n - a.n)
    .map(({ m }) => {
      const L = lum(m[0]!, m[1]!, m[2]!);
      const white = 1.05 / (L + 0.05), black = (L + 0.05) / 0.05;
      return { hex: hex(m[0]!, m[1]!, m[2]!), ink: white >= black ? "#ffffff" : "#000000", ratio: +Math.max(white, black).toFixed(1) } as Swatch;
    });
}
