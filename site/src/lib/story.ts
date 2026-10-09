// The facts the page tells: one alert's path to production, how a session ends. They follow
// the app's demo data (app/E2E/showcase.json), whose screens the page shows (src/assets/app/),
// so the words and the screens never tell them differently.

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

/** The failed release build the agent starts from: each line's kind, and its text. */
export const BUILD_LOG: ["" | "ok" | "err", string][] = [
  ["", "vite v6.3.5 building for production..."],
  ["ok", "✓ 2418 modules transformed."],
  ["err", "✗ Build failed in 14.2s"],
  ["err", '[vite]: Rollup failed to resolve import "d3-shape/src/curve" from "apps/app/src/components/Sparkline.tsx".'],
];

/** The agent's fix: each line's number, whether it goes or comes, and its text. */
export const FIX: [number, "" | "del" | "add", string][] = [
  [1, "", '  import { scaleLinear } from "d3-scale"'],
  [2, "del", '- import { line } from "d3-shape"'],
  [3, "del", '- import { curveMonotoneX } from "d3-shape/src/curve"'],
  [2, "add", '+ import { curveMonotoneX, line } from "d3-shape"'],
  [3, "", ""],
  [4, "", "  export function Sparkline({ values }: Props) {"],
];

/**
 * The four ways a session ends, each with the evidence that says so, and the app's glyph for it
 * (app/Sources/Bridgetown/Presentation.swift), so no two ends share a mark.
 */
export const OUTCOMES = [
  { word: "Resolved", glyph: "circle-check", tint: "green", evidence: "Deployed app-v2.15.1. The release tracker confirmed it at 10:31." },
  { word: "Closed", glyph: "circle-minus", tint: "grey", evidence: "Root cause not found. Nothing shipped, and the card says so." },
  { word: "Failed", glyph: "octagon-x", tint: "red", evidence: "e2e failed twice after the fix. Handed back to you with the logs." },
  { word: "Stopped", glyph: "circle-stop", tint: "faint", evidence: "You stopped it during Fix. Its worktree is kept for you." },
];
