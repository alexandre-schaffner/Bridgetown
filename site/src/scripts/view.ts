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
