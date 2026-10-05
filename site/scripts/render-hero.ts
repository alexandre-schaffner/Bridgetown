// Renders the hero (public/hero/) from the frame renderer (src/dev/render.ts): for each set, every
// frame of the walk through the arch as WebP at the set's size, and the opening shot's six-second
// loop, its last second dissolved into its first so it wraps without a jump. The camera path is
// the page's own (scripts/view.ts). Slow: the scene is drawn at offline quality, in software.
//
// usage: bun scripts/render-hero.ts [l] [m] [p] [--frames-only | --loops-only] [--quality 88]

import sharp from "sharp";
import { join } from "node:path";
import { SETS } from "../src/scripts/hero-frames";
import { devServer, encoder, launchBrowser, SITE } from "./dev";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const keys = args.filter((a) => a in SETS);
const sets = (keys.length ? keys : Object.keys(SETS)).map((k) => SETS[k]!);
const quality = Number(option("--quality") ?? 88);
const LOOP_FPS = 30;
const LOOP_SECONDS = 6;
/** The stretch at the loop's end that dissolves into its start. */
const SEAM_SECONDS = 1;

const file = (path: string) => join(SITE, "public", path);

const server = await devServer();
const browser = await launchBrowser();
let code = 0;
try {
  const loopsDone = new Set<string>();
  for (const set of sets) {
    const page = await browser.newPage({ viewport: { width: set.width, height: set.height }, deviceScaleFactor: 1 });
    await page.goto(`${server.url}/render`);
    await page.waitForFunction(() => window.__render?.ready, null, { timeout: 120_000 });
    const frame = async (p: number, t: number) => {
      const url = await page.evaluate(([p, t]) => window.__render.hero(p!, t!), [p, t]);
      return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
    };

    if (!args.includes("--loops-only")) {
      for (let i = 0; i < set.count; i++) {
        const out = file(`${set.dir}/${String(i).padStart(3, "0")}.webp`);
        await sharp(await frame(i / (set.count - 1), 0)).webp({ quality }).toFile(out);
        process.stdout.write(`\r${set.dir}: frame ${i + 1} of ${set.count}`);
      }
      process.stdout.write("\n");
    }

    // Sets that share a loop (m reuses l's) render it once, at the size of the set it lives in.
    if (!args.includes("--frames-only") && !loopsDone.has(set.loop) && set.loop.startsWith(`${set.dir}/`)) {
      loopsDone.add(set.loop);
      const n = LOOP_FPS * LOOP_SECONDS;
      const seam = LOOP_FPS * SEAM_SECONDS;
      // Rendered a second long, the seam's frames blended over the start's: the last frame then
      // runs straight on into the first.
      const raw = async (t: number) => sharp(await frame(0, t)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const video = encoder(file(set.loop), LOOP_FPS);
      for (let f = 0; f < n; f++) {
        const { data, info } = await raw(f / LOOP_FPS);
        if (f < seam) {
          const after = (await raw((f + n) / LOOP_FPS)).data;
          const w = f / seam;
          for (let i = 0; i < data.length; i++) data[i] = Math.round(after[i]! * (1 - w) + data[i]! * w);
        }
        await video.write(await sharp(data, { raw: info }).png().toBuffer());
        process.stdout.write(`\r${set.loop}: frame ${f + 1} of ${n}`);
      }
      await video.close();
      process.stdout.write("\n");
    }
    await page.close();
  }
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await browser.close();
  server.stop();
}
process.exit(code);
