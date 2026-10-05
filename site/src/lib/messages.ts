// The messages the triage table shows being read. Every route here is what Bridgetown's
// policy gives at the default 75% threshold (scripts/main.ts re-routes them as it moves).

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

/** The triage table, in order. */
export const triageRows: Message[] = [
  {
    kind: "alert",
    from: "#alerts-api",
    who: "Monitor",
    text: "5xx rate 3.1% on /v4/orders over 5 minutes",
    answers: [
      ["Needs action now", 93],
      ["An agent can fix it", 86],
      ["A teammate is on it", 5],
    ],
    route: { label: "Agent starts", dot: "blue" },
  },
  {
    kind: "inbox",
    from: "Direct message",
    who: "Priya",
    text: "Should we ship the pricing change today, or hold it for Monday?",
    answers: [
      ["Waiting on you", 96],
      ["An agent can do it", 4],
      ["Already answered", 2],
    ],
    route: { label: "Needs you", dot: "amber" },
  },
  {
    kind: "inbox",
    from: "#eng-api",
    who: "Jonas",
    text: "@you the orders page 500s when region is empty, can you take a look?",
    answers: [
      ["Waiting on you", 91],
      ["An agent can do it", 78],
      ["Already answered", 3],
    ],
    route: { label: "Agent drafts, you send", dot: "blue" },
  },
  {
    kind: "alert",
    from: "#alerts-billing",
    who: "Monitor",
    text: "Invoice job failed 3 times in a row",
    answers: [
      ["Needs action now", 88],
      ["An agent can fix it", 71],
      ["A teammate is on it", 82],
    ],
    route: { label: "Sam is on it", dot: "grey" },
  },
  {
    kind: "rule",
    from: "#alerts-releases",
    who: "Deploy bot",
    text: "web v2.15.0 deployed to production",
    answers: null,
    note: "Matched a rule: a successful deploy. No model call.",
    route: { label: "Filtered", dot: "grey" },
  },
];
