import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Backend, Folder, FolderAssignment, FolderBackend, Host } from "@lamasync/core";
import { api } from "../api.ts";
import { validateCronExpression } from "../cron.ts";
import { AssignmentEditor } from "../components/AssignmentEditor.tsx";
import { HintText } from "../components/Hint.tsx";
import { ConfirmDialog } from "../components/Modal.tsx";
import {
  BACKEND_KIND_HINTS,
  FOLDER_TYPE_HINTS,
  ROLE_HINTS,
} from "../concepts.ts";

interface FolderWithAssignments {
  folder: Folder;
  assignments: FolderAssignment[];
}

type FolderType = "sync" | "mount" | "backup" | "dotfile" | "git";

type AssignRole = "source" | "target" | "both";

// Mirrors the Dotfiles page + AssignmentEditor presets so the assign form
// offers the same schedule shortcuts.
const SCHEDULE_PRESETS: { label: string; value: string; cron: string }[] = [
  { label: "Custom", value: "custom", cron: "" },
  { label: "Every hour", value: "hourly", cron: "0 * * * *" },
  { label: "Every 6 hours", value: "6h", cron: "0 */6 * * *" },
  { label: "Daily", value: "daily", cron: "0 0 * * *" },
  { label: "Weekly", value: "weekly", cron: "0 0 * * 0" },
  { label: "Monthly", value: "monthly", cron: "0 0 1 * *" },
  { label: "On boot", value: "@reboot", cron: "@reboot" },
  { label: "On login", value: "@login", cron: "@login" },
];

function schedulePresetForCron(cron: string | null | undefined): string {
  if (!cron) return "custom";
  const preset = SCHEDULE_PRESETS.find((p) => p.cron === cron);
  return preset ? preset.value : "custom";
}

interface AssignForm {
  hostId: string;
  role: AssignRole;
  localPath: string;
  syncExpr: string;
}

/** Hint for a folder backend value (sftp has no glossary entry — the four
 *  named backend kinds do). */
function backendKindHint(kind: FolderBackend): string | undefined {
  if (kind === "sftp") return undefined;
  return BACKEND_KIND_HINTS[kind];
}

interface FolderForm {
  name: string;
  type: FolderType;
  backend: FolderBackend;
  // LAMA-222: an s3 folder references a reusable Backend (credentials live
  // there) and only needs the per-folder bucket name here.
  backendId: string;
  s3Bucket: string;
}

const FOLDER_TYPES: FolderType[] = ["sync", "mount", "backup", "dotfile", "git"];
// LAMA-232: local/nfs/restic folders reference a matching-kind Backend
// (server-side directory target, or centralized restic repo).
const FOLDER_BACKENDS: FolderBackend[] = ["sftp", "s3", "local", "nfs", "restic"];

const BACKEND_REF_KINDS: FolderBackend[] = ["s3", "local", "nfs", "restic"];

const DEFAULT_FORM: FolderForm = {
  name: "",
  type: "sync",
  backend: "sftp",
  backendId: "",
  s3Bucket: "",
};

function isFolderType(value: string): value is FolderType {
  return FOLDER_TYPES.includes(value as FolderType);
}

function isFolderBackend(value: string): value is FolderBackend {
  return FOLDER_BACKENDS.includes(value as FolderBackend);
}

/** Human-readable byte count for the Size column (LAMA-224). */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "n/a";
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

function folderToForm(folder: Folder): FolderForm {
  return {
    name: folder.name,
    type: folder.type,
    backend: folder.backend ?? "sftp",
    backendId: folder.backendId ?? "",
    s3Bucket: folder.s3Bucket ?? "",
  };
}

function buildCreateBody(form: FolderForm): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    type: form.type,
    backend: form.backend,
  };
  if (BACKEND_REF_KINDS.includes(form.backend)) {
    body.backendId = form.backendId.trim() || null;
  }
  if (form.backend === "s3") {
    body.s3Bucket = form.s3Bucket.trim() || null;
  }
  return body;
}

/** UX workstream 4: client-side folder validation (S3 bucket required). */
function validateFolderForm(form: FolderForm): string | null {
  if (form.backend === "s3") {
    if (form.s3Bucket.trim() === "") return "s3 bucket name is required";
    if (form.backendId.trim() === "") return "pick an S3 backend for this folder";
  }
  return null;
}

function buildUpdateBody(form: FolderForm): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    type: form.type,
    backend: form.backend,
  };
  if (BACKEND_REF_KINDS.includes(form.backend)) {
    body.backendId = form.backendId.trim() || null;
  } else {
    body.backendId = null;
  }
  if (form.backend === "s3") {
    body.s3Bucket = form.s3Bucket.trim() || null;
  } else {
    body.s3Bucket = null;
  }
  return body;
}

export function Folders() {
  const [items, setItems] = useState<FolderWithAssignments[] | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [backends, setBackends] = useState<Backend[]>([]);
  // LAMA-224: last-known working-set size per folder (server-cached 15 min).
  const [sizes, setSizes] = useState<Record<string, { text: string; error?: boolean }>>({});
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FolderForm>(DEFAULT_FORM);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FolderForm>(DEFAULT_FORM);
  const [assigningFolder, setAssigningFolder] = useState<Folder | null>(null);
  const [assignForm, setAssignForm] = useState<AssignForm>({
    hostId: "",
    role: "both",
    localPath: "",
    syncExpr: "",
  });
  // LAMA-198: transient "queued" note after a per-assignment Sync now.
  const [syncNote, setSyncNote] = useState<string | null>(null);
  // UX workstream 4: inline cron validation on the assign form.
  const [assignCronError, setAssignCronError] = useState<string | null>(null);
  // Assignment editing (reuses AssignmentEditor from HostDetail).
  const [editingAssignment, setEditingAssignment] = useState<FolderAssignment | null>(null);
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const [unassign, setUnassign] = useState<{ folderId: string; hostId: string } | null>(null);

  async function refresh() {
    setError(null);
    try {
      const [folders, hostList, backendList] = await Promise.all([
        api.listFolders(),
        api.listHosts(),
        api.listBackends().catch(() => [] as Backend[]),
      ]);
      const withAssignments = await Promise.all(
        folders.map(async (folder) => ({
          folder,
          assignments: await api.listAssignments(folder.id),
        })),
      );
      setItems(withAssignments);
      setHosts(hostList);
      setBackends(backendList);
      // LAMA-224 P1-7: per-folder sizes are sequential, not parallel —
      // a fleet with many S3 folders used to spawn N concurrent rclone
      // processes against the same bucket. Individual failures (or the
      // non-S3 'not measurable server-side' response) show "n/a".
      for (const folder of folders) {
        try {
          const size = await api.folderSize(folder.id);
          setSizes((prev) => ({
            ...prev,
            [folder.id]: {
              text: formatBytes(size.bytes),
              error: Boolean(size.error),
            },
          }));
        } catch {
          setSizes((prev) => ({
            ...prev,
            [folder.id]: { text: "n/a", error: true },
          }));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    const validationError = validateFolderForm(form);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createFolder(buildCreateBody(form));
      setForm(DEFAULT_FORM);
      setShowForm(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function beginEdit(folder: Folder) {
    setEditingId(folder.id);
    setEditForm(folderToForm(folder));
  }

  async function onEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    const validationError = validateFolderForm(editForm);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateFolder(editingId, buildUpdateBody(editForm));
      setEditingId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    setDeletingFolderId(id);
  }

  async function confirmDeleteFolder(): Promise<void> {
    if (!deletingFolderId) return;
    const id = deletingFolderId;
    setDeletingFolderId(null);
    setBusy(true);
    try {
      await api.deleteFolder(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function beginAssign(folder: Folder, assignments: FolderAssignment[]) {
    const assignedHostIds = new Set(assignments.map((a) => a.hostId));
    const firstAvailable = hosts.find((h) => !assignedHostIds.has(h.id));
    setAssigningFolder(folder);
    setAssignForm({
      hostId: firstAvailable?.id ?? "",
      role: "both",
      localPath: "",
      syncExpr: "",
    });
  }

  async function onAssign(e: React.FormEvent) {
    e.preventDefault();
    if (!assigningFolder || !assignForm.hostId) return;
    // UX workstream 4: validate cron client-side before the round-trip.
    const cron = assignForm.syncExpr.trim();
    if (cron) {
      const cronError = validateCronExpression(cron);
      if (cronError) {
        setAssignCronError(cronError);
        return;
      }
    }
    setAssignCronError(null);
    setBusy(true);
    setError(null);
    try {
      await api.assignFolder(assigningFolder.id, {
        hostId: assignForm.hostId,
        role: assignForm.role,
        localPath: assignForm.localPath.trim(),
        syncExpr: cron || null,
      });
      setAssigningFolder(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function onUnassign(folderId: string, hostId: string) {
    setUnassign({ folderId, hostId });
  }

  async function confirmUnassign(): Promise<void> {
    if (!unassign) return;
    const { folderId, hostId } = unassign;
    setUnassign(null);
    setBusy(true);
    setError(null);
    try {
      await api.unassignFolder(folderId, hostId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // LAMA-198: ask a host's daemon to sync this folder now. The daemon picks
  // it up on its next poll (~30 s); the server 404s if the folder isn't
  // actually assigned to that host, which we surface rather than pre-filter.
  async function onSyncNow(folderId: string, hostId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.enqueueAction(hostId, {
        type: "trigger_sync",
        payload: { folderId },
      });
      // UX workstream 4: resolve ids to display names in the note.
      const folderName =
        items?.find((i) => i.folder.id === folderId)?.folder.name ?? folderId;
      const hostName = hosts.find((h) => h.id === hostId)?.hostname ?? hostId;
      setSyncNote(
        `Sync of “${folderName}” queued on ${hostName} — runs on the daemon within ~30 s`,
      );
      window.setTimeout(() => setSyncNote(null), 6000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function updateFormBackend(value: string, current: FolderForm, setter: (f: FolderForm) => void) {
    if (!isFolderBackend(value)) return;
    const next = { ...current, backend: value };
    if (!BACKEND_REF_KINDS.includes(value)) {
      next.backendId = "";
      next.s3Bucket = "";
    }
    if (value !== "s3") {
      next.s3Bucket = "";
    }
    setter(next);
  }

  function renderS3Fields(current: FolderForm, setter: (f: FolderForm) => void, isEditing: boolean) {
    return (
      <>
        <label>
          Backend
          <select
            required
            value={current.backendId}
            onChange={(e) => setter({ ...current, backendId: e.target.value })}
          >
            <option value="">Select a backend…</option>
            {backends
              .filter((b) => b.kind === "s3")
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.s3Endpoint ? ` (${b.s3Endpoint})` : ""}
                </option>
              ))}
          </select>
        </label>
        <label>
          Bucket name
          <input
            required
            value={current.s3Bucket}
            placeholder="my-bucket"
            onChange={(e) => setter({ ...current, s3Bucket: e.target.value })}
          />
        </label>
        {backends.length === 0 ? (
          <p className="muted">
            No backends configured yet — create one on the{" "}
            <a href="#/backends">Backends</a> page first.
          </p>
        ) : null}
      </>
    );
  }

  // LAMA-232: local/nfs/restic folders reference a matching-kind Backend.
  // The folder name is the sub-path under the backend root (mirroring how
  // the bucket name sits under an S3 backend).
  function renderKindBackendField(current: FolderForm, setter: (f: FolderForm) => void) {
    const matching = backends.filter((b) => b.kind === current.backend);
    const hint =
      current.backend === "local"
        ? "A server-side directory (attached disk) this folder syncs against."
        : current.backend === "nfs"
          ? "An NFS export already mounted on the server."
          : "Central restic repository — used as the default for this folder's backups.";
    return (
      <>
        <label>
          Backend
          <select
            required
            value={current.backendId}
            onChange={(e) => setter({ ...current, backendId: e.target.value })}
          >
            <option value="">Select a {current.backend} backend…</option>
            {matching.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.localPath ? ` (${b.localPath})` : b.resticRepository ? ` (${b.resticRepository})` : ""}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">{hint}</p>
        {matching.length === 0 ? (
          <p className="muted">
            No {current.backend} backends yet — create one on the{" "}
            <a href="#/backends">Backends</a> page first.
          </p>
        ) : null}
      </>
    );
  }

  function renderForm(
    current: FolderForm,
    setter: (f: FolderForm) => void,
    onSubmit: (e: React.FormEvent) => void,
    submitLabel: string,
    onCancel?: () => void,
    isEditing = false,
  ) {
    return (
      <form className="form" onSubmit={onSubmit}>
        <label>
          Name
          <input
            required
            value={current.name}
            onChange={(e) => setter({ ...current, name: e.target.value })}
          />
        </label>
        <label>
          Type
          <select
            value={current.type}
            onChange={(e) => isFolderType(e.target.value) && setter({ ...current, type: e.target.value })}
          >
            {FOLDER_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <HintText>{FOLDER_TYPE_HINTS[current.type]}</HintText>
        </label>
        <label>
          Backend
          <select
            value={current.backend}
            onChange={(e) => updateFormBackend(e.target.value, current, setter)}
          >
            {FOLDER_BACKENDS.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          <HintText>{backendKindHint(current.backend)}</HintText>
        </label>
        {current.backend === "s3" && renderS3Fields(current, setter, isEditing)}
        {(current.backend === "local" ||
          current.backend === "nfs" ||
          current.backend === "restic") &&
          renderKindBackendField(current, setter)}
        <div className="actions">
          <button type="submit" className="action primary" disabled={busy}>
            {submitLabel}
          </button>
          {onCancel && (
            <button type="button" className="action" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          )}
        </div>
      </form>
    );
  }

  function renderAssignForm() {
    if (!assigningFolder) return null;
    const assignedHostIds = new Set(
      (items?.find((i) => i.folder.id === assigningFolder.id)?.assignments ?? []).map(
        (a) => a.hostId,
      ),
    );
    const availableHosts = hosts.filter((h) => !assignedHostIds.has(h.id));
    return (
      <form className="form" onSubmit={onAssign}>
        <h2 className="form-title">Assign “{assigningFolder.name}” to a host</h2>
        {availableHosts.length === 0 ? (
          <p className="muted">
            {hosts.length === 0
              ? "No hosts registered yet — add one from the Hosts page first."
              : "Every registered host already has this folder assigned."}
          </p>
        ) : (
          <>
            <label>
              Host
              <select
                required
                value={assignForm.hostId}
                onChange={(e) => setAssignForm({ ...assignForm, hostId: e.target.value })}
              >
                {availableHosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.hostname} ({h.id})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Role
              <select
                value={assignForm.role}
                onChange={(e) =>
                  setAssignForm({ ...assignForm, role: e.target.value as AssignRole })
                }
              >
                {ROLE_HINTS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              <HintText>
                {ROLE_HINTS.find((r) => r.value === assignForm.role)?.hint}
              </HintText>
            </label>
            <label>
              Local path
              <input
                required
                placeholder="~/Documents"
                value={assignForm.localPath}
                onChange={(e) => setAssignForm({ ...assignForm, localPath: e.target.value })}
              />
            </label>
            <label>
              Schedule (cron, optional)
              <select
                value={schedulePresetForCron(assignForm.syncExpr)}
                onChange={(e) => {
                  const preset = SCHEDULE_PRESETS.find((p) => p.value === e.target.value);
                  setAssignForm({ ...assignForm, syncExpr: preset ? preset.cron : assignForm.syncExpr });
                  setAssignCronError(null);
                }}
              >
                {SCHEDULE_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </label>
            <label>
              Custom cron (optional)
              <input
                placeholder="*/15 * * * *"
                value={assignForm.syncExpr}
                onChange={(e) => {
                  setAssignForm({ ...assignForm, syncExpr: e.target.value });
                  setAssignCronError(null);
                }}
              />
              <HintText>
                Cron expression, e.g. <code>0 * * * *</code> = every hour. Leave
                empty to sync on the daemon's default schedule.
              </HintText>
              {assignCronError && <div className="error">{assignCronError}</div>}
            </label>
          </>
        )}
        <div className="actions">
          {availableHosts.length > 0 && (
            <button type="submit" className="action primary" disabled={busy}>
              Assign
            </button>
          )}
          <button
            type="button"
            className="action"
            onClick={() => setAssigningFolder(null)}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Folders</h1>
        <button type="button" className="action primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "New folder"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {syncNote && <div className="banner">{syncNote}</div>}
      {showForm && renderForm(form, setForm, onCreate, "Create", () => { setShowForm(false); setForm(DEFAULT_FORM); })}

      {editingId && renderForm(editForm, setEditForm, onEdit, "Save", () => setEditingId(null), true)}

      {renderAssignForm()}

      {editingAssignment ? (
        <AssignmentEditor
          assignment={editingAssignment}
          folderName={items?.find((i) => i.assignments.some((a) => a.id === editingAssignment.id))?.folder.name}
          onSaved={() => {
            setEditingAssignment(null);
            void refresh();
          }}
          onCancel={() => setEditingAssignment(null)}
        />
      ) : null}

      <table className="data">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Backend</th>
            <th>Size</th>
            <th>Assignments</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {!items ? (
            <tr aria-busy="true">
              <td colSpan={7}><div className="skel skel-line" /></td>
            </tr>
          ) : items.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={7}>No folders yet — create one, then assign it to a host to start syncing.</td>
            </tr>
          ) : (
            items.map(({ folder, assignments }) => {
              const size = sizes[folder.id];
              return (
              <tr key={folder.id}>
                <td>{folder.name}</td>
                <td>
                  <span className="badge badge-unknown">{folder.type}</span>
                </td>
                <td>
                  {folder.backend ?? "sftp"}
                  {folder.backend === "s3" && folder.backendId ? (
                    <span className="mono muted"> / {folder.backendId.slice(0, 8)}</span>
                  ) : null}
                </td>
                <td className="muted">
                  {size ? (
                    <span title={size.error ? "size unavailable (unreachable backend)" : undefined}>
                      {size.text}
                    </span>
                  ) : (
                    "…"
                  )}
                </td>
                <td>
                  {assignments.length === 0 ? (
                    <span className="muted">—</span>
                  ) : (
                    <ul className="assignment-list">
                      {assignments.map((assignment) => (
                        <li key={assignment.id}>
                          <strong className="mono">{assignment.hostId}</strong>
                          <span>
                            {assignment.role} · <span className="mono">{assignment.localPath}</span>
                          </span>
                          <button
                            type="button"
                            className="action"
                            title={`Edit assignment on ${assignment.hostId}`}
                            onClick={() => setEditingAssignment(assignment)}
                            disabled={busy || editingAssignment !== null}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="action"
                            title={`Sync “${folder.name}” now on ${assignment.hostId}`}
                            onClick={() => onSyncNow(folder.id, assignment.hostId)}
                            disabled={busy}
                          >
                            Sync now
                          </button>
                          <button
                            type="button"
                            className="action danger unassign-btn"
                            title={`Unassign from ${assignment.hostId}`}
                            onClick={() => onUnassign(folder.id, assignment.hostId)}
                            disabled={busy}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="mono muted">
                  {folder.createdAt ? new Date(folder.createdAt).toLocaleString() : "—"}
                </td>
                <td className="table-actions">
                  <button
                    type="button"
                    className="action"
                    onClick={() => beginAssign(folder, assignments)}
                    disabled={busy}
                  >
                    Assign
                  </button>
                  <Link
                    className="action"
                    to={`/operations?folderId=${encodeURIComponent(folder.id)}`}
                  >
                    History
                  </Link>
                  <button
                    type="button"
                    className="action"
                    onClick={() => beginEdit(folder)}
                    disabled={busy}
                  >
                    Edit
                  </button>

                  <button
                    type="button"
                    className="action danger"
                    onClick={() => onDelete(folder.id)}
                    disabled={busy}
                  >
                    Delete
                  </button>
                </td>
              </tr>
              );
            })
          )}
        </tbody>
      </table>

      {deletingFolderId && (
        <ConfirmDialog
          title="Delete folder"
          danger
          confirmLabel="Delete"
          message="Delete this folder and all its assignments?"
          onConfirm={() => void confirmDeleteFolder()}
          onCancel={() => setDeletingFolderId(null)}
        />
      )}

      {unassign && (
        <ConfirmDialog
          title="Unassign folder"
          danger
          confirmLabel="Unassign"
          message={`Unassign this folder from ${unassign.hostId}?`}
          onConfirm={() => void confirmUnassign()}
          onCancel={() => setUnassign(null)}
        />
      )}
    </div>
  );
}
