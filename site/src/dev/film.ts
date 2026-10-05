// The film rig's director. Plays the keynote (or the short island recording) once, in real
// time, from the site's own scene and components, and reports when it is done so the
// recorder can stop. Cuts: keynote (the film), launch (30 seconds), island (the short
// recording).

import { gsap } from "gsap";
import * as THREE from "three";
import { createArchScene, type LightName } from "../scripts/scene";
import { createIsland } from "../scripts/island";
import { restView, type View } from "../scripts/view";
import "./rig";

const cut = new URLSearchParams(location.search).get("cut") ?? "keynote";
document.documentElement.classList.add(`cut-${cut}`);
const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector<T>(s)!;
const $$ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => [...root.querySelectorAll<T>(s)];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// MARK: Pieces

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
const islandRoot = $("[data-island-root]");
const island = createIsland(islandRoot, { reducedMotion: false });
island.setVisible(true);

const cards = Object.fromEntries($$("[data-card]").map((el) => [el.dataset.card!, el]));
const flood = $("[data-flood]");

/** Brings a card in out of a blur, or sends it off. */
function show(name: string, on: boolean, tl: gsap.core.Timeline, at: number, dur = 0.9) {
  const el = cards[name]!;
  tl.to(
    el,
    on
      ? { autoAlpha: 1, filter: "blur(0px)", scale: 1, duration: dur, ease: "expo.out" }
      : { autoAlpha: 0, filter: "blur(14px)", scale: 1.03, duration: dur * 0.7, ease: "power2.in" },
    at,
  );
  if (on) tl.set(el, { filter: "blur(14px)", scale: 0.98 }, at - 0.001);
}

/** The camera, as a tweenable view. */
const cam: View = restView();
const pushView = () => {
  Object.assign(scene.view, cam);
};
gsap.ticker.add(pushView);

function lightAt(tl: gsap.core.Timeline, at: number, name: LightName, seconds = 1.1) {
  tl.call(() => scene.setLight(name, seconds), [], at);
}

function caption(el: HTMLElement, text: string, tl: gsap.core.Timeline, at: number) {
  tl.to(el, { opacity: 0, filter: "blur(6px)", duration: 0.25 }, at);
  tl.call(() => (el.textContent = text), [], at + 0.26);
  tl.to(el, { opacity: 1, filter: "blur(0px)", duration: 0.6, ease: "expo.out" }, at + 0.27);
}

// MARK: Terminal

/** Types a command at the terminal's last prompt, then prints its output. */
function type(tl: gsap.core.Timeline, at: number, command: string, output: string[]) {
  const pre = $("[data-term]");
  tl.call(
    () => {
      const caret = pre.querySelector(".caret");
      const line = document.createElement("span");
      caret?.before(line);
      let i = 0;
      const timer = setInterval(() => {
        line.textContent = command.slice(0, ++i);
        if (i >= command.length) {
          clearInterval(timer);
          setTimeout(() => {
            caret?.remove();
            const out = output.map((o) => `\n${o}`).join("");
            line.insertAdjacentHTML(
              "afterend",
              `${out}\n<span class="p" style="color:#0a63c7">~/code/api</span> <span class="caret" style="display:inline-block;width:7px;height:15px;vertical-align:-3px;background:#1d1d1f"></span>`,
            );
            // Keep the window to its last lines.
            const lines = pre.innerHTML.split("\n");
            if (lines.length > 17) pre.innerHTML = lines.slice(-17).join("\n");
          }, 380);
        }
      }, 55);
    },
    [],
    at,
  );
}

// MARK: Cuts

function keynote(): gsap.core.Timeline {
  const tl = gsap.timeline({ paused: true });
  Object.assign(cam, { x: 0, y: 0.6, z: 30, lookX: 0, lookY: 2.6, lookZ: 0, white: 0, flare: 0 });
  scene.snap();

  // Night: the light comes up behind the arch; the name; the promise.
  lightAt(tl, 0.3, "rest", 2.4);
  tl.to(cam, { z: 21, y: -0.4, lookY: 2.2, duration: 5.6, ease: "power2.out" }, 0);
  tl.to(cam, { z: 15, y: -1.1, lookY: 0.55, duration: 6, ease: "power2.inOut" }, 5.6);
  show("title", true, tl, 1.6, 1.6);
  show("title", false, tl, 5.4);
  show("promise", true, tl, 6.1, 1.2);
  show("promise", false, tl, 9.3);
  show("question", true, tl, 9.9, 1.1);
  show("question", false, tl, 13.2);

  // Through the arch, into the light.
  tl.to(cam, { z: 0.9, y: -0.72, lookY: -0.72, lookZ: -14, duration: 3.6, ease: "power2.inOut" }, 12.4);
  tl.to(cam, { flare: 1, duration: 2.6, ease: "power1.in" }, 13.4);
  tl.to(cam, { z: -3.4, duration: 1.4, ease: "power2.in" }, 16);
  tl.to(cam, { white: 1, duration: 1.3, ease: "power2.in" }, 16);
  tl.set(flood, { opacity: 1 }, 17.35);

  // Day: the notch.
  const cap = $("[data-caption]");
  show("notch", true, tl, 17.4, 1);
  tl.from($(".mac-wrap"), { y: 160, rotateX: 18, scale: 0.92, transformPerspective: 1600, duration: 2.2, ease: "expo.out" }, 17.4);
  tl.call(() => island.setStep(0), [], 18.6);
  caption(cap, "Agents at work, either side of the notch.", tl, 18.6);
  tl.call(() => island.setStep(1), [], 21.4);
  caption(cap, "Something is yours: a banner drops, then tucks back in.", tl, 21.6);
  tl.call(() => island.setStep(2), [], 25.4);
  caption(cap, "Click, and the whole app unfolds.", tl, 25.8);
  tl.call(() => island.setStep(3), [], 29);
  caption(cap, "Merge, from the notch. Then back to work.", tl, 29.2);
  show("notch", false, tl, 33.4, 0.9);

  // Day: the agents' path, frame by frame.
  const journey = cards.journey!;
  const track = $("[data-track]", journey);
  const frames = $$(".frame", track);
  const rail = $$("[data-rail]", journey);
  show("journey", true, tl, 33.8, 0.9);
  const reel = { p: 0 };
  tl.to(
    reel,
    {
      p: 1,
      duration: 13,
      ease: "none",
      onUpdate: () => {
        const distance = track.scrollWidth - innerWidth;
        track.style.transform = `translate3d(${-reel.p * distance}px,0,0)`;
        const mid = innerWidth / 2;
        let nearest = 0;
        let best = Infinity;
        frames.forEach((f, i) => {
          const r = f.getBoundingClientRect();
          const d = (r.left + r.width / 2 - mid) / innerWidth;
          if (Math.abs(d) < best) {
            best = Math.abs(d);
            nearest = i;
          }
          const panel = f.querySelector<HTMLElement>(".panel");
          if (panel) panel.style.transform = `perspective(1600px) translateX(${d * -60}px) rotateY(${d * -14}deg)`;
          if (d < 0.3) f.classList.add("played");
        });
        rail.forEach((r, i) => r.classList.toggle("done", i <= nearest));
      },
    },
    34.6,
  );
  show("journey", false, tl, 48, 0.9);
  tl.set(flood, { opacity: 0 }, 48.6);

  // Night: the light, walking around the arch.
  tl.call(() => {
    Object.assign(cam, { x: Math.sin(-0.5) * 15.5, z: Math.cos(-0.5) * 15.5, y: -1.2, lookX: 0, lookY: 0.45, lookZ: 0, white: 0, flare: 0 });
    scene.snap();
    scene.setLight("rest", 0.01);
  }, [], 48.5);
  const walk = { a: -0.5 };
  tl.to(
    walk,
    {
      a: 0.5,
      duration: 11,
      ease: "sine.inOut",
      onUpdate: () => {
        cam.x = Math.sin(walk.a) * lerp(15.5, 12.8, ease((walk.a + 0.5) / 1));
        cam.z = Math.cos(walk.a) * lerp(15.5, 12.8, ease((walk.a + 0.5) / 1));
      },
    },
    48.5,
  );
  const lc = $("[data-light-caption]");
  show("light", true, tl, 49, 1);
  caption(lc, "Cool white. Nothing is waiting on you.", tl, 49.4);
  lightAt(tl, 51.8, "working");
  caption(lc, "Blue lamps. Agents are at work.", tl, 51.8);
  lightAt(tl, 54.2, "needs-you");
  caption(lc, "Amber. A decision is yours.", tl, 54.2);
  lightAt(tl, 56.6, "rest");
  caption(lc, "The same light, on your Dock icon.", tl, 56.6);
  show("light", false, tl, 59.2, 0.8);

  // Day: what an ending looks like.
  const outcomes = $$("[data-outcome]", cards.outcomes!);
  show("outcomes", true, tl, 59.6, 0.9);
  outcomes.forEach((o, i) => {
    o.style.setProperty("--lit", "0.16");
    tl.to(o, { "--lit": 1, duration: 0.7, ease: "power2.out" }, 60.6 + i * 0.9);
  });
  show("outcomes", false, tl, 65.4, 0.9);

  // Night: the end card.
  tl.call(() => {
    Object.assign(cam, { x: 0, y: 2.4, z: 30, lookX: 0, lookY: -0.2, lookZ: 0, white: 0, flare: 0 });
    scene.snap();
    scene.setLight("rest", 1.5);
  }, [], 65.9);
  tl.to(cam, { z: 19, y: -0.4, lookY: 3.4, duration: 6, ease: "power3.out" }, 65.9);
  show("end", true, tl, 67, 1.4);
  lightAt(tl, 69.5, "working", 0.8);
  lightAt(tl, 71, "rest", 1.2);
  tl.to({}, { duration: 0.01 }, 73.5);
  return tl;
}

function launch(): gsap.core.Timeline {
  const tl = gsap.timeline({ paused: true });
  Object.assign(cam, { x: -1.2, y: 0.4, z: 26, lookX: 0, lookY: 1.8, lookZ: 0, white: 0, flare: 0 });
  scene.snap();

  // Night: the light breathes up through the mist; two lines.
  lightAt(tl, 0.2, "rest", 2.2);
  tl.to(cam, { x: 0, z: 15, y: -1.1, lookY: 0.55, duration: 7.4, ease: "power2.inOut" }, 0);
  show("l-alerts", true, tl, 1.4, 1.1);
  show("l-alerts", false, tl, 4.3);
  lightAt(tl, 4.4, "working", 0.8);
  show("l-agents", true, tl, 4.8, 1.1);
  show("l-agents", false, tl, 7.6);
  lightAt(tl, 7.4, "rest", 0.8);

  // Through the arch.
  tl.to(cam, { z: 0.9, y: -0.72, lookY: -0.72, lookZ: -14, duration: 2.4, ease: "power2.inOut" }, 7.4);
  tl.to(cam, { flare: 1, duration: 2, ease: "power1.in" }, 8);
  tl.to(cam, { z: -3.4, duration: 1, ease: "power2.in" }, 9.6);
  tl.to(cam, { white: 1, duration: 1, ease: "power2.in" }, 9.6);
  tl.set(flood, { opacity: 1 }, 10.6);

  // The notch, quick.
  const cap = $("[data-caption]");
  show("notch", true, tl, 10.6, 0.8);
  tl.from($(".mac-wrap"), { y: 140, rotateX: 16, scale: 0.93, transformPerspective: 1600, duration: 1.8, ease: "expo.out" }, 10.6);
  tl.call(() => island.setStep(0), [], 11.2);
  caption(cap, "Agents at work, beside the notch.", tl, 11.2);
  tl.call(() => island.setStep(1), [], 12.6);
  caption(cap, "Something is yours.", tl, 13);
  tl.call(() => island.setStep(2), [], 15.5);
  caption(cap, "One click, and it all unfolds.", tl, 16.4);
  show("notch", false, tl, 19.6, 0.7);

  // The light, in its colours.
  tl.set(flood, { opacity: 0 }, 20.3);
  tl.call(() => {
    Object.assign(cam, { x: Math.sin(-0.45) * 14.5, z: Math.cos(-0.45) * 14.5, y: -1.2, lookX: 0, lookY: 0.45, lookZ: 0, white: 0, flare: 0 });
    scene.snap();
    scene.setLight("working", 0.01);
  }, [], 20.2);
  const walk = { a: -0.45 };
  tl.to(walk, { a: 0.45, duration: 5.6, ease: "sine.inOut", onUpdate: () => {
    cam.x = Math.sin(walk.a) * 13.5;
    cam.z = Math.cos(walk.a) * 13.5;
  } }, 20.2);
  lightAt(tl, 22.6, "needs-you", 0.6);
  lightAt(tl, 25, "rest", 0.8);

  // The name.
  tl.call(() => {
    Object.assign(cam, { x: 0, y: 2.4, z: 30, lookX: 0, lookY: -0.2, lookZ: 0, white: 0, flare: 0 });
    scene.snap();
  }, [], 25.8);
  tl.to(cam, { z: 19, y: -0.4, lookY: 3.4, duration: 5.5, ease: "power3.out" }, 25.8);
  show("l-intro", true, tl, 26.4, 1.6);
  tl.to({}, { duration: 0.01 }, 32.5);
  return tl;
}

function islandCut(): gsap.core.Timeline {
  const tl = gsap.timeline({ paused: true });
  gsap.set(cards.notch!, { autoAlpha: 1 });
  scene.setActive(false);
  type(tl, 0.6, "bun test orders", [" ✓ rejects an empty region [2.4ms]", " ✓ lists orders by region [5.1ms]", "", " 2 pass", " 0 fail"]);
  tl.call(() => island.setStep(0), [], 0.2);
  tl.call(() => island.setStep(1), [], 3.2);
  type(tl, 5.2, "git add -p", ["(1/2) Stage this hunk [y,n,q,a,d,s,e,?]? y"]);
  tl.call(() => island.setStep(2), [], 8.4);
  tl.call(() => island.setStep(3), [], 11.2);
  type(tl, 16.2, "git commit -m \"Cache search by normalized query\"", ["[search-cache 4e1b2c9] Cache search by normalized query", " 2 files changed, 41 insertions(+)"]);
  tl.to({}, { duration: 0.01 }, 19.6);
  return tl;
}

// MARK: Run

const tl = cut === "island" ? islandCut() : cut === "launch" ? launch() : keynote();
tl.eventCallback("onComplete", () => (window.__film.done = true));
window.__film = {
  ready: false,
  done: false,
  duration: tl.duration(),
  start: () => tl.play(0),
};
const wait = () => {
  if (sceneReady || cut === "island") {
    // Let fonts, textures and the first frames settle before the recorder starts.
    document.fonts.ready.then(() => setTimeout(() => (window.__film.ready = true), 800));
  } else requestAnimationFrame(wait);
};
wait();
if (new URLSearchParams(location.search).has("play")) setTimeout(() => tl.play(0), 1500);
