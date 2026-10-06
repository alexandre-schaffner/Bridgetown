import { Schema } from "effect"
import { type Alert, type AlertKind, AlertKind as AlertKindSchema } from "../domain/alert.ts"

/** What a prod signal rising means, for the watcher's findings when Jev gave no kind. */
const WATCH_KINDS: Readonly<Record<string, AlertKind>> = {
  rpc_errors: "onchain_or_keeper",
  failed_job_pods: "infra_or_cert",
  oom_kills: "infra_or_cert",
  db_waiting: "infra_or_cert",
}

const kindFallback = (alert: Alert): AlertKind => {
  switch (alert.fields._tag) {
    case "release":
      return alert.fields.stages.some((s) => s.name === "Build" && s.status === "failure") ? "build_failure" : "deploy_failure"
    case "uptime":
      return alert.fields.state === "ssl_expiry" ? "infra_or_cert" : "uptime_incident"
    case "engine":
      return "onchain_or_keeper"
    case "watch":
      return WATCH_KINDS[alert.fields.signal] ?? "runtime_error"
    case "inbox":
    case "generic":
      return "runtime_error"
  }
}

const isAlertKind = Schema.is(AlertKindSchema)

/** Jev's kind when it gave an alert kind; otherwise one read from the alert's own fields. Picks the agent's playbook. */
export const alertKind = (alert: Alert): AlertKind => {
  const kind = alert.triage.jev?.kind
  return kind !== undefined && isAlertKind(kind) ? kind : kindFallback(alert)
}
