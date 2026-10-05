// The page's choreography. Lenis smooths the scroll; ScrollTrigger reports where each
// chapter is; one ticker turns that into the camera, the light, the island's steps and
// everything that draws or brightens on the way. Without this script every chapter still
// reads top to bottom, unpinned and fully shown.

import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import type { Color } from "three";
import type { ArchScene, LightName, View } from "./scene";
import { restView } from "./view";
import { createDawn, type Dawn } from "./dawn";
import { createIsland } from "./island";
import { createBoard } from "./board";

gsap.registerPlugin(ScrollTrigger);

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = matchMedia("(pointer: fine)").matches;
const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector<T>(s);
const $$ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => [
  ...root.querySelectorAll<T>(s),
];

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const inOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
/** 0 before a, up to 1 by b, held to c, back to 0 by d. */
const band = (p: number, a: number, b: number, c: number, d: number) => smooth(a, b, p) * (1 - smooth(c, d, p));

// MARK: Scroll

let lenis: Lenis | null = null;
if (!reduced) {
  lenis = new Lenis({ lerp: 0.09, wheelMultiplier: 0.95, touchMultiplier: 1.4 });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis!.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
  (window as unknown as { __lenis: Lenis }).__lenis = lenis;
}

for (const a of $$<HTMLAnchorElement>('a[href^="#"]')) {
  a.addEventListener("click", (e) => {
    const id = a.getAttribute("href")!;
    const target = id === "#top" ? document.body : $(id);
    if (!target) return;
    e.preventDefault();
    if (lenis) {
      // A long way off, cut to a screen short of it and glide the rest: gliding through every
      // chapter between would scrub the hero, the reel and the light all at once.
      // Chapters that open on a run of dusk land past it, on the stage (data-land="stage").
      const run = target.dataset.land === "stage" ? parseFloat(getComputedStyle(target).paddingTop) : 0;
      const to = target.getBoundingClientRect().top + lenis.scroll + run;
      const gap = to - lenis.scroll;
      if (Math.abs(gap) > innerHeight * 2) lenis.scrollTo(to - Math.sign(gap) * innerHeight, { immediate: true });
      lenis.scrollTo(to, { duration: 1.1, easing: (t) => 1 - (1 - t) ** 4 });
    } else target.scrollIntoView();
    history.replaceState(null, "", id);
  });
}

// The nav steps aside while you read down, and comes back when you scroll up.
let lastY = 0;
let lastScrollAt = 0;
const onScrollNav = (y: number) => {
  document.documentElement.classList.toggle("nav-hidden", y > lastY && y > 200);
  lastY = y;
  lastScrollAt = performance.now();
};
if (lenis) lenis.on("scroll", ({ scroll }: { scroll: number }) => onScrollNav(scroll));
else addEventListener("scroll", () => onScrollNav(scrollY), { passive: true });

// MARK: Scene

/** A CSS colour as sRGB components, through a canvas so oklch() resolves like the page's. */
function cssRGB(name: string): [number, number, number] {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const c = document.createElement("canvas").getContext("2d")!;
  c.fillStyle = value;
  c.fillRect(0, 0, 1, 1);
  const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
  return [r! / 255, g! / 255, b! / 255];
}

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
      else if (performance.now() - lastScrollAt < 450) setTimeout(check, 150);
      else idle(() => (urgent || performance.now() - lastScrollAt >= 450 ? resolve() : check()));
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
    const first = lightView(lightP);
    aside(first);
    Object.assign(s.view, first);
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
watchFor(["#notch", "#light", "#download"], "100% 0px", () => void loadScene());
watchFor(["#light", "#download"], "150% 0px", () => {
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
/** The pointer, -1 to 1, as the dawn follows it: eased toward `x`, `y`. */
const sunPointer = { x: 0, y: 0, ex: 0, ey: 0 };

if (finePointer && !reduced) {
  addEventListener("pointermove", (e) => {
    const x = (e.clientX / innerWidth) * 2 - 1;
    const y = (e.clientY / innerHeight) * 2 - 1;
    scene?.setPointer(x, y);
    board?.setPointer(x, y);
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

// MARK: Theme

// Light, dark, or whatever the system says; remembered. The new theme opens as a circle
// from the switch, and the hero's flood follows it.
const themeSwitch = $("[data-theme-switch]");
if (themeSwitch) {
  themeSwitch.hidden = false;
  const root = document.documentElement;
  const system = matchMedia("(prefers-color-scheme: dark)");
  const buttons = $$<HTMLButtonElement>("[data-theme-option]", themeSwitch);
  const resolve = (choice: string) => choice === "dark" || (choice === "system" && system.matches);
  const sync = () => {
    const choice = root.dataset.theme ?? "light";
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeOption === choice)));
    if (scene) scene.setDay(dayColor(cssRGB("--day")));
    dawn?.setDay(cssRGB("--day"));
  };
  const apply = (choice: string, from?: HTMLElement) => {
    const flip = () => {
      root.dataset.theme = choice;
      root.classList.toggle("theme-dark", resolve(choice));
      sync();
    };
    try {
      localStorage.setItem("bridgetown-theme", choice);
    } catch {
      // Private mode: the choice lasts for this visit.
    }
    if (resolve(choice) === root.classList.contains("theme-dark") || reduced || !document.startViewTransition || !from) {
      flip();
      return;
    }
    const r = from.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    document.startViewTransition(flip).ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 900, easing: "cubic-bezier(0.65, 0, 0.35, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    });
  };
  buttons.forEach((b) => b.addEventListener("click", () => apply(b.dataset.themeOption!, b)));
  system.addEventListener("change", () => {
    if (root.dataset.theme === "system") apply("system");
  });
  sync();
}

// MARK: Hero

const hero = $("[data-hero]")!;
const heroIntro = $("[data-hero-intro]", hero);
const caption = $("[data-hero-caption]", hero);
let heroP = 0;
ScrollTrigger.create({
  trigger: hero,
  start: "top top",
  end: "bottom bottom",
  onUpdate: (s) => (heroP = s.progress),
});

// The board, live while you can see it. Measured once per layout, never while scrolling.
const boardWrap = $("[data-board-wrap]", hero);
const boardEl = $("[data-board]", hero);
const board = boardEl ? createBoard(boardEl, { reducedMotion: reduced }) : null;
let boardW = 0;
let boardH = 0;
const measureBoard = () => {
  if (!boardWrap) return;
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
  const peek = innerHeight * 0.36 + boardH / 2;
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

// MARK: Recording

// The clip grows from between the two halves of its line to fill the screen, and plays
// only while you can see it.
const recording = $("[data-recording]");
if (recording) {
  const video = $<HTMLVideoElement>("[data-clip-video]", recording)!;
  const toggle = $<HTMLButtonElement>("[data-clip-toggle]", recording)!;
  let userPaused = reduced;
  const setPaused = (paused: boolean) => {
    toggle.classList.toggle("paused", paused);
    toggle.setAttribute("aria-label", paused ? "Play the recording" : "Pause the recording");
  };
  setPaused(userPaused);
  toggle.addEventListener("click", () => {
    userPaused = !video.paused;
    if (userPaused) video.pause();
    else void video.play();
    setPaused(userPaused);
  });
  new IntersectionObserver(
    ([e]) => {
      if (e!.isIntersecting && !userPaused) void video.play().catch(() => setPaused(true));
      else video.pause();
    },
    { threshold: 0.25 },
  ).observe(video);

  if (!reduced) {
    // In screens of scroll since the pin took hold: the first stretch lies over the hero's
    // walk into the light, and the screen develops out of it; then the clip grows.
    const play = (d: number) => {
      recording.style.setProperty("--enter", smooth(0.05, 0.65, d).toFixed(3));
      recording.style.setProperty("--grow", lerp(0.34, 1, inOut(clamp((d - 0.75) / 1.15))).toFixed(4));
      recording.style.setProperty("--out", smooth(0.95, 1.45, d).toFixed(3));
      recording.style.setProperty("--caption", smooth(1.65, 2.05, d).toFixed(3));
    };
    play(0);
    ScrollTrigger.create({
      trigger: recording,
      start: "top top",
      end: "bottom bottom",
      onUpdate: (s) => play((s.progress * (recording.offsetHeight - innerHeight)) / innerHeight),
    });
  } else {
    // The clip at full size; the line's halves would only stand cut off at its sides. It still
    // fades in out of the light, or it would stand over the hero's board.
    recording.style.setProperty("--grow", "1");
    recording.style.setProperty("--out", "1");
    recording.style.setProperty("--caption", "1");
    recording.style.setProperty("--enter", "0");
    ScrollTrigger.create({
      trigger: recording,
      start: "top top",
      end: "bottom bottom",
      onUpdate: (s) =>
        recording.style.setProperty(
          "--enter",
          smooth(0.05, 0.65, (s.progress * (recording.offsetHeight - innerHeight)) / innerHeight).toFixed(3),
        ),
    });
  }
}

// MARK: Film

const film = $<HTMLDialogElement>("[data-film]");
if (film) {
  const video = $<HTMLVideoElement>("[data-film-video]", film)!;
  for (const b of $$("[data-open-film]")) {
    b.addEventListener("click", () => {
      const name = b.dataset.openFilm || "launch";
      if (video.dataset.film !== name) {
        video.dataset.film = name;
        video.poster = `/media/${name}-poster.jpg`;
        video.src = `/media/${name}.mp4`;
      }
      film.showModal();
      lenis?.stop();
      void video.play().catch(() => {});
    });
  }
  film.addEventListener("close", () => {
    video.pause();
    lenis?.start();
  });
  // A click on the backdrop closes it.
  film.addEventListener("click", (e) => {
    if (e.target === film) film.close();
  });
}

// MARK: Notch

const notch = $("[data-notch]");
if (notch) {
  const island = createIsland(notch, { reducedMotion: reduced });
  const tryIt = $("[data-try]", notch);
  if (tryIt) tryIt.hidden = false;
  const steps = $$("[data-step]", notch);
  const cuts = [0, 0.22, 0.46, 0.7, 1];
  ScrollTrigger.create({
    trigger: notch,
    start: "top 60%",
    // The last screen of the pin is the next chapter sliding over it.
    end: () => `bottom-=${innerHeight} bottom`,
    onToggle: (s) => island.setVisible(s.isActive),
    onUpdate: (s) => {
      // Pinning starts at "top top"; the first stretch before it is the approach.
      const pinStart = innerHeight * 0.6;
      const total = notch.offsetHeight - 2 * innerHeight + pinStart;
      const p = clamp((s.progress * total - pinStart) / (total - pinStart));
      const step = cuts.findIndex((c, i) => p >= c && p < (cuts[i + 1] ?? 2));
      island.setStep(Math.max(0, step));
      steps.forEach((el, i) => el.style.setProperty("--fill", clamp((p - cuts[i]!) / (cuts[i + 1]! - cuts[i]!)).toFixed(3)));
    },
  });
  island.setVisible(true);

  // The machine rises into place as the day arrives.
  if (!reduced) {
    gsap.fromTo(
      $("[data-mac]", notch),
      { y: 120, scale: 0.9, rotateX: 22, transformPerspective: 1400, transformOrigin: "50% 0%", opacity: 0.4 },
      {
        y: 0,
        scale: 1,
        rotateX: 0,
        opacity: 1,
        ease: "none",
        scrollTrigger: { trigger: notch, start: "top bottom", end: "top top", scrub: true },
      },
    );
  }
}

// MARK: Reveals

/** Adds `.in` once an element is well into view; `stagger` spaces siblings out. */
function revealOnView(els: HTMLElement[], { threshold = 0.35, stagger = 90 } = {}) {
  const io = new IntersectionObserver(
    (entries) => {
      const arriving = entries.filter((e) => e.isIntersecting);
      arriving.forEach((e, i) => {
        const el = e.target as HTMLElement;
        el.style.transitionDelay = reduced ? "" : `${i * stagger}ms`;
        el.classList.add("in");
        io.unobserve(el);
      });
    },
    { threshold },
  );
  els.forEach((el) => io.observe(el));
}

revealOnView($$("[data-row]"), { threshold: 0.5, stagger: 160 });
revealOnView($$("[data-rule]"), { threshold: 0.6, stagger: 80 });

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

// MARK: Policy

// The threshold re-routes the messages, as the app's policy does with the one you set.
const policy = $("[data-policy]");
if (policy) {
  const input = $<HTMLInputElement>("[data-threshold]", policy)!;
  const out = $("[data-threshold-out]", policy)!;
  const rows = $$("[data-row]");
  const decide = (row: HTMLElement, t: number): [string, string] | null => {
    const agent = Number(row.dataset.agent);
    const other = Number(row.dataset.other);
    if (row.dataset.kind === "alert") {
      if (other >= 50) return null;
      return agent >= t ? ["Agent starts", "blue"] : ["Suggested to you", "amber"];
    }
    if (row.dataset.kind === "inbox") return agent >= t ? ["Agent drafts, you send", "blue"] : ["Needs you", "amber"];
    return null;
  };
  const apply = (animate: boolean) => {
    const t = Number(input.value);
    out.textContent = `${t}%`;
    input.style.setProperty("--fill", `${((t - 50) / 45) * 100}%`);
    for (const row of rows) {
      row.style.setProperty("--threshold", `${t}%`);
      const next = decide(row, t);
      if (!next) continue;
      const route = $("[data-route]", row)!;
      const label = $("span", route)!;
      const dot = $(".dot", route)!;
      if (label.textContent === next[0]) continue;
      label.textContent = next[0];
      dot.className = `dot dot-${next[1]}`;
      if (animate && !reduced) {
        label.animate(
          [
            { opacity: 0, transform: "translateY(40%)", filter: "blur(4px)" },
            { opacity: 1, transform: "none", filter: "blur(0)" },
          ],
          { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
        dot.animate([{ transform: "scale(0)" }, { transform: "scale(1.5)" }, { transform: "none" }], { duration: 500 });
      }
    }
  };
  input.addEventListener("input", () => apply(true));
  apply(false);
}

// MARK: Journey

const journey = $("[data-journey]");
const wide = matchMedia("(min-width: 981px)");
if (journey) {
  const pin = $("[data-journey-pin]", journey)!;
  const track = $("[data-track]", journey)!;
  const frames = $$(".frame", track);
  const rail = $$("[data-rail]", journey);
  const panels = frames.map((f) => f.querySelector<HTMLElement>(".panel"));
  let distance = 0;
  /** Each frame's centre on the untranslated track, measured once per layout, never while scrolling. */
  let centers: number[] = [];

  const layout = () => {
    if (!wide.matches) {
      journey.style.height = "";
      pin.style.position = "";
      track.style.transform = "";
      panels.forEach((p) => p && (p.style.transform = ""));
      return;
    }
    distance = Math.max(0, track.scrollWidth - innerWidth);
    journey.style.height = `${distance + innerHeight}px`;
    pin.style.position = "sticky";
    pin.style.top = "0";
    const shift = track.getBoundingClientRect().left - (track.style.transform ? lastShift : 0);
    centers = frames.map((f) => shift + f.offsetLeft + f.offsetWidth / 2);
  };
  let lastShift = 0;
  layout();
  // Before every measure (load, late fonts, resize), so the reel's length is never stale.
  ScrollTrigger.addEventListener("refreshInit", layout);

  const played = new Set<Element>();
  const play = (frame: Element) => {
    if (played.has(frame)) return;
    played.add(frame);
    frame.classList.add("played");
  };

  ScrollTrigger.create({
    trigger: journey,
    start: "top top",
    end: "bottom bottom",
    onUpdate: (s) => {
      if (!wide.matches) return;
      lastShift = -s.progress * distance;
      track.style.transform = `translate3d(${lastShift.toFixed(1)}px,0,0)`;
      const mid = innerWidth / 2;
      let nearest = 0;
      let best = Infinity;
      frames.forEach((f, i) => {
        const d = ((centers[i] ?? 0) + lastShift - mid) / innerWidth;
        if (Math.abs(d) < best) {
          best = Math.abs(d);
          nearest = i;
        }
        // Depth: frames turn slightly away as they leave the middle, their panels lagging behind.
        const panel = panels[i];
        if (panel && !reduced) {
          panel.style.transform = `perspective(1600px) translateX(${(d * -60).toFixed(1)}px) rotateY(${(d * -14).toFixed(2)}deg)`;
        }
        if (d < 0.3) play(f);
      });
      rail.forEach((r, i) => r.classList.toggle("done", i <= nearest));
    },
  });

  // Narrow screens: each frame plays as it scrolls into view.
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && !wide.matches && play(e.target)),
    { threshold: 0.4 },
  );
  frames.forEach((f) => io.observe(f));
}

// MARK: Light

const lightSection = $("[data-light]");
let lightP = 0;
const LIGHT_ORDER: LightName[] = ["rest", "working", "needs-you", "paused"];
let pickedLight: LightName | null = null;
let pickedAt = -1;
if (lightSection) {
  const items = $$("[data-light-state]", lightSection);
  const mark = (name: LightName) =>
    items.forEach((el) => {
      const on = el.dataset.lightState === name;
      el.classList.toggle("on", on);
      el.querySelector("button")?.setAttribute("aria-pressed", String(on));
    });
  // A picked light holds until scrolling moves on to the next state.
  for (const b of $$<HTMLButtonElement>("[data-light-pick]", lightSection)) {
    b.addEventListener("click", () => {
      pickedLight = b.dataset.lightPick as LightName;
      pickedAt = Math.min(LIGHT_ORDER.length - 1, Math.floor(lightP * LIGHT_ORDER.length));
      mark(pickedLight);
    });
  }
  // The section runs up and down through 70svh of dusk either side of its pinned stage.
  ScrollTrigger.create({
    trigger: lightSection,
    start: () => `top+=${innerHeight * 0.7} top`,
    end: () => `bottom-=${innerHeight * 0.7} bottom`,
    onUpdate: (s) => {
      lightP = s.progress;
      const i = Math.min(LIGHT_ORDER.length - 1, Math.floor(s.progress * LIGHT_ORDER.length));
      if (pickedLight && i !== pickedAt) pickedLight = null;
      mark(pickedLight ?? LIGHT_ORDER[i]!);
    },
  });
}

function lightView(p: number): View {
  const v = restView();
  // A phone stands back and looks up a little, so the arch sits under the words, not on them.
  const tall = 1 - smooth(0.6, 0.9, innerWidth / innerHeight);
  const a = lerp(-0.42, 0.42, inOut(p));
  const r = lerp(15.5, 12.5, inOut(p)) * (1 + 0.14 * tall);
  v.x = Math.sin(a) * r;
  v.z = Math.cos(a) * r;
  v.y = -1.2;
  v.lookY = 0.45 + 1.3 * tall;
  return v;
}

/**
 * Wide screens keep the arch to the right of the words, wherever the camera has walked: the
 * camera and its target slide left of the shot by a share of the distance between them.
 */
function aside(v: View) {
  const fx = v.lookX - v.x;
  const fz = v.lookZ - v.z;
  const n = Math.hypot(fx, fz) || 1;
  const d = n * 0.17 * smooth(1.1, 1.45, innerWidth / innerHeight);
  if (d <= 0) return;
  // The camera's right, on the ground.
  const rx = -fz / n;
  const rz = fx / n;
  v.x -= rx * d;
  v.z -= rz * d;
  v.lookX -= rx * d;
  v.lookZ -= rz * d;
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
  const button = $("button", finale);
  const wake = (on: boolean) => scene?.setLight(on ? "working" : "rest", on ? 0.5 : 1.2);
  button?.addEventListener("pointerenter", () => wake(true));
  button?.addEventListener("pointerleave", () => wake(false));
  button?.addEventListener("focus", () => wake(true));
  button?.addEventListener("blur", () => wake(false));
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

// MARK: Outcomes and watch

const outcomes = $$("[data-outcome]");
const watch = $("[data-watch]");
const line = watch ? $<SVGPathElement>("[data-line]", watch) : null;
if (watch && line) {
  const plot = $("[data-chart] .plot", watch)!;
  const width = line.ownerSVGElement!.viewBox.baseVal.width;
  ScrollTrigger.create({
    trigger: $("[data-chart]", watch),
    start: "top 85%",
    end: "center 45%",
    onUpdate: (s) => {
      plot.style.setProperty("--draw", (1 - s.progress).toFixed(4));
      // How far across the pen is, for the shade beneath it.
      const at = line.getPointAtLength(s.progress * line.getTotalLength());
      plot.style.setProperty("--reach", (at.x / width).toFixed(4));
      if (s.progress > 0.985) watch.classList.add("risen");
      else if (s.progress < 0.9) watch.classList.remove("risen");
    },
  });
}

// MARK: Chapters

// The day's tone: every day chapter takes the same one at once, the share of the sunk tone
// within a screen around the middle of the view, so a change of tone is a slow turn of the
// light rather than an edge. Sections are measured on refresh, never while scrolling.
const toned = $$("main > .day").filter((s) => !s.hasAttribute("data-recording"));
let sunk: [number, number][] = [];
let lastTone = -1;

// Chapters that slide in over the one before; what they cover sinks back as they come.
const sheets = $$("[data-sheet]").map((sheet) => ({
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
    const bg = tone <= 0 ? "" : `color-mix(in oklch, var(--day), var(--day-sunk) ${tone}%)`;
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
let lastIntro = -1;
let dawnTime = 9;
let dawnShown = false;
gsap.ticker.add(() => {
  // Reads first, all of them, so no write below forces a layout in between.
  const h = onScreen(hero);
  const l = onScreen(lightSection);
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
  const heroLeads = h > 0 && h >= l && h >= f;
  document.documentElement.classList.toggle("hero-away", !heroLeads);
  if (heroLeads) {
    const dt = Math.min(0.05, gsap.ticker.deltaRatio(60) / 60);
    const flood = smooth(0.66, 0.9, heroP);
    if (dawn) {
      if (!reduced) dawnTime += dt;
      // Without a mouse, the sun wanders along the edge on its own.
      if (!finePointer && !reduced) sunPointer.x = Math.sin(dawnTime * 0.11) * 0.45;
      const k = 1 - Math.exp(-dt * 2.4);
      sunPointer.ex += (sunPointer.x - sunPointer.ex) * k;
      sunPointer.ey += (sunPointer.y - sunPointer.ey) * k;
      const w = boardW * boardS;
      const bh = boardH * boardS;
      dawn.render({
        time: dawnTime,
        scroll: heroP,
        intro: intro.dawn,
        flood,
        pointer: [sunPointer.ex, sunPointer.ey],
        board: boardOn > 0.01 ? new DOMRect((innerWidth - w) / 2, (innerHeight - bh) / 2 + boardY, w, bh) : null,
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
    if (board && boardOn > 0.05) board.tick(dt);
  }

  if (!scene) return;
  scene.setActive(!heroLeads && l + f > 0);
  if (heroLeads || l + f === 0) return;

  let view: View;
  let light: LightName;
  if (l >= f) {
    view = lightView(lightP);
    light = pickedLight ?? LIGHT_ORDER[Math.min(LIGHT_ORDER.length - 1, Math.floor(lightP * LIGHT_ORDER.length))]!;
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
  if (l >= f) aside(view);
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
    b.addEventListener("pointerleave", () => gsap.to(b, { x: 0, y: 0, duration: 0.9, ease: "expo.out" }));
  }
}

// MARK: Download

// The light comes to rest as the download starts, the way it does when a session is done.
for (const link of $$<HTMLAnchorElement>("[data-download]")) {
  link.addEventListener("click", () => scene?.setLight("rest", 0.4));
}
