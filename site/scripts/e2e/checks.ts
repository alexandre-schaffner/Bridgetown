// What the landing page has to do, not only how it looks: focus, landing, the nav, the island,
// the films, the hero's frames. scripts/e2e.ts runs each on the home page, in a browser context
// of its own.

import type { Page } from "playwright-core";
import { LAPTOP, PHONE, type Motion, type Viewport } from "./screens";

/** One thing the page has to do. `run` throws a sentence saying what went wrong. */
export interface Check {
  name: string;
  viewport: Viewport;
  motion: Motion;
  /** `requested` holds the path of every request the page has made since it began to load. */
  run(page: Page, requested: string[]): Promise<void>;
}

function expect(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(what);
}

export const CHECKS: Check[] = [
  {
    name: "The skip link moves keyboard focus into the content",
    viewport: LAPTOP,
    motion: "no-preference",
    async run(page) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.matches(".skip")), "the first Tab doesn't reach the skip link");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("main")), "after the skip link, Tab goes back to the nav");
    },
  },
  {
    name: "The hero's headline arrives letter by letter, and reads as one sentence",
    viewport: LAPTOP,
    motion: "no-preference",
    async run(page) {
      const h1 = page.locator("h1");
      const letters = await h1.locator(".ch").count();
      expect(letters > 20, `it is split into ${letters} letters`);
      const tree = await h1.ariaSnapshot();
      expect(tree.includes('heading "Your alerts, handled before you look."'), `a screen reader gets ${tree}`);
    },
  },
  {
    name: "Under Reduce Motion, a nav link lands on the light's stage and focuses it",
    viewport: LAPTOP,
    motion: "reduce",
    async run(page) {
      await page.click('nav a[href="#light"]');
      await page.waitForTimeout(300);
      const { y, stage, focused } = await page.evaluate(() => {
        const light = document.querySelector<HTMLElement>("#light")!;
        const stage = light.getBoundingClientRect().top + scrollY + parseFloat(getComputedStyle(light).paddingTop);
        return { y: scrollY, stage, focused: document.activeElement === light };
      });
      expect(Math.abs(y - stage) < 2, `it lands at ${Math.round(y)}px, in the dusk before the stage at ${Math.round(stage)}px`);
      expect(focused, "the light chapter doesn't take focus");
    },
  },
  {
    name: "Paging down with the keyboard, the nav stays out of the way",
    viewport: LAPTOP,
    motion: "no-preference",
    async run(page) {
      await page.keyboard.press("PageDown");
      await page.keyboard.press("PageDown");
      await page.waitForTimeout(1200);
      expect(await page.evaluate(() => scrollY > 200), "PageDown didn't scroll the page");
      expect(await page.evaluate(() => document.documentElement.classList.contains("nav-hidden")), "the nav came back once the page stopped");
    },
  },
  {
    name: "A nav that stepped aside comes back for keyboard focus",
    viewport: LAPTOP,
    motion: "no-preference",
    async run(page) {
      await page.evaluate(() => scrollTo(0, innerHeight * 3));
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(1000);
      expect(await page.evaluate(() => document.documentElement.classList.contains("nav-hidden")), "the nav didn't step aside");
      await page.focus('nav a[href="#notch"]');
      await page.waitForTimeout(800);
      const top = await page.evaluate(() => document.querySelector(".nav")!.getBoundingClientRect().top);
      expect(top > -1, `the focused nav is ${Math.round(-top)}px off the top of the screen`);
    },
  },
  {
    name: "The island opens and folds on a click, a target for the pointer alone",
    viewport: LAPTOP,
    motion: "reduce",
    async run(page) {
      const hit = page.locator("[data-island-hit]");
      expect(
        await hit.evaluate((b: HTMLElement) => b.tabIndex === -1 && !!b.closest('[aria-hidden="true"]')),
        "the hit target is in the tab order, or in the accessibility tree inside the screen's image",
      );
      // Once its width has finished changing (Reduce Motion still runs a 1ms transition).
      const state = () =>
        hit.evaluate(async (b: HTMLElement) => {
          await new Promise(requestAnimationFrame);
          await Promise.all(b.getAnimations().map((a) => a.finished));
          return { open: b.closest("[data-island]")!.classList.contains("is-open"), width: b.offsetWidth };
        });
      // The end of the chapter, once its last step has opened the island and folded it away.
      await page.evaluate(() => {
        const notch = document.querySelector<HTMLElement>("#notch")!;
        scrollTo(0, notch.offsetTop + notch.offsetHeight - innerHeight - 10);
      });
      const isOpen = (want: boolean) =>
        page.waitForFunction((want) => document.querySelector("[data-island]")!.classList.contains("is-open") === want, want, {
          timeout: 10_000,
        });
      await isOpen(true);
      await isOpen(false);
      await hit.click();
      const opened = await state();
      expect(opened.open && opened.width === 1128, `after a click it is ${JSON.stringify(opened)}, not open across the island`);
      await hit.click();
      const folded = await state();
      expect(!folded.open && folded.width === 300, `after a second click it is ${JSON.stringify(folded)}, not folded`);
    },
  },
  {
    name: "On a touch screen the recording's pause button is in sight",
    viewport: PHONE,
    motion: "no-preference",
    async run(page) {
      const opacity = await page.evaluate(() => getComputedStyle(document.querySelector("[data-clip-toggle]")!).opacity);
      expect(opacity === "1", `it is drawn at opacity ${opacity}, shown only on hover`);
    },
  },
  {
    name: "Watch the film opens the dialog, fading in out of a blur",
    viewport: LAPTOP,
    motion: "no-preference",
    async run(page) {
      await page.click("a[data-open-film]");
      const start = await page.evaluate(() => {
        const film = document.querySelector<HTMLDialogElement>("[data-film]")!;
        const a = film.getAnimations()[0];
        if (!film.open || !a) return null;
        a.pause();
        a.currentTime = 0;
        const { opacity, filter } = getComputedStyle(film);
        return { opacity, filter, src: film.querySelector("video")!.getAttribute("src") };
      });
      expect(start, "the dialog didn't open, or opened without its animation");
      expect(start.filter.includes("blur") && Number(start.opacity) < 0.05, `it starts at opacity ${start.opacity}, ${start.filter}`);
      expect(start.src === "/media/launch.mp4", `it plays ${start.src}`);
    },
  },
  {
    name: "Each film link points at its film, for when script never runs",
    viewport: LAPTOP,
    motion: "reduce",
    async run(page) {
      const hrefs = await page.evaluate(() => [...document.querySelectorAll<HTMLAnchorElement>("[data-open-film]")].map((a) => a.href));
      expect(hrefs.length === 2, `there are ${hrefs.length} film links, not 2`);
      for (const href of hrefs) {
        const res = await page.request.get(href, { headers: { Range: "bytes=0-1" } });
        expect(res.status() === 206 && href.endsWith(".mp4"), `${href} answers ${res.status()}`);
      }
    },
  },
  {
    name: "The hero's frames come from the set its picture chose",
    // Between the two old rules: the picture took the medium set here and the script the large.
    viewport: { width: 1500, height: 900, scale: 1.5, touch: false },
    motion: "no-preference",
    async run(page, requested) {
      await page.waitForTimeout(1000);
      const sets = new Set(requested.filter((u) => u.startsWith("/hero/") && u.endsWith(".webp")).map((u) => u.split("/")[2]));
      expect(sets.size === 1, `frames came from ${[...sets].join(" and ")}`);
    },
  },
  {
    name: "Under Reduce Motion the hero's opening loop isn't downloaded",
    viewport: LAPTOP,
    motion: "reduce",
    async run(page, requested) {
      await page.waitForTimeout(1500);
      const loops = requested.filter((u) => u.endsWith("/loop.mp4"));
      expect(loops.length === 0, `it fetched ${loops.join(", ")}`);
    },
  },
];
