import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import type {
  Conflict,
  Folder,
  Host,
  OperationLog,
  ResticSnapshot,
  Share,
  StorageReport,
  WSEvent,
} from "@lamasync/core";
import { api } from "../api.ts";
import { useWebSocket } from "../hooks/useWebSocket.ts";

interface DashboardData {
  hosts: Host[];
  folders: Folder[];
  pendingConflicts: Conflict[];
  shares: Share[];
  snapshots: ResticSnapshot[];
  operations: OperationLog[];
}

function mergeEvent(prev: DashboardData, event: WSEvent): DashboardData {
  switch (event.kind) {
    case "operation":
      return { ...prev, operations: [event.entry, ...prev.operations].slice(0, 20) };
    case "host": {
      const others = prev.hosts.filter((h) => h.id !== event.host.id);
      return { ...prev, hosts: [...others, event.host] };
    }
    case "conflict": {
      const others = prev.pendingConflicts.filter((x) => x.id !== event.conflict.id);
      const next =
        event.conflict.status === "pending"
          ? [event.conflict, ...others]
          : others.filter((x) => x.status === "pending");
      return { ...prev, pendingConflicts: next };
    }
    case "restic_snapshot": {
      if (prev.snapshots.some((s) => s.id === event.snapshot.id)) return prev;
      return { ...prev, snapshots: [event.snapshot, ...prev.snapshots] };
    }
    default:
      return prev;
  }
}

function formatTimestamp(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

/** Human-readable byte count (KiB/MiB/GiB/TiB). */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = "B";
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

/**
 * Compact "time ago" label for triage cards. Full `toLocaleString()`
 * timestamps wrap to 2-3 lines inside the narrow attention-grid columns;
 * a relative label keeps each entry on a single line.
 */
function formatTimeAgo(ts: number | null | undefined): string {
  if (!ts) return "—";
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000) return "just now";
  const min = Math.floor(diffMs / 60_000);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

/**
 * LAMA-203: the last-visit timestamp used to highlight "what changed since
 * last visit". `null` means "never visited" — nothing is highlighted on the
 * first visit. The value is refreshed to `now` on every Command Center mount
 * (see the effect below), AFTER highlights are computed against the previous
 * value.
 */
const LAST_VISIT_KEY = "lamasync-last-visit";

function readLastVisit(): number | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(LAST_VISIT_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isNewSince(ts: number | undefined, lastVisit: number | null): boolean {
  return lastVisit !== null && typeof ts === "number" && ts > lastVisit;
}

interface AttentionItemProps {
  title: string;
  count: number;
  children?: ReactNode;
  to?: string;
}

function AttentionItem({ title, count, children, to }: AttentionItemProps) {
  return (
    <div className={`attention-item ${count ? "attention-active" : ""}`}>
      <div>
        <strong>{title}</strong>
        <span className="attention-count">{count}</span>
      </div>
      {count ? <div className="attention-detail">{children}</div> : null}
      {to && count ? (
        <Link className="attention-link" to={to}>
          View all →
        </Link>
      ) : null}
    </div>
  );
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { state: wsState, event } = useWebSocket();
  // LAMA-224: storage report (server-side 5-min cache; refresh button bypasses).
  const [storage, setStorage] = useState<StorageReport | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  // LAMA-203: captured once; highlights are computed against the previous
  // visit, then the stored value is bumped to `now` for the next one.
  const [lastVisit] = useState<number | null>(readLastVisit);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(LAST_VISIT_KEY, String(Date.now()));
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.health(),
      api.listFolders(),
      api.listConflicts("pending"),
      api.listShares(),
      api.listResticSnapshots(),
      api.listOperations({ limit: 100 }),
    ])
      .then(([health, folders, pendingConflicts, shares, snapshots, operations]) => {
        if (cancelled) return;
        setData({ hosts: health.hosts ?? [], folders, pendingConflicts, shares, snapshots, operations });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    // LAMA-224: storage totals (best-effort — the server caches for 5 min).
    api
      .storageReport()
      .then((report) => {
        if (!cancelled) setStorage(report);
      })
      .catch(() => {
        // storage is a nice-to-have; don't fail the dashboard over it
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (event) setData((prev) => (prev ? mergeEvent(prev, event) : prev));
  }, [event]);

  const counts = useMemo(() => {
    const hosts = data?.hosts ?? [];
    return {
      total: hosts.length,
      online: hosts.filter((h) => h.status === "online").length,
      offline: hosts.filter((h) => h.status === "offline" || h.status === "degraded").length,
      folders: data?.folders.length ?? 0,
      conflicts: data?.pendingConflicts.length ?? 0,
      shares: data?.shares.length ?? 0,
      snapshots: data?.snapshots.length ?? 0,
    };
  }, [data]);

  const failed = (data?.operations ?? []).filter(
    (op) => op.status === "failed" && op.timestamp >= Date.now() - 24 * 3600 * 1000,
  );
  const offline = (data?.hosts ?? []).filter(
    (h) => h.status === "offline" || h.status === "degraded",
  );
  const updates = (data?.hosts ?? []).filter((h) => h.updateAvailable);

  // LAMA-203: deltas since the previous visit (conflicts + failed ops only;
  // offline hosts and updates are state, not deltas).
  const newConflicts = (data?.pendingConflicts ?? []).filter((c) =>
    isNewSince(c.createdAt, lastVisit),
  ).length;
  const newFailed = failed.filter((op) => isNewSince(op.timestamp, lastVisit)).length;
  const newTotal = newConflicts + newFailed;

  const allQuiet =
    data !== null && !counts.conflicts && !failed.length && !offline.length && !updates.length;

  async function onRefreshStorage(): Promise<void> {
    setStorageBusy(true);
    setError(null);
    try {
      setStorage(await api.storageReport(true));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStorageBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Command Center</h1>
        <span className="muted">WS: {wsState}</span>
      </div>
      {error && <div className="error">{error}</div>}

      <section className="section">
        <h2>Needs attention{newTotal > 0 ? ` · ${newTotal} new` : ""}</h2>
        {allQuiet ? (
          <div className="all-quiet">✓ All quiet — your fleet is healthy</div>
        ) : (
          <div className="attention-grid">
            <AttentionItem title="Pending conflicts" count={counts.conflicts} to="/conflicts">
              <ul>
                {data?.pendingConflicts.slice(0, 3).map((c) => (
                  <li key={c.id} title={formatTimestamp(c.createdAt)}>
                    <span className="attention-entry-text">{c.folderId}</span>
                    <span className="attention-entry-time">
                      {formatTimeAgo(c.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </AttentionItem>
            <AttentionItem
              title="Failed operations (24h)"
              count={failed.length}
              to="/operations"
            >
              <ul>
                {failed.slice(0, 3).map((op) => (
                  <li
                    key={String(op.id)}
                    title={`${op.summary ?? op.operation} · ${formatTimestamp(op.timestamp)}`}
                  >
                    <span className="attention-entry-text">
                      {op.summary ?? op.operation}
                    </span>
                    <span className="attention-entry-time">
                      {formatTimeAgo(op.timestamp)}
                    </span>
                  </li>
                ))}
              </ul>
            </AttentionItem>
            <AttentionItem title="Offline / degraded" count={offline.length}>
              <div>
                {offline.map((h) => (
                  <span className="attention-host" key={h.id}>
                    {h.hostname}
                  </span>
                ))}
              </div>
            </AttentionItem>
            <AttentionItem title="Updates available" count={updates.length}>
              <div>
                {updates.map((h) => (
                  <span className="attention-host" key={h.id}>
                    {h.hostname} <code>v{h.version ?? "—"}</code>
                  </span>
                ))}
              </div>
            </AttentionItem>
          </div>
        )}
      </section>

      <section className="section">
        <h2>Fleet</h2>
        <div className="fleet-grid">
          {!data || !data.hosts.length ? (
            <div className="empty-row">No hosts registered yet</div>
          ) : (
            data.hosts.map((h) => (
              <Link className="fleet-card fleet-card-link" key={h.id} to={`/hosts/${encodeURIComponent(h.id)}`}>
                <div className="fleet-card-head">
                  <strong>{h.hostname}</strong>
                  <span className={`badge badge-${h.status}`}>{h.status}</span>
                </div>
                <span className="muted">Last seen {formatTimestamp(h.lastSeen)}</span>
                {h.tailnetIp ? <span className="muted">tailnet {h.tailnetIp}</span> : null}
                <span>
                  v{h.version ?? "—"}{" "}
                  {h.updateAvailable && <span className="badge badge-update">update</span>}
                </span>
              </Link>
            ))
          )}
        </div>
      </section>

      <div className="summary-grid">
        <SummaryCard label="Hosts" value={counts.total} />
        <SummaryCard label="Online" value={counts.online} accent="online" />
        <SummaryCard label="Folders" value={counts.folders} />
        <SummaryCard label="Shares" value={counts.shares} />
        <SummaryCard label="Snapshots" value={counts.snapshots} />
        <SummaryCard label="Storage" value={storage ? formatBytes(storage.totalBytes) : "—"} />
      </div>

      <section className="section">
        <div className="toolbar">
          <h2>Storage</h2>
          <button
            type="button"
            className="action"
            disabled={storageBusy}
            onClick={() => void onRefreshStorage()}
          >
            {storageBusy ? "Measuring…" : "Refresh"}
          </button>
        </div>
        {!storage ? (
          <div className="empty-row">Loading storage report…</div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Source</th>
                <th>Kind</th>
                <th>Size</th>
                <th>Objects</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {storage.backends.map((entry) => (
                <tr key={entry.backendId ?? entry.label}>
                  <td>{entry.label}</td>
                  <td>
                    <span className={`badge badge-${entry.kind}`}>{entry.kind}</span>
                  </td>
                  <td>{formatBytes(entry.bytes)}</td>
                  <td className="muted">{entry.objectCount ?? "—"}</td>
                  <td>
                    {entry.error ? (
                      <span className="badge badge-failed" title={entry.error}>
                        error
                      </span>
                    ) : (
                      <span className="badge badge-success">ok</span>
                    )}
                  </td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>Total</strong>
                </td>
                <td />
                <td>
                  <strong>{formatBytes(storage.totalBytes)}</strong>
                </td>
                <td />
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2>Recent activity</h2>
        <table className="data">
          <thead>
            <tr>
              <th>Time</th>
              <th>Host</th>
              <th>Operation</th>
              <th>Status</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {!data || !data.operations.length ? (
              <tr className="empty-row">
                <td colSpan={5}>No operations recorded</td>
              </tr>
            ) : (
              data.operations.map((op) => (
                <tr key={String(op.id)}>
                  <td>{formatTimestamp(op.timestamp)}</td>
                  <td>{op.hostId}</td>
                  <td>{op.operation}</td>
                  <td>
                    <span className={`badge badge-${op.status}`}>{op.status}</span>
                    {isNewSince(op.timestamp, lastVisit) ? (
                      <span className="chip-new">new</span>
                    ) : null}
                  </td>
                  <td className="muted">{op.summary ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className="section quick-actions">
        <h2>Quick actions</h2>
        <Link className="action" to="/folders">
          Manage folders →
        </Link>
        <Link className="action" to="/conflicts">
          Resolve conflicts →
        </Link>
      </section>
    </div>
  );
}

interface SummaryCardProps {
  label: string;
  value: number | string;
  accent?: "online" | "offline" | "conflict";
}

function SummaryCard({ label, value, accent }: SummaryCardProps) {
  return (
    <div className="summary-card">
      <span className="label">{label}</span>
      <span className={accent ? `value badge-${accent}` : "value"}>{value}</span>
    </div>
  );
}
