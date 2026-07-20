import { useEffect, useState } from "react";
import type { DotfileManifest, Host } from "@lamasync/core";
import { api } from "../api.ts";

const GLOBAL_HOST_ID = "_global";

interface ManifestForm {
  appName: string;
  hostId: string;
  paths: string;
  excludes: string;
  schedulePreset: string;
  schedule: string;
  instructions: string;
}

const EMPTY_FORM: ManifestForm = {
  appName: "",
  hostId: GLOBAL_HOST_ID,
  paths: "",
  excludes: "",
  schedulePreset: "custom",
  schedule: "",
  instructions: "",
};

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

export function Dotfiles() {
  const [items, setItems] = useState<DotfileManifest[] | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ManifestForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<ManifestForm>(EMPTY_FORM);

  async function refresh() {
    setError(null);
    try {
      const [list, health] = await Promise.all([api.listManifests(), api.health()]);
      setItems(list);
      setHosts(health.hosts ?? []);
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
      const excludes = form.excludes
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      await api.createManifest({
        appName: form.appName.trim(),
        hostId: form.hostId,
        paths,
        excludes: excludes.length > 0 ? excludes : null,
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
      hostId: manifest.hostId,
      paths: manifest.paths.join(", "),
      excludes: (manifest.excludes ?? []).join(", "),
      schedulePreset: schedulePresetForCron(manifest.schedule),
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
      const excludes = editForm.excludes
        .split(",")
        .map((path) => path.trim())
        .filter((path) => path.length > 0);
      await api.updateManifest(editingId, {
        appName: editForm.appName.trim(),
        paths,
        excludes: excludes.length > 0 ? excludes : null,
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

  function updateSchedule(formUpdater: (f: ManifestForm) => void, value: string) {
    const preset = SCHEDULE_PRESETS.find((p) => p.value === value);
    if (preset && value !== "custom") {
      formUpdater({ ...form, schedulePreset: value, schedule: preset.cron });
    } else {
      formUpdater({ ...form, schedulePreset: "custom", schedule: "" });
    }
  }

  function hostLabel(hostId: string): string {
    if (hostId === GLOBAL_HOST_ID) return "Global (all hosts)";
    const host = hosts.find((h) => h.id === hostId);
    return host?.hostname ?? hostId;
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
            Host
            <select
              value={form.hostId}
              onChange={(e) => setForm({ ...form, hostId: e.target.value })}
            >
              <option value={GLOBAL_HOST_ID}>Global (all hosts)</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.hostname}
                </option>
              ))}
            </select>
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
            Excludes (comma-separated)
            <input
              placeholder="*.log, cache/, .git"
              value={form.excludes}
              onChange={(e) => setForm({ ...form, excludes: e.target.value })}
            />
          </label>
          <label>
            Schedule
            <select
              value={form.schedulePreset}
              onChange={(e) => updateSchedule(setForm, e.target.value)}
            >
              {SCHEDULE_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {form.schedulePreset === "custom" && (
            <label>
              Cron expression
              <input
                placeholder="0 */6 * * *"
                value={form.schedule}
                onChange={(e) => setForm({ ...form, schedule: e.target.value })}
              />
            </label>
          )}
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
            Host
            <select
              value={editForm.hostId}
              onChange={(e) => setEditForm({ ...editForm, hostId: e.target.value })}
              disabled
            >
              <option value={GLOBAL_HOST_ID}>Global (all hosts)</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.hostname}
                </option>
              ))}
            </select>
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
            Excludes (comma-separated)
            <input
              placeholder="*.log, cache/, .git"
              value={editForm.excludes}
              onChange={(e) => setEditForm({ ...editForm, excludes: e.target.value })}
            />
          </label>
          <label>
            Schedule
            <select
              value={editForm.schedulePreset}
              onChange={(e) => updateSchedule(setEditForm, e.target.value)}
            >
              {SCHEDULE_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {editForm.schedulePreset === "custom" && (
            <label>
              Cron expression
              <input
                value={editForm.schedule}
                onChange={(e) => setEditForm({ ...editForm, schedule: e.target.value })}
              />
            </label>
          )}
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
            <th>Excludes</th>
            <th>Schedule</th>
            <th>Last sync</th>
            <th>Uploader</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {!items ? (
            <tr className="empty-row">
              <td colSpan={8}>Loading…</td>
            </tr>
          ) : items.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={8}>No manifests yet</td>
            </tr>
          ) : (
            items.map((m) => (
              <tr key={m.id}>
                <td>{m.appName}</td>
                <td className="muted">{hostLabel(m.hostId)}</td>
                <td className="muted">{m.paths.join(", ")}</td>
                <td className="muted">{(m.excludes ?? []).join(", ") || "—"}</td>
                <td className="muted">{m.schedule ?? "—"}</td>
                <td className="muted">
                  {m.lastSyncAt ? new Date(m.lastSyncAt).toLocaleString() : "—"}
                  {m.lastSyncDirection ? (
                    <span className={`badge badge-${m.lastSyncDirection}`}>{m.lastSyncDirection}</span>
                  ) : null}
                </td>
                <td className="muted">{hostLabel(m.originalUploaderHostId ?? "") || "—"}</td>
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
