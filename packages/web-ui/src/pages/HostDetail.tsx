import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type {
  DotfileManifest,
  FolderAssignment,
  Host,
  HostConfig,
  OperationLog,
  QueuedAction,
  QueuedActionType,
} from "@lamasync/core";
import { effectiveFolderType } from "@lamasync/core/effective-type";
import { api, errorText } from "../api.ts";
import {
  daemonUpdateUiState,
  latestRemoteUpdateAction,
  remoteUpdateFollowUp,
} from "../daemon-update.ts";
import { HostClassIcon } from "../components/icons.tsx";
import { AssignmentEditor } from "../components/AssignmentEditor.tsx";
import { EditableHostname } from "../components/EditableHostname.tsx";
import { DryRunDrawer, type DryRunState } from "../components/DryRunDrawer.tsx";
import { findDryRunOperation, parseDryRunDetails } from "../dry-run.ts";
import { Hint } from "../components/Hint.tsx";
import { MISC_HINTS } from "../concepts.ts";
import { useWebSocket } from "../hooks/useWebSocket.ts";
import { usePause } from "../hooks/usePause.ts";
import { PauseBanner } from "../components/PauseBanner.tsx";
import { PauseControl } from "../components/PauseControl.tsx";
import { ConfirmDialog } from "../components/Modal.tsx";
import { InlineError } from "../components/InlineError.tsx";

interface DetailData {
  host: Host;
  config: HostConfig;
  manifests: DotfileManifest[];
  operations: OperationLog[];
  actions: QueuedAction[];
}

type ActionKind = "trigger_sync" | "trigger_backup" | "check_update" | "refresh_config";

// LAMA-212: no keyboard handler exists for these, so no [S][B][U][R] hints.
const ACTION_BUTTONS: { type: ActionKind; label: string }[] = [
  { type: "trigger_sync", label: "Trigger sync" },
  { type: "trigger_backup", label: "Trigger backup" },
  { type: "check_update", label: "Check update" },
  { type: "refresh_config", label: "Refresh config" },
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
  const navigate = useNavigate();
  const hostId = params.hostId ?? "";

  const [data, setData] = useState<DetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<QueuedActionType | null>(null);
  // LAMA-198: per-assignment sync/dry-run enqueue in flight (assignmentId:mode).
  const [assignmentBusy, setAssignmentBusy] = useState<string | null>(null);
  // LAMA-257: "Preview next run" drawer state — the folder being previewed
  // and the dry-run result (or running/error).
  const [preview, setPreview] = useState<{ folderId: string } | null>(null);
  const [previewState, setPreviewState] = useState<DryRunState | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  // Assignment editing (pause/resume + full editor).
  const [editingAssignment, setEditingAssignment] = useState<FolderAssignment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // LAMA-225: transient banner when this host's label is renamed.
  const [renamedBanner, setRenamedBanner] = useState<string | null>(null);
  // LAMA-299: remote daemon update (Software section).
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const { event } = useWebSocket();
  // LAMA-273: per-device pause / slow mode. The effective pause for this
  // device is its own row when present, else the global fleet pause.
  const { overview, refresh: refreshPause, effectiveFor } = usePause();
  const activePause = effectiveFor(hostId);
  const hostPause = overview?.hosts.find((h) => h.hostId === hostId) ?? null;

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

  // LAMA-299: latest release for the Software section (independent probe;
  // failure just means the section shows "unknown" for the release).
  useEffect(() => {
    let cancelled = false;
    api
      .latestRelease()
      .then((r) => {
        if (!cancelled) setLatestVersion(r.version);
      })
      .catch(() => {
        if (!cancelled) setLatestVersion(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (event && event.kind === "host_renamed" && event.oldId === hostId) {
      setRenamedBanner(`device renamed: ${event.oldId} → ${event.hostname}`);
      void refresh();
    }
    // LAMA-299: action events for this host refresh the Software status.
    if (event && event.kind === "action" && event.action.hostId === hostId) {
      void refresh();
    }
  }, [event, hostId, refresh]);

  const assignments = data?.config.assignments ?? [];
  const folders = data?.config.folders ?? [];
  const folderById = useMemo(
    () => new Map(folders.map((f) => [f.id, f])),
    [folders],
  );

  const assignmentRows = useMemo(() => {
    return assignments.map((a) => ({
      assignment: a,
      folder: folderById.get(a.folderId) ?? null,
    }));
  }, [assignments, folderById]);

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

  // LAMA-198: per-folder sync and dry-run. Dry-run runs the same assignment
  // with `rclone --dry-run` (no file changes); the ack summary carries a
  // `dry-run: ` prefix so the Operations log shows what happened.
  async function onAssignmentSync(folderId: string, dryRun: boolean): Promise<void> {
    const key = `${folderId}:${dryRun ? "dry" : "sync"}`;
    setAssignmentBusy(key);
    setError(null);
    try {
      await api.enqueueAction(hostId, {
        type: "trigger_sync",
        payload: dryRun ? { folderId, dryRun: true } : { folderId },
      });
      setSyncNote(
        `${dryRun ? "Dry run" : "Sync"} of “${
          folderById.get(folderId)?.name ?? folderId
        }” queued — runs on the daemon within ~30 s`,
      );
      window.setTimeout(() => setSyncNote(null), 6000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAssignmentBusy(null);
    }
  }

  // LAMA-257: close the preview drawer (also bound to Escape below).
  function closePreview(): void {
    setPreview(null);
    setPreviewState(null);
  }

  // LAMA-299: queue a remote daemon update (admin-only action). Duplicate
  // clicks are prevented locally via `updateBusy` and server-side by the
  // in-flight capability check in the Software section.
  async function onUpdateDaemon(): Promise<void> {
    setConfirmUpdate(false);
    setUpdateBusy(true);
    setError(null);
    try {
      await api.enqueueAction(hostId, { type: "update_daemon" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdateBusy(false);
    }
  }

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closePreview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  // LAMA-257: enqueue a dry-run sync, poll the action to completion, then
  // read the tagged operation row (the daemon reports the would-change file
  // lists in its JSON `details`) and surface counts + capped file list.
  async function openDryRunPreview(folderId: string): Promise<void> {
    setPreview({ folderId });
    setPreviewState({ status: "running" });
    try {
      const created = await api.enqueueAction(hostId, {
        type: "trigger_sync",
        payload: { folderId, dryRun: true },
      });
      const deadline = Date.now() + 90_000;
      let action: QueuedAction | null = null;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const actions = await api.listHostActions(hostId);
        action = actions.find((a) => a.id === created.id) ?? null;
        if (action && (action.status === "done" || action.status === "failed")) break;
      }
      if (!action) {
        setPreviewState({
          status: "error",
          message: "The dry run timed out waiting for the device — is it online?",
        });
        return;
      }
      if (action.status === "failed") {
        setPreviewState({ status: "error", message: action.result ?? "Dry run failed on the device." });
        return;
      }
      const ops = await api.listOperationsForHost(hostId, 50);
      const dryOp = findDryRunOperation(ops, folderId);
      if (!dryOp) {
        setPreviewState({
          status: "error",
          message: `The dry run finished but reported no details (${action.result ?? "unknown"}).`,
        });
        return;
      }
      setPreviewState({ status: "done", details: parseDryRunDetails(dryOp.details) });
    } catch (err) {
      setPreviewState({ status: "error", message: errorText(err) });
    }
  }

  // LAMA-198: pause/resume an assignment (enabled flag round-trips through
  // PATCH /folders/:id/assign/:hostId).
  async function onToggleEnabled(assignment: FolderAssignment): Promise<void> {
    const key = `${assignment.folderId}:toggle`;
    setAssignmentBusy(key);
    setError(null);
    try {
      await api.updateAssignment(assignment.folderId, assignment.hostId, {
        enabled: !assignment.enabled,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAssignmentBusy(null);
    }
  }

  // LAMA-198: decommission. Cascade is server-side (DELETE /hosts/:hostId);
  // the daemon on that machine re-registers unless stopped/uninstalled.
  function onDeleteHost(): void {
    if (!data) return;
    setConfirmDelete(true);
  }

  async function runDeleteHost(): Promise<void> {
    if (!data) return;
    setConfirmDelete(false);
    setDeleting(true);
    setError(null);
    try {
      await api.deleteHost(hostId);
      navigate("/hosts");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  }

  if (!hostId) {
    return (
      <div className="page">
        <div className="error">Missing device id</div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="page">
        <div className="toolbar">
          <h1>Device</h1>
          <Link className="action" to="/hosts">← Back to devices</Link>
        </div>
        <InlineError message={error} onRetry={() => void refresh()} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page">
        <div className="toolbar">
          <h1>Device</h1>
          <span className="muted">loading…</span>
        </div>
      </div>
    );
  }

  const { host, config, manifests, operations, actions } = data;

  // LAMA-299: Software-section derived state. `inFlight` also prevents
  // duplicate pending requests; the follow-up line tracks the latest
  // update_daemon action through queued → claimed → installed → confirmed.
  const updateAction = useMemo(() => latestRemoteUpdateAction(actions), [actions]);
  const updateInFlight = updateAction?.status === "pending" || updateAction?.status === "taken";
  const updateState = useMemo(
    () => daemonUpdateUiState(host, latestVersion, updateInFlight),
    [host, latestVersion, updateInFlight],
  );
  const updateFollowUp = useMemo(
    () => remoteUpdateFollowUp(updateAction, host.version),
    [updateAction, host.version],
  );
  // Modest poll while an update action is in flight (WS is primary; this
  // is the fallback when the socket is down).
  useEffect(() => {
    if (!updateInFlight) return;
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [updateInFlight, refresh]);

  return (
    <div className="page">
      <div className="toolbar">
        <h1><HostClassIcon hostClass={host.hostClass} className="host-detail-icon" /> {host.hostname}</h1>
        <Link className="action" to="/hosts">← All devices</Link>
        <PauseControl
          scope="host"
          hostId={hostId}
          deviceName={host.hostname}
          active={activePause !== null && activePause !== undefined}
          onChanged={() => void refreshPause()}
        />
        <button
          type="button"
          className="action danger"
          disabled={deleting}
          onClick={() => onDeleteHost()}
        >
          {deleting ? "…" : "Delete device"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {syncNote && <div className="banner">{syncNote}</div>}
      {activePause ? (
        <PauseBanner
          state={activePause}
          scope={hostPause ? "host" : "global"}
          hostId={hostId}
          onResumed={() => void refreshPause()}
        />
      ) : null}
      {renamedBanner ? (
        <div className="banner">
          <span>{renamedBanner}</span>
          <button
            type="button"
            className="banner-close"
            aria-label="Dismiss"
            onClick={() => setRenamedBanner(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      <section className="section host-detail-identity">
        <h2>Identity</h2>
        <dl className="host-detail-dl">
          <dt>Status</dt>
          <dd><span className={`badge badge-${host.status}`}>{host.status}</span></dd>
          <dt>Class</dt>
          <dd><span className="badge badge-unknown">{host.hostClass ?? "unknown"}</span></dd>
          <dt>Hostname</dt>
          <dd>
            <EditableHostname host={host} onRenamed={() => void refresh()} />
          </dd>
          <dt>Device ID</dt>
          <dd><code>{host.id}</code></dd>
          <dt>Last seen</dt>
          <dd className="mono">{formatTimestamp(host.lastSeen)}</dd>
          {/* LAMA-223: tailnet is the primary address; LAN IP is fallback info. */}
          <dt>Tailnet IP</dt>
          <dd>
            {host.tailnetIp ? (
              <code className="address-primary">{host.tailnetIp}</code>
            ) : (
              <span className="muted">—</span>
            )}
          </dd>
          <dt>LAN IP</dt>
          <dd>
            {host.lanIp ? (
              <code className="muted">{host.lanIp}</code>
            ) : (
              <span className="muted">—</span>
            )}
          </dd>
          <dt>Service version</dt>
          <dd>
            <code>v{host.version ?? "—"}</code>
            {host.updateAvailable ? (
              <span className="badge badge-update">update available</span>
            ) : null}
          </dd>
          <dt>
            Config revision <Hint text={MISC_HINTS.configRevision} />
          </dt>
          <dd><code>{host.configRevision ?? 0}</code> (cached: <code>{config.host.configRevision ?? 0}</code>)</dd>
        </dl>
      </section>

      <section className="section">
        <h2>Software</h2>
        <dl className="host-detail-dl">
          <dt>Installed version</dt>
          <dd><code>v{host.version ?? "—"}</code></dd>
          <dt>Latest release</dt>
          <dd><code>{latestVersion ? `v${latestVersion}` : "—"}</code></dd>
          <dt>Update</dt>
          <dd>
            {updateState.kind === "ready" ? (
              <span className="badge badge-update">update available</span>
            ) : updateState.kind === "no-update" ? (
              <span className="badge badge-success">up to date</span>
            ) : (
              <span className="muted">{updateState.message}</span>
            )}
          </dd>
        </dl>
        {updateState.kind === "ready" ? (
          <div className="actions">
            <button
              type="button"
              className="action primary"
              disabled={updateBusy || updateInFlight}
              onClick={() => setConfirmUpdate(true)}
            >
              {updateBusy ? "Queueing…" : `Update daemon to v${updateState.latest}`}
            </button>
          </div>
        ) : null}
        {updateFollowUp ? (
          <div className={updateFollowUp.kind === "failed" ? "error" : "muted"}>
            {updateFollowUp.message}
          </div>
        ) : null}
        <p className="muted">
          Remote update runs the same release flow as <code>lamasyncd --update</code> on
          the device: download from the release proxy, atomic binary replace, then a
          systemd service restart. Local sync work is not cancelled by this page —
          but the device service restarts. Devices older than the release that added
          remote updates must bootstrap once with <code>lamasyncd --update</code> or
          the installer.
        </p>
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
              {busy === b.type ? "…" : b.label}
            </button>
          ))}
        </div>
        <p className="muted">{MISC_HINTS.queuedAction}</p>
      </section>

      <section className="section">
        <h2>Folders on this device ({assignments.length})</h2>
        {editingAssignment ? (
          <AssignmentEditor
            assignment={editingAssignment}
            folder={folderById.get(editingAssignment.folderId)}
            folderName={folderById.get(editingAssignment.folderId)?.name}
            hostName={data?.host.hostname}
            onSaved={() => {
              setEditingAssignment(null);
              void refresh();
            }}
            onCancel={() => setEditingAssignment(null)}
          />
        ) : null}
        {assignmentRows.length === 0 ? (
          <div className="empty-row">No folders on this device yet</div>
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
                <th />
              </tr>
            </thead>
            <tbody>
              {assignmentRows.map(({ assignment, folder }) => (
                <tr key={assignment.id}>
                  <td>
                    {folder ? folder.name : assignment.folderId}{" "}
                    <Link
                      className="action"
                      to={`/operations?folderId=${encodeURIComponent(assignment.folderId)}`}
                    >
                      History
                    </Link>
                  </td>
                  <td>
                    {folder && (folder.type === "sync" || folder.type === "mount") ? (
                      <span className="badge badge-unknown">
                        {effectiveFolderType(folder, assignment)}
                        {assignment.mode && assignment.mode !== "inherit"
                          ? " (override)"
                          : ""}
                      </span>
                    ) : (
                      <span className="badge badge-unknown">{folder?.type ?? "—"}</span>
                    )}
                  </td>
                  <td className="muted"><code>{assignment.localPath}</code></td>
                  <td className="muted">{assignment.syncExpr ?? "—"}</td>
                  <td className="muted">{assignment.role}</td>
                  <td>
                    <button
                      type="button"
                      className="action"
                      disabled={assignmentBusy !== null}
                      onClick={() => void onToggleEnabled(assignment)}
                      title={assignment.enabled ? "Pause syncing this folder" : "Resume syncing this folder"}
                    >
                      {assignmentBusy === `${assignment.folderId}:toggle`
                        ? "…"
                        : assignment.enabled
                          ? "Pause"
                          : "Resume"}
                    </button>
                  </td>
                  <td className="table-actions">
                    <button
                      type="button"
                      className="action"
                      disabled={assignmentBusy !== null || editingAssignment !== null}
                      onClick={() => setEditingAssignment(assignment)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="action"
                      disabled={assignmentBusy !== null}
                      onClick={() => void onAssignmentSync(assignment.folderId, false)}
                      title={`Sync “${folder?.name ?? assignment.folderId}” now`}
                    >
                      {assignmentBusy === `${assignment.folderId}:sync` ? "…" : "Sync now"}
                    </button>
                    <button
                      type="button"
                      className="action"
                      disabled={assignmentBusy !== null || preview !== null}
                      onClick={() => void openDryRunPreview(assignment.folderId)}
                      title="Preview next run (rclone --dry-run, no file changes)"
                    >
                      Preview next run
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2>App settings backups ({manifests.length})</h2>
        {manifests.length === 0 ? (
          <div className="empty-row">No app settings backups yet</div>
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
                  <td className="mono">{formatTimestamp(op.timestamp)}</td>
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
                  <td className="mono muted">{formatTimestamp(a.createdAt)}</td>
                  <td className="mono muted">{formatTimestamp(a.takenAt)}</td>
                  <td className="mono muted">{formatTimestamp(a.completedAt)}</td>
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

      {confirmUpdate && updateState.kind === "ready" && (
        <ConfirmDialog
          title="Update daemon"
          confirmLabel={`Update to v${updateState.latest}`}
          message={
            <>
              Update the LamaSync daemon on “{host.hostname}” from
              v{updateState.installed} to v{updateState.latest}?
              <br />
              <br />
              The device downloads the release via the server's release proxy,
              atomically replaces its binary, and restarts the
              <code> lamasyncd.service</code> systemd unit. Local sync work is
              not cancelled by this page, but the device service restarts.
            </>
          }
          onConfirm={() => void onUpdateDaemon()}
          onCancel={() => setConfirmUpdate(false)}
        />
      )}

      {confirmDelete && data && (
        <ConfirmDialog
          title="Delete device"
          danger
          confirmLabel="Delete"
          message={
            <>
              Delete device “{data.host.hostname}” ({data.host.id})?
              <br />
              <br />
              This removes its folder setups, app settings backups, and
              history. Stop/uninstall the LamaSync service on that machine
              too, or it will re-register.
            </>
          }
          onConfirm={() => void runDeleteHost()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      <DryRunDrawer
        open={preview !== null}
        folderName={
          preview ? (folderById.get(preview.folderId)?.name ?? preview.folderId) : ""
        }
        state={previewState}
        onClose={closePreview}
      />
    </div>
  );
}