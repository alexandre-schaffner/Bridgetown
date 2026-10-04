// The island's shape, ported from app/Sources/Bridgetown/Island/NotchShape.swift: a black
// shape hanging from the top edge whose top corners flare outward into it, with continuous
// bottom corners. Shoulder and corner both animate, so the shape morphs as it opens.

export interface IslandLayout {
  /** The body, between the shoulders. */
  width: number;
  height: number;
  shoulder: number;
  corner: number;
}

/** Handle length as a share of the radius: longer than a circle's 0.55, like Apple's corners. */
const EASE = 0.64;

/** The shape as an SVG path, its frame's left edge at `x`. */
export function notchPath({ width, height, shoulder, corner }: IslandLayout, x = 0): string {
  const frame = width + 2 * shoulder;
  const s = Math.max(0, Math.min(shoulder, frame / 4, height / 2));
  const c = Math.max(0, Math.min(corner, (frame - 2 * s) / 2, height - s));
  const k = EASE;
  const minX = x;
  const maxX = x + frame;
  const left = minX + s;
  const right = maxX - s;
  const n = (v: number) => v.toFixed(2);
  return [
    `M${n(minX)} 0`,
    `C${n(minX + s * k)} 0 ${n(left)} ${n(s * (1 - k))} ${n(left)} ${n(s)}`,
    `L${n(left)} ${n(height - c)}`,
    `C${n(left)} ${n(height - c * (1 - k))} ${n(left + c * (1 - k))} ${n(height)} ${n(left + c)} ${n(height)}`,
    `L${n(right - c)} ${n(height)}`,
    `C${n(right - c * (1 - k))} ${n(height)} ${n(right)} ${n(height - c * (1 - k))} ${n(right)} ${n(height - c)}`,
    `L${n(right)} ${n(s)}`,
    `C${n(right)} ${n(s * (1 - k))} ${n(maxX - s * k)} 0 ${n(maxX)} 0`,
    "Z",
  ].join("");
}

/** The notch of the drawn screen, in its 1440-point coordinates. */
export const NOTCH = { width: 190, height: 32 };
export const WING = 38;

export type Presentation = "hidden" | "wings" | "banner" | "open";

/** IslandModel.layout, for the drawn screen. */
export function layoutFor(p: Presentation, hovering = false): IslandLayout {
  switch (p) {
    case "open":
      return { width: 1100, height: NOTCH.height + 480, shoulder: 14, corner: 32 };
    case "banner":
      return { width: 360, height: NOTCH.height + 64, shoulder: 10, corner: 24 };
    case "wings": {
      const l = { width: NOTCH.width + 2 * WING, height: NOTCH.height, shoulder: 6, corner: 12 };
      return hovering ? { width: l.width + 14, height: l.height + 5, shoulder: 6, corner: 14 } : l;
    }
    case "hidden":
      return { width: NOTCH.width - 12, height: NOTCH.height - 4, shoulder: 0, corner: 8 };
  }
}
