// Serves the site's static assets, and answers byte-range requests for the films, which
// static assets alone don't: Safari won't play a video it can't fetch in ranges, and
// seeking needs them everywhere. Only the videos reach this code (wrangler.jsonc).

import sizes from "./media.json";

interface Env {
  ASSETS: { fetch(request: Request | string): Promise<Response> };
}

/** `bytes=a-b`, `bytes=a-` or `bytes=-n` against a file of `size` bytes; null if unsatisfiable. */
function parseRange(header: string, size: number): [number, number] | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start <= end && start < size ? [start, end] : null;
}

/** Passes on bytes `start` to `end` of a stream, dropping the rest. */
function slice(body: ReadableStream<Uint8Array>, start: number, end: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        const from = Math.max(start - offset, 0);
        const to = Math.min(end + 1 - offset, chunk.byteLength);
        offset += chunk.byteLength;
        if (from < to) out.enqueue(chunk.subarray(from, to));
      },
    }),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const range = request.headers.get("Range");
    if (!range || request.method !== "GET") return env.ASSETS.fetch(request);

    // Asset responses carry no length, so the total comes from the build (scripts/media-manifest.mjs).
    const size = (sizes as Record<string, number>)[new URL(request.url).pathname];
    const whole = await env.ASSETS.fetch(new Request(request.url, { method: "GET" }));
    if (!whole.ok || !whole.body || !size) return whole;

    const headers = new Headers(whole.headers);
    headers.set("Accept-Ranges", "bytes");
    const bounds = parseRange(range, size);
    if (!bounds) {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    const [start, end] = bounds;
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(slice(whole.body, start, end), { status: 206, headers });
  },
};
