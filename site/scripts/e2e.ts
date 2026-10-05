// The landing page, end to end, for whoever changes it next (person or agent). Builds the site
// if dist/ is older than its sources, serves dist/ on a free port, and walks each page at five
// viewports, with and without Reduce Motion. At every scroll stop it takes a screenshot and
// lints what the page drew: sideways scroll, text or media spilling past the screen, text cut
// off or ellipsised by its box, text drawn over other text, broken images and videos, console
// errors, page errors and failed requests. Then it checks what the page has to do: focus,
// landing, the nav, the films (CHECKS).
//
// Writes .context/e2e/<run>/site/: index.md first (checks, errors with crops, warnings by
// rule, a contact sheet per walk), report.json, shots/, issues/ (each issue's crop, outlined
// in red), sheets/ and checks/ (the screen when a check failed). Exits 0 when clean, 1 on lint
// errors or a failed check, 2 when the harness itself failed.
//
// usage: bun scripts/e2e.ts [--quick] [--only <part of a shot name>] [--no-build]
//   --quick     one stop per section instead of one per screen
//   --only      e.g. `--only 375x812`, `--only home.1920x1080.reduce`, `--only checks`

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseRange } from "../worker/range";

const SITE = resolve(import.meta.dir, "..");
const ROOT = resolve(SITE, "..");
const DIST = join(SITE, "dist");

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const QUICK = flag("--quick");
const ONLY = option("--only");

// MARK: What it visits

interface Viewport {
  width: number;
  height: number;
  scale: number;
  touch: boolean;
}
const VIEWPORTS: Viewport[] = [
  { width: 375, height: 812, scale: 3, touch: true }, // a phone
  { width: 768, height: 1024, scale: 2, touch: true }, // a tablet, upright
  { width: 1280, height: 800, scale: 1, touch: false },
  { width: 1512, height: 982, scale: 2, touch: false }, // a 14-inch MacBook
  { width: 1920, height: 1080, scale: 1, touch: false },
];
const MOTIONS = ["reduce", "no-preference"] as const;
type Motion = (typeof MOTIONS)[number];

interface PageSpec {
  name: string;
  path: string;
  /** The status the document should answer with. */
  status: number;
}
const PAGES: PageSpec[] = [
  { name: "home", path: "/", status: 200 },
  { name: "404", path: "/nothing-stands-here", status: 404 },
];

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
const ALLOW: Allow[] = [
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

// MARK: Lint

type Rule =
  | "sideways-scroll"
  | "spill"
  | "clipped-text"
  | "ellipsis"
  | "text-overlap"
  | "broken-media"
  | "console-error"
  | "page-error"
  | "failed-request";
type Severity = "error" | "warning";
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Issue {
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
 * Runs in the page, so it is self-contained. Text is linted as the boxes of its text nodes
 * (a Range's client rects, a line each), clipped by every ancestor whose overflow clips it.
 */
function lintPage({ allow, shot }: { allow: Allow[]; shot: string }): Issue[] {
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

// MARK: Serving

/** dist/ on a free port, answering byte ranges like the Worker does, plus the run's own files under /__e2e/. */
function serve(out: string) {
  const file = (path: string) => {
    try {
      return statSync(path).isFile() ? path : null;
    } catch {
      return null;
    }
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const name = decodeURIComponent(url.pathname);
      const path = name.startsWith("/__e2e/")
        ? file(join(out, name.slice(7)))
        : (file(join(DIST, name)) ?? file(join(DIST, name, "index.html")) ?? file(join(DIST, `${name}.html`)));
      if (!path || !path.startsWith(name.startsWith("/__e2e/") ? out : DIST)) {
        return new Response(Bun.file(join(DIST, "404.html")), { status: 404 });
      }
      const body = Bun.file(path);
      const range = req.headers.get("Range");
      if (!range) return new Response(body, { headers: { "Accept-Ranges": "bytes" } });
      const bounds = parseRange(range, body.size);
      if (!bounds) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${body.size}` } });
      const [start, end] = bounds;
      return new Response(body.slice(start, end + 1), {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${end}/${body.size}`, "Accept-Ranges": "bytes", "Content-Type": body.type },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** Builds when any source is newer than the last build. */
function buildIfStale() {
  const newest = (dir: string): number => {
    let t = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
    }
    return t;
  };
  let built = 0;
  try {
    built = statSync(join(DIST, "index.html")).mtimeMs;
  } catch {}
  const sources = Math.max(newest(join(SITE, "src")), newest(join(SITE, "public")), statSync(join(SITE, "astro.config.mjs")).mtimeMs);
  if (built > sources) return;
  console.log("dist/ is stale: building");
  const r = spawnSync("bun", ["run", "build"], { cwd: SITE, stdio: "inherit" });
  if (r.status !== 0) throw new Error("the build failed");
}

// MARK: Walking

interface Shot {
  name: string;
  page: string;
  size: string;
  motion: Motion;
  scrollY: number;
  png: string;
  issues: Issue[];
}
interface Walk {
  name: string;
  page: string;
  size: string;
  motion: Motion;
  /** Console errors, page errors and failed requests, wherever they happened. */
  issues: Issue[];
  shots: Shot[];
  sheet?: string;
  error?: string;
}

const nextFrames = (page: Page) =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

/** Where to stop: each section's top, then a screen at a time through the tall ones. */
async function stopsOf(page: Page): Promise<number[]> {
  const { tops, max, vh } = await page.evaluate(() => {
    const sections = [...document.querySelectorAll("main > *, body > footer")].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top + scrollY, height: r.height };
    });
    return { tops: sections, max: document.documentElement.scrollHeight - innerHeight, vh: innerHeight };
  });
  const ys: number[] = [];
  for (const { top, height } of tops) {
    ys.push(top);
    if (!QUICK) for (let y = top + vh; y < top + height - vh * 0.5; y += vh) ys.push(y);
  }
  ys.push(max);
  const out: number[] = [];
  for (const y of ys.map((y) => Math.round(Math.min(max, Math.max(0, y)))).sort((a, b) => a - b)) {
    if (out.length === 0 || y - out.at(-1)! > vh * 0.25) out.push(y);
  }
  return out;
}

async function walk(browser: Browser, base: string, out: string, spec: PageSpec, vp: Viewport, motion: Motion): Promise<Walk> {
  const size = `${vp.width}x${vp.height}`;
  const name = `${spec.name}.${size}.${motion}`;
  const result: Walk = { name, page: spec.path, size, motion, issues: [], shots: [] };
  const context: BrowserContext = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.scale,
    isMobile: vp.touch,
    hasTouch: vp.touch,
    reducedMotion: motion,
    colorScheme: "light",
  });
  const page = await context.newPage();
  let where = name;
  const pageIssue = (rule: Rule, text: string) =>
    result.issues.push({ rule, severity: "error", text: `${text.replace(/\s+/g, " ").slice(0, 300)} (at ${where})` });
  // A failed load also logs a console error; the response handler below judges those.
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && pageIssue("console-error", m.text()));
  page.on("pageerror", (e) => pageIssue("page-error", e.message));
  page.on("requestfailed", (r) => {
    // Media elements drop the requests they no longer need; that is not a failure.
    if (r.failure()?.errorText !== "net::ERR_ABORTED") pageIssue("failed-request", `${r.url()}: ${r.failure()?.errorText}`);
  });
  page.on("response", (r) => {
    const expected = r.request().isNavigationRequest() && r.frame() === page.mainFrame() ? spec.status : 200;
    if (r.status() >= 400 && r.status() !== expected) pageIssue("failed-request", `${r.url()}: HTTP ${r.status()}`);
  });
  try {
    const res = await page.goto(base + spec.path, { waitUntil: "load" });
    if (res?.status() !== spec.status) pageIssue("failed-request", `${spec.path} answered ${res?.status()}, not ${spec.status}`);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(800);
    const settle = motion === "reduce" ? 300 : 1000;
    const stops = await stopsOf(page);
    for (const [i, y] of stops.entries()) {
      const shotName = `${name}.${String(i).padStart(2, "0")}`;
      where = shotName;
      if (ONLY && !shotName.includes(ONLY)) continue;
      await page.evaluate((y) => scrollTo(0, y), y);
      await nextFrames(page);
      await page.waitForTimeout(settle);
      const png = `shots/${shotName}.png`;
      await page.screenshot({ path: join(out, png), scale: "css", caret: "hide" });
      const issues = await page.evaluate(lintPage, { allow: ALLOW, shot: shotName });
      await crop(page, out, shotName, issues);
      result.shots.push({ name: shotName, page: spec.path, size, motion, scrollY: y, png, issues });
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  } finally {
    await context.close();
  }
  return result;
}

/** Each issue's surroundings, the elements involved outlined in red: what to open first. */
async function crop(page: Page, out: string, shot: string, issues: Issue[]) {
  let n = 0;
  for (const issue of issues) {
    if (issue.allowed || !issue.rect || n >= 8) continue;
    const vp = page.viewportSize()!;
    const r = issue.rect;
    const x = Math.max(0, Math.min(vp.width - 1, r.x - 24));
    const y = Math.max(0, Math.min(vp.height - 1, r.y - 24));
    const clip = {
      x,
      y,
      width: Math.max(1, Math.min(vp.width, r.x + r.w + 24) - x),
      height: Math.max(1, Math.min(vp.height, r.y + r.h + 24) - y),
    };
    await page.evaluate((r) => {
      const d = document.createElement("div");
      d.dataset.e2eOutline = "";
      Object.assign(d.style, {
        position: "fixed",
        left: `${r.x}px`,
        top: `${r.y}px`,
        width: `${r.w}px`,
        height: `${r.h}px`,
        outline: "2px solid #ff2d55",
        outlineOffset: "1px",
        zIndex: "2147483647",
        pointerEvents: "none",
      });
      document.body.append(d);
    }, r);
    issue.crop = `issues/${shot}-${n++}.png`;
    await page.screenshot({ path: join(out, issue.crop), clip, scale: "css", caret: "hide" });
    await page.evaluate(() => document.querySelectorAll("[data-e2e-outline]").forEach((d) => d.remove()));
  }
}

/** One picture of a whole walk: every stop, small, with its issue count. */
async function sheet(browser: Browser, base: string, out: string, w: Walk) {
  if (!w.shots.length) return;
  const page = await browser.newPage({ viewport: { width: 1800, height: 600 } });
  const portrait = Number(w.size.split("x")[0]) < Number(w.size.split("x")[1]);
  const cells = w.shots
    .map((s) => {
      const bad = s.issues.filter((i) => !i.allowed && i.severity === "error").length;
      return `<figure><img src="/__e2e/${s.png}"><figcaption>${s.name.split(".").at(-1)} · y ${s.scrollY}${bad ? ` · <b>${bad} errors</b>` : ""}</figcaption></figure>`;
    })
    .join("");
  await page.goto(`${base}/__e2e/`);
  await page.setContent(
    `<style>body{margin:12px;font:13px system-ui;background:#222;color:#ddd}main{display:grid;grid-template-columns:repeat(${portrait ? 8 : 4},1fr);gap:10px}img{width:100%;display:block;border:1px solid #444}figure{margin:0}b{color:#ff6b81}</style><h3>${w.name}</h3><main>${cells}</main>`,
  );
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
  w.sheet = `sheets/${w.name}.png`;
  await page.screenshot({ path: join(out, w.sheet), fullPage: true });
  await page.close();
}

// MARK: Checks

/**
 * What the page has to do, not only how it looks. Each check opens the home page in a context
 * of its own and throws a sentence saying what went wrong.
 */
interface Check {
  name: string;
  viewport: Viewport;
  motion: Motion;
  run(page: Page): Promise<void>;
}
interface CheckResult {
  name: string;
  size: string;
  motion: Motion;
  ok: boolean;
  error?: string;
  png?: string;
}

const PHONE = VIEWPORTS[0]!;
const LAPTOP = VIEWPORTS[2]!;

function expect(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(what);
}

const CHECKS: Check[] = [
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
];

async function check(browser: Browser, base: string, out: string, c: Check, n: number): Promise<CheckResult> {
  const result: CheckResult = { name: c.name, size: `${c.viewport.width}x${c.viewport.height}`, motion: c.motion, ok: false };
  const context = await browser.newContext({
    viewport: { width: c.viewport.width, height: c.viewport.height },
    deviceScaleFactor: c.viewport.scale,
    isMobile: c.viewport.touch,
    hasTouch: c.viewport.touch,
    reducedMotion: c.motion,
  });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/`, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForTimeout(800);
    await c.run(page);
    result.ok = true;
  } catch (e) {
    result.error = e instanceof Error ? e.message.split("\n")[0] : String(e);
    result.png = `checks/${String(n).padStart(2, "0")}.png`;
    await page.screenshot({ path: join(out, result.png), scale: "css" }).catch(() => (result.png = undefined));
  } finally {
    await context.close();
  }
  return result;
}

// MARK: Report

function report(out: string, run: string, browser: string, walks: Walk[], checks: CheckResult[], started: number) {
  const shots = walks.flatMap((w) => w.shots);
  const all = [...walks.flatMap((w) => w.issues), ...shots.flatMap((s) => s.issues)];
  const open = all.filter((i) => !i.allowed);
  const errors = open.filter((i) => i.severity === "error");
  const warnings = open.filter((i) => i.severity === "warning");
  const failed = walks.filter((w) => w.error);
  const broken = checks.filter((c) => !c.ok);
  const git = (...a: string[]) => {
    try {
      return execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  const summary = {
    shots: shots.length,
    errors: errors.length,
    warnings: warnings.length,
    allowed: all.length - open.length,
    checks: checks.length,
    failedChecks: broken.length,
    failedWalks: failed.length,
  };
  writeFileSync(
    join(out, "report.json"),
    JSON.stringify(
      {
        run,
        commit: `${git("rev-parse", "--short", "HEAD")}${git("status", "--porcelain") ? "+dirty" : ""}`,
        os: `${process.platform} ${release()}`,
        browser,
        durationMs: Date.now() - started,
        summary,
        checks,
        walks,
      },
      null,
      1,
    ),
  );

  const line =
    `${summary.shots} shots, ${summary.errors} errors, ${summary.warnings} warnings, ${summary.allowed} allowed; ` +
    `${checks.length - broken.length} of ${checks.length} checks pass${failed.length ? `; ${failed.length} walks failed` : ""}`;
  const md: string[] = [`# Site e2e · ${run}`, "", line, ""];
  if (checks.length) {
    md.push("## Checks", "");
    for (const c of checks) {
      md.push(`- ${c.ok ? "✓" : "✗"} ${c.name} (${c.size}, ${c.motion})${c.ok ? "" : `: **${c.error}**${c.png ? ` [shot](${c.png})` : ""}`}`);
    }
    md.push("");
  }
  const link = (i: Issue) => (i.crop ? ` [crop](${i.crop})` : "");
  const where = (i: Issue) => shots.find((s) => s.issues.includes(i));
  if (failed.length) {
    md.push("## Walks that failed", "");
    for (const w of failed) md.push(`- **${w.name}**: ${w.error}`);
    md.push("");
  }
  if (errors.length) {
    md.push("## Errors", "");
    for (const i of errors) {
      const s = where(i);
      md.push(`- **${i.rule}** ${s ? `[${s.name}](${s.png})` : ""} ${i.text}${i.selector ? ` · \`${i.selector}\`` : ""}${link(i)}`);
    }
    md.push("");
  }
  if (warnings.length) {
    md.push("## Warnings", "");
    const rules = [...new Set(warnings.map((i) => i.rule))];
    for (const rule of rules) {
      const these = warnings.filter((i) => i.rule === rule);
      md.push(`### ${rule} (${these.length})`, "");
      const seen = new Set<string>();
      for (const i of these) {
        const key = `${i.selector} ${i.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const s = where(i);
        md.push(`- ${s ? `[${s.name}](${s.png})` : ""} ${i.text}${i.selector ? ` · \`${i.selector}\`` : ""}${link(i)}`);
      }
      md.push("");
    }
  }
  const allowed = all.filter((i) => i.allowed);
  if (allowed.length) {
    md.push("## Allowed", "");
    for (const why of new Set(allowed.map((i) => i.allowed!))) {
      md.push(`- ${allowed.filter((i) => i.allowed === why).length} × ${why}`);
    }
    md.push("");
  }
  md.push("## Walks", "", "| walk | stops | errors | sheet |", "| --- | --- | --- | --- |");
  for (const w of walks) {
    const n = w.issues.filter((i) => !i.allowed).length + w.shots.flatMap((s) => s.issues).filter((i) => !i.allowed && i.severity === "error").length;
    md.push(`| ${w.name} | ${w.shots.length} | ${n} | ${w.sheet ? `[sheet](${w.sheet})` : ""} |`);
  }
  md.push("");
  writeFileSync(join(out, "index.md"), md.join("\n"));
  return { line, code: failed.length ? 2 : errors.length || broken.length ? 1 : 0 };
}

/** Keeps the five newest site runs, and points latest-site at this one. */
function prune(e2e: string, run: string) {
  const runs = readdirSync(e2e)
    .filter((d) => /^\d{8}-\d{6}$/.test(d))
    .filter((d) => {
      const entries = readdirSync(join(e2e, d));
      return entries.length === 1 && entries[0] === "site";
    })
    .sort();
  for (const d of runs.slice(0, -5)) rmSync(join(e2e, d), { recursive: true, force: true });
  rmSync(join(e2e, "latest-site"), { force: true });
  symlinkSync(join(run, "site"), join(e2e, "latest-site"));
}

// MARK: Run

const started = Date.now();
const run = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const e2e = join(ROOT, ".context", "e2e");
const out = join(e2e, run, "site");
for (const d of ["shots", "issues", "sheets", "checks"]) mkdirSync(join(out, d), { recursive: true });

let code = 2;
try {
  if (!flag("--no-build")) buildIfStale();
  const server = serve(out);
  const browser = await chromium.launch({
    headless: true,
    // WebGL through SwiftShader, as any machine without a GPU would draw it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
  });
  const version = `chromium ${browser.version()}`;
  const walks: Walk[] = [];
  const checks: CheckResult[] = [];
  try {
    for (const spec of PAGES) {
      for (const vp of VIEWPORTS) {
        for (const motion of MOTIONS) {
          const name = `${spec.name}.${vp.width}x${vp.height}.${motion}`;
          if (ONLY && !name.includes(ONLY) && !ONLY.startsWith(name)) continue;
          const w = await walk(browser, server.url, out, spec, vp, motion);
          await sheet(browser, server.url, out, w);
          walks.push(w);
          const bad = w.issues.length + w.shots.flatMap((s) => s.issues).filter((i) => !i.allowed && i.severity === "error").length;
          console.log(`${name}: ${w.shots.length} stops, ${bad} errors${w.error ? `, failed: ${w.error}` : ""}`);
        }
      }
    }
    for (const [n, c] of CHECKS.entries()) {
      if (ONLY && !c.name.includes(ONLY) && ONLY !== "checks") continue;
      const r = await check(browser, server.url, out, c, n);
      checks.push(r);
      console.log(`${r.ok ? "✓" : "✗"} ${c.name}${r.ok ? "" : `: ${r.error}`}`);
    }
  } finally {
    await browser.close();
    server.stop();
  }
  const result = report(out, run, version, walks, checks, started);
  prune(e2e, run);
  console.log(`${result.line}\n${relative(process.cwd(), join(out, "index.md"))}`);
  code = result.code;
} catch (e) {
  console.error(e);
  writeFileSync(join(out, "index.md"), `# Site e2e · ${run}\n\nThe harness failed: ${e instanceof Error ? e.stack : e}\n`);
}
process.exit(code);
