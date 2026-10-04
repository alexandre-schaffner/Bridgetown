// The launch film's director. Every feature gets a shot, cut to a 120 BPM grid (a beat is half a
// second, a bar two). Plays once in real time and reports when it is done, plus the cues the
// score is built from (.context tooling). Nothing here ships: pages/launch.astro redirects in
// production.

import { gsap } from "gsap";
import * as THREE from "three";
import { createArchScene, restView, type LightName, type View } from "./scene";
import { createIsland } from "./island";

type CueKind =
  | "tick" // a notification lands
  | "drop" // the noise cuts out
  | "hit" // a line of type lands
  | "impact" // the name
  | "riser" // building into the next cut (v = length)
  | "whoosh" // a camera move or a push between shots
  | "click" // a button, pressed
  | "chime" // a verified outcome
  | "amber" // something is yours
  | "deny" // a command refused
  | "type" // keys (v = length)
  | "count"; // bars filling, numbers counting

interface Cue {
  t: number;
  kind: CueKind;
  v?: number;
}

const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector<T>(s)!;
const $$ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => [...root.querySelectorAll<T>(s)];

// The film keeps to the clock even when a frame runs long, so the score stays in sync.
gsap.ticker.lagSmoothing(0);
const tl = gsap.timeline({ paused: true });
const cues: Cue[] = [];
const cue = (t: number, kind: CueKind, v?: number) => cues.push({ t: +t.toFixed(3), kind, ...(v === undefined ? {} : { v }) });
const shots = Object.fromEntries($$("[data-shot]").map((el) => [el.dataset.shot!, el]));
const shot = (name: string) => shots[name]!;

// MARK: The arch

const day = (() => {
  const c = document.createElement("canvas").getContext("2d")!;
  c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--day");
  c.fillRect(0, 0, 1, 1);
  const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
  return new THREE.Color().setRGB(r! / 255, g! / 255, b! / 255, THREE.SRGBColorSpace);
})();
let sceneReady = false;
const scene = createArchScene($<HTMLCanvasElement>("[data-scene]"), {
  day,
  reducedMotion: false,
  onFirstFrame: () => (sceneReady = true),
});
scene.setLight("out", 0.01);
const cam: View = restView();
gsap.ticker.add(() => {
  Object.assign(scene.view, cam);
});
const light = (at: number, name: LightName, seconds = 1.1) => tl.call(() => scene.setLight(name, seconds), [], at);
const placeCamera = (at: number, view: Partial<View>, lamp?: LightName) =>
  tl.call(
    () => {
      Object.assign(cam, { x: 0, y: 0, z: 30, lookX: 0, lookY: 0, lookZ: 0, white: 0, flare: 0 }, view);
      // The ticker hands the camera over once a frame; a cut can't wait for it.
      Object.assign(scene.view, cam);
      scene.snap();
      if (lamp) scene.setLight(lamp, 0.01);
    },
    [],
    at,
  );

const island = createIsland($("[data-island-root]"), { reducedMotion: false });
island.setVisible(true);
const flood = $("[data-flood]");

// MARK: Grammar

/** Wraps each word in a mask so it can rise out of its own line. Keeps <br> and inline spans. */
function split(el: HTMLElement) {
  if (el.dataset.splitDone) return;
  el.dataset.splitDone = "1";
  const walk = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const parts = child.textContent!.split(/(\s+)/);
        const frag = document.createDocumentFragment();
        for (const p of parts) {
          if (!p) continue;
          if (/^\s+$/.test(p)) frag.append(" ");
          else {
            const w = document.createElement("span");
            w.className = "w";
            const wi = document.createElement("span");
            wi.className = "wi";
            wi.textContent = p;
            w.append(wi);
            frag.append(w);
          }
        }
        child.replaceWith(frag);
      } else if (child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName !== "BR") walk(child);
    }
  };
  walk(el);
}

/** Words rise into place, one after another. */
function reveal(el: HTMLElement, at: number, { stagger = 0.06, dur = 1.0, hit = true } = {}) {
  split(el);
  const words = $$(".wi", el);
  tl.fromTo(
    words,
    { yPercent: 110, opacity: 0, filter: "blur(10px)" },
    { yPercent: 0, opacity: 1, filter: "blur(0px)", duration: dur, ease: "expo.out", stagger },
    at,
  );
  if (hit) cue(at, "hit");
}

/** A shot arrives. `cut` is instant; `rise` comes up out of a blur. */
function enter(name: string, at: number, how: "cut" | "rise" = "rise") {
  const el = shot(name);
  if (how === "cut") {
    tl.set(el, { autoAlpha: 1, scale: 1, filter: "blur(0px)" }, at);
    return;
  }
  tl.fromTo(
    el,
    { autoAlpha: 0, scale: 0.955, filter: "blur(16px)" },
    { autoAlpha: 1, scale: 1, filter: "blur(0px)", duration: 0.9, ease: "expo.out" },
    at,
  );
}

/** A shot goes: pushed past the camera, or cut. */
function leave(name: string, at: number, how: "cut" | "push" = "push") {
  const el = shot(name);
  if (how === "cut") {
    tl.set(el, { autoAlpha: 0 }, at);
    return;
  }
  tl.to(el, { autoAlpha: 0, scale: 1.07, filter: "blur(18px)", duration: 0.42, ease: "power2.in" }, at);
  cue(at + 0.05, "whoosh");
}

/** A slow camera move across a shot's whole life. */
function drift(name: string, at: number, dur: number, from: gsap.TweenVars, to: gsap.TweenVars) {
  const c = $(".cam", shot(name));
  tl.fromTo(c, { transformPerspective: 2400, ...from }, { ...to, duration: dur, ease: "sine.inOut" }, at);
}

/** Counts `el`'s number up to its target. */
function countUp(el: HTMLElement, to: number, at: number, dur: number, fmt = (n: number) => `${Math.round(n)}%`, ease = "power3.out") {
  const o = { n: 0 };
  tl.to(o, { n: to, duration: dur, ease, onUpdate: () => (el.textContent = fmt(o.n)) }, at);
}

/** Types `text` into `el` at `cps` characters a second. */
function typeInto(el: HTMLElement, text: string, at: number, cps = 38) {
  const dur = text.length / cps;
  const o = { n: 0 };
  tl.to(
    o,
    {
      n: text.length,
      duration: dur,
      ease: "none",
      onUpdate: () => (el.textContent = text.slice(0, Math.round(o.n))),
    },
    at,
  );
  cue(at, "type", +dur.toFixed(2));
  return dur;
}

/** Where `el` sits inside `anc`, in layout pixels (transforms ignored). */
function offsetWithin(el: HTMLElement, anc: HTMLElement) {
  let x = 0;
  let y = 0;
  let n: HTMLElement | null = el;
  while (n && n !== anc) {
    x += n.offsetLeft;
    y += n.offsetTop;
    n = n.offsetParent as HTMLElement | null;
  }
  return { x: x + el.offsetWidth * 0.55, y: y + el.offsetHeight * 0.6 };
}

/** The pointer glides to `target` and presses it at `at`. */
function press(pointer: SVGElement, target: HTMLElement, at: number, from = { dx: 160, dy: 200 }, travel = 0.75) {
  const anc = (pointer.parentElement as HTMLElement)!;
  const p = offsetWithin(target, anc);
  tl.fromTo(
    pointer,
    { x: p.x + from.dx, y: p.y + from.dy, opacity: 0 },
    { x: p.x, y: p.y, opacity: 1, duration: travel, ease: "power3.inOut" },
    at - travel - 0.12,
  );
  tl.to(pointer, { scale: 0.82, duration: 0.08, transformOrigin: "4px 3px" }, at);
  tl.to(pointer, { scale: 1, duration: 0.25, ease: "back.out(3)" }, at + 0.08);
  tl.to(target, { scale: 0.93, duration: 0.08 }, at);
  tl.to(target, { scale: 1, duration: 0.4, ease: "back.out(3)" }, at + 0.08);
  cue(at, "click");
}

// MARK: 1 · The noise (0–8)

const NOTES: [string, string, string, boolean][] = [
  ["#alert-api", "M", "5xx rate 3.1% on /v4/orders over 5 minutes", true],
  ["#eng-infra", "J", "@alex the orders page 500s when region is empty", false],
  ["#alert-engine", "M", "Merkle root update late on Arbitrum · 14 min", true],
  ["Priya", "P", "Should we ship the pricing change today?", false],
  ["#alert-erpc", "M", "eRPC errors 4.2% on Base", true],
  ["#alert-jobs", "M", "pod opportunities-sync OOMKilled", true],
  ["#alert-releases", "D", "web v2.15.0 deployed to production", true],
  ["@infra", "S", "anyone looking at the dispute bot retries?", false],
  ["#alert-db", "M", "Lock waits above 2s on rewards", true],
  ["#alert-billing", "M", "Invoice job failed 3 times in a row", true],
  ["Baptiste", "B", "can you review #3349 before standup?", false],
  ["#alert-api", "M", "p99 latency 1.8s on /v4/opportunities", true],
  ["#alert-rewards", "M", "Campaign 0x8f3c…2a1b distributed 0 rewards", true],
  ["#alert-releases", "D", "api v1.35.11 waiting for approval", true],
  ["Julien", "J", "is the Base indexer behind again?", false],
  ["#alert-engine", "M", "[RESOLVED] Merkle root update late on Arbitrum", true],
  ["#alert-jobs", "M", "cron rewards-sync exceeded 15 min", true],
  ["#eng-api", "M", "@alex quick one on the v4 pagination", false],
];
const wall = $("[data-wall]");
const N = 78;
for (let i = 0; i < N; i++) {
  const [ch, who, tx, alert] = NOTES[(i * 7) % NOTES.length]!;
  const el = document.createElement("div");
  el.className = "note";
  const mm = String((12 + Math.floor(i * 1.2)) % 60).padStart(2, "0");
  el.innerHTML = `<span class="av${alert ? " alert" : ""}">${who}</span><div><p class="ch"><span>${ch}</span><span>${alert ? "" : "now · "}09:${mm}</span></p><p class="tx">${tx}</p></div>`;
  wall.append(el);
}
{
  const notes = $$(".note", wall);
  // Nearest the middle first, with a little disorder, so the first ones are read and the rest pile up.
  const cols = 6;
  const rows = Math.ceil(N / cols);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const order = notes
    .map((el, i) => {
      const cx = (i % cols) - (cols - 1) / 2;
      const cy = Math.floor(i / cols) - (rows - 1) / 2;
      return { el, d: Math.hypot(cx * 0.8, cy * 1.6) + rand() * 1.6 };
    })
    .sort((a, b) => a.d - b.d);
  order.forEach(({ el }, k) => {
    const t = 0.35 + 6.9 * Math.pow(k / (N - 1), 0.52);
    tl.fromTo(
      el,
      { opacity: 0, scale: 0.86, y: 30, z: -120 },
      { opacity: 1, scale: 1, y: 0, z: 0, duration: 0.55, ease: "expo.out" },
      t,
    );
    cue(t, "tick");
  });
  enter("noise", 0, "cut");
  tl.call(() => scene.setActive(false), [], 0.1);
  drift("noise", 0, 8, { scale: 2.1, rotateX: 22, rotateZ: -5, y: 40 }, { scale: 0.92, rotateX: 30, rotateZ: -9, y: -20 });
  countUp($('[data-count="alerts"]'), 147, 0.4, 7.2, (n) => String(Math.round(n)), "power2.in");
  countUp($('[data-count="mentions"]'), 23, 0.9, 6.7, (n) => String(Math.round(n)), "power2.in");
  countUp($('[data-count="dms"]'), 9, 1.4, 6.2, (n) => String(Math.round(n)), "power2.in");
  countUp($("[data-clock]"), 95, 0.4, 7.4, (n) => `${String(9 + Math.floor((12 + n) / 60)).padStart(2, "0")}:${String(Math.floor(12 + n) % 60).padStart(2, "0")}`, "power2.in");
  cue(4.0, "riser", 3.95);
  // The pile rushes the lens, then nothing.
  tl.to($(".cam", shot("noise")), { scale: 1.6, filter: "blur(24px)", duration: 0.32, ease: "power3.in" }, 7.66);
  leave("noise", 7.99, "cut");
  cue(8, "drop");
}

// MARK: 2 · The turn (8–12)

enter("turn-a", 8, "cut");
reveal($(".hl", shot("turn-a")), 8.04, { stagger: 0.07 });
leave("turn-a", 9.6);
enter("turn-b", 10, "cut");
reveal($(".hl", shot("turn-b")), 10.04, { stagger: 0.09 });
leave("turn-b", 11.6);

// MARK: 3 · The name (12–20)

tl.call(() => scene.setActive(true), [], 11.5);
placeCamera(11.9, { x: 0, y: 0.6, z: 31, lookY: 2.6 });
light(12.1, "rest", 2.6);
tl.to(cam, { z: 19, y: -0.5, lookY: 1.9, duration: 6.4, ease: "power2.out" }, 12);
{
  const t = shot("title");
  enter("title", 13.4, "cut");
  tl.fromTo($(".mark", t), { opacity: 0, y: 18, filter: "blur(10px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 1.6, ease: "expo.out" }, 13.4);
  tl.fromTo(
    $(".name", t),
    { opacity: 0, letterSpacing: "0.06em", filter: "blur(22px)", scale: 1.06 },
    { opacity: 1, letterSpacing: "-0.05em", filter: "blur(0px)", scale: 1, duration: 2.6, ease: "expo.out" },
    13.5,
  );
  cue(13.5, "impact");
  leave("title", 16.4);
  enter("tagline", 16.6, "cut");
  reveal($(".tag-line", shot("tagline")), 16.62, { stagger: 0.08, hit: false });
  leave("tagline", 18.7);
}
// Into the arch and its light, and out the other side into the first chapter.
tl.to(cam, { z: 0.9, y: -0.72, lookY: -0.72, lookZ: -14, duration: 1.9, ease: "power2.in" }, 18.1);
tl.to(cam, { flare: 1, duration: 1.7, ease: "power1.in" }, 18.3);
cue(17.9, "riser", 2.1);
tl.call(() => scene.setActive(false), [], 20.2);

// MARK: 4 · Triage (20–32)

function chapter(name: string, at: number, out: number) {
  const s = shot(name);
  enter(name, at, "cut");
  tl.fromTo($(".kick", s), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.8, ease: "expo.out" }, at + 0.05);
  reveal($(".hl", s), at + 0.1, { stagger: 0.07 });
  tl.fromTo(s, { scale: 1 }, { scale: 1.045, duration: out - at, ease: "none" }, at);
  leave(name, out);
}
chapter("ch-triage", 20, 22.6);
cue(20, "impact");

{
  const t0 = 23;
  enter("triage", t0);
  drift("triage", t0, 9, { rotateX: 7, rotateY: -5, z: 0 }, { rotateX: 2, rotateY: 3, z: 70 });
  const rows = $$("[data-trow]", shot("triage"));
  const at = [23.6, 25.2, 26.4, 27.5, 28.6];
  rows.forEach((row, i) => {
    const s = at[i]!;
    tl.to(row, { opacity: 1, duration: 0.35, ease: "power2.out" }, s);
    if (i > 0) tl.to(rows[i - 1]!, { opacity: 0.55, duration: 0.4 }, s);
    const bars = $$(".bar i", row);
    bars.forEach((b, j) => {
      const p = Number(getComputedStyle(b.closest(".t-a")!).getPropertyValue("--p"));
      tl.to(b, { scaleX: p, duration: 0.8, ease: "expo.out" }, s + 0.1 + j * 0.1);
    });
    $$("[data-pct]", row).forEach((el, j) => countUp(el, Number(el.dataset.pct), s + 0.1 + j * 0.1, 0.8));
    if (bars.length) cue(s + 0.1, "count");
    const route = $("[data-troute]", row);
    tl.fromTo(route, { opacity: 0, x: -14 }, { opacity: 1, x: 0, duration: 0.6, ease: "expo.out" }, s + 0.55);
    cue(s + 0.55, row.querySelector(".dot-amber") ? "amber" : "tick");
  });
  tl.to(rows[4]!, { opacity: 0.55, duration: 0.4 }, 29.6);
  // Your threshold, raised: two routes become suggestions.
  const fill = $("[data-pfill]");
  const thumb = $("[data-pthumb]");
  const val = $("[data-pval]");
  const pct = (v: number) => `${((v - 50) / 45) * 100}%`;
  const knob = { v: 75 };
  tl.to(
    knob,
    {
      v: 90,
      duration: 0.9,
      ease: "power3.inOut",
      onUpdate: () => {
        fill.style.width = pct(knob.v);
        thumb.style.left = pct(knob.v);
        val.textContent = `${Math.round(knob.v)}%`;
      },
    },
    29.8,
  );
  cue(29.8, "whoosh");
  const flip = (row: HTMLElement, at: number, label: string) => {
    const route = $("[data-troute]", row);
    tl.to(route, { opacity: 0, x: 10, duration: 0.15 }, at);
    tl.call(
      () => {
        route.querySelector(".dot")!.className = "dot dot-amber";
        route.querySelector("span")!.textContent = label;
      },
      [],
      at + 0.16,
    );
    tl.to(route, { opacity: 1, x: 0, duration: 0.45, ease: "expo.out" }, at + 0.17);
    tl.to(row, { opacity: 1, duration: 0.3 }, at);
    cue(at + 0.17, "amber");
  };
  flip(rows[0]!, 30.2, "Suggested to you");
  flip(rows[2]!, 30.5, "Needs you");
  leave("triage", 31.6);
}

{
  enter("depth", 32, "cut");
  reveal($(".hl-m", shot("depth")), 32.05);
  drift("depth", 32, 4, { z: -60, rotateX: 6 }, { z: 30, rotateX: 0 });
  $$("[data-dcard]", shot("depth")).forEach((c, i) => {
    const at = 32.5 + i * 0.5;
    tl.fromTo(c, { opacity: 0, y: 60, rotateX: -24, filter: "blur(8px)" }, { opacity: 1, y: 0, rotateX: 0, filter: "blur(0px)", duration: 0.9, ease: "expo.out" }, at);
    tl.fromTo($(".d-meter i", c), { scaleX: 0 }, { scaleX: 1, duration: 1, ease: "expo.out" }, at + 0.2);
    cue(at, "hit");
  });
  leave("depth", 35.6);
}

// MARK: 5 · The agents' path (36–57)

chapter("ch-agents", 36, 38.6);
{
  const T = 39;
  const s = shot("pipe");
  const track = $("[data-track]", s);
  const frames = $$("[data-frame]", s);
  const rail = $$("[data-rail]", s);
  const step = 1360; // frame width + gap
  const x0 = 360;
  enter("pipe", T - 0.1);
  tl.set(track, { x: x0 + step * 0.5 }, T - 0.1);
  const tilt = () => {
    const mid = 960;
    for (const f of frames) {
      const r = f.getBoundingClientRect();
      const d = (r.left + r.width / 2 - mid) / 1920;
      const panel = f.querySelector<HTMLElement>(".panel");
      if (panel) panel.style.transform = `perspective(1800px) translateX(${d * -90}px) rotateY(${d * -22}deg)`;
      f.style.opacity = String(Math.max(0.18, 1 - Math.abs(d) * 1.4));
    }
  };
  frames.forEach((f, i) => {
    const at = T + i * 2;
    tl.to(track, { x: x0 - step * i, duration: i === 0 ? 0.9 : 0.75, ease: "expo.inOut", onUpdate: tilt }, at - (i === 0 ? 0.1 : 0.42));
    if (i > 0) cue(at - 0.42, "whoosh");
    tl.call(() => rail.forEach((r, j) => r.classList.toggle("done", j <= i)), [], at);
    const ins = $$("[data-in]", f).filter((el) => !el.closest("[data-check]"));
    tl.fromTo(ins, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.6, ease: "expo.out", stagger: 0.09 }, at + 0.05);
  });
  // Diagnose: the line draws to the rise.
  tl.to($("[data-draw]", frames[0]!), { strokeDashoffset: 0, duration: 1.4, ease: "power2.inOut" }, T + 0.15);
  cue(T + 0.9, "amber");
  // Fix: the tests pass.
  cue(T + 2 + 1.0, "chime");
  // Second review: the blocking finding.
  cue(T + 6 + 0.2, "amber");
  cue(T + 6 + 0.5, "chime");
  // CI: one green check at a time.
  $$("[data-check]", frames[4]!).forEach((c, j) => {
    tl.fromTo(c, { opacity: 0, x: -14 }, { opacity: 1, x: 0, duration: 0.4, ease: "expo.out" }, T + 8 + 0.3 + j * 0.3);
    cue(T + 8 + 0.3 + j * 0.3, "tick");
  });
  cue(T + 10 + 0.4, "hit");
  // Merge and Release: your clicks.
  press($("[data-pointer]", frames[6]!), $("[data-press]", frames[6]!), T + 12 + 1.25);
  press($("[data-pointer]", frames[7]!), $("[data-press]", frames[7]!), T + 14 + 1.25);
  // Deploy: confirmed by the tracker, and only then green.
  $$("[data-check]", frames[8]!).forEach((c, j) => {
    tl.fromTo(c, { opacity: 0, x: -14 }, { opacity: 1, x: 0, duration: 0.4, ease: "expo.out" }, T + 16 + 0.2 + j * 0.35);
    cue(T + 16 + 0.2 + j * 0.35, j === 2 ? "chime" : "tick");
  });
  // Out into the day.
  tl.to(flood, { opacity: 1, duration: 0.45, ease: "power2.in" }, 56.6);
  leave("pipe", 56.55);
}

// MARK: 6 · The notch (57–69)

{
  const T = 57;
  const s = shot("notch");
  enter("notch", T);
  tl.set(flood, { opacity: 0 }, T + 1);
  tl.from($(".mac-wrap", s), { y: 180, rotateX: 20, scale: 0.9, transformPerspective: 1800, duration: 2.2, ease: "expo.out" }, T);
  reveal($(".day-title", s), T + 0.1);
  const cap = $("[data-caption]", s);
  const caption = (text: string, at: number) => {
    tl.to(cap, { opacity: 0, filter: "blur(6px)", duration: 0.2 }, at);
    tl.call(() => (cap.textContent = text), [], at + 0.21);
    tl.to(cap, { opacity: 1, filter: "blur(0px)", duration: 0.6, ease: "expo.out" }, at + 0.22);
  };
  tl.call(() => island.setStep(0), [], T + 0.9);
  caption("Agents at work, either side of the notch.", T + 0.9);
  tl.call(() => island.setStep(1), [], T + 2.5);
  caption("Something is yours: a banner drops, then tucks back in.", T + 2.6);
  cue(T + 2.85, "amber");
  tl.call(() => island.setStep(2), [], T + 5.6);
  caption("Click, and the whole app unfolds.", T + 5.8);
  cue(T + 5.6 + 1.07, "click");
  cue(T + 5.6 + 1.2, "whoosh");
  tl.call(() => island.setStep(3), [], T + 8.4);
  caption("Merge, from the notch. Then back to work.", T + 8.5);
  cue(T + 8.4 + 1.45, "click");
  cue(T + 8.4 + 1.6, "chime");
  leave("notch", 68.6);
}

// MARK: 7 · Three clicks (69–75)

{
  const T = 69;
  const s = shot("gates");
  enter("gates", T, "cut");
  reveal($(".hl-m", s), T + 0.05);
  drift("gates", T, 6, { z: -40, rotateX: 4 }, { z: 40, rotateX: -2 });
  const gates = $$("[data-gate]", s);
  gates.forEach((g, i) => {
    tl.fromTo(g, { opacity: 0, y: 50, filter: "blur(8px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.8, ease: "expo.out" }, T + 0.5 + i * 0.12);
  });
  const ptr = $<SVGElement>("[data-pointer]", s);
  gates.forEach((g, i) => {
    const at = T + 1.9 + i * 1.0;
    const btn = $("[data-press]", g);
    const off = offsetWithin(btn, $(".cam", s));
    if (i === 0) press(ptr, btn, at, { dx: 220, dy: 260 }, 0.7);
    else {
      tl.to(ptr, { x: off.x, y: off.y, duration: 0.55, ease: "power3.inOut" }, at - 0.62);
      tl.to(ptr, { scale: 0.82, duration: 0.08 }, at);
      tl.to(ptr, { scale: 1, duration: 0.25, ease: "back.out(3)" }, at + 0.08);
      tl.to(btn, { scale: 0.93, duration: 0.08 }, at);
      tl.to(btn, { scale: 1, duration: 0.4, ease: "back.out(3)" }, at + 0.08);
      cue(at, "click");
    }
    const kind = $(".g-kind", g);
    tl.call(() => {
      kind.innerHTML = `<i class="dot dot-done"></i> ${["Merged #3352", "Released v1.35.12", "Sent to Jonas"][i]}`;
      kind.style.color = "var(--mid)";
    }, [], at + 0.15);
    tl.to(btn, { backgroundColor: "rgba(255,255,255,0.08)", color: "#f5f5f7", duration: 0.4 }, at + 0.2);
  });
  tl.to(ptr, { opacity: 0, duration: 0.3 }, T + 4.5);
  reveal($(".g-foot", s), T + 4.5, { stagger: 0.05 });
  leave("gates", 74.6);
}

// MARK: 8 · Ask, and reply (75–81)

{
  const T = 75;
  const s = shot("ask");
  enter("ask", T, "cut");
  drift("ask", T, 6, { rotateY: 5, z: -20 }, { rotateY: -4, z: 50 });
  const [h1, h2] = $$(".hl-s", s);
  reveal(h1!, T + 0.05);
  reveal(h2!, T + 0.3, { hit: false });
  tl.fromTo([$("[data-acard]", s), $("[data-rcard]", s)], { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.8, ease: "expo.out", stagger: 0.15 }, T + 0.3);
  const ptr = $<SVGElement>("[data-pointer]", s);
  const chip = $$("[data-chip]", s)[0]!;
  press(ptr, chip, T + 1.7, { dx: 260, dy: 240 }, 0.8);
  tl.call(() => chip.classList.add("picked"), [], T + 1.75);
  tl.to($("[data-after]", $("[data-acard]", s)), { opacity: 1, duration: 0.5 }, T + 2.0);
  const draft = $("[data-type]", s);
  typeInto(draft, draft.dataset.type!, T + 2.1, 60);
  const send = $$("[data-chip]", s)[2]!;
  const off = offsetWithin(send, $(".cam", s));
  tl.to(ptr, { x: off.x, y: off.y, duration: 0.7, ease: "power3.inOut" }, T + 3.9);
  tl.to(ptr, { scale: 0.82, duration: 0.08 }, T + 4.7);
  tl.to(ptr, { scale: 1, duration: 0.25, ease: "back.out(3)" }, T + 4.78);
  tl.to(send, { scale: 0.93, duration: 0.08 }, T + 4.7);
  tl.to(send, { scale: 1, duration: 0.4, ease: "back.out(3)" }, T + 4.78);
  cue(T + 4.7, "click");
  tl.to($("[data-after]", $("[data-rcard]", s)), { opacity: 1, duration: 0.5 }, T + 4.9);
  tl.to(ptr, { opacity: 0, duration: 0.3 }, T + 5.3);
  leave("ask", 80.6);
}

// MARK: 9 · Watch (81–96)

chapter("ch-watch", 81, 83.6);
{
  const T = 84;
  const s = shot("watch");
  enter("watch", T, "cut");
  drift("watch", T, 6, { rotateY: -8, rotateX: 4, z: 0 }, { rotateY: 3, rotateX: 1, z: 70 });
  tl.fromTo($$("[data-sig]", s), { opacity: 0, x: -20 }, { opacity: 1, x: 0, duration: 0.5, ease: "expo.out", stagger: 0.07 }, T + 0.1);
  tl.fromTo($(".w-chart", s), { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.8, ease: "expo.out" }, T + 0.1);
  tl.to($("[data-wline]", s), { strokeDashoffset: 0, duration: 2.8, ease: "power1.inOut" }, T + 0.4);
  tl.to($("[data-wrise]", s), { opacity: 1, duration: 0.5 }, T + 2.9);
  cue(T + 2.9, "count");
  tl.fromTo($("[data-finding]", s), { opacity: 0, y: 20, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.7, ease: "expo.out" }, T + 3.4);
  cue(T + 3.4, "amber");
  leave("watch", 89.6);
}
{
  const T = 90;
  const s = shot("logs");
  enter("logs", T, "cut");
  reveal($(".hl-s", s), T + 0.05);
  drift("logs", T, 6, { z: -40, rotateX: 5 }, { z: 30, rotateX: 0 });
  tl.fromTo($("[data-stream]", s).children, { y: 0 }, { y: -900, duration: 6, ease: "none" }, T);
  cue(T + 0.2, "type", 1.6);
  $$("[data-pt]", s).forEach((p, i) => {
    const at = T + 1.3 + i * 0.85;
    tl.fromTo(p, { opacity: 0, y: 24, filter: "blur(6px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.7, ease: "expo.out" }, at);
    $$("[data-pct]", p).forEach((el, j) => countUp(el, Number(el.dataset.pct), at + 0.25 + j * 0.08, 0.8));
    cue(at, "hit");
    cue(at + 0.25, "count");
  });
  leave("logs", 95.6);
}

// MARK: 10 · The team (96–102)

{
  const T = 96;
  const s = shot("team");
  enter("team", T, "cut");
  drift("team", T, 6, { rotateY: 6, z: -40 }, { rotateY: -4, z: 30 });
  reveal($(".hl-m", s), T + 0.05);
  reveal($(".sub", s), T + 0.7, { stagger: 0.03, dur: 0.8, hit: false });
  $$("[data-tm]", s).forEach((m, i) => {
    const at = [T + 1.0, T + 1.6, T + 2.2, T + 3.6][i]!;
    tl.fromTo(m, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.6, ease: "expo.out" }, at);
    cue(at, i === 3 ? "chime" : "tick");
  });
  const late = $("[data-late]", s);
  tl.to(late, { opacity: 0.22, filter: "blur(1px)", duration: 0.5 }, T + 2.9);
  tl.to($("[data-withdrawn]", s), { opacity: 1, duration: 0.4 }, T + 3.0);
  cue(T + 2.9, "deny");
  leave("team", 101.6);
}

// MARK: 11 · Safety (102–110)

{
  const T = 102;
  const s = shot("safety");
  enter("safety", T, "cut");
  drift("safety", T, 8, { rotateY: -8, z: -50 }, { rotateY: 3, z: 30 });
  reveal($(".hl-m", s), T + 0.05);
  tl.fromTo($(".term", s), { opacity: 0, y: 40, rotateY: -12 }, { opacity: 1, y: 0, rotateY: 0, duration: 1, ease: "expo.out" }, T + 0.2);
  $$("[data-ref]", s).forEach((r, i) => {
    const at = T + 0.9 + i * 1.3;
    const cmd = $("[data-type]", r);
    tl.set(r, { opacity: 1 }, at - 0.05);
    const d = typeInto(cmd, cmd.dataset.type!, at, 56);
    tl.to($(".why", r), { opacity: 1, duration: 0.25 }, at + d + 0.12);
    tl.fromTo($(".why", r), { x: -8 }, { x: 0, duration: 0.4, ease: "back.out(4)" }, at + d + 0.12);
    cue(at + d + 0.12, "deny");
  });
  $$("[data-g]", s).forEach((g, i) => tl.to(g, { opacity: 1, duration: 0.4 }, T + 1.5 + i * 1.25));
  leave("safety", 109.6);
}

// MARK: 12 · Outcomes (110–116)

{
  const T = 110;
  const s = shot("outcomes");
  enter("outcomes", T, "cut");
  drift("outcomes", T, 6, { z: -40 }, { z: 40 });
  reveal($(".hl-m", s), T + 0.05);
  $$("[data-outcome]", s).forEach((o, i) => {
    const at = T + 0.9 + i * 1.0;
    tl.to(o, { opacity: 1, duration: 0.4 }, at);
    if (i > 0) tl.to($$("[data-outcome]", s)[i - 1]!, { opacity: 0.4, duration: 0.4 }, at);
    tl.fromTo($(".o-word", o), { x: -30 }, { x: 0, duration: 0.8, ease: "expo.out" }, at);
    cue(at, i === 0 ? "chime" : i === 2 ? "deny" : "hit");
  });
  tl.to($$("[data-outcome]", s), { opacity: 1, duration: 0.5 }, T + 4.9);
  leave("outcomes", 115.6);
}

// MARK: 13 · The light (116–124)

{
  const T = 116;
  const s = shot("light");
  tl.call(() => scene.setActive(true), [], T - 0.6);
  placeCamera(T - 0.4, { x: Math.sin(-0.5) * 17, z: Math.cos(-0.5) * 17, y: -1.2, lookX: -1.5, lookY: 0.2 }, "rest");
  const walk = { a: -0.5 };
  tl.to(
    walk,
    {
      a: 0.5,
      duration: 8.2,
      ease: "sine.inOut",
      onUpdate: () => {
        const r = 17.5 - 2 * ((walk.a + 0.5) / 1);
        cam.x = Math.sin(walk.a) * r;
        cam.z = Math.cos(walk.a) * r;
      },
    },
    T - 0.4,
  );
  enter("light", T, "cut");
  reveal($(".light-title", s), T + 0.1);
  tl.fromTo($(".light-sub", s), { opacity: 0 }, { opacity: 1, duration: 0.8 }, T + 0.6);
  tl.fromTo($(".light-states", s), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.8, ease: "expo.out" }, T + 0.5);
  const states = $$("[data-lstate]", s);
  const lit = (i: number, at: number) => tl.call(() => states.forEach((el, j) => el.classList.toggle("on", j === i)), [], at);
  lit(0, T + 0.5);
  [["working", T + 2], ["needs-you", T + 4], ["paused", T + 6]].forEach(([name, at], i) => {
    light(at as number, name as LightName, 0.7);
    lit(i + 1, at as number);
    cue(at as number, name === "needs-you" ? "amber" : "hit");
  });
  leave("light", 123.6);
  tl.call(() => scene.setLight("out", 0.3), [], 123.7);
}

// MARK: 14 · Montage, and the end (124–137)

{
  const T = 124;
  const s = shot("montage");
  enter("montage", T, "cut");
  $$("[data-mword]", s).forEach((w, i) => {
    const at = T + i * 0.5;
    tl.set(w, { opacity: 1 }, at);
    tl.fromTo(w, { scale: 1.12, filter: "blur(6px)" }, { scale: 1, filter: "blur(0px)", duration: 0.45, ease: "expo.out", immediateRender: false }, at);
    tl.set(w, { opacity: 0 }, at + 0.5);
    cue(at, "hit");
  });
  leave("montage", T + 3.5, "cut");
  tl.call(() => scene.setActive(false), [], T + 0.2);

  const E = 128;
  tl.call(() => scene.setActive(true), [], E - 0.4);
  placeCamera(E - 0.2, { x: 0, y: 2.6, z: 32, lookY: -0.2 }, "out");
  light(E + 0.6, "rest", 2.4);
  tl.to(cam, { z: 18.5, y: -0.4, lookY: 3.5, duration: 8.5, ease: "power3.out" }, E);
  const end = shot("end");
  enter("end", E + 0.6, "cut");
  tl.fromTo($(".kick", end), { opacity: 0 }, { opacity: 1, duration: 1.2 }, E + 0.6);
  tl.fromTo($(".mark", end), { opacity: 0, y: 14, filter: "blur(8px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 1.6, ease: "expo.out" }, E + 1.0);
  tl.fromTo(
    $(".name", end),
    { opacity: 0, letterSpacing: "0.06em", filter: "blur(22px)", scale: 1.06 },
    { opacity: 1, letterSpacing: "-0.05em", filter: "blur(0px)", scale: 1, duration: 2.6, ease: "expo.out" },
    E + 1.1,
  );
  cue(E + 1.1, "impact");
  tl.fromTo($(".end-line", end), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 1.2, ease: "expo.out" }, E + 2.8);
  tl.fromTo($(".end-small", end), { opacity: 0 }, { opacity: 1, duration: 1.2 }, E + 3.8);
  light(E + 5, "working", 0.8);
  light(E + 6.4, "rest", 1.4);
  tl.to({}, { duration: 0.01 }, E + 9);
}

// MARK: Splices

// Two shots cut in after the rest was timed: everything from `at` on (in the cut before any
// splice) moves `d` seconds later, cues included, and the score maps its sections the same way.
// Each is whole bars, so the grid holds. Times above this are in the cut before the splices; the
// spliced shots below are timed in the final cut.
const INSERTS = [
  { at: 36, d: 6 }, // calibration, after Depth
  { at: 96, d: 6 }, // health, after the logs
];
for (const { at, d } of [...INSERTS].sort((a, b) => b.at - a.at)) {
  for (const c of tl.getChildren(false, true, true)) if (c.startTime() >= at - 1e-6) c.startTime(c.startTime() + d);
  for (const c of cues) if (c.t >= at - 1e-6) c.t = +(c.t + d).toFixed(3);
}

// MARK: 4b · Calibration (36–42)

{
  const T = 36;
  const s = shot("calibrate");
  enter("calibrate", T, "cut");
  drift("calibrate", T, 6, { rotateY: -6, z: -40 }, { rotateY: 3, z: 30 });
  reveal($(".hl-m", s), T + 0.05);
  reveal($(".sub", s), T + 0.7, { stagger: 0.03, dur: 0.8, hit: false });
  const rows = $$("[data-vrow]", s);
  tl.fromTo(rows, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.6, ease: "expo.out", stagger: 0.18 }, T + 0.4);
  const ptr = $<SVGElement>("[data-pointer]", s);
  const label = (row: HTMLElement, i: number, text: string, at: number) => {
    const thumb = $$("[data-thumb]", row)[i]!;
    const q = $("[data-vq]", row);
    tl.call(() => thumb.classList.add("picked"), [], at + 0.05);
    tl.to(q, { opacity: 0, duration: 0.12 }, at + 0.05);
    tl.call(() => (q.textContent = text), [], at + 0.18);
    tl.to(q, { opacity: 1, color: "#a1a1a6", duration: 0.4 }, at + 0.19);
    return thumb;
  };
  const up = label(rows[0]!, 0, "You marked this a good call", T + 2.0);
  press(ptr, up, T + 2.0, { dx: 240, dy: 260 }, 0.8);
  const down = label(rows[1]!, 1, "You marked this a bad call", T + 3.4);
  const off = offsetWithin(down, $(".cam", s));
  tl.to(ptr, { x: off.x, y: off.y, duration: 0.6, ease: "power3.inOut" }, T + 2.7);
  tl.to(ptr, { scale: 0.82, duration: 0.08 }, T + 3.4);
  tl.to(ptr, { scale: 1, duration: 0.25, ease: "back.out(3)" }, T + 3.48);
  tl.to(down, { scale: 0.9, duration: 0.08 }, T + 3.4);
  tl.to(down, { scale: 1, duration: 0.4, ease: "back.out(3)" }, T + 3.48);
  cue(T + 3.4, "click");
  tl.to(ptr, { opacity: 0, x: "+=60", y: "+=80", duration: 0.5, ease: "power2.in" }, T + 4.4);
  leave("calibrate", T + 5.6);
}

// MARK: 9b · Health (102–108)

{
  const T = 102;
  const s = shot("health");
  enter("health", T, "cut");
  drift("health", T, 6, { z: -50, rotateX: 5 }, { z: 30, rotateX: 0 });
  reveal($(".hl-m", s), T + 0.05);
  tl.fromTo($("[data-hcard]", s), { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.8, ease: "expo.out" }, T + 0.35);
  const dot = $('[data-svc="Grafana"] .dot', s);
  const fold = $("[data-hfold]", s);
  tl.call(() => (dot.className = "dot dot-amber"), [], T + 1.3);
  tl.to($('[data-svc="Grafana"]', s), { color: "#f5f5f7", duration: 0.3 }, T + 1.3);
  cue(T + 1.3, "amber");
  tl.to(fold, { height: () => fold.scrollHeight, duration: 0.6, ease: "expo.out" }, T + 1.35);
  const line = $("[data-type]", fold);
  typeInto(line, line.dataset.type!, T + 1.6, 64);
  // Fixed: the dot goes quiet again and the warning folds away.
  tl.call(() => (dot.className = "dot dot-done"), [], T + 4.1);
  tl.to($('[data-svc="Grafana"]', s), { color: "#a1a1a6", duration: 0.3 }, T + 4.1);
  tl.to($(".h-problem:not(.h-after)", fold), { opacity: 0, duration: 0.25 }, T + 4.1);
  tl.to($("[data-hafter]", fold), { opacity: 1, duration: 0.35 }, T + 4.2);
  cue(T + 4.1, "tick");
  tl.to(fold, { height: 0, opacity: 0, duration: 0.6, ease: "expo.inOut" }, T + 5.0);
  leave("health", T + 5.6);
}

// MARK: Run

tl.eventCallback("onComplete", () => (window.__film.done = true));
window.__film = {
  ready: false,
  done: false,
  duration: tl.duration(),
  cues: cues.sort((a, b) => a.t - b.t),
  inserts: INSERTS,
  start: () => void tl.play(0),
};
const params = new URLSearchParams(location.search);
const wait = () => {
  if (sceneReady) document.fonts.ready.then(() => setTimeout(() => (window.__film.ready = true), 800));
  else requestAnimationFrame(wait);
};
wait();
if (params.has("at")) {
  // `?at=42` holds the film at 42 seconds, for stills.
  const at = Number(params.get("at"));
  const go = () =>
    sceneReady
      ? setTimeout(() => {
          tl.seek(Math.max(0, at - 3), false);
          tl.play();
        }, 600)
      : requestAnimationFrame(go);
  go();
  tl.call(() => tl.pause(), [], at);
}
if (params.has("play")) setTimeout(() => tl.play(0), 1500);
