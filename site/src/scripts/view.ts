// Where the arch scene's camera is and what it looks at. Kept apart from scene.ts so the page
// can plan camera moves before three.js has loaded.

import { clamp, inOut, lerp, smooth } from "../lib/math";

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

/** How far the hero has flooded to day at scroll progress `p`: the page lays its flood by it. */
export const heroWhite = (p: number) => smooth(0.8, 0.97, p);

/**
 * The hero's camera at scroll progress `p`: in through the arch and into the light. Wide
 * screens open with the arch to the right of the words. The frame renderer (dev/render.ts)
 * pre-renders the page's hero frames from it.
 */
export function heroView(p: number, aspect: number): View {
  const v = restView();
  const approach = inOut(clamp(p / 0.86));
  const through = smooth(0.86, 1, p);
  const side = aspect > 1.2 ? 1 - smooth(0.02, 0.3, p) : 0;
  v.x = -2.9 * side;
  v.lookX = -2.9 * side;
  v.z = lerp(lerp(15.5, 0.9, approach), -3.4, through);
  v.y = lerp(-1.1, -0.72, approach);
  v.lookY = lerp(0.55, -0.72, approach);
  v.lookZ = lerp(0, -14, approach);
  v.flare = smooth(0.6, 1, p);
  v.white = heroWhite(p);
  return v;
}
