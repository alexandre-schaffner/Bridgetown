import { Effect } from "effect"
import type { ReviewerShape } from "../../src/critique/reviewer.ts"
import type { JevVerdict } from "../../src/domain/alert.ts"
import { MissingCredential } from "../../src/domain/errors.ts"
import type { GrafanaShape } from "../../src/grafana/client.ts"
import type { AgentShape } from "../../src/sessions/agent.ts"
import type { GitHubShape } from "../../src/ship/github.ts"
import type { SlackClientShape, SlackMessage } from "../../src/slack/client.ts"
import type { JevShape } from "../../src/jev.ts"

/**
 * The outside world, faked for the tests and the mock daemon. Each fake takes the methods a caller is about and
 * answers the rest plainly; Jev's unasked questions die, so a test that reaches one it did not expect says so.
 */

/** A call nobody expected. */
const unused = () => Effect.die("unused")

/** Slack where you are `UME`, nothing has been posted, and every post goes through. */
export const fakeSlack = (overrides: Partial<SlackClientShape> = {}): SlackClientShape => ({
  identity: () => Effect.succeed({ user_id: "UME", user: "me", url: "https://merkl.slack.com/" }),
  latest: () => Effect.succeed([]),
  replies: () => Effect.succeed([]),
  permalink: (channel, ts) => Effect.succeed(`https://merkl.slack.com/archives/${channel}/p${ts.replace(".", "")}`),
  search: () => Effect.succeed([]),
  groupsOf: () => Effect.succeed([]),
  userName: (id) => Effect.succeed(id),
  post: () => Effect.succeed("1.000001"),
  remove: () => Effect.void,
  ...overrides,
})

/** `latest` for a Slack where only `channel` has anything in it: `messages()`, read on each call. */
export const postedIn =
  (channel: string, messages: () => ReadonlyArray<SlackMessage>): SlackClientShape["latest"] =>
  (asked) =>
    Effect.sync(() => (asked === channel ? messages() : []))

/** A confident "an agent can fix this build failure" unless `overrides` say otherwise. */
export const verdict = (overrides: Partial<JevVerdict> = {}): JevVerdict => ({
  actionable: 0.95, agentResolvable: 0.9, humanOnIt: 0.01, kind: "build_failure", kindConfidence: 0.9, depth: "quick", urgency: 1, ...overrides,
})

/** Jev that answers only the questions given. */
export const fakeJev = (overrides: Partial<JevShape> = {}): JevShape => ({
  judge: unused,
  judgeInbox: unused,
  judgeFinding: unused,
  judgeLogPatterns: unused,
  ...overrides,
})

const noKey = () => Effect.fail(new MissingCredential({ service: "jev", message: "no TypeSafe API key" }))

/** Jev before a TypeSafe key is added: every question fails as it does then. */
export const noJev: JevShape = { judge: noKey, judgeInbox: noKey, judgeFinding: noKey, judgeLogPatterns: noKey }

/** GitHub with no pull request to show, where writes succeed and change nothing, no tag exists yet and GHE is reachable. */
export const fakeGitHub = (overrides: Partial<GitHubShape> = {}): GitHubShape => ({
  viewPr: () => Effect.die("no PR"),
  mergePr: () => Effect.void,
  rerunFailedJobs: () => Effect.void,
  nextPatchTag: (_repo, prefix) => Effect.succeed(`${prefix}-v0.0.1`),
  tagExists: () => Effect.succeed(false),
  createRelease: () => Effect.void,
  branchHead: () => Effect.succeed(null),
  prHead: () => Effect.succeed(null),
  markReady: () => Effect.void,
  reachability: Effect.succeed("ok"),
  ...overrides,
})

/** Grafana that answers every query with no series and no rows. */
export const noGrafana: GrafanaShape = {
  reachable: Effect.succeed(true),
  prom: () => Effect.succeed([]),
  logStats: () => Effect.succeed([]),
  logRows: () => Effect.succeed([]),
}

/** An agent SDK that a test did not expect to start a turn on. */
export const noAgent: AgentShape = {
  query: () => {
    throw new Error("no agent: this world starts no turn")
  },
}

/** A reviewer that a test did not expect to review anything. */
export const noReviewer: ReviewerShape = { review: unused }
