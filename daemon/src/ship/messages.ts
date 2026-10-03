/**
 * Everything Bridgetown posts in Slack threads, in one place. Each goes out
 * 🤖-prefixed under the user's name (see `SlackThread`), so the wording is theirs
 * to review here.
 */
export const investigating = "Investigating with Bridgetown…"

export const fixPr = (prUrl: string, summary: string): string => `Fix PR: ${prUrl}\n${summary}`

export const noActionNeeded = (summary: string): string => `No action needed: ${summary}`

export const recommendation = (summary: string, detail: string): string => `${summary}\nRecommendation: ${detail}`

export const reviewRequested = (channelName: string, prUrl: string): string => `Review requested in #${channelName}: ${prUrl}`

export const merged = (prUrl: string | null): string => `Merged ${prUrl ?? ""}`.trim()

export const released = (tag: string): string => `Released ${tag}; watching the deploy.`

export const deployed = (what: string): string => `Deployed ${what} ✓`

export const reranJobs = "Re-ran the failed jobs (flaky infrastructure); watching the deploy."
