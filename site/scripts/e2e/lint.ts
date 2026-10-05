// What the e2e (scripts/e2e.ts) finds wrong in what the page drew at a scroll stop: sideways
// scroll, text or media spilling past the screen, text cut off, ellipsised or grown out of its
// box, text drawn over other text, broken images and videos. And what it lets pass, and why.

export type Rule =
  | "sideways-scroll"
  | "spill"
  | "clipped-text"
  | "text-overflow"
  | "ellipsis"
  | "text-overlap"
  | "broken-media"
  | "console-error"
  | "page-error"
  | "failed-request";
export type Severity = "error" | "warning";
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Issue {
  rule: Rule;
  severity: Severity;
  /** What it is about: the text, the element, the request. */
  text: string;
  /** A short CSS path to the element. */
  selector?: string;
  /** Where on the screenshot, in CSS pixels. */
  rect?: Rect;
  /** Set when an allowlist entry covers it: why it is fine. */
  allowed?: string;
  crop?: string;
}

/**
 * Issues that are the design, not a glitch. Each names its rule, the element it is about (an
 * ancestor selector, matched with closest()), and why it is fine. `with` is the other element
 * of an overlap; `shots` narrows an entry to shot names containing that text.
 */
export interface Allow {
  rule: Rule | Rule[];
  within: string;
  with?: string;
  shots?: string;
  why: string;
}
export const ALLOW: Allow[] = [
  {
    rule: ["clipped-text", "spill"],
    within: "[data-track]",
    why: "The journey reel runs sideways: the frames either side of the middle one pass the screen's edges.",
  },
  {
    rule: "clipped-text",
    within: "[data-screen] .menubar",
    why: "Narrow screens zoom the drawn Mac in on its notch, so its menu bar runs off both sides (island.ts, fit).",
  },
  {
    rule: "text-overlap",
    within: "[data-island]",
    with: "[data-screen] .window",
    why: "The open island covers the terminal window behind it, as it does on a real screen.",
  },
  {
    rule: "ellipsis",
    within: "[data-island]",
    why: "The island's rows are a line each and truncate, as the app's do.",
  },
];

/**
 * Runs in the page, so it is self-contained. Text is linted as the boxes of its text nodes
 * (a Range's client rects, a line each), clipped by every ancestor whose overflow clips it.
 */
export function lintPage({ allow, shot }: { allow: Allow[]; shot: string }): Issue[] {
  const vw = innerWidth;
  const vh = innerHeight;
  const issues: Issue[] = [];
  const style = (el: Element) => getComputedStyle(el);
  const toRect = (r: DOMRect | { left: number; top: number; right: number; bottom: number }): Rect => ({
    x: Math.round(r.left),
    y: Math.round(r.top),
    w: Math.round(r.right - r.left),
    h: Math.round(r.bottom - r.top),
  });
  const path = (el: Element) => {
    const parts: string[] = [];
    for (let e: Element | null = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      const id = e.id ? `#${e.id}` : "";
      const cls = [...e.classList].filter((c) => !c.startsWith("astro-")).slice(0, 2).map((c) => `.${c}`).join("");
      parts.unshift(`${e.tagName.toLowerCase()}${id}${cls}`);
      if (id) break;
    }
    return parts.join(" > ");
  };
  const allowedFor = (rule: Rule, el: Element | null, other?: Element) => {
    if (!el) return undefined;
    const covers = (a: Allow, el: Element, other?: Element) =>
      el.closest(a.within) && (!a.with || (other && other.closest(a.with)));
    return allow.find(
      (a) =>
        (Array.isArray(a.rule) ? a.rule.includes(rule) : a.rule === rule) &&
        (!a.shots || shot.includes(a.shots)) &&
        (covers(a, el, other) || (other && covers(a, other, el))),
    )?.why;
  };
  const add = (rule: Rule, severity: Severity, el: Element | null, text: string, rect?: Rect) =>
    issues.push({ rule, severity, text: text.replace(/\s+/g, " ").trim().slice(0, 140), selector: el ? path(el) : undefined, rect, allowed: allowedFor(rule, el) });

  // How see-through an element is, all its ancestors included.
  const opacities = new Map<Element, number>();
  const opacity = (el: Element | null): number => {
    if (!el || el === document.documentElement) return 1;
    let o = opacities.get(el);
    if (o === undefined) {
      o = Number(style(el).opacity) * opacity(el.parentElement);
      opacities.set(el, o);
    }
    return o;
  };
  const shown = (el: Element) => style(el).visibility === "visible" && opacity(el) >= 0.15;

  // The boxes that clip an element's content: its own if it clips, then each ancestor's whose
  // overflow applies to it (an absolute or fixed box escapes those outside its containing block).
  interface Clip {
    el: Element;
    rect: DOMRect;
    /** Per axis: clipped for good, or scrollable. */
    x: "clip" | "scroll" | null;
    y: "clip" | "scroll" | null;
  }
  const kind = (v: string) => (v === "hidden" || v === "clip" ? "clip" : v === "auto" || v === "scroll" ? "scroll" : null);
  const containsFixed = (s: CSSStyleDeclaration) =>
    s.transform !== "none" || s.translate !== "none" || s.scale !== "none" || s.filter !== "none" || s.perspective !== "none" || /paint|layout|strict|content/.test(s.contain);
  const clips = new Map<Element, Clip[]>();
  const clipsOf = (start: Element): Clip[] => {
    const cached = clips.get(start);
    if (cached) return cached;
    const out: Clip[] = [];
    let el: Element | null = start;
    let s = style(el);
    for (;;) {
      const x = kind(s.overflowX);
      const y = kind(s.overflowY);
      if ((x || y) && el !== document.body) out.push({ el, rect: el.getBoundingClientRect(), x, y });
      const position = s.position;
      let a: Element | null = el.parentElement;
      while (a && a !== document.documentElement) {
        const as = style(a);
        if (position === "fixed" ? containsFixed(as) : position === "absolute" ? as.position !== "static" || containsFixed(as) : true) break;
        a = a.parentElement;
      }
      if (!a || a === document.documentElement || a === document.body) break;
      el = a;
      s = style(a);
    }
    clips.set(start, out);
    return out;
  };
  /** `r` cut down by every clip that applies, and the innermost clip that cut it on each axis. */
  const clipRect = (r: DOMRect, cl: Clip[]) => {
    let { left, top, right, bottom } = r;
    let cutX: Clip | null = null;
    let cutY: Clip | null = null;
    for (const c of cl) {
      if (c.x) {
        if (c.rect.left > left + 2 || c.rect.right < right - 2) cutX ??= c;
        left = Math.max(left, c.rect.left);
        right = Math.min(right, c.rect.right);
      }
      if (c.y) {
        if (c.rect.top > top + 2 || c.rect.bottom < bottom - 2) cutY ??= c;
        top = Math.max(top, c.rect.top);
        bottom = Math.min(bottom, c.rect.bottom);
      }
    }
    return { left, top, right, bottom, cutX, cutY };
  };
  const onScreen = (v: { left: number; top: number; right: number; bottom: number }) =>
    v.right - v.left > 1 && v.bottom - v.top > 1 && v.right > 0 && v.left < vw && v.bottom > 0 && v.top < vh;

  // Sideways scroll, or a phone that zoomed out to fit something too wide.
  const doc = document.documentElement;
  const wide = Math.max(doc.scrollWidth, document.body.scrollWidth);
  if (wide > vw + 1) add("sideways-scroll", "error", null, `The page is ${wide}px wide on a ${vw}px screen`);
  if (visualViewport && Math.abs(visualViewport.scale - 1) > 0.01) {
    add("sideways-scroll", "error", null, `The page zoomed to ${visualViewport.scale.toFixed(2)}× to fit`);
  }

  // Text.
  interface Fragment {
    node: Text;
    el: Element;
    rect: { left: number; top: number; right: number; bottom: number };
  }
  const fragments: Fragment[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const el = n.parentElement;
    if (!el || !n.data.trim() || el.closest("script, style, noscript, title") || !shown(el)) continue;
    range.selectNodeContents(n);
    const cl = clipsOf(el);
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      const v = clipRect(r, cl);
      if (!onScreen(v)) continue;
      fragments.push({ node: n, el, rect: v });
      const what = n.data;
      // Text that has outgrown its own box (a wrapped label in a fixed-height pill, say): past
      // its edges by more than a line's glyphs reach past it when the line is set tight.
      let box: Element = el;
      while (box.parentElement && /^(inline|contents)$/.test(style(box).display)) box = box.parentElement;
      const b = box.getBoundingClientRect();
      const line = parseFloat(style(el).lineHeight) || r.height;
      const slack = 2 + Math.max(0, (r.height - line) / 2);
      const out = Math.max(b.top - r.top, r.bottom - b.bottom, b.left - r.left, r.right - b.right);
      if (out > slack && !clipsOf(box).some((c) => c.el === box)) {
        add("text-overflow", "error", el, `“${what}” runs ${Math.round(out)}px out of ${path(box)}`, toRect(r));
      }
      if (v.cutX || v.cutY) {
        const cutter = (v.cutX ?? v.cutY)!.el;
        const scrolls = (v.cutX ? v.cutX.x : v.cutY!.y) === "scroll";
        if (scrolls) continue;
        if (style(cutter).textOverflow === "ellipsis") add("ellipsis", "warning", el, `“${what}” is ellipsised by ${path(cutter)}`, toRect(r));
        else add("clipped-text", "error", el, `“${what}” is cut off by ${path(cutter)}`, toRect(r));
      } else if (v.left < -1 || v.right > vw + 1) {
        add("spill", "error", el, `“${what}” runs past the ${v.left < -1 ? "left" : "right"} edge`, toRect(r));
      }
    }
  }

  // Text over text: two text nodes whose glyphs overlap (each line's box is trimmed to roughly
  // its glyphs, so tight line-height isn't counted).
  const core = (r: Fragment["rect"]) => {
    const inset = (r.bottom - r.top) * 0.18;
    return { left: r.left + 1, right: r.right - 1, top: r.top + inset, bottom: r.bottom - inset };
  };
  const cores = fragments.map((f) => core(f.rect));
  const reported = new Set<string>();
  for (let i = 0; i < fragments.length; i++) {
    for (let j = i + 1; j < fragments.length; j++) {
      const a = fragments[i]!;
      const b = fragments[j]!;
      if (a.node === b.node) continue;
      const p = cores[i]!;
      const q = cores[j]!;
      const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
      const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
      if (w <= 2 || h <= 2) continue;
      const smaller = Math.min((p.right - p.left) * (p.bottom - p.top), (q.right - q.left) * (q.bottom - q.top));
      if (w * h < smaller * 0.1) continue;
      const key = [path(a.el), path(b.el)].sort().join("|");
      if (reported.has(key)) continue;
      reported.add(key);
      const box = { left: Math.min(a.rect.left, b.rect.left), top: Math.min(a.rect.top, b.rect.top), right: Math.max(a.rect.right, b.rect.right), bottom: Math.max(a.rect.bottom, b.rect.bottom) };
      const covered = allowedFor("text-overlap", a.el, b.el);
      issues.push({
        rule: "text-overlap",
        severity: "error",
        text: `“${a.node.data.trim().slice(0, 50)}” and “${b.node.data.trim().slice(0, 50)}” overlap`,
        selector: `${path(a.el)} / ${path(b.el)}`,
        rect: toRect(box),
        allowed: covered,
      });
    }
  }

  // Media and controls that reach past the screen, and media that didn't load.
  for (const el of document.querySelectorAll("img, video, canvas, svg, iframe, button, input, select, textarea, pre, table")) {
    if (el instanceof SVGElement && el.ownerSVGElement) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || !shown(el)) continue;
    const v = clipRect(r, el.parentElement ? clipsOf(el.parentElement) : []);
    if (!onScreen(v)) continue;
    if (v.left < -1 || v.right > vw + 1) add("spill", "error", el, `<${el.tagName.toLowerCase()}> reaches past the ${v.left < -1 ? "left" : "right"} edge`, toRect(r));
    if (el instanceof HTMLImageElement && el.complete && el.currentSrc && el.naturalWidth === 0) {
      add("broken-media", "error", el, `${el.currentSrc} did not load`, toRect(r));
    }
    if (el instanceof HTMLVideoElement && (el.currentSrc || el.querySelector("source")) && (el.error || el.networkState === HTMLMediaElement.NETWORK_NO_SOURCE)) {
      add("broken-media", "error", el, `${el.currentSrc || "its source"} did not load${el.error ? ` (${el.error.message || el.error.code})` : ""}`, toRect(r));
    }
  }
  return issues;
}
