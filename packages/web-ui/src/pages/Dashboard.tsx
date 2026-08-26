import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "../components/PageHeader.tsx";
import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import type {
  Backend,
  Conflict,
  DemoState,
  Folder,
  Host,
  OperationLog,
  ResticSnapshot,
  Share,
  StorageReport,
  WSEvent,
} from "@lamasync/core";
import { api } from "../api.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { GettingStarted } from "../components/GettingStarted.tsx";
import { ConfirmDialog } from "../components/Modal.tsx";
import { useWebSocket } from "../hooks/useWebSocket.ts";
import { usePause } from "../hooks/usePause.ts";
import { PauseBanner } from "../components/PauseBanner.tsx";
import { PauseControl } from "../components/PauseControl.tsx";
import { formatTimeAgo } from "../relative-time.ts";
import { showVerifiedBadge } from "../backup-health.ts";
import { OperationSentenceView } from "../components/OperationSentence.tsx";
import { Donut } from "../components/Donut.tsx";
import { Confetti, useMilestoneConfetti } from "../components/Confetti.tsx";

/** LAMA-265: "first backup ever seen" — a successful folder or app-settings
 *  backup in the feed (terminology: `backup` = Backup, `dotfile` = App
 *  settings backup). Never fires on failures. */
function isSuccessfulBackup(op: OperationLog): boolean {
  return (
    op.status === "success" &&
    (op.operation === "backup" || op.operation === "dotfile")
  );
}

interface DashboardData {
  hosts: Host[];
  folders: Folder[];
  pendingConflicts: Conflict[];
  shares: Share[];
  snapshots: ResticSnapshot[];
  operations: OperationLog[];
  // Workstream 2: first-run checklist inputs (best-effort).
  backends: Backend[];
  hasAssignments: boolean;
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
  // LAMA-273: global pause / slow mode — banner + control for the fleet.
  const { overview, refresh: refreshPause } = usePause();
  // LAMA-224: storage report (server-side 5-min cache; refresh button bypasses).
  const [storage, setStorage] = useState<StorageReport | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  // UX workstream 4: a failed storage fetch surfaces an inline hint instead
  // of being silently swallowed.
  const [storageError, setStorageError] = useState<string | null>(null);
  // LAMA-264: demo-mode state (whether a demo fleet is present). Best-effort;
  // failures are ignored so a missing endpoint never breaks the dashboard.
  const [demo, setDemo] = useState<DemoState | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [confirmDeleteDemo, setConfirmDeleteDemo] = useState(false);
  // LAMA-203: captured once; highlights are computed against the previous
  // visit, then the stored value is bumped to `now` for the next one.
  const [lastVisit] = useState<number | null>(readLastVisit);
  // LAMA-265: once-per-milestone confetti — first successful backup ever
  // seen in the operations feed (flag lives in localStorage, reload-safe).
  const { fire: fireFirstBackup, visible: showFirstBackup } =
    useMilestoneConfetti("first-backup-seen");

  // WS6 P4: resolve folder ids to display names for the needs-attention
  // conflict list. Memoized so the map is rebuilt only when the folders
  // list changes; unknown ids fall back to the raw id.
  const folderNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of data?.folders ?? []) m.set(f.id, f.name);
    return m;
  }, [data?.folders]);

  // LAMA-258: resolve device + storage-destination names for the activity
  // sentence. Unknown ids fall back to the raw id inside the sentence.
  const hostNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const h of data?.hosts ?? []) m.set(h.id, h.hostname);
    return m;
  }, [data?.hosts]);

  const backendNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of data?.backends ?? []) m.set(b.id, b.name);
    return m;
  }, [data?.backends]);

  // LAMA-266: backup-health badge. Show "✓ Verified <t> ago" when any
  // destination was proven ok within 30 days (using the most recent such
  // prove); otherwise a muted "not verified yet" caption.
  const backupVerified = useMemo(() => {
    const now = Date.now();
    let mostRecent: number | null = null;
    for (const b of data?.backends ?? []) {
      if (showVerifiedBadge(b.lastProveAt, b.lastProveOk, now)) {
        if (mostRecent === null || (b.lastProveAt ?? 0) > mostRecent) {
          mostRecent = b.lastProveAt ?? null;
        }
      }
    }
    return mostRecent;
  }, [data?.backends]);

  // folder id -> its storage destination display name (folder.backendId).
  const folderBackendNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of data?.folders ?? []) {
      if (f.backendId) {
        const name = backendNameById.get(f.backendId);
        if (name) m.set(f.id, name);
      }
    }
    return m;
  }, [data?.folders, backendNameById]);

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
      api.listBackends().catch(() => [] as Backend[]),
    ])
      .then(
        async ([
          health,
          folders,
          pendingConflicts,
          shares,
          snapshots,
          operations,
          backends,
        ]) => {
          if (cancelled) return;
          // Workstream 2: any folder assignment anywhere means step 4 is
          // done. Best-effort — a failure just keeps the step pending.
          let hasAssignments = false;
          try {
            const perFolder = await Promise.all(
              folders.map((f) => api.listAssignments(f.id)),
            );
            hasAssignments = perFolder.some((list) => list.length > 0);
          } catch {
            hasAssignments = false;
          }
          if (cancelled) return;
          setData({
            hosts: health.hosts ?? [],
            folders,
            pendingConflicts,
            shares,
            snapshots,
            operations,
            backends,
            hasAssignments,
          });
        },
      )
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    // LAMA-224: storage totals (best-effort — the server caches for 5 min).
    api
      .storageReport()
      .then((report) => {
        if (!cancelled) {
          setStorage(report);
          setStorageError(null);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStorageError(err instanceof Error ? err.message : String(err));
      });
    // LAMA-264: read demo-mode state (best-effort, never blocks render).
    api.getDemo().then(setDemo).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (event) setData((prev) => (prev ? mergeEvent(prev, event) : prev));
  }, [event]);

  // LAMA-265: fire the once-ever milestone the moment the feed shows any
  // successful backup — including backups that arrive via WebSocket. The
  // localStorage gate makes repeat runs no-ops, so this is safe to re-check
  // on every data change.
  useEffect(() => {
    if (data && (data.operations ?? []).some(isSuccessfulBackup)) {
      fireFirstBackup();
    }
  }, [data, fireFirstBackup]);

  async function onSeedDemo(): Promise<void> {
    setDemoBusy(true);
    try {
      await api.seedDemo();
      setDemo(await api.getDemo());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDemoBusy(false);
    }
  }

  async function onDeleteDemo(): Promise<void> {
    setConfirmDeleteDemo(false);
    setDemoBusy(true);
    try {
      await api.deleteDemo();
      setDemo(await api.getDemo());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDemoBusy(false);
    }
  }

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
      setStorageError(null);
    } catch (err) {
      setStorageError(err instanceof Error ? err.message : String(err));
    } finally {
      setStorageBusy(false);
    }
  }

  return (
    <div className="page">
      <PageHeader title="Dashboard" purpose="See what needs attention across your devices at a glance." />
<div className="toolbar">
        <span
          className={`ws-pill ws-${wsState}`}
          title="WebSocket connection status"
        >
          <span className="ws-dot" aria-hidden="true" /> {wsState}
        </span>
        <PauseControl
          scope="global"
          active={overview?.global !== null}
          onChanged={() => void refreshPause()}
        />
        {backupVerified !== null ? (
          <span
            className="badge badge-success"
            title="A storage destination was proven within the last 30 days"
          >
            ✓ Verified {formatTimeAgo(backupVerified)} ago
          </span>
        ) : (
          <span className="muted" title="Run 'Prove it' on a restic destination">
            backups not verified yet
          </span>
        )}
      </div>
      {overview?.global ? (
        <PauseBanner
          state={overview.global}
          scope="global"
          onResumed={() => void refreshPause()}
        />
      ) : null}
      {error && <div className="error">{error}</div>}

      {showFirstBackup ? (
        <Confetti fallback={<span>✓ Nice work — your first backup is in.</span>} />
      ) : null}

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
                    <span className="attention-entry-text">
                      {folderNameById.get(c.folderId) ?? c.folderId}
                    </span>
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
                      <OperationSentenceView
                        op={op}
                        ctx={{
                          folderName: op.folderId ? folderNameById.get(op.folderId) : undefined,
                          hostName: hostNameById.get(op.hostId),
                          backendName: op.folderId ? folderBackendNameById.get(op.folderId) : undefined,
                        }}
                      />
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

      {data && data.hosts.length > 0 ? (
        <GettingStarted
          hosts={data.hosts}
          backends={data.backends}
          folders={data.folders}
          hasAssignments={data.hasAssignments}
          hasOperations={data.operations.length > 0}
        />
      ) : null}

      {demo?.hasDemo ? (
        <section className="section demo-banner">
          <div className="toolbar">
            <h2>Demo data is active</h2>
            <button
              type="button"
              className="action danger"
              disabled={demoBusy}
              onClick={() => setConfirmDeleteDemo(true)}
            >
              {demoBusy ? "Working…" : "Delete demo data"}
            </button>
          </div>
          <p className="muted">
            You're exploring a demo fleet — 3 fake devices, a timeline, and a
            browsable snapshot. Nothing here touches a real backend. Delete it
            any time to start fresh.
          </p>
        </section>
      ) : null}

      {confirmDeleteDemo ? (
        <ConfirmDialog
          title="Delete demo data?"
          message="This permanently removes the demo devices, folders, timeline, and snapshot. Your real data is not affected."
          confirmLabel="Delete demo data"
          danger
          onConfirm={() => void onDeleteDemo()}
          onCancel={() => setConfirmDeleteDemo(false)}
        />
      ) : null}

      <section className="section">
        <h2>Fleet</h2>
        {!data ? (
          <div className="fleet-grid" aria-busy="true">
            <div className="skel skel-card" />
            <div className="skel skel-card" />
            <div className="skel skel-card" />
            <div className="skel skel-card" />
          </div>
        ) : data.hosts.length === 0 ? (
          <>
            <EmptyState
              variant="devices"
              glyph="llama"
              title="Pair your first device"
              how="Register a machine with this server and start syncing folders between your devices."
              ctaLabel="Pair your first device"
              ctaTo="/hosts"
              steps={[
                "Run the installer on the new machine",
                "Point it at this server with your API key",
                "It appears here within a minute",
              ]}
              timeNote="takes 30s"
            />
            {!demo?.hasDemo ? (
              <div className="demo-secondary">
                <span className="muted">Or explore without setting anything up:</span>
                <button
                  type="button"
                  className="action"
                  disabled={demoBusy}
                  onClick={() => void onSeedDemo()}
                >
                  {demoBusy ? "Seeding…" : "Explore a demo fleet"}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="fleet-grid">
            {data.hosts.map((h) => (
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
            ))}
          </div>
        )}
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
          <div className="empty-row">
            {storageError ? (
              <span className="error">
                Storage report unavailable — {storageError}
              </span>
            ) : (
              <div className="skel skel-line" aria-busy="true" />
            )}
          </div>
        ) : (
          <>
            {storageError && (
              <div className="error">Storage refresh failed — {storageError}</div>
            )}
            {storage.backends.some((b) => b.bytes > 0) ? (
              <div className="storage-overview">
                <Donut
                  data={storage.backends
                    .filter((b) => b.bytes > 0)
                    .map((b) => ({ label: b.label, value: b.bytes }))}
                  size={120}
                  thickness={16}
                  centerLabel={formatBytes(storage.totalBytes)}
                  centerSublabel="total"
                  ariaLabel="Storage by source"
                />
              </div>
            ) : null}
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
                <td className="num mono">
                  <strong>{formatBytes(storage.totalBytes)}</strong>
                </td>
                <td />
                <td />
              </tr>
            </tbody>
          </table>
          </>
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
                  <td className="muted">
                    <OperationSentenceView
                      op={op}
                      ctx={{
                        folderName: op.folderId ? folderNameById.get(op.folderId) : undefined,
                        hostName: hostNameById.get(op.hostId),
                        backendName: op.folderId ? folderBackendNameById.get(op.folderId) : undefined,
                      }}
                    />
                  </td>
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
