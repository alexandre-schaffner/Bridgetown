/** Build time only (src/lib/download.ts): the site has no Node types, and needs just this. */
declare const process: { env: { GITHUB_TOKEN?: string } };

/** The film rigs (scripts/film.ts, scripts/launch.ts), driven by a headless recorder. */
interface FilmRig {
  ready: boolean;
  done: boolean;
  duration: number;
  /** The launch film's score cues, by time. */
  cues?: { t: number; kind: string; v?: number }[];
  /** Shots spliced into the launch film: `d` seconds opened at `at`, in the cut before any splice. */
  inserts?: { at: number; d: number }[];
  start: () => void;
}

interface Window {
  __film: FilmRig;
}
