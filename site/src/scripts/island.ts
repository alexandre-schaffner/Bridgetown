// Drives the island in the notch chapter. The shape is NotchShape, sprung between layouts
// with IslandController's springs; each presentation's layer is revealed the way the app's
// `.reveal` transition does it (a blur-fade that trails the shape, out quickly before it
// closes). Scroll picks a step; each step plays in time, like the real thing would.

import {
  BOX_W,
  frameWidth,
  layoutFor,
  NOTCH,
  notchPath,
  SCREEN_W,
  WING,
  type IslandLayout,
  type Presentation,
} from "../lib/notch";

/** SwiftUI's spring(response:dampingFraction:) as stiffness and damping, mass 1. */
interface SpringSpec {
  response: number;
  damping: number;
}
const OPENING: SpringSpec = { response: 0.5, damping: 0.74 };
const CLOSING: SpringSpec = { response: 0.38, damping: 0.92 };
const SWELL: SpringSpec = { response: 0.32, damping: 0.62 };
// The launch film's: slower and barely bouncing, so a full-screen black panel opening over a
// white desktop reads as a move, not a flash.
const FILM_OPENING: SpringSpec = { response: 0.8, damping: 0.9 };
const FILM_CLOSING: SpringSpec = { response: 0.9, damping: 1 };

class Spring {
  v = 0;
  constructor(
    public x: number,
    public target = x,
  ) {}
  step(dt: number, spec: SpringSpec) {
    const k = (2 * Math.PI / spec.response) ** 2;
    const c = (4 * Math.PI * spec.damping) / spec.response;
    // Fixed substeps keep a stiff spring stable at any frame rate.
    const n = Math.ceil(dt / (1 / 240));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -k * (this.x - this.target) - c * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
  }
  get settled() {
    return Math.abs(this.x - this.target) < 0.01 && Math.abs(this.v) < 0.01;
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("aborted", "AbortError"))), {
      once: true,
    });
  });

export interface IslandStage {
  setStep(step: number): void;
  setVisible(visible: boolean): void;
}

export function createIsland(
  root: HTMLElement,
  { reducedMotion, cinematic = false }: { reducedMotion: boolean; cinematic?: boolean },
): IslandStage {
  const opening = cinematic ? FILM_OPENING : OPENING;
  const closing = cinematic ? FILM_CLOSING : CLOSING;
  const screen = root.querySelector<HTMLElement>("[data-screen]")!;
  const mac = root.querySelector<HTMLElement>("[data-mac]")!;
  const island = root.querySelector<HTMLElement>("[data-island]")!;
  const fill = island.querySelector<SVGPathElement>("[data-island-fill]")!;
  const edge = island.querySelector<SVGPathElement>("[data-island-edge]")!;
  const clip = island.querySelector<HTMLElement>("[data-island-clip]")!;
  const layers = Object.fromEntries(
    [...island.querySelectorAll<HTMLElement>(".layer")].map((el) => [el.dataset.layer!, el]),
  ) as Record<"wings" | "banner" | "open", HTMLElement>;
  const bandFoot = island.querySelector<HTMLElement>("[data-layer='band-foot']")!;
  const glyph = island.querySelector<HTMLElement>("[data-wing-glyph]")!;
  const wingDot = island.querySelector<HTMLElement>("[data-wing-dot]")!;
  const wingNumber = island.querySelector<HTMLElement>("[data-wing-number]")!;
  const needsCount = island.querySelector<HTMLElement>("[data-needs-count]")!;
  const needsBadge = island.querySelector<HTMLElement>("[data-needs-badge]")!;
  const mergeRow = island.querySelector<HTMLElement>("[data-action='merge']")!;
  const mergeBtn = island.querySelector<HTMLElement>("[data-btn='merge']")!;
  const cursor = root.querySelector<SVGElement>("[data-cursor]")!;
  const hit = island.querySelector<HTMLButtonElement>("[data-island-hit]")!;
  const steps = [...root.querySelectorAll<HTMLElement>("[data-step]")];

  // Fit the screen to the bezel (inside its 14px edges). Narrow screens zoom in on the notch
  // instead, keeping the open island and a little either side in view and letting the menu bar
  // run off the sides.
  const fit = () => {
    const inner = mac.clientWidth - 28;
    const k = inner < 900 ? inner / (BOX_W + 32) : inner / SCREEN_W;
    mac.style.setProperty("--k", String(k));
    mac.style.setProperty("--ox", `${(inner - SCREEN_W * k) / 2}px`);
  };
  fit();
  new ResizeObserver(fit).observe(mac);

  // MARK: Shape

  let presentation: Presentation = "hidden";
  let hovering = false;
  const start = layoutFor("hidden");
  const springs = {
    width: new Spring(start.width),
    height: new Spring(start.height),
    shoulder: new Spring(start.shoulder),
    corner: new Spring(start.corner),
    lift: new Spring(0),
  };
  let spec = opening;
  let visible = false;
  let raf = 0;
  let last = 0;

  const draw = () => {
    const layout: IslandLayout = {
      width: Math.max(0, springs.width.x),
      height: Math.max(0, springs.height.x),
      shoulder: Math.max(0, springs.shoulder.x),
      corner: Math.max(0, springs.corner.x),
    };
    const d = notchPath(layout, (BOX_W - frameWidth(layout)) / 2);
    fill.setAttribute("d", d);
    edge.setAttribute("d", d);
    clip.style.clipPath = `path("${d}")`;
    const lift = Math.min(1, Math.max(0, springs.lift.x));
    island.style.setProperty("--lift", (0.55 * lift).toFixed(3));
    island.style.setProperty("--lift-edge", lift.toFixed(3));
  };

  const tick = (now: number) => {
    raf = 0;
    const dt = Math.min(1 / 30, (now - last) / 1000 || 1 / 60);
    last = now;
    let moving = false;
    for (const s of Object.values(springs)) {
      if (reducedMotion) {
        s.x = s.target;
        s.v = 0;
      } else {
        s.step(dt, spec);
      }
      if (!s.settled) moving = true;
    }
    draw();
    if (moving && visible) raf = requestAnimationFrame(tick);
  };
  const kick = () => {
    if (!raf && visible) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }
  };

  const shape = (p: Presentation) => {
    const target = layoutFor(p, hovering);
    const now = layoutFor(presentation, false);
    spec = hovering && (p === "wings") ? SWELL : target.height * target.width >= now.height * now.width ? opening : closing;
    springs.width.target = target.width;
    springs.height.target = target.height;
    springs.shoulder.target = target.shoulder;
    springs.corner.target = target.corner;
    springs.lift.target = p === "open" || p === "banner" ? 1 : 0;
    kick();
  };

  // MARK: Layers

  const shown = new Set<string>();
  const reveal = (name: keyof typeof layers, on: boolean) => {
    if (shown.has(name) === on) return;
    on ? shown.add(name) : shown.delete(name);
    const el = layers[name];
    el.getAnimations().forEach((a) => a.cancel());
    const hidden = { opacity: 0, filter: "blur(10px)", transform: "scale(0.96)" };
    const rest = { opacity: 1, filter: "blur(0px)", transform: "scale(1)" };
    if (reducedMotion) {
      el.animate([on ? hidden : rest, on ? rest : hidden], { duration: 180, fill: "forwards" });
      return;
    }
    el.animate(on ? [hidden, rest] : [rest, hidden], {
      duration: on ? (cinematic ? 700 : 420) : cinematic ? 220 : 120,
      delay: on ? (cinematic ? 180 : 70) : 0,
      easing: on ? "cubic-bezier(0.22, 1, 0.36, 1)" : "cubic-bezier(0.4, 0, 1, 1)",
      fill: "both",
    });
  };

  const present = (p: Presentation) => {
    shape(p);
    presentation = p;
    island.classList.toggle("is-open", p === "open");
    reveal("wings", p === "wings" || p === "open");
    reveal("banner", p === "banner");
    reveal("open", p === "open");
    bandFoot.classList.toggle("on", p === "open");
  };

  // MARK: Glance

  const glance = (working: number, waiting: number) => {
    glyph.classList.toggle("working", working > 0);
    const amber = waiting > 0;
    wingDot.style.color = amber ? "var(--amber)" : "var(--blue)";
    wingNumber.style.color = amber ? "var(--amber)" : "";
    const value = String(amber ? waiting : working);
    if (wingNumber.textContent !== value) {
      wingNumber.textContent = value;
      if (!reducedMotion) {
        wingNumber.animate(
          [
            { transform: "translateY(60%)", filter: "blur(3px)", opacity: 0 },
            { transform: "none", filter: "blur(0)", opacity: 1 },
          ],
          { duration: 380, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
      }
    }
  };

  const setNeeds = (n: number) => {
    for (const el of [needsCount, needsBadge]) {
      if (el.textContent === String(n)) continue;
      el.textContent = String(n);
      if (!reducedMotion) {
        el.animate(
          [
            { transform: "translateY(-50%)", opacity: 0, filter: "blur(3px)" },
            { transform: "none", opacity: 1, filter: "blur(0)" },
          ],
          { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
      }
    }
  };

  // MARK: Cursor

  let cursorAt = { x: 1100, y: 420 };
  const showCursor = (on: boolean) => {
    cursor.animate([{ opacity: on ? 1 : 0 }], { duration: 250, fill: "forwards" });
  };
  const moveCursor = async (x: number, y: number, ms: number, signal: AbortSignal) => {
    const from = cursorAt;
    cursorAt = { x, y };
    const anim = cursor.animate(
      [{ transform: `translate(${from.x}px, ${from.y}px)` }, { transform: `translate(${x}px, ${y}px)` }],
      { duration: reducedMotion ? 1 : ms, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards" },
    );
    signal.addEventListener("abort", () => anim.finish(), { once: true });
    await anim.finished;
  };
  const click = async (signal: AbortSignal) => {
    cursor.animate([{ scale: 1 }, { scale: 0.82 }, { scale: 1 }], { duration: 220, easing: "ease-out" });
    await sleep(120, signal);
  };
  /** Where an element in the island sits, in the screen's unscaled coordinates. */
  const pointOf = (el: HTMLElement) => {
    const s = screen.getBoundingClientRect();
    const k = s.width / SCREEN_W;
    const r = el.getBoundingClientRect();
    return { x: (r.left - s.left + r.width * 0.55) / k, y: (r.top - s.top + r.height * 0.55) / k };
  };
  const rightWing = { x: SCREEN_W / 2 + NOTCH.width / 2 + WING / 2, y: NOTCH.height / 2 };

  // MARK: Steps

  let current = -1;
  let controller = new AbortController();

  const restoreMerge = () => {
    for (const row of island.querySelectorAll(".action")) row.classList.remove("settled");
    mergeBtn.classList.remove("hover", "press");
    setNeeds(3);
  };

  const scripts: ((signal: AbortSignal) => Promise<void>)[] = [
    // Wings: two agents at work, nothing waiting yet.
    async (signal) => {
      showCursor(false);
      restoreMerge();
      if (presentation === "hidden") await sleep(250, signal);
      glance(2, 0);
      present("wings");
    },
    // A banner drops for a merge that just became yours, then tucks back into an amber count.
    async (signal) => {
      showCursor(false);
      restoreMerge();
      glance(2, 0);
      present("wings");
      await sleep(350, signal);
      present("banner");
      await sleep(2600, signal);
      glance(2, 3);
      present("wings");
    },
    // The pointer comes up to the wing and clicks: the whole app unfolds.
    async (signal) => {
      restoreMerge();
      glance(2, 3);
      if (presentation === "open") {
        showCursor(false);
        return;
      }
      present("wings");
      cursorAt = { x: 1040, y: 380 };
      cursor.animate([{ transform: `translate(${cursorAt.x}px, ${cursorAt.y}px)` }], { duration: 0, fill: "forwards" });
      showCursor(true);
      await sleep(200, signal);
      await moveCursor(rightWing.x, rightWing.y + 2, 850, signal);
      await click(signal);
      present("open");
      await sleep(300, signal);
      await moveCursor(rightWing.x + 120, 300, 700, signal);
    },
    // Merge, from the island: the row settles, counts go down, the island folds away.
    async (signal) => {
      glance(2, 3);
      restoreMerge();
      if (presentation !== "open") {
        present("open");
        await sleep(450, signal);
      }
      showCursor(true);
      await sleep(150, signal);
      const target = pointOf(mergeBtn);
      await moveCursor(target.x, target.y, 900, signal);
      mergeBtn.classList.add("hover");
      await sleep(260, signal);
      mergeBtn.classList.add("press");
      await click(signal);
      await sleep(120, signal);
      mergeBtn.classList.remove("press");
      mergeRow.classList.add("settled");
      setNeeds(2);
      await sleep(1300, signal);
      await moveCursor(target.x + 160, target.y + 220, 600, signal);
      showCursor(false);
      glance(2, 2);
      present("wings");
    },
  ];

  const run = (step: number) => {
    controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    scripts[step]?.(signal).catch((e) => {
      if (e?.name !== "AbortError") throw e;
    });
  };

  // MARK: Pointer

  // After the tour, the island answers the pointer: it swells under it and opens on a click.
  hit.addEventListener("pointerenter", () => {
    if (presentation !== "wings") return;
    hovering = true;
    shape("wings");
  });
  hit.addEventListener("pointerleave", () => {
    if (!hovering) return;
    hovering = false;
    if (presentation === "wings") shape("wings");
  });
  hit.addEventListener("click", () => {
    controller.abort();
    showCursor(false);
    hovering = false;
    present(presentation === "open" ? "wings" : "open");
  });

  // Its buttons work too: each settles its row, and the island folds once nothing is left.
  for (const btn of island.querySelectorAll<HTMLElement>("[data-btn]")) {
    btn.addEventListener("click", async () => {
      if (presentation !== "open") return;
      controller.abort();
      controller = new AbortController();
      const signal = controller.signal;
      showCursor(false);
      const row = btn.closest(".action")!;
      btn.classList.add("press");
      try {
        await sleep(140, signal);
        btn.classList.remove("press");
        row.classList.add("settled");
        const left = island.querySelectorAll(".action:not(.settled)").length;
        setNeeds(left);
        glance(2, left);
        if (left === 0) {
          await sleep(900, signal);
          present("wings");
          await sleep(1800, signal);
          restoreMerge();
          glance(2, 3);
        }
      } catch {
        // Interrupted by the next step.
      }
    });
  }

  draw();

  return {
    setStep(step) {
      step = Math.max(0, Math.min(scripts.length - 1, step));
      steps.forEach((el, i) => el.classList.toggle("on", i === step));
      if (step === current) return;
      current = step;
      run(step);
    },
    setVisible(next) {
      visible = next;
      if (next) kick();
    },
  };
}
