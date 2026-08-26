// Admin endpoints — destructive operations guarded by auth.

import { Elysia, t } from "elysia";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import type {
  OperationLogExport,
  PruneResult,
} from "@lamasync/core";

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// P-B cleanup #6: export defaults to 90 days so the daily archive
// matches the default retention policy (LM_RETENTION_DAYS = 90).
const DEFAULT_EXPORT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

let activeDb: Database = defaultDb;

/** Test seam: let unit tests point this module at an in-memory database
 *  without having to write to disk. */
export function __setDb(next: Database): void {
  activeDb = next;
}

/** Reset back to the default singleton db; useful after a test run. */
export function __resetDb(): void {
  activeDb = defaultDb;
}

interface OperationLogRow {
  id: number;
  timestamp: number;
  host_id: string;
  folder_id: string | null;
  operation: string;
  status: string;
  summary: string | null;
  details: string | null;
  duration_ms: number | null;
  demo: number;
}

/** Audit shape: copy each DB column verbatim into camelCase JSON. We keep
 *  `status` as a plain string because `operation_log.status` is free-form
 *  TEXT (the daemon writes whatever rclone / hooks report — "success",
 *  "failed", "aborted", "running", "pending", and more). Narrowing to the
 *  `OperationStatus` union would collapse legitimate archive values into
 *  an undefined default. */
function rowToArchiveRow(row: OperationLogRow): Record<string, unknown> {
  return {
    id: row.id,
    timestamp: row.timestamp,
    hostId: row.host_id,
    folderId: row.folder_id,
    operation: row.operation,
    status: row.status,
    summary: row.summary,
    details: row.details,
    durationMs: row.duration_ms,
    demo: row.demo,
  };
}

/** Read every operation_log row older than `cutoff` that pruneOperationLog
 *  would also delete (preserving the latest per host). Returns rows in
 *  ascending id order so the NDJSON is replay-friendly. */
function selectArchivableRows(cutoff: number): OperationLogRow[] {
  const lastByHost = activeDb
    .query<{ id: number }, [number]>(
      "SELECT MAX(id) AS id FROM operation_log WHERE timestamp < ? GROUP BY host_id",
    )
    .all(cutoff);
  const excludedIds = lastByHost
    .map((r) => r.id)
    .filter((id): id is number => typeof id === "number");
  if (excludedIds.length > 0) {
    const placeholders = excludedIds.map(() => "?").join(",");
    return activeDb
      .query<OperationLogRow, (number | string)[]>(
        `SELECT id, timestamp, host_id, folder_id, operation, status, summary, details, duration_ms, demo
         FROM operation_log
         WHERE timestamp < ? AND id NOT IN (${placeholders})
         ORDER BY id ASC`,
      )
      .all(cutoff, ...excludedIds);
  }
  return activeDb
    .query<OperationLogRow, [number]>(
      `SELECT id, timestamp, host_id, folder_id, operation, status, summary, details, duration_ms, demo
       FROM operation_log
       WHERE timestamp < ?
       ORDER BY id ASC`,
    )
    .all(cutoff);
}

/**
 * Delete operation_log entries older than `olderThanMs` ago. The most recent
 * entry per host is preserved (older than the cutoff) so the last-known status
 * of an offline host remains visible.
 *
 * Idempotent; safe to call from a startup hook and a daily timer.
 */
export function pruneOperationLog(
  olderThanMs: number,
): PruneResult {
  const cutoff = Date.now() - olderThanMs;
  // Preserve the latest operation_log row per host so the last-known status
  // of an offline host does not silently disappear after pruning.
  const lastByHost = activeDb
    .query<{ id: number }, [number]>(
      "SELECT MAX(id) AS id FROM operation_log WHERE timestamp < ? GROUP BY host_id",
    )
    .all(cutoff);
  const excludedIds = lastByHost
    .map((r) => r.id)
    .filter((id): id is number => typeof id === "number");
  let result;
  if (excludedIds.length > 0) {
    const placeholders = excludedIds.map(() => "?").join(",");
    result = activeDb.run(
      `DELETE FROM operation_log WHERE timestamp < ? AND id NOT IN (${placeholders})`,
      [cutoff, ...excludedIds],
    );
  } else {
    result = activeDb.run("DELETE FROM operation_log WHERE timestamp < ?", [cutoff]);
  }
  return { deleted: result.changes, olderThanMs };
}

/**
 * Pick the archive directory: explicit override, then `LAMASYNC_BACKUP_DIR`,
 * then `os.tmpdir()` as a last-resort safety net (the operator may not have
 * provisioned a backup dir on a fresh dev box).
 */
function resolveArchiveDir(override: string | undefined): string {
  const candidate =
    typeof override === "string" && override.length > 0
      ? override
      : (process.env.LAMASYNC_BACKUP_DIR ?? "");
  return candidate.length > 0 ? candidate : tmpdir();
}

/** Resolve to a positive integer ms cutoff. Accepts the same unions
 *  Elysia gives us for query/body fields. */
function normalizeRetentionMs(raw: unknown, fallback: number): number | null {
  let provided: number | undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    provided = raw;
  } else if (typeof raw === "string" && raw.length > 0) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) provided = parsed;
  }
  const value = provided ?? fallback;
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function joinNdjson(lines: string[]): Uint8Array {
  // NDJSON = one JSON object per line. The decoder (`split('\n')`) needs
  // an actual newline separator; we also append a trailing `\n` so the
  // last entry is a well-formed POSIX text line. Then encode to bytes;
  // textEncoder.encode() returns Uint8Array<ArrayBuffer> (we widen the
  // generic to ArrayBufferLike because Bun.gzipSync accepts either, but
  // its overload picks the narrow ArrayBuffer form).
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

function compressNdjson(plain: Uint8Array): Uint8Array {
  // Bun ships a synchronous gzip codec — small one-shot call, no need for
  // streaming. Compresses about 6-10x on JSON repeats.
  return Bun.gzipSync(plain as Uint8Array<ArrayBuffer>);
}

function decodeNdjson(bytes: Uint8Array): string {
  return new TextDecoder().decode(
    Bun.gunzipSync(bytes as Uint8Array<ArrayBuffer>),
  );
}

/**
 * P-B cleanup #6: archive operation_log rows older than the cutoff to a
 * gzip-compressed NDJSON file, then DELETE only the archive rows. The
 * write goes to a `.ndjson.gz.tmp` sibling first, fsync'd, then atomically
 * renamed to the final `.ndjson.gz` path before the DB delete — a failed
 * archive write therefore leaves the rows in the DB so the next call can
 * retry. Format documented in the agent-skill reference.
 *
 * Idempotent: zero rows yields `{ archived: 0, file: null, deleted: 0 }`
 * so a daily timer can re-fire without producing extra archive files.
 */
export function archiveAndPruneOperationLog(
  olderThanMs: number,
  targetDir: string,
): OperationLogExport {
  const cutoff = Date.now() - olderThanMs;
  const archivable = selectArchivableRows(cutoff);

  if (archivable.length === 0) {
    return {
      archived: 0,
      file: null,
      deleted: 0,
      olderThanMs,
      targetDir,
    };
  }

  // Ensure the target dir exists; on a fresh dev box /tmp/lama-archive
  // may not exist yet — Bun.file's GzipStream also requires a parent dir.
  mkdirSync(targetDir, { recursive: true });

  const ndjsonLines = archivable.map((row) =>
    JSON.stringify(rowToArchiveRow(row)),
  );
  const plain = joinNdjson(ndjsonLines);
  const gz = compressNdjson(plain);
  const epoch = Math.floor(Date.now() / 1000);
  const finalPath = join(targetDir, `lamasync-oplog-${epoch}.ndjson.gz`);
  const tmpPath = `${finalPath}.tmp`;

  // Atomic-ish: write to .tmp, fsync the data, then rename. An interrupted
  // write leaves a stray .tmp file (which the next call will overwrite),
  // and never produces a half-written .ndjson.gz that downstream tooling
  // would have to distrust.
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, gz);
    // fsync before close: forces the data to stable storage so a power
    // loss after the close (but before the DB delete) doesn't lose the
    // archive — the DB delete is the moment we "commit" the operation.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Replace any leftover .tmp from a previous failed attempt (shouldn't
  // happen because the unique epoch suffix names each .tmp, but be safe
  // against clock weirdness).
  if (existsSync(finalPath)) unlinkSync(finalPath);
  renameSync(tmpPath, finalPath);

  // DELETE the exact set we just archived — same predicate the
  // preservation-candidates use, so the DB and archive stay in lockstep.
  const cutoffResult =
    pruneOperationLog(olderThanMs);
  // The archive predicate (selectArchivableRows) and the delete predicate
  // (pruneOperationLog) use the same timestamp + per-host-preservation
  // rule, so `cutoffResult.deleted` MUST equal `archivable.length`. If a
  // racing writer added a new "latest per host" row between the two,
  // the delete would return one fewer; we surface the actual count rather
  // than the planned count.
  return {
    archived: archivable.length,
    file: finalPath,
    deleted: cutoffResult.deleted,
    olderThanMs,
    targetDir,
  };
}

export const adminRoutes = new Elysia({ prefix: "/api/v1" })
  .post(
    "/admin/prune",
    ({ query, set }) => {
      const q = query as { olderThanMs?: number | string };
      const provided =
        typeof q.olderThanMs === "number"
          ? q.olderThanMs
          : q.olderThanMs
            ? Number.parseInt(String(q.olderThanMs), 10)
            : DEFAULT_RETENTION_MS;
      if (!Number.isFinite(provided) || provided < 0) {
        set.status = 400;
        return { error: "olderThanMs must be a non-negative integer" };
      }
      return pruneOperationLog(provided);
    },
    {
      query: t.Object({
        olderThanMs: t.Optional(t.Union([t.Number(), t.String()])),
      }),
      detail: {
        summary: "Prune operation_log entries older than the cutoff",
        tags: ["Admin"],
        responses: {
          200: { description: "Number of rows deleted" },
          400: { description: "Invalid input" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/admin/export",
    ({ body, set }) => {
      const input = (body ?? {}) as {
        olderThanMs?: number | string;
        targetDir?: string;
      };
      const retention = normalizeRetentionMs(
        input.olderThanMs,
        DEFAULT_EXPORT_RETENTION_MS,
      );
      if (retention === null) {
        set.status = 400;
        return { error: "olderThanMs must be a non-negative integer" };
      }
      const targetOverride =
        typeof input.targetDir === "string" && input.targetDir.length > 0
          ? input.targetDir
          : undefined;
      try {
        return archiveAndPruneOperationLog(retention, resolveArchiveDir(targetOverride));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set.status = 500;
        return { error: `export failed: ${message}` };
      }
    },
    {
      body: t.Object({
        olderThanMs: t.Optional(t.Union([t.Number(), t.String()])),
        targetDir: t.Optional(t.String()),
      }),
      detail: {
        summary:
          "Archive operation_log rows older than the cutoff to a gzip-compressed NDJSON file, then prune them",
        tags: ["Admin"],
        responses: {
          200: { description: "Archive written + rows deleted" },
          400: { description: "Invalid input" },
          401: { description: "Unauthorized" },
          500: { description: "Archive write failed (rows preserved)" },
        },
      },
    },
  );

// Decode helper used by tests; not exported to the Elysia surface because
// the live spec is `/swagger/json`.
export const __exportHelpersForTests = {
  decodeNdjson,
  normalizeRetentionMs,
  resolveArchiveDir,
};
