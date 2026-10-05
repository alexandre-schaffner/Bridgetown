// Renders the hero offline, for scripts/render-hero.ts (window.__render, protocol.ts): the same
// camera path as the page (view.ts), the scene at ultra quality, drawn at twice the size and
// brought down to the viewport with a high-quality resample. The flood to day is left out; the
// page lays it over the frames, in its theme.

import * as THREE from "three";
import { createArchScene } from "../scripts/scene";
import { heroView } from "../scripts/view";

const canvas = document.querySelector<HTMLCanvasElement>("[data-scene]")!;
const scene = createArchScene(canvas, { day: new THREE.Color(1, 1, 1), reducedMotion: false, ultra: true });
const out = document.createElement("canvas");
out.width = innerWidth;
out.height = innerHeight;
const ctx = out.getContext("2d")!;
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = "high";

function hero(p: number, t: number): string {
  const view = heroView(p, innerWidth / innerHeight);
  view.white = 0;
  scene.still(view, t, "rest");
  // Same task as the render, so the drawing buffer is still there to read.
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

window.__render = { ready: false, hero };
// Two warm-up frames compile every shader before the first one that counts.
hero(0, 0);
hero(0.5, 0);
document.fonts.ready.then(() => (window.__render.ready = true));
