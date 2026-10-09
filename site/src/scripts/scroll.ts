// The page's scroll, which every script that moves with it shares: Lenis smooths it (not under
// Reduce Motion) and keeps ScrollTrigger told, and links within the page glide to their
// chapter instead of jumping.

import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { $, $$ } from "../lib/dom";

gsap.registerPlugin(ScrollTrigger);
export { ScrollTrigger };

export const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
export const finePointer = matchMedia("(pointer: fine)").matches;
/** The page made for a phone (pages/index.astro): nothing pinned, nothing scrubbed by scroll. */
export const phone = document.documentElement.classList.contains("phone");

export const lenis = reduced ? null : new Lenis({ lerp: 0.09, wheelMultiplier: 0.95, touchMultiplier: 1.4 });
if (lenis) {
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
}

/** Calls `fn` with the scroll position whenever the page scrolls, smoothed or not. */
export function onScroll(fn: (y: number) => void) {
  if (lenis) lenis.on("scroll", ({ scroll }: { scroll: number }) => fn(scroll));
  else addEventListener("scroll", () => fn(scrollY), { passive: true });
}

let scrolledAt = 0;
onScroll(() => (scrolledAt = performance.now()));
/** Milliseconds since the page last moved. */
export const sinceScroll = () => performance.now() - scrolledAt;

// The browser's own jump is cancelled, so this does what it would have done too: the target
// takes focus, so the skip link and the nav move keyboard focus with the view.
for (const a of $$<HTMLAnchorElement>('a[href^="#"]')) {
  a.addEventListener("click", (e) => {
    const id = a.getAttribute("href")!;
    const target = $(id);
    if (!target) return;
    e.preventDefault();
    // Chapters that open on a run of dusk land past it, on the stage (data-land="stage").
    const run = target.dataset.land === "stage" ? parseFloat(getComputedStyle(target).paddingTop) : 0;
    const to = target.getBoundingClientRect().top + scrollY + run;
    if (lenis) {
      // A long way off, cut to a screen short of it and glide the rest: gliding through every
      // chapter between would scrub the hero, the reel and the light all at once.
      const gap = to - lenis.scroll;
      if (Math.abs(gap) > innerHeight * 2) lenis.scrollTo(to - Math.sign(gap) * innerHeight, { immediate: true });
      lenis.scrollTo(to, { duration: 1.1, easing: (t) => 1 - (1 - t) ** 4 });
    } else scrollTo(0, to);
    if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    history.replaceState(null, "", id);
  });
}
