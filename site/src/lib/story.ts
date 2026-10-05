// The facts the page shows and the launch film (dev/launch.astro) shows again: one alert's path
// to production, how a session ends, the signal Bridgetown watches. Kept in one place so the
// two never tell them differently.

import { series } from "./spark";

/** An alert's path, Diagnose to Deploy. Two of its steps are yours. */
export const PATH = [
  { step: "Diagnose" },
  { step: "Fix" },
  { step: "Draft PR" },
  { step: "Second review" },
  { step: "CI" },
  { step: "Review request" },
  { step: "Merge", yours: true },
  { step: "Release", yours: true },
  { step: "Deploy" },
];

/** The 5xx on the broken route over the last hour, rising once the bad deploy landed. */
export const RISE = [...series(40, 12, 3, 9), 14, 22, 41, 63, 71, 69, 74, 72];

/** The agent's fix: each line's number, whether it goes or comes, and its text. */
export const FIX: [number, "" | "del" | "add", string][] = [
  [41, "", "  const query = parseQuery(req)"],
  [42, "del", "- const region = Number(query.region)"],
  [42, "add", "+ if (!query.region) {"],
  [43, "add", '+   return badRequest("region is required")'],
  [44, "add", "+ }"],
  [45, "add", "+ const region = Number(query.region)"],
  [46, "", "  const orders = await findOrders(region)"],
];

/** The four ways a session ends, each with the evidence that says so. */
export const OUTCOMES = [
  { word: "Resolved", dot: "green", evidence: "Deployed api v1.35.12. The release tracker confirmed it at 10:31." },
  { word: "Closed", dot: "grey", evidence: "Root cause not found. Nothing shipped, and the card says so." },
  { word: "Failed", dot: "red", evidence: "e2e failed twice after the fix. Handed back to you with the logs." },
  { word: "Stopped", dot: "grey", evidence: "You stopped it during Fix. Its worktree is kept for you." },
];

const steady = series(33, 11, 2.6, 3);
/** Three hours of API 5xx in five-minute steps: steady, then a rise no alert covers. */
export const SIGNAL = {
  values: [...steady, 38, 64, 71],
  /** Its usual level: the 90th percentile of the steady stretch. */
  usual: [...steady].sort((a, b) => a - b)[Math.floor(steady.length * 0.9)]!,
};

/** What the header watches, a dot each. */
export const SERVICES = ["Slack", "Jev", "GitHub", "Grafana"];
