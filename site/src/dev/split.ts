// The launch film's headings (launch.ts) split into spans that move on their own: words, or the
// letters of each word. A screen reader still reads the heading whole: it is labelled with its
// own text, and the spans are hidden from it.

/**
 * The spaces a line may break at. The no-break ones stay inside the word they join: between two
 * inline blocks a line breaks even at a no-break space.
 */
const BREAKS = /([^\S\u00a0\u2007\u202f]+)/;

/**
 * Wraps every word of `el` in a `.w` that never breaks, keeping <br> and inline elements, and
 * returns the parts that move, in reading order: each word's `.wi`, or each letter's `.ch`.
 * Words joined by a no-break space are one `.w`. Splitting an element again returns the parts
 * it already has.
 */
export function splitText(el: HTMLElement, unit: "words" | "chars"): HTMLElement[] {
  const part = unit === "words" ? "wi" : "ch";
  if (!el.querySelector(".w")) {
    el.setAttribute("aria-label", el.textContent!.replace(/\s+/g, " ").trim());
    const walk = (node: Node) => {
      for (const child of [...node.childNodes]) {
        if (child instanceof Text) {
          const frag = document.createDocumentFragment();
          for (const piece of child.data.split(BREAKS)) {
            // Spaces stay text between the words, so lines break where they did.
            if (!piece || BREAKS.test(piece)) {
              frag.append(piece);
              continue;
            }
            const word = document.createElement("span");
            word.className = "w";
            word.style.cssText = "display:inline-block;white-space:nowrap";
            word.setAttribute("aria-hidden", "true");
            for (const text of unit === "words" ? [piece] : [...piece]) {
              const span = document.createElement("span");
              span.className = part;
              span.style.display = "inline-block";
              span.textContent = text;
              word.append(span);
            }
            frag.append(word);
          }
          child.replaceWith(frag);
        } else if (child instanceof HTMLElement && child.tagName !== "BR") walk(child);
      }
    };
    walk(el);
  }
  return [...el.querySelectorAll<HTMLElement>(`.${part}`)];
}
