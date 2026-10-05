<div align="center">

# Bridgetown

**From Slack alert to reviewed fix. Right in your Mac’s notch.**

Claude investigates. Codex reviews. You make the call.

[Try the demo](#try-it-locally) · [Set it up](#connect-your-workspace) · [How it works](docs/WORKFLOW.md)

</div>

![Bridgetown overview in a MacBook mockup, showing production signals, decisions waiting on you, and active agents](docs/images/bridgetown-overview.png)

Bridgetown is a macOS notch app. It watches Slack alerts, mentions, and DMs, gives the work an agent can handle to Claude, and brings the decisions that need you to the surface. Agents investigate in separate worktrees, prepare fixes, and follow them through review, CI, and deployment. You approve merges, releases, and replies.

Built for macOS with SwiftUI and a local Bun + Effect daemon. Currently tailored to Merkl’s Slack, GitHub Enterprise, and Grafana workflows.

## One glance. One decision.

- **Prod:** API errors, latency, infrastructure, database health, and log patterns in one view. Investigations can start from Grafana findings as well as Slack.
- **Needs you:** answer an agent, investigate an alert, merge a reviewed fix, cut a release, or send a prepared reply.
- **Agents:** see the current step, latest activity, and outcome of each session. Open one to inspect its work or take over in Terminal.

The notch shows running agents and decisions waiting on you. Click it to expand Bridgetown from the notch itself, leaving your desktop visible around it. On a Mac without one, it sits at the top centre of the display. Blue marks live work, amber marks a decision, and green marks a verified outcome.

## From alert to deployment

Jev triages each item after deterministic rules filter routine notices and duplicates. Work goes to an agent, becomes a suggestion, or waits for you.

```text
Slack alerts + mentions + DMs     Grafana metrics + logs
              └──────────────────┬──────────────────┘
                           Rules + Jev
                                │
                      Claude in its own worktree
                                │
                      Draft PR → Codex review → CI
                                │
                      You: merge → cut release
                                │
                      Track the production deploy
```

Codex reviews the fix before the PR leaves draft. Blocking findings return to the same Claude session for a fix or an evidence-backed rebuttal. The app keeps resolved, closed without a fix, failed, and stopped sessions distinct.

![Bridgetown session in a MacBook mockup, with a reviewed pull request ready to merge and production charts beside it](docs/images/bridgetown-session.png)

<sub>Both app captures use local demo data. The MacBook frames are generated mockups.</sub>

## Try it locally

You need **macOS 14 or later**, **Swift 6 / Xcode Command Line Tools**, **Bun**, and **Git**. The demo needs no Slack token or AI account: Slack, Jev, agents, GitHub, and Grafana use local fixtures.

```sh
git clone https://github.com/alexandre-schaffner/Bridgetown.git
cd Bridgetown
bun install --cwd daemon
make mock
```

Leave the mock daemon running. In a second terminal, from the repository root:

```sh
make dev-app
```

Click the notch to open the app. The demo includes running investigations, questions, review and CI states, merge and release gates, and completed sessions. Actions run against the local mock services.

For the app in a regular window:

```sh
make dev-app ARGS=--preview-window
```

## Connect your workspace

The current integration targets `Merkl/monorepo` on `nocturlab.ghe.com`. Repository paths and watched channels are configurable in Settings; GitHub targets, alert parsers, and production queries still contain Merkl-specific defaults. See [daemon/src/config.ts](daemon/src/config.ts) before adapting it to another team.

1. **Slack:** create a personal Slack app from [slack-app-manifest.yml](slack-app-manifest.yml), install it, and copy the `xoxp-…` user token.
2. **Jev:** get a TypeSafe API key for triage.
3. **Agent tools:** install and sign in to `claude`, `codex`, and `gh`. Verify GitHub Enterprise access with `gh auth status --hostname nocturlab.ghe.com`. Set `BRIDGETOWN_CODEX_PATH` if Codex isn’t on the app’s PATH.
4. **MCP:** run `claude mcp login merkl`. For production signals and logs, run `bun grafana:mcp` in the Merkl monorepo.
5. **Build:** stop the demo daemon, then assemble and open the app:

   ```sh
   make all
   open build/Bridgetown.app
   ```

Open **Settings** from the app’s **…** menu. Save the Slack and TypeSafe tokens under **Accounts**, set the checkout paths under **Repos**, and choose channels and triage thresholds. Tokens are stored in macOS Keychain.

**Dry run is on by default.** It suppresses Slack posts; agents can still run and prepare PRs. Turn off **Start agents automatically** under **Triage** to keep candidates waiting for your decision.

## You keep the controls

Each agent gets its own Git worktree. The command guard restricts production operations and pushes, and file-edit tools are confined to that worktree. The daemon strips its Slack and TypeSafe credentials from spawned processes.

Merging, cutting releases, and sending prepared replies require your click. Production environment approval remains with the reviewer team. Slack content is treated as untrusted input.

The guard has limits: it cannot inspect every operation inside interpreter-run code or shell writes. [The workflow reference](docs/WORKFLOW.md#safety-model) documents the boundaries and backstops.

## Develop

Run these from the repository root:

| Command | Purpose |
| --- | --- |
| `make mock` | Start the daemon with local demo services |
| `make dev-app` | Attach the SwiftUI app to the running daemon |
| `make all` | Compile the daemon and assemble `build/Bridgetown.app` |
| `make test-app` | Run Swift tests |
| `bun test --cwd daemon` | Run daemon tests |
| `bun run --cwd daemon check` | Type-check the daemon |
| `bun install --cwd site` | Install landing-page dependencies |
| `bun run --cwd site dev` | Start the Astro landing page |

To update the README visuals, see the [screenshot capture guide](docs/images/README.md).

## Inside the repository

| Path | What lives here |
| --- | --- |
| [app/](app/) | SwiftUI app, notch interface, Keychain storage, daemon lifecycle |
| [daemon/](daemon/) | Slack ingestion, triage, agent sessions, Codex review, shipping, Grafana monitoring |
| [site/](site/) | Astro landing page, three.js visuals, and product recordings |
| [docs/API.md](docs/API.md) | Local HTTP/SSE contract between the app and daemon |
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | Decision policy, safety boundaries, and Slack posting behavior |
| [PRODUCT.md](PRODUCT.md) | Product purpose and design principles |
