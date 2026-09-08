// LAMA-325: snapshot retention policies + preview/execute for app
// protections and restic-backed folders.
//
// Safety contract (LAMA-313 / LAMA-325):
//   - policies are disabled/null by default; NULL keeps everything
//   - preview is READ-ONLY (no side effects)
//   - execution requires explicit `confirm: true`, re-evaluates FRESH
//     state (never trusts a stale preview), records per-item outcomes in
//     Activity, and never reports a failed deletion as pruned
//   - pins/holds + unfinished/rollback artifacts override every rule
//   - app archive deletes reuse the LAMA-324 storage adapter (dispatch
//     from each snapshot's immutable stored location; fail closed)
//   - restic deletes use restic forget + prune per repository
//   - ordinary backup/sync/mount trees have NO snapshot identity — folder
//     retention refuses them

import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import {
  describePolicy,
  evaluateRetention,
  smartRetentionRules,
  type RetentionDecision,
  type RetentionPolicy,
  type RetentionRule,
  type RetentionSnapshotDescriptor,
} from "@lamasync/core";
import { db as defaultDb } from "../db.ts";
import { requireAdmin, principalOf } from "../auth.ts";
import {
  deleteSnapshotArchiveForRow,
  type SnapshotLocationRow,
} from "../app-storage.ts";
import { resolveFolderResticConfigForHost } from "../backends.ts";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

const APP_SNAPSHOT_SELECT =
  "SELECT id, protection_id, template_id, template_revision, source_host_id, created_at, archive_path, archive_format, size_bytes, checksum_sha256, description, captured_spec, integrity_status, backend_id, object_key, s3_bucket FROM application_snapshots";

interface AppSnapshotRow extends SnapshotLocationRow {
  id: string;
  protection_id: string;
  created_at: number;
  size_bytes: number | null;
  integrity_status: string;
}

interface ResticSnapshotRow {
  id: string;
  folder_id: string;
  host_id: string;
  snapshot_id: string;
  timestamp: number;
  size_bytes: number | null;
}

interface FolderRow {
  id: string;
  name: string;
  type: string;
  backend: string;
  backend_id: string | null;
}

// ---------------------------------------------------------------------------
// Policy parsing / validation.
// ---------------------------------------------------------------------------

export function parseRetentionPolicy(raw: string | null | undefined): RetentionPolicy | null {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    const v = JSON.parse(raw) as RetentionPolicy;
    if (typeof v !== "object" || v === null || typeof v.enabled !== "boolean") return null;
    return {
      enabled: v.enabled,
      rules: Array.isArray(v.rules) ? v.rules : [],
      keepAtLeastOne: v.keepAtLeastOne !== false,
    };
  } catch {
    return null;
  }
}

/** Validate an incoming rule; returns an error string or null. */
function validateRule(rule: unknown): string | null {
  if (typeof rule !== "object" || rule === null) return "rule must be an object";
  const r = rule as Record<string, unknown>;
  if (r.kind === "keepLast") {
    if (typeof r.count !== "number" || !Number.isInteger(r.count) || r.count < 1 || r.count > 3650) {
      return "keepLast.count must be an integer in 1..3650";
    }
    return null;
  }
  if (r.kind === "keepAge") {
    if (typeof r.maxAgeMs !== "number" || !Number.isFinite(r.maxAgeMs) || r.maxAgeMs <= 0) {
      return "keepAge.maxAgeMs must be a positive number of milliseconds";
    }
    return null;
  }
  if (r.kind === "calendar") {
    if (r.unit !== "daily" && r.unit !== "weekly" && r.unit !== "monthly" && r.unit !== "yearly") {
      return "calendar.unit must be daily|weekly|monthly|yearly";
    }
    if (typeof r.count !== "number" || !Number.isInteger(r.count) || r.count < 1 || r.count > 3650) {
      return "calendar.count must be an integer in 1..3650";
    }
    return null;
  }
  return "unknown rule kind";
}

/** Normalize an incoming policy body into a validated RetentionPolicy. */
export function normalizePolicyBody(body: {
  enabled?: unknown;
  rules?: unknown;
  applySmartPreset?: unknown;
}): { policy: RetentionPolicy | null; error: string | null } {
  const applySmart = body.applySmartPreset;
  let rules: RetentionRule[] = [];
  if (applySmart !== undefined && applySmart !== null) {
    if (typeof applySmart !== "object") {
      return { policy: null, error: "applySmartPreset must be an object" };
    }
    const preset = applySmart as Record<string, unknown>;
    const pick = (k: string): number => {
      const v = preset[k];
      return typeof v === "number" && Number.isInteger(v) ? v : 0;
    };
    rules = smartRetentionRules({
      daily: pick("daily"),
      weekly: pick("weekly"),
      monthly: pick("monthly"),
      yearly: pick("yearly"),
    });
  } else {
    if (!Array.isArray(body.rules)) {
      return { policy: null, error: "rules must be an array (or use applySmartPreset)" };
    }
    for (const rule of body.rules) {
      const err = validateRule(rule);
      if (err) return { policy: null, error: err };
      rules.push(rule as RetentionRule);
    }
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return { policy: null, error: "enabled must be a boolean" };
  }
  return {
    policy: { enabled: body.enabled === true, rules, keepAtLeastOne: true },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Snapshot descriptor collection.
// ---------------------------------------------------------------------------

/** App snapshots → evaluator descriptors. `successful` = the archive was
 *  captured (verified OR unverified); `failed` integrity is a delete
 *  candidate like any other. Pins/rollback hooks are reserved (no
 *  pinning feature or restore executor exists yet). */
function appDescriptors(rows: AppSnapshotRow[]): RetentionSnapshotDescriptor[] {
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.created_at,
    sizeBytes: r.size_bytes,
    successful: r.integrity_status !== "failed",
  }));
}

/** Restic snapshots → descriptors. restore jobs that are still
 *  pending/running make the referenced snapshot a rollback artifact (never
 *  pruned before its operation finalizes). */
function resticDescriptors(db: Database, rows: ResticSnapshotRow[], folderId: string): RetentionSnapshotDescriptor[] {
  const inFlight = new Set<string>(
    db
      .query<{ snapshot_id: string }, [string]>(
        `SELECT snapshot_id FROM restic_restore_jobs
          WHERE folder_id = ? AND status IN ('pending', 'running')`,
      )
      .all(folderId)
      .map((r) => r.snapshot_id),
  );
  return rows.map((r) => ({
    id: r.snapshot_id,
    timestamp: r.timestamp,
    sizeBytes: r.size_bytes,
    successful: true,
    rollback: inFlight.has(r.snapshot_id),
    hostId: r.host_id,
  }));
}

// ---------------------------------------------------------------------------
// Preview (read-only).
// ---------------------------------------------------------------------------

interface PreviewResult {
  policy: RetentionPolicy;
  policyDescription: string;
  evaluation: ReturnType<typeof evaluateRetention>;
  snapshots: Array<{
    id: string;
    createdAt: number;
    sizeBytes: number | null;
    successful: boolean;
    decision: RetentionDecision;
  }>;
}

function buildPreview(
  policy: RetentionPolicy | null,
  descriptors: RetentionSnapshotDescriptor[],
  rawById: Map<string, { createdAt: number; sizeBytes: number | null; successful: boolean }>,
): PreviewResult {
  const effective: RetentionPolicy = policy ?? { enabled: false, rules: [], keepAtLeastOne: true };
  const evaluation = evaluateRetention({ snapshots: descriptors, policy: effective });
  const decisionById = new Map(evaluation.decisions.map((d) => [d.id, d]));
  const snapshots = descriptors
    .map((d) => {
      const raw = rawById.get(d.id);
      const decision = decisionById.get(d.id);
      return {
        id: d.id,
        createdAt: raw?.createdAt ?? d.timestamp,
        sizeBytes: raw?.sizeBytes ?? d.sizeBytes ?? null,
        successful: d.successful,
        decision: decision ?? { id: d.id, action: "keep" as const, reason: "kept (disabled policy)", kind: "policy" as const },
      };
    })
    .sort((a, b) => a.createdAt - b.createdAt);
  return {
    policy: effective,
    policyDescription: describePolicy(effective),
    evaluation,
    snapshots,
  };
}

// ---------------------------------------------------------------------------
// Execution (confirmed, destructive).
// ---------------------------------------------------------------------------

const inFlight = new Set<string>();

type ExecOutcome = { id: string; status: "deleted" | "absent" | "failed" | "skipped"; error?: string | null };

/** RESTIC_PASSWORD-style helper: write a 0600 password file for restic. */
function tempPasswordFile(password: string): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "lamasync-restic-pass-"));
  const file = join(dir, "password");
  writeFileSync(file, password, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { file, dir };
}

const RESTIC_TIMEOUT_MS = 600_000;

/** Strip embedded credentials from a repo string before it reaches the wire
 *  or Activity: scheme://user:pass@host → scheme://<redacted>@host, and any
 *  accidental occurrence of the password is masked. */
export function scrubRepository(repo: string, password: string): string {
  let out = repo.replace(/\/\/[^/@\s]+@/, "//<redacted>@");
  if (password !== "") {
    out = out.split(password).join("<redacted>");
  }
  return out;
}

export interface ResticRun {
  code: number;
  stderr: string;
}

export interface ResticExec {
  (args: string[]): Promise<ResticRun>;
}

let resticExecForTests: ResticExec | null = null;

/** Test seam: replace the restic spawner. Pass null to restore. */
export function __setResticExecForTest(fn: ResticExec | null): void {
  resticExecForTests = fn;
}

async function runRestic(args: string[]): Promise<{ code: number; stderr: string }> {
  if (resticExecForTests !== null) return resticExecForTests(args);
  // The restic password travels ONLY via the 0600 --password-file (never on
  // the command line, never in the inherited process env). Do not add a
  // RESTIC_PASSWORD variable here: the secret would be visible in the child
  // environment and could leak into core dumps / /proc for the child's
  // lifetime. The inherited environment is preserved as-is.
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
    signal: AbortSignal.timeout(RESTIC_TIMEOUT_MS),
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr };
}


interface ResticRepoPlan {
  repo: string;
  password: string;
  snapshotIds: string[];
}

/** Group restic delete candidates by repository (per-host overrides are
 *  resolved per snapshot; unresolvable hosts report a per-item failure). */
function planResticRepos(
  db: Database,
  folder: FolderRetentionRow,
  candidates: Array<{ snapshot: ResticSnapshotRow; reason: string }>,
): { plans: Map<string, ResticRepoPlan>; unresolvable: ExecOutcome[] } {
  const plans = new Map<string, ResticRepoPlan>();
  const unresolvable: ExecOutcome[] = [];
  for (const { snapshot } of candidates) {
    // The restic resolvers read camelCase folder fields — map the raw row.
    const config = resolveFolderResticConfigForHost(
      db,
      { id: folder.id, backend: folder.backend, backendId: folder.backend_id },
      snapshot.host_id,
    );
    if (!config) {
      unresolvable.push({
        id: snapshot.snapshot_id,
        status: "failed",
        error: `no restic repository resolvable for host ${snapshot.host_id}`,
      });
      continue;
    }
    const key = `${config.repository}\u0000${config.password}`;
    let plan = plans.get(key);
    if (!plan) {
      plan = { repo: config.repository, password: config.password, snapshotIds: [] };
      plans.set(key, plan);
    }
    plan.snapshotIds.push(snapshot.snapshot_id);
  }
  return { plans, unresolvable };
}

/** App scope: reuse the LAMA-324 delete primitive (exact per-snapshot
 *  stored location; missing backend fails closed). */
async function deleteAppArchive(db: Database, row: AppSnapshotRow): Promise<ExecOutcome> {
  const locationRow: SnapshotLocationRow = {
    backend_id: row.backend_id,
    object_key: row.object_key,
    s3_bucket: row.s3_bucket,
    archive_path: row.archive_path,
  };
  const outcome = await deleteSnapshotArchiveForRow(db, locationRow);
  if (outcome.status === "failed") {
    return { id: row.id, status: "failed", error: outcome.error };
  }
  // deleted or absent: the row is removed (absent = archive already gone).
  db.run(`DELETE FROM application_snapshots WHERE id = ?`, [row.id]);
  return { id: row.id, status: outcome.status === "deleted" ? "deleted" : "absent" };
}

function recordOperationLog(opts: {
  operation: string;
  folderId: string | null;
  summary: string;
  status: "success" | "failed";
  details: Record<string, unknown>;
}): number {
  const ts = Date.now();
  const result = activeDb
    .query<{ id: number }, [number, string | null, string, string, string | null, string | null]>(
      `INSERT INTO operation_log (timestamp, host_id, folder_id, operation, status, summary, details, trigger)
       VALUES (?, '_retention', ?, ?, ?, ?, ?, 'manual')
       RETURNING id`,
    )
    .get(ts, opts.folderId, opts.operation, opts.status, opts.summary, JSON.stringify(opts.details));
  return result?.id ?? 0;
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

const ruleBody = t.Object({
  kind: t.String(),
  count: t.Optional(t.Number()),
  maxAgeMs: t.Optional(t.Number()),
  unit: t.Optional(t.String()),
});

export const retentionRoutes = new Elysia({ prefix: "/api/v1" })
  // -------------------------------------------------------------------------
  // App-protection retention (snapshot identity = application_snapshots).
  // -------------------------------------------------------------------------
  .get(
    "/apps/protections/:id/retention",
    ({ params, set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const protection = activeDb
        .query<{ id: string }, [string]>(`SELECT id FROM application_protections WHERE id = ?`)
        .get(params.id);
      if (!protection) {
        set.status = 404;
        return { error: "Protection not found" };
      }
      const row = activeDb
        .query<{ retention_policy: string | null }, [string]>(
          `SELECT retention_policy FROM application_protections WHERE id = ?`,
        )
        .get(params.id);
      const policy = parseRetentionPolicy(row?.retention_policy ?? null);
      return { policy, policyDescription: describePolicy(policy ?? { enabled: false, rules: [], keepAtLeastOne: true }) };
    },
    { detail: { summary: "Get an app protection's retention policy", tags: ["Retention"] } },
  )
  .put(
    "/apps/protections/:id/retention",
    ({ body, params, set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const protection = activeDb
        .query<{ id: string }, [string]>(`SELECT id FROM application_protections WHERE id = ?`)
        .get(params.id);
      if (!protection) {
        set.status = 404;
        return { error: "Protection not found" };
      }
      const normalized = normalizePolicyBody(body);
      if (normalized.error) {
        set.status = 400;
        return { error: normalized.error };
      }
      const policy = normalized.policy!;
      activeDb.run(
        `UPDATE application_protections SET retention_policy = ?, updated_at = ? WHERE id = ?`,
        [policy.enabled || policy.rules.length > 0 ? JSON.stringify(policy) : null, Date.now(), params.id],
      );
      return {
        policy,
        policyDescription: describePolicy(policy),
      };
    },
    {
      body: t.Object({
        enabled: t.Optional(t.Boolean()),
        rules: t.Optional(t.Array(ruleBody)),
        applySmartPreset: t.Optional(
          t.Object({
            daily: t.Optional(t.Number()),
            weekly: t.Optional(t.Number()),
            monthly: t.Optional(t.Number()),
            yearly: t.Optional(t.Number()),
          }),
        ),
      }),
      detail: { summary: "Set an app protection's retention policy (admin)", tags: ["Retention"] },
    },
  )
  .post(
    "/apps/protections/:id/retention/preview",
    ({ params, set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const protection = activeDb
        .query<{ id: string }, [string]>(`SELECT id FROM application_protections WHERE id = ?`)
        .get(params.id);
      if (!protection) {
        set.status = 404;
        return { error: "Protection not found" };
      }
      const policyRow = activeDb
        .query<{ retention_policy: string | null }, [string]>(
          `SELECT retention_policy FROM application_protections WHERE id = ?`,
        )
        .get(params.id);
      const rows = activeDb
        .query<AppSnapshotRow, [string]>(`${APP_SNAPSHOT_SELECT} WHERE protection_id = ? ORDER BY created_at ASC`)
        .all(params.id);
      const rawById = new Map(rows.map((r) => [r.id, { createdAt: r.created_at, sizeBytes: r.size_bytes, successful: r.integrity_status !== "failed" }]));
      return buildPreview(parseRetentionPolicy(policyRow?.retention_policy ?? null), appDescriptors(rows), rawById);
    },
    { detail: { summary: "Preview app protection retention (read-only)", tags: ["Retention"] } },
  )
  .post(
    "/apps/protections/:id/retention/execute",
    async ({ body, params, set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (body.confirm !== true) {
        set.status = 400;
        return { error: "Destructive retention execution requires confirm: true" };
      }
      const lockKey = `app:${params.id}`;
      if (inFlight.has(lockKey)) {
        set.status = 409;
        return { error: "A retention execution is already in progress for this protection" };
      }
      const protection = activeDb
        .query<{ id: string; retention_policy: string | null }, [string]>(
          `SELECT id, retention_policy FROM application_protections WHERE id = ?`,
        )
        .get(params.id);
      if (!protection) {
        set.status = 404;
        return { error: "Protection not found" };
      }
      inFlight.add(lockKey);
      try {
        // FRESH evaluation — never trust a preview taken earlier.
        const rows = activeDb
          .query<AppSnapshotRow, [string]>(`${APP_SNAPSHOT_SELECT} WHERE protection_id = ? ORDER BY created_at ASC`)
          .all(params.id);
        const policy = parseRetentionPolicy(protection.retention_policy);
        const descriptors = appDescriptors(rows);
        const rawById = new Map(rows.map((r) => [r.id, { createdAt: r.created_at, sizeBytes: r.size_bytes, successful: r.integrity_status !== "failed" }]));
        const revalidatedPreview = buildPreview(policy, descriptors, rawById);

        const outcomes: ExecOutcome[] = [];
        const deleteDecisions = revalidatedPreview.evaluation.decisions.filter((d) => d.action === "delete");
        for (const decision of deleteDecisions) {
          const row = rows.find((r) => r.id === decision.id);
          if (!row) {
            // Snapshot vanished between evaluation and delete — its row was
            // removed by another actor; nothing to do (never reported as a
            // failed delete).
            continue;
          }
          outcomes.push(await deleteAppArchive(activeDb, row));
        }
        const failed = outcomes.filter((o) => o.status === "failed");
        const deleted = outcomes.filter((o) => o.status === "deleted").length;
        const absent = outcomes.filter((o) => o.status === "absent").length;
        const details: Record<string, unknown> = {
          scope: "app",
          protectionId: params.id,
          evaluated: revalidatedPreview.evaluation.deleteCount,
          deleted,
          absent,
          failed: failed.length,
          outcomes,
        };
        const logId = recordOperationLog({
          operation: "retention_execute",
          folderId: null,
          summary: failed.length > 0
            ? `App retention: pruned ${deleted}, ${failed.length} failed`
            : `App retention: pruned ${deleted}${absent > 0 ? ` (${absent} already absent)` : ""}`,
          status: failed.length > 0 ? "failed" : "success",
          details,
        });
        return {
          revalidatedPreview,
          outcomes,
          prune: null,
          operationLogId: logId,
        };
      } finally {
        inFlight.delete(lockKey);
      }
    },
    {
      body: t.Object({ confirm: t.Boolean() }),
      detail: { summary: "Execute app protection retention (requires confirm: true)", tags: ["Retention"] },
    },
  )

  // -------------------------------------------------------------------------
  // Folder retention (restic-backed folders only — ordinary backup/sync/
  // mount trees have no snapshot identity).
  // -------------------------------------------------------------------------
  .get(
    "/folders/:id/retention",
    ({ params, set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const folder = folderById(params.id);
      if (!folder) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      const scope = folderScopeError(folder);
      if (scope) {
        set.status = 400;
        return { error: scope };
      }
      const policy = parseRetentionPolicy(folder.retention_policy);
      return { policy, policyDescription: describePolicy(policy ?? { enabled: false, rules: [], keepAtLeastOne: true }) };
    },
    { detail: { summary: "Get a folder's retention policy (restic folders)", tags: ["Retention"] } },
  )
  .put(
    "/folders/:id/retention",
    ({ body, params, set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const folder = folderById(params.id);
      if (!folder) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      const scope = folderScopeError(folder);
      if (scope) {
        set.status = 400;
        return { error: scope };
      }
      const normalized = normalizePolicyBody(body);
      if (normalized.error) {
        set.status = 400;
        return { error: normalized.error };
      }
      const policy = normalized.policy!;
      activeDb.run(`UPDATE folders SET retention_policy = ? WHERE id = ?`, [
        policy.enabled || policy.rules.length > 0 ? JSON.stringify(policy) : null,
        params.id,
      ]);
      return { policy, policyDescription: describePolicy(policy) };
    },
    {
      body: t.Object({
        enabled: t.Optional(t.Boolean()),
        rules: t.Optional(t.Array(ruleBody)),
        applySmartPreset: t.Optional(
          t.Object({
            daily: t.Optional(t.Number()),
            weekly: t.Optional(t.Number()),
            monthly: t.Optional(t.Number()),
            yearly: t.Optional(t.Number()),
          }),
        ),
      }),
      detail: { summary: "Set a folder's retention policy (admin; restic folders)", tags: ["Retention"] },
    },
  )
  .post(
    "/folders/:id/retention/preview",
    ({ params, set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const folder = folderById(params.id);
      if (!folder) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      const scope = folderScopeError(folder);
      if (scope) {
        set.status = 400;
        return { error: scope };
      }
      const rows = resticRows(folder.id);
      const rawById = new Map(rows.map((r) => [r.snapshot_id, { createdAt: r.timestamp, sizeBytes: r.size_bytes, successful: true }]));
      return buildPreview(parseRetentionPolicy(folder.retention_policy), resticDescriptors(activeDb, rows, folder.id), rawById);
    },
    { detail: { summary: "Preview folder retention (read-only)", tags: ["Retention"] } },
  )
  .post(
    "/folders/:id/retention/execute",
    async ({ body, params, set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (body.confirm !== true) {
        set.status = 400;
        return { error: "Destructive retention execution requires confirm: true" };
      }
      const folder = folderById(params.id);
      if (!folder) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      const scopeError = folderScopeError(folder);
      if (scopeError) {
        set.status = 400;
        return { error: scopeError };
      }
      const lockKey = `folder:${params.id}`;
      if (inFlight.has(lockKey)) {
        set.status = 409;
        return { error: "A retention execution is already in progress for this folder" };
      }
      inFlight.add(lockKey);
      try {
        const rows = resticRows(folder.id);
        const policy = parseRetentionPolicy(folder.retention_policy);
        const rawById = new Map(rows.map((r) => [r.snapshot_id, { createdAt: r.timestamp, sizeBytes: r.size_bytes, successful: true }]));
        const revalidatedPreview = buildPreview(policy, resticDescriptors(activeDb, rows, folder.id), rawById);

        const deleteDecisionIds = new Set(
          revalidatedPreview.evaluation.decisions.filter((d) => d.action === "delete").map((d) => d.id),
        );
        const candidates = rows
          .filter((r) => deleteDecisionIds.has(r.snapshot_id))
          .map((snapshot) => ({ snapshot, reason: "not covered by any retention rule" }));
        const { plans, unresolvable } = planResticRepos(activeDb, folder, candidates);

        const outcomes: ExecOutcome[] = [...unresolvable];
        const prunedIds = new Set<string>();
        // PER-REPOSITORY prune outcomes (repo string scrubbed of any
        // embedded credentials). Failure aggregates MONOTONICALLY: a later
        // successful repo must never overwrite an earlier failed one.
        const pruneOutcomes: Array<{ repository: string; ok: boolean; error?: string | null }> = [];
        let pruneFailed = false;
        for (const plan of plans.values()) {
          let passwordFile: { file: string; dir: string } | null = null;
          try {
            passwordFile = tempPasswordFile(plan.password);
            const forget = await runRestic([
              "restic",
              "forget",
              ...plan.snapshotIds,
              "--repo",
              plan.repo,
              "--password-file",
              passwordFile.file,
              "--no-cache",
            ]);
            if (forget.code === 0) {
              for (const id of plan.snapshotIds) {
                outcomes.push({ id, status: "deleted" });
                prunedIds.add(id);
              }
              // Prune once per repo where something was forgotten.
              const pruneRun = await runRestic([
                "restic",
                "prune",
                "--repo",
                plan.repo,
                "--password-file",
                passwordFile.file,
                "--no-cache",
              ]);
              const ok = pruneRun.code === 0;
              if (!ok) pruneFailed = true;
              pruneOutcomes.push({
                repository: scrubRepository(plan.repo, plan.password),
                ok,
                error: ok ? null : (pruneRun.stderr.trim().split("\n").pop() ?? "restic prune failed"),
              });
            } else {
              for (const id of plan.snapshotIds) {
                outcomes.push({ id, status: "failed", error: forget.stderr.trim().split("\n").pop() ?? "restic forget failed" });
              }
            }
          } finally {
            if (passwordFile !== null) {
              try {
                rmSync(passwordFile.dir, { recursive: true, force: true });
              } catch {
                /* best-effort */
              }
            }
          }
        }
        const prune: { attempted: boolean; ok: boolean; outcomes: typeof pruneOutcomes } =
          pruneOutcomes.length > 0
            ? { attempted: true, ok: !pruneFailed, outcomes: pruneOutcomes }
            : { attempted: false, ok: true, outcomes: [] };
        // Remove DB rows for snapshots actually forgotten (never for
        // failed ones — a retry must still see them).
        if (prunedIds.size > 0) {
          const placeholders = [...prunedIds].map(() => "?").join(", ");
          activeDb.run(
            `DELETE FROM restic_snapshots WHERE folder_id = ? AND snapshot_id IN (${placeholders})`,
            [folder.id, ...prunedIds],
          );
        }
        const failed = outcomes.filter((o) => o.status === "failed");
        const deletedCount = outcomes.filter((o) => o.status === "deleted").length;
        const details: Record<string, unknown> = {
          scope: "folder",
          folderId: params.id,
          evaluated: revalidatedPreview.evaluation.deleteCount,
          deleted: deletedCount,
          failed: failed.length,
          pruneOutcomes,
          outcomes,
        };
        const logId = recordOperationLog({
          operation: "retention_execute",
          folderId: folder.id,
          summary:
            failed.length > 0 || pruneFailed
              ? `Folder retention: pruned ${deletedCount}, ${failed.length} failed${pruneFailed ? ", restic prune failed" : ""}`
              : `Folder retention: pruned ${deletedCount}${prune.attempted ? " + repository prune" : ""}`,
          status: failed.length > 0 || pruneFailed ? "failed" : "success",
          details,
        });
        return { revalidatedPreview, outcomes, prune, operationLogId: logId };
      } finally {
        inFlight.delete(lockKey);
      }
    },
    {
      body: t.Object({ confirm: t.Boolean() }),
      detail: { summary: "Execute folder retention (restic forget + prune; requires confirm: true)", tags: ["Retention"] },
    },
  );

interface FolderRetentionRow {
  id: string;
  name: string;
  type: string;
  backend: string;
  backend_id: string | null;
  retention_policy: string | null;
}

function folderById(id: string): FolderRetentionRow | null {
  return activeDb
    .query<FolderRetentionRow, [string]>(
      `SELECT id, name, type, backend, backend_id, retention_policy FROM folders WHERE id = ?`,
    )
    .get(id);
}

/** Folder retention applies ONLY to restic-backed folders (snapshot
 *  identity exists). Ordinary backup/sync/mount trees have mutable
 *  destinations with no versions to retain. */
function folderScopeError(folder: {
  backend: string;
}): string | null {
  if (folder.backend !== "restic") {
    return "Retention applies to restic-backed folders only; ordinary backup/sync/mount trees have no snapshot identity";
  }
  return null;
}

function resticRows(folderId: string): ResticSnapshotRow[] {
  return activeDb
    .query<ResticSnapshotRow, [string]>(
      `SELECT id, folder_id, host_id, snapshot_id, timestamp, size_bytes
         FROM restic_snapshots WHERE folder_id = ? ORDER BY timestamp ASC`,
    )
    .all(folderId);
}