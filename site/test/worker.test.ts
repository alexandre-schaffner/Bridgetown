import { describe, expect, test } from "bun:test";
import worker from "../worker/index";
import sizes from "../worker/media.json";
import { parseRange, slice } from "../worker/range";

/** A body of `chunks` × `size` bytes counting up, which records how far it was read and whether it was cancelled. */
function source(chunks: number, size: number) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (state.pulled === chunks) return c.close();
        c.enqueue(Uint8Array.from({ length: size }, (_, i) => (state.pulled * size + i) % 256));
        state.pulled++;
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

const bytes = async (s: ReadableStream<Uint8Array> | null) => new Uint8Array(await new Response(s).arrayBuffer());

describe("parseRange", () => {
  test("the three forms, clamped to the file", () => {
    expect(parseRange("bytes=0-1", 100)).toEqual([0, 1]);
    expect(parseRange("bytes=90-", 100)).toEqual([90, 99]);
    expect(parseRange("bytes=-10", 100)).toEqual([90, 99]);
    expect(parseRange("bytes=50-500", 100)).toEqual([50, 99]);
    expect(parseRange("bytes=-500", 100)).toEqual([0, 99]);
  });

  test("unsatisfiable or malformed ranges are null", () => {
    expect(parseRange("bytes=100-", 100)).toBeNull();
    expect(parseRange("bytes=5-2", 100)).toBeNull();
    expect(parseRange("bytes=-0", 100)).toBeNull();
    expect(parseRange("bytes=-", 100)).toBeNull();
    expect(parseRange("bytes=0-1,4-5", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
  });
});

describe("slice", () => {
  test("two bytes of a long body: read no further, and the rest is cancelled", async () => {
    const { stream, state } = source(1000, 1024);
    expect([...(await bytes(slice(stream, 0, 1)))]).toEqual([0, 1]);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(4);
  });

  test("a range across chunks comes out whole", async () => {
    const { stream, state } = source(10, 1000);
    const out = await bytes(slice(stream, 1500, 2600));
    expect(out.length).toBe(1101);
    expect(out[0]).toBe(1500 % 256);
    expect(out.at(-1)).toBe(2600 % 256);
    expect(state.pulled).toBeLessThan(6);
  });

  test("a range to the end reads the body to the end", async () => {
    const { stream } = source(4, 10);
    expect((await bytes(slice(stream, 35, 39))).length).toBe(5);
  });
});

describe("the Worker", () => {
  const path = "/media/island.mp4";
  const size = (sizes as Record<string, number>)[path]!;
  const env = () => {
    const calls: Request[] = [];
    const body = source(Math.ceil(size / 4096), 4096);
    const ASSETS = {
      fetch: async (r: Request | string) => {
        calls.push(typeof r === "string" ? new Request(r) : r);
        return new Response(body.stream, { headers: { "Content-Type": "video/mp4" } });
      },
    };
    return { env: { ASSETS }, calls, body: body.state };
  };
  const get = (url: string, range?: string) =>
    new Request(`https://bridgetown.test${url}`, { headers: range ? { Range: range } : {} });

  test("Safari's first probe: two bytes, the film's whole length, and the rest left unread", async () => {
    const { env: e, body } = env();
    const res = await worker.fetch(get(path, "bytes=0-1"), e);
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-1/${size}`);
    expect(res.headers.get("Content-Length")).toBe("2");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect((await bytes(res.body)).length).toBe(2);
    expect(body.cancelled).toBe(true);
  });

  test("an unsatisfiable range is a 416 without fetching the film", async () => {
    const { env: e, calls } = env();
    const res = await worker.fetch(get(path, `bytes=${size}-`), e);
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe(`bytes */${size}`);
    expect(calls).toHaveLength(0);
  });

  test("no range, or a file it has no length for, goes straight to the assets", async () => {
    const { env: e, calls } = env();
    expect((await worker.fetch(get(path), e)).status).toBe(200);
    expect((await worker.fetch(get("/hero/m/loop.mp4", "bytes=0-1"), e)).status).toBe(200);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([path, "/hero/m/loop.mp4"]);
  });
});
