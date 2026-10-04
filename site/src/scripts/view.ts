// Where the arch scene's camera is and what it looks at. Kept apart from scene.ts so the page
// can plan camera moves before three.js has loaded.

/** `white` floods the frame with day; `flare` is 0 at rest, up to 1 as the camera nears the light. */
export interface View {
  x: number;
  y: number;
  z: number;
  lookX: number;
  lookY: number;
  lookZ: number;
  white: number;
  flare: number;
}

export const restView = (): View => ({ x: 0, y: -1.1, z: 14, lookX: 0, lookY: 0.55, lookZ: 0, white: 0, flare: 0 });

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const inOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * The hero's camera at scroll progress `p`: in through the arch and into the light. Wide
 * screens open with the arch to the right of the words. `intro` (0 to 1) is the dolly on
 * arrival. The page and the frame renderer (scripts/render.ts) share it, so the pre-rendered
 * frames are exactly this shot.
 */
export function heroView(p: number, aspect: number, intro = 1): View {
  const v = restView();
  const approach = inOut(clamp(p / 0.86));
  const through = smooth(0.86, 1, p);
  const dolly = (1 - intro) ** 3 * 9;
  const side = aspect > 1.2 ? 1 - smooth(0.02, 0.3, p) : 0;
  v.x = -2.9 * side;
  v.lookX = -2.9 * side;
  v.z = lerp(lerp(15.5, 0.9, approach), -3.4, through) + dolly;
  v.y = lerp(-1.1, -0.72, approach) + (1 - intro) * 0.6;
  v.lookY = lerp(0.55, -0.72, approach);
  v.lookZ = lerp(0, -14, approach);
  v.flare = smooth(0.6, 1, p);
  v.white = smooth(0.8, 0.97, p);
  return v;
}
