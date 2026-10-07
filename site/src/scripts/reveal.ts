import { reduced } from "./scroll";

/** Adds `.in` once an element is well into view; `stagger` spaces siblings out. */
export function revealOnView(els: HTMLElement[], { threshold = 0.35, stagger = 90 } = {}) {
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
