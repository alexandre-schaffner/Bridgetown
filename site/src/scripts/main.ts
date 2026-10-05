// The page's choreography: what moves with more than one chapter. ScrollTrigger reports where
// each chapter is; one ticker turns that into the camera, the light, the hero's frames and
// the outcomes brightening on the way. Widgets that keep to their own chapter run from their
// component (Nav, Recording, Notch, Triage, Watch, Safety, Finale, Film). Without script every
// chapter still reads top to bottom, unpinned and fully shown.

import { gsap } from "gsap";
import type { Color } from "three";
import { $, $$, cssRGB } from "../lib/dom";
import { clamp, band, inOut, lerp, smooth } from "../lib/math";
import { splitText } from "../lib/split";
import { createHeroFrames } from "./hero-frames";
import { createReel } from "./reel";
import type { ArchScene, LightName } from "./scene";
import { finePointer, reduced, ScrollTrigger, sinceScroll } from "./scroll";
import { heroWhite, restView, type View } from "./view";

// MARK: Scene

// The hero is pre-rendered; the live scene (and three.js, in its own chunk) is only needed for
// the light and the closing chapters. Setting it up costs the main thread real time (parsing,
// the environment map, shader compiles), so it happens in steps, each one in a moment when
// you have stopped scrolling, well before those chapters; only if you get close first does
// it stop waiting.
let scene: ArchScene | null = null;
let dayColor: (rgb: [number, number, number]) => Color = () => {
  throw new Error("three.js not loaded");
};
const canvas = $<HTMLCanvasElement>("[data-scene]");

let urgent = false;
const idle = (fn: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 600 }) : setTimeout(fn, 60));
/** Resolves once the page has been at rest for a moment, or straight away when the scene is due. */
const atRest = () =>
  new Promise<void>((resolve) => {
    const check = () => {
      if (urgent) resolve();
      else if (sinceScroll() < 450) setTimeout(check, 150);
      else idle(() => (urgent || sinceScroll() >= 450 ? resolve() : check()));
    };
    check();
  });

let sceneLoading = false;
async function loadScene() {
  if (!canvas || sceneLoading) return;
  sceneLoading = true;
  try {
    await atRest();
    const [{ createArchScene }, THREE] = await Promise.all([import("./scene"), import("three")]);
    await atRest();
    dayColor = ([r, g, b]) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
    const s = createArchScene(canvas, {
      day: dayColor(cssRGB("--day")),
      reducedMotion: reduced,
      onFirstFrame: () => document.documentElement.classList.add("scene-ready"),
    });
    Object.assign(s.view, lightView(lightP));
    s.snap();
    s.setActive(false);
    scene = s;
    await s.prepare(atRest);
  } catch {
    // No WebGL: those chapters keep the plain night behind them.
    scene = null;
  }
}
const watchFor = (ids: string[], rootMargin: string, then: () => void) => {
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      then();
      io.disconnect();
    },
    { rootMargin },
  );
  for (const id of ids) {
    const el = $(id);
    if (el) io.observe(el);
  }
};
// Start once you are into the page; insist once a night chapter is a screen or so away.
watchFor(["#notch", "#light", "#access"], "100% 0px", () => void loadScene());
watchFor(["#light", "#access"], "150% 0px", () => {
  urgent = true;
  void loadScene();
});

// The theme switch (Nav) changed what day is: the flood follows.
addEventListener("themechange", () => scene?.setDay(dayColor(cssRGB("--day"))));

// The pre-rendered hero.
const heroMedia = $("[data-hero-media]");
const heroFrames = heroMedia && createHeroFrames(heroMedia, { reducedMotion: reduced });

if (finePointer && !reduced) {
  addEventListener("pointermove", (e) => {
    const x = (e.clientX / innerWidth) * 2 - 1;
    const y = (e.clientY / innerHeight) * 2 - 1;
    scene?.setPointer(x, y);
    heroMedia?.style.setProperty("--px", x.toFixed(3));
    heroMedia?.style.setProperty("--py", y.toFixed(3));
  });
}

// MARK: Drag

// In the night chapters a mouse can take the camera and walk it around the arch.
const orbit = { angle: 0 };
let dragging = false;
if (finePointer && !reduced) {
  let lastX = 0;
  for (const n of $$(".night:not(.hero)")) {
    n.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.target as Element).closest("a, button, input, label, form")) return;
      dragging = true;
      lastX = e.clientX;
      document.documentElement.classList.add("orbiting");
    });
  }
  addEventListener("pointermove", (e) => {
    if (!dragging) return;
    orbit.angle = clamp(orbit.angle - (e.clientX - lastX) * 0.004, -1.1, 1.1);
    lastX = e.clientX;
  });
  addEventListener("pointerup", () => {
    dragging = false;
    document.documentElement.classList.remove("orbiting");
  });
}

// MARK: Hero

const hero = $("[data-hero]")!;
const beats = $$("[data-beat]", hero);
const cue = $("[data-cue]", hero);
const heroStage = $(".stage", hero)!;
let heroP = 0;
ScrollTrigger.create({
  trigger: hero,
  start: "top top",
  end: "bottom bottom",
  onUpdate: (s) => (heroP = s.progress),
});

// The headline arrives letter by letter out of a blur, as the light comes up behind it.
const title = $("[data-split]", hero);
if (title && !reduced) {
  gsap.from(splitText(title, "chars"), {
    yPercent: 40,
    opacity: 0,
    filter: "blur(12px)",
    duration: 1.4,
    ease: "expo.out",
    stagger: 0.022,
    delay: 0.45,
    clearProps: "filter",
  });
  gsap.from($$(".kicker, .intro-side > *", hero), {
    y: 18,
    opacity: 0,
    filter: "blur(6px)",
    duration: 1.2,
    ease: "expo.out",
    stagger: 0.12,
    delay: 1.1,
    clearProps: "filter",
  });
}

function playBeats(p: number) {
  const shows = [1 - smooth(0.06, 0.15, p), band(p, 0.2, 0.26, 0.38, 0.45), band(p, 0.49, 0.55, 0.66, 0.73)];
  beats.forEach((el, i) => {
    const v = shows[i] ?? 0;
    const leaving = i === 0 || p > [0, 0.32, 0.6][i]!;
    el.style.opacity = v.toFixed(3);
    el.style.visibility = v < 0.01 ? "hidden" : "visible";
    el.style.transform = `translateY(${((1 - v) * (leaving ? -28 : 28)).toFixed(1)}px)`;
    el.style.filter = v > 0.99 ? "" : `blur(${((1 - v) * 10).toFixed(1)}px)`;
  });
  if (cue) cue.style.opacity = String(1 - smooth(0, 0.04, p));
  heroStage.style.setProperty("--scrim", (1 - smooth(0.72, 0.84, p)).toFixed(3));
}

// MARK: Reveals

// Headings rise out of a mask as their section arrives: once, quietly.
if (!reduced) {
  for (const h of $$(".day .display")) {
    gsap.from(h, {
      yPercent: 30,
      opacity: 0,
      clipPath: "inset(0 0 100% 0)",
      duration: 1.3,
      ease: "expo.out",
      scrollTrigger: { trigger: h, start: "top 85%", once: true },
      clearProps: "clipPath,transform",
    });
  }
  for (const l of $$(".day .lead")) {
    gsap.from(l, {
      y: 16,
      opacity: 0,
      duration: 1.2,
      delay: 0.12,
      ease: "expo.out",
      scrollTrigger: { trigger: l, start: "top 88%", once: true },
    });
  }
}

// MARK: Journey

// Wide screens pin the chapter and slide its reel past by scroll; narrow ones stack the
// frames, each playing as it scrolls into view.
const journey = $("[data-journey]");
if (journey) {
  const pin = $("[data-journey-pin]", journey)!;
  const reel = createReel(journey, { tilt: !reduced });
  let sideways = false;
  const layout = () => {
    sideways = reel.sideways;
    if (!sideways) {
      journey.style.height = "";
      pin.style.position = "";
      reel.reset();
      return;
    }
    reel.measure();
    journey.style.height = `${reel.distance + innerHeight}px`;
    pin.style.position = "sticky";
    pin.style.top = "0";
  };
  layout();
  // Before every measure (load, late fonts, resize), so the reel's length is never stale.
  ScrollTrigger.addEventListener("refreshInit", layout);
  const slide = ScrollTrigger.create({
    trigger: journey,
    start: "top top",
    end: "bottom bottom",
    onUpdate: (s) => sideways && reel.seek(s.progress),
  });
  // A frame coming into view plays: stacked, that frame; in a row, whatever the reel has near
  // its middle. Scroll alone misses that when it stops exactly at the start (the nav's link
  // lands there), since the progress never moves off 0.
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      if (sideways) reel.seek(slide.progress);
      else entries.forEach((e) => e.isIntersecting && e.target.classList.add("played"));
    },
    { threshold: 0.4 },
  );
  $$(".frame", journey).forEach((f) => io.observe(f));
}

// MARK: Light

const lightSection = $("[data-light]");
let lightP = 0;
/** What the light chapter shows: the state scrolling has reached, or the one you picked. */
let stageLight: LightName = "rest";
if (lightSection) {
  const ORDER: LightName[] = ["rest", "working", "needs-you", "paused"];
  const items = $$("[data-light-state]", lightSection);
  let reached = 0;
  let picked: { name: LightName; at: number } | null = null;
  const show = (name: LightName) => {
    stageLight = name;
    items.forEach((el) => {
      const on = el.dataset.lightState === name;
      el.classList.toggle("on", on);
      el.querySelector("button")?.setAttribute("aria-pressed", String(on));
    });
  };
  // A picked light holds until scrolling moves on to the next state.
  for (const b of $$<HTMLButtonElement>("[data-light-pick]", lightSection)) {
    b.addEventListener("click", () => {
      picked = { name: b.dataset.lightPick as LightName, at: reached };
      show(picked.name);
    });
  }
  // The section runs up and down through 70svh of dusk either side of its pinned stage.
  ScrollTrigger.create({
    trigger: lightSection,
    start: () => `top+=${innerHeight * 0.7} top`,
    end: () => `bottom-=${innerHeight * 0.7} bottom`,
    onUpdate: (s) => {
      lightP = s.progress;
      reached = Math.min(ORDER.length - 1, Math.floor(s.progress * ORDER.length));
      if (picked && reached !== picked.at) picked = null;
      show(picked?.name ?? ORDER[reached]!);
    },
  });
}

function lightView(p: number): View {
  const v = restView();
  const a = lerp(-0.42, 0.42, inOut(p));
  const r = lerp(15.5, 12.5, inOut(p));
  v.x = Math.sin(a) * r;
  v.z = Math.cos(a) * r;
  v.y = -1.2;
  v.lookY = 0.45;
  return v;
}

// MARK: Finale

const finale = $("[data-finale]");
let finaleP = 0;
if (finale) {
  ScrollTrigger.create({
    trigger: finale,
    start: "top bottom",
    end: () => `top+=${innerHeight * 0.7} top`,
    onUpdate: (s) => (finaleP = s.progress),
  });

  // The light answers the button: blue lamps come on while your pointer is on it, and it
  // settles once a request is sent (Finale).
  const button = $("button", finale);
  const wake = (on: boolean) => scene?.setLight(on ? "working" : "rest", on ? 0.5 : 1.2);
  button?.addEventListener("pointerenter", () => wake(true));
  button?.addEventListener("pointerleave", () => wake(false));
  button?.addEventListener("focus", () => wake(true));
  button?.addEventListener("blur", () => wake(false));
  finale.addEventListener("access-sent", () => scene?.setLight("rest", 0.4));
}

function finaleView(p: number): View {
  const v = restView();
  const t = inOut(p);
  // The arch settles low in the frame, under the words.
  v.z = lerp(30, 19, t);
  v.y = lerp(2.4, -0.4, t);
  v.lookY = lerp(-0.2, 3.4, t);
  return v;
}

// MARK: Ticker

const outcomes = $$("[data-outcome]");

/** How much of a section is on screen, in pixels. */
const onScreen = (el: Element | null) => {
  if (!el) return 0;
  const r = el.getBoundingClientRect();
  return Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top));
};

let outcomesNear = false;
if (outcomes[0]) {
  new IntersectionObserver(([e]) => (outcomesNear = e!.isIntersecting), { rootMargin: "50% 0px" }).observe(
    outcomes[0].parentElement!,
  );
}

let lastLight: LightName | null = null;
let lastHeroP = -1;
gsap.ticker.add(() => {
  // Reads first, all of them, so no write below forces a layout in between.
  const h = onScreen(hero);
  const l = onScreen(lightSection);
  const f = onScreen(finale);
  const lit = outcomesNear
    ? outcomes.map((o) => {
        const r = o.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) return null;
        const d = Math.abs(r.top + r.height / 2 - innerHeight * 0.55) / (innerHeight * 0.42);
        return lerp(0.16, 1, 1 - smooth(0.15, 1, d)).toFixed(3);
      })
    : [];

  // Then writes.
  if (h > 0 && heroP !== lastHeroP) {
    playBeats(heroP);
    lastHeroP = heroP;
  }
  lit.forEach((v, i) => v && outcomes[i]!.style.setProperty("--lit", v));

  // The hero: frames, its loop at the very top, the flood to day at the end of the walk in.
  const heroLeads = h > 0 && h >= l && h >= f;
  document.documentElement.classList.toggle("hero-away", !heroLeads);
  if (heroLeads && heroFrames) {
    heroFrames.render(heroP);
    heroFrames.setResting(heroP < 0.004);
    const white = heroWhite(heroP);
    heroMedia!.style.setProperty("--flood", Math.min(1, white * 1.4).toFixed(3));
    heroMedia!.style.setProperty("--reach", (white * 160).toFixed(1));
  } else heroFrames?.setResting(false);

  if (!scene) return;
  scene.setActive(!heroLeads && l + f > 0);
  if (heroLeads || l + f === 0) return;

  let view: View;
  let light: LightName;
  if (l >= f) {
    view = lightView(lightP);
    light = stageLight;
  } else {
    view = finaleView(finaleP);
    light = "rest";
  }
  // Your drag turns the camera around the arch; it drifts back when you let go.
  if (!dragging) orbit.angle *= 0.94;
  if (Math.abs(orbit.angle) > 0.0005) {
    const dx = view.x - view.lookX;
    const c = Math.cos(orbit.angle);
    const sn = Math.sin(orbit.angle);
    const z = view.z;
    view.x = view.lookX + dx * c - z * sn;
    view.z = dx * sn + z * c;
  }
  Object.assign(scene.view, view);
  if (light !== lastLight) {
    scene.setLight(light, 1.1);
    lastLight = light;
  }
});

// MARK: Buttons

// The light pills lean toward the pointer a little.
if (finePointer && !reduced) {
  for (const b of $$(".button")) {
    b.addEventListener("pointermove", (e) => {
      const r = b.getBoundingClientRect();
      const x = (e.clientX - r.left - r.width / 2) / r.width;
      const y = (e.clientY - r.top - r.height / 2) / r.height;
      gsap.to(b, { x: x * 8, y: y * 6, duration: 0.4, ease: "power3.out" });
    });
    b.addEventListener("pointerleave", () => gsap.to(b, { x: 0, y: 0, duration: 0.7, ease: "elastic.out(1, 0.5)" }));
  }
}
