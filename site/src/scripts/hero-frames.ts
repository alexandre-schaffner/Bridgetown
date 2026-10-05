// The hero, pre-rendered (dev/render.ts): frames of the walk through the arch, scrubbed by
// scroll with a crossfade between neighbours so any scroll position lands between two frames,
// and a loop of the opening shot for when nobody is scrolling. Frames load coarse to fine,
// so the scrub works early and sharpens as the rest arrive.
//
// The crossfade is two canvases, one over the other, each holding a whole frame; scrolling
// only changes the top one's opacity, which the compositor does for free. A frame is painted
// only when the scrub crosses into a new one, and then into one canvas, never both.

interface FrameSet {
  dir: string;
  count: number;
  width: number;
  height: number;
  /** The opening loop. */
  loop: string;
}

/**
 * Keyed by directory: the hero's <picture> (pages/index.astro) picks one by its first frame.
 * scripts/render-hero.ts renders them.
 */
export const SETS: Record<string, FrameSet> = {
  l: { dir: "/hero/l", count: 240, width: 2560, height: 1440, loop: "/hero/l/loop.mp4" },
  m: { dir: "/hero/m", count: 240, width: 1920, height: 1080, loop: "/hero/l/loop.mp4" },
  p: { dir: "/hero/p", count: 200, width: 1080, height: 1920, loop: "/hero/p/loop.mp4" },
};

/** Every index once, coarse to fine: 0, the last, then every 32nd, 16th, … 1st. */
function order(count: number): number[] {
  const seen = new Set<number>([0, count - 1]);
  const out = [0, count - 1];
  for (let step = 32; step >= 1; step >>= 1) {
    for (let i = 0; i < count; i += step) {
      if (!seen.has(i)) {
        seen.add(i);
        out.push(i);
      }
    }
  }
  return out;
}

export interface HeroFrames {
  /** Draw scroll progress `p` (0 to 1). Cheap when nothing changed. */
  render(p: number): void;
  /** The loop plays only at the very top, and only while the hero is on screen. */
  setResting(resting: boolean): void;
}

export function createHeroFrames(root: HTMLElement, { reducedMotion }: { reducedMotion: boolean }): HeroFrames {
  const first = root.querySelector<HTMLImageElement>("picture img")!;
  const canvas = root.querySelector<HTMLCanvasElement>("[data-hero-frames]")!;
  const video = root.querySelector<HTMLVideoElement>("[data-hero-loop]")!;
  /** The set the <picture> chose for this screen, so the first frame and the rest agree. */
  const chosen = () => SETS[(first.currentSrc || first.src).split("/").at(-2)!] ?? SETS.m!;
  let set = chosen();
  let images: (HTMLImageElement | null)[] = [];

  // Two layers: the page's canvas below, a twin of it above.
  const twin = canvas.cloneNode() as HTMLCanvasElement;
  canvas.after(twin);
  const layers = [canvas, twin].map((el) => ({ el, ctx: el.getContext("2d", { alpha: false })!, index: -1 }));
  const [below, above] = layers as [(typeof layers)[0], (typeof layers)[0]];
  let aboveOpacity = "";
  // An opaque canvas is black until something is drawn in it; the first frame's image shows till then.
  for (const l of layers) l.el.style.visibility = "hidden";

  const size = () => {
    const ratio = Math.min(devicePixelRatio, 2);
    // No more pixels than the frames have: drawing them bigger only costs.
    const w = Math.min(Math.round(innerWidth * ratio), set.width);
    const h = Math.round((w * innerHeight) / innerWidth);
    for (const l of layers) {
      if (l.el.width === w && l.el.height === h) continue;
      l.el.width = w;
      l.el.height = h;
      l.ctx.imageSmoothingEnabled = true;
      l.ctx.imageSmoothingQuality = "high";
      l.index = -1;
      l.el.style.visibility = "hidden";
    }
  };

  // Each load is a generation: a superseded one (the screen turned, and the set with it) stops
  // asking for frames and drops the ones on their way, so two sets never download at once and
  // no frame lands in the other set's slots.
  let generation = 0;
  let pending = new Set<HTMLImageElement>();
  const load = () => {
    const gen = ++generation;
    for (const img of pending) img.src = "";
    pending = new Set();
    const loading = pending;
    const { dir, count } = set;
    const frames: (HTMLImageElement | null)[] = (images = new Array(count).fill(null));
    for (const l of layers) l.index = -1;
    const queue = order(count);
    let next = 0;
    // A few at a time, so the first coarse pass lands quickly.
    const pump = () => {
      const i = queue[next++];
      if (gen !== generation || i === undefined) return;
      const img = new Image();
      img.decoding = "async";
      img.src = `${dir}/${String(i).padStart(3, "0")}.webp`;
      loading.add(img);
      img
        .decode()
        .then(() => {
          frames[i] = img;
        })
        .catch(() => {})
        .finally(() => {
          loading.delete(img);
          pump();
        });
    };
    for (let k = 0; k < 6; k++) pump();
    // Reduce Motion never plays the loop, so it isn't fetched.
    if (!reducedMotion && video.getAttribute("src") !== set.loop) {
      video.src = set.loop;
      video.load();
    }
  };

  /** The nearest loaded frame at or below `i`, and at or above it. */
  const around = (i: number): [number, number] => {
    let lo = Math.floor(i);
    let hi = Math.ceil(i);
    while (lo > 0 && !images[lo]) lo--;
    while (hi < set.count - 1 && !images[hi]) hi++;
    if (!images[hi]) hi = lo;
    if (!images[lo]) lo = hi;
    return [lo, hi];
  };

  /** Frame `i` into a layer, like `object-fit: cover`. */
  const paint = (layer: (typeof layers)[0], i: number) => {
    const img = images[i]!;
    const { el, ctx } = layer;
    const s = Math.max(el.width / img.naturalWidth, el.height / img.naturalHeight);
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    ctx.drawImage(img, (el.width - w) / 2, (el.height - h) / 2, w, h);
    layer.index = i;
    el.style.visibility = "";
  };

  const showAbove = (opacity: number) => {
    const v = opacity.toFixed(3);
    if (v === aboveOpacity) return;
    aboveOpacity = v;
    above.el.style.opacity = v;
  };

  size();
  load();
  addEventListener("resize", size);
  // The <picture> picks again when the screen changes shape, and loads its new first frame.
  first.addEventListener("load", () => {
    const next = chosen();
    if (next === set) return;
    set = next;
    size();
    load();
  });

  let stopping = 0;

  return {
    render(p) {
      const i = Math.min(1, Math.max(0, p)) * (set.count - 1);
      const [lo, hi] = around(i);
      if (!images[lo]) return;
      const a = hi === lo ? 0 : (i - lo) / (hi - lo);

      if (a < 0.002 || !images[hi]) {
        // One frame: whichever layer already has it, else the one below.
        if (above.index === lo) return showAbove(1);
        if (below.index !== lo) paint(below, lo);
        return showAbove(0);
      }
      // Two frames: keep each where it already is if it is anywhere, so at most one paints.
      const flipped = below.index === hi || above.index === lo;
      const [forLo, forHi] = flipped ? [above, below] : [below, above];
      if (forLo.index !== lo) paint(forLo, lo);
      if (forHi.index !== hi) paint(forHi, hi);
      showAbove(flipped ? 1 - a : a);
    },
    setResting(resting) {
      const play = resting && !reducedMotion && video.readyState >= 2;
      video.classList.toggle("on", play);
      if (play) {
        clearTimeout(stopping);
        stopping = 0;
        if (video.paused) void video.play().catch(() => {});
      } else if (!video.paused && !stopping) {
        // Let the dissolve finish before stopping it: one timer, however many frames ask.
        stopping = window.setTimeout(() => {
          stopping = 0;
          if (!video.classList.contains("on")) video.pause();
        }, 500);
      }
    },
  };
}
