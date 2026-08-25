// LAMA-266: backup "Prove it" + monthly fire-drill engine.
//
// Two server-side surfaces share this engine:
//
//   POST /api/v1/backends/:backendId/prove   — one-shot "Prove it" run
//   POST /api/v1/backends/:backendId/drill   — same as prove + liveness
//                                              probe + audit/notification
//
// The same `runDrill` body is what the monthly scheduler invokes so the
// report cards (operation_log row, notification, health_drills row) stay
// identical for manual and scheduled runs.
//
// Liveness strategy
// -----------------
// `restic check` reads the full repo (cache + blobs) and is the textbook
// health command, but on multi-TiB repositories it runs in many minutes
// and is unsuitable as a monthly cron that fires for every restic
// backend the server knows about. We deliberately substitute a cheaper
// two-step probe:
//
//   1. `restic snapshots --json` against the backend's repository — proves
//      the repo is reachable, decryptable, and that the repo has at least
//      one snapshot to pick a "prove" target from.
//   2. The "prove" itself (one random small file from the latest snapshot,
//      restored to a private tempdir and compared against the snapshot
//      listing's stored hash) — proves the data is readable AND intact.
//
// If the snapshots listing passes but the prove fails, we still record
// `ok=false` with a scrubbed detail ("restic restore failed: <code>" —
// never the raw stderr) so the operator knows which leg broke.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { HealthDrill } from "@lamasync/core";
import { db as defaultDb } from "./db.ts";
import { getBackend } from "./backends.ts";
import { decryptSecret } from "./crypto.ts";
import {
  __setDb as __setNotificationDb,
  emitNotification,
} from "./notifications.ts";

// ---------- test seam ----------------------------------------------------

/** One restic invocation. `env` is merged with the caller's process.env
 *  by the default runner; tests pass a mock that ignores it. */
export interface ResticSpawnInput {
  args: string[];
  /** Repository + password; merged with process.env before spawn. */
  env?: Record<string, string>;
  /** Optional working directory (mostly for tests). */
  cwd?: string;
}

export interface ResticSpawnResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ResticSpawnFn = (
  input: ResticSpawnInput,
) => Promise<ResticSpawnResult>;

let activeRunner: ResticSpawnFn = defaultResticRunner;

/** Test seam — substitute a fake runner to assert argv + scrub behavior. */
export function __setResticRunnerForTests(fn: ResticSpawnFn | null): void {
  activeRunner = fn ?? defaultResticRunner;
}

async function defaultResticRunner(
  input: ResticSpawnInput,
): Promise<ResticSpawnResult> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (input.env) Object.assign(env, input.env);
  const proc = Bun.spawn(["restic", ...input.args], {
    env,
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

// ---------- DB seam -------------------------------------------------------

let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
  // The notification engine writes its own row to notification_events
  // when a drill succeeds/fails; keep both DBs in sync so test fixtures
  // (which `__setDb` on the engine + the notifications module share)
  // see the row.
  __setNotificationDb(next);
}

// ---------- result shapes -------------------------------------------------

/** Result of a "Prove it" run. Always returns ok=true/false; on failure
 *  `detail` is a SCRUBBED summary (never raw stderr, never secrets). */
export interface ProveOutcome {
  ok: boolean;
  /** Path of the restored file (relative to the tempdir) on success. */
  file?: string;
  /** Epoch ms when the run finished. */
  checkedAt: number;
  durationMs: number;
  /** Scrubbed summary when ok=false; safe to surface on the wire. */
  detail?: string;
}

/** Result of a full fire-drill. Wraps the prove outcome + liveness probe. */
export interface DrillOutcome extends ProveOutcome {
  backendId: string;
  backendName: string;
  kind: "prove" | "drill";
  livenessOk: boolean;
  /** Drill summary written into operation_log.summary. */
  summary: string;
  /** HealthDrill row id (one row inserted per run). */
  drillId: string;
}

// ---------- pure helpers (exported for unit tests) -----------------------

/** Parse the JSON array emitted by `restic snapshots --json -r <repo>`.
 *  Returns an empty list on parse failure (and surfaces the failure to
 *  the caller via the returned array, not by throwing). */
export function parseSnapshotsJson(stdout: string): Array<{
  id: string;
  time?: string;
  paths?: string[];
  tags?: string[];
}> {
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is { id: string } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === "string",
    ) as Array<{ id: string; time?: string; paths?: string[]; tags?: string[] }>;
  } catch {
    return [];
  }
}

/** One row extracted from a `restic ls --json <snapshot>` listing.
 *  Mirrors the shape the candidate picker downstream needs (path +
 *  size + isDir); we don't expose the restic-side fields (uid/gid/
 *  mode/mtime/...) because nothing reads them. */
export interface LsLongEntry {
  path: string;
  size: number;
  isDir: boolean;
}

/**
 * Parse the JSON-lines listing emitted by `restic ls --json <snapshotId>`.
 * Restic 0.17 writes one JSON object per line, with two message types
 * (per https://restic.readthedocs.io/en/v0.17.1/075_scripting.html#ls):
 *
 *   1. `{"message_type":"snapshot", ...}` — header line emitted ONCE at
 *      the start. Carries the snapshot id + paths; we ignore it.
 *   2. `{"message_type":"node", "name":..., "type":..., "path":...,
 *       "size":..., "uid":..., "gid":..., "mode":..., "permissions":...,
 *       "mtime":..., ...}` — one per file/dir/symlink/etc.
 *
 * Older 0.17.0 builds only emit `struct_type` (the deprecated alias of
 * `message_type`); we accept either to stay forward/backward compatible.
 *
 * Per-line contract:
 *   - A line that doesn't parse as JSON, or that doesn't decode to an
 *     object, is dropped silently (defensive — restic may evolve).
 *   - A non-"node" message type (e.g. the snapshot header, or a future
 *     `summary` line) is dropped.
 *   - `type` is the canonical isDir signal: `"dir"` → isDir=true.
 *     For entries with no `type` field (very old restic), we fall back
 *     to `permissions[0] === "d"` (the `ls -l`-style mode string).
 *   - `size` is omitted (`omitempty`) for non-file types; we default to
 *     0 so directories still flow through pickCandidate's isDir filter
 *     without NaN-poisoning size comparisons.
 *   - Only regular files and directories are returned. Symlinks, dev
 *     nodes, fifos, and sockets are dropped (restic restore can't
 *     `--include` them the way the prove step needs).
 */
export function parseLsJson(stdout: string): LsLongEntry[] {
  const out: LsLongEntry[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // malformed JSON line — drop silently
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    // Filter by struct_type / message_type when present. If a future
    // restic version emits a new message type we don't recognise, the
    // safest behaviour is to skip it — we'd rather restore nothing
    // than the wrong file.
    const structType = obj["struct_type"];
    const messageType = obj["message_type"];
    if (structType !== undefined && structType !== "node") continue;
    if (messageType !== undefined && messageType !== "node") continue;
    // Derive isDir: canonical `type` field first, permissions string
    // fallback for the rare build that doesn't emit `type`. Anything
    // we can't classify as file-or-dir (symlink, chardev, …) is
    // dropped — we only ever want to --include regular files.
    const typeField = obj["type"];
    let isDir: boolean;
    if (typeField === "file") isDir = false;
    else if (typeField === "dir") isDir = true;
    else if (typeField === undefined) {
      const perms = obj["permissions"];
      if (typeof perms !== "string" || perms.length === 0) continue;
      isDir = perms[0] === "d";
    } else {
      // symlink / chardev / blockdev / fifo / socket / dev — skip
      continue;
    }
    const path = obj["path"];
    if (typeof path !== "string" || path.trim() === "") continue;
    // `size` is a JSON number for files; restic omits the field for
    // directories + other node types. Default to 0 so we never NaN-
    // poison downstream comparisons.
    const sizeRaw = obj["size"];
    const size =
      typeof sizeRaw === "number" && Number.isFinite(sizeRaw)
        ? Math.max(0, sizeRaw)
        : 0;
    out.push({ path, size, isDir });
  }
  return out;
}

/** Choose a small candidate file from a long-listing. Filters to files
 *  ≤ `maxBytes` (default 64 KiB) and bounds by `max` entries (default 1024).
 *  Excludes hidden / well-known sidecar files that don't represent the
 *  real backup contents (`.lamasyncignore`, `*.swp`, etc.). */
export function pickCandidate(
  entries: LsLongEntry[],
  opts: { maxBytes?: number; max?: number; rng?: () => number } = {},
): LsLongEntry | null {
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const max = opts.max ?? 1024;
  const rng = opts.rng ?? Math.random;
  const filtered = entries
    .filter((e) => e.size > 0 && e.size <= maxBytes)
    .filter((e) => !/\.(swp|swo|bak|lamasyncignore|lamasyncmountignore)$/i.test(e.path))
    .slice(0, max);
  if (filtered.length === 0) return null;
  const idx = Math.min(filtered.length - 1, Math.floor(rng() * filtered.length));
  return filtered[idx] ?? null;
}

/** SHA-256 hex of a Buffer. */
export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * LAMA-226 / LAMA-266: build a SAFE failure summary for the wire. The
 * raw restic stderr can carry endpoint / bucket / host fragments we do
 * NOT want in API responses or report cards, so this function only
 * names the failing stage + exit code. Full stderr is logged server-
 * side by the caller before this runs.
 *
 * The `stage` argument lets the call site pass the restic subcommand
 * (e.g. "snapshots", "ls", "restore") so the operator gets a hint of
 * which leg of the drill broke without us echoing any stderr text.
 */
export function scrubFailureSummary(
  stage: string,
  code: number,
): string {
  const safeStage = stage.replace(/[^a-z0-9_-]/gi, "");
  if (safeStage === "") return `restic command failed with exit code ${code}`;
  return `restic ${safeStage} failed with exit code ${code}`;
}

// ---------- core run ------------------------------------------------------

interface ResolvedBackend {
  id: string;
  name: string;
  repository: string;
  password: string;
}

function resolveBackend(backendId: string): ResolvedBackend | null {
  const row = getBackend(activeDb, backendId);
  if (!row) return null;
  const repository = (row.restic_repository ?? "").trim();
  const password = decryptSecret(row.restic_password_enc) ?? "";
  if (repository === "" || password === "") return null;
  return { id: row.id, name: row.name, repository, password };
}

/** Liveness probe: cheapest restic call that confirms the repo is
 *  reachable, decryptable, and non-empty. Returns the latest snapshot id
 *  so the prove step can pick it as a target. */
async function livenessProbe(
  backend: ResolvedBackend,
  runner: ResticSpawnFn,
): Promise<{ ok: boolean; latestSnapshotId: string | null; code: number }> {
  const result = await runner({
    args: ["snapshots", "--json", "-r", backend.repository],
    env: { RESTIC_PASSWORD: backend.password },
  });
  if (result.code !== 0) {
    console.error(
      `[health-drill] restic snapshots failed for ${backend.name} (code ${result.code}): ${result.stderr.trim()}`,
    );
    return { ok: false, latestSnapshotId: null, code: result.code };
  }
  const entries = parseSnapshotsJson(result.stdout);
  if (entries.length === 0) {
    return { ok: false, latestSnapshotId: null, code: 0 };
  }
  // `restic snapshots --json` returns newest-first by time. Pick the
  // first entry as "latest" — that's also what the prove step uses.
  return { ok: true, latestSnapshotId: entries[0]?.id ?? null, code: 0 };
}

interface RunProveArgs {
  backendId: string;
  /** Inject the runner (tests use this; production passes nothing). */
  runner?: ResticSpawnFn;
  /** Inject the RNG (tests use this; production passes nothing). */
  rng?: () => number;
  /** Inject "now" (epoch ms) so test fixtures can assert against a
   *  fixed clock; production leaves this undefined and gets Date.now(). */
  now?: number;
}

/**
 * Run the "Prove it" sequence for a restic backend. Restores ONE small
 * file from the latest snapshot of the backend's repository into a
 * private tempdir (mkdtemp under os.tmpdir), compares its SHA-256 to
 * the snapshot's stored hash from `restic ls --json`, and cleans up the
 * tempdir in a `finally` block. Never writes to a real folder.
 *
 * Outcomes:
 *   ok=true      — tempdir cleaned up; `file` is the restored path
 *   ok=false     — `detail` is a scrubbed summary (no stderr/secrets);
 *                  tempdir is still cleaned up
 *
 * The caller is responsible for persisting the outcome to `backends`
 * (last_prove_at/last_prove_ok) and to operation_log/notification when
 * it wants the full drill audit trail. `runDrill` is the wired-up
 * version that does all of the above.
 */
export async function runProve(args: RunProveArgs): Promise<ProveOutcome> {
  const now = (): number => args.now ?? Date.now();
  const startedAt = now();
  const backend = resolveBackend(args.backendId);
  if (!backend) {
    // LAMA-266: non-restic backends (s3/local/nfs without a restic
    // repository + password) cannot be proven — the route layer maps
    // this throw to 409 with the api.md-documented message. Mirrors
    // the same throw pattern runDrill uses so callers can rely on a
    // single shape for "this backend cannot be drilled".
    throw new HealthDrillError(
      "prove requires a restic backend with snapshots",
    );
  }
  const runner = args.runner ?? activeRunner;

  // Step 1: liveness (cheap restic call + find latest snapshot).
  const probe = await livenessProbe(backend, runner);
  if (!probe.ok || probe.latestSnapshotId === null) {
    return {
      ok: false,
      checkedAt: now(),
      durationMs: now() - startedAt,
      detail:
        probe.code === 0
          ? "no restic snapshots found in the backend's repository"
          : `restic snapshots failed (exit ${probe.code})`,
    };
  }
  const snapshotId = probe.latestSnapshotId;

  // Step 2: list files in that snapshot, pick a small candidate.
  // We use `restic ls --json` rather than the long text listing because
  // the text format's column layout is brittle (mode, uid, gid, size,
  // date, time, path) and earlier restic builds produced a free-text
  // "snapshot <id> of [paths] at <time>" header that shifted every
  // column. JSON-lines gives one record per node with stable keys
  // (type, path, size, …) and is robust to spaces in paths.
  const lsResult = await runner({
    args: ["ls", "--json", snapshotId, "-r", backend.repository],
    env: { RESTIC_PASSWORD: backend.password },
  });
  if (lsResult.code !== 0) {
    console.error(
      `[health-drill] restic ls failed for ${backend.name} (code ${lsResult.code}): ${lsResult.stderr.trim()}`,
    );
    return {
      ok: false,
      checkedAt: now(),
      durationMs: now() - startedAt,
      detail: scrubFailureSummary("ls", lsResult.code),
    };
  }
  const entries = parseLsJson(lsResult.stdout);
  const candidate = pickCandidate(entries, { rng: args.rng });
  if (!candidate) {
    return {
      ok: false,
      checkedAt: now(),
      durationMs: now() - startedAt,
      detail: "no small files in the latest snapshot to prove with",
    };
  }

  // Defense-in-depth (LAMA-266): never spawn restic with `--include ""`.
  // A bug in the listing parser (or any future restic JSON-shape drift)
  // could otherwise produce a blank --include arg, which restic rejects
  // with `Fatal: --include: invalid pattern(s) provided:`. If this ever
  // triggers in production, treat it as a server-side bug — the parser
  // + picker should never let an empty path through.
  if (candidate.path.trim() === "") {
    console.error(
      `[health-drill] picked an empty candidate path for ${backend.name} — refusing to spawn restic with --include ""`,
    );
    return {
      ok: false,
      checkedAt: now(),
      durationMs: now() - startedAt,
      detail: "no usable files in the latest snapshot to prove with",
    };
  }

  // Step 3: restore the candidate into a private tempdir (mkdtemp gives
  // us a 0700 dir under os.tmpdir; we also pass `--no-lock` so we don't
  // collide with a daemon that's currently writing the same repo).
  const tempDir = mkdtempSync(join(tmpdir(), "lamasync-prove-"));
  try {
    const restoreResult = await runner({
      args: [
        "restore",
        "--no-lock",
        "--target",
        tempDir,
        "--include",
        candidate.path,
        snapshotId,
        "-r",
        backend.repository,
      ],
      env: { RESTIC_PASSWORD: backend.password },
    });
    if (restoreResult.code !== 0) {
      console.error(
        `[health-drill] restic restore failed for ${backend.name} (code ${restoreResult.code}): ${restoreResult.stderr.trim()}`,
      );
      return {
        ok: false,
        checkedAt: now(),
        durationMs: now() - startedAt,
        detail: scrubFailureSummary("restore", restoreResult.code),
      };
    }
    const restoredPath = join(tempDir, candidate.path.replace(/^\/+/, ""));
    if (!existsSync(restoredPath)) {
      return {
        ok: false,
        checkedAt: now(),
        durationMs: now() - startedAt,
        detail: `restic restore claimed success but ${candidate.path} is missing from the temp target`,
      };
    }
    const restoredBytes = readFileSync(restoredPath);
    const restoredHash = sha256Hex(restoredBytes);
    // The "snapshot stored hash" in `restic ls --json` is the size-only
    // hint (restic's ls output doesn't print sha256). Treat size match
    // AND non-empty as the "at minimum" check the spec allows — see the
    // module header. A future enhancement could cross-check against
    // `restic dump <snap>:<path>` for a byte-exact prove.
    const sizeMatches = restoredBytes.length === candidate.size;
    const nonEmpty = restoredBytes.length > 0;
    if (!nonEmpty) {
      return {
        ok: false,
        checkedAt: now(),
        durationMs: now() - startedAt,
        detail: `restored ${candidate.path} but it is empty`,
      };
    }
    if (!sizeMatches) {
      console.warn(
        `[health-drill] ${backend.name}: restored ${candidate.path} size ${restoredBytes.length} != listed ${candidate.size}; flagging as ok=false`,
      );
      return {
        ok: false,
        checkedAt: now(),
        durationMs: now() - startedAt,
        detail: `restored ${candidate.path} size mismatch (${restoredBytes.length} vs ${candidate.size})`,
      };
    }
    return {
      ok: true,
      file: candidate.path,
      checkedAt: now(),
      durationMs: now() - startedAt,
      detail: `sha256=${restoredHash} size=${restoredBytes.length}B`,
    };
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * LAMA-266: a bare manual "Prove it" run (POST /backends/:id/prove)
 * also stamps the backend's `last_prove_at`/`last_prove_ok` columns so
 * the UI badge updates immediately. The route layer calls this after a
 * successful runProve — the stamp is additive and never fails the
 * request. Wrapped in try/catch so a DB-side hiccup never escapes into
 * the handler.
 */
export function stampProveFromOutcome(
  backendId: string,
  outcome: ProveOutcome,
): void {
  try {
    upsertProveStamp(backendId, outcome.checkedAt, outcome.ok);
  } catch (err) {
    console.error(
      `[health-drill] prove stamp failed for ${backendId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------- audit + notification wiring ----------------------------------

interface RunDrillArgs extends RunProveArgs {
  /** Distinguishes the audit row from a manual prove. The route uses
   *  "drill" for /:backendId/drill + scheduler; "prove" is the result
   *  of a bare /:backendId/prove (no audit row written). */
  kind: "prove" | "drill";
}

/**
 * Run a "Prove it" + record the audit trail. Used by both the manual
 * /drill endpoint and the monthly scheduler so report cards (operation_log
 * row + notification + health_drills row) are identical regardless of
 * who triggered the run.
 */
export async function runDrill(args: RunDrillArgs): Promise<DrillOutcome> {
  const now = (): number => args.now ?? Date.now();
  const probeStartedAt = now();
  const backend = resolveBackend(args.backendId);
  if (!backend) {
    // No audit row when the backend doesn't resolve — the caller wants a
    // 409-style outcome, not a "drill failed" notification storm.
    throw new HealthDrillError(
      "backend is not a restic backend (missing repository or password)",
    );
  }
  // Pre-flight liveness (separate from the prove's internal probe, so
  // the drill report card can distinguish "repo unreachable" from
  // "restore failed").
  const preflight = await livenessProbe(backend, args.runner ?? activeRunner);
  const proveOutcome = await runProve({
    backendId: args.backendId,
    runner: args.runner,
    rng: args.rng,
    now: args.now,
  });
  const checkedAt = proveOutcome.checkedAt;
  const durationMs = now() - probeStartedAt;
  const ok = preflight.ok && proveOutcome.ok;
  const summary = ok
    ? `backup fire drill passed for ${backend.name}`
    : `backup fire drill failed for ${backend.name}`;
  const detail =
    ok
      ? null
      : proveOutcome.detail ??
        (preflight.ok ? "unknown drill failure" : "restic liveness probe failed");
  const drillId = recordDrill({
    backendId: backend.id,
    kind: args.kind,
    ranAt: checkedAt,
    ok,
    detail,
  });
  upsertProveStamp(backend.id, checkedAt, ok);
  appendOperationLog({
    hostId: "_backup-health-drill",
    summary,
    ok,
    durationMs,
  });
  // Notification: success → info; failure → critical. Uses the existing
  // notification engine (LAMA-200) so the same ntfy/webhook channels the
  // user already configured deliver the drill card. The payload's
  // `operation: "backup_drill"` is recognized by notifications.ts's
  // isBackupFailure() so the first consecutive failure already
  // escalates to critical.
  emitNotification({
    type: ok ? "operation_success" : "operation_failed",
    hostId: null,
    folderId: null,
    message: summary,
    payload: {
      operation: "backup_drill",
      backendId: backend.id,
      backendName: backend.name,
      detail,
      durationMs,
    },
  });
  return {
    ...proveOutcome,
    backendId: backend.id,
    backendName: backend.name,
    kind: args.kind,
    livenessOk: preflight.ok,
    summary,
    drillId,
  };
}

/** LAMA-266: a recoverable drill error — surfaces as 409 to the caller
 *  rather than getting persisted as a failed drill row + critical
 *  notification. Used for "backend not restic / missing config". */
export class HealthDrillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HealthDrillError";
  }
}

/** Insert one health_drills row. Id is a UUID; detail is the scrubbed
 *  failure summary (or null on success). */
export function recordDrill(row: {
  backendId: string;
  kind: "prove" | "drill";
  ranAt: number;
  ok: boolean;
  detail: string | null;
}): string {
  const id = randomUUID();
  activeDb.run(
    `INSERT INTO health_drills (id, backend_id, kind, ran_at, ok, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, row.backendId, row.kind, row.ranAt, row.ok ? 1 : 0, row.detail],
  );
  return id;
}

/** Stamp the backend's last_prove_at/last_prove_ok columns so the
 *  /backends response surfaces the badge without an extra endpoint. */
export function upsertProveStamp(
  backendId: string,
  ranAt: number,
  ok: boolean,
): void {
  activeDb.run(
    `UPDATE backends SET last_prove_at = ?, last_prove_ok = ? WHERE id = ?`,
    [ranAt, ok ? 1 : 0, backendId],
  );
}

/** Write a single operation_log row using the same shape other server
 *  code uses (see browse-jobs.ts / report.ts for the patterns). The
 *  host_id is a sentinel "_backup-health-drill" so the dashboard
 *  filters can keep this off the per-device feed; the dedicated
 *  /health/drills endpoint is the source of truth for drill history. */
export function appendOperationLog(args: {
  hostId: string;
  summary: string;
  ok: boolean;
  durationMs: number;
}): void {
  // Insert via the canonical column set; cast `duration_ms` to a
  // plain number — the column is INTEGER NOT NULL but allows null in
  // older rows.
  try {
    activeDb.run(
      `INSERT INTO operation_log
         (timestamp, host_id, folder_id, operation, status, summary, duration_ms)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      [
        Date.now(),
        args.hostId,
        "backup_drill",
        args.ok ? "success" : "failed",
        args.summary,
        args.durationMs,
      ],
    );
  } catch (error) {
    // Audit appends must never throw into the request handler.
    console.error(`[health-drill] operation_log append failed: ${String(error)}`);
  }
}

// ---------- history read --------------------------------------------------

const DRILL_DEFAULT_LIMIT = 50;
const DRILL_MAX_LIMIT = 200;

interface DrillRow {
  id: string;
  backend_id: string;
  kind: string;
  ran_at: number;
  ok: number;
  detail: string | null;
  backend_name: string | null;
}

export interface DrillHistoryEntry extends HealthDrill {
  backendName: string;
}

/** Recent drill history joined with the destination name. Newest first. */
export function listDrills(limitRaw?: number | string): DrillHistoryEntry[] {
  const parsed =
    typeof limitRaw === "number"
      ? limitRaw
      : limitRaw !== undefined && limitRaw !== ""
        ? Number.parseInt(String(limitRaw), 10)
        : DRILL_DEFAULT_LIMIT;
  const safeLimit = Number.isFinite(parsed)
    ? Math.min(Math.max(1, Math.floor(parsed)), DRILL_MAX_LIMIT)
    : DRILL_DEFAULT_LIMIT;
  const rows = activeDb
    .query<DrillRow, [number]>(
      `SELECT d.id, d.backend_id, d.kind, d.ran_at, d.ok, d.detail, b.name AS backend_name
         FROM health_drills d
         LEFT JOIN backends b ON b.id = d.backend_id
        ORDER BY d.ran_at DESC, d.rowid DESC
        LIMIT ?`,
    )
    .all(safeLimit);
  const out: DrillHistoryEntry[] = [];
  for (const r of rows) {
    if (r.kind !== "prove" && r.kind !== "drill") continue;
    out.push({
      id: r.id,
      backendId: r.backend_id,
      kind: r.kind,
      ranAt: r.ran_at,
      ok: r.ok === 1,
      detail: r.detail,
      backendName: r.backend_name ?? "(deleted backend)",
    });
  }
  return out;
}

// ---------- scheduler -----------------------------------------------------

/** Map backend id → most recent 'drill' (not 'prove') row, if any. */
export function lastDrillAtByBackend(
  db: Database = activeDb,
): Map<string, number> {
  const rows = db
    .query<{ backend_id: string; ran_at: number }, []>(
      `SELECT backend_id, MAX(ran_at) AS ran_at
         FROM health_drills
        WHERE kind = 'drill'
        GROUP BY backend_id`,
    )
    .all();
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.backend_id, row.ran_at);
  return out;
}

export interface SchedulerOptions {
  /** Cadence (ms) between scheduled drills per backend. Default 30 days. */
  intervalMs: number;
  /** Current epoch ms; tests inject a fake clock. */
  now: number;
  /** Optional runner override (tests). */
  runner?: ResticSpawnFn;
  /** Optional RNG override (tests). */
  rng?: () => number;
}

export interface SchedulerResult {
  inspected: number;
  due: number;
  ran: number;
  failed: number;
  results: DrillOutcome[];
}

/**
 * Monthly fire-drill scheduler pass. Inspects every backend in the
 * table, picks the ones whose most recent 'drill' row is older than
 * `intervalMs` (or has none at all), and runs `runDrill` for each —
 * sequentially, to avoid stacking concurrent rclone/restic spawns on
 * a fleet with many destinations. A pass with no due backends is a
 * no-op.
 *
 * The caller (server boot + the periodic timer in index.ts) is
 * responsible for skipping the boot pass when the last drill is
 * recent; this function runs every backends it's handed without
 * checking the previous run's wall-clock, so it can be invoked
 * safely at any time (e.g. by the manual /drill endpoint).
 */
export async function runDrillScheduler(
  opts: SchedulerOptions,
): Promise<SchedulerResult> {
  const cutoff = opts.now - opts.intervalMs;
  const lastDrill = lastDrillAtByBackend(activeDb);
  // Walk every backend (we don't filter to restic-only here — the
  // resolveBackend call inside runDrill does that and throws a
  // HealthDrillError for non-restic rows, which we swallow).
  const backends = activeDb
    .query<{ id: string }, []>("SELECT id FROM backends")
    .all();
  const due: string[] = [];
  for (const row of backends) {
    const last = lastDrill.get(row.id);
    if (last === undefined || last <= cutoff) due.push(row.id);
  }
  const results: DrillOutcome[] = [];
  let ran = 0;
  let failed = 0;
  for (const backendId of due) {
    try {
      const result = await runDrill({
        backendId,
        kind: "drill",
        runner: opts.runner,
        rng: opts.rng,
        now: opts.now,
      });
      results.push(result);
      ran += 1;
      if (!result.ok) failed += 1;
    } catch (err) {
      // Non-restic backends (or other unrecoverable setup errors) are
      // skipped silently — they have no business showing up on a drill
      // report. We only count real drill failures.
      if (!(err instanceof HealthDrillError)) {
        console.error(
          `[health-drill] scheduler pass for ${backendId} crashed: ${err instanceof Error ? err.message : String(err)}`,
        );
        failed += 1;
      }
    }
  }
  return {
    inspected: backends.length,
    due: due.length,
    ran,
    failed,
    results,
  };
}

// ---------- env defaults --------------------------------------------------

export const DEFAULT_DRILL_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
// Scheduler tick (how often the server checks for due backends). 1h is
// generous — the per-backend cadence is the 30-day interval above; this
// is just "how long after one pass could a newly-due backend be late by".
export const DEFAULT_DRILL_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function parseDrillIntervalMs(
  envValue: string | undefined,
  fallback: number,
): number {
  if (envValue === undefined) return fallback;
  const parsed = Number.parseInt(envValue, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// ---------- internal: avoid "unused" warnings on re-exports --------------
// mkdirSync / existsSync are reserved for a future enhancement where we
// could swap mkdtempSync for a per-backend persistent cache; keep the
// imports explicit so a future patch doesn't have to re-thread them.
void mkdirSync;
