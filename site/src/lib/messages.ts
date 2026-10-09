// The messages the triage table shows being read. Every route here is what Bridgetown's
// policy gives at the default 75% threshold (Triage.astro re-routes them as it moves).

export type Dot = "blue" | "amber" | "grey";

export interface Message {
  /** What the policy does with it: alerts and inbox items are routed, rules are filtered. */
  kind: "alert" | "inbox" | "rule";
  from: string;
  who: string;
  text: string;
  answers: [string, number][] | null;
  note?: string;
  route: { label: string; dot: Dot };
}

/** The triage table, in order: messages from the app's demo data (app/E2E/showcase.json). */
export const triageRows: Message[] = [
  {
    kind: "alert",
    from: "#alert-dev",
    who: "Monitor",
    text: "merkl-api · 5xx rate 3.1% on /v4/opportunities",
    answers: [
      ["Needs action now", 88],
      ["An agent can fix it", 81],
      ["A teammate is on it", 7],
    ],
    route: { label: "Agent starts", dot: "blue" },
  },
  {
    kind: "inbox",
    from: "Direct message",
    who: "Hugo Lextrait",
    text: "Should we prioritise the sparkline work over the studio revamp?",
    answers: [
      ["Waiting on you", 90],
      ["An agent can do it", 4],
      ["Already answered", 0],
    ],
    route: { label: "Needs you", dot: "amber" },
  },
  {
    kind: "inbox",
    from: "#eng-api",
    who: "Pierre",
    text: "@you can you check why /opportunities 500s when chainId is empty?",
    answers: [
      ["Waiting on you", 84],
      ["An agent can do it", 79],
      ["Already answered", 12],
    ],
    route: { label: "Agent drafts, you send", dot: "blue" },
  },
  {
    kind: "alert",
    from: "#alert-engine",
    who: "Monitor",
    text: "Keeper gas balance low on Gnosis",
    answers: [
      ["Needs action now", 88],
      ["An agent can fix it", 71],
      ["A teammate is on it", 82],
    ],
    route: { label: "Baptiste is on it", dot: "grey" },
  },
  {
    kind: "rule",
    from: "#alert-releases",
    who: "Deploy bot",
    text: "merkl-api v1.35.11 deployed to production",
    answers: null,
    note: "Matched a rule: a successful deploy. No model call.",
    route: { label: "Filtered", dot: "grey" },
  },
];
