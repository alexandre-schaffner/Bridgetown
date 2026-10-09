// The notch recording's director: tests run, a decision becomes yours, the island opens and
// it is settled from the notch, and the terminal never loses focus. Plays once and reports
// when it is done (rig.ts).

import { $, createRig } from "./rig";

const { tl, scene, island, publish } = createRig();
scene.setActive(false);

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
            // Styled inline: MacScreen's scoped styles don't reach what is added here.
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

type(0.6, "bun test search", [" ✓ caches by normalized query [3.1ms]", " ✓ evicts after ttl [0.8ms]", "", " 2 pass", " 0 fail"]);
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

publish({ scene: false });
