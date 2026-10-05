// Queries, typed.

/** The first element matching `s`, or null. */
export const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector<T>(s);

/** Every element matching `s`, as an array. */
export const $$ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => [
  ...root.querySelectorAll<T>(s),
];

/** A CSS colour property as sRGB components, through a canvas so oklch() resolves as the page's does. */
export function cssRGB(name: string): [number, number, number] {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const c = document.createElement("canvas").getContext("2d")!;
  c.fillStyle = value;
  c.fillRect(0, 0, 1, 1);
  const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
  return [r! / 255, g! / 255, b! / 255];
}
