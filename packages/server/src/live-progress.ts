// LAMA-327 — bounded in-memory registry of live rclone sync runs.
//
// Live progress intentionally NEVER touches the database: operation_log
// stays the immutable terminal audit trail (one row per completion/failure),
// and this module keeps only the currently-running non-terminal snapshots.
// The registry is keyed by the daemon-generated runId; entries are:
//
//   - written by the device-scoped `POST /api/v1/sync-progress` report
//   - broadcast via a `sync_progress` WebSocket event only when something
//     materially changed (phase transition, terminal, or a ≥ `THROTTLE_MS`
//     counter snapshot)
//   - removed + broadcast-once on the terminal phases (success/failed)
//   - expired after `TTL_MS` without an update (crashed daemon / lost report)
//   - capped at `MAX_ENTRIES` (oldest startedAt evicted first)

import type { LiveSyncProgress, LiveSyncPhase, WSEvent } from "@lamasync/core";
import { broadcast } from "./ws.ts";

/** How long an entry survives without any update before it is dropped
 *  (crashed daemon, offline link, lost reports). 30 minutes is long enough
 *  to cover long initial bisync resyncs while still bounding memory. */
export const SYNC_PROGRESS_TTL_MS = 30 * 60_000;

/** Minimum wall-clock gap between counter-only broadcasts per entry. Phase
 *  transitions and terminal events always broadcast immediately. */
export const SYNC_PROGRESS_THROTTLE_MS = 5_000;

/** Maximum concurrent tracked runs. The fleet is small; the cap is a
 *  guarantee, not a budget. Oldest-starting entries are evicted first. */
export const SYNC_PROGRESS_MAX_ENTRIES = 128;

/** Wire detail cap — the daemon already bounds this, but the server clamps
 *  again so a compromised/buggy daemon can never inflate the broadcast. */
export const SYNC_PROGRESS_DETAIL_CAP = 200;

export const LIVE_SYNC_PHASES: ReadonlySet<string> = new Set<LiveSyncPhase>([
  "queued",
  "lock",
  "preparing",
  "enumerating",
  "enumerating_local",
  "enumerating_remote",
  "reconciling",
  "transferring",
  "checking",
  "finalizing",
  "retrying",
  "working",
  "success",
  "failed",
]);

const TERMINAL_PHASES: ReadonlySet<string> = new Set<LiveSyncPhase>(["success", "failed"]);

interface RegistryEntry {
  progress: LiveSyncProgress;
  /** Epoch ms of the last broadcast for THIS entry (throttle window). */
  lastBroadcastAt: number;
  /** Phase at the last broadcast (immediate broadcast on change). */
  lastBroadcastPhase: LiveSyncPhase;
  /** Serialized counters at the last broadcast (material-change check). */
  lastBroadcastCounters: string;
}

/** runId → entry. Iteration order matches insertion order in Bun's Map, so
 *  eviction pops the oldest-started first when we need headroom. */
const registry = new Map<string, RegistryEntry>();

/** Test seam: deterministic clock. Real calls pass no `now` param. */
export function __setNowSource(fn: () => number | null): void {
  nowSource = fn;
}
let nowSource: (() => number | null) | null = null;
function now(): number {
  const injected = nowSource?.();
  return typeof injected === "number" ? injected : Date.now();
}

/** Test seam: wipe registry + restore the live clock. */
export function __resetLiveProgressForTests(): void {
  registry.clear();
  nowSource = null;
}

function isLiveSyncPhase(value: unknown): value is LiveSyncPhase {
  return typeof value === "string" && LIVE_SYNC_PHASES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clampDetail(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const stripped = value.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  if (stripped.length === 0) return null;
  return stripped.length <= SYNC_PROGRESS_DETAIL_CAP
    ? stripped
    : `${stripped.slice(0, SYNC_PROGRESS_DETAIL_CAP)}…`;
}

function clampString(value: unknown, cap: number): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length <= cap ? value : value.slice(0, cap);
}

/** Narrow an unknown counter to a non-negative finite number or null. */
function clampCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function serializeCounters(p: LiveSyncProgress): string {
  return [
    p.phase,
    p.transfers ?? -1,
    p.bytes ?? -1,
    p.checks ?? -1,
    p.errors ?? -1,
    p.files ?? -1,
    p.detail ?? "",
  ].join("|");
}

/** Sweep expired entries. Called on every write and read. */
function sweepExpired(timestamp: number): void {
  if (registry.size === 0) return;
  for (const [runId, entry] of registry) {
    if (timestamp - entry.progress.updatedAt > SYNC_PROGRESS_TTL_MS) {
      registry.delete(runId);
    }
  }
}

/** Evict the oldest-starting entry when the cap is exceeded. */
function enforceCap(): void {
  while (registry.size > SYNC_PROGRESS_MAX_ENTRIES) {
    let oldestRunId: string | null = null;
    let oldestStartedAt = Number.POSITIVE_INFINITY;
    for (const [runId, entry] of registry) {
      if (entry.progress.startedAt < oldestStartedAt) {
        oldestStartedAt = entry.progress.startedAt;
        oldestRunId = runId;
      }
    }
    if (oldestRunId === null) break;
    registry.delete(oldestRunId);
  }
}

/**
 * Normalize a daemon update into a full wire snapshot. Rejects updates with
 * an unknown phase or a missing/oversized runId — a malformed report must
 * never poison the registry or the broadcast stream.
 */
export function normalizeProgressUpdate(
  body: unknown,
  timestamp: number,
): LiveSyncProgress | null {
  if (!isRecord(body)) return null;
  const rec = body;
  const runId = clampString(rec.runId, 64);
  const hostId = clampString(rec.hostId, 64);
  if (runId === null || hostId === null) return null;
  const phase = rec.phase;
  if (!isLiveSyncPhase(phase)) return null;
  const startedAt = rec.startedAt;
  const phaseStartedAt = rec.phaseStartedAt;
  if (
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    typeof phaseStartedAt !== "number" ||
    !Number.isFinite(phaseStartedAt)
  ) {
    return null;
  }
  const operation = clampString(rec.operation, 32) ?? "sync";
  const progress: LiveSyncProgress = {
    runId,
    hostId,
    hostname: clampString(rec.hostname, 64),
    folderId: clampString(rec.folderId, 64),
    folderName: clampString(rec.folderName, 96),
    operation,
    phase,
    startedAt,
    phaseStartedAt,
    updatedAt: timestamp,
    elapsedMs: Math.max(0, timestamp - startedAt),
    transfers: clampCount(rec.transfers),
    bytes: clampCount(rec.bytes),
    checks: clampCount(rec.checks),
    errors: clampCount(rec.errors),
    files: clampCount(rec.files),
    detail: clampDetail(rec.detail),
  };
  return progress;
}

function liveSyncEvent(progress: LiveSyncProgress): WSEvent {
  return { kind: "sync_progress", progress };
}

/**
 * Insert or update one live run and broadcast when something materially
 * changed. Returns the full snapshot (normalized + server-refreshed) that
 * was placed in the registry, or null when the update was malformed.
 *
 * Broadcast rules per entry:
 *   - terminal phase: broadcast exactly once, then the entry is removed.
 *   - phase transition: immediate.
 *   - everything else (counter/detail change): throttled to one broadcast
 *     per `SYNC_PROGRESS_THROTTLE_MS` window.
 */
export function upsertLiveProgress(body: unknown, timestamp: number = now()): LiveSyncProgress | null {
  sweepExpired(timestamp);
  const progress = normalizeProgressUpdate(body, timestamp);
  if (progress === null) return null;

  if (TERMINAL_PHASES.has(progress.phase)) {
    broadcast(liveSyncEvent(progress));
    registry.delete(progress.runId);
    return progress;
  }

  const existing = registry.get(progress.runId);
  const isNew = existing === undefined;
  const countersChanged =
    existing !== undefined &&
    serializeCounters(progress) !== serializeCounters(existing.progress);
  const phaseChanged = existing !== undefined && existing.progress.phase !== progress.phase;
  const throttled = existing !== undefined && timestamp - existing.lastBroadcastAt >= SYNC_PROGRESS_THROTTLE_MS;

  registry.set(progress.runId, {
    progress,
    lastBroadcastAt: existing?.lastBroadcastAt ?? 0,
    lastBroadcastPhase: existing?.lastBroadcastPhase ?? progress.phase,
    lastBroadcastCounters: existing?.lastBroadcastCounters ?? serializeCounters(progress),
  });
  enforceCap();

  if (isNew || phaseChanged || (countersChanged && throttled)) {
    const snapshot = registry.get(progress.runId)!.progress;
    const r = registry.get(progress.runId)!;
    r.lastBroadcastAt = timestamp;
    r.lastBroadcastPhase = snapshot.phase;
    r.lastBroadcastCounters = serializeCounters(snapshot);
    broadcast(liveSyncEvent(snapshot));
  }
  return registry.get(progress.runId)?.progress ?? progress;
}

/**
 * Admin hydration read: every active (non-terminal, non-expired) run,
 * newest-started first, with refreshable `elapsedMs`. Reconnecting clients
 * call this once after their WebSocket opens and then live off
 * `sync_progress` events.
 */
export function listActiveLiveProgress(timestamp: number = now()): LiveSyncProgress[] {
  sweepExpired(timestamp);
  const out: LiveSyncProgress[] = [];
  for (const entry of registry.values()) {
    const p: LiveSyncProgress = {
      ...entry.progress,
      updatedAt: timestamp,
      elapsedMs: Math.max(0, timestamp - entry.progress.startedAt),
    };
    out.push(p);
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

/** Test/audit seam: how many live entries are currently tracked. */
export function liveProgressSize(): number {
  return registry.size;
}
