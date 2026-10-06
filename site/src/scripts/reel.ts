// The journey's reel (components/Journey.astro): on wide screens its frames sit in a row and
// slide past as a progress runs from 0 to 1, the page driving it by scroll (scripts/main.ts)
// and the film rig by time (dev/film.ts). Each frame plays its proof once it nears the
// middle; the rail marks how far along the path the reel is.

export interface Reel {
  /** Whether the frames are laid out in a row (the CSS decides, by width). */
  readonly sideways: boolean;
  /** How far the track slides, in pixels. */
  readonly distance: number;
  /** Measures the track and its frames: once per layout, never while it moves. */
  measure(): void;
  /** Slides to progress `p`. */
  seek(p: number): void;
  /** Back to the frames' place in the flow, as narrow screens stack them: unslid and unturned. */
  reset(): void;
}

export function createReel(root: HTMLElement, { tilt }: { tilt: boolean }): Reel {
  const track = root.querySelector<HTMLElement>("[data-track]")!;
  const frames = [...track.querySelectorAll<HTMLElement>(".frame")];
  const panels = frames.map((f) => f.querySelector<HTMLElement>(".panel"));
  const rail = [...root.querySelectorAll<HTMLElement>("[data-rail]")];
  let distance = 0;
  /** Each frame's centre on the screen with the track unmoved. */
  let centers: number[] = [];

  return {
    get sideways() {
      return getComputedStyle(track).display === "flex";
    },
    get distance() {
      return distance;
    },
    measure() {
      distance = Math.max(0, track.scrollWidth - innerWidth);
      // Layout offsets, which neither the track's slide nor a scaled ancestor move.
      let left = 0;
      for (let n: HTMLElement | null = track; n; n = n.offsetParent as HTMLElement | null) left += n.offsetLeft;
      centers = frames.map((f) => left + f.offsetLeft + f.offsetWidth / 2);
    },
    seek(p) {
      const shift = -p * distance;
      track.style.transform = `translate3d(${shift.toFixed(1)}px,0,0)`;
      const mid = innerWidth / 2;
      let nearest = 0;
      let best = Infinity;
      frames.forEach((f, i) => {
        const d = ((centers[i] ?? 0) + shift - mid) / innerWidth;
        if (Math.abs(d) < best) {
          best = Math.abs(d);
          nearest = i;
        }
        // Depth: frames turn slightly away as they leave the middle, their panels lagging behind.
        const panel = panels[i];
        if (panel && tilt) {
          panel.style.transform = `perspective(1600px) translateX(${(d * -60).toFixed(1)}px) rotateY(${(d * -14).toFixed(2)}deg)`;
        }
        if (d < 0.3) f.classList.add("played");
      });
      rail.forEach((r, i) => r.classList.toggle("done", i <= nearest));
    },
    reset() {
      track.style.transform = "";
      for (const p of panels) if (p) p.style.transform = "";
    },
  };
}
