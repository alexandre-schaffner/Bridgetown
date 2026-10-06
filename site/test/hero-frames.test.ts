import { beforeEach, describe, expect, test } from "bun:test";
import { createHeroFrames } from "../src/scripts/hero-frames";

// Just enough of a browser for the hero's frames: images whose decoding the test finishes by
// hand, canvases that record what they paint, and the <picture>'s first frame.

const SIZES: Record<string, [number, number]> = { p: [1080, 1920], m: [1920, 1080], l: [2560, 1440] };
let decoding: FakeImage[] = [];

class FakeImage {
  src = "";
  decoding = "";
  naturalWidth = 0;
  naturalHeight = 0;
  done?: () => void;
  decode() {
    decoding.push(this);
    return new Promise<void>((resolve) => (this.done = resolve));
  }
  /** The image arrives: sized as its set's frames are. */
  arrive() {
    [this.naturalWidth, this.naturalHeight] = SIZES[this.src.split("/")[2]!] ?? [0, 0];
    this.done?.();
  }
}

function page(firstSrc: string) {
  const painted: string[] = [];
  const canvas = () => ({
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => ({ drawImage: (img: FakeImage) => painted.push(img.src) }),
    cloneNode: () => canvas(),
    after() {},
  });
  const listeners: (() => void)[] = [];
  const first = { currentSrc: firstSrc, src: "", addEventListener: (_: string, fn: () => void) => listeners.push(fn) };
  const video = {
    src: "",
    paused: true,
    readyState: 4,
    classes: new Set<string>(),
    getAttribute() {
      return this.src || null;
    },
    load() {},
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    classList: {
      toggle: (c: string, on: boolean) => (on ? video.classes.add(c) : video.classes.delete(c)),
      contains: (c: string) => video.classes.has(c),
    },
  };
  const parts: Record<string, unknown> = { "picture img": first, "[data-hero-frames]": canvas(), "[data-hero-loop]": video };
  const root = { querySelector: (s: string) => parts[s] } as unknown as HTMLElement;
  /** The picture picks another set, as it does when the screen turns. */
  const turn = (src: string) => {
    first.currentSrc = src;
    listeners.forEach((fn) => fn());
  };
  return { root, painted, video, turn };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  decoding = [];
  Object.assign(globalThis, { Image: FakeImage, window: globalThis, innerWidth: 390, innerHeight: 844, devicePixelRatio: 2 });
});

describe("the hero's frames", () => {
  test("come from the set the picture chose", () => {
    createHeroFrames(page("/hero/m/000.webp").root, { reducedMotion: false });
    expect(new Set(decoding.map((i) => i.src.split("/")[2]))).toEqual(new Set(["m"]));
  });

  test("a frame of the set the screen turned away from never lands in the new one", async () => {
    const p = page("/hero/p/000.webp");
    const hero = createHeroFrames(p.root, { reducedMotion: false });
    const portrait = [...decoding];
    Object.assign(globalThis, { innerWidth: 844, innerHeight: 390 });
    p.turn("/hero/m/000.webp");
    const landscape = decoding.filter((i) => !portrait.includes(i));
    expect(landscape.map((i) => i.src.split("/")[2])).toEqual(Array(6).fill("m"));
    // The superseded requests are dropped, and arriving late changes nothing.
    expect(portrait.map((i) => i.src)).toEqual(Array(6).fill(""));
    landscape.forEach((i) => i.arrive());
    await settle();
    portrait.forEach((i) => i.arrive());
    await settle();
    hero.render(0);
    expect(p.painted).toEqual(["/hero/m/000.webp"]);
  });

  test("the old set stops loading once the screen turns", async () => {
    const p = page("/hero/p/000.webp");
    createHeroFrames(p.root, { reducedMotion: false });
    const portrait = [...decoding];
    p.turn("/hero/m/000.webp");
    portrait.forEach((i) => i.arrive());
    await settle();
    expect(decoding.filter((i) => i.src.startsWith("/hero/p/"))).toHaveLength(0);
  });

  test("the opening loop is fetched for the set, once, and never under Reduce Motion", () => {
    const p = page("/hero/l/000.webp");
    createHeroFrames(p.root, { reducedMotion: false });
    expect(p.video.src).toBe("/hero/l/loop.mp4");
    p.video.load = () => {
      throw new Error("reloaded the loop it already had");
    };
    p.turn("/hero/m/000.webp");
    const still = page("/hero/p/000.webp");
    createHeroFrames(still.root, { reducedMotion: true });
    expect(still.video.src).toBe("");
  });

  test("leaving the top stops the loop once, however many frames ask", async () => {
    const p = page("/hero/m/000.webp");
    const hero = createHeroFrames(p.root, { reducedMotion: false });
    let timers = 0;
    const real = globalThis.setTimeout;
    Object.assign(globalThis, { setTimeout: (fn: () => void, ms: number) => (timers++, real(fn, ms)) });
    hero.setResting(true);
    expect(p.video.paused).toBe(false);
    for (let i = 0; i < 60; i++) hero.setResting(false);
    Object.assign(globalThis, { setTimeout: real });
    expect(timers).toBe(1);
    await new Promise((r) => real(r, 550));
    expect(p.video.paused).toBe(true);
  });
});
