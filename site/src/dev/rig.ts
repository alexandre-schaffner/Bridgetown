// What a film rig (film.ts, launch.ts) hands the recorder that drives it.

export interface FilmRig {
  ready: boolean;
  done: boolean;
  duration: number;
  /** The launch film's score cues, by time. */
  cues?: { t: number; kind: string; v?: number }[];
  /** Shots spliced into the launch film: `d` seconds opened at `at`, in the cut before any splice. */
  inserts?: { at: number; d: number }[];
  start: () => void;
}

declare global {
  interface Window {
    __film: FilmRig;
  }
}
