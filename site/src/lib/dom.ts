// Queries, typed.

/** The first element matching `s`, or null. */
export const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector<T>(s);

/** Every element matching `s`, as an array. */
export const $$ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => [
  ...root.querySelectorAll<T>(s),
];
