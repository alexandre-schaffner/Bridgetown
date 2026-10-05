// What both film rigs (film.ts, launch.ts) are made of: a paused timeline, the arch scene and
// the camera it follows, the island in the notch shot, and the handshake with the recorder
// (window.__film, protocol.ts). The pages lay it out on RigLayout.astro.

import { gsap } from "gsap";
import * as THREE from "three";
import { cssRGB } from "../lib/dom";
import { createIsland } from "../scripts/island";
import { createArchScene, type LightName } from "../scripts/scene";
import { restView, type View } from "../scripts/view";
import type { FilmRig } from "./protocol";

export { $$ } from "../lib/dom";

/** The element matching `s`, which the rig's markup always has. */
export function $<T extends Element = HTMLElement>(s: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(s);
  if (!el) throw new Error(`The rig has no ${s}`);
  return el;
}

/** What the island says at each step of its tour, Wings to Merge. */
const TOUR = [
  "Agents at work, either side of the notch.",
  "Something is yours: a banner drops, then tucks back in.",
  "Click, and the whole app unfolds.",
  "Merge, from the notch. Then back to work.",
];

/** `cinematic` springs the island the launch film's slower way (scripts/island.ts). */
export function createRig({ cinematic = false } = {}) {
  // The film keeps to the clock even when a frame runs long, so cues and score stay in sync.
  gsap.ticker.lagSmoothing(0);
  const tl = gsap.timeline({ paused: true });

  let sceneReady = false;
  const scene = createArchScene($<HTMLCanvasElement>("[data-scene]"), {
    day: new THREE.Color().setRGB(...cssRGB("--day"), THREE.SRGBColorSpace),
    reducedMotion: false,
    onFirstFrame: () => (sceneReady = true),
  });
  scene.setLight("out", 0.01);
  /** The camera, as the timeline tweens it: the scene follows it every frame. */
  const cam: View = restView();
  gsap.ticker.add(() => {
    Object.assign(scene.view, cam);
  });

  const island = createIsland($("[data-island-root]"), { reducedMotion: false, cinematic });
  island.setVisible(true);

  /** A caption's text changes at `at`: out through a blur, and back in with the new words. */
  const caption = (el: HTMLElement, text: string, at: number) => {
    tl.to(el, { opacity: 0, filter: "blur(6px)", duration: 0.2 }, at);
    tl.call(() => (el.textContent = text), [], at + 0.21);
    tl.to(el, { opacity: 1, filter: "blur(0px)", duration: 0.6, ease: "expo.out" }, at + 0.22);
  };

  /** Cuts the camera to `view`, from a level look at the arch from 30 away, and the light to `lamp`. */
  const cut = (view: Partial<View>, lamp?: LightName) => {
    Object.assign(cam, { x: 0, y: 0, z: 30, lookX: 0, lookY: 0, lookZ: 0, white: 0, flare: 0 }, view);
    // The ticker hands the camera over once a frame; a cut can't wait for it.
    Object.assign(scene.view, cam);
    scene.snap();
    if (lamp) scene.setLight(lamp, 0.01);
  };

  return {
    tl,
    scene,
    cam,
    island,
    flood: $("[data-flood]"),
    caption,
    /** The arch's light goes to `name` at `at`, over `seconds`. */
    light(at: number, name: LightName, seconds = 1.1) {
      tl.call(() => scene.setLight(name, seconds), [], at);
    },
    cut,
    /** The same cut, at `at`. */
    place(at: number, view: Partial<View>, lamp?: LightName) {
      tl.call(() => cut(view, lamp), [], at);
    },
    /** The island's tour, a step at each of `steps`, each step's caption at `captions`. */
    tour(cap: HTMLElement, steps: number[], captions: number[], texts = TOUR) {
      steps.forEach((at, i) => tl.call(() => island.setStep(i), [], at));
      captions.forEach((at, i) => caption(cap, texts[i]!, at));
    },
    /**
     * Hands the film to the recorder (window.__film): ready once the scene has drawn (unless the
     * film never shows it) and the fonts are in. `?play` plays it a moment after loading;
     * `?at=42` plays it up to 42 seconds and holds there, for stills.
     */
    publish({ cues, inserts, scene: shown = true }: Pick<FilmRig, "cues" | "inserts"> & { scene?: boolean } = {}) {
      tl.eventCallback("onComplete", () => (window.__film.done = true));
      window.__film = { ready: false, done: false, duration: tl.duration(), cues, inserts, start: () => void tl.play(0) };
      const whenDrawn = (then: () => void) => (sceneReady || !shown ? then() : requestAnimationFrame(() => whenDrawn(then)));
      // Let the fonts, textures and first frames settle before the recorder starts.
      whenDrawn(() => document.fonts.ready.then(() => setTimeout(() => (window.__film.ready = true), 800)));
      const params = new URLSearchParams(location.search);
      if (params.has("play")) setTimeout(() => tl.play(0), 1500);
      if (params.has("at")) {
        const at = Number(params.get("at"));
        tl.call(() => tl.pause(), [], at);
        whenDrawn(() =>
          setTimeout(() => {
            tl.seek(Math.max(0, at - 3), false);
            tl.play();
          }, 600),
        );
      }
    },
  };
}
