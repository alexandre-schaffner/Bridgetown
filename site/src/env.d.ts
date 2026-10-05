interface ImportMetaEnv {
  /** Where the access form posts `{ email }` as JSON. Unset: the form says requests aren't open yet. */
  readonly PUBLIC_ACCESS_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
