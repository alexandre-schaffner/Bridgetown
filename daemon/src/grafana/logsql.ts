/** LogsQL fragments every query Bridgetown writes shares: the panels', the log sweeps', the deploy list's. */

export const ERROR_LEVELS = `(severity_text:="ERROR" OR severity_text:="FATAL")`
export const WARNING_LEVELS = `(severity_text:="WARN" OR severity_text:="WARNING")`

/**
 * `value` matched literally inside a quoted regex. Routes, images and job names are already limited to
 * `[A-Za-z0-9_./-]`, so `.` is the only metacharacter left; a class matches it without backslashes, which quoted
 * LogsQL and PromQL strings would otherwise reinterpret.
 */
export const regexLiteral = (value: string): string => value.replaceAll(".", "[.]")
