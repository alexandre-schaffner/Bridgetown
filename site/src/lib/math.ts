// The easing and mapping every scroll-driven move on the page is built from.

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Smoothstep: 0 at or below `a`, 1 at or above `b`. */
export const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Cubic ease in and out. */
export const inOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** 0 before a, up to 1 by b, held to c, back to 0 by d. */
export const band = (p: number, a: number, b: number, c: number, d: number) => smooth(a, b, p) * (1 - smooth(c, d, p));
