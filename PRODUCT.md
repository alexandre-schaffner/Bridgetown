# Product

## Register

product

## Users

One engineer at Merkl (DeFi incentives) who sits in a dozen Slack alert channels and is the person teammates tag. They work in an editor or a terminal and glance at the notch between tasks: a few seconds to see what the agents are doing and what is waiting on them, then back to their own work. They open the island only for the human gates: investigate, merge, cut a release, send a reply, answer an agent's question.

## Product Purpose

Bridgetown watches Slack (alert channels, mentions, DMs) and asks Jev whether each item should go to a Claude agent or to the user. Agents diagnose, fix, open a PR, get CI green, request review, and follow the deploy. Success is fewer context switches without loss of trust: the user can believe every word on screen without opening Slack, GitHub or the logs to check.

## Brand Personality

Calm, precise, honest. Like a flight-status board or the Vercel dashboard: black, exact, and never claiming more than happened. The voice is plain and specific ("Root cause not found", "PR #3340 open, CI running"), never cheerful or vague. Color is reserved for meaning, on small status marks only: blue for live work, green only for verified outcomes, amber for "needs you", red for failure. Data, finished steps and controls are monochrome, except that amber also marks the one thing in the data worth a look: a spike in a chart, a suspicious log pattern.

## Anti-references

- Generic SaaS dashboards: hero metrics, gradients, card grids, decorative color.
- Optimistic status theater: checkmarks, filled progress or "Resolved" for steps that did not happen. A closed or abandoned session must never look like a success.
- Noisy notification centers: badges and red everywhere, everything urgent.
- Agent transcript dumps as the primary UI.

## Design Principles

1. **Show only what is true.** State comes from evidence (a PR that exists, a check that passed, a deploy the tracker confirmed), never from what the agent intended or what the user dismissed.
2. **Distinguish outcomes.** Resolved, closed without a fix, failed and stopped are different facts and look different.
3. **Quiet by default, loud when it matters.** Neutral surfaces; color and motion only for live work and things that need the user.
4. **One glance, one decision.** Each row says what happened, and a decision offers the single next action as a verb plus object.
5. **One identity.** A black stage, structure drawn with one-pixel outlines rather than fills, rows separated by hairlines like a table, Geist for words and Geist Mono for machine text (times, branches, logs), a white button for the one next step. Behave like a macOS utility (an island in the notch, keyboard, context menus); look like Bridgetown.

## Accessibility & Inclusion

WCAG AA contrast for all text: the three text greys are 16:1, 7.6:1 and 5.5:1 on black. Status is never conveyed by color alone (always a label or glyph too). Respect Reduce Motion: pulses become static and nothing slides, scales or blurs. The island and a detail fade in, a tab's fill is simply there, and a link's glyph holds still. Live marks also hold still over the last update while the daemon is away, and out of sight. The island is always dark; Settings follows the system appearance.
