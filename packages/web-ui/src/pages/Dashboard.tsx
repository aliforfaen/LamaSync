import { useEffect, useMemo, useState } from "react";
import type {
  Conflict,
  Folder,
  Host,
  OperationLog,
  ResticSnapshot,
  Share,
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
      const c = event.conflict;
      const others = prev.pendingConflicts.filter((x) => x.id !== c.id);
      const next =
        c.status === "pending" ? [c, ...others] : others.filter((x) => x.status === "pending");
      return { ...prev, pendingConflicts: next };
    }
    case "restic_snapshot": {
      const exists = prev.snapshots.some((s) => s.id === event.snapshot.id);
      if (exists) return prev;
      return { ...prev, snapshots: [event.snapshot, ...prev.snapshots] };
    }
    case "restic_restore":
    case "mount":
    case "lock":
    default:
      return prev;
  }
}

function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString();
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { state: wsState, event } = useWebSocket();

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.health(),
      api.listFolders(),
      api.listConflicts("pending"),
      api.listShares(),
      api.listResticSnapshots(),
      api.listOperations(20),
    ])
      .then(([health, folders, pendingConflicts, shares, snapshots, operations]) => {
        if (cancelled) return;
        setData({
          hosts: health.hosts ?? [],
          folders,
          pendingConflicts,
          shares,
          snapshots,
          operations,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!event) return;
    setData((prev) => (prev ? mergeEvent(prev, event) : prev));
  }, [event]);

  const counts = useMemo(() => {
    if (!data) {
      return {
        totalHosts: 0,
        onlineHosts: 0,
        offlineHosts: 0,
        folders: 0,
        pendingConflicts: 0,
        shares: 0,
        snapshots: 0,
      };
    }
    const online = data.hosts.filter((h) => h.status === "online").length;
    const offline = data.hosts.filter(
      (h) => h.status === "offline" || h.status === "degraded",
    ).length;
    return {
      totalHosts: data.hosts.length,
      onlineHosts: online,
      offlineHosts: offline,
      folders: data.folders.length,
      pendingConflicts: data.pendingConflicts.length,
      shares: data.shares.length,
      snapshots: data.snapshots.length,
    };
  }, [data]);

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Dashboard</h1>
        <span className="muted">WS: {wsState}</span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="summary-grid">
        <SummaryCard label="Hosts" value={counts.totalHosts} />
        <SummaryCard label="Online" value={counts.onlineHosts} accent="online" />
        <SummaryCard label="Offline / Degraded" value={counts.offlineHosts} accent="offline" />
        <SummaryCard label="Folders" value={counts.folders} />
        <SummaryCard label="Pending Conflicts" value={counts.pendingConflicts} accent="conflict" />
        <SummaryCard label="Network Shares" value={counts.shares} />
        <SummaryCard label="Restic Snapshots" value={counts.snapshots} />
      </div>

      <section className="section">
        <h2>Hosts</h2>
        <table className="data">
          <thead>
            <tr>
              <th>Hostname</th>
              <th>Status</th>
              <th>Last seen</th>
              <th>Tailnet IP</th>
              <th>LAN IP</th>
            </tr>
          </thead>
          <tbody>
            {!data || data.hosts.length === 0 ? (
              <tr className="empty-row">
                <td colSpan={5}>No hosts registered yet</td>
              </tr>
            ) : (
              data.hosts.map((h) => (
                <tr key={h.id}>
                  <td>{h.hostname}</td>
                  <td>
                    <span className={`badge badge-${h.status}`}>{h.status}</span>
                  </td>
                  <td>{formatTimestamp(h.lastSeen)}</td>
                  <td className="muted">{h.tailnetIp ?? "—"}</td>
                  <td className="muted">{h.lanIp ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className="section">
        <h2>Recent operations</h2>
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
            {!data || data.operations.length === 0 ? (
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
                  </td>
                  <td className="muted">{op.summary ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

interface SummaryCardProps {
  label: string;
  value: number;
  accent?: "online" | "offline" | "conflict";
}

function SummaryCard({ label, value, accent }: SummaryCardProps) {
  const cls = accent ? `value badge-${accent}` : "value";
  return (
    <div className="summary-card">
      <span className="label">{label}</span>
      <span className={cls}>{value}</span>
    </div>
  );
}
