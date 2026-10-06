// The screens the e2e opens the page on (scripts/e2e.ts walks them all; each check picks one),
// and the two motion settings it walks each at.

export interface Viewport {
  width: number;
  height: number;
  scale: number;
  touch: boolean;
}
export const PHONE: Viewport = { width: 375, height: 812, scale: 3, touch: true };
/** A tablet, upright. */
export const TABLET: Viewport = { width: 768, height: 1024, scale: 2, touch: true };
export const LAPTOP: Viewport = { width: 1280, height: 800, scale: 1, touch: false };
/** A 14-inch MacBook. */
export const MACBOOK: Viewport = { width: 1512, height: 982, scale: 2, touch: false };
export const DESKTOP: Viewport = { width: 1920, height: 1080, scale: 1, touch: false };
/**
 * The smallest phone (an iPhone SE, first generation). Checks open it; the walk doesn't yet, as
 * the hero's board still covers the hero's caption and Watch the film button on it.
 */
export const SHORT_PHONE: Viewport = { width: 320, height: 568, scale: 2, touch: true };
export const VIEWPORTS = [PHONE, TABLET, LAPTOP, MACBOOK, DESKTOP];

export const MOTIONS = ["reduce", "no-preference"] as const;
export type Motion = (typeof MOTIONS)[number];
