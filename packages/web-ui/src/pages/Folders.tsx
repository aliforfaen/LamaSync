import { useEffect, useState } from "react";
import type { Folder, FolderAssignment } from "@lamasync/core";
import { api } from "../api.ts";

interface FolderWithAssignments {
  folder: Folder;
  assignments: FolderAssignment[];
}

interface NewFolderForm {
  name: string;
  type: "sync" | "mount" | "backup" | "dotfile" | "git";
}

const FOLDER_TYPES = ["sync", "mount", "backup", "dotfile", "git"] as const;
function isFolderType(value: string): value is NewFolderForm["type"] {
  return FOLDER_TYPES.some((type) => type === value);
}


export function Folders() {
  const [items, setItems] = useState<FolderWithAssignments[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<NewFolderForm>({ name: "", type: "sync" });
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<NewFolderForm>({ name: "", type: "sync" });

  async function refresh() {
    setError(null);
    try {
      const folders = await api.listFolders();
      const withAssignments = await Promise.all(
        folders.map(async (folder) => ({
          folder,
          assignments: await api.listAssignments(folder.id),
        })),
      );
      setItems(withAssignments);
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
      await api.createFolder({ name: form.name.trim(), type: form.type });
      setForm({ name: "", type: "sync" });
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
    setEditForm({ name: folder.name, type: folder.type });
  }

  async function onEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateFolder(editingId, {
        name: editForm.name.trim(),
        type: editForm.type,
      });
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

  function updateCreateType(value: string) {
    if (isFolderType(value)) setForm({ ...form, type: value });
  }

  function updateEditType(value: string) {
    if (isFolderType(value)) setEditForm({ ...editForm, type: value });
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
      {showForm && (
        <form className="form" onSubmit={onCreate}>
          <label>
            Name
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            Type
            <select
              value={form.type}
              onChange={(e) => updateCreateType(e.target.value)}
            >
              {FOLDER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <div className="actions">
            <button type="submit" className="action primary" disabled={busy}>
              Create
            </button>
          </div>
        </form>
      )}

      {editingId && (
        <form className="form" onSubmit={onEdit}>
          <label>
            Name
            <input
              required
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
            />
          </label>
          <label>
            Type
            <select
              value={editForm.type}
              onChange={(e) => updateEditType(e.target.value)}
            >
              {FOLDER_TYPES.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </label>
          <div className="actions">
            <button type="submit" className="action primary" disabled={busy}>Save</button>
            <button type="button" className="action" onClick={() => setEditingId(null)}>Cancel</button>
          </div>
        </form>
      )}

      <table className="data">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Assignments</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {!items ? (
            <tr className="empty-row">
              <td colSpan={5}>Loading…</td>
            </tr>
          ) : items.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={5}>No folders yet</td>
            </tr>
          ) : (
            items.map(({ folder, assignments }) => (
              <tr key={folder.id}>
                <td>{folder.name}</td>
                <td>
                  <span className="badge badge-unknown">{folder.type}</span>
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
