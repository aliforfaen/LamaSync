// LAMA-345 — Folders page health presentation.
//
// Pure helpers so the card's decisions are unit-testable without a DOM:
// which actions a record offers, how staleness is worded, and how a reviewed
// plan's validity is explained. The state/reason vocabulary itself lives in
// @lamasync/core/folder-health — one contract shared by the daemon, the
// server and this UI.

import {
  describeBootstrapAuthority,
  describeFolderHealthAction,
  describeFolderHealthState,
  type FolderBootstrapAuthority,
  type FolderHealthActionId,
  type FolderHealthRecord,
  type FolderHealthState,
  type FolderPlanWithValidity,
} from "@lamasync/core/folder-health";

export type HealthTone = "ok" | "warn" | "bad" | "info";

/** CSS tone for a state. Colour is never the only signal — the card always
 *  shows the state word and the reason sentence beside it. */
export function healthTone(state: FolderHealthState): HealthTone {
  switch (state) {
    case "healthy":
      return "ok";
    case "busy":
      return "info";
    case "new_host":
    case "recoverable":
      return "warn";
    case "resync_required":
    case "unsafe":
    case "blocked":
      return "bad";
    case "unknown":
      return "info";
  }
}

export function healthLabel(state: FolderHealthState): string {
  return describeFolderHealthState(state);
}

/**
 * Actions the health card may offer for this record.
 *
 * Gating rules (the "intervention gates" the acceptance criteria name):
 *   - Diagnose is always available.
 *   - Planning and the reseeding operations are for bisync (`sync`) only.
 *   - Sync now requires a *valid paired baseline*; without one the operator
 *     must initialize or seed instead — that is the whole point of the change.
 *   - Resync is offered when the baseline needs rebuilding, and Resume when
 *     the run merely stopped.
 *   - Cancel is only offered while something is actually running.
 *   - Nothing mutating is offered while a run is in flight.
 */
export function availableHealthActions(
  record: Pick<FolderHealthRecord, "state" | "facts" | "active">,
): FolderHealthActionId[] {
  const actions: FolderHealthActionId[] = ["diagnose"];
  const isBisync = record.facts.effectiveType === "sync";
  if (!isBisync) return actions;

  // A blocked assignment cannot run anything: the precondition (missing or
  // unwritable path, no disk space, paused, disabled, rclone absent) would
  // fail the run. Diagnose is the honest offer.
  if (record.state === "blocked" || record.state === "unknown") return actions;

  actions.push("plan");
  if (record.active || record.state === "busy") {
    actions.push("cancel");
    return actions;
  }

  const baselineReady = record.facts.baseline.ready;
  if (baselineReady) {
    actions.push("sync");
  } else {
    actions.push("initialize", "seed");
  }
  // "Reseed baseline" is always available for a bisync assignment — an
  // operator may want to rebuild a baseline that rclone still considers
  // usable — and it is the guarded path (plan + explicit authority + confirm).
  actions.push("resync");
  if (record.state === "recoverable") {
    actions.push("resume");
  }
  return actions;
}

/** Actions that must go through the guided review modal. */
export function isGuardedAction(action: FolderHealthActionId): boolean {
  return action === "initialize" || action === "seed" || action === "resync";
}

/** The authority a guarded action will use, or null when it is not guarded. */
export function authorityForAction(
  action: FolderHealthActionId,
  chosen: FolderBootstrapAuthority,
): FolderBootstrapAuthority | null {
  switch (action) {
    case "initialize":
      return "remote";
    case "seed":
      return "local";
    case "resync":
      return chosen;
    default:
      return null;
  }
}

export function authorityWording(authority: FolderBootstrapAuthority): {
  short: string;
  long: string;
} {
  return describeBootstrapAuthority(authority);
}

export function actionLabel(action: FolderHealthActionId): string {
  return describeFolderHealthAction(action);
}

/** Compact "how fresh is this" sentence. Never implies an old value is now. */
export function freshnessSentence(
  record: Pick<FolderHealthRecord, "reportedAt" | "stale" | "stalenessMs" | "measurementAgeMs">,
  now: number = Date.now(),
): string {
  const age = record.stalenessMs ?? Math.max(0, now - record.reportedAt);
  const relative = relativeMinutes(age);
  if (record.stale) return `Last checked ${relative} ago — stale`;
  return `Checked ${relative} ago`;
}

/** Deep measurement freshness, said separately so it cannot be mistaken for
 *  the report's freshness. */
export function measurementSentence(
  record: Pick<FolderHealthRecord, "measurementAgeMs" | "facts">,
): string | null {
  if (record.facts.measurement === null) return null;
  const age = record.measurementAgeMs;
  if (age === null) return "Measured (age unknown)";
  return `Measured ${relativeMinutes(age)} ago`;
}

export function relativeMinutes(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/** Baseline readiness wording (paired listing set, or what is missing). */
export function baselineSentence(
  record: Pick<FolderHealthRecord, "facts">,
): string {
  const b = record.facts.baseline;
  if (b.error) return "Baseline unusable — rclone recorded a critical error";
  if (!b.present) return "No baseline yet — this device has never completed a sync";
  if (!b.ready) return "Baseline incomplete — a listing is missing or still being written";
  if (b.path1Count !== null && b.path2Count !== null) {
    return `Baseline paired (remote ${b.path1Count} · local ${b.path2Count})`;
  }
  return "Baseline paired";
}

/** Filter-universe wording. */
export function filterSentence(record: Pick<FolderHealthRecord, "facts">): string {
  const f = record.facts.filter;
  const source =
    f.source === "combined"
      ? "Git ignore rules + .lamasyncignore"
      : f.source === "gitignore"
        ? "Git ignore rules"
        : f.source === "lamasyncignore"
          ? ".lamasyncignore"
          : "no ignore file";
  if (f.changedSinceBaseline) return `${source} — changed since the last baseline`;
  return source;
}

/** Watcher wording: "asked for" and "actually running" are never conflated. */
export function watcherSentence(record: Pick<FolderHealthRecord, "facts">): string | null {
  const w = record.facts.watcher;
  if (!w || !w.enabled) return null;
  if (w.running) return `Watcher running (quiet ${w.quietSec ?? 30}s)`;
  return "Watcher requested but not running";
}

/** Sentence for a reviewed plan's validity. */
export function planValiditySentence(entry: FolderPlanWithValidity): string {
  if (entry.validity.valid) return "This plan is current.";
  return entry.validity.message;
}

export function planAuthoritySentence(entry: FolderPlanWithValidity): string {
  return authorityWording(entry.plan.authority).short;
}
