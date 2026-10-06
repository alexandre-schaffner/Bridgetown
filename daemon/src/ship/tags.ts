import { escapeRegExp } from "../lib/text.ts"

/** Release tags, `<prefix>-vX.Y.Z`: the prefix names what ships (`admin`, `states-exporter`). */

/** What may stand before `-vX.Y.Z` in a release tag. */
const RELEASE_PREFIX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const isReleasePrefix = (prefix: string): boolean => RELEASE_PREFIX.test(prefix)

/** `admin-v0.6.0` → `admin`; a bare prefix stays as it is. */
export const tagPrefix = (tag: string): string => tag.replace(/-v\d+\.\d+\.\d+.*$/, "")

/** The prefix the agent named, as a prefix: a full tag (`admin-v0.6.0`) gives its prefix, nothing or blank gives `null`. */
export const releasePrefixOf = (named: string | null): string | null => {
  const prefix = tagPrefix(named?.trim() ?? "")
  return prefix === "" ? null : prefix
}

const parseVersion = (tag: string, prefix: string): ReadonlyArray<number> | undefined => {
  const match = new RegExp(`^${escapeRegExp(prefix)}-v(\\d+)\\.(\\d+)\\.(\\d+)$`).exec(tag)
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

const compare = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number =>
  (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0)

/**
 * The tag after the highest `<prefix>-vX.Y.Z` in `tags`: a patch bump, or
 * `<prefix>-v0.1.0` for the first release of a prefix.
 */
export const nextTagFrom = (tags: ReadonlyArray<string>, prefix: string): string => {
  const latest = tags
    .map((tag) => parseVersion(tag, prefix))
    .filter((v): v is ReadonlyArray<number> => v !== undefined)
    .sort(compare)
    .at(-1)
  if (latest === undefined) return `${prefix}-v0.1.0`
  return `${prefix}-v${latest[0] ?? 0}.${latest[1] ?? 0}.${(latest[2] ?? 0) + 1}`
}
