// Serves the site's static assets, and answers byte-range requests for the films, which
// static assets alone don't: Safari won't play a video it can't fetch in ranges, and
// seeking needs them everywhere. Only the videos reach this code (wrangler.jsonc).

import sizes from "./media.json";
import { parseRange, slice } from "./range";

interface Env {
  ASSETS: { fetch(request: Request | string): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const range = request.headers.get("Range");
    // Asset responses carry no length, so the total comes from the build (scripts/media-manifest.mjs).
    const size = (sizes as Record<string, number>)[new URL(request.url).pathname];
    if (!range || request.method !== "GET" || !size) return env.ASSETS.fetch(request);

    const bounds = parseRange(range, size);
    const ifRange = request.headers.get("If-Range");
    if (bounds === "unsatisfiable" && !["If-Range", "If-Match", "If-None-Match", "If-Modified-Since", "If-Unmodified-Since"].some((h) => request.headers.has(h))) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" } });
    }
    // A Range it can't serve as one range is ignored: the whole film.
    const assetHeaders = new Headers(request.headers);
    assetHeaders.delete("Range");
    assetHeaders.delete("If-Range");
    const whole = await env.ASSETS.fetch(new Request(request.url, { method: request.method, headers: assetHeaders }));
    if (!bounds || whole.status !== 200 || !whole.body) return whole;
    // A weak or changed validator means the caller needs the new film in full.
    // Asset dates cannot establish a strong validator, so only a matching strong ETag resumes.
    if (ifRange && (!ifRange.startsWith('"') || ifRange !== whole.headers.get("ETag"))) return whole;
    if (bounds === "unsatisfiable") {
      await whole.body.cancel();
      const headers = new Headers(whole.headers);
      headers.set("Content-Range", `bytes */${size}`);
      headers.set("Accept-Ranges", "bytes");
      headers.delete("Content-Length");
      return new Response(null, { status: 416, headers });
    }

    const [start, end] = bounds;
    const headers = new Headers(whole.headers);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(slice(whole.body, start, end), { status: 206, headers });
  },
};
