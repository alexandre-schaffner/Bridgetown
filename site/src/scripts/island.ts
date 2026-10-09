// Drives the island in the notch chapter. The shape is NotchShape, sprung between layouts
// with IslandController's springs; each presentation's layer is revealed the way the app's
// `.reveal` transition does it (a blur-fade that trails the shape, out quickly before it
// closes). Open, it shows the app's real screens, and the pointer works them where their
// buttons really are. Scroll picks a step; each step plays in time, like the real thing would.

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
const SWELL: SpringSpec = { response: 0.32, damping: 0.62 };

/** How the island moves: the springs it grows and shrinks on, and its layers' fades, in ms. */
interface Pace {
  opening: SpringSpec;
  closing: SpringSpec;
  fade: { in: number; delay: number; out: number };
}
/** The app's (IslandController), which the page plays at. */
const APP: Pace = {
  opening: { response: 0.5, damping: 0.74 },
  closing: { response: 0.38, damping: 0.92 },
  fade: { in: 420, delay: 70, out: 120 },
};
/**
 * The launch film's: slower and barely bouncing, so a full-screen black panel opening over a
 * white desktop reads as a move, not a flash.
 */
const FILM: Pace = {
  opening: { response: 0.8, damping: 0.9 },
  closing: { response: 0.9, damping: 1 },
  fade: { in: 700, delay: 180, out: 220 },
};

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
  const pace = cinematic ? FILM : APP;
  const screen = root.querySelector<HTMLElement>("[data-screen]")!;
  const mac = root.querySelector<HTMLElement>("[data-mac]")!;
  const island = root.querySelector<HTMLElement>("[data-island]")!;
  const fill = island.querySelector<SVGPathElement>("[data-island-fill]")!;
  const edge = island.querySelector<SVGPathElement>("[data-island-edge]")!;
  const clip = island.querySelector<HTMLElement>("[data-island-clip]")!;
  const layers = Object.fromEntries(
    [...island.querySelectorAll<HTMLElement>(".layer")].map((el) => [el.dataset.layer!, el]),
  ) as Record<"wings" | "banner" | "open", HTMLElement>;
  const glyph = island.querySelector<HTMLElement>("[data-wing-glyph]")!;
  const wingDot = island.querySelector<HTMLElement>("[data-wing-dot]")!;
  const wingNumber = island.querySelector<HTMLElement>("[data-wing-number]")!;
  const press = island.querySelector<HTMLElement>("[data-press]")!;
  const mergeTarget = island.querySelector<HTMLButtonElement>("[data-target='merge']")!;
  const cursor = root.querySelector<SVGElement>("[data-cursor]")!;
  const hit = island.querySelector<HTMLButtonElement>("[data-island-hit]")!;
  const steps = [...root.querySelectorAll<HTMLElement>("[data-step]")];

  // Fit the screen to the bezel (inside its 14px edges). Narrow screens zoom in on the notch
  // instead, letting the menu bar run off the sides: at 900px the open island and a little either
  // side stay in view; on a phone, as far as the open island's middle column, so what needs you
  // can be read.
  const fit = () => {
    const inner = mac.clientWidth - 28;
    const span = 440 + (BOX_W + 32 - 440) * Math.min(1, Math.max(0, (inner - 320) / (900 - 320)));
    const k = inner < 900 ? inner / span : inner / SCREEN_W;
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
  let spec = pace.opening;
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
    // A move under way finishes even if the chapter has just gone, so the shape never
    // stops halfway with its layers already gone.
    if (moving) raf = requestAnimationFrame(tick);
  };
  const kick = () => {
    if (raf) return;
    if (!visible) {
      // Off screen: take the new shape at once.
      for (const s of Object.values(springs)) {
        s.x = s.target;
        s.v = 0;
      }
      draw();
      return;
    }
    last = performance.now();
    raf = requestAnimationFrame(tick);
  };

  const shape = (p: Presentation) => {
    const target = layoutFor(p, hovering);
    const now = layoutFor(presentation, false);
    spec = hovering && p === "wings" ? SWELL : target.height * target.width >= now.height * now.width ? pace.opening : pace.closing;
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
      duration: on ? pace.fade.in : pace.fade.out,
      delay: on ? pace.fade.delay : 0,
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
  };

  /**
   * Which real screen the open island shows: the overview, or the session the tour opens,
   * before and after its merge. They cross-fade, as a detail replaces the last two columns.
   */
  type View = "overview" | "merge" | "merged";
  const show = (view: View) => {
    island.dataset.view = view;
    if (view !== "merge") press.classList.remove("hover", "press");
  };
  show("overview");

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
    if (!reducedMotion) cursor.animate([{ scale: 1 }, { scale: 0.82 }, { scale: 1 }], { duration: 220, easing: "ease-out" });
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

  // Six agents at work and, once the merge below is yours, twelve things waiting: what the
  // open screens say. Merging leaves twelve, since cutting the release takes its place.
  const WORKING = 6;
  const WAITING = 12;

  /** Merge, pressed: the button gives, and the session says it merged. */
  const merge = async (signal: AbortSignal) => {
    press.classList.add("press");
    await sleep(140, signal);
    show("merged");
  };

  const scripts: ((signal: AbortSignal) => Promise<void>)[] = [
    // Wings: the agents at work, and what already waits on you.
    async (signal) => {
      showCursor(false);
      show("overview");
      if (presentation === "hidden") await sleep(250, signal);
      glance(WORKING, WAITING - 1);
      present("wings");
    },
    // A banner drops for a merge that just became yours, then tucks back into the count.
    async (signal) => {
      showCursor(false);
      show("overview");
      glance(WORKING, WAITING - 1);
      present("wings");
      await sleep(350, signal);
      present("banner");
      await sleep(2600, signal);
      glance(WORKING, WAITING);
      present("wings");
    },
    // The pointer comes up to the wing and clicks: the whole app unfolds.
    async (signal) => {
      glance(WORKING, WAITING);
      if (presentation === "open" && island.dataset.view === "overview") {
        showCursor(false);
        return;
      }
      show("overview");
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
    // Merge, from the island: the session with the merge opens in place of the overview's
    // last two columns (in the app, from its row under Ship, below what the screen shows), the
    // pointer presses Merge, the session says merged, and the island folds away.
    async (signal) => {
      glance(WORKING, WAITING);
      show("overview");
      if (presentation !== "open") {
        present("open");
        await sleep(450, signal);
      }
      await sleep(250, signal);
      show("merge");
      showCursor(true);
      await sleep(400, signal);
      const target = pointOf(mergeTarget);
      await moveCursor(target.x, target.y, 800, signal);
      press.classList.add("hover");
      await sleep(260, signal);
      await click(signal);
      await merge(signal);
      // Off the release button that takes Merge's place, which is the next decision, not this one.
      await moveCursor(target.x + 160, target.y + 220, 600, signal);
      await sleep(900, signal);
      showCursor(false);
      present("wings");
      await sleep(400, signal);
      show("overview");
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
  // It opens on the session the tour opened, its merge waiting again for you to press.
  hit.addEventListener("click", () => {
    controller.abort();
    showCursor(false);
    hovering = false;
    if (presentation !== "open") show("merge");
    present(presentation === "open" ? "wings" : "open");
  });

  // Its Merge works too: the session says merged, and the island folds back to work.
  mergeTarget.addEventListener("pointerenter", () => press.classList.add("hover"));
  mergeTarget.addEventListener("pointerleave", () => press.classList.remove("hover"));
  mergeTarget.addEventListener("click", async () => {
    if (presentation !== "open") return;
    controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    showCursor(false);
    try {
      await merge(signal);
      await sleep(1300, signal);
      present("wings");
    } catch {
      // Interrupted by the next step.
    }
  });

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
