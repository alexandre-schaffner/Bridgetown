import { GH_HOST, GHE_REPO } from "../config.ts"
import { escapeRegExp } from "../lib/text.ts"

/** Pull request links: what one is, which one, and where else it opens. */

const PR_URL = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)/
const OWN_PR = new RegExp(`^https://${escapeRegExp(GH_HOST)}/${escapeRegExp(GHE_REPO)}/pull/(\\d+)(?:[/?#].*)?$`)
const GHE_PR = new RegExp(`https://${escapeRegExp(GH_HOST)}/[\\w.-]+/[\\w.-]+/pull/\\d+`)

/** The number of any pull request link (`…/pull/3244`, `…/pull/3244/files`), or `null`. */
export const prNumber = (prUrl: string): string | null => /\/pull\/(\d+)(?:[/?#]|$)/.exec(prUrl)?.[1] ?? null

/** "#3244" for a PR link; a link that is not one stays as it is. */
export const prLabel = (prUrl: string): string => {
  const number = prNumber(prUrl)
  return number === null ? prUrl : `#${number}`
}

/** Revv's PR deep link (`packages/shared/src/pr-deep-link.ts` in revv): opens the PR walkthrough. */
export const revvLink = (prUrl: string): string | null => {
  const match = PR_URL.exec(prUrl)
  if (match === null) return null
  const params = new URLSearchParams({ host: (match[1] ?? GH_HOST).toLowerCase(), repo: match[2] ?? "", number: match[3] ?? "" })
  return `revv://pr?${params.toString()}`
}

/** The first link to a pull request on GHE in `text`, or `null`. */
export const findPrUrl = (text: string): string | null => GHE_PR.exec(text)?.[0] ?? null

/**
 * The agent's PR link as the PR's own URL, if it is a pull request on the repo Bridgetown ships (a link
 * into one, like its files tab, counts): anything else (another repo's PR, a teammate's link from an
 * untrusted Slack message, a non-https URL) is no PR. The merge card runs `gh pr merge` on it with your
 * credentials.
 */
export const ownPrUrl = (url: string | null | undefined): string | null => {
  const number = url === null || url === undefined ? undefined : OWN_PR.exec(url)?.[1]
  return number === undefined ? null : `https://${GH_HOST}/${GHE_REPO}/pull/${number}`
}
