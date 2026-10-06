import type { SessionResult } from "../../src/agent/result.ts"
import type { Script, Step, Turn } from "./agent.ts"
import { ASK, pr, RUNNING_NOTE, SESSION } from "./fixtures.ts"

/** What the scripted agent does in each turn. */

const text = (value: string): Step => ({ kind: "text", text: value })
const bash = (command: string): Step => ({ kind: "tool", name: "Bash", input: { command } })
const read = (file: string): Step => ({ kind: "tool", name: "Read", input: { file_path: file } })
const edit = (file: string): Step => ({ kind: "tool", name: "Edit", input: { file_path: file } })

/** Works on the 5xx forever (it never finishes on its own), so activity and the transcript keep moving. */
const running = (extra: boolean): Script => ({
  paceMs: 4_000,
  steps: [
    { kind: "report", phase: "diagnose", note: "Reading the 5xx errors" },
    bash(`bun run scripts/logs.ts --app merkl-api --grep TypeError --since 30m`),
    text("412 errors in 30 minutes, all from `OpportunityService.computeApr` when `campaign.rewardToken` is null."),
    read("packages/api/src/services/opportunity.ts"),
    text("Root cause: campaigns created since v1.35.9 can have a null reward token until their first distribution."),
    { kind: "report", phase: "fix", note: RUNNING_NOTE },
    ...(extra ? [{ kind: "ask", question: "Roll back merkl-api to v1.35.8 while I finish the fix?", options: ["Roll back", "Keep investigating", "Both"] } satisfies Step] : []),
  ],
  loop: [
    edit("packages/api/src/services/opportunity.ts"),
    bash("bun test packages/api --filter apr"),
    text("2 tests fail: the fixture campaign still has a reward token. Updating it."),
    edit("packages/api/src/services/opportunity.apr.test.ts"),
    bash("bun run --filter api typecheck"),
    text("Typecheck and tests pass locally; running the whole API suite to be sure."),
  ],
})

/** Gets stuck on a decision only you can make, asks it (a real answer card, quick replies), then carries on. */
const asking: Script = {
  paceMs: 3_000,
  steps: [
    { kind: "report", phase: "diagnose", note: "Checking the keeper's last root updates on Arbitrum" },
    bash("bun run scripts/keeper-status.ts --chain arbitrum"),
    text("eth_estimateGas has returned 429 from the primary Arbitrum RPC for 2 hours, so every root update attempt fails before it is sent."),
    read("packages/keeper/src/config/rpc.ts"),
    { kind: "ask", question: ASK.question, options: ASK.options },
  ],
  loop: [
    edit("packages/keeper/src/config/rpc.ts"),
    bash("bun test packages/keeper"),
    text("The fallback provider answers eth_estimateGas in 140ms. Preparing the PR."),
    bash("git diff --stat"),
  ],
}

let nextPr = 3360
/** PRs the scripted agents opened this run, so a resumed turn keeps its session's PR. */
const opened = new Map<string, string>()

/** A fix in a PR: the real finalize moves it to CI, and the fake GitHub takes it through checks, review, merge and release. */
const fixed = (prUrl: string, summary: string): Step => ({
  kind: "result",
  costUsd: 0.74,
  output: {
    outcome: "fix_pr",
    rootCauseFound: true,
    diagnosis: summary,
    tried: ["Reproduced it locally", "Checked the last deploys"],
    summary,
    prUrl,
    recommendation: null,
    recommendationDetail: null,
    releasePrefix: "api",
  } satisfies SessionResult,
})

/** A new session (Investigate, a retry from scratch): a short investigation that ends with a PR. */
const investigation = (sessionId: string): Script => {
  const prUrl = pr(nextPr++)
  opened.set(sessionId, prUrl)
  return {
    paceMs: 3_000,
    steps: [
      { kind: "report", phase: "diagnose", note: "Reading the alert and the last deploys" },
      bash("git log --oneline -10 origin/main"),
      text("The failures started with the last deploy of merkl-api; the 504s come from a slow query on /v4/roots/delay."),
      read("packages/api/src/routes/roots/delay.ts"),
      { kind: "report", phase: "fix", note: "Adding the missing index on roots(chain_id, epoch)" },
      edit("packages/db/migrations/0142_roots_index.sql"),
      bash("bun test packages/api --filter roots"),
      bash(`gh pr create --draft --title "fix(api): index roots by chain and epoch"`),
      fixed(prUrl, "A missing index made /v4/roots/delay scan the whole table; added it."),
    ],
  }
}

/** A resumed conversation (your message, a retry): reads what it was sent, then finishes with a PR. */
const resumed = (turn: Turn, prUrl: string | null): Script => ({
  paceMs: 3_000,
  steps: [
    text(`Picking this back up: ${turn.prompt.split("\n")[0]?.slice(0, 160) ?? ""}`),
    bash("git status --short"),
    bash("bun test"),
    fixed(prUrl ?? pr(nextPr++), "Applied the follow-up and pushed it to the PR."),
  ],
})

/** Sent back with the adversarial review's findings: checks them, fixes the real one, pushes to the same PR. */
const addressed = (prUrl: string): Script => ({
  paceMs: 3_000,
  steps: [
    { kind: "report", phase: "fix", note: "Addressing the review findings" },
    text("Checking the reviewer's finding against the code: `pendingOf` does still call `Number(amount)`. It's real."),
    read("packages/api/src/services/reward.ts"),
    edit("packages/api/src/services/reward.ts"),
    edit("packages/api/src/services/reward.test.ts"),
    bash("bun test packages/api --filter reward"),
    bash("git commit -am 'fix(api): parse pending rewards as BigInt' && git push"),
    fixed(prUrl, "Fixed the finding: `pendingOf` parsed pending amounts with Number(); it now uses BigInt, with a regression test for a 2^60 wei amount."),
  ],
})

/** The scripted agent's turns, by session. `prs` are the fixture sessions' PRs, so a resumed one keeps its own. */
export const scriptFor =
  (options: { readonly extra: boolean; readonly prs: ReadonlyMap<string, string | null> }) =>
  (turn: Turn): Script => {
    if (turn.sessionId === SESSION.running && !turn.resume) return running(options.extra)
    if (turn.sessionId === SESSION.ask && !turn.resume) return asking
    const prUrl = options.prs.get(turn.sessionId) ?? opened.get(turn.sessionId) ?? null
    if (turn.resume && prUrl !== null && turn.prompt.startsWith("An independent reviewer")) return addressed(prUrl)
    return turn.resume ? resumed(turn, prUrl) : investigation(turn.sessionId)
  }
