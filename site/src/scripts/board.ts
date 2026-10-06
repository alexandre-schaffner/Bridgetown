// The hero's board: a morning replayed in Bridgetown's own terms. Messages land and Jev reads
// them; agents take what they can finish through diagnosis, a pull request, CI and review; the
// merge and the reply wait for whoever is looking, and a deploy turns green only once the
// tracker confirms it. Rows arrive at the top and the board makes room for them.
//
// It runs only while you can see it (main.ts calls `tick`). The team and services are made up.

type Dot = "blue" | "amber" | "green" | "grey" | "hollow";
type Path = "agent" | "you" | "teammate" | "filtered" | "closed";

interface Stage {
  label: string;
  dot: Dot;
  /** Seconds before the next stage; none for a stage that waits on you, or the last. */
  hold?: number;
  /** The session's step, 1 to 6 (diagnose, fix, PR, CI, review, deploy); 7 when all are done. */
  step?: number;
  /** A button for the one next step, which only you can take. */
  action?: string;
  note?: string;
  live?: boolean;
}

interface Item {
  time: string;
  source: string;
  title: string;
  path: Path;
  /** The stage it starts at, for the rows already on the board. */
  at?: number;
  pr?: number;
  /** When a row already on the board was settled. */
  settled?: string;
}

interface Row {
  item: Item;
  stages: Stage[];
  at: number;
  wait: number;
  el: HTMLElement;
}

export interface Board {
  /** Advance by `dt` seconds of being watched. */
  tick(dt: number): void;
  setPointer(x: number, y: number): void;
}

const ROWS = 6;
const STEPS = ["Diagnose", "Fix", "Pull request", "CI", "Review", "Deploy"];

/** Already on the board at 09:41. */
const START: Item[] = [
  { time: "09:31", source: "#eng-api · Jonas", title: "Orders page 500s when region is empty", path: "agent", at: 6, pr: 3352 },
  { time: "09:22", source: "#alerts-web · Sentry", title: "TypeError in CheckoutSummary, 41 events", path: "agent", at: 4, pr: 3349 },
  { time: "09:05", source: "#alerts-billing · Monitor", title: "Invoice job failed 3 times in a row", path: "teammate", at: 1 },
  { time: "08:47", source: "#alerts-api · Monitor", title: "p95 latency 1.8s on /v4/quotes", path: "agent", at: 8, pr: 3344, settled: "08:58" },
  { time: "08:30", source: "#alerts-db · Monitor", title: "Replica lag 42s on orders-ro-2", path: "closed", at: 2 },
  { time: "08:12", source: "#alerts-releases · Deploy bot", title: "api v1.35.11 deployed to production", path: "filtered" },
];

/** What lands after, in order. */
const ARRIVALS: Item[] = [
  { time: "09:42", source: "#alerts-api · Monitor", title: "5xx rate 3.1% on /v4/orders", path: "agent", pr: 3355 },
  { time: "09:43", source: "Direct message · Priya", title: "Ship the pricing change today, or hold it for Monday?", path: "you" },
  { time: "09:45", source: "#alerts-releases · Deploy bot", title: "web v2.15.0 deployed to production", path: "filtered" },
  { time: "09:47", source: "#alerts-infra · Monitor", title: "Disk 91% on ci-runner-3", path: "agent", pr: 3358 },
  { time: "09:50", source: "#alerts-queue · Monitor", title: "Queue depth 184 on emails", path: "closed" },
];

const READING: Stage = { label: "Jev is reading", dot: "grey", hold: 1.6 };

function stagesOf(item: Item, clock: () => string): Stage[] {
  switch (item.path) {
    case "agent":
      return [
        READING,
        { label: "Agent · Diagnosing", dot: "blue", step: 1, hold: 3, live: true },
        { label: "Agent · Fixing", dot: "blue", step: 2, hold: 3, live: true },
        { label: `PR #${item.pr} open`, dot: "blue", step: 3, hold: 2.6, live: true },
        { label: "CI running", dot: "blue", step: 4, hold: 3.4, live: true },
        { label: "Second review", dot: "blue", step: 5, hold: 3, live: true },
        { label: "Needs you", dot: "amber", step: 6, action: `Merge #${item.pr}` },
        { label: "Deploying", dot: "blue", step: 6, hold: 3.6, live: true },
        { label: "Deployed", dot: "green", step: 7, get note() { return `Tracker confirmed ${item.settled ?? clock()}`; } },
      ];
    case "you":
      return [
        READING,
        { label: "Needs you", dot: "amber", action: "Reply", note: "Waiting on you: 96%" },
        { label: "You replied", dot: "grey", get note() { return `Sent ${clock()}`; } },
      ];
    case "teammate":
      return [READING, { label: "Sam is on it", dot: "grey", note: "A teammate is on it: 82%" }];
    case "filtered":
      return [{ label: "Filtered", dot: "grey", note: "Matched a rule. No model call." }];
    case "closed":
      return [
        READING,
        { label: "Agent · Diagnosing", dot: "blue", step: 1, hold: 4, live: true },
        { label: "Closed, no fix", dot: "hollow", note: "Recovered on its own" },
      ];
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function createBoard(root: HTMLElement, { reducedMotion }: { reducedMotion: boolean }): Board {
  const list = root.querySelector<HTMLElement>("[data-board-rows]")!;
  const clockEl = root.querySelector<HTMLElement>("[data-board-clock]");
  const replay = root.querySelector<HTMLButtonElement>("[data-board-replay]");
  const counts = {
    needs: root.querySelector<HTMLElement>("[data-board-count=needs]"),
    agents: root.querySelector<HTMLElement>("[data-board-count=agents]"),
    done: root.querySelector<HTMLElement>("[data-board-count=done]"),
  };
  const tilt = root.querySelector<HTMLElement>("[data-board-tilt]") ?? root;

  let minute = 9 * 60 + 41;
  let rows: Row[] = [];
  let next = 0;
  let arriveIn = 2.4;
  let minuteIn = 8;
  const pointer = { x: 0, y: 0, ex: 0, ey: 0 };

  const clock = () => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  const ease = "cubic-bezier(0.22, 1, 0.36, 1)";
  const animate = (el: Element, frames: Keyframe[], duration: number, delay = 0) =>
    reducedMotion ? null : el.animate(frames, { duration, delay, easing: ease, fill: "backwards" });

  const rowElement = (item: Item) => {
    const el = document.createElement("li");
    el.className = "row";
    el.innerHTML = `
      <span class="time">${item.time}</span>
      <span class="what"><span class="title">${esc(item.title)}</span><span class="src">${esc(item.source)}</span></span>
      <span class="state">
        <span class="label"><i class="dot"></i><span class="txt"></span></span>
        <span class="sub">
          <span class="track" role="img">${STEPS.map(() => "<i></i>").join("")}</span>
          <button class="act" type="button"></button>
          <span class="note"></span>
        </span>
      </span>`;
    return el;
  };

  /** Draws a row's stage; `animate` crossfades the label when it changes. */
  const paint = (row: Row, animated: boolean) => {
    const s = row.stages[row.at]!;
    const { el } = row;
    const dot = el.querySelector<HTMLElement>(".dot")!;
    const txt = el.querySelector<HTMLElement>(".txt")!;
    dot.className = `dot dot-${s.dot}${s.live ? " live" : ""}`;
    el.dataset.dot = s.dot;
    el.classList.toggle("reading", s === READING);
    if (txt.textContent !== s.label) {
      txt.textContent = s.label;
      if (animated) {
        animate(txt, [{ opacity: 0, transform: "translateY(55%)", filter: "blur(3px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }], 520);
        animate(dot, [{ transform: "scale(0)" }, { transform: "scale(1.5)", offset: 0.5 }, { transform: "none" }], 560);
      }
    }
    // Under the label: your one next step, else the steps while they run, else the evidence.
    const sub = s.action ? "action" : s.step && s.step <= 6 ? "track" : s.note ? "note" : "none";
    el.dataset.sub = sub;
    const track = el.querySelector<HTMLElement>(".track")!;
    if (s.step) {
      track.setAttribute("aria-label", s.step > 6 ? "All six steps done" : `Step ${s.step} of 6: ${STEPS[s.step - 1]}`);
      [...track.children].forEach((seg, i) => {
        const n = i + 1;
        seg.className = n < s.step! ? "done" : n === s.step ? (s.dot === "amber" ? "now-amber" : "now-blue") : "";
      });
    }
    const act = el.querySelector<HTMLButtonElement>(".act")!;
    act.textContent = s.action ?? "";
    act.disabled = !s.action;
    act.tabIndex = s.action ? 0 : -1;
    el.querySelector<HTMLElement>(".note")!.textContent = s.note ?? "";
  };

  const tally = () => {
    let needs = 0;
    let agents = 0;
    let done = 0;
    for (const r of rows) {
      const s = r.stages[r.at]!;
      if (s.dot === "amber") needs++;
      else if (s.dot === "blue") agents++;
      else if (s.dot === "green") done++;
    }
    for (const [k, v] of [["needs", needs], ["agents", agents], ["done", done]] as const) {
      const el = counts[k];
      if (!el || el.textContent === String(v)) continue;
      el.textContent = String(v);
      animate(el, [{ opacity: 0, transform: "translateY(50%)" }, { opacity: 1, transform: "none" }], 420);
    }
    if (clockEl && clockEl.textContent !== clock()) clockEl.textContent = clock();
  };

  const advance = (row: Row) => {
    row.at++;
    row.wait = row.stages[row.at]!.hold ?? Infinity;
    paint(row, true);
    tally();
  };

  const add = (item: Item, animated: boolean) => {
    const el = rowElement(item);
    const row: Row = { item, stages: stagesOf(item, clock), at: item.at ?? 0, wait: 0, el };
    row.wait = row.stages[row.at]!.hold ?? Infinity;
    el.querySelector(".act")!.addEventListener("click", () => {
      if (!row.stages[row.at]!.action) return;
      advance(row);
    });
    paint(row, false);

    // FLIP: everything below moves down to make room, from where it was.
    const before = new Map(rows.map((r) => [r.el, r.el.offsetTop]));
    list.prepend(el);
    rows.unshift(row);
    if (animated) {
      for (const r of rows.slice(1)) {
        const dy = before.get(r.el)! - r.el.offsetTop;
        if (dy) animate(r.el, [{ transform: `translateY(${dy}px)` }, { transform: "none" }], 700);
      }
      animate(el, [{ opacity: 0, transform: "translateY(-30%)", filter: "blur(6px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }], 700, 120);
    }
    // No room: the oldest settled row goes, a verified outcome last; what waits on you stays.
    while (rows.length > ROWS) {
      const settled = (r: Row) => r.wait === Infinity && !r.stages[r.at]!.action;
      let i = rows.findLastIndex((r) => settled(r) && r.stages[r.at]!.dot !== "green");
      if (i < 0) i = rows.findLastIndex(settled);
      if (i < 0) i = rows.findLastIndex((r) => !r.stages[r.at]!.action);
      const [gone] = rows.splice(i < 0 ? rows.length - 1 : i, 1);
      const out = animate(gone!.el, [{ opacity: 1 }, { opacity: 0 }], 300);
      if (out) out.onfinish = () => gone!.el.remove();
      else gone!.el.remove();
    }
    tally();
  };

  const reset = () => {
    list.replaceChildren();
    rows = [];
    next = 0;
    minute = 9 * 60 + 41;
    minuteIn = 8;
    arriveIn = 2.4;
    if (replay) replay.hidden = true;
    for (const item of [...START].reverse()) add(item, false);
    animate(list, [{ opacity: 0 }, { opacity: 1 }], 500);
  };

  replay?.addEventListener("click", reset);
  reset();

  return {
    tick(dt) {
      // The board's clock runs at a minute every few seconds of watching.
      minuteIn -= dt;
      if (minuteIn <= 0) {
        minute++;
        minuteIn = 8;
        if (clockEl) clockEl.textContent = clock();
      }
      arriveIn -= dt;
      if (arriveIn <= 0 && next < ARRIVALS.length) {
        const item = ARRIVALS[next++]!;
        minute = Math.max(minute, Number(item.time.slice(0, 2)) * 60 + Number(item.time.slice(3)));
        add(item, true);
        arriveIn = 6.5;
      }
      let busy = next < ARRIVALS.length;
      for (const r of rows) {
        if (r.wait === Infinity) continue;
        busy = true;
        r.wait -= dt;
        if (r.wait <= 0) advance(r);
      }
      if (replay && !busy && replay.hidden) replay.hidden = false;

      // The board leans a little toward the pointer.
      if (!reducedMotion) {
        const k = 1 - Math.exp(-dt * 4);
        pointer.ex += (pointer.x - pointer.ex) * k;
        pointer.ey += (pointer.y - pointer.ey) * k;
        tilt.style.transform = `perspective(1600px) rotateX(${(-pointer.ey * 2.2).toFixed(3)}deg) rotateY(${(pointer.ex * 3.2).toFixed(3)}deg)`;
      }
    },
    setPointer(x, y) {
      pointer.x = x;
      pointer.y = y;
    },
  };
}
