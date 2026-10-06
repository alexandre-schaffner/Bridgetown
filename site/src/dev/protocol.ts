// What the rigs put on window for the scripts that drive them: the film rigs (rig.ts) for the
// recorder (scripts/record.ts), the frame renderer (render.ts) for scripts/render-hero.ts.

export interface FilmRig {
  /** The scene has drawn, the fonts are in: recording can start. */
  ready: boolean;
  /** The film has played to its end. */
  done: boolean;
  /** In seconds. */
  duration: number;
  /** The launch film's score cues, by time. */
  cues?: { t: number; kind: string; v?: number; n?: number; e?: string }[];
  /** Shots spliced into the launch film: `d` seconds opened at `at`, in the cut before any splice. */
  inserts?: { at: number; d: number }[];
  /** Plays the film from the start. */
  start(): void;
}

export interface FrameRenderer {
  ready: boolean;
  /** The hero at scroll progress `p` and scene time `t` (seconds), as a PNG data URL. */
  hero(p: number, t: number): string;
}

declare global {
  interface Window {
    __film: FilmRig;
    /** On the virtual clock (`?vt`, RigLayout.astro): moves time on by `ms` and draws a frame. */
    __advance(ms: number): void;
    __render: FrameRenderer;
  }
}
