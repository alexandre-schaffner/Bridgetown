// The film rig's director. Plays the keynote, the 32-second launch cut or the short island
// recording once, from the site's own scene and components, and reports when it is done so the
// recorder can stop (rig.ts). `?cut=keynote` (the default), `launch` or `island`.

import { gsap } from "gsap";
import { inOut, lerp } from "../lib/math";
import { createReel } from "../scripts/reel";
import { $, $$, createRig } from "./rig";

const cut = new URLSearchParams(location.search).get("cut") ?? "keynote";
document.documentElement.classList.add(`cut-${cut}`);

const { tl, scene, cam, island, flood, caption, light, cut: cutTo, place, tour, publish } = createRig();
const cards = Object.fromEntries($$("[data-card]").map((el) => [el.dataset.card!, el]));

/** Brings a card in out of a blur, or sends it off. */
function show(name: string, on: boolean, at: number, dur = 0.9) {
  const el = cards[name]!;
  tl.to(
    el,
    on
      ? { autoAlpha: 1, filter: "blur(0px)", scale: 1, duration: dur, ease: "expo.out" }
      : { autoAlpha: 0, filter: "blur(14px)", scale: 1.03, duration: dur * 0.7, ease: "power2.in" },
    at,
  );
  if (on) tl.set(el, { filter: "blur(14px)", scale: 0.98 }, at - 0.001);
}

// MARK: Terminal

/** Types a command at the terminal's last prompt, then prints its output. */
function type(at: number, command: string, output: string[]) {
  const pre = $("[data-term]");
  tl.call(
    () => {
      const caret = pre.querySelector(".caret");
      const line = document.createElement("span");
      caret?.before(line);
      let i = 0;
      const timer = setInterval(() => {
        line.textContent = command.slice(0, ++i);
        if (i >= command.length) {
          clearInterval(timer);
          setTimeout(() => {
            caret?.remove();
            const out = output.map((o) => `\n${o}`).join("");
            line.insertAdjacentHTML(
              "afterend",
              `${out}\n<span class="p" style="color:#0a63c7">~/code/api</span> <span class="caret" style="display:inline-block;width:7px;height:15px;vertical-align:-3px;background:#1d1d1f"></span>`,
            );
            // Keep the window to its last lines.
            const lines = pre.innerHTML.split("\n");
            if (lines.length > 17) pre.innerHTML = lines.slice(-17).join("\n");
          }, 380);
        }
      }, 55);
    },
    [],
    at,
  );
}

// MARK: Cuts

function keynote() {
  cutTo({ y: 0.6, lookY: 2.6 });

  // Night: the light comes up behind the arch; the name; the promise.
  light(0.3, "rest", 2.4);
  tl.to(cam, { z: 21, y: -0.4, lookY: 2.2, duration: 5.6, ease: "power2.out" }, 0);
  tl.to(cam, { z: 15, y: -1.1, lookY: 0.55, duration: 6, ease: "power2.inOut" }, 5.6);
  show("title", true, 1.6, 1.6);
  show("title", false, 5.4);
  show("promise", true, 6.1, 1.2);
  show("promise", false, 9.3);
  show("question", true, 9.9, 1.1);
  show("question", false, 13.2);

  // Through the arch, into the light.
  tl.to(cam, { z: 0.9, y: -0.72, lookY: -0.72, lookZ: -14, duration: 3.6, ease: "power2.inOut" }, 12.4);
  tl.to(cam, { flare: 1, duration: 2.6, ease: "power1.in" }, 13.4);
  tl.to(cam, { z: -3.4, duration: 1.4, ease: "power2.in" }, 16);
  tl.to(cam, { white: 1, duration: 1.3, ease: "power2.in" }, 16);
  tl.set(flood, { opacity: 1 }, 17.35);

  // Day: the notch.
  show("notch", true, 17.4, 1);
  tl.from($(".mac-wrap"), { y: 160, rotateX: 18, scale: 0.92, transformPerspective: 1600, duration: 2.2, ease: "expo.out" }, 17.4);
  tour($("[data-caption]"), [18.6, 21.4, 25.4, 29], [18.6, 21.6, 25.8, 29.2]);
  show("notch", false, 33.4, 0.9);

  // Day: the agents' path, frame by frame.
  const reel = createReel(cards.journey!, { tilt: true });
  const along = { p: 0 };
  show("journey", true, 33.8, 0.9);
  tl.call(() => reel.measure(), [], 34.6);
  tl.to(along, { p: 1, duration: 13, ease: "none", onUpdate: () => reel.seek(along.p) }, 34.6);
  show("journey", false, 48, 0.9);
  tl.set(flood, { opacity: 0 }, 48.6);

  // Night: the light, walking around the arch.
  place(48.5, { x: Math.sin(-0.5) * 15.5, z: Math.cos(-0.5) * 15.5, y: -1.2, lookY: 0.45 }, "rest");
  const walk = { a: -0.5 };
  tl.to(
    walk,
    {
      a: 0.5,
      duration: 11,
      ease: "sine.inOut",
      onUpdate: () => {
        const r = lerp(15.5, 12.8, inOut(walk.a + 0.5));
        cam.x = Math.sin(walk.a) * r;
        cam.z = Math.cos(walk.a) * r;
      },
    },
    48.5,
  );
  const lc = $("[data-light-caption]");
  show("light", true, 49, 1);
  caption(lc, "Cool white. Nothing is waiting on you.", 49.4);
  light(51.8, "working");
  caption(lc, "Blue lamps. Agents are at work.", 51.8);
  light(54.2, "needs-you");
  caption(lc, "Amber. A decision is yours.", 54.2);
  light(56.6, "rest");
  caption(lc, "The same light, on your Dock icon.", 56.6);
  show("light", false, 59.2, 0.8);

  // Day: what an ending looks like.
  const outcomes = $$("[data-outcome]", cards.outcomes!);
  show("outcomes", true, 59.6, 0.9);
  outcomes.forEach((o, i) => {
    o.style.setProperty("--lit", "0.16");
    tl.to(o, { "--lit": 1, duration: 0.7, ease: "power2.out" }, 60.6 + i * 0.9);
  });
  show("outcomes", false, 65.4, 0.9);

  // Night: the end card.
  place(65.9, { y: 2.4, lookY: -0.2 });
  light(65.9, "rest", 1.5);
  tl.to(cam, { z: 19, y: -0.4, lookY: 3.4, duration: 6, ease: "power3.out" }, 65.9);
  show("end", true, 67, 1.4);
  light(69.5, "working", 0.8);
  light(71, "rest", 1.2);
  tl.to({}, { duration: 0.01 }, 73.5);
}

function launch() {
  cutTo({ x: -1.2, y: 0.4, z: 26, lookY: 1.8 });

  // Night: the light breathes up through the mist; two lines.
  light(0.2, "rest", 2.2);
  tl.to(cam, { x: 0, z: 15, y: -1.1, lookY: 0.55, duration: 7.4, ease: "power2.inOut" }, 0);
  show("l-alerts", true, 1.4, 1.1);
  show("l-alerts", false, 4.3);
  light(4.4, "working", 0.8);
  show("l-agents", true, 4.8, 1.1);
  show("l-agents", false, 7.6);
  light(7.4, "rest", 0.8);

  // Through the arch.
  tl.to(cam, { z: 0.9, y: -0.72, lookY: -0.72, lookZ: -14, duration: 2.4, ease: "power2.inOut" }, 7.4);
  tl.to(cam, { flare: 1, duration: 2, ease: "power1.in" }, 8);
  tl.to(cam, { z: -3.4, duration: 1, ease: "power2.in" }, 9.6);
  tl.to(cam, { white: 1, duration: 1, ease: "power2.in" }, 9.6);
  tl.set(flood, { opacity: 1 }, 10.6);

  // The notch, quick.
  show("notch", true, 10.6, 0.8);
  tl.from($(".mac-wrap"), { y: 140, rotateX: 16, scale: 0.93, transformPerspective: 1600, duration: 1.8, ease: "expo.out" }, 10.6);
  tour($("[data-caption]"), [11.2, 12.6, 15.5], [11.2, 13, 16.4], [
    "Agents at work, beside the notch.",
    "Something is yours.",
    "One click, and it all unfolds.",
  ]);
  show("notch", false, 19.6, 0.7);

  // The light, in its colours.
  tl.set(flood, { opacity: 0 }, 20.3);
  place(20.2, { x: Math.sin(-0.45) * 14.5, z: Math.cos(-0.45) * 14.5, y: -1.2, lookY: 0.45 }, "working");
  const walk = { a: -0.45 };
  tl.to(
    walk,
    {
      a: 0.45,
      duration: 5.6,
      ease: "sine.inOut",
      onUpdate: () => {
        cam.x = Math.sin(walk.a) * 13.5;
        cam.z = Math.cos(walk.a) * 13.5;
      },
    },
    20.2,
  );
  light(22.6, "needs-you", 0.6);
  light(25, "rest", 0.8);

  // The name.
  place(25.8, { y: 2.4, lookY: -0.2 });
  tl.to(cam, { z: 19, y: -0.4, lookY: 3.4, duration: 5.5, ease: "power3.out" }, 25.8);
  show("l-intro", true, 26.4, 1.6);
  tl.to({}, { duration: 0.01 }, 32.5);
}

function islandCut() {
  gsap.set(cards.notch!, { autoAlpha: 1 });
  scene.setActive(false);
  type(0.6, "bun test orders", [" ✓ rejects an empty region [2.4ms]", " ✓ lists orders by region [5.1ms]", "", " 2 pass", " 0 fail"]);
  tl.call(() => island.setStep(0), [], 0.2);
  tl.call(() => island.setStep(1), [], 3.2);
  type(5.2, "git add -p", ["(1/2) Stage this hunk [y,n,q,a,d,s,e,?]? y"]);
  tl.call(() => island.setStep(2), [], 8.4);
  tl.call(() => island.setStep(3), [], 11.2);
  type(16.2, 'git commit -m "Cache search by normalized query"', [
    "[search-cache 4e1b2c9] Cache search by normalized query",
    " 2 files changed, 41 insertions(+)",
  ]);
  tl.to({}, { duration: 0.01 }, 19.6);
}

// MARK: Run

if (cut === "island") islandCut();
else if (cut === "launch") launch();
else keynote();
publish({ scene: cut !== "island" });
