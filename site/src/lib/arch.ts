// Bridgetown's arch, as drawn by the app (app/Sources/Bridgetown/Views/ArchMark.swift and
// Icon/IconArt.swift): a ring of voussoirs whose keystone stands proud, on two piers.
// Measures are the icon's, in its 1024-unit canvas, around the centre of the ring.

export const ARCH = {
  outer: 258,
  inner: 138,
  pier: 214,
  keyRise: 26,
  keyDrop: 12,
} as const;

export const archWidth = 2 * ARCH.outer;
export const archHeight = ARCH.outer + ARCH.keyRise + ARCH.pier;

type Pt = [number, number];
const f = (n: number) => +n.toFixed(2);

/**
 * The app's arch mark as an SVG path in an `archWidth × archHeight` viewBox (y down): three
 * ring stones (keystone in the middle, a little wider than on the icon so it reads small)
 * and two piers, with `joint` units cut between them.
 */
export function markPath(joint = 30): string {
  const { outer: R, inner: r, pier, keyRise, keyDrop } = ARCH;
  const cx = R;
  const cy = R + keyRise;
  const g = joint / 2;
  const keySpan = Math.PI / 7;
  const at = (rad: number, a: number): Pt => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  const parts: string[] = [];

  // A sector between two angles (y-down: π is left, 1.5π is the crown), sides pulled half a joint in.
  const ring = (a0: number, a1: number, ri: number, ro: number, cut0 = true, cut1 = true) => {
    const s0 = cut0 ? g : 0;
    const s1 = cut1 ? g : 0;
    const o0 = a0 + Math.asin(Math.min(1, s0 / ro));
    const o1 = a1 - Math.asin(Math.min(1, s1 / ro));
    const i0 = a0 + Math.asin(Math.min(1, s0 / ri));
    const i1 = a1 - Math.asin(Math.min(1, s1 / ri));
    const [ax, ay] = at(ro, o0);
    const [bx, by] = at(ro, o1);
    const [ix, iy] = at(ri, i1);
    const [jx, jy] = at(ri, i0);
    parts.push(
      `M${f(ax)} ${f(ay)}A${ro} ${ro} 0 0 1 ${f(bx)} ${f(by)}L${f(ix)} ${f(iy)}A${ri} ${ri} 0 0 0 ${f(jx)} ${f(jy)}Z`,
    );
  };
  const crown = 1.5 * Math.PI;
  ring(Math.PI, crown - keySpan / 2, r, R, false);
  ring(crown - keySpan / 2, crown + keySpan / 2, r - keyDrop, R + keyRise);
  ring(crown + keySpan / 2, 2 * Math.PI, r, R, true, false);
  for (const x of [cx - R, cx + r]) {
    const y = cy + g;
    parts.push(`M${f(x)} ${f(y)}H${f(x + R - r)}V${f(cy + pier)}H${f(x)}Z`);
  }
  return parts.join("");
}
