import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  DotfileManifest,
  FolderAssignment,
  Host,
  HostConfig,
  OperationLog,
  QueuedAction,
  QueuedActionType,
} from "@lamasync/core";
import { api } from "../api.ts";

interface DetailData {
  host: Host;
  config: HostConfig;
  manifests: DotfileManifest[];
  operations: OperationLog[];
  actions: QueuedAction[];
}

type ActionKind = "trigger_sync" | "trigger_backup" | "check_update" | "refresh_config";

const ACTION_BUTTONS: { type: ActionKind; label: string; hotkey: string }[] = [
  { type: "trigger_sync", label: "Trigger sync", hotkey: "S" },
  { type: "trigger_backup", label: "Trigger backup", hotkey: "B" },
  { type: "check_update", label: "Check update", hotkey: "U" },
  { type: "refresh_config", label: "Refresh config", hotkey: "R" },
];

function formatTimestamp(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

function actionStatusBadgeClass(status: QueuedAction["status"]): string {
  switch (status) {
    case "done":
      return "badge-success";
    case "failed":
      return "badge-failed";
    case "taken":
      return "badge-started";
    case "pending":
      return "badge-unknown";
  }
}

export function HostDetail() {
  const params = useParams<{ hostId: string }>();
  const hostId = params.hostId ?? "";

  const [data, setData] = useState<DetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<QueuedActionType | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!hostId) return;
    try {
      const [host, config, manifests, operations, actions] = await Promise.all([
        api.getHost(hostId),
        api.getConfig(hostId),
        api.listManifests(hostId),
        api.listOperationsForHost(hostId, 20),
        api.listHostActions(hostId),
      ]);
      setData({ host, config, manifests, operations, actions });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [hostId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const assignments = data?.config.assignments ?? [];
  const folders = data?.config.folders ?? [];

  const assignmentRows = useMemo(() => {
    const folderById = new Map(folders.map((f) => [f.id, f]));
    return assignments.map((a) => ({
      assignment: a,
      folder: folderById.get(a.folderId) ?? null,
    }));
  }, [assignments, folders]);

  async function onAction(type: ActionKind): Promise<void> {
    setBusy(type);
    setError(null);
    try {
      await api.enqueueAction(hostId, { type, payload: null });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (!hostId) {
    return (
      <div className="page">
        <div className="error">Missing host id</div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="page">
        <div className="toolbar">
          <h1>Host</h1>
          <Link className="action" to="/hosts">← Back to hosts</Link>
        </div>
        <div className="error">{error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page">
        <div className="toolbar">
          <h1>Host</h1>
          <span className="muted">loading…</span>
        </div>
      </div>
    );
  }

  const { host, config, manifests, operations, actions } = data;

  return (
    <div className="page">
      <div className="toolbar">
        <h1>{host.hostname}</h1>
        <Link className="action" to="/hosts">← All hosts</Link>
      </div>
      {error && <div className="error">{error}</div>}

      <section className="section host-detail-identity">
        <h2>Identity</h2>
        <dl className="host-detail-dl">
          <dt>Status</dt>
          <dd><span className={`badge badge-${host.status}`}>{host.status}</span></dd>
          <dt>Hostname</dt>
          <dd>{host.hostname}</dd>
          <dt>Host ID</dt>
          <dd><code>{host.id}</code></dd>
          <dt>Last seen</dt>
          <dd>{formatTimestamp(host.lastSeen)}</dd>
          {host.tailnetIp ? (
            <>
              <dt>Tailnet IP</dt>
              <dd><code>{host.tailnetIp}</code></dd>
            </>
          ) : null}
          {host.lanIp ? (
            <>
              <dt>LAN IP</dt>
              <dd><code>{host.lanIp}</code></dd>
            </>
          ) : null}
          <dt>Daemon version</dt>
          <dd>
            v{host.version ?? "—"}
            {host.updateAvailable ? (
              <span className="badge badge-update">update available</span>
            ) : null}
          </dd>
          <dt>Config revision</dt>
          <dd><code>{host.configRevision ?? 0}</code> (cached: <code>{config.host.configRevision ?? 0}</code>)</dd>
        </dl>
      </section>

      <section className="section">
        <h2>Actions</h2>
        <div className="host-detail-actions">
          {ACTION_BUTTONS.map((b) => (
            <button
              key={b.type}
              type="button"
              className="action primary"
              disabled={busy !== null}
              onClick={() => void onAction(b.type)}
            >
              {busy === b.type ? "…" : b.label} <span className="hotkey">[{b.hotkey}]</span>
            </button>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>Assigned folders ({assignments.length})</h2>
        {assignmentRows.length === 0 ? (
          <div className="empty-row">No folder assignments</div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Folder</th>
                <th>Type</th>
                <th>Local path</th>
                <th>Schedule</th>
                <th>Role</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {assignmentRows.map(({ assignment, folder }) => (
                <tr key={assignment.id}>
                  <td>{folder ? folder.name : assignment.folderId}</td>
                  <td>
                    <span className="badge badge-unknown">
                      {folder?.type ?? "—"}
                    </span>
                  </td>
                  <td className="muted"><code>{assignment.localPath}</code></td>
                  <td className="muted">{assignment.syncExpr ?? "—"}</td>
                  <td className="muted">{assignment.role}</td>
                  <td>
                    <span className={`badge badge-${assignment.enabled ? "online" : "offline"}`}>
                      {assignment.enabled ? "enabled" : "disabled"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2>Dotfile manifests ({manifests.length})</h2>
        {manifests.length === 0 ? (
          <div className="empty-row">No dotfile manifests</div>
        ) : (
          <ul className="assignment-list">
            {manifests.map((m) => (
              <li key={m.id}>
                <strong>{m.appName}</strong>
                <span>{m.paths.join(", ")}</span>
                {m.schedule ? <span className="muted">cron: {m.schedule}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section">
        <h2>Last operations</h2>
        {operations.length === 0 ? (
          <div className="empty-row">No operations recorded</div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Time</th>
                <th>Operation</th>
                <th>Status</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {operations.map((op) => (
                <tr key={String(op.id)}>
                  <td>{formatTimestamp(op.timestamp)}</td>
                  <td>{op.operation}</td>
                  <td>
                    <span className={`badge badge-${op.status}`}>{op.status}</span>
                  </td>
                  <td className="muted">{op.summary ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2>Action history ({actions.length})</h2>
        {actions.length === 0 ? (
          <div className="empty-row">No actions queued yet</div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Type</th>
                <th>Status</th>
                <th>Created</th>
                <th>Taken</th>
                <th>Completed</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {actions.map((a) => (
                <tr key={a.id}>
                  <td>{a.type}</td>
                  <td>
                    <span className={`badge ${actionStatusBadgeClass(a.status)}`}>
                      {a.status}
                    </span>
                  </td>
                  <td className="muted">{formatTimestamp(a.createdAt)}</td>
                  <td className="muted">{formatTimestamp(a.takenAt)}</td>
                  <td className="muted">{formatTimestamp(a.completedAt)}</td>
                  <td className="muted">{a.result ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2>Generated rclone config</h2>
        <details className="host-detail-config">
          <summary>Show full rclone.conf ({config.rcloneConfig.length} chars)</summary>
          <pre className="rclone-config">{config.rcloneConfig}</pre>
        </details>
      </section>
    </div>
  );
}