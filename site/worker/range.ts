// Byte ranges, for the Worker in front of the videos (worker/index.ts) and the e2e's static
// server (scripts/e2e.ts), which has to answer them the same way for a video to play.

/**
 * One byte range of a file of `size` bytes: `bytes=a-b`, `bytes=a-` or `bytes=-n`, clamped to
 * the file. "unsatisfiable" when it is a valid range that misses the file (it starts past the
 * end, or asks for the last 0 bytes): a 416. null when the header is malformed or asks for
 * several ranges, which a server may ignore (RFC 9110, 14.2): the whole file, a 200.
 */
export function parseRange(header: string, size: number): [number, number] | "unsatisfiable" | null {
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const last = Number(m[2]);
    return last === 0 ? "unsatisfiable" : [Math.max(0, size - last), size - 1];
  }
  const start = Number(m[1]);
  if (m[2] !== "" && Number(m[2]) < start) return null;
  if (start >= size) return "unsatisfiable";
  return [start, m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1)];
}

/**
 * Passes on bytes `start` to `end` of a stream, and stops reading it there: Safari's first
 * probe asks for two bytes of a 17 MB film, and reading on to the end would pull all of it.
 */
export function slice(body: ReadableStream<Uint8Array>, start: number, end: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        const from = Math.max(start - offset, 0);
        const to = Math.min(end + 1 - offset, chunk.byteLength);
        offset += chunk.byteLength;
        if (from < to) out.enqueue(chunk.subarray(from, to));
        // Closes what we pass on and cancels the pipe, so the rest is never read.
        if (offset > end) out.terminate();
      },
    }),
  );
}
