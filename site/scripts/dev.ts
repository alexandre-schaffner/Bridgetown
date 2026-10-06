// What the script that drives the film rigs (record.ts) needs. The rigs exist only in
// `astro dev`, so it starts a dev server of its own on a free port (not the lock-holding one
// you may have open) and opens it in the cached Chromium.

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { resolve } from "node:path";

export const SITE = resolve(import.meta.dir, "..");

/** `astro dev` on a free port, once it answers. */
export async function devServer() {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  const server = spawn("bunx", ["astro", "dev", "--ignore-lock", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: SITE,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const stop = () => server.kill();
  // However the script ends, the server goes with it, rather than holding its port and watching
  // files for no one: an uncaught error skips the caller's `finally`, and so do Ctrl-C and a
  // timeout's SIGTERM unless they end the process through exit().
  process.once("exit", stop);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => process.exit(128 + constants.signals[signal]));
  }
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (await fetch(url).then((r) => r.ok, () => false)) break;
    if (i > 300 || server.exitCode !== null) throw new Error("astro dev didn't start");
    await Bun.sleep(100);
  }
  return { url, stop };
}

/** Chromium drawing WebGL in software, as on any machine. */
export const launchBrowser = () => chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

/**
 * Pipes PNG frames into ffmpeg, which writes an H.264 `out` (at `size`, if the frames are another);
 * `close()` waits for it to finish.
 */
export function encoder(out: string, fps: number, size?: { width: number; height: number }) {
  const ffmpeg = spawn(
    "ffmpeg",
    [
      ...["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-"],
      ...(size ? ["-vf", `scale=${size.width}:${size.height}:flags=lanczos`] : []),
      ...["-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  return {
    write: (png: Buffer) => new Promise<void>((resolve, reject) => ffmpeg.stdin!.write(png, (e) => (e ? reject(e) : resolve()))),
    async close() {
      ffmpeg.stdin!.end();
      const status = await new Promise<number | null>((resolve) => ffmpeg.on("close", resolve));
      if (status !== 0) throw new Error(`ffmpeg exited with ${status}`);
    },
  };
}
