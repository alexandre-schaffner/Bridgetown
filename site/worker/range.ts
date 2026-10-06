// Byte ranges, for the Worker in front of the videos (worker/index.ts) and the e2e's static
// server (scripts/e2e.ts), which has to answer them the same way for a video to play.

/** `bytes=a-b`, `bytes=a-` or `bytes=-n` against a file of `size` bytes; null if unsatisfiable. */
export function parseRange(header: string, size: number): [number, number] | null {
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
