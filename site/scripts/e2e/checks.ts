// What the landing page has to do, not only how it looks: focus, landing, the nav, the island,
// the film, the hero's headline. scripts/e2e.ts runs each on the home page, in a browser context
// of its own.

import type { Page } from "playwright-core";
import { LAPTOP, MACBOOK, PHONE, SHORT_PHONE, type Motion, type Viewport } from "./screens";

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
    name: "The hero's headline rises word by word, and reads as one sentence",
    viewport: LAPTOP,
    motion: "no-preference",
    async run(page) {
      const h1 = page.locator("h1");
      const words = await h1.locator(".wi").count();
      expect(words >= 5, `it is split into ${words} words`);
      // A no-break space reads as a space.
      const tree = (await h1.ariaSnapshot()).replaceAll("\u00a0", " ");
      expect(tree.includes('heading "Your alerts, handled before you look."'), `a screen reader gets ${tree}`);
    },
  },
  {
    name: "Split into words, the headline never breaks at its no-break space",
    viewport: LAPTOP,
    motion: "no-preference",
    async run(page) {
      // “you&nbsp;look.” shares a line however narrow the heading gets: one word that rises as one.
      const word = await page.evaluate(() => [...document.querySelectorAll("h1 .wi")].find((w) => w.textContent!.includes("look."))?.textContent);
      expect(word === "you\u00a0look.", `“look.” rises in ${JSON.stringify(word)}, apart from “you”`);
    },
  },
  {
    name: "Under Reduce Motion, a nav link lands on Safety and focuses it",
    viewport: LAPTOP,
    motion: "reduce",
    async run(page) {
      await page.click('nav a[href="#safety"]');
      await page.waitForTimeout(300);
      const { y, stage, focused } = await page.evaluate(() => {
        const safety = document.querySelector<HTMLElement>("#safety")!;
        const stage = safety.getBoundingClientRect().top + scrollY;
        return { y: scrollY, stage, focused: document.activeElement === safety };
      });
      expect(Math.abs(y - stage) < 2, `it lands at ${Math.round(y)}px, away from Safety at ${Math.round(stage)}px`);
      expect(focused, "the Safety chapter doesn't take focus");
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
      // Tab past the skip link into the nav, as a keyboard does.
      for (let i = 0; i < 4 && !(await page.evaluate(() => !!document.activeElement?.closest(".nav"))); i++) {
        await page.keyboard.press("Tab");
      }
      expect(await page.evaluate(() => !!document.activeElement?.closest(".nav")), "Tab never reaches the nav");
      await page.waitForTimeout(800);
      const top = await page.evaluate(() => document.querySelector(".nav")!.getBoundingClientRect().top);
      expect(top > -1, `the focused nav is ${Math.round(-top)}px off the top of the screen`);
    },
  },
  {
    name: "A theme picked with the mouse doesn't hold the nav in place",
    viewport: LAPTOP,
    motion: "no-preference",
    async run(page) {
      // The button keeps focus after the click, which must not count as tabbing into the nav.
      // (Light is the theme already, so no view transition runs over the scroll.)
      await page.click('[data-theme-option="light"]');
      await page.mouse.move(640, 400);
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(100);
      }
      await page.waitForTimeout(1200);
      const { hidden, top } = await page.evaluate(() => ({
        hidden: document.documentElement.classList.contains("nav-hidden"),
        top: document.querySelector(".nav")!.getBoundingClientRect().top,
      }));
      expect(hidden && top < -1, `reading down after the click, the nav is still in view (top ${Math.round(top)}px)`);
    },
  },
  {
    name: "The nav's link to the agents lands on the reel's first frame, played",
    viewport: LAPTOP,
    motion: "no-preference",
    async run(page) {
      // It lands exactly where the reel starts, where scrolling alone never moves its progress.
      await page.click('nav a[href="#journey"]');
      await page.waitForTimeout(2500);
      const { top, played, done } = await page.evaluate(() => {
        const journey = document.querySelector("#journey")!;
        return {
          top: journey.getBoundingClientRect().top,
          played: journey.querySelector(".frame")!.classList.contains("played"),
          done: journey.querySelector("[data-rail]")!.classList.contains("done"),
        };
      });
      expect(Math.abs(top) < 2, `it lands ${Math.round(top)}px from the chapter's top`);
      expect(played && done, `the first frame ${played ? "played" : "never played its proof"}, and its rail step is ${done ? "" : "not "}marked`);
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
    name: "On the smallest phone the notch chapter's words stay on its pinned screen",
    viewport: SHORT_PHONE,
    motion: "reduce",
    async run(page) {
      // Halfway through the pin, the machine above and every line beneath it on screen.
      await page.evaluate(() => {
        const notch = document.querySelector<HTMLElement>("#notch")!;
        scrollTo(0, notch.offsetTop + notch.offsetHeight / 2);
      });
      await page.waitForTimeout(300);
      const out = await page.evaluate(() => {
        const foot = Math.min(document.querySelector("#notch .pin")!.getBoundingClientRect().bottom, innerHeight);
        return [...document.querySelectorAll<HTMLElement>("#notch .copy > *")]
          .filter((el) => !el.hidden)
          .map((el) => ({ text: el.innerText.trim().slice(0, 40), past: Math.round(el.getBoundingClientRect().bottom - foot) }))
          .filter((el) => el.past > 0);
      });
      expect(out.length === 0, out.map((el) => `“${el.text}…” runs ${el.past}px past the screen's foot`).join("; "));
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
      await page.click("[data-open-film]");
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
    name: "The page runs whole under its Content-Security-Policy",
    viewport: LAPTOP,
    motion: "no-preference",
    async run(page) {
      // scripts/e2e.ts reports each violation as a console error starting "CSP:"; from the start.
      const blocked: string[] = [];
      page.on("console", (m) => m.text().startsWith("CSP:") && blocked.push(m.text()));
      const policy = (await page.reload({ waitUntil: "load" }))?.headers()["content-security-policy"];
      expect(policy?.includes("default-src 'self'"), `the page is served with ${policy ? `the policy ${policy}` : "no policy"}`);
      // The inline theme script ran, the arch's scene loads, and the film plays.
      expect(await page.evaluate(() => document.documentElement.classList.contains("js")), "the theme script was blocked");
      await page.locator("#download").scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.documentElement.classList.contains("scene-ready"), null, { timeout: 15_000 });
      // Wait for scrolling to settle before returning to the hero to open the film.
      const still = () => !document.documentElement.classList.contains("lenis-scrolling");
      await page.waitForFunction(still);
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForFunction(still);
      await page.click("[data-open-film]");
      await page.waitForFunction(() => document.querySelector<HTMLVideoElement>("[data-film-video]")!.readyState >= 2, null, { timeout: 10_000 });
      expect(blocked.length === 0, blocked.join("; "));
    },
  },
  {
    name: "On a phone the finale's download line breaks only between its halves",
    viewport: PHONE,
    motion: "reduce",
    async run(page) {
      const halves = await page.evaluate(() => {
        // Until a release is out the build knows no version or size: the longest it may grow to.
        const meta = document.querySelector("#download .meta")!;
        const needs = meta.querySelector("span")!;
        const release = needs.cloneNode() as HTMLElement;
        release.textContent = "v10.12.0 · 140 MB";
        meta.prepend(release);
        const range = document.createRange();
        return [release, needs].map((half) => {
          range.selectNodeContents(half);
          return { text: half.textContent, lines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size, top: half.getBoundingClientRect().top };
        });
      });
      for (const h of halves) expect(h.lines === 1, `“${h.text}” runs over ${h.lines} lines`);
      expect(halves[1]!.top > halves[0]!.top, "the two halves share a line too narrow for both");
      const text = await page.evaluate(() => (document.querySelector("#download .meta") as HTMLElement).innerText);
      expect(!/·\s*$/m.test(text), `a line ends on its separator: ${JSON.stringify(text)}`);
    },
  },
  {
    name: "The finale's note never splits the name of a System Settings pane",
    viewport: MACBOOK,
    motion: "reduce",
    async run(page) {
      const torn = await page.evaluate(() => {
        const note = document.querySelector("#download .note")!;
        const text = [...note.childNodes].find((n) => n.textContent!.includes("Privacy"))!;
        const out: string[] = [];
        for (const name of ["System\u00a0Settings", "Privacy\u00a0&\u00a0Security", "Open\u00a0Anyway"]) {
          const at = text.textContent!.indexOf(name);
          if (at < 0) {
            out.push(`${name} isn't whole`);
            continue;
          }
          const range = document.createRange();
          range.setStart(text, at);
          range.setEnd(text, at + name.length);
          if (new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size > 1) out.push(`${name} breaks across lines`);
        }
        return out;
      });
      expect(torn.length === 0, torn.join("; "));
    },
  },
  {
    name: "Every film the page opens is there, with its poster",
    viewport: LAPTOP,
    motion: "reduce",
    async run(page) {
      const films = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-open-film]")].map((b) => b.dataset.openFilm));
      expect(films.length > 0, "nothing on the page opens a film");
      const url = (path: string) => new URL(path, page.url()).href;
      for (const name of films) {
        const film = await page.request.get(url(`/media/${name}.mp4`), { headers: { Range: "bytes=0-1" } });
        const poster = await page.request.get(url(`/media/${name}-poster.jpg`));
        expect(film.status() === 206 && poster.ok(), `${name}.mp4 answers ${film.status()} and its poster ${poster.status()}`);
      }
    },
  },
];
