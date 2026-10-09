// The launch film's director: the noise, the name, the notch, then the real app, cut to a
// 120 BPM grid (a beat is half a second, a bar two). Plays once and reports when it is done,
// plus the cues the score is built from (scripts/score.ts).

import { splitText } from "./split";
import { $, $$, createRig } from "./rig";

type CueKind =
  | "tick" // a notification lands
  | "drop" // the noise cuts out
  | "hit" // a line of type lands
  | "impact" // the name
  | "riser" // building into the next cut (v = length)
  | "whoosh" // a camera move
  | "push" // a shot pushed past the camera, into the cut 0.42s later
  | "swell" // a panel rises into place
  | "click" // a button, pressed
  | "chime" // a verified outcome
  | "amber"; // something is yours

interface Cue {
  t: number;
  kind: CueKind;
  v?: number;
}

const { tl, scene, cam, flood, light, place, tour, publish } = createRig({ cinematic: true });
const cues: Cue[] = [];
const cue = (t: number, kind: CueKind, v?: number) => cues.push({ t: +t.toFixed(3), kind, ...(v === undefined ? {} : { v }) });
const shots = Object.fromEntries($$("[data-shot]").map((el) => [el.dataset.shot!, el]));
const shot = (name: string) => shots[name]!;

// MARK: The arch

const sceneCanvas = $<HTMLCanvasElement>("[data-scene]");
// The film opens on the noise: the arch draws its first frame (rig.ts waits for it), unseen.
sceneCanvas.style.visibility = "hidden";
/** Starts or pauses the arch. A paused canvas still holds its last frame (often the white of
 * the flare), so it is hidden too. */
const stage = (on: boolean, at: number) =>
  tl.call(
    () => {
      scene.setActive(on);
      sceneCanvas.style.visibility = on ? "visible" : "hidden";
    },
    [],
    at,
  );

// MARK: Grammar

/** Words rise into place, one after another. */
function reveal(el: HTMLElement, at: number, { stagger = 0.06, dur = 1.0, hit = true } = {}) {
  tl.fromTo(
    splitText(el, "words"),
    { yPercent: 110, opacity: 0, filter: "blur(10px)" },
    { yPercent: 0, opacity: 1, filter: "blur(0px)", duration: dur, ease: "expo.out", stagger },
    at,
  );
  if (hit) cue(at, "hit");
}

/** The words of `el` lift away, ahead of the next line. */
function conceal(el: HTMLElement, at: number) {
  tl.to(splitText(el, "words"), { yPercent: -60, opacity: 0, filter: "blur(8px)", duration: 0.35, ease: "power2.in", stagger: 0.02 }, at);
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
  cue(at, "swell");
}

/** A shot goes: pushed past the camera, or cut. */
function leave(name: string, at: number, how: "cut" | "push" = "push") {
  const el = shot(name);
  if (how === "cut") {
    tl.set(el, { autoAlpha: 0 }, at);
    return;
  }
  tl.to(el, { autoAlpha: 0, scale: 1.07, filter: "blur(18px)", duration: 0.42, ease: "power2.in" }, at);
  cue(at, "push");
}

// MARK: Screens

/** A region of a screenshot, in its pixels (2200 × 1024): left, top, right, bottom. */
type Rect = [number, number, number, number];

/** Where Screen.astro puts a screenshot: its frame's corner and its scale. */
const FRAME = { x: 160, y: 266, k: 1600 / 2200 };
/** Where a region the camera closes on is centred, and the room it may fill, below the words. */
const VIEW = { x: 960, y: 640, w: 1700, h: 720 };

/** The camera's place to show `r` as large as the room allows, up to `max` times. */
function framing(r: Rect | null, max = 2.4) {
  if (!r) return { x: 0, y: 0, scale: 1 };
  const [x0, y0, x1, y1] = r;
  const z = Math.min(VIEW.w / ((x1 - x0) * FRAME.k), VIEW.h / ((y1 - y0) * FRAME.k), max);
  const cx = FRAME.x + ((x0 + x1) / 2) * FRAME.k;
  const cy = FRAME.y + ((y0 + y1) / 2) * FRAME.k;
  return { x: VIEW.x - z * cx, y: VIEW.y - z * cy, scale: z };
}

/** The camera moves over `name`'s screen to `r` (null: the whole screen). */
function look(name: string, r: Rect | null, at: number, dur = 1.4, max?: number) {
  tl.to($(".cam", shot(name)), { ...framing(r, max), transformOrigin: "0 0", duration: dur, ease: "power3.inOut" }, at);
  if (dur > 0.5) cue(at, "whoosh");
}

/** The camera starts there, already. */
function frame(name: string, r: Rect | null, at: number, max?: number) {
  tl.set($(".cam", shot(name)), { ...framing(r, max), transformOrigin: "0 0" }, at);
}

/** Percentages of a screenshot, for things laid out inside its frame. */
const pct = ([x0, y0, x1, y1]: Rect) => ({
  left: `${(x0 / 2200) * 100}%`,
  top: `${(y0 / 1024) * 100}%`,
  width: `${((x1 - x0) / 2200) * 100}%`,
  height: `${((y1 - y0) / 1024) * 100}%`,
});

/** The shots whose spotlight or pointer is on screen, as the timeline is built. */
const lit = new Set<string>();
const pointing = new Set<string>();

/** The spotlight goes to `r`, or away. It comes up where it is first wanted, then moves on. */
function spot(name: string, r: Rect | null, at: number) {
  const s = $("[data-spot]", shot(name));
  if (!r) {
    tl.to(s, { opacity: 0, duration: 0.5, ease: "power2.out" }, at);
    lit.delete(name);
  } else if (lit.has(name)) {
    tl.to(s, { ...pct(r), duration: 0.8, ease: "power3.inOut" }, at);
  } else {
    tl.set(s, pct(r), at);
    tl.to(s, { opacity: 1, duration: 0.6, ease: "power2.out" }, at);
    lit.add(name);
  }
}

/** Cross-fades `name`'s screen to `screen`. */
function show(name: string, screen: string, at: number, dur = 0.5) {
  const imgs = $$("[data-screen]", shot(name));
  for (const img of imgs) tl.to(img, { opacity: img.dataset.screen === screen ? 1 : 0, duration: dur, ease: "sine.inOut" }, at);
}

/** Caption `i` replaces the one before it. */
function caption(name: string, i: number, at: number) {
  const caps = $$("[data-cap]", shot(name));
  if (i > 0) conceal(caps[i - 1]!, at - 0.36);
  reveal(caps[i]!, at, { stagger: 0.05, dur: 0.9, hit: i === 0 });
}

/** The pointer glides in to the button at `p` (screenshot pixels) and presses it at `at`. */
function press(name: string, p: [number, number], at: number, travel = 0.8) {
  const ptr = $("[data-ptr]", shot(name));
  const pos = (x: number, y: number) => ({ left: `${(x / 2200) * 100}%`, top: `${(y / 1024) * 100}%` });
  if (!pointing.has(name)) tl.set(ptr, { ...pos(p[0] + 260, p[1] + 200), opacity: 0 }, at - travel - 0.15);
  tl.to(ptr, { ...pos(p[0] - 6, p[1] - 4), opacity: 1, duration: travel, ease: "power3.inOut" }, at - travel - 0.12);
  tl.to(ptr, { scale: 0.82, duration: 0.08, transformOrigin: "6px 4px" }, at);
  tl.to(ptr, { scale: 1, duration: 0.25, ease: "back.out(3)" }, at + 0.08);
  cue(at, "click");
  pointing.add(name);
}

/** The pointer leaves. */
function unpoint(name: string, at: number) {
  tl.to($("[data-ptr]", shot(name)), { opacity: 0, duration: 0.3 }, at);
  pointing.delete(name);
}

/** A button in the screenshot goes down under the pointer: a dark press over its rectangle. */
function dip(name: string, r: Rect, at: number) {
  const d = document.createElement("div");
  d.style.cssText = "position:absolute;border-radius:10px;background:#000;opacity:0;pointer-events:none;z-index:2";
  Object.assign(d.style, pct(r));
  $("[data-frame]", shot(name)).append(d);
  tl.to(d, { opacity: 0.35, duration: 0.06 }, at);
  tl.to(d, { opacity: 0, duration: 0.3 }, at + 0.1);
}

// MARK: 1 · The noise (0–8)

const NOTES: [string, string, string, boolean][] = [
  ["#alert-api", "M", "5xx rate 3.1% on /v4/opportunities over 5 minutes", true],
  ["#eng-api", "J", "@alex /opportunities 500s when chainId is empty", false],
  ["#alert-engine", "M", "Keeper missed 2 root updates on Arbitrum", true],
  ["Hugo", "H", "should we prioritise the sparkline work over the studio revamp?", false],
  ["#alert-erpc", "M", "eRPC errors 4.2% on Base", true],
  ["#alert-jobs", "M", "pod opportunities-sync OOMKilled", true],
  ["#alert-releases", "D", "merkl-app v2.15.0 · Build failed", true],
  ["@infra", "S", "anyone looking at the dispute bot retries?", false],
  ["#alert-db", "M", "Lock waits above 2s on rewards", true],
  ["#alert-uptime", "M", "Incident started on api.merkl.xyz/v4/roots/delay", true],
  ["Baptiste", "B", "#product: review #3336 when you get a chance?", false],
  ["#alert-api", "M", "p99 latency 1.8s on /v4/campaigns", true],
  ["#alert-rewards", "M", "Campaign 0x8f3c…2a1b distributed 0 rewards", true],
  ["#alert-releases", "D", "merkl-api v1.35.11 waiting for approval", true],
  ["Julien", "J", "is the Base indexer behind again?", false],
  ["#alert-engine", "M", "[RESOLVED] Keeper missed 2 root updates", true],
  ["#alert-jobs", "M", "cron rewards-sync exceeded 15 min", true],
  ["Pierre", "P", "@alex quick one on the v4 pagination", false],
];
{
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
  const notes = $$(".note", wall);
  // Nearest the middle first, with a little disorder, so the first ones are read and the rest pile up.
  const cols = 6;
  const rows = Math.ceil(N / cols);
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  notes
    .map((el, i) => {
      const cx = (i % cols) - (cols - 1) / 2;
      const cy = Math.floor(i / cols) - (rows - 1) / 2;
      return { el, d: Math.hypot(cx * 0.8, cy * 1.6) + rand() * 1.6 };
    })
    .sort((a, b) => a.d - b.d)
    .forEach(({ el }, k) => {
      const t = 0.35 + 6.9 * Math.pow(k / (N - 1), 0.52);
      tl.fromTo(el, { opacity: 0, scale: 0.86, y: 30, z: -120 }, { opacity: 1, scale: 1, y: 0, z: 0, duration: 0.55, ease: "expo.out" }, t);
      cue(t, "tick");
    });
  enter("noise", 0, "cut");
  stage(false, 0.1);
  tl.fromTo(
    $(".cam", shot("noise")),
    { transformPerspective: 2400, scale: 2.1, rotateX: 22, rotateZ: -5, y: 40 },
    { scale: 0.92, rotateX: 30, rotateZ: -9, y: -20, duration: 8, ease: "sine.inOut" },
    0,
  );
  const count = (el: HTMLElement, to: number, at: number, dur: number, fmt = (n: number) => String(Math.round(n))) => {
    const o = { n: 0 };
    tl.to(o, { n: to, duration: dur, ease: "power2.in", onUpdate: () => (el.textContent = fmt(o.n)) }, at);
  };
  count($('[data-count="alerts"]'), 147, 0.4, 7.2);
  count($('[data-count="mentions"]'), 23, 0.9, 6.7);
  count($('[data-count="dms"]'), 9, 1.4, 6.2);
  const two = (n: number) => String(n).padStart(2, "0");
  count($("[data-clock]"), 95, 0.4, 7.4, (n) => `${two(9 + Math.floor((12 + n) / 60))}:${two(Math.floor(12 + n) % 60)}`);
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

place(11.45, { x: 0, y: 0.6, z: 31, lookY: 2.6 });
stage(true, 11.5);
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
// Into the arch and its light, which becomes the day the notch is shown in.
tl.to(cam, { z: 0.9, y: -0.72, lookY: -0.72, lookZ: -14, duration: 1.9, ease: "power2.in" }, 18.1);
tl.to(cam, { flare: 1, duration: 1.7, ease: "power1.in" }, 18.3);
tl.to(cam, { white: 1, duration: 0.6, ease: "power2.in" }, 19.4);
cue(17.9, "riser", 2.1);
tl.set(flood, { opacity: 1 }, 20);
stage(false, 20.1);

// MARK: 4 · The notch (20–29)

{
  const T = 20;
  const s = shot("notch");
  enter("notch", T);
  tl.from($(".mac-wrap", s), { y: 180, rotateX: 20, scale: 0.9, transformPerspective: 1800, duration: 2.2, ease: "expo.out" }, T);
  reveal($(".day-title", s), T + 0.1);
  tour(
    $("[data-caption]", s),
    [T + 0.9, T + 2.5, T + 4.6],
    [T + 0.9, T + 2.6, T + 4.8],
    ["Agents at work, either side of the notch.", "Something needs you: a banner drops, then tucks back in.", "One click, and the whole app unfolds."],
  );
  cue(T + 2.85, "amber");
  cue(T + 4.6 + 1.07, "click");
  cue(T + 4.6 + 1.2, "whoosh");
  // The camera leans into the open island, then goes through it, into the app.
  tl.to($(".mac-wrap", s), { scale: 1.06, transformOrigin: "50% 0%", duration: 1.6, ease: "power2.inOut" }, T + 5.6);
  tl.to([$(".day-title", s), $("[data-caption]", s)], { opacity: 0, duration: 0.5 }, T + 7.2);
  tl.to($(".mac-wrap", s), { scale: 2.1, y: 120, filter: "blur(10px)", duration: 1.0, ease: "power3.in" }, T + 7.5);
  tl.to(s, { autoAlpha: 0, duration: 0.3, ease: "power1.in" }, T + 8.3);
  tl.set(flood, { opacity: 0 }, T + 8.3);
  cue(T + 7.5, "riser", 1.1);
}

// MARK: 5 · One glance (28.6–37)

{
  const T = 28.6;
  const n = "glance";
  const s = shot(n);
  tl.fromTo(s, { autoAlpha: 0, scale: 1.35, filter: "blur(14px)" }, { autoAlpha: 1, scale: 1, filter: "blur(0px)", duration: 1.2, ease: "expo.out" }, T);
  cue(T, "impact");
  frame(n, null, T);
  tl.fromTo($(".kick", s), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.8, ease: "expo.out" }, T + 0.4);
  caption(n, 0, T + 0.5);
  // Prod, Needs you, Agents: one column at a time, read left to right.
  const PROD: Rect = [0, 64, 760, 1024];
  const NEEDS: Rect = [760, 64, 1480, 1024];
  const AGENTS: Rect = [1480, 64, 2200, 1024];
  [PROD, NEEDS, AGENTS].forEach((r, i) => {
    const at = T + 2.4 + i * 2;
    spot(n, r, at);
    look(n, r, at, 1.3, 1.25);
    caption(n, i + 1, at + 0.2);
    if (i === 1) cue(at + 0.4, "amber");
  });
  spot(n, null, T + 8);
  look(n, null, T + 7.9, 0.5);
  leave(n, T + 8.4);
}

// MARK: 6 · Agents take it all the way (37–49)

{
  const T = 37;
  const n = "agents";
  const s = shot(n);
  enter(n, T);
  tl.fromTo($(".kick", s), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.8, ease: "expo.out" }, T + 0.2);
  // The session's state and its step, in the detail pane.
  const STATE: Rect = [770, 64, 2200, 500];
  const MERGE: Rect = [770, 480, 2200, 760];
  frame(n, null, T);
  caption(n, 0, T + 0.3);
  look(n, STATE, T + 0.9, 1.6, 1.7);
  spot(n, [776, 170, 2190, 520], T + 1.2);
  // Review, then CI: other sessions, further along the same path.
  show(n, "review", T + 2.6);
  caption(n, 1, T + 2.7);
  cue(T + 2.7, "tick");
  show(n, "ci", T + 4.6);
  caption(n, 2, T + 4.7);
  cue(T + 4.9, "chime");
  // Ready to merge: the one click that is yours.
  show(n, "merge", T + 6.6);
  caption(n, 3, T + 6.7);
  cue(T + 6.8, "amber");
  look(n, MERGE, T + 6.8, 1.3, 1.6);
  spot(n, [776, 520, 2190, 740], T + 6.9);
  const MERGE_BTN: [number, number] = [895, 680];
  press(n, MERGE_BTN, T + 8.6);
  dip(n, [837, 652, 953, 707], T + 8.6);
  show(n, "merged", T + 8.8, 0.35);
  cue(T + 9.0, "chime");
  caption(n, 4, T + 9.2);
  press(n, [941, 680], T + 10.6, 0.55);
  dip(n, [837, 653, 1046, 706], T + 10.6);
  unpoint(n, T + 11.0);
  leave(n, T + 11.6);
}

// MARK: 7 · Production (49–55)

{
  const T = 49;
  const n = "watch";
  const s = shot(n);
  enter(n, T, "cut");
  tl.fromTo(s, { scale: 1.05, filter: "blur(10px)" }, { scale: 1, filter: "blur(0px)", duration: 0.8, ease: "expo.out" }, T);
  tl.fromTo($(".kick", s), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.8, ease: "expo.out" }, T + 0.2);
  frame(n, null, T);
  caption(n, 0, T + 0.1);
  // The spike, where it was seen, and then what Bridgetown says about it.
  spot(n, [0, 150, 760, 520], T + 1.0);
  cue(T + 1.0, "amber");
  look(n, [770, 170, 2200, 930], T + 2.0, 1.3, 1.6);
  spot(n, [776, 180, 2190, 520], T + 2.1);
  caption(n, 1, T + 2.2);
  spot(n, [1990, 940, 2190, 1015], T + 3.8);
  look(n, [1300, 560, 2200, 1024], T + 3.7, 1.0, 1.9);
  caption(n, 2, T + 3.9);
  press(n, [2090, 977], T + 4.8, 0.6);
  dip(n, [2008, 950, 2172, 1004], T + 4.8);
  unpoint(n, T + 5.2);
  leave(n, T + 5.6);
}

// MARK: 8 · Your models (55–61)

{
  const T = 55;
  const s = shot("models");
  enter("models", T, "cut");
  tl.fromTo($(".kick", s), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.8, ease: "expo.out" }, T + 0.05);
  reveal($(".hl-m", s), T + 0.1);
  tl.fromTo($(".sub", s), { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.9, ease: "expo.out" }, T + 0.9);
  tl.fromTo(
    $("[data-panel]", s),
    { opacity: 0, y: 90, rotateY: -14, transformPerspective: 2000 },
    { opacity: 1, y: 0, rotateY: -6, duration: 1.2, ease: "expo.out" },
    T + 0.3,
  );
  tl.to($("[data-panel]", s), { rotateY: 0, y: -10, duration: 5, ease: "sine.inOut" }, T + 1.2);
  cue(T + 0.3, "swell");
  // Monitoring, then Reviewing: 960 × 1258 pixels, shown at two thirds.
  const sp = $("[data-spot]", s);
  const box = (x0: number, y0: number, x1: number, y1: number) => ({
    left: `${(x0 / 960) * 100}%`,
    top: `${(y0 / 1258) * 100}%`,
    width: `${((x1 - x0) / 960) * 100}%`,
    height: `${((y1 - y0) / 1258) * 100}%`,
  });
  tl.set(sp, box(46, 140, 914, 368), T);
  tl.to(sp, { opacity: 1, duration: 0.6 }, T + 2.0);
  cue(T + 2.0, "hit");
  tl.to(sp, { ...box(46, 544, 914, 772), duration: 0.8, ease: "power3.inOut" }, T + 3.6);
  cue(T + 3.6, "hit");
  tl.to(sp, { opacity: 0, duration: 0.5 }, T + 5.0);
  leave("models", T + 5.6);
}

// MARK: 9 · Montage, and the end (61–70)

{
  const T = 61;
  const s = shot("montage");
  enter("montage", T, "cut");
  $$("[data-mword]", s).forEach((w, i) => {
    const at = T + i * 0.5;
    tl.set(w, { opacity: 1 }, at);
    tl.fromTo(w, { scale: 1.12, filter: "blur(6px)" }, { scale: 1, filter: "blur(0px)", duration: 0.45, ease: "expo.out", immediateRender: false }, at);
    tl.set(w, { opacity: 0 }, at + 0.5);
    cue(at, "hit");
  });
  leave("montage", T + 2, "cut");

  const E = 63;
  place(E - 0.5, { x: 0, y: 2.6, z: 32, lookY: -0.2 }, "out");
  stage(true, E - 0.4);
  light(E + 0.3, "rest", 2.4);
  tl.to(cam, { z: 18.5, y: -0.4, lookY: 3.5, duration: 8, ease: "power3.out" }, E);
  const end = shot("end");
  enter("end", E + 0.3, "cut");
  tl.fromTo($(".mark", end), { opacity: 0, y: 14, filter: "blur(8px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 1.6, ease: "expo.out" }, E + 0.5);
  tl.fromTo(
    $(".name", end),
    { opacity: 0, letterSpacing: "0.06em", filter: "blur(22px)", scale: 1.06 },
    { opacity: 1, letterSpacing: "-0.05em", filter: "blur(0px)", scale: 1, duration: 2.6, ease: "expo.out" },
    E + 0.6,
  );
  cue(E + 0.6, "impact");
  tl.fromTo($(".end-line", end), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 1.2, ease: "expo.out" }, E + 2.2);
  tl.fromTo($(".end-small", end), { opacity: 0 }, { opacity: 1, duration: 1.2 }, E + 3.2);
  light(E + 4.4, "working", 0.8);
  light(E + 5.8, "rest", 1.4);
  tl.to({}, { duration: 0.01 }, E + 8);
}

// MARK: Run

publish({ cues: cues.sort((a, b) => a.t - b.t) });
