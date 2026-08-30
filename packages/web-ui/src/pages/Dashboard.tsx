import { useEffect, useMemo, useState } from "react";
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
import { InlineError } from "../components/InlineError.tsx";
import { useWebSocket } from "../hooks/useWebSocket.ts";
import { usePause } from "../hooks/usePause.ts";
import { PauseBanner } from "../components/PauseBanner.tsx";
import { PauseControl } from "../components/PauseControl.tsx";
import { formatTimeAgo } from "../relative-time.ts";
import { showVerifiedBadge } from "../backup-health.ts";
import { OperationSentenceView } from "../components/OperationSentence.tsx";
import { Donut } from "../components/Donut.tsx";
import { Confetti, useMilestoneConfetti } from "../components/Confetti.tsx";
import {
  IconFolderFilled,
  IconHost,
  IconLlamaFilled,
  IconShieldFilled,
  IconStorageFilled,
  IconSyncFilled,
} from "../components/icons.tsx";

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

function greetingForHour(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function activityLabel(op: OperationLog): string {
  if (op.operation === "dotfile") return "App settings backed up";
  if (op.operation === "backup") return "Backup completed";
  if (op.operation === "sync") return "Folder synced";
  if (op.operation === "restore") return "Recovery started";
  return op.operation.replaceAll("_", " ");
}

function activityTone(status: OperationLog["status"]): "success" | "warning" | "critical" | "info" {
  if (status === "success") return "success";
  if (status === "failed") return "critical";
  if (status === "conflict" || status === "deferred" || status === "retry") return "warning";
  return "info";
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // P-A: a failed storage-destination list no longer collapses into a silent
  // "not verified yet" caption — an inline error with retry replaces it.
  const [backendsError, setBackendsError] = useState<string | null>(null);
  // P-A: bump to re-run the whole dashboard fetch from the retry button.
  const [reloadKey, setReloadKey] = useState(0);
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
  const [dashboardTab, setDashboardTab] = useState<"overview" | "sync" | "protection" | "activity">("overview");
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
    setError(null);
    setBackendsError(null);
    Promise.all([
      api.health(),
      api.listFolders(),
      api.listConflicts("pending"),
      api.listShares(),
      api.listResticSnapshots(),
      api.listOperations({ limit: 100 }),
    ])
      .then(
        async ([
          health,
          folders,
          pendingConflicts,
          shares,
          snapshots,
          operations,
        ]) => {
          if (cancelled) return;
          // The destination list is best-effort — a failure must not blank
          // the whole dashboard, but it must surface as an inline caption.
          let backends: Backend[] = [];
          try {
            backends = await api.listBackends();
          } catch (err: unknown) {
            setBackendsError(
              `Couldn't load storage destinations — ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
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
  }, [reloadKey]);

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
  const attentionCount = failed.length + counts.conflicts + offline.length + updates.length;
  const heroTitle =
    data === null
      ? "Checking in with your fleet…"
      : data.hosts.length === 0
        ? "A quiet home for your files."
        : allQuiet
          ? "Your files are in good hands."
          : "Your files need a hand.";
  const heroDescription =
    data === null
      ? "Gathering the latest device, folder, and protection signals."
      : data.hosts.length === 0
        ? "Pair a device to start keeping your files in step and recoverable."
        : allQuiet
          ? "Everything important is moving along. Here’s the latest from your sync fleet."
          : `${attentionCount} ${attentionCount === 1 ? "item needs" : "items need"} a closer look. Start with the next useful action below.`;
  const dashboardHeadline = data?.hosts.length ? "Your sync fleet, at a glance." : "A quiet home for your files.";

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

  const tabs: Array<{ id: typeof dashboardTab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "sync", label: "Sync" },
    { id: "protection", label: "Protection" },
    { id: "activity", label: "Activity" },
  ];

  return (
    <div className="page dashboard-page">
      <header className="dashboard-header">
        <div>
          <p className="dashboard-eyebrow">
            {greetingForHour(new Date().getHours())}, friend <span aria-hidden="true">✦</span>
          </p>
          <h1>{dashboardHeadline}</h1>
          <p className="dashboard-lede">{heroDescription}</p>
        </div>
        <div className="dashboard-head-right">
          <nav className="dashboard-tabs" role="tablist" aria-label="Dashboard views">
            {tabs.map((tab) => (
              <button
                type="button"
                key={tab.id}
                className={dashboardTab === tab.id ? "is-active" : undefined}
                aria-selected={dashboardTab === tab.id}
                role="tab"
                onClick={() => setDashboardTab(tab.id)}
              >
                {tab.label}
                {tab.id === "activity" && data?.operations.length ? (
                  <span className="tab-count">{data.operations.length}</span>
                ) : null}
              </button>
            ))}
          </nav>
          <div className="dashboard-header-tools">
          <span className={`ws-pill ws-${wsState}`} title="WebSocket connection status">
            <span className="ws-dot" aria-hidden="true" /> {wsState}
          </span>
          <PauseControl
            scope="global"
            active={Boolean(overview?.global)}
            onChanged={() => void refreshPause()}
          />
          {backupVerified !== null ? (
            <span className="dashboard-verified" title="A storage destination was proven within the last 30 days">
              <span aria-hidden="true">✓</span> Verified {formatTimeAgo(backupVerified)} ago
            </span>
          ) : (
            <span className="dashboard-unverified" title="Run 'Prove it' on a restic destination">
              Backups not verified yet
            </span>
          )}
          </div>
        </div>
      </header>

      {overview?.global ? (
        <PauseBanner state={overview.global} scope="global" onResumed={() => void refreshPause()} />
      ) : null}
      {error ? <div className="error">{error}</div> : null}
      {backendsError ? <InlineError message={backendsError} onRetry={() => setReloadKey((k) => k + 1)} /> : null}
      {showFirstBackup ? <Confetti fallback={<span>✓ Nice work — your first backup is in.</span>} /> : null}

      {dashboardTab === "overview" ? (
        <section className={`dashboard-hero ${data && allQuiet ? "hero-healthy" : "hero-attention"}`} aria-labelledby="fleet-verdict">
          <div className="hero-copy">
            <div className="hero-kicker">
              <span className="hero-status-mark" aria-hidden="true">{data && allQuiet ? "✓" : data ? "!" : "…"}</span>
              Fleet verdict
            </div>
            <h2 id="fleet-verdict">{heroTitle}</h2>
            <p>{heroDescription}</p>
            <div className="hero-actions">
              {data && !allQuiet ? (
                <button type="button" className="action primary" onClick={() => document.getElementById("needs-a-hand")?.scrollIntoView({ behavior: "smooth" })}>
                  Review what needs a hand
                </button>
              ) : data && data.hosts.length === 0 ? (
                <Link className="action primary" to="/hosts">Pair a device</Link>
              ) : (
                <button type="button" className="action primary" onClick={() => setDashboardTab("activity")}>View recent activity</button>
              )}
              <Link className="hero-secondary-action" to="/folders">Manage synced folders <span aria-hidden="true">→</span></Link>
            </div>
          </div>
          <div className="hero-llama" aria-hidden="true"><IconLlamaFilled /></div>
          <div className="hero-summary" aria-label="Current attention summary">
            <div className="hero-attention-heading">{attentionCount ? "Worth a look" : "A calm moment"}</div>
            <div className="hero-attention-list">
              <HeroSignal label="Failed operations" value={failed.length} tone={failed.length ? "critical" : "quiet"} />
              <HeroSignal label="Pending conflicts" value={counts.conflicts} tone={counts.conflicts ? "warning" : "quiet"} />
              <HeroSignal label="Offline devices" value={offline.length} tone={offline.length ? "warning" : "quiet"} />
              <HeroSignal label="Updates available" value={updates.length} tone={updates.length ? "info" : "quiet"} />
            </div>
          </div>
        </section>
      ) : null}

      {dashboardTab !== "activity" ? (
        <div className="dashboard-signals" aria-label="Fleet signals">
          <SignalTile icon={<IconHost />} label="Devices" value={data ? `${counts.online}/${counts.total}` : "—"} detail="online now" to="/hosts" tone="moss" />
          <SignalTile icon={<IconFolderFilled />} label="Synced folders" value={counts.folders} detail="kept in step" to="/folders" tone="clay" />
          <SignalTile icon={<IconShieldFilled />} label="Protection" value={backupVerified !== null ? "Verified" : data?.backends.length ? "Not yet" : "Set up"} detail={backupVerified !== null ? `checked ${formatTimeAgo(backupVerified)} ago` : "recovery copies"} to="/backends" tone="moss" />
          <SignalTile icon={<IconStorageFilled />} label="Storage" value={storage ? formatBytes(storage.totalBytes) : "—"} detail={storage ? "in use" : "measuring"} to="/backends" tone="teal" />
        </div>
      ) : null}

      {dashboardTab === "overview" && data ? (
        <GettingStarted hosts={data.hosts} backends={data.backends} folders={data.folders} hasAssignments={data.hasAssignments} hasOperations={data.operations.length > 0} />
      ) : null}

      {demo?.hasDemo && dashboardTab === "overview" ? (
        <section className="section demo-banner">
          <div className="toolbar"><h2>Demo fleet active</h2><button type="button" className="action danger" disabled={demoBusy} onClick={() => setConfirmDeleteDemo(true)}>{demoBusy ? "Working…" : "Delete demo data"}</button></div>
          <p className="muted">You’re exploring three fictional devices and a sample timeline. Nothing here touches a real storage destination.</p>
        </section>
      ) : null}

      {confirmDeleteDemo ? (
        <ConfirmDialog title="Delete demo data?" message="This permanently removes the demo devices, folders, timeline, and snapshot. Your real data is not affected." confirmLabel="Delete demo data" danger onConfirm={() => void onDeleteDemo()} onCancel={() => setConfirmDeleteDemo(false)} />
      ) : null}

      {dashboardTab === "overview" || dashboardTab === "sync" ? (
        <div className="dashboard-workspace">
          <section className="dashboard-panel needs-hand" id="needs-a-hand" aria-labelledby="needs-heading">
            <PanelHeading title="Needs a hand" subtitle={newTotal > 0 ? `${newTotal} new since your last visit` : "Short, actionable signals from the fleet"} />
            {!data ? <div className="skel skel-lines" aria-busy="true" /> : allQuiet ? (
              <div className="quiet-state"><span className="quiet-mark" aria-hidden="true">✓</span><div><strong>All quiet here.</strong><span>Your fleet is healthy and up to date.</span></div></div>
            ) : (
              <div className="needs-list">
                {failed.length ? <NeedsRow tone="critical" label={`${failed.length} failed operation${failed.length === 1 ? "" : "s"}`} detail="Review the latest backup or sync result." to="/operations" /> : null}
                {counts.conflicts ? <NeedsRow tone="warning" label={`${counts.conflicts} pending conflict${counts.conflicts === 1 ? "" : "s"}`} detail={data.pendingConflicts.slice(0, 2).map((c) => folderNameById.get(c.folderId) ?? c.folderId).join(" · ")} to="/conflicts" /> : null}
                {offline.length ? <NeedsRow tone="warning" label={`${offline.length} device${offline.length === 1 ? "" : "s"} offline or degraded`} detail={offline.map((h) => h.hostname).join(" · ")} to="/hosts" /> : null}
                {updates.length ? <NeedsRow tone="info" label={`${updates.length} update${updates.length === 1 ? "" : "s"} available`} detail={updates.map((h) => h.hostname).join(" · ")} to="/hosts" /> : null}
              </div>
            )}
          </section>

          <section className="dashboard-panel fleet-roster" aria-labelledby="fleet-heading">
            <PanelHeading title="Fleet" subtitle="Devices keeping your files in step" action={<Link to="/hosts">View devices <span aria-hidden="true">→</span></Link>} />
            {!data ? <div className="skel skel-lines" aria-busy="true" /> : data.hosts.length === 0 ? (
              <div className="empty-fleet"><IconLlamaFilled aria-hidden="true" /><strong>Your fleet starts with one device.</strong><Link className="action" to="/hosts">Pair a device</Link>{!demo?.hasDemo ? <button type="button" className="text-action" disabled={demoBusy} onClick={() => void onSeedDemo()}>{demoBusy ? "Seeding…" : "Explore a demo fleet"}</button> : null}</div>
            ) : (
              <div className="fleet-roster-list">
                {data.hosts.slice(0, 5).map((h) => <Link className="fleet-roster-row" key={h.id} to={`/hosts/${encodeURIComponent(h.id)}`}>
                  <span className={`roster-device roster-device--${h.status}`} aria-hidden="true"><IconHost /></span>
                  <span className="roster-name"><strong>{h.hostname}</strong><span>{h.lastSeen ? `Last seen ${formatTimeAgo(h.lastSeen)}` : "Waiting for first check-in"}</span></span>
                  <span className={`roster-status roster-status--${h.status}`}><span aria-hidden="true">●</span>{h.status}</span>
                  <span className="roster-version">v{h.version ?? "—"}{h.updateAvailable ? <em>update</em> : null}</span>
                </Link>)}
              </div>
            )}
          </section>
        </div>
      ) : null}

      {dashboardTab === "sync" ? (
        <section className="dashboard-panel dashboard-context-panel">
          <PanelHeading title="Sync in plain language" subtitle="The folders and devices currently sharing work." />
          <div className="context-cards"><ContextCard icon={<IconSyncFilled />} title="Synced folders" body="Keep a working folder identical across the Devices that share it." to="/folders" /><ContextCard icon={<IconFolderFilled />} title="Conflicts" body={counts.conflicts ? "A choice is waiting where two Devices changed the same file." : "No folder choices are waiting right now."} to="/conflicts" /></div>
        </section>
      ) : null}

      {dashboardTab === "protection" ? (
        <section className="dashboard-panel protection-panel" aria-labelledby="protection-heading">
          <PanelHeading title="Protection" subtitle="Recovery copies are separate from a successful sync." action={<Link to="/backends">Manage destinations <span aria-hidden="true">→</span></Link>} />
          <div className="protection-summary"><div className={`protection-status ${backupVerified !== null ? "is-verified" : ""}`}><IconShieldFilled aria-hidden="true" /><div><strong>{backupVerified !== null ? "A destination was recently verified" : "Backups have not been verified yet"}</strong><span>{backupVerified !== null ? `Last checked ${formatTimeAgo(backupVerified)} ago. Completed and verified are tracked separately.` : "Run Prove it from a restic destination to confirm a recovery copy can be read."}</span></div></div><Link className="action primary" to="/backends">Open protection</Link></div>
          <StorageSection storage={storage} storageBusy={storageBusy} storageError={storageError} onRefresh={() => void onRefreshStorage()} />
        </section>
      ) : null}

      {dashboardTab === "overview" ? <ActivityLedger operations={data?.operations ?? []} folderNameById={folderNameById} hostNameById={hostNameById} folderBackendNameById={folderBackendNameById} lastVisit={lastVisit} onViewAll={() => setDashboardTab("activity")} /> : null}
      {dashboardTab === "activity" ? <ActivityLedger operations={data?.operations ?? []} folderNameById={folderNameById} hostNameById={hostNameById} folderBackendNameById={folderBackendNameById} lastVisit={lastVisit} /> : null}

      {dashboardTab === "overview" ? <section className="dashboard-footer-actions"><Link to="/folders">Manage synced folders <span aria-hidden="true">→</span></Link><Link to="/conflicts">Resolve conflicts <span aria-hidden="true">→</span></Link></section> : null}
    </div>
  );
}

interface SignalTileProps {
  icon: ReactNode;
  label: string;
  value: number | string;
  detail: string;
  to: string;
  tone: "moss" | "clay" | "teal";
}

function SignalTile({ icon, label, value, detail, to, tone }: SignalTileProps) {
  return (
    <Link className={`signal-tile signal-tile--${tone}`} to={to}>
      <span className="signal-icon" aria-hidden="true">{icon}</span>
      <span className="signal-copy"><span className="signal-label">{label}</span><strong>{value}</strong><span>{detail}</span></span>
      <span className="signal-arrow" aria-hidden="true">↗</span>
    </Link>
  );
}

function HeroSignal({ label, value, tone }: { label: string; value: number; tone: "critical" | "warning" | "info" | "quiet" }) {
  return <div className={`hero-signal hero-signal--${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function PanelHeading({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return <div className="panel-heading"><div><h2>{title}</h2><p>{subtitle}</p></div>{action ? <span className="panel-heading-action">{action}</span> : null}</div>;
}

function NeedsRow({ tone, label, detail, to }: { tone: "critical" | "warning" | "info"; label: string; detail: string; to: string }) {
  return <Link className={`needs-row needs-row--${tone}`} to={to}><span className="needs-row-mark" aria-hidden="true">{tone === "critical" ? "×" : tone === "warning" ? "!" : "↗"}</span><span><strong>{label}</strong><small>{detail}</small></span><span className="needs-row-arrow" aria-hidden="true">→</span></Link>;
}

function ContextCard({ icon, title, body, to }: { icon: ReactNode; title: string; body: string; to: string }) {
  return <Link className="context-card" to={to}><span className="context-card-icon" aria-hidden="true">{icon}</span><span><strong>{title}</strong><small>{body}</small></span><span aria-hidden="true">→</span></Link>;
}

interface StorageSectionProps {
  storage: StorageReport | null;
  storageBusy: boolean;
  storageError: string | null;
  onRefresh: () => void;
}

function StorageSection({ storage, storageBusy, storageError, onRefresh }: StorageSectionProps) {
  return (
    <div className="protection-storage">
      <div className="protection-storage-toolbar"><div><strong>Storage destinations</strong><span>Where recovery copies and working data live.</span></div><button type="button" className="action" disabled={storageBusy} onClick={onRefresh}>{storageBusy ? "Measuring…" : "Refresh"}</button></div>
      {!storage ? (
        storageError ? <InlineError message={`Storage report unavailable — ${storageError}`} onRetry={onRefresh} /> : <div className="skel skel-line" aria-busy="true" />
      ) : (
        <>
          {storageError ? <InlineError message={`Storage refresh failed — ${storageError}`} onRetry={onRefresh} /> : null}
          {storage.backends.some((entry) => entry.bytes > 0) ? <div className="storage-overview"><Donut data={storage.backends.filter((entry) => entry.bytes > 0).map((entry) => ({ label: entry.label, value: entry.bytes }))} size={120} thickness={16} centerLabel={formatBytes(storage.totalBytes)} centerSublabel="total" ariaLabel="Storage by source" /></div> : null}
          <table className="data protection-table"><thead><tr><th>Destination</th><th>Kind</th><th>Size</th><th>Status</th></tr></thead><tbody>{storage.backends.map((entry) => <tr key={entry.backendId ?? entry.label}><td>{entry.label}</td><td><span className={`badge badge-${entry.kind}`}>{entry.kind}</span></td><td className="mono">{formatBytes(entry.bytes)}</td><td>{entry.error ? <span className="badge badge-failed" title={entry.error}>error</span> : <span className="badge badge-success">ready</span>}</td></tr>)}<tr><td><strong>Total</strong></td><td /><td className="mono"><strong>{formatBytes(storage.totalBytes)}</strong></td><td /></tr></tbody></table>
        </>
      )}
    </div>
  );
}

interface ActivityLedgerProps {
  operations: OperationLog[];
  folderNameById: Map<string, string>;
  hostNameById: Map<string, string>;
  folderBackendNameById: Map<string, string>;
  lastVisit: number | null;
  onViewAll?: () => void;
}

function ActivityLedger({ operations, folderNameById, hostNameById, folderBackendNameById, lastVisit, onViewAll }: ActivityLedgerProps) {
  return (
    <section className="dashboard-panel activity-ledger" aria-labelledby="activity-heading">
      <PanelHeading title="Recent activity" subtitle="A small, honest record of what changed." action={onViewAll ? <button type="button" className="text-action" onClick={onViewAll}>View all activity <span aria-hidden="true">→</span></button> : undefined} />
      {!operations.length ? <div className="ledger-empty"><IconSyncFilled aria-hidden="true" /><span>No activity recorded yet. Your first useful change will appear here.</span></div> : <ol className="activity-list">{operations.slice(0, 8).map((op) => { const tone = activityTone(op.status); return <li className={`activity-row activity-row--${tone}`} key={String(op.id)}><span className="activity-dot" aria-hidden="true">{tone === "success" ? "✓" : tone === "critical" ? "×" : tone === "warning" ? "!" : "·"}</span><time dateTime={new Date(op.timestamp).toISOString()}><strong>{formatTimeAgo(op.timestamp)}</strong><small>{formatTimestamp(op.timestamp)}</small></time><span className="activity-content"><strong>{activityLabel(op)}</strong><small><OperationSentenceView op={op} ctx={{ folderName: op.folderId ? folderNameById.get(op.folderId) : undefined, hostName: hostNameById.get(op.hostId), backendName: op.folderId ? folderBackendNameById.get(op.folderId) : undefined }} /></small></span><span className="activity-status">{op.status}{isNewSince(op.timestamp, lastVisit) ? <em>new</em> : null}</span></li>; })}</ol>}
    </section>
  );
}
