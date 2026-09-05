// LAMA-316 — App backups page. Host-scoped application protections with
// snapshot history. A protection binds one enrolled template to one device;
// snapshots are immutable archives captured on the protection's schedule or
// uploaded manually here. No restore/setup/replace actions exist in this
// delivery — a snapshot is downloaded and inspected elsewhere.

import { Fragment, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  ApplicationProtectionListItem,
  ApplicationSnapshot,
  Host,
} from "@lamasync/core";
import { api, errorText } from "../api.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { ConfirmDialog } from "../components/Modal.tsx";
import { formatBytes } from "../format-bytes.ts";
import { nextRunSentence } from "../next-run.ts";

/** Integrity badge tone per snapshot state (badge CSS tokens). */
const INTEGRITY_BADGE: Record<string, string> = {
  verified: "badge-success",
  unverified: "",
  failed: "badge-failed",
};

/** Human label for the (extensible) archive destination value. */
const DESTINATION_LABEL: Record<string, string> = {
  server_archive: "Server archive",
};

/** Description stamped on snapshots uploaded from this page. */
export const UPLOAD_DESCRIPTION = "Manual upload from the web UI";

// ---------------------------------------------------------------------------
// Flows shared with the page handlers — exported so the page test can drive
// the exact code the buttons call (repo convention: DOM-free page tests,
// see pages/apps.test.ts).
// ---------------------------------------------------------------------------

export interface SnapshotUploadServices {
  uploadAppSnapshot(
    protectionId: string,
    file: Blob,
    opts?: { description?: string },
  ): Promise<unknown>;
}

/**
 * Upload one tarball snapshot for a protection. Returns null on success; on
 * failure returns the error text the page renders — e.g. the server's 409
 * "protection is disabled" when the protection is turned off.
 */
export async function uploadProtectionSnapshot(
  services: SnapshotUploadServices,
  protectionId: string,
  file: Blob,
  description = UPLOAD_DESCRIPTION,
): Promise<string | null> {
  try {
    await services.uploadAppSnapshot(protectionId, file, { description });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export interface ProtectionToggleServices {
  updateAppProtection(id: string, body: { enabled: boolean }): Promise<unknown>;
}

/** Enable or disable a protection. Returns null on success, error text otherwise. */
export async function setProtectionEnabled(
  services: ProtectionToggleServices,
  id: string,
  enabled: boolean,
): Promise<string | null> {
  try {
    await services.updateAppProtection(id, { enabled });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

export function AppBackups() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [hostId, setHostId] = useState<string | null>(null);
  const [items, setItems] = useState<ApplicationProtectionListItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Expanded protection rows lazily load their snapshot list (cache is keyed
  // by protection id — never by template, since one template can be enrolled
  // on several devices).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, ApplicationSnapshot[]>>({});
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  // Hidden per-row file inputs; the Upload button calls input.click().
  // The map survives re-renders so a just-uploaded row can pick the same
  // file again (input value is cleared after each pick).
  const uploadRefs = useRef(new Map<string, HTMLInputElement>());
  const [busyProtectionId, setBusyProtectionId] = useState<string | null>(null);
  const [deletingProtection, setDeletingProtection] =
    useState<ApplicationProtectionListItem | null>(null);
  const [deletingSnapshot, setDeletingSnapshot] = useState<ApplicationSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.listHosts();
        if (cancelled) return;
        setHosts(list);
        setHostId((current) => current ?? list[0]?.id ?? null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load protections whenever the selected device changes.
  useEffect(() => {
    if (!hostId) {
      setItems([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await api.listAppProtections(hostId);
        if (cancelled) return;
        setItems(list);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hostId]);

  /** Silent reload after mutations (no full-page skeleton flash). */
  async function reloadProtections(): Promise<void> {
    if (!hostId) return;
    try {
      const list = await api.listAppProtections(hostId);
      setItems(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function hostLabel(id: string): string {
    return hosts.find((host) => host.id === id)?.hostname ?? id;
  }

  async function loadSnapshots(protectionId: string): Promise<void> {
    if (snapshots[protectionId] !== undefined) return;
    setSnapshotsLoading(true);
    setError(null);
    try {
      const list = await api.listAppSnapshots(protectionId);
      setSnapshots((previous) => ({ ...previous, [protectionId]: list }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSnapshotsLoading(false);
    }
  }

  function toggleHistory(protection: ApplicationProtectionListItem): void {
    if (expandedId === protection.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(protection.id);
    void loadSnapshots(protection.id);
  }

  async function refreshSnapshots(protectionId: string): Promise<void> {
    try {
      const list = await api.listAppSnapshots(protectionId);
      setSnapshots((previous) => ({ ...previous, [protectionId]: list }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onPickFile(
    protection: ApplicationProtectionListItem,
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploadingId(protection.id);
    setError(null);
    const message = await uploadProtectionSnapshot(api, protection.id, file);
    setUploadingId(null);
    if (message !== null) {
      // Disabled protection -> the server's 409 renders right here.
      setError(message);
      return;
    }
    await Promise.all([reloadProtections(), refreshSnapshots(protection.id)]);
  }

  async function onToggle(protection: ApplicationProtectionListItem): Promise<void> {
    setBusyProtectionId(protection.id);
    setError(null);
    const message = await setProtectionEnabled(api, protection.id, !protection.enabled);
    setBusyProtectionId(null);
    if (message !== null) {
      setError(message);
      return;
    }
    await reloadProtections();
  }

  async function confirmDeleteProtection(): Promise<void> {
    if (!deletingProtection) return;
    const protection = deletingProtection;
    setDeletingProtection(null);
    setBusyProtectionId(protection.id);
    setError(null);
    try {
      await api.deleteAppProtection(protection.id);
      setExpandedId((current) => (current === protection.id ? null : current));
      setSnapshots((previous) => {
        const next = { ...previous };
        delete next[protection.id];
        return next;
      });
      await reloadProtections();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyProtectionId(null);
    }
  }

  async function confirmDeleteSnapshot(): Promise<void> {
    if (!deletingSnapshot) return;
    const snapshot = deletingSnapshot;
    setDeletingSnapshot(null);
    setBusyProtectionId(snapshot.protectionId);
    setError(null);
    try {
      await api.deleteAppSnapshot(snapshot.id);
      await refreshSnapshots(snapshot.protectionId);
      await reloadProtections();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyProtectionId(null);
    }
  }

  async function download(id: string): Promise<void> {
    setError(null);
    try {
      await api.downloadAppSnapshot(id);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const selectedHostname = hostId ? hostLabel(hostId) : null;

  return (
    <div className="page">
      <PageHeader
        title="App backups"
        purpose="Application protections on one device, with the snapshots captured from them. Snapshots are immutable archives; download one to inspect or recover its contents elsewhere."
      />
      <div className="toolbar">
        <label>
          Device
          <select
            value={hostId ?? ""}
            onChange={(e) => setHostId(e.target.value)}
            disabled={hosts.length === 0}
          >
            {hosts.length === 0 ? <option value="">No devices</option> : null}
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>{host.hostname}</option>
            ))}
          </select>
        </label>
        <Link className="action" to="/apps/templates">Enroll a template…</Link>
      </div>
      {error ? <div className="error">{error}</div> : null}

      {hosts.length === 0 && !loading ? (
        <p className="muted">
          Register a device on the <Link to="/hosts">Devices</Link> page before protecting an
          application on it.
        </p>
      ) : null}

      <table className="data">
        <thead>
          <tr>
            <th>Protection</th>
            <th>Status</th>
            <th>Schedule</th>
            <th>Destination</th>
            <th>Latest snapshot</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {loading || items === null ? (
            <tr aria-busy="true">
              <td colSpan={6}><div className="skel skel-line" /></td>
            </tr>
          ) : items.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={6}>
                {selectedHostname
                  ? `No app protections on ${selectedHostname} yet — enroll a template to start capturing snapshots.`
                  : "No app protections yet"}
              </td>
            </tr>
          ) : (
            items.map((protection) => {
              const expanded = expandedId === protection.id;
              const protectionSnapshots = snapshots[protection.id];
              const busy = busyProtectionId === protection.id;
              return (
                <Fragment key={protection.id}>
                  <tr>
                    <td>
                      <strong>{protection.name}</strong>
                      <span className="muted"> · </span>
                      <span className="muted">{protection.templateName}</span>
                      {protection.templateEmoji ? (
                        <span className="muted"> {protection.templateEmoji}</span>
                      ) : null}
                      <span className="badge">
                        {protection.templateOrigin === "built_in" ? "Built-in" : "Custom"}
                      </span>
                    </td>
                    <td>
                      {protection.enabled ? (
                        <span className="badge badge-success">Enabled</span>
                      ) : (
                        <span className="badge badge-unknown">Disabled</span>
                      )}
                    </td>
                    <td className="muted">
                      {protection.schedule ? (
                        <span className="next-run" title={protection.schedule}>
                          {nextRunSentence(protection.schedule) ?? protection.schedule}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="muted">
                      {DESTINATION_LABEL[protection.destination] ?? protection.destination}
                    </td>
                    <td className="muted">
                      {protection.latestSnapshot ? (
                        <>
                          {new Date(protection.latestSnapshot.createdAt).toLocaleString()}
                          {" · "}
                          {formatBytes(protection.latestSnapshot.sizeBytes)}
                          {" · "}
                          <span className={`badge ${INTEGRITY_BADGE[protection.latestSnapshot.integrityStatus] ?? ""}`}>
                            {protection.latestSnapshot.integrityStatus}
                          </span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="table-actions">
                      <button
                        type="button"
                        className="action primary"
                        onClick={() => toggleHistory(protection)}
                        disabled={snapshotsLoading && !expanded}
                      >
                        {expanded ? "Hide history" : "Snapshot history"}
                      </button>
                      <button
                        type="button"
                        className="action"
                        disabled={uploadingId !== null}
                        onClick={() => uploadRefs.current.get(protection.id)?.click()}
                      >
                        {uploadingId === protection.id ? "Uploading…" : "Upload snapshot…"}
                      </button>
                      <input
                        ref={(node) => {
                          if (node) uploadRefs.current.set(protection.id, node);
                          else uploadRefs.current.delete(protection.id);
                        }}
                        type="file"
                        style={{ display: "none" }}
                        accept=".tar.gz,application/gzip"
                        onChange={(event) => void onPickFile(protection, event)}
                      />
                      <details className="row-menu">
                        <summary className="action">More</summary>
                        <div className="row-menu-panel">
                          <button type="button" disabled={busy} onClick={() => void onToggle(protection)}>
                            {protection.enabled ? "Disable protection" : "Enable protection"}
                          </button>
                          <button
                            type="button"
                            disabled={busy || protection.latestSnapshot === null}
                            onClick={() => {
                              if (protection.latestSnapshot) void download(protection.latestSnapshot.id);
                            }}
                          >
                            Download latest snapshot
                          </button>
                          <button
                            type="button"
                            className="danger"
                            disabled={busy || protection.latestSnapshot !== null}
                            title={protection.latestSnapshot ? "Disable this protection to keep its snapshot history" : undefined}
                            onClick={() => setDeletingProtection(protection)}
                          >
                            Delete protection
                          </button>
                        </div>
                      </details>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr className="dotfile-versions-row">
                      <td colSpan={6}>
                        <h3 className="form-title">Snapshot history — {protection.name}</h3>
                        {protectionSnapshots === undefined ? (
                          <span className="skel skel-line" aria-busy="true" />
                        ) : protectionSnapshots.length === 0 ? (
                          <span className="muted">
                            No snapshots yet. They land here when the device’s daemon captures this
                            protection on its schedule, or when you upload one.
                          </span>
                        ) : (
                          <table className="data">
                            <thead>
                              <tr>
                                <th>Snapshot</th>
                                <th>Created</th>
                                <th>Size</th>
                                <th>Integrity</th>
                                <th>Description</th>
                                <th />
                              </tr>
                            </thead>
                            <tbody>
                              {protectionSnapshots.map((snapshot) => (
                                <tr key={snapshot.id}>
                                  <td><code>{snapshot.id.slice(0, 8)}</code></td>
                                  <td className="muted">{new Date(snapshot.createdAt).toLocaleString()}</td>
                                  <td className="muted">{formatBytes(snapshot.sizeBytes)}</td>
                                  <td className="muted">
                                    <span className={`badge ${INTEGRITY_BADGE[snapshot.integrityStatus] ?? ""}`}>
                                      {snapshot.integrityStatus}
                                    </span>
                                  </td>
                                  <td className="muted">{snapshot.description ?? "—"}</td>
                                  <td className="table-actions">
                                    <button
                                      type="button"
                                      className="action"
                                      disabled={busy}
                                      onClick={() => void download(snapshot.id)}
                                    >
                                      Download
                                    </button>
                                    <button
                                      type="button"
                                      className="action danger"
                                      disabled={busy}
                                      onClick={() => setDeletingSnapshot(snapshot)}
                                    >
                                      Delete
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })
          )}
        </tbody>
      </table>

      {deletingProtection ? (
        <ConfirmDialog
          title={`Delete ${deletingProtection.name}?`}
          danger
          confirmLabel="Delete protection"
          message="Only protections without snapshots can be deleted. Disable this protection instead to stop future captures while preserving its history."
          onConfirm={() => void confirmDeleteProtection()}
          onCancel={() => setDeletingProtection(null)}
        />
      ) : null}

      {deletingSnapshot ? (
        <ConfirmDialog
          title="Delete snapshot"
          danger
          confirmLabel="Delete snapshot"
          message={`Delete snapshot ${deletingSnapshot.id.slice(0, 8)}? This permanently removes the archive.`}
          onConfirm={() => void confirmDeleteSnapshot()}
          onCancel={() => setDeletingSnapshot(null)}
        />
      ) : null}
    </div>
  );
}
