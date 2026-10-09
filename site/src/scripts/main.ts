// The page's choreography: what moves with more than one chapter. ScrollTrigger reports where
// each chapter is; one ticker turns that into the hero's dawn and board, the camera, the light,
// the day's tone, the chapters sliding over one another and the outcomes brightening on the
// way. Widgets that keep to their own chapter run from their component (Nav, Recording, Notch,
// Triage, Watch, Safety, Film). Without script every chapter still reads top to bottom,
// unpinned and fully shown.

import { gsap } from "gsap";
import type { Color } from "three";
import { $, $$, cssRGB } from "../lib/dom";
import { band, clamp, inOut, lerp, smooth } from "../lib/math";
import { createDawn, type Dawn } from "./dawn";
import { createReel } from "./reel";
import type { ArchScene } from "./scene";
import { finePointer, phone, reduced, ScrollTrigger, sinceScroll } from "./scroll";
import { restView, type View } from "./view";

// MARK: Scene

// The hero draws its own dawn; the live scene (and three.js, in its own chunk) is only needed
// for the closing chapter. Setting it up costs the main thread real time
// (parsing, the environment map, shader compiles), so it happens in steps, each one in a moment
// when you have stopped scrolling, well before that chapter; only if you get close first
// does it stop waiting.
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
    const first = finaleView(finaleP);
    Object.assign(s.view, first);
    s.snap();
    s.setActive(false);
    scene = s;
    await s.prepare(atRest);
  } catch {
    // No WebGL: the closing chapter keeps the plain night behind it.
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
// Start once you are into the page; insist once a night chapter is a screen or so away. A
// phone's page is shorter, and the work would stall the notch's tour as it plays: it starts a
// few chapters before the arch instead.
watchFor(phone ? ["#safety", "#download"] : ["#notch", "#download"], "100% 0px", () => void loadScene());
watchFor(["#download"], "150% 0px", () => {
  urgent = true;
  void loadScene();
});

// The hero's dawn, one shader. Without WebGL the still glow behind it stays.
const heroMedia = $("[data-hero-media]");
let dawn: Dawn | null = null;
try {
  const c = $<HTMLCanvasElement>("[data-dawn]");
  dawn = c ? createDawn(c) : null;
} catch {
  dawn = null;
}
dawn?.setDay(cssRGB("--day"));
/** The pointer, -1 to 1, as the dawn and the board follow it: eased toward `x`, `y`. */
const sunPointer = { x: 0, y: 0, ex: 0, ey: 0 };

// The theme switch (Nav) changed what day is: the arch's flood and the dawn follow.
addEventListener("themechange", () => {
  if (scene) scene.setDay(dayColor(cssRGB("--day")));
  dawn?.setDay(cssRGB("--day"));
});

if (finePointer && !reduced) {
  addEventListener("pointermove", (e) => {
    const x = (e.clientX / innerWidth) * 2 - 1;
    const y = (e.clientY / innerHeight) * 2 - 1;
    scene?.setPointer(x, y);
    sunPointer.x = x;
    sunPointer.y = y;
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
const heroIntro = $("[data-hero-intro]", hero);
const caption = $("[data-hero-caption]", hero);
let heroP = 0;
ScrollTrigger.create({
  trigger: hero,
  start: "top top",
  // A phone's hero isn't pinned: it scrolls by, all of it.
  end: phone ? "bottom top" : "bottom bottom",
  onUpdate: (s) => (heroP = s.progress),
});

// The board: the app, open. Measured once per layout, never while scrolling.
const boardWrap = $("[data-board-wrap]", hero);
const boardTilt = finePointer && !reduced ? $("[data-board-tilt]", hero) : null;
let boardW = 0;
let boardH = 0;
/** How far below the middle the board's top edge waits, in screens (Hero.astro's --peek). */
let peekAt = 0.36;
const measureBoard = () => {
  if (!boardWrap) return;
  peekAt = parseFloat(getComputedStyle(hero).getPropertyValue("--peek")) || peekAt;
  boardW = boardWrap.offsetWidth;
  boardH = boardWrap.offsetHeight;
  hero.style.setProperty("--board-h", `${boardH}px`);
};
measureBoard();
ScrollTrigger.addEventListener("refreshInit", measureBoard);

// On arrival the dawn comes up, the headline rises word by word out of its own line, the
// rest follows, and the board's top edge rises into view at the foot of the screen.
const title = $("[data-split]", hero);
const intro = { t: reduced ? 1 : 0, dawn: reduced ? 1 : 0 };
if (!reduced) {
  if (title) {
    title.innerHTML = title.innerHTML
      .split(/(\s+)/)
      .map((w) => (/^\s+$/.test(w) ? w : `<span class="w"><span class="wi">${w}</span></span>`))
      .join("");
  }
  const tl = gsap.timeline({ delay: 0.2 });
  tl.to(intro, { dawn: 1, duration: 3.2, ease: "power2.out" }, 0);
  if (title) {
    tl.from($$(".wi", title), { yPercent: 112, rotate: 5, duration: 1.4, ease: "expo.out", stagger: 0.07 }, 0.35);
  }
  tl.from(
    $$("[data-rise]", hero),
    { y: 18, opacity: 0, duration: 1.2, ease: "expo.out", stagger: 0.11, clearProps: "transform,opacity" },
    0.85,
  );
  tl.to(intro, { t: 1, duration: 1.8, ease: "expo.out" }, 1.3);
}

/** How present the board is, for the light behind it, and where it is. */
let boardOn = 0;
let boardY = 0;
let boardS = 1;

function playHero(p: number) {
  // A phone's board stands where the page puts it, under the words, and rises into place as
  // they arrive; it is as present as the dawn behind it.
  if (phone) {
    boardOn = intro.t;
    if (boardWrap) {
      boardWrap.style.opacity = intro.t.toFixed(3);
      boardWrap.style.transform = intro.t < 1 ? `translate3d(0,${((1 - intro.t) * 48).toFixed(1)}px,0)` : "";
    }
    return;
  }
  // The words lift away first.
  const out = smooth(0.02, 0.2, p);
  if (heroIntro) {
    heroIntro.style.opacity = (1 - out).toFixed(3);
    heroIntro.style.visibility = out > 0.99 ? "hidden" : "visible";
    heroIntro.style.transform = `translate3d(0,${(-out * 70).toFixed(1)}px,0) scale(${(1 - out * 0.05).toFixed(4)})`;
  }
  // The board waits at the foot of the screen, rises to the middle, holds, and goes.
  const rise = inOut(clamp(p / 0.3));
  const leave = smooth(0.6, 0.76, p);
  const peek = innerHeight * peekAt + boardH / 2;
  boardY = lerp(peek, 0, rise) + (1 - intro.t) * innerHeight * 0.12 - leave * 50;
  boardS = lerp(0.9, 1, rise) * (1 - leave * 0.06);
  boardOn = intro.t * (1 - leave);
  if (boardWrap) {
    boardWrap.style.opacity = boardOn.toFixed(3);
    boardWrap.style.visibility = boardOn < 0.01 ? "hidden" : "visible";
    boardWrap.style.transform = `translate3d(0,${boardY.toFixed(1)}px,0) scale(${boardS.toFixed(4)})`;
  }
  if (caption) {
    const v = band(p, 0.26, 0.34, 0.54, 0.62);
    caption.style.opacity = v.toFixed(3);
    caption.style.visibility = v < 0.01 ? "hidden" : "visible";
    caption.style.transform = `translate3d(0,${((1 - v) * (p > 0.44 ? -16 : 16)).toFixed(1)}px,0)`;
  }
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
// frames, each playing as it scrolls into view. A phone swipes through them instead, the
// rail above marking which one it's on.
const journey = $("[data-journey]");
if (journey) {
  const pin = $("[data-journey-pin]", journey)!;
  const reel = createReel(journey, { tilt: !reduced });
  let sideways = false;
  const layout = () => {
    // A phone's frames are in a row too, but it swipes them: nothing pinned.
    sideways = reel.sideways && !phone;
    if (!sideways) {
      journey.style.height = "";
      pin.style.position = "";
      pin.style.top = "";
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

  if (phone) {
    const viewport = $("[data-journey-viewport]", journey)!;
    const frames = $$(".frame", journey);
    const rail = $$("[data-rail]", journey);
    viewport.tabIndex = 0;
    viewport.setAttribute("role", "group");
    viewport.setAttribute("aria-label", "The path, one step at a time: swipe or scroll sideways");
    let on = -1;
    const mark = () => {
      const left = viewport.getBoundingClientRect().left;
      // The frame whose leading edge is nearest the gutter it snaps to.
      const now = frames.reduce(
        (best, f, i) =>
          Math.abs(f.getBoundingClientRect().left - left) < Math.abs(frames[best]!.getBoundingClientRect().left - left) ? i : best,
        0,
      );
      if (now === on) return;
      on = now;
      rail.forEach((r, i) => r.classList.toggle("done", i <= now));
    };
    viewport.addEventListener("scroll", mark, { passive: true });
    mark();
  }
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

  // The light answers the button: blue lamps come on while your pointer is on it.
  const button = $("[data-download]", finale);
  const wake = (on: boolean) => scene?.setLight(on ? "working" : "rest", on ? 0.5 : 1.2);
  button?.addEventListener("pointerenter", () => wake(true));
  button?.addEventListener("pointerleave", () => wake(false));
  button?.addEventListener("focus", () => wake(true));
  button?.addEventListener("blur", () => wake(false));
}

// The light comes to rest as a download starts (Hero, Nav, Finale), the way it does when a
// session is done.
for (const link of $$("[data-download]")) {
  link.addEventListener("click", () => scene?.setLight("rest", 0.4));
}

// A phone can't run Bridgetown: its download buttons send this page to your Mac instead, by the
// share sheet (AirDrop, Messages, Mail), or copy its link where there is none. Dismissing the
// sheet does nothing.
if (phone) {
  const page = new URL("/", location.href).href;
  for (const link of $$("[data-download]")) {
    let copied = 0;
    link.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        if (navigator.share) {
          await navigator.share({ title: "Bridgetown for macOS", text: "Bridgetown, for my Mac", url: page });
          return;
        }
        await navigator.clipboard.writeText(page);
        link.classList.add("copied");
        clearTimeout(copied);
        copied = window.setTimeout(() => link.classList.remove("copied"), 2400);
      } catch {
        // The sheet was dismissed, or the clipboard refused: the button stays as it was.
      }
    });
  }
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

// MARK: Chapters

// The day's tone: every day chapter takes the same one at once, the share of the sunk tone
// within a screen around the middle of the view, so a change of tone is a slow turn of the
// light rather than an edge. Sections are measured on refresh, never while scrolling.
const toned = $$("main > .day").filter((s) => !s.hasAttribute("data-recording"));
let sunk: [number, number][] = [];
let lastTone = -1;

// Chapters that slide in over the one before; what they cover sinks back as they come. On a
// phone nothing is pinned for one to slide over.
const sheets = (phone ? [] : $$("[data-sheet]")).map((sheet) => ({
  sheet,
  under: sheet.previousElementSibling?.querySelector<HTMLElement>(".pin") ?? null,
  r: 0,
  last: -1,
}));

// The nav marks the chapter you're in with a line that glides from one link to the next.
const navMark = $("[data-nav-mark]");
const navLinks = $$<HTMLAnchorElement>("[data-nav] nav a");
/** Every chapter's span, and its link if it has one. Chapters overlap where one slides over another. */
let chapters: { link: HTMLAnchorElement | null; top: number; bottom: number }[] = [];
let lastChapter: HTMLAnchorElement | null | undefined;

const measureChapters = () => {
  const y = scrollY;
  const range = (el: Element) => {
    const r = el.getBoundingClientRect();
    return [r.top + y, r.bottom + y] as [number, number];
  };
  sunk = $$('main > [data-tone="sunk"]').map(range);
  chapters = $$("main > section").map((section) => {
    const [top, bottom] = range(section);
    return { link: navLinks.find((a) => a.getAttribute("href") === `#${section.id}`) ?? null, top, bottom };
  });
  lastTone = -1;
  lastChapter = undefined;
};
measureChapters();
ScrollTrigger.addEventListener("refresh", measureChapters);

function playChapters() {
  const c = scrollY + innerHeight / 2;
  const w = innerHeight * 0.45;
  let share = 0;
  for (const [a, b] of sunk) share += Math.max(0, Math.min(b, c + w) - Math.max(a, c - w));
  const tone = Math.round(smooth(0, 1, share / (2 * w)) * 1000) / 10;
  if (tone !== lastTone) {
    lastTone = tone;
    // At 0 too: a sunk chapter just off the middle, at the screen's edge, is day like the rest.
    const bg = `color-mix(in oklch, var(--day), var(--day-sunk) ${tone}%)`;
    for (const s of toned) s.style.backgroundColor = bg;
  }

  for (const s of sheets) {
    if (!s.under || s.r === s.last) continue;
    s.last = s.r;
    const r = s.r;
    // It drifts up at a sixth of the sheet's pace, shrinks a little, and is gone by halfway.
    s.under.style.transform = r > 0 ? `translate3d(0,${(-r * 16).toFixed(2)}svh,0) scale(${(1 - r * 0.06).toFixed(4)})` : "";
    s.under.style.opacity = r > 0 ? (1 - smooth(0.05, 0.6, r)).toFixed(3) : "";
  }

  if (navMark) {
    // The one on top: the last that spans the middle of the view.
    const now = chapters.findLast((ch) => c >= ch.top && c < ch.bottom)?.link ?? null;
    if (now !== lastChapter) {
      lastChapter = now;
      navLinks.forEach((a) => (a === now ? a.setAttribute("aria-current", "location") : a.removeAttribute("aria-current")));
      if (now) navMark.style.transform = `translateX(${now.offsetLeft}px) scaleX(${now.offsetWidth})`;
      navMark.classList.toggle("on", !!now);
    }
  }
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

let lastHeroP = -1;
let lastIntro = -1;
let dawnTime = 9;
let dawnShown = false;
gsap.ticker.add(() => {
  // Reads first, all of them, so no write below forces a layout in between.
  const h = onScreen(hero);
  // A phone's board, where it scrolls to, and the hero's foot, which day floods the frame ahead of.
  const phoneBoard = phone && h > 0 && boardWrap ? boardWrap.getBoundingClientRect() : null;
  const heroFoot = phone && h > 0 ? hero.getBoundingClientRect().bottom : 0;
  const f = onScreen(finale);
  if (!reduced) for (const s of sheets) s.r = clamp(1 - s.sheet.getBoundingClientRect().top / innerHeight);
  const lit = outcomesNear
    ? outcomes.map((o) => {
        const r = o.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) return null;
        const d = Math.abs(r.top + r.height / 2 - innerHeight * 0.55) / (innerHeight * 0.42);
        return lerp(0.16, 1, 1 - smooth(0.15, 1, d)).toFixed(3);
      })
    : [];

  // Then writes.
  if (h > 0 && (heroP !== lastHeroP || intro.t !== lastIntro)) {
    playHero(heroP);
    lastHeroP = heroP;
    lastIntro = intro.t;
  }
  lit.forEach((v, i) => v && outcomes[i]!.style.setProperty("--lit", v));
  playChapters();

  // The hero: the dawn, and at the end of it the flood to day.
  const heroLeads = h > 0 && h >= f;
  document.documentElement.classList.toggle("hero-away", !heroLeads);
  if (heroLeads) {
    const dt = Math.min(0.05, gsap.ticker.deltaRatio(60) / 60);
    // On a phone, day has filled the frame by the time the next chapter's edge is a third of
    // the way up it, so the edge never shows.
    const flood = phone ? smooth(innerHeight * 1.05, innerHeight * 0.35, heroFoot) : smooth(0.66, 0.9, heroP);
    if (!reduced) dawnTime += dt;
    // Without a mouse, the sun wanders along the edge on its own.
    if (!finePointer && !reduced) sunPointer.x = Math.sin(dawnTime * 0.11) * 0.45;
    const k = 1 - Math.exp(-dt * 2.4);
    sunPointer.ex += (sunPointer.x - sunPointer.ex) * k;
    sunPointer.ey += (sunPointer.y - sunPointer.ey) * k;
    if (dawn) {
      const w = boardW * boardS;
      const bh = boardH * boardS;
      dawn.render({
        time: dawnTime,
        // A phone's dawn breaks lower, where the board's top edge peeks (93% down rather than
        // 86%), so none of the words stand in its glare; it rises past as you scroll.
        scroll: phone ? heroP - 0.45 : heroP,
        intro: intro.dawn,
        flood,
        pointer: [sunPointer.ex, sunPointer.ey],
        board:
          boardOn <= 0.01 ? null : (phoneBoard ?? new DOMRect((innerWidth - w) / 2, (innerHeight - bh) / 2 + boardY, w, bh)),
        boardOn,
      });
      if (!dawnShown) {
        dawnShown = true;
        document.documentElement.classList.add("dawn-ready");
      }
    } else {
      heroMedia?.style.setProperty("--flood", flood.toFixed(3));
      heroMedia?.style.setProperty("--reach", (flood * 160).toFixed(1));
    }
    // The board leans a little toward the pointer, with the sun.
    if (boardTilt && boardOn > 0.05) {
      boardTilt.style.transform = `perspective(1600px) rotateX(${(-sunPointer.ey * 2.2).toFixed(3)}deg) rotateY(${(sunPointer.ex * 3.2).toFixed(3)}deg)`;
    }
  }

  if (!scene) return;
  scene.setActive(!heroLeads && f > 0);
  if (heroLeads || f === 0) return;

  const view = finaleView(finaleP);
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
    b.addEventListener("pointerleave", () => gsap.to(b, { x: 0, y: 0, duration: 0.9, ease: "expo.out" }));
  }
}
