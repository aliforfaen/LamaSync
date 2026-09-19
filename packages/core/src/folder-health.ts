// LAMA-345 — managed-folder health, diagnostics and guided bisync
// intervention.
//
// Why this exists: a clean rclone exit code is not evidence that a managed
// folder is healthy. On dev-vm (2026-09-19) the daemon transferred 850 files
// and reported success while the host only ever received three project trees,
// because the shared remote itself was incomplete. The daemon also decided
// "is this the first bisync?" by looking for a `bisync.state` file that rclone
// has never written — rclone persists a *paired* listing set
// (`*.path1.lst` + `*.path2.lst`) under `--workdir` — so every run looked like
// a first run and was forced to `--resync`.
//
// This module is the shared, dependency-free contract: state/fact/reason
// types, the pure state derivation both the daemon and the server agree on,
// staleness rules, and the allowlisted intervention payload grammar. It must
// stay free of node built-ins so the web UI can import it unchanged.

// ---------------------------------------------------------------------------
// Health states
// ---------------------------------------------------------------------------

/**
 * Assignment-level health. Deliberately about *this assignment on this host*,
 * not about the folder globally: the same folder can be healthy on one device
 * and unseeded on another.
 *
 *   healthy          a valid paired baseline exists and the last run agreed
 *   new_host         never synchronised here — no paired baseline yet
 *   resync_required  the synchronization universe moved (filter change) or the
 *                    listing pair is unusable; a planned resync is required
 *   recoverable      an interrupted/failed run, but the baseline is intact and
 *                    normal recovery can continue
 *   unsafe           rclone recorded a critical error (.lst-err) or the
 *                    intended baseline could not be established — an
 *                    unattended run could destroy data
 *   blocked          a precondition prevents any run (missing/unwritable
 *                    local path, no disk space, paused, disabled, no rclone)
 *   busy             a run is in flight right now
 *   unknown          nothing has been reported yet
 */
export type FolderHealthState =
  | "healthy"
  | "new_host"
  | "resync_required"
  | "recoverable"
  | "unsafe"
  | "blocked"
  | "busy"
  | "unknown";

export const FOLDER_HEALTH_STATES: readonly FolderHealthState[] = [
  "healthy",
  "new_host",
  "resync_required",
  "recoverable",
  "unsafe",
  "blocked",
  "busy",
  "unknown",
];

/** Ordered worst-first for UI sorting and server-side "is this worse?" tests. */
export const FOLDER_HEALTH_SEVERITY: Readonly<Record<FolderHealthState, number>> = {
  unsafe: 6,
  resync_required: 5,
  blocked: 4,
  recoverable: 3,
  new_host: 2,
  busy: 1,
  healthy: 0,
  unknown: 0,
};

/**
 * Bounded, actionable reason codes. Every state is *explained* by at least
 * one of these; the UI never has to parse prose to decide what to offer.
 */
export type FolderHealthReasonCode =
  | "ok"
  | "never_reported"
  | "run_in_progress"
  | "assignment_disabled"
  | "paused"
  | "rclone_missing"
  | "unsupported_folder_type"
  | "local_path_missing"
  | "local_path_not_directory"
  | "local_path_unreadable"
  | "local_path_unwritable"
  | "disk_space_low"
  | "baseline_missing"
  | "baseline_incomplete"
  | "baseline_error"
  | "baseline_not_established"
  | "filter_changed"
  | "interrupted"
  | "last_run_failed"
  | "conflicts_pending";

/**
 * Actions an operator can take from the health card. This is the allowlist
 * shared by the Web UI, the server's action boundary and the daemon — no
 * caller ever supplies rclone flags, a config path or a script.
 */
export type FolderHealthActionId =
  | "diagnose"
  | "plan"
  | "sync"
  | "initialize"
  | "seed"
  | "resync"
  | "resume"
  | "cancel";

export const FOLDER_HEALTH_ACTION_IDS: readonly FolderHealthActionId[] = [
  "diagnose",
  "plan",
  "sync",
  "initialize",
  "seed",
  "resync",
  "resume",
  "cancel",
];

/** One reason a state was chosen, with the exact remediation wording. */
export interface FolderHealthReason {
  code: FolderHealthReasonCode;
  /** One bounded operator-facing sentence. */
  message: string;
  /** What to do about it, in plain language. */
  remediation: string;
  /** Machine-actionable next step, when one exists. */
  action: FolderHealthActionId | null;
}

// ---------------------------------------------------------------------------
// Facts (lightweight; never a full tree walk)
// ---------------------------------------------------------------------------

export type FolderHealthLocalDirState =
  | "ok"
  | "missing"
  | "not_directory"
  | "unreadable"
  | "unwritable";

export interface FolderHealthWatcherFacts {
  /** Watch was requested on the assignment. */
  enabled: boolean;
  /** A watcher is actually running for it right now. */
  running: boolean;
  quietSec: number | null;
}

export interface FolderHealthFilterFacts {
  /** Fingerprint of the effective filter universe, or null when no filter. */
  fingerprint: string | null;
  /** Which source produced the effective filter. */
  source: "none" | "lamasyncignore" | "gitignore" | "combined";
  /** True when the fingerprint differs from the acknowledged baseline. */
  changedSinceBaseline: boolean;
}

/**
 * Bisync listing-pair facts. rclone persists one listing per path in the
 * daemon's `--workdir`; a *pair* is the only proof of a resumable baseline.
 */
export interface FolderHealthBaselineFacts {
  /** A matching `<stem>.path1.lst` + `<stem>.path2.lst` pair exists. */
  present: boolean;
  /** The pair is usable: no `.lst-err`, no in-flight `.lst-new`. */
  ready: boolean;
  /** rclone recorded a critical error (`.lst-err`); runs refuse until resync. */
  error: boolean;
  /** Entry counts read from the pair — null until measured. */
  path1Count: number | null;
  path2Count: number | null;
  /** mtime of the newest listing in the pair. */
  updatedAt: number | null;
  /** LAMA-345: stable identity of the pair, for plan invalidation. */
  fingerprint: string;
}

export interface FolderHealthLastRunFacts {
  status: string;
  summary: string | null;
  at: number | null;
}

export interface FolderHealthDeepMeasurement {
  /** Files+dirs counted below the local tree. */
  pathCount: number;
  totalBytes: number;
  measuredAt: number;
}

export interface FolderHealthFacts {
  folderType: string;
  /** Effective type for this host (per-host sync/mount override applied). */
  effectiveType: string;
  enabled: boolean;
  paused: boolean;
  runInProgress: boolean;
  rcloneAvailable: boolean;
  localDir: FolderHealthLocalDirState;
  freeSpaceBytes: number | null;
  freeSpaceThresholdBytes: number | null;
  watcher: FolderHealthWatcherFacts | null;
  filter: FolderHealthFilterFacts;
  baseline: FolderHealthBaselineFacts;
  activePhase: string | null;
  pendingConflicts: number;
  lastRun: FolderHealthLastRunFacts | null;
  /** Deep measurement is optional and only refreshed deliberately. */
  measurement: FolderHealthDeepMeasurement | null;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** Daemon → server report for one assignment. */
export interface FolderHealthReport {
  hostId: string;
  folderId: string;
  /** Assignment identity; the server re-derives it when omitted. */
  assignmentId?: string | null;
  state: FolderHealthState;
  reasons: FolderHealthReason[];
  facts: FolderHealthFacts;
  reportedAt: number;
}

/** Server → client record: the report plus freshness accounting. */
export interface FolderHealthRecord extends FolderHealthReport {
  assignmentId: string;
  /** True when the report is older than the heartbeat staleness budget. */
  stale: boolean;
  /** Age of `reportedAt`, in ms (null when clock skew makes it negative). */
  stalenessMs: number | null;
  /** Deep measurement age in ms, or null when never measured. */
  measurementAgeMs: number | null;
  /** True when a run is currently active for this assignment. */
  active: boolean;
}

/** One bounded history entry (never the full facts blob). */
export interface FolderHealthHistoryEntry {
  state: FolderHealthState;
  reasons: FolderHealthReasonCode[];
  reportedAt: number;
}

export interface FolderHealthResponse {
  folderId: string;
  records: FolderHealthRecord[];
  history: FolderHealthHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/**
 * Explicit bootstrap authority. The daemon's bisync command places the remote
 * at Path 1 and the local tree at Path 2, so:
 *   - `remote` (Path 1): remote wins; used to initialize this host.
 *   - `local`  (Path 2): this host wins; used to seed an incomplete remote.
 */
export type FolderBootstrapAuthority = "remote" | "local";

export interface FolderSyncPlan {
  id: string;
  hostId: string;
  folderId: string;
  assignmentId: string;
  /** Intervention this plan authorizes. Plans are only ever produced for the
   *  three reseeding operations — a resumable run needs no review. */
  intervention: "initialize" | "seed" | "resync";
  authority: FolderBootstrapAuthority;
  /** One bounded human-readable summary of what will happen. */
  summary: string;
  /** Bounded, human-readable change list (capped by the daemon). */
  changes: {
    wouldCopy: string[];
    wouldDelete: string[];
    wouldMkdir: string[];
    files: number;
    bytes: number;
  };
  /** Effective config revision the plan was built against. */
  configRevision: number;
  /** Effective filter fingerprint the plan was built against. */
  filterFingerprint: string | null;
  /** Listing-pair fingerprint the plan was built against. */
  baselineFingerprint: string | null;
  createdAt: number;
  expiresAt: number;
}

/** Validity verdict for a plan against the live assignment state. */
export type FolderPlanInvalidReason =
  | "expired"
  | "config_changed"
  | "filter_changed"
  | "baseline_changed"
  | "missing";

export interface FolderPlanValidity {
  valid: boolean;
  reason: FolderPlanInvalidReason | null;
  message: string;
}

/** A plan plus the server's verdict on whether it is still usable. */
export interface FolderPlanWithValidity {
  plan: FolderSyncPlan;
  validity: FolderPlanValidity;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** A daemon heartbeat is every 30 s; 15 min of silence means "stale". */
export const FOLDER_HEALTH_STALE_MS = 15 * 60_000;

/** Deep local measurement is deliberately slow: once a day unless asked. */
export const FOLDER_HEALTH_DEEP_INTERVAL_MS = 24 * 60 * 60_000;

/** How many per-assignment health reports are stored (bounded history). */
export const FOLDER_HEALTH_HISTORY_LIMIT = 50;

/** Plans expire quickly — they are a reviewed intent, not a standing grant. */
export const FOLDER_PLAN_TTL_MS = 30 * 60_000;

/** Bounded change list carried on a plan. */
export const FOLDER_PLAN_CHANGE_CAP = 20;

// ---------------------------------------------------------------------------
// Allowlisted assignment tuning (LAMA-345 stage 4)
// ---------------------------------------------------------------------------

/** rclone `--max-delete` bounds. 0 is meaningful ("abort on any deletion"). */
export const BISYNC_MAX_DELETE_MIN = 0;
export const BISYNC_MAX_DELETE_MAX = 1_000_000;

/**
 * Validate the allowlisted bisync deletion cap. Returns a human-readable
 * error or null. `null` means "no cap" (rclone's own default) and is valid.
 */
export function validateBisyncMaxDelete(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < BISYNC_MAX_DELETE_MIN ||
    value > BISYNC_MAX_DELETE_MAX
  ) {
    return `bisyncMaxDelete must be null or an integer between ${BISYNC_MAX_DELETE_MIN} and ${BISYNC_MAX_DELETE_MAX}`;
  }
  return null;
}

/**
 * Validate an allowlisted mount VFS cache mode. `null` means "use the
 * assignment's cache profile / rclone default".
 */
export function validateMountCacheMode(value: unknown): value is string | null {
  if (value === null || value === undefined) return true;
  return value === "off" || value === "minimal" || value === "writes" || value === "full";
}

// ---------------------------------------------------------------------------
// Pure derivation
// ---------------------------------------------------------------------------

interface ReasonTemplate {
  /** State this reason alone establishes. */
  state: FolderHealthState;
  message: (facts: FolderHealthFacts) => string;
  remediation: string;
  action: FolderHealthActionId | null;
}

const REASON_TEMPLATES: Readonly<Record<FolderHealthReasonCode, ReasonTemplate>> = {
  ok: {
    state: "healthy",
    message: () => "Baseline is paired and the last run agreed.",
    remediation: "Nothing to do.",
    action: null,
  },
  never_reported: {
    state: "unknown",
    message: () => "This device has not reported folder health yet.",
    remediation: "Run Diagnose now to collect a first report.",
    action: "diagnose",
  },
  run_in_progress: {
    state: "busy",
    message: (f) =>
      f.activePhase
        ? `A run is in progress (${f.activePhase}).`
        : "A run is in progress.",
    remediation: "Wait for it to finish, or cancel it deliberately.",
    action: "cancel",
  },
  assignment_disabled: {
    state: "blocked",
    message: () => "This folder is switched off on this device.",
    remediation: "Turn the assignment back on before syncing.",
    action: null,
  },
  paused: {
    state: "blocked",
    message: (f) => `Sync is paused${f.paused ? "" : ""} for this device.`,
    remediation: "Wait for the pause window to end, or lift the pause.",
    action: null,
  },
  rclone_missing: {
    state: "blocked",
    message: () => "rclone is not installed or not on PATH on this device.",
    remediation: "Install rclone on the device, then diagnose again.",
    action: "diagnose",
  },
  unsupported_folder_type: {
    state: "healthy",
    message: (f) => `Folder type "${f.effectiveType}" has no bisync baseline.`,
    remediation: "Nothing to do — health checks apply to sync folders.",
    action: null,
  },
  local_path_missing: {
    state: "blocked",
    message: () => "The local folder does not exist on this device yet.",
    remediation: "It is created automatically at the next sync or mount.",
    action: "sync",
  },
  local_path_not_directory: {
    state: "blocked",
    message: () => "The local path exists but is not a directory.",
    remediation: "Point the assignment at a directory, then diagnose again.",
    action: "diagnose",
  },
  local_path_unreadable: {
    state: "blocked",
    message: () => "The local folder cannot be read by the daemon.",
    remediation: "Fix the directory permissions on the device, then diagnose again.",
    action: "diagnose",
  },
  local_path_unwritable: {
    state: "blocked",
    message: () => "The local folder cannot be written by the daemon.",
    remediation: "Fix the directory permissions on the device, then diagnose again.",
    action: "diagnose",
  },
  disk_space_low: {
    state: "blocked",
    message: (f) =>
      f.freeSpaceBytes === null
        ? "Free space is below this assignment's disk-space floor."
        : `Only ${f.freeSpaceBytes} bytes free — below the assignment's floor.`,
    remediation: "Free space on the device or lower the disk-space floor.",
    action: "diagnose",
  },
  baseline_missing: {
    state: "new_host",
    message: () => "This device has no bisync baseline yet.",
    remediation: "Initialize this host from remote, or seed the remote from this host.",
    action: "initialize",
  },
  baseline_incomplete: {
    state: "resync_required",
    message: () => "The bisync listing set is incomplete (a path listing is missing).",
    remediation: "Plan a resync so a complete baseline is rebuilt.",
    action: "resync",
  },
  baseline_error: {
    state: "unsafe",
    message: () => "rclone recorded a critical bisync error for this pair.",
    remediation: "Review a plan, then resync to rebuild the baseline.",
    action: "resync",
  },
  baseline_not_established: {
    state: "resync_required",
    message: (f) =>
      f.baseline.path1Count === 0 && (f.baseline.path2Count ?? 0) > 0
        ? "The remote listing is empty while this host has data — the last baseline was not established."
        : "The paired listings do not cover the intended baseline.",
    remediation: "Plan and approve a resync with explicit authority.",
    action: "resync",
  },
  filter_changed: {
    state: "resync_required",
    message: () => "The effective ignore/filter set changed since the last baseline.",
    remediation: "Plan a safe resync so stale listings are not reused.",
    action: "resync",
  },
  interrupted: {
    state: "recoverable",
    message: () => "The last run was interrupted; the baseline is still usable.",
    remediation: "Resume the recoverable work.",
    action: "resume",
  },
  last_run_failed: {
    state: "recoverable",
    message: () => "The last run failed; the baseline is still usable.",
    remediation: "Retry, or plan a resync if it keeps failing.",
    action: "resume",
  },
  conflicts_pending: {
    state: "recoverable",
    message: (f) => `${f.pendingConflicts} conflict(s) are waiting for review.`,
    remediation: "Resolve the conflicts, then sync again.",
    action: "sync",
  },
};

/**
 * Derive the assignment health state + ordered reasons from lightweight facts.
 *
 * Precedence is by severity, not by check order: `busy` outranks a missing
 * path because a running sync is the most current truth, and `unsafe` outranks
 * `resync_required` because an error-marked pair must never be run unattended.
 * The returned reason list is bounded (worst first) so the wire stays small and
 * the UI can show the first two without truncating mid-sentence.
 */
export function deriveFolderHealth(facts: FolderHealthFacts): {
  state: FolderHealthState;
  reasons: FolderHealthReason[];
} {
  const codes: FolderHealthReasonCode[] = [];
  const bisync = facts.effectiveType === "sync";

  if (!facts.enabled) codes.push("assignment_disabled");
  if (facts.paused) codes.push("paused");
  if (!facts.rcloneAvailable) codes.push("rclone_missing");
  if (!bisync) codes.push("unsupported_folder_type");

  switch (facts.localDir) {
    case "missing":
      codes.push("local_path_missing");
      break;
    case "not_directory":
      codes.push("local_path_not_directory");
      break;
    case "unreadable":
      codes.push("local_path_unreadable");
      break;
    case "unwritable":
      codes.push("local_path_unwritable");
      break;
    case "ok":
      break;
  }

  const floor = facts.freeSpaceThresholdBytes;
  if (
    floor !== null &&
    floor > 0 &&
    facts.freeSpaceBytes !== null &&
    facts.freeSpaceBytes < floor
  ) {
    codes.push("disk_space_low");
  }

  if (bisync) {
    if (facts.baseline.error) {
      codes.push("baseline_error");
    } else if (!facts.baseline.present) {
      codes.push("baseline_missing");
    } else if (!facts.baseline.ready) {
      codes.push("baseline_incomplete");
    } else if (
      facts.baseline.path1Count === 0 &&
      (facts.baseline.path2Count ?? 0) > 0
    ) {
      // The dev-vm case: rclone exited 0, the pair exists, but the remote
      // side of the pair is empty while this host has content.
      codes.push("baseline_not_established");
    }
  }

  if (facts.filter.changedSinceBaseline) codes.push("filter_changed");
  if (facts.pendingConflicts > 0) codes.push("conflicts_pending");

  const status = facts.lastRun?.status ?? null;
  if (bisync && status !== null && status !== "success" && status !== "recovery") {
    if (status === "retry" || status === "deferred") codes.push("interrupted");
    else if (status === "failed") codes.push("last_run_failed");
  }

  if (facts.runInProgress) codes.push("run_in_progress");
  if (codes.length === 0) codes.push("ok");

  const reasons: FolderHealthReason[] = [];
  let worst: FolderHealthState = "healthy";
  let worstSeverity = -1;
  for (const code of codes) {
    const tpl = REASON_TEMPLATES[code];
    reasons.push({
      code,
      message: tpl.message(facts),
      remediation: tpl.remediation,
      action: tpl.action,
    });
    const severity = FOLDER_HEALTH_SEVERITY[tpl.state];
    if (severity > worstSeverity) {
      worstSeverity = severity;
      worst = tpl.state;
    }
  }
  // A missing baseline on a non-bisync folder is not a health problem at all.
  if (worst === "new_host" && !bisync) worst = "healthy";
  // A live run is the most current truth there is; it is never hidden behind
  // a precondition that the run itself is already dealing with.
  if (facts.runInProgress) {
    worst = "busy";
    const index = reasons.findIndex((r) => r.code === "run_in_progress");
    if (index > 0) reasons.unshift(reasons.splice(index, 1)[0]!);
  }
  return { state: worst, reasons };
}

/** Age of a report relative to `now`; null when the clock went backwards. */
export function folderHealthStaleness(
  reportedAt: number,
  now: number,
): { stale: boolean; stalenessMs: number | null } {
  const age = now - reportedAt;
  if (!Number.isFinite(age) || age < 0) return { stale: false, stalenessMs: null };
  return { stale: age > FOLDER_HEALTH_STALE_MS, stalenessMs: age };
}

/**
 * Which of the two sides a state implies for the operator. Used for the
 * "exact remediation" sentence and the guided modal wording.
 */
export function describeBootstrapAuthority(
  authority: FolderBootstrapAuthority,
): { short: string; long: string } {
  return authority === "remote"
    ? {
        short: "Remote wins",
        long:
          "The shared remote is authoritative. Files that exist only on this device are removed locally to match it.",
      }
    : {
        short: "This device wins",
        long:
          "This device is authoritative. Its files are uploaded to the remote, and anything on the remote that this device does not have is removed there.",
      };
}

export function describeFolderHealthState(state: FolderHealthState): string {
  switch (state) {
    case "healthy":
      return "Healthy";
    case "new_host":
      return "Not initialised";
    case "resync_required":
      return "Resync required";
    case "recoverable":
      return "Recoverable";
    case "unsafe":
      return "Unsafe";
    case "blocked":
      return "Blocked";
    case "busy":
      return "Running";
    case "unknown":
      return "Unknown";
  }
}

export function describeFolderHealthAction(action: FolderHealthActionId): string {
  switch (action) {
    case "diagnose":
      return "Diagnose now";
    case "plan":
      return "Plan sync";
    case "sync":
      return "Sync now";
    case "initialize":
      return "Initialize this host from remote";
    case "seed":
      return "Seed remote from this host";
    case "resync":
      return "Reseed baseline";
    case "resume":
      return "Resume";
    case "cancel":
      return "Cancel";
  }
}

// ---------------------------------------------------------------------------
// Intervention payload grammar
// ---------------------------------------------------------------------------

export const FOLDER_INTERVENTIONS = [
  "initialize",
  "seed",
  "resync",
  "resume",
  "cancel",
] as const;

export type FolderIntervention = (typeof FOLDER_INTERVENTIONS)[number];

/**
 * The complete, allowlisted instruction set for a folder intervention. There
 * is deliberately no field for rclone flags, a config path, an arbitrary
 * command or a target URL: the daemon derives every argv element itself.
 */
export interface FolderInterventionPayload {
  folderId: string;
  intervention: FolderIntervention;
  authority?: FolderBootstrapAuthority;
  planId?: string;
  confirm?: true;
  maxDelete?: number;
}

export type FolderInterventionParseResult =
  | { ok: true; payload: FolderInterventionPayload }
  | { ok: false; error: string };

/** Interventions that mutate data and therefore require review + confirm. */
export function interventionRequiresAuthority(
  intervention: FolderIntervention,
): boolean {
  return intervention === "initialize" || intervention === "seed" || intervention === "resync";
}

export function interventionRequiresConfirm(intervention: FolderIntervention): boolean {
  return intervention !== "cancel";
}

/** Interventions that must be backed by a reviewed plan. */
export function interventionRequiresPlan(intervention: FolderIntervention): boolean {
  return intervention === "initialize" || intervention === "seed" || intervention === "resync";
}

/** The authority a queued intervention must carry to be consistent. */
export function requiredAuthority(
  intervention: FolderIntervention,
): FolderBootstrapAuthority | null {
  switch (intervention) {
    case "initialize":
      return "remote";
    case "seed":
      return "local";
    case "resync":
      return null; // explicit, but either side may be chosen
    case "resume":
    case "cancel":
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Validate an intervention payload at any boundary (server enqueue, daemon
 * dispatch). Pure and shared so both sides reject the same shapes with the
 * same wording — the daemon must never trust the control plane, and the
 * control plane must never accept an unbounded instruction.
 */
export function parseFolderInterventionPayload(
  value: unknown,
): FolderInterventionParseResult {
  if (!isRecord(value)) return { ok: false, error: "payload must be an object" };
  const folderId = value["folderId"];
  if (typeof folderId !== "string" || folderId.length === 0) {
    return { ok: false, error: "folderId is required" };
  }
  const intervention = value["intervention"];
  if (
    typeof intervention !== "string" ||
    !FOLDER_INTERVENTIONS.includes(intervention as FolderIntervention)
  ) {
    return { ok: false, error: `intervention must be one of ${FOLDER_INTERVENTIONS.join(", ")}` };
  }
  const kind = intervention as FolderIntervention;

  const allowedKeys = new Set([
    "folderId",
    "intervention",
    "authority",
    "planId",
    "confirm",
    "maxDelete",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `unsupported field: ${key}` };
    }
  }

  let authority: FolderBootstrapAuthority | undefined;
  if (interventionRequiresAuthority(kind)) {
    const raw = value["authority"];
    if (raw !== "remote" && raw !== "local") {
      return {
        ok: false,
        error: "authority must be explicitly 'remote' or 'local'",
      };
    }
    authority = raw;
    const required = requiredAuthority(kind);
    if (required !== null && authority !== required) {
      return {
        ok: false,
        error:
          required === "remote"
            ? "initialize requires remote authority (remote is authoritative)"
            : "seed requires local authority (this host is authoritative)",
      };
    }
  } else if (value["authority"] !== undefined) {
    return { ok: false, error: `${kind} does not take an authority` };
  }

  let planId: string | undefined;
  if (value["planId"] !== undefined) {
    const raw = value["planId"];
    if (typeof raw !== "string" || raw.length === 0) {
      return { ok: false, error: "planId must be a non-empty string" };
    }
    planId = raw;
  }
  if (interventionRequiresPlan(kind) && planId === undefined) {
    return { ok: false, error: `${kind} requires a reviewed planId` };
  }

  if (interventionRequiresConfirm(kind) && value["confirm"] !== true) {
    return { ok: false, error: `${kind} requires confirm: true` };
  }

  let maxDelete: number | undefined;
  if (value["maxDelete"] !== undefined) {
    const raw = value["maxDelete"];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 1_000_000) {
      return { ok: false, error: "maxDelete must be an integer between 0 and 1000000" };
    }
    maxDelete = raw;
  }

  return {
    ok: true,
    payload: {
      folderId,
      intervention: kind,
      ...(authority ? { authority } : {}),
      ...(planId ? { planId } : {}),
      ...(value["confirm"] === true ? { confirm: true as const } : {}),
      ...(maxDelete !== undefined ? { maxDelete } : {}),
    },
  };
}

/** A read-only plan request: which intervention to preview, and for whom. */
export interface FolderPlanRequestPayload {
  folderId: string;
  intervention: "initialize" | "seed" | "resync";
  authority: FolderBootstrapAuthority;
  maxDelete?: number;
}

export type FolderPlanRequestParseResult =
  | { ok: true; payload: FolderPlanRequestPayload }
  | { ok: false; error: string };

/**
 * Validate a `plan_folder` payload. Planning is read-only, but the preview
 * must describe the *same* authority the later intervention will use, so the
 * operator reviews the thing they are about to approve. `confirm` is not
 * required here because nothing is executed by planning.
 */
export function parseFolderPlanRequestPayload(value: unknown): FolderPlanRequestParseResult {
  if (!isRecord(value)) return { ok: false, error: "payload must be an object" };
  const folderId = value["folderId"];
  if (typeof folderId !== "string" || folderId.length === 0) {
    return { ok: false, error: "folderId is required" };
  }
  const intervention = value["intervention"];
  if (intervention !== "initialize" && intervention !== "seed" && intervention !== "resync") {
    return { ok: false, error: "only initialize, seed or resync can be planned" };
  }
  const authority = value["authority"];
  if (authority !== "remote" && authority !== "local") {
    return { ok: false, error: "authority must be explicitly 'remote' or 'local'" };
  }
  const required = requiredAuthority(intervention);
  if (required !== null && authority !== required) {
    return {
      ok: false,
      error:
        required === "remote"
          ? "initialize requires remote authority (remote is authoritative)"
          : "seed requires local authority (this host is authoritative)",
    };
  }
  const allowedKeys = new Set(["folderId", "intervention", "authority", "maxDelete"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) return { ok: false, error: `unsupported field: ${key}` };
  }
  let maxDelete: number | undefined;
  if (value["maxDelete"] !== undefined) {
    const error = validateBisyncMaxDelete(value["maxDelete"]);
    if (error) return { ok: false, error };
    maxDelete = value["maxDelete"] as number;
  }
  return {
    ok: true,
    payload: {
      folderId,
      intervention,
      authority,
      ...(maxDelete !== undefined ? { maxDelete } : {}),
    },
  };
}

/**
 * Read-only diagnosis request. Deliberately a single field: a diagnose must
 * never be able to carry flags or a target.
 */
export function parseFolderDiagnosePayload(
  value: unknown,
): { ok: true; folderId: string } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "payload must be an object" };
  const folderId = value["folderId"];
  if (typeof folderId !== "string" || folderId.length === 0) {
    return { ok: false, error: "folderId is required" };
  }
  for (const key of Object.keys(value)) {
    if (key !== "folderId") return { ok: false, error: `unsupported field: ${key}` };
  }
  return { ok: true, folderId };
}

/**
 * Validate a stored plan against the live assignment state. A plan is a
 * reviewed intent with a short life: it dies on expiry, on a config-revision
 * bump, on a filter-universe change, and on any change to the listing pair.
 */
export function checkFolderPlanValidity(
  plan: Pick<
    FolderSyncPlan,
    "expiresAt" | "configRevision" | "filterFingerprint" | "baselineFingerprint"
  >,
  live: {
    now: number;
    configRevision: number;
    filterFingerprint: string | null;
    baselineFingerprint: string | null;
  },
): FolderPlanValidity {
  if (live.now >= plan.expiresAt) {
    return { valid: false, reason: "expired", message: "This plan has expired — plan again." };
  }
  if (live.configRevision !== plan.configRevision) {
    return {
      valid: false,
      reason: "config_changed",
      message: "The assignment changed since this plan was built — plan again.",
    };
  }
  if (live.filterFingerprint !== plan.filterFingerprint) {
    return {
      valid: false,
      reason: "filter_changed",
      message: "The ignore/filter set changed since this plan was built — plan again.",
    };
  }
  if (live.baselineFingerprint !== plan.baselineFingerprint) {
    return {
      valid: false,
      reason: "baseline_changed",
      message: "The bisync baseline changed since this plan was built — plan again.",
    };
  }
  return { valid: true, reason: null, message: "Plan is current." };
}
