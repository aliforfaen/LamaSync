import { useEffect, useState } from "react";
import type { Folder, FolderAssignment, FolderBackend, Host, S3Provider } from "@lamasync/core";
import { api } from "../api.ts";

interface FolderWithAssignments {
  folder: Folder;
  assignments: FolderAssignment[];
}

type FolderType = "sync" | "mount" | "backup" | "dotfile" | "git";

const ASSIGN_ROLES = ["source", "target", "both"] as const;
type AssignRole = (typeof ASSIGN_ROLES)[number];

interface AssignForm {
  hostId: string;
  role: AssignRole;
  localPath: string;
  syncExpr: string;
}

interface FolderForm {
  name: string;
  type: FolderType;
  backend: FolderBackend;
  s3Provider: S3Provider;
  s3Endpoint: string;
  s3Bucket: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3Region: string;
}

const FOLDER_TYPES: FolderType[] = ["sync", "mount", "backup", "dotfile", "git"];
const FOLDER_BACKENDS: FolderBackend[] = ["sftp", "s3", "local"];
const S3_PROVIDERS: S3Provider[] = ["exoscale", "aws", "other"];

const DEFAULT_FORM: FolderForm = {
  name: "",
  type: "sync",
  backend: "sftp",
  s3Provider: "other",
  s3Endpoint: "",
  s3Bucket: "",
  s3AccessKeyId: "",
  s3SecretAccessKey: "",
  s3Region: "",
};

function isFolderType(value: string): value is FolderType {
  return FOLDER_TYPES.includes(value as FolderType);
}

function isFolderBackend(value: string): value is FolderBackend {
  return FOLDER_BACKENDS.includes(value as FolderBackend);
}

function isS3Provider(value: string): value is S3Provider {
  return S3_PROVIDERS.includes(value as S3Provider);
}

function folderToForm(folder: Folder): FolderForm {
  return {
    name: folder.name,
    type: folder.type,
    backend: folder.backend ?? "sftp",
    s3Provider: folder.s3Provider ?? "other",
    s3Endpoint: folder.s3Endpoint ?? "",
    s3Bucket: folder.s3Bucket ?? "",
    s3AccessKeyId: folder.s3AccessKeyId ?? "",
    s3SecretAccessKey: folder.s3SecretAccessKey ?? "",
    s3Region: folder.s3Region ?? "",
  };
}

function buildCreateBody(form: FolderForm): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    type: form.type,
    backend: form.backend,
  };
  if (form.backend === "s3") {
    body.s3Provider = form.s3Provider;
    body.s3Endpoint = form.s3Endpoint.trim() || null;
    body.s3Bucket = form.s3Bucket.trim() || null;
    body.s3AccessKeyId = form.s3AccessKeyId.trim() || null;
    body.s3SecretAccessKey = form.s3SecretAccessKey.trim() || null;
    body.s3Region = form.s3Region.trim() || null;
  }
  return body;
}

function buildUpdateBody(form: FolderForm): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    type: form.type,
    backend: form.backend,
  };
  if (form.backend === "s3") {
    body.s3Provider = form.s3Provider;
    body.s3Endpoint = form.s3Endpoint.trim() || null;
    body.s3Bucket = form.s3Bucket.trim() || null;
    body.s3AccessKeyId = form.s3AccessKeyId.trim() || null;
    // The API redacts the stored secret (LAMA-178), so the edit form always
    // loads blank. Blank means "keep the existing secret" — only send the
    // field when the user actually typed a new one.
    const secret = form.s3SecretAccessKey.trim();
    if (secret !== "") body.s3SecretAccessKey = secret;
    body.s3Region = form.s3Region.trim() || null;
  } else {
    body.s3Endpoint = null;
    body.s3Bucket = null;
    body.s3AccessKeyId = null;
    body.s3SecretAccessKey = null;
    body.s3Region = null;
  }
  return body;
}

export function Folders() {
  const [items, setItems] = useState<FolderWithAssignments[] | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
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

  async function refresh() {
    setError(null);
    try {
      const [folders, hostList] = await Promise.all([
        api.listFolders(),
        api.listHosts(),
      ]);
      const withAssignments = await Promise.all(
        folders.map(async (folder) => ({
          folder,
          assignments: await api.listAssignments(folder.id),
        })),
      );
      setItems(withAssignments);
      setHosts(hostList);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
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
    if (!confirm("Delete this folder and all its assignments?")) return;
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
    setBusy(true);
    setError(null);
    try {
      await api.assignFolder(assigningFolder.id, {
        hostId: assignForm.hostId,
        role: assignForm.role,
        localPath: assignForm.localPath.trim(),
        syncExpr: assignForm.syncExpr.trim() || null,
      });
      setAssigningFolder(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onUnassign(folderId: string, hostId: string) {
    if (!confirm(`Unassign this folder from ${hostId}?`)) return;
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

  function updateFormBackend(value: string, current: FolderForm, setter: (f: FolderForm) => void) {
    if (!isFolderBackend(value)) return;
    const next = { ...current, backend: value };
    if (value !== "s3") {
      next.s3Provider = "other";
      next.s3Endpoint = "";
      next.s3Bucket = "";
      next.s3AccessKeyId = "";
      next.s3SecretAccessKey = "";
      next.s3Region = "";
    }
    setter(next);
  }

  function updateFormS3Provider(value: string, current: FolderForm, setter: (f: FolderForm) => void) {
    if (!isS3Provider(value)) return;
    const next = { ...current, s3Provider: value };
    if (value === "exoscale") {
      next.s3Region = "other-v2-signature";
    } else if (current.s3Region === "other-v2-signature") {
      next.s3Region = "";
    }
    setter(next);
  }

  function renderS3Fields(current: FolderForm, setter: (f: FolderForm) => void, isEditing: boolean) {
    return (
      <>
        <label>
          S3 provider
          <select
            value={current.s3Provider}
            onChange={(e) => updateFormS3Provider(e.target.value, current, setter)}
          >
            {S3_PROVIDERS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          Endpoint
          <input
            required
            value={current.s3Endpoint}
            placeholder={current.s3Provider === "exoscale" ? "sos-at-vie-1.exo.io" : "s3.example.com"}
            onChange={(e) => setter({ ...current, s3Endpoint: e.target.value })}
          />
        </label>
        <label>
          Bucket
          <input
            required
            value={current.s3Bucket}
            onChange={(e) => setter({ ...current, s3Bucket: e.target.value })}
          />
        </label>
        <label>
          Access key ID
          <input
            required
            value={current.s3AccessKeyId}
            onChange={(e) => setter({ ...current, s3AccessKeyId: e.target.value })}
          />
        </label>
        <label>
          Secret access key
          <input
            required={!isEditing}
            type="password"
            value={current.s3SecretAccessKey}
            placeholder={isEditing ? "(unchanged)" : undefined}
            onChange={(e) => setter({ ...current, s3SecretAccessKey: e.target.value })}
          />
        </label>
        <label>
          Region
          <input
            required={current.s3Provider !== "exoscale"}
            disabled={current.s3Provider === "exoscale"}
            value={current.s3Provider === "exoscale" ? "other-v2-signature" : current.s3Region}
            onChange={(e) => setter({ ...current, s3Region: e.target.value })}
          />
        </label>
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
        </label>
        {current.backend === "s3" && renderS3Fields(current, setter, isEditing)}
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
                {ASSIGN_ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
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
              <input
                placeholder="*/15 * * * *"
                value={assignForm.syncExpr}
                onChange={(e) => setAssignForm({ ...assignForm, syncExpr: e.target.value })}
              />
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
      {showForm && renderForm(form, setForm, onCreate, "Create", () => { setShowForm(false); setForm(DEFAULT_FORM); })}

      {editingId && renderForm(editForm, setEditForm, onEdit, "Save", () => setEditingId(null), true)}

      {renderAssignForm()}

      <table className="data">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Backend</th>
            <th>Assignments</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {!items ? (
            <tr className="empty-row">
              <td colSpan={6}>Loading…</td>
            </tr>
          ) : items.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={6}>No folders yet</td>
            </tr>
          ) : (
            items.map(({ folder, assignments }) => (
              <tr key={folder.id}>
                <td>{folder.name}</td>
                <td>
                  <span className="badge badge-unknown">{folder.type}</span>
                </td>
                <td>
                  {folder.backend ?? "sftp"}
                  {folder.backend === "s3" && folder.s3Provider && (
                    <span className="muted"> / {folder.s3Provider}</span>
                  )}
                </td>
                <td>
                  {assignments.length === 0 ? (
                    <span className="muted">—</span>
                  ) : (
                    <ul className="assignment-list">
                      {assignments.map((assignment) => (
                        <li key={assignment.id}>
                          <strong>{assignment.hostId}</strong>
                          <span>{assignment.role} · {assignment.localPath}</span>
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
                <td className="muted">
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
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
