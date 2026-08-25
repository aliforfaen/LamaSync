// LAMA-273: pause / slow mode toggle.
//
// The fleet can be paused globally (`POST /api/v1/pause`) or per-device
// (`POST /api/v1/hosts/:hostId/pause`) for a fixed window. `DELETE` on the
// same path clears the pause (resume). Slow mode stores a single-segment
// rclone size string the daemon appends to its argv via the existing
// `bandwidthSchedule` plumbing — there is intentionally no schedule
// support, only a flat cap.
//
// Every set/clear bumps `config_revision` so daemons re-pull their
// `/config/:hostId` payload and observe the new effective pause state. The
// effective pause resolution itself (host override → global fallback →
// none) lives in routes/config.ts, not here.

import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import type { PauseMode, PauseState } from "@lamasync/core";
import { db as defaultDb } from "../db.ts";
import { bumpConfigRevision, bumpConfigRevisionForPeers } from "../config-revision.ts";

const GLOBAL_ID = "global";

let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

interface PauseRow {
  id: string;
  scope: string;
  host_id: string | null;
  until_ms: number;
  mode: string;
  bwlimit: string | null;
  created_at: number;
}

function parseMode(value: unknown): PauseMode | null {
  return value === "pause" || value === "slow" ? value : null;
}

function rowToState(row: PauseRow): PauseState {
  return {
    scope: row.scope === "host" ? "host" : "global",
    hostId: row.host_id ?? undefined,
    until: new Date(row.until_ms).toISOString(),
    mode: row.mode === "slow" ? "slow" : "pause",
    bwlimit: row.bwlimit,
  };
}

/** LAMA-273: prune expired rows. Called on every read so daemons never
 *  observe a past `until` even if the writer-side cleanup was skipped. */
function pruneExpired(): void {
  const now = Date.now();
  activeDb.run("DELETE FROM pause_state WHERE until_ms <= ?", [now]);
}

/** True when the body parses to a valid pause payload. Returns the
 *  normalized epoch-ms `until` (or 0 for an explicit clear) and the
 *  validated `mode`/`bwlimit` pair on success; null + a reason on
 *  failure. */
function parsePauseBody(
  body: { until?: unknown; mode?: unknown; bwlimit?: unknown } | undefined,
): { ok: true; untilMs: number; mode: PauseMode; bwlimit: string | null } | { ok: false; error: string } {
  const rawUntil = body?.until;
  const rawMode = body?.mode;
  const rawBwlimit = body?.bwlimit ?? null;
  const mode = parseMode(rawMode);
  if (mode === null) {
    return { ok: false, error: "mode must be 'pause' or 'slow'" };
  }
  let untilMs: number;
  if (typeof rawUntil === "number") {
    untilMs = Math.floor(rawUntil);
  } else if (typeof rawUntil === "string" && rawUntil.trim() !== "") {
    const parsed = Date.parse(rawUntil);
    if (!Number.isFinite(parsed)) {
      return { ok: false, error: "until must be an ISO timestamp or epoch ms" };
    }
    untilMs = parsed;
  } else {
    return { ok: false, error: "until is required (ISO timestamp or epoch ms)" };
  }
  let bwlimit: string | null = null;
  if (rawBwlimit !== undefined && rawBwlimit !== null) {
    if (typeof rawBwlimit !== "string") {
      return { ok: false, error: "bwlimit must be a string" };
    }
    const trimmed = rawBwlimit.trim();
    if (trimmed.length > 0) {
      // LAMA-273: single-segment rclone size (e.g. "1M", "512K"). The
      // existing `bandwidthSchedule` field accepts comma-separated
      // schedules — for slow mode we deliberately restrict to ONE
      // segment, which rclone interprets as a flat cap (no schedule).
      if (!/^\d+(?:\.\d+)?[KMGT]?$/i.test(trimmed)) {
        return { ok: false, error: "bwlimit must look like '1M' or '512K' (no schedules)" };
      }
      bwlimit = trimmed;
    }
  }
  return { ok: true, untilMs, mode, bwlimit };
}

function writePause(scope: "global" | "host", hostId: string | null, untilMs: number, mode: PauseMode, bwlimit: string | null): PauseState {
  const id = scope === "global" ? GLOBAL_ID : (hostId as string);
  const now = Date.now();
  activeDb.run(
    `INSERT INTO pause_state (id, scope, host_id, until_ms, mode, bwlimit, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       scope = excluded.scope,
       host_id = excluded.host_id,
       until_ms = excluded.until_ms,
       mode = excluded.mode,
       bwlimit = excluded.bwlimit,
       created_at = excluded.created_at`,
    [id, scope, hostId, untilMs, mode, bwlimit, now],
  );
  const row = activeDb
    .query<PauseRow, [string]>(
      "SELECT id, scope, host_id, until_ms, mode, bwlimit, created_at FROM pause_state WHERE id = ?",
    )
    .get(id);
  if (!row) throw new Error("pause_state row missing after write");
  return rowToState(row);
}

function clearPause(id: string): boolean {
  const result = activeDb.run("DELETE FROM pause_state WHERE id = ?", [id]);
  return result.changes > 0;
}

/** LAMA-273: explicit semantic for POST-with-past-`until`. The brief says
 *  "POST with until in the past = clear, OR accept explicit clear semantics
 *  — pick ONE and document". We chose the explicit-DELETE verb so a UI
 *  with a momentary network race can't accidentally clear an active pause
 *  by replaying an old timestamp. Pausing for "now" means untilMs > now;
 *  the executor's belt-and-braces check makes expired rows harmless even
 *  if a future code path writes them. */
function isPastInstant(untilMs: number): boolean {
  return untilMs <= Date.now();
}

export const pauseRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/pause",
    () => {
      // Prune expired rows so GET always returns the current window.
      pruneExpired();
      const globalRow = activeDb
        .query<PauseRow, [string]>(
          "SELECT id, scope, host_id, until_ms, mode, bwlimit, created_at FROM pause_state WHERE scope = 'global' AND id = 'global'",
        )
        .get(GLOBAL_ID);
      const hostRows = activeDb
        .query<PauseRow, []>(
          "SELECT id, scope, host_id, until_ms, mode, bwlimit, created_at FROM pause_state WHERE scope = 'host' ORDER BY host_id ASC",
        )
        .all();
      return {
        global: globalRow ? rowToState(globalRow) : null,
        hosts: hostRows.map(rowToState),
      };
    },
    {
      detail: {
        summary: "Read current pause/slow state (global + per-host)",
        tags: ["Pause"],
        responses: {
          200: { description: "Global pause + per-host pauses" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/pause",
    ({ body, set }) => {
      const parsed = parsePauseBody(body);
      if (!parsed.ok) {
        set.status = 400;
        return { error: parsed.error };
      }
      const { untilMs, mode, bwlimit } = parsed;
      // See `isPastInstant` docstring: an explicit DELETE is the
      // resume verb. POST with a past `until` is rejected as a no-op
      // would silently clear state during timestamp-skew retries.
      if (isPastInstant(untilMs)) {
        set.status = 400;
        return { error: "until must be in the future; use DELETE /pause to resume" };
      }
      const state = writePause("global", null, untilMs, mode, bwlimit);
      // Affects every daemon — bump all hosts so each re-pulls.
      bumpConfigRevisionForPeers("__pause_global__");
      set.status = 201;
      return state;
    },
    {
      body: t.Object({
        until: t.Union([t.String(), t.Number()]),
        mode: t.Union([t.Literal("pause"), t.Literal("slow")]),
        bwlimit: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: {
        summary: "Set the global pause/slow window (fleet-wide)",
        tags: ["Pause"],
        responses: {
          201: { description: "Pause state set" },
          400: { description: "Invalid input" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .delete(
    "/pause",
    ({ set }) => {
      const removed = clearPause(GLOBAL_ID);
      // Even when there was nothing to clear, the bump is cheap and keeps
      // the contract uniform (every state change bumps every host).
      bumpConfigRevisionForPeers("__pause_global__");
      if (!removed) {
        set.status = 204;
        return null;
      }
      set.status = 204;
      return null;
    },
    {
      detail: {
        summary: "Resume (clear the global pause)",
        tags: ["Pause"],
        responses: {
          204: { description: "Cleared (or nothing to clear)" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/hosts/:hostId/pause",
    ({ params, body, set }) => {
      const hostId = params.hostId;
      // Confirm the host is known — refuse to enqueue a pause against a
      // host id that has never registered (would sit there forever).
      const host = activeDb
        .query<{ id: string }, [string]>("SELECT id FROM hosts WHERE id = ?")
        .get(hostId);
      if (!host) {
        set.status = 404;
        return { error: `Host '${hostId}' not found` };
      }
      const parsed = parsePauseBody(body);
      if (!parsed.ok) {
        set.status = 400;
        return { error: parsed.error };
      }
      const { untilMs, mode, bwlimit } = parsed;
      if (isPastInstant(untilMs)) {
        set.status = 400;
        return { error: "until must be in the future; use DELETE /hosts/:hostId/pause to resume" };
      }
      const state = writePause("host", hostId, untilMs, mode, bwlimit);
      bumpConfigRevision([hostId]);
      set.status = 201;
      return state;
    },
    {
      params: t.Object({ hostId: t.String() }),
      body: t.Object({
        until: t.Union([t.String(), t.Number()]),
        mode: t.Union([t.Literal("pause"), t.Literal("slow")]),
        bwlimit: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: {
        summary: "Set a per-device pause/slow window",
        tags: ["Pause"],
        responses: {
          201: { description: "Pause state set" },
          400: { description: "Invalid input" },
          404: { description: "Host not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .delete(
    "/hosts/:hostId/pause",
    ({ params, set }) => {
      const hostId = params.hostId;
      const removed = clearPause(hostId);
      bumpConfigRevision([hostId]);
      if (!removed) {
        set.status = 204;
        return null;
      }
      set.status = 204;
      return null;
    },
    {
      params: t.Object({ hostId: t.String() }),
      detail: {
        summary: "Resume (clear the per-device pause)",
        tags: ["Pause"],
        responses: {
          204: { description: "Cleared (or nothing to clear)" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );
