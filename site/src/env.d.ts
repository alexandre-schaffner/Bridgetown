interface ImportMetaEnv {
  /** Where the access form posts `{ email }` as JSON. Unset: the form says requests aren't open yet. */
  readonly PUBLIC_ACCESS_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** The film rigs (scripts/film.ts, scripts/launch.ts), driven by a headless recorder. */
interface FilmRig {
  ready: boolean;
  done: boolean;
  duration: number;
  /** The launch film's score cues, by time. */
  cues?: { t: number; kind: string; v?: number }[];
  start: () => void;
}

interface Window {
  __film: FilmRig;
}
