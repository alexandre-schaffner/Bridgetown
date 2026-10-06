/** Plain text helpers, for anything Bridgetown writes: status lines, history, findings, prompts. */

export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`

/** On one line (every run of whitespace a single space), then truncated. */
export const oneLine = (text: string, max: number): string => truncate(text.replace(/\s+/g, " ").trim(), max)

/** First line with content, skipping bare group pings like `<!subteam^S0AV…>` that Grafana alerts lead with. */
export const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && !/^(<!(subteam\^[A-Z0-9]+|here|channel)(\|[^>]*)?>\s*)+$/.test(line)) ?? ""

/** A fraction as a whole percentage: 0.873 → "87%". */
export const pct = (value: number): string => `${Math.round(value * 100)}%`

/** "1 round", "3 rounds". */
export const plural = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`)

/** "14:05 UTC". */
export const clock = (date: Date): string => `${date.toISOString().slice(11, 16)} UTC`

/** `text` matched literally inside a regular expression. */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
