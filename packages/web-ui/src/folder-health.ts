// LAMA-345 — Folders page health presentation.
//
// Pure helpers so the card's decisions are unit-testable without a DOM:
// which actions a record offers, how staleness is worded, how a plan's totals
// and samples are separated, and how the wizard's state is derived. The
// state/reason vocabulary itself lives in @lamasync/core/folder-health — one
// contract shared by the daemon, the server and this UI.

import {
  BISYNC_MAX_DELETE_PERCENT_DEFAULT,
  checkPlanSemantics,
  describeFolderHealthState,
  FOLDER_PLAN_CHANGE_CAP,
  type FolderBootstrapAuthority,
  type FolderHealthActionId,
  type FolderHealthRecord,
  type FolderHealthState,
  type FolderPlanWithValidity,
  type FolderSyncPlan,
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
 * Planning is deliberately NOT an action of its own: a plan only means
 * something attached to the operation it previews, so every reseeding action
 * builds its own plan inside the guided flow.
 *
 * Gating rules (the "intervention gates" the acceptance criteria name):
 *   - Checking the device is always available.
 *   - The reseeding operations are for bisync (`sync`) only.
 *   - Sync now requires a *valid paired baseline*; without one the operator
 *     must set the device up from the remote or fill the remote from it.
 *   - Rebuild is offered when the baseline needs rebuilding.
 *   - Continue is offered when a run merely stopped.
 *   - Stop is only offered while something is actually running.
 *   - Nothing mutating is offered while blocked/unknown or already running.
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

  if (record.active || record.state === "busy") {
    actions.push("cancel");
    return actions;
  }

  if (record.facts.baseline.ready) {
    actions.push("sync");
  } else {
    actions.push("initialize", "seed");
  }
  // "Rebuild the sync baseline" is always available for a bisync assignment —
  // an operator may want to rebuild a baseline rclone still considers usable —
  // and it is the guarded path (plan + chosen side + confirmation).
  actions.push("resync");
  if (record.state === "recoverable") {
    actions.push("resume");
  }
  return actions;
}

/** Actions that must go through the guided review wizard. */
export function isGuardedAction(action: FolderHealthActionId): boolean {
  return action === "initialize" || action === "seed" || action === "resync";
}

/** Actions that need a small explanatory confirmation rather than a wizard. */
export function needsSimpleConfirm(action: FolderHealthActionId): boolean {
  return action === "resume" || action === "cancel";
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

/** True when the operator may pick the winning side (only a rebuild may). */
export function actionChoosesAuthority(action: FolderHealthActionId): boolean {
  return action === "resync";
}

export function authorityWording(authority: FolderBootstrapAuthority): {
  short: string;
  long: string;
  conflict: string;
} {
  // Local copy of the core wording, kept here so the UI can render it without
  // importing the barrel (which pulls node built-ins into the bundle).
  return authority === "remote"
    ? {
        short: "The remote wins conflicting files",
        long: "Files that exist on only one side are copied to the other side. When the same file was changed on both sides, the remote's version is kept and this device's version is set aside.",
        conflict: "Same file changed on both sides → the remote's version is kept.",
      }
    : {
        short: "This device wins conflicting files",
        long: "Files that exist on only one side are copied to the other side. When the same file was changed on both sides, this device's version is kept and the remote's version is set aside.",
        conflict: "Same file changed on both sides → this device's version is kept.",
      };
}

/**
 * Plain-language primary label. rclone's Path 1/Path 2 vocabulary belongs in
 * `technicalDetails`, not on the button the operator reads first.
 */
export function actionLabel(action: FolderHealthActionId): string {
  switch (action) {
    case "diagnose":
      return "Check this device now";
    case "plan":
      return "Preview changes";
    case "sync":
      return "Sync now";
    case "initialize":
      return "Set up this device from the remote";
    case "seed":
      return "Fill the remote from this device";
    case "resync":
      return "Rebuild the sync baseline";
    case "resume":
      return "Continue the interrupted sync";
    case "cancel":
      return "Stop current run";
  }
}

/**
 * Visual weight. "Check this device now" and "Sync now" must never look like
 * the destructive/rebaseline path.
 */
export function actionTone(action: FolderHealthActionId): "primary" | "neutral" | "danger" {
  switch (action) {
    case "sync":
      return "primary";
    case "diagnose":
      return "neutral";
    case "resync":
    case "cancel":
      return "danger";
    case "initialize":
    case "seed":
    case "resume":
    case "plan":
      return "neutral";
  }
}

/** Why this action builds a plan — the plan's purpose, in one sentence. */
export function actionPurpose(action: FolderHealthActionId): string {
  switch (action) {
    case "initialize":
      return "You will see exactly what would be copied and deleted before anything runs.";
    case "seed":
      return "You will see exactly what would be copied and deleted before anything runs.";
    case "resync":
      return "You will see exactly what would be copied and deleted before the sync baseline is rebuilt.";
    default:
      return "";
  }
}

/**
 * The optional technical-details sentence: rclone terminology and the
 * authority mapping, for operators who want it. Never the primary copy.
 */
export function technicalDetails(
  action: FolderHealthActionId,
  authority: FolderBootstrapAuthority,
  maxDeletePercent: number | null,
): string[] {
  const lines: string[] = [];
  if (isGuardedAction(action)) {
    lines.push(
      "LamaSync runs `rclone bisync <remote> <local>`: the remote is Path 1 and this device is Path 2.",
    );
    if (action === "initialize") {
      lines.push("This operation uses `--resync --resync-mode path1` (Path 1 authority).");
    } else if (action === "seed") {
      lines.push("This operation uses `--resync --resync-mode path2` (Path 2 authority).");
    } else {
      lines.push(
        `This operation uses \`--resync --resync-mode ${
          authority === "local" ? "path2" : "path1"
        }\` (${authority === "local" ? "Path 2" : "Path 1"} authority).`,
      );
    }
    lines.push(
      `Deletion threshold: \`--max-delete ${
        maxDeletePercent === null ? "(omitted)" : maxDeletePercent
      }\` — ${
        maxDeletePercent === null
          ? `rclone's default, currently ${BISYNC_MAX_DELETE_PERCENT_DEFAULT}%`
          : `${maxDeletePercent}%`
      } of a side's files.`,
    );
    lines.push(
      "Prior bisync state on this device is archived beside the workdir before the reseed; it is never deleted.",
    );
  }
  if (action === "resume") {
    lines.push("This continues the interrupted run with `rclone bisync --recover`; no listings are discarded.");
  }
  if (action === "cancel") {
    lines.push("This aborts the running rclone process. The listing pair is left recoverable.");
  }
  return lines;
}

/** "How fresh is this" sentence. Never implies an old value is current. */
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
  if (b.error) return "Sync record unusable — rclone recorded a critical error";
  if (!b.present) return "No sync record yet — this device has never completed a sync";
  if (!b.ready) return "Sync record incomplete — a listing is missing or still being written";
  if (b.path1Count !== null && b.path2Count !== null) {
    return `Sync record paired (remote ${b.path1Count} · this device ${b.path2Count})`;
  }
  return "Sync record paired";
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
  if (f.changedSinceBaseline) return `${source} — changed since the last sync`;
  return source;
}

/** Watcher wording: "asked for" and "actually running" are never conflated. */
export function watcherSentence(record: Pick<FolderHealthRecord, "facts">): string | null {
  const w = record.facts.watcher;
  if (!w || !w.enabled) return null;
  if (w.running) return `Watching for changes (settles after ${w.quietSec ?? 30}s of quiet)`;
  return "Watching was requested but is not running";
}

/** "What do these terms mean?" — plain consequences, no jargon. */
export interface GlossaryEntry {
  term: string;
  plain: string;
}

export const HEALTH_GLOSSARY: readonly GlossaryEntry[] = [
  {
    term: "Sync record (baseline)",
    plain:
      "The saved list of what both sides held after the last successful sync. Without it, a sync has no safe starting point — LamaSync must copy to rebuild it.",
  },
  {
    term: "Ignore set (filter)",
    plain:
      "The files and folders LamaSync is told to leave alone, from .lamasyncignore and — if enabled — your Git ignore rules. Changing it changes which files count as 'the same set', so the record must be rebuilt.",
  },
  {
    term: "Watching for changes",
    plain:
      "When on, LamaSync syncs shortly after a file changes instead of waiting for the schedule. It settles for a few quiet seconds first so a burst of edits is one sync.",
  },
  {
    term: "Dry run (preview)",
    plain:
      "A real rclone pass with nothing written. It reports exactly what would be copied and deleted, so you approve facts rather than a guess.",
  },
  {
    term: "Winning side (authority)",
    plain:
      "Only matters when the SAME file changed on both sides. Files that exist on just one side are always copied to the other side. Choose which version to keep for the overlaps.",
  },
  {
    term: "Deletion threshold",
    plain:
      "A safety brake: the run aborts if it would delete more than this share of a side's files. Leaving it blank uses rclone's own limit, which is 50% — it never means 'no limit'.",
  },
];

// ---------------------------------------------------------------------------
// Plan review
// ---------------------------------------------------------------------------

export interface PlanTotals {
  copies: number;
  deletes: number;
  mkdirs: number;
  bytes: number;
  /** True when the plan carries its full bounded sample list. */
  sampled: boolean;
  /** How many entries per list the daemon keeps. */
  sampleCap: number;
}

/**
 * Totals are counted from the plan's own bounded lists, so they are a FLOOR,
 * not a promise: the daemon caps each list at `FOLDER_PLAN_CHANGE_CAP`. The UI
 * must say when only the first N entries are shown.
 */
export function planTotals(plan: Pick<FolderSyncPlan, "changes">): PlanTotals {
  const c = plan.changes;
  return {
    copies: c.wouldCopy.length,
    deletes: c.wouldDelete.length,
    mkdirs: c.wouldMkdir.length,
    bytes: c.bytes,
    sampled:
      c.wouldCopy.length >= FOLDER_PLAN_CHANGE_CAP ||
      c.wouldDelete.length >= FOLDER_PLAN_CHANGE_CAP ||
      c.wouldMkdir.length >= FOLDER_PLAN_CHANGE_CAP,
    sampleCap: FOLDER_PLAN_CHANGE_CAP,
  };
}

export function planValiditySentence(entry: FolderPlanWithValidity): string {
  if (entry.validity.valid) return "This preview is still current.";
  return entry.validity.message;
}

/**
 * Does the displayed plan still describe the operation the operator has
 * selected? A plan must never be approved against a different side or
 * threshold than the one it was built for — uses the SAME core check the
 * daemon enforces, so the UI cannot disagree with it.
 */
export function planMatchesSelection(
  plan: Pick<FolderSyncPlan, "intervention" | "authority" | "maxDeletePercent">,
  selection: {
    intervention: FolderHealthActionId;
    authority: FolderBootstrapAuthority;
    maxDeletePercent: number | null;
  },
): { ok: boolean; message: string | null } {
  if (!isGuardedAction(selection.intervention)) {
    return { ok: false, message: "This operation does not take a plan." };
  }
  const verdict = checkPlanSemantics(plan, {
    intervention: selection.intervention as "initialize" | "seed" | "resync",
    authority: authorityForAction(selection.intervention, selection.authority),
    maxDeletePercent: selection.maxDeletePercent,
  });
  return { ok: verdict.ok, message: verdict.message };
}

/** Does the plan correspond to the dry run this wizard just requested? */
export function planIsFromThisRequest(
  plan: Pick<FolderSyncPlan, "createdAt">,
  requestedAt: number,
  clockSkewMs = 5_000,
): boolean {
  return plan.createdAt >= requestedAt - clockSkewMs;
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

/**
 * The guided flow is four explicit steps so the operator always knows where
 * they are: choose (if a side must be picked) → preview running → review →
 * done/failed.
 */
export type WizardStep = 1 | 2 | 3 | 4;

export type WizardStage = "choose" | "previewing" | "review" | "executing" | "failed";

export function wizardStep(stage: WizardStage): WizardStep {
  switch (stage) {
    case "choose":
      return 1;
    case "previewing":
      return 2;
    case "review":
      return 3;
    case "executing":
      return 4;
    case "failed":
      return 3;
  }
}

export const WIZARD_STEP_LABELS: readonly string[] = [
  "Choose the winning side",
  "Running a preview",
  "Review what will change",
  "Run it",
];

export function wizardStepLabel(step: WizardStep): string {
  return WIZARD_STEP_LABELS[step - 1] ?? "";
}

/** Step 1 is skipped entirely when the side is fixed by the operation. */
export function wizardVisibleSteps(action: FolderHealthActionId): WizardStep[] {
  return actionChoosesAuthority(action) ? [1, 2, 3, 4] : [2, 3, 4];
}

/**
 * Concrete next step when a preview fails or times out. Never a dead end.
 */
export function previewFailureNextStep(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "The preview took longer than this folder's timeout. Raise the timeout in Advanced settings (or run Check this device now to see how large the tree is), then preview again.";
  }
  if (lower.includes("not assigned") || lower.includes("not configured")) {
    return "This device no longer has the folder assigned. Re-assign it from the Set up button, then preview again.";
  }
  if (lower.includes("rclone")) {
    return "rclone could not run on the device. Run Check this device now to see the reported problem, fix it on the device, then preview again.";
  }
  return "Close this and run Check this device now for a fresh diagnosis, then preview again. Nothing has been changed.";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
