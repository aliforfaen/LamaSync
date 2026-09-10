// LAMA-327 — "Running now" live rclone sync panel.
//
// Paints the non-terminal phase surface from TWO sources, exactly per the
// contract:
//   - hydration: `GET /api/v1/sync-progress` (admin read) on mount and again
//     every time the WebSocket (re)opens, so a reconnect never leaves a gap.
//   - live events: `sync_progress` WS events upsert (or, on the terminal
//     success/failed phases, remove) entries.
//
// All state transitions are PURE functions exported for reducer tests, and
// the server registry never grows stale entries client-side beyond the next
// hydration (terminal broadcast removes them instantly).

import { useEffect, useRef, useState } from "react";
import type { LiveSyncPhase, LiveSyncProgress, WSEvent } from "@lamasync/core";
import { api } from "../api.ts";
import { useWebSocket } from "../hooks/useWebSocket.ts";
import { InlineError } from "./InlineError.tsx";

export const TERMINAL_LIVE_PHASES: ReadonlySet<LiveSyncPhase> = new Set([
  "success",
  "failed",
]);

/** Phases where a large initial bisync resync is most likely still listing
 *  trees before any transfer counter can appear. */
const PRE_TRANSFER_PHASES: ReadonlySet<string> = new Set([
  "queued",
  "lock",
  "preparing",
  "enumerating",
  "enumerating_local",
  "enumerating_remote",
  "reconciling",
  "working",
]);

/** Newest-started first (matches the server hydration sort). */
export function sortRunsNewestFirst(runs: LiveSyncProgress[]): LiveSyncProgress[] {
  return [...runs].sort((a, b) => b.startedAt - a.startedAt);
}

/** Replace the current set with the authoritative hydration snapshot. A run
 * can finish while the WebSocket is disconnected, so preserving an entry the
 * server no longer returns would leave a stale "Running now" card forever. */
export function mergeHydration(
  _current: LiveSyncProgress[],
  fresh: LiveSyncProgress[],
): LiveSyncProgress[] {
  return sortRunsNewestFirst(fresh.filter((r) => !TERMINAL_LIVE_PHASES.has(r.phase)));
}

/** Apply one WebSocket event: terminal phases remove the run; anything else
 *  upserts it. Unknown kinds are ignored (the panel only owns sync_progress). */
export function applySyncProgressEvent(
  runs: LiveSyncProgress[],
  event: WSEvent | null,
): LiveSyncProgress[] {
  if (event === null || event.kind !== "sync_progress") return runs;
  const p = event.progress;
  if (TERMINAL_LIVE_PHASES.has(p.phase)) {
    return runs.filter((r) => r.runId !== p.runId);
  }
  const others = runs.filter((r) => r.runId !== p.runId);
  return sortRunsNewestFirst([...others, p]);
}

/** True when the run is stuck in a pre-transfer phase with zero counters —
 *  bisync's initial resync can legitimately spend minutes listing a large
 *  remote tree before transfers exist, and the UI must say so instead of
 *  looking frozen. */
export function showEnumerationHint(p: LiveSyncProgress): boolean {
  if (!PRE_TRANSFER_PHASES.has(p.phase)) return false;
  const transfers = p.transfers === null || p.transfers === undefined ? 0 : p.transfers;
  const bytes = p.bytes === null || p.bytes === undefined ? 0 : p.bytes;
  return transfers === 0 && bytes === 0;
}

function formatElapsed(startedAt: number, nowMs: number): string {
  const ms = Math.max(0, nowMs - startedAt);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = "B";
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

const PHASE_LABEL: Record<string, string> = {
  queued: "Queued",
  lock: "Lock acquired",
  preparing: "Preparing",
  enumerating: "Enumerating",
  enumerating_local: "Enumerating local",
  enumerating_remote: "Enumerating remote",
  reconciling: "Reconciling",
  transferring: "Transferring",
  checking: "Checking",
  finalizing: "Finalizing",
  retrying: "Retrying",
  working: "Working",
  success: "Success",
  failed: "Failed",
};

function phaseBadgeClass(phase: LiveSyncPhase): string {
  if (phase === "transferring") return "badge-transferring";
  if (phase === "enumerating" || phase === "enumerating_local" || phase === "enumerating_remote") {
    return "badge-enumerating";
  }
  // Every other live phase reads as "in progress" (info accent); terminal
  // phases never render here (entries are removed on the terminal event).
  return "badge-started";
}

export function RunningNowPanel() {
  const { state: wsState, event } = useWebSocket();
  const [runs, setRuns] = useState<LiveSyncProgress[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hydratedOnceRef = useRef(false);

  // Elapsed-time ticker — the server refreshes `elapsedMs` only on
  // broadcast/hydration, so the panel ticks from the immutable startedAt.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Hydration read: once on mount (first paint) and again on every
  // WebSocket `open` so a reconnect never leaves a gap. The server registry
  // is in-memory and TTL-expired, so the fresh list is authoritative.
  const hydrate = async (): Promise<void> => {
    try {
      const fresh = await api.listSyncProgress();
      setRuns((prev) => (prev === null ? fresh : mergeHydration(prev, fresh)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (hydratedOnceRef.current && wsState !== "open") return;
    hydratedOnceRef.current = true;
    void hydrate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsState]);

  useEffect(() => {
    setRuns((prev) => (prev === null ? prev : applySyncProgressEvent(prev, event)));
  }, [event]);

  return (
    <section className="section">
      <div className="live-head">
        <h2>Running now</h2>
        <span className="ws-pill ws-open" title="Live sync runs">
          <span className="ws-dot" aria-hidden="true" /> live
        </span>
      </div>
      {error ? (
        <InlineError
          message={`Couldn't load live runs — ${error}`}
          onRetry={() => void hydrate()}
        />
      ) : null}
      {runs === null ? (
        <div className="skel skel-line" aria-busy="true" />
      ) : runs.length === 0 ? (
        <div className="empty-row">No syncs running right now</div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Device</th>
              <th>Folder</th>
              <th>Operation</th>
              <th>Phase</th>
              <th>Elapsed</th>
              <th>Progress</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.runId}>
                <td className="muted">{run.hostname ?? run.hostId}</td>
                <td className="muted">{run.folderName ?? run.folderId ?? "—"}</td>
                <td className="mono">{run.operation}</td>
                <td>
                  <span className={`badge ${phaseBadgeClass(run.phase)}`}>
                    {PHASE_LABEL[run.phase] ?? run.phase}
                  </span>
                </td>
                <td className="num mono">{formatElapsed(run.startedAt, nowMs)}</td>
                <td className="num mono">
                  {run.transfers !== null && run.transfers !== undefined
                    ? `${run.transfers} files`
                    : "—"}
                  {run.bytes !== null && run.bytes !== undefined && run.bytes > 0
                    ? ` · ${formatBytes(run.bytes)}`
                    : ""}
                </td>
                <td className="muted">
                  <span>{run.detail ?? "running"}</span>
                  {showEnumerationHint(run) ? (
                    <span className="live-hint">
                      First bisync/resync can list the trees for a while before
                      transfers appear.
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
