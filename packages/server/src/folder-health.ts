// LAMA-345 — server-side persistence and reads for managed-folder health.
//
// The daemon reports lightweight facts; this module owns the durable state:
//
//   - one `folder_health` row per assignment (the latest report)
//   - a bounded `folder_health_history` of *transitions* (state/reason change),
//     never one row per heartbeat
//   - reviewed `folder_sync_plans` with a short TTL
//
// Reads re-derive the state so the server can fold in information only it
// knows: the pending conflict count, whether a run is currently live, and a
// fleet-level cross-check of what each host sees on the SAME shared remote.
// That last check is what makes the dev-vm incident visible: a host that
// pulled an incomplete shared baseline sees far fewer entries than a sibling
// host that already seeded it.

import type { Database } from "bun:sqlite";
import {
  deriveFolderHealth,
  FOLDER_HEALTH_HISTORY_LIMIT,
  FOLDER_HEALTH_SEVERITY,
  folderHealthStaleness,
  type FolderHealthFacts,
  type FolderHealthHistoryEntry,
  type FolderHealthReason,
  type FolderHealthReasonCode,
  type FolderHealthRecord,
  type FolderHealthState,
  type FolderSyncPlan,
} from "@lamasync/core";
import { isLiveProgressForAssignment } from "./live-progress.ts";

interface HealthRow {
  assignment_id: string;
  folder_id: string;
  host_id: string;
  state: string;
  reasons: string;
  facts: string;
  reported_at: number;
  destination: string | null;
  folder_name: string | null;
  folder_type: string | null;
}

interface HistoryRow {
  state: string;
  reasons: string;
  reported_at: number;
}

interface PlanRow {
  id: string;
  folder_id: string;
  host_id: string;
  assignment_id: string;
  intervention: string;
  authority: string;
  max_delete_percent: number | null;
  summary: string;
  changes: string;
  config_revision: number;
  filter_fingerprint: string | null;
  baseline_fingerprint: string | null;
  created_at: number;
  expires_at: number;
}

// ---------------------------------------------------------------------------
// Normalisation (bounded; never trusts the daemon)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clampString(value: unknown, cap: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= cap ? trimmed : `${trimmed.slice(0, cap)}…`;
}

function clampInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  if (floored < min || floored > max) return null;
  return floored;
}

const STATES: ReadonlySet<string> = new Set([
  "healthy",
  "new_host",
  "resync_required",
  "recoverable",
  "unsafe",
  "blocked",
  "busy",
  "unknown",
]);

const REASON_CODES: ReadonlySet<string> = new Set([
  "ok",
  "never_reported",
  "run_in_progress",
  "assignment_disabled",
  "paused",
  "rclone_missing",
  "unsupported_folder_type",
  "local_path_missing",
  "local_path_not_directory",
  "local_path_unreadable",
  "local_path_unwritable",
  "disk_space_low",
  "baseline_missing",
  "baseline_incomplete",
  "baseline_error",
  "baseline_not_established",
  "filter_changed",
  "interrupted",
  "last_run_failed",
  "conflicts_pending",
]);

const ACTIONS: ReadonlySet<string> = new Set([
  "diagnose",
  "plan",
  "sync",
  "initialize",
  "seed",
  "resync",
  "resume",
  "cancel",
]);

const LOCAL_DIR_STATES: ReadonlySet<string> = new Set([
  "ok",
  "missing",
  "not_directory",
  "unreadable",
  "unwritable",
]);

const FILTER_SOURCES: ReadonlySet<string> = new Set([
  "none",
  "lamasyncignore",
  "gitignore",
  "combined",
]);

/** Normalize the daemon's reason list. Exported so the route stores exactly
 *  the bounded shape this module reads back. */
export function normalizeFolderHealthReasons(value: unknown): FolderHealthReason[] {
  if (!Array.isArray(value)) return [];
  const out: FolderHealthReason[] = [];
  for (const entry of value.slice(0, 6)) {
    if (!isRecord(entry)) continue;
    const code = entry["code"];
    if (typeof code !== "string" || !REASON_CODES.has(code)) continue;
    const action = entry["action"];
    out.push({
      code: code as FolderHealthReasonCode,
      message: clampString(entry["message"], 240) ?? code,
      remediation: clampString(entry["remediation"], 240) ?? "Diagnose again.",
      action:
        typeof action === "string" && ACTIONS.has(action)
          ? (action as FolderHealthReason["action"])
          : null,
    });
  }
  return out;
}

/** Normalize the daemon's facts blob; unknown/malformed fields are dropped. */
export function normalizeFolderHealthFacts(value: unknown): FolderHealthFacts | null {
  if (!isRecord(value)) return null;
  const localDir = value["localDir"];
  if (typeof localDir !== "string" || !LOCAL_DIR_STATES.has(localDir)) return null;
  const effectiveType = clampString(value["effectiveType"], 32);
  if (effectiveType === null) return null;
  const baseline = isRecord(value["baseline"]) ? value["baseline"] : {};
  const filter = isRecord(value["filter"]) ? value["filter"] : {};
  const watcher = isRecord(value["watcher"]) ? value["watcher"] : null;
  const lastRun = isRecord(value["lastRun"]) ? value["lastRun"] : null;
  const measurement = isRecord(value["measurement"]) ? value["measurement"] : null;
  const filterSource = filter["source"];
  // LAMA-346: archive tooling is reported by the heartbeat. A missing or
  // malformed block is `null` ("not verified"), never an invented `true`.
  const archiveRaw = isRecord(value["archive"]) ? value["archive"] : null;
  const archive: FolderHealthFacts["archive"] = archiveRaw
    ? {
        tar: archiveRaw["tar"] === true,
        zstd: archiveRaw["zstd"] === true,
        gzip: archiveRaw["gzip"] === true,
      }
    : null;
  // LAMA-346: the target's own same-filesystem proof for the staging sibling.
  // Normalized fail-closed: `sameFilesystem` is only true when the device
  // reported the boolean true, so an unknown or malformed block can never be
  // read as "proven".
  const seedStagingRaw = isRecord(value["seedStaging"]) ? value["seedStaging"] : null;
  const seedStaging: FolderHealthFacts["seedStaging"] = seedStagingRaw
    ? {
        targetPath: clampString(seedStagingRaw["targetPath"], 4096),
        targetParent: clampString(seedStagingRaw["targetParent"], 4096),
        stagingParent: clampString(seedStagingRaw["stagingParent"], 4096),
        sameFilesystem: seedStagingRaw["sameFilesystem"] === true ? true : null,
        device: clampInt(seedStagingRaw["device"], 0, Number.MAX_SAFE_INTEGER),
        checkedAt: clampInt(seedStagingRaw["checkedAt"], 0, Number.MAX_SAFE_INTEGER) ?? 0,
      }
    : null;
  return {
    folderType: clampString(value["folderType"], 32) ?? effectiveType,
    effectiveType,
    enabled: value["enabled"] === true,
    paused: value["paused"] === true,
    runInProgress: value["runInProgress"] === true,
    rcloneAvailable: value["rcloneAvailable"] !== false,
    archive,
    seedStaging,
    localDir: localDir as FolderHealthFacts["localDir"],
    freeSpaceBytes: clampInt(value["freeSpaceBytes"], 0, Number.MAX_SAFE_INTEGER),
    freeSpaceThresholdBytes: clampInt(
      value["freeSpaceThresholdBytes"],
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    watcher: watcher
      ? {
          enabled: watcher["enabled"] === true,
          running: watcher["running"] === true,
          quietSec: clampInt(watcher["quietSec"], 0, 86_400),
        }
      : null,
    filter: {
      fingerprint: clampString(filter["fingerprint"], 128),
      source:
        typeof filterSource === "string" && FILTER_SOURCES.has(filterSource)
          ? (filterSource as FolderHealthFacts["filter"]["source"])
          : "none",
      changedSinceBaseline: filter["changedSinceBaseline"] === true,
    },
    baseline: {
      present: baseline["present"] === true,
      ready: baseline["ready"] === true,
      error: baseline["error"] === true,
      path1Count: clampInt(baseline["path1Count"], 0, 100_000_000),
      path2Count: clampInt(baseline["path2Count"], 0, 100_000_000),
      updatedAt: clampInt(baseline["updatedAt"], 0, Number.MAX_SAFE_INTEGER),
      fingerprint: clampString(baseline["fingerprint"], 128) ?? "none",
    },
    activePhase: clampString(value["activePhase"], 40),
    pendingConflicts: clampInt(value["pendingConflicts"], 0, 100_000) ?? 0,
    lastRun: lastRun
      ? {
          status: clampString(lastRun["status"], 24) ?? "unknown",
          summary: clampString(lastRun["summary"], 240),
          at: clampInt(lastRun["at"], 0, Number.MAX_SAFE_INTEGER),
        }
      : null,
    measurement: measurement
      ? {
          pathCount: clampInt(measurement["pathCount"], 0, 1_000_000_000) ?? 0,
          totalBytes: clampInt(measurement["totalBytes"], 0, Number.MAX_SAFE_INTEGER) ?? 0,
          measuredAt: clampInt(measurement["measuredAt"], 0, Number.MAX_SAFE_INTEGER) ?? 0,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function reasonsKey(reasons: readonly FolderHealthReason[]): string {
  return reasons
    .map((r) => r.code)
    .sort()
    .join(",");
}

/**
 * Upsert the latest report and append a history row only when the state or the
 * reason set actually changed. Returns the normalized report data that was
 * stored (without the server-derived freshness fields).
 */
export function recordFolderHealth(
  database: Database,
  report: {
    assignmentId: string;
    folderId: string;
    hostId: string;
    state: FolderHealthState;
    reasons: FolderHealthReason[];
    facts: FolderHealthFacts;
    reportedAt: number;
  },
): void {
  const reasonsJson = JSON.stringify(report.reasons);
  const factsJson = JSON.stringify(report.facts);
  const previous = database
    .query<{ state: string; reasons: string }, [string]>(
      "SELECT state, reasons FROM folder_health WHERE assignment_id = ?",
    )
    .get(report.assignmentId);
  database.run(
    `INSERT INTO folder_health
       (assignment_id, folder_id, host_id, state, reasons, facts, reported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(assignment_id) DO UPDATE SET
       folder_id = excluded.folder_id,
       host_id = excluded.host_id,
       state = excluded.state,
       reasons = excluded.reasons,
       facts = excluded.facts,
       reported_at = excluded.reported_at`,
    [
      report.assignmentId,
      report.folderId,
      report.hostId,
      report.state,
      reasonsJson,
      factsJson,
      report.reportedAt,
    ],
  );

  const previousCodes = previous
    ? normalizeFolderHealthReasons(safeParse(previous.reasons)).map((r) => r.code).sort().join(",")
    : null;
  const changed =
    previous === null ||
    previous.state !== report.state ||
    previousCodes !== reasonsKey(report.reasons);
  if (!changed) return;

  database.run(
    `INSERT INTO folder_health_history
       (assignment_id, folder_id, host_id, state, reasons, reported_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      report.assignmentId,
      report.folderId,
      report.hostId,
      report.state,
      JSON.stringify(report.reasons.map((r) => r.code)),
      report.reportedAt,
    ],
  );
  database.run(
    `DELETE FROM folder_health_history
      WHERE assignment_id = ?
        AND id NOT IN (
          SELECT id FROM folder_health_history
          WHERE assignment_id = ?
          ORDER BY reported_at DESC, id DESC
          LIMIT ?
        )`,
    [report.assignmentId, report.assignmentId, FOLDER_HEALTH_HISTORY_LIMIT],
  );
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Drop the health rows (latest + history) for an assignment being removed. */
export function deleteFolderHealthForAssignment(
  database: Database,
  assignmentId: string,
): void {
  database.run("DELETE FROM folder_health WHERE assignment_id = ?", [assignmentId]);
  database.run("DELETE FROM folder_health_history WHERE assignment_id = ?", [assignmentId]);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const HEALTH_SELECT = `
  SELECT h.assignment_id, h.folder_id, h.host_id, h.state, h.reasons, h.facts, h.reported_at,
         a.destination AS destination,
         f.name AS folder_name, f.type AS folder_type
    FROM folder_health h
    LEFT JOIN folder_assignments a ON a.id = h.assignment_id
    LEFT JOIN folders f ON f.id = h.folder_id`;

function pendingConflictsFor(
  database: Database,
  folderId: string,
  hostId: string,
): number {
  const row = database
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM conflicts WHERE folder_id = ? AND host_id = ? AND status = 'pending'",
    )
    .get(folderId, hostId);
  return row?.n ?? 0;
}

/** Shared-destination grouping key for the fleet cross-check. */
function destinationGroupKey(row: HealthRow): string | null {
  if (row.destination === null || row.destination === undefined) return null;
  return `${row.folder_id}::${row.destination}`;
}

/**
 * Fold the fleet-level "incomplete shared remote" check into a record.
 *
 * Two hosts assigned to the same shared destination should see the same
 * entries on that remote. When one host's Path 1 listing is a small fraction
 * of a sibling's, the smaller one pulled an incomplete baseline — exactly the
 * dev-vm failure that previously reported `healthy`.
 */
function applyFleetBaselineCheck(
  record: FolderHealthRecord,
  group: FolderHealthRecord[],
  now: number,
): FolderHealthRecord {
  if (!record.facts.baseline.ready) return record;
  if (record.facts.effectiveType !== "sync") return record;
  if (record.facts.filter.changedSinceBaseline) return record;
  const counts = group
    .filter((other) => other.facts.baseline.ready && other.facts.filter.changedSinceBaseline === false)
    .map((other) => other.facts.baseline.path1Count)
    .filter((n): n is number => n !== null);
  if (counts.length < 2) return record;
  const max = Math.max(...counts);
  const own = record.facts.baseline.path1Count;
  if (own === null || max < 20 || own > max / 2) return record;

  const reason: FolderHealthReason = {
    code: "baseline_not_established",
    message: `Another device already sees ${max} entries on this shared remote, while this device sees only ${own}.`,
    remediation: "Plan and approve a resync with explicit authority to rebuild this device's baseline.",
    action: "resync",
  };
  const reasons = [reason, ...record.reasons.filter((r) => r.code !== "ok")].slice(0, 6);
  const state =
    FOLDER_HEALTH_SEVERITY[record.state] >= FOLDER_HEALTH_SEVERITY.resync_required
      ? record.state
      : "resync_required";
  void now;
  return { ...record, state, reasons };
}

/**
 * THE read path for managed-folder health: normalise the stored facts,
 * re-derive the state with everything only the server knows (pending
 * conflicts, report age, live runs) and apply the fleet cross-check.
 *
 * Every surface must go through this. The Dashboard summary previously read the
 * daemon's *stored* state column instead, so a folder the daemon called
 * `unsafe` with healthy-looking facts showed as "needs attention" on the
 * dashboard while its own card — which re-derives — said "Healthy". One code
 * path means the two cannot disagree.
 */
export function loadDerivedFolderHealth(
  database: Database,
  now: number = Date.now(),
  folderId?: string,
): FolderHealthRecord[] {
  const rows = folderId
    ? database
        .query<HealthRow, [string]>(`${HEALTH_SELECT} WHERE h.folder_id = ?`)
        .all(folderId)
    : database.query<HealthRow, []>(HEALTH_SELECT).all();

  const parsed: { record: FolderHealthRecord; row: HealthRow }[] = [];
  for (const row of rows) {
    const facts = normalizeFolderHealthFacts(safeParse(row.facts));
    if (facts === null) continue;
    const pendingConflicts = pendingConflictsFor(database, row.folder_id, row.host_id);
    const withConflicts: FolderHealthFacts = { ...facts, pendingConflicts };
    const derived = deriveFolderHealth(withConflicts);
    const staleness = folderHealthStaleness(row.reported_at, now);
    const measurementAgeMs =
      withConflicts.measurement === null
        ? null
        : Math.max(0, now - withConflicts.measurement.measuredAt);
    parsed.push({
      row,
      record: {
        assignmentId: row.assignment_id,
        folderId: row.folder_id,
        hostId: row.host_id,
        state: derived.state,
        reasons: derived.reasons,
        facts: withConflicts,
        reportedAt: row.reported_at,
        stale: staleness.stale,
        stalenessMs: staleness.stalenessMs,
        measurementAgeMs,
        active: isLiveProgressForAssignment(row.folder_id, row.host_id),
      },
    });
  }

  const groupByKey = new Map<string, FolderHealthRecord[]>();
  for (const { row, record } of parsed) {
    const key = destinationGroupKey(row);
    if (key === null) continue;
    const list = groupByKey.get(key) ?? [];
    list.push(record);
    groupByKey.set(key, list);
  }

  const records = parsed.map(({ row, record }) => {
    const key = destinationGroupKey(row);
    const group = key === null ? [] : groupByKey.get(key) ?? [];
    return applyFleetBaselineCheck(record, group, now);
  });
  records.sort((a, b) => a.hostId.localeCompare(b.hostId));
  return records;
}

/**
 * Every assignment health record for one folder, with server-derived freshness,
 * pending conflicts, live-run activity and the fleet cross-check.
 */
export function listFolderHealth(
  database: Database,
  folderId: string,
  now: number = Date.now(),
): { records: FolderHealthRecord[]; history: FolderHealthHistoryEntry[] } {
  const records = loadDerivedFolderHealth(database, now, folderId);

  const historyRows = database
    .query<HistoryRow, [string, number]>(
      `SELECT state, reasons, reported_at FROM folder_health_history
        WHERE folder_id = ?
        ORDER BY reported_at DESC, id DESC
        LIMIT ?`,
    )
    .all(folderId, FOLDER_HEALTH_HISTORY_LIMIT);
  const history: FolderHealthHistoryEntry[] = [];
  for (const row of historyRows) {
    if (!STATES.has(row.state)) continue;
    const codes = safeParse(row.reasons);
    history.push({
      state: row.state as FolderHealthState,
      reasons: Array.isArray(codes)
        ? codes.filter((c): c is FolderHealthReasonCode => typeof c === "string" && REASON_CODES.has(c))
        : [],
      reportedAt: row.reported_at,
    });
  }

  return { records, history };
}

/** Latest health record for a single assignment (or null). */
export function getAssignmentHealth(
  database: Database,
  assignmentId: string,
  now: number = Date.now(),
): FolderHealthRecord | null {
  const row = database
    .query<HealthRow, [string]>(`${HEALTH_SELECT} WHERE h.assignment_id = ?`)
    .get(assignmentId);
  if (!row) return null;
  const folderId = row.folder_id;
  const { records } = listFolderHealth(database, folderId, now);
  return records.find((r) => r.assignmentId === assignmentId) ?? null;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

function rowToPlan(row: PlanRow): FolderSyncPlan {
  const changes = safeParse(row.changes);
  const rec = isRecord(changes) ? changes : {};
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string").slice(0, 20)
      : [];
  return {
    id: row.id,
    hostId: row.host_id,
    folderId: row.folder_id,
    assignmentId: row.assignment_id,
    intervention: row.intervention as FolderSyncPlan["intervention"],
    authority: row.authority === "local" ? "local" : "remote",
    // The reviewed deletion threshold is part of the plan's semantics.
    maxDeletePercent:
      typeof row.max_delete_percent === "number" ? row.max_delete_percent : null,
    summary: row.summary,
    changes: {
      wouldCopy: list(rec["wouldCopy"]),
      wouldDelete: list(rec["wouldDelete"]),
      wouldMkdir: list(rec["wouldMkdir"]),
      files: typeof rec["files"] === "number" ? Math.floor(rec["files"]) : 0,
      bytes: typeof rec["bytes"] === "number" ? Math.floor(rec["bytes"]) : 0,
    },
    configRevision: row.config_revision,
    filterFingerprint: row.filter_fingerprint,
    baselineFingerprint: row.baseline_fingerprint,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

const PLAN_SELECT = `SELECT id, folder_id, host_id, assignment_id, intervention, authority,
       max_delete_percent, summary, changes, config_revision, filter_fingerprint,
       baseline_fingerprint, created_at, expires_at
  FROM folder_sync_plans`;

export function recordFolderPlan(database: Database, plan: FolderSyncPlan): void {
  database.run(
    `INSERT INTO folder_sync_plans
       (id, folder_id, host_id, assignment_id, intervention, authority, max_delete_percent,
        summary, changes, config_revision, filter_fingerprint, baseline_fingerprint,
        created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       summary = excluded.summary,
       changes = excluded.changes,
       config_revision = excluded.config_revision,
       filter_fingerprint = excluded.filter_fingerprint,
       baseline_fingerprint = excluded.baseline_fingerprint,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at`,
    [
      plan.id,
      plan.folderId,
      plan.hostId,
      plan.assignmentId,
      plan.intervention,
      plan.authority,
      plan.maxDeletePercent,
      plan.summary,
      JSON.stringify(plan.changes),
      plan.configRevision,
      plan.filterFingerprint,
      plan.baselineFingerprint,
      plan.createdAt,
      plan.expiresAt,
    ],
  );
}

export function getFolderPlan(database: Database, planId: string): FolderSyncPlan | null {
  const row = database
    .query<PlanRow, [string]>(`${PLAN_SELECT} WHERE id = ?`)
    .get(planId);
  return row ? rowToPlan(row) : null;
}

/** Newest plans for a folder (bounded), expired ones included so the UI can
 *  say "this plan expired" rather than pretending it never existed. */
export function listFolderPlans(
  database: Database,
  folderId: string,
  limit = 10,
): FolderSyncPlan[] {
  const capped = Math.min(Math.max(1, limit), 50);
  return database
    .query<PlanRow, [string, number]>(
      `${PLAN_SELECT} WHERE folder_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(folderId, capped)
    .map(rowToPlan);
}

/** Remove plans for an assignment being deleted. */
export function deleteFolderPlansForAssignment(
  database: Database,
  assignmentId: string,
): void {
  database.run("DELETE FROM folder_sync_plans WHERE assignment_id = ?", [assignmentId]);
}

/** Housekeeping: drop plans whose TTL ended long ago. */
export function pruneExpiredFolderPlans(
  database: Database,
  now: number = Date.now(),
  graceMs: number = 24 * 60 * 60_000,
): number {
  const result = database.run("DELETE FROM folder_sync_plans WHERE expires_at < ?", [
    now - graceMs,
  ]);
  return Number(result.changes ?? 0);
}
