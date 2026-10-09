// Records a film rig (src/dev/) frame by frame: opens it on its virtual clock (`?vt`,
// dev/RigLayout.astro), plays the film, and after every step of the clock hands the frame to
// ffmpeg, so each frame is drawn at its exact time however long it takes to draw. Math.random
// is seeded, so two recordings of a film are the same.
//
// usage: bun scripts/record.ts <film> [--fps 60] [--from <s>] [--to <s>] [--out <file>]
//                                     [--poster <s>] [--stills <dir> [--every <s>]] [--silent]
//   launch        the launch film, 1920 × 1080, scored (score.ts)     → public/media/launch.mp4
//   island        the notch recording, 1600 × 996, saved 1280 wide     → public/media/island.mp4
//   island-phone  the same, zoomed on the notch as on a phone, 400 × 440 at 2×
//                                                                     → public/media/island-phone.mp4
//   --poster <s>   also writes the frame at <s> seconds as <out>-poster.jpg, at the saved size
//   --stills <dir> writes a PNG every --every seconds (default 1) instead of a video
//   --silent       leaves a scored film unscored
// A film that reports cues (launch) writes them to .context/films/<film>.cues.json first; its
// video is then scored from them (score.ts) and muxed at -16 LUFS.

import sharp from "sharp";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FilmRig } from "../src/dev/protocol";
import { devServer, encoder, launchBrowser, SITE } from "./dev";
import { score, wav } from "./score";

interface Film {
  path: string;
  width: number;
  height: number;
  out: string;
  /** Saved narrower than it is drawn. */
  saveWidth?: number;
  /** Device pixels per CSS pixel: a film drawn at a phone's width, sharp at a phone's density. */
  scale?: number;
}
const FILMS: Record<string, Film> = {
  launch: { path: "/launch", width: 1920, height: 1080, out: "public/media/launch.mp4" },
  island: { path: "/island", width: 1600, height: 996, saveWidth: 1280, out: "public/media/island.mp4" },
  "island-phone": { path: "/island", width: 400, height: 440, scale: 2, out: "public/media/island-phone.mp4" },
};

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const film = FILMS[args[0] ?? ""];
if (!film) {
  console.error(`usage: bun scripts/record.ts <${Object.keys(FILMS).join(" | ")}> [options]`);
  process.exit(2);
}
const fps = Number(option("--fps") ?? 60);
const from = Number(option("--from") ?? 0);
const to = Number(option("--to") ?? Infinity);
const poster = option("--poster");
const stills = option("--stills");
const every = Number(option("--every") ?? 1);
const silent = args.includes("--silent");
const out = resolve(SITE, option("--out") ?? film.out);
/** The film and its poster as saved: as wide as saveWidth, the height kept even for H.264. */
const saved = film.saveWidth
  ? { width: film.saveWidth, height: 2 * Math.round((film.height * film.saveWidth) / film.width / 2) }
  : undefined;

/**
 * Lays `sound` under `picture` as `out`: measured, then raised by one gain to -17 LUFS, with a
 * limiter holding the peaks under -1.5 dBTP. One gain keeps the score's dynamics, which
 * loudnorm's one-pass mode would flatten (it lifts a quiet opening to full scale).
 */
function muxScore(picture: string, sound: string, out: string) {
  const probe = spawnSync("ffmpeg", ["-hide_banner", "-i", sound, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" });
  const lufs = Number(/Integrated loudness:\s*I:\s*(-?[\d.]+) LUFS/.exec(probe.stderr)?.[1]);
  if (!Number.isFinite(lufs)) throw new Error("ffmpeg couldn't measure the score's loudness");
  const mux = spawnSync(
    "ffmpeg",
    [
      ...["-y", "-loglevel", "error", "-i", picture, "-i", sound, "-map", "0:v", "-map", "1:a", "-c:v", "copy"],
      ...["-af", `highpass=f=28,volume=${(-17 - lufs).toFixed(2)}dB,alimiter=limit=0.84:attack=2:release=80:level=false`],
      ...["-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out],
    ],
    { stdio: "inherit" },
  );
  if (mux.status !== 0) throw new Error(`ffmpeg couldn't mux the score (${mux.status})`);
}

const server = await devServer();
const browser = await launchBrowser();
let code = 0;
try {
  const page = await browser.newPage({ viewport: { width: film.width, height: film.height }, deviceScaleFactor: film.scale ?? 1 });
  await page.addInitScript(() => {
    let seed = 1;
    Math.random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  });
  page.on("pageerror", (e) => console.error(`page error: ${e.message}`));
  await page.goto(`${server.url}${film.path}${film.path.includes("?") ? "&" : "?"}vt`);

  const step = 1000 / fps;
  const advance = (ms: number) => page.evaluate((ms) => window.__advance(ms), ms);
  // The rig gets ready on its own clock: the scene's first frame, the fonts, a moment to settle.
  for (let waited = 0; !(await page.evaluate(() => window.__film?.ready)); waited += step) {
    if (waited > 30_000) throw new Error("the rig never got ready");
    await advance(step);
  }
  const { duration, cues } = await page.evaluate((): Pick<FilmRig, "duration" | "cues"> => {
    const { duration, cues } = window.__film;
    return { duration, cues };
  });
  const end = Math.min(to, duration);
  const scored = Boolean(cues) && !silent && !stills;
  if (cues) {
    const file = resolve(SITE, `../.context/films/${args[0]}.cues.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ duration, cues }, null, 1));
    console.log(file);
  }
  console.log(`${args[0]}: ${duration.toFixed(2)}s, recording ${from}s to ${end.toFixed(2)}s at ${fps} fps`);
  await page.evaluate(() => {
    window.__film.start();
  });

  mkdirSync(stills ?? dirname(out), { recursive: true });
  const picture = scored ? out.replace(/\.mp4$/, ".picture.mp4") : out;
  const video = stills ? null : encoder(picture, fps, saved);
  let nextStill = from;
  for (let frame = 0; ; frame++) {
    const t = frame / fps;
    if (t > end + 1e-9) break;
    if (t >= from - 1e-9) {
      if (video) await video.write(await page.screenshot({ type: "png" }));
      else if (t >= nextStill - 1e-9) {
        await page.screenshot({ path: join(stills!, `${t.toFixed(2).padStart(7, "0")}.png`) });
        nextStill += every;
      }
      if (poster && Math.abs(t - Number(poster)) < 0.5 / fps) {
        // As big as the film it stands in for.
        const still = sharp(await page.screenshot({ type: "png" }));
        if (saved) still.resize(saved);
        await still.jpeg({ quality: 90 }).toFile(out.replace(/\.mp4$/, "-poster.jpg"));
      }
      if (frame % fps === 0) process.stdout.write(`\r${t.toFixed(0)}s`);
    }
    await advance(step);
  }
  process.stdout.write("\n");
  if (video) {
    await video.close();
    if (scored) {
      const sound = out.replace(/\.mp4$/, ".score.wav");
      writeFileSync(sound, wav(score({ duration, cues: cues! })));
      muxScore(picture, sound, out);
      rmSync(picture);
      rmSync(sound);
    }
    console.log(out);
  }
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await browser.close();
  server.stop();
}
process.exit(code);
