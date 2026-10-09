// What the film rigs (rig.ts) put on window for the recorder that drives them (scripts/record.ts).

export interface FilmRig {
  /** The scene has drawn, the fonts are in: recording can start. */
  ready: boolean;
  /** The film has played to its end. */
  done: boolean;
  /** In seconds. */
  duration: number;
  /** The launch film's score cues, by time (scripts/score.ts). */
  cues?: { t: number; kind: string; v?: number }[];
  /** Plays the film from the start. */
  start(): void;
}

declare global {
  interface Window {
    __film: FilmRig;
    /** On the virtual clock (`?vt`, RigLayout.astro): moves time on by `ms` and draws a frame. */
    __advance(ms: number): void;
  }
}
