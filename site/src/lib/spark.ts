// Deterministic series and SVG paths for the small charts drawn on the page.

/** A wandering series around `base`, with fixed noise so it renders the same every build. */
export function series(n: number, base: number, wobble: number, seed: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const v =
      base +
      wobble *
        (Math.sin(t * 23 + seed) * 0.5 + Math.sin(t * 57 + seed * 1.7) * 0.3 + Math.sin(t * 131 + seed * 2.3) * 0.2);
    out.push(v);
  }
  return out;
}

/** A line through `values` in a `w × h` box, with `pad` kept clear top and bottom. */
export function linePath(values: number[], w: number, h: number, pad = 2, max?: number, min?: number): string {
  const hi = max ?? Math.max(...values);
  const lo = min ?? Math.min(...values);
  const span = hi - lo || 1;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = pad + (1 - (v - lo) / span) * (h - 2 * pad);
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join("");
}

/** The same line, closed down to the baseline, for a soft fill under it. */
export function areaPath(values: number[], w: number, h: number, pad = 2, max?: number, min?: number): string {
  return `${linePath(values, w, h, pad, max, min)}L${w} ${h}L0 ${h}Z`;
}
