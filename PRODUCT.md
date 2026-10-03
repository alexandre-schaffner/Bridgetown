# Product

## Register

product

## Users

One engineer at Merkl (DeFi incentives) who sits in a dozen Slack alert channels and is the person teammates tag. They work in an editor or a terminal and glance at the menu bar between tasks: a few seconds to see what the agents are doing and what is waiting on them, then back to their own work. They act from the popover only for the human gates: investigate, merge, cut a release, send a reply, answer an agent's question.

## Product Purpose

Bridgetown watches Slack (alert channels, mentions, DMs) and asks Jev whether each item should go to a Claude agent or to the user. Agents diagnose, fix, open a PR, get CI green, request review, and follow the deploy. Success is fewer context switches without loss of trust: the user can believe every word on screen without opening Slack, GitHub or the logs to check.

## Brand Personality

Calm, precise, honest. Like a flight-status board or Things: quiet, exact, and never claiming more than happened. The voice is plain and specific ("Root cause not found", "PR #3340 open, CI running"), never cheerful or vague. Color is reserved for meaning: accent for live work, green only for verified outcomes, orange for "needs you", red for failure. Everything else is neutral.

## Anti-references

- Generic SaaS dashboards: hero metrics, gradients, card grids, decorative color.
- Optimistic status theater: checkmarks, filled progress or "Resolved" for steps that did not happen. A closed or abandoned session must never look like a success.
- Noisy notification centers: badges and red everywhere, everything urgent.
- Agent transcript dumps as the primary UI.

## Design Principles

1. **Show only what is true.** State comes from evidence (a PR that exists, a check that passed, a deploy the tracker confirmed), never from what the agent intended or what the user dismissed.
2. **Distinguish outcomes.** Resolved, closed without a fix, failed and stopped are different facts and look different.
3. **Quiet by default, loud when it matters.** Neutral surfaces; color and motion only for live work and things that need the user.
4. **One glance, one decision.** Each card says what happened and offers the single next action as a verb plus object.
5. **Native first.** Behave like a first-party macOS utility: system materials, SF Pro, standard controls.

## Accessibility & Inclusion

WCAG AA contrast for all text, including secondary text on materials. Status is never conveyed by color alone (always a label or glyph too). Respect Reduce Motion: pulses become static. Works in light and dark appearance.
