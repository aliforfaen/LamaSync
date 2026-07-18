import { useEffect, useState } from "react";
import type { DotfileManifest } from "@lamasync/core";
import { api } from "../api.ts";

interface ManifestForm {
  appName: string;
  paths: string;
  schedule: string;
  instructions: string;
}

const EMPTY_FORM: ManifestForm = {
  appName: "",
  paths: "",
  schedule: "",
  instructions: "",
};

export function Dotfiles() {
  const [items, setItems] = useState<DotfileManifest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ManifestForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<ManifestForm>(EMPTY_FORM);

  async function refresh() {
    setError(null);
    try {
      const list = await api.listManifests();
      setItems(list);
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
      const paths = form.paths
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      await api.createManifest({
        appName: form.appName.trim(),
        paths,
        schedule: form.schedule.trim() || null,
        instructions: form.instructions.trim() || null,
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function beginEdit(manifest: DotfileManifest) {
    setEditingId(manifest.id);
    setEditForm({
      appName: manifest.appName,
      paths: manifest.paths.join(", "),
      schedule: manifest.schedule ?? "",
      instructions: manifest.instructions ?? "",
    });
  }

  async function onEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setBusy(true);
    setError(null);
    try {
      const paths = editForm.paths
        .split(",")
        .map((path) => path.trim())
        .filter((path) => path.length > 0);
      await api.updateManifest(editingId, {
        appName: editForm.appName.trim(),
        paths,
        schedule: editForm.schedule.trim() || null,
        instructions: editForm.instructions.trim() || null,
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
    if (!confirm("Delete this manifest and all its versions?")) return;
    setBusy(true);
    try {
      await api.deleteManifest(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Dotfiles</h1>
        <button type="button" className="action primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "New manifest"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {showForm && (
        <form className="form" onSubmit={onCreate}>
          <label>
            App name
            <input
              required
              value={form.appName}
              onChange={(e) => setForm({ ...form, appName: e.target.value })}
            />
          </label>
          <label>
            Paths (comma-separated)
            <input
              required
              placeholder="~/.config/nvim, ~/.bashrc"
              value={form.paths}
              onChange={(e) => setForm({ ...form, paths: e.target.value })}
            />
          </label>
          <label>
            Schedule (cron)
            <input
              value={form.schedule}
              placeholder="0 */6 * * *"
              onChange={(e) => setForm({ ...form, schedule: e.target.value })}
            />
          </label>
          <label>
            Instructions
            <textarea
              rows={3}
              value={form.instructions}
              onChange={(e) => setForm({ ...form, instructions: e.target.value })}
            />
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
            App name
            <input
              required
              value={editForm.appName}
              onChange={(e) => setEditForm({ ...editForm, appName: e.target.value })}
            />
          </label>
          <label>
            Paths (comma-separated)
            <input
              required
              value={editForm.paths}
              onChange={(e) => setEditForm({ ...editForm, paths: e.target.value })}
            />
          </label>
          <label>
            Schedule (cron)
            <input
              value={editForm.schedule}
              onChange={(e) => setEditForm({ ...editForm, schedule: e.target.value })}
            />
          </label>
          <label>
            Instructions
            <textarea
              rows={3}
              value={editForm.instructions}
              onChange={(e) => setEditForm({ ...editForm, instructions: e.target.value })}
            />
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
            <th>App</th>
            <th>Host</th>
            <th>Paths</th>
            <th>Schedule</th>
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
              <td colSpan={5}>No manifests yet</td>
            </tr>
          ) : (
            items.map((m) => (
              <tr key={m.id}>
                <td>{m.appName}</td>
                <td className="muted">{m.hostId}</td>
                <td className="muted">{m.paths.join(", ")}</td>
                <td className="muted">{m.schedule ?? "—"}</td>
                <td className="table-actions">
                  <button
                    type="button"
                    className="action"
                    onClick={() => beginEdit(m)}
                    disabled={busy}
                  >
                    Edit
                  </button>

                  <button
                    type="button"
                    className="action danger"
                    onClick={() => onDelete(m.id)}
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
