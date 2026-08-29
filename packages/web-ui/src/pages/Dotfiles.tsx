import { Fragment, useEffect, useRef, useState } from "react";
import { PageHeader } from "../components/PageHeader.tsx";
import type { AppProfile, DotfileManifest, DotfileVersion, Host } from "@lamasync/core";
import { api } from "../api.ts";
import { HintText } from "../components/Hint.tsx";
import { ConfirmDialog, Modal } from "../components/Modal.tsx";
import { MISC_HINTS } from "../concepts.ts";
// LAMA-267: shared presets (single source of truth for labels) and the
// client-side "Next: …" sentence helper.
import { SCHEDULE_PRESETS, schedulePresetForCron } from "../schedule-presets.ts";
import { nextRunSentence } from "../next-run.ts";

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

interface SaveProfileDraft {
  name: string;
  description: string;
  emoji: string;
  color: string;
  linuxPaths: string;
  macosPaths: string;
  windowsPaths: string;
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

/** Human-readable byte count for the version Size column. */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = "B";
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

type Scope =
  | { kind: "all" }
  | { kind: "global" }
  | { kind: "host"; hostId: string };

function scopeKey(s: Scope): string {
  if (s.kind === "all") return "__all__";
  if (s.kind === "global") return "__global__";
  // LAMA-225 P1-8: the <select> options use bare hostId values (see
  // below), so scopeKey() must return the same string — otherwise the
  // control snaps back to "All hosts" while the table shows host data.
  return s.hostId;
}

export function Dotfiles() {
  const [items, setItems] = useState<DotfileManifest[] | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ManifestForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<ManifestForm>(EMPTY_FORM);
  // LAMA-198: expandable per-app version rows (lazy fetch). Expansion keys on
  // the manifest id — two manifests can share an appName (global + host
  // override) and must expand independently; the version cache itself stays
  // keyed by appName since the tarball store is per-app.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, DotfileVersion[]>>({});
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [deletingManifestId, setDeletingManifestId] = useState<string | null>(null);
  const [deletingVersion, setDeletingVersion] = useState<{ appName: string; version: DotfileVersion } | null>(null);
  const [profileSaveTarget, setProfileSaveTarget] = useState<DotfileManifest | null>(null);
  const [profileSaveDraft, setProfileSaveDraft] = useState<SaveProfileDraft | null>(null);
  const [profileSaveBusy, setProfileSaveBusy] = useState(false);

  async function refresh(currentScope: Scope, requestId: number) {
    // LAMA-225 P1-8: a request-counter guard ignores stale responses.
    // Rapid scope changes used to race: the "All hosts" fetch could
    // resolve AFTER a host-scoped fetch and overwrite the host view.
    // Compare against the live ref AFTER each await — a render-time
    // snapshot goes stale the moment any request increments it.
    setError(null);
    try {
      // Always need the host list for the scope dropdown and the table's
      // HOST column (even when filtering to a single host, we want the
      // rest of the dropdown populated).
      const hostsResp = await api.listHosts();
      if (requestId !== refreshCounterRef.current) return;
      setHosts(hostsResp);

      let list: DotfileManifest[];
      if (currentScope.kind === "global") {
        list = await api.listManifests();
      } else if (currentScope.kind === "host") {
        list = await api.listManifests(currentScope.hostId);
      } else {
        // Aggregate global manifests + each known host's manifests.
        // Dedupe by manifest id (host rows override global rows with the
        // same (hostId, appName)). Sorting by appName then hostId makes
        // the fleet view stable.
        const aggregated = new Map<string, DotfileManifest>();
        try {
          const globals = await api.listManifests();
          for (const m of globals) aggregated.set(m.id, m);
        } catch {
          // Tolerate global-list failure — fall through to per-host fetch.
        }
        for (const h of hostsResp) {
          try {
            const perHost = await api.listManifests(h.id);
            for (const m of perHost) aggregated.set(m.id, m);
          } catch {
            // Skip hosts we can't read; show what we have.
          }
        }
        list = Array.from(aggregated.values()).sort((a, b) => {
          const app = a.appName.localeCompare(b.appName);
          if (app !== 0) return app;
          return a.hostId.localeCompare(b.hostId);
        });
      }
      if (requestId !== refreshCounterRef.current) return;
      setItems(list);
    } catch (err) {
      if (requestId !== refreshCounterRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // LAMA-225 P1-8: monotonic request id; refresh() drops resolves whose
  // id is no longer current. Lets rapid scope changes cancel in-flight
  // fetches without aborting the underlying Promise (which would leak
  // listeners).
  const refreshCounterRef = useRef(0);

  useEffect(() => {
    const requestId = ++refreshCounterRef.current;
    void refresh(scope, requestId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

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
      await refresh(scope, ++refreshCounterRef.current);
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
      await refresh(scope, ++refreshCounterRef.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function onDelete(id: string) {
    setDeletingManifestId(id);
  }

  async function confirmDeleteManifest(): Promise<void> {
    if (!deletingManifestId) return;
    const id = deletingManifestId;
    setDeletingManifestId(null);
    setBusy(true);
    try {
      await api.deleteManifest(id);
      await refresh(scope, ++refreshCounterRef.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // LAMA-198: expand/collapse the version list for a manifest row. The
  // version list is fetched lazily on first expand.
  async function toggleVersions(m: DotfileManifest) {
    if (expandedId === m.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(m.id);
    if (versions[m.appName] === undefined) {
      setVersionsLoading(true);
      setError(null);
      try {
        const list = await api.listDotfileVersions(m.appName);
        setVersions((prev) => ({ ...prev, [m.appName]: list }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setVersionsLoading(false);
      }
    }
  }

  async function onDownloadVersion(appName: string, version: DotfileVersion) {
    setError(null);
    try {
      await api.downloadDotfileVersion(appName, version.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function onDeleteVersion(appName: string, version: DotfileVersion) {
    setDeletingVersion({ appName, version });
  }

  async function confirmDeleteVersion(): Promise<void> {
    if (!deletingVersion) return;
    const { appName, version } = deletingVersion;
    setDeletingVersion(null);
    setBusy(true);
    setError(null);
    try {
      await api.deleteDotfileVersion(appName, version.id);
      const list = await api.listDotfileVersions(appName);
      setVersions((prev) => ({ ...prev, [appName]: list }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function updateSchedule(
    formUpdater: (updater: (current: ManifestForm) => ManifestForm) => void,
    value: string,
  ) {
    const preset = SCHEDULE_PRESETS.find((p) => p.value === value);
    if (preset && value !== "custom") {
      formUpdater((current) => ({ ...current, schedulePreset: value, schedule: preset.cron }));
    } else {
      formUpdater((current) => ({ ...current, schedulePreset: "custom", schedule: "" }));
    }
  }

  function hostLabel(hostId: string): string {
    if (hostId === GLOBAL_HOST_ID) return "All devices";
    const host = hosts.find((h) => h.id === hostId);
    return host?.hostname ?? hostId;
  }

  function hostOs(hostId: string): keyof AppProfile["paths"] {
    const host = hosts.find((item) => item.id === hostId);
    const value = (host?.os ?? "").toLowerCase();
    if (value.includes("darwin") || value.includes("mac")) return "macos";
    if (value.includes("win")) return "windows";
    return "linux";
  }

  function beginSaveAsProfile(manifest: DotfileManifest): void {
    const os = hostOs(manifest.hostId);
    const paths = manifest.paths.join("\n");
    setProfileSaveTarget(manifest);
    setProfileSaveDraft({
      name: manifest.appName,
      description: `Reusable profile for ${manifest.appName}.`,
      emoji: "🧩",
      color: "#5dd6c0",
      linuxPaths: os === "linux" ? paths : "",
      macosPaths: os === "macos" ? paths : "",
      windowsPaths: os === "windows" ? paths : "",
    });
  }

  async function saveAsProfile(): Promise<void> {
    if (!profileSaveDraft || !profileSaveTarget) return;
    const lines = (value: string): string[] => value.split("\n").map((path) => path.trim()).filter((path) => path.length > 0);
    const payload: Omit<AppProfile, "id" | "createdAt" | "updatedAt"> = {
      name: profileSaveDraft.name.trim(),
      description: profileSaveDraft.description.trim() || null,
      emoji: profileSaveDraft.emoji.trim() || null,
      color: profileSaveDraft.color.trim() || null,
      paths: {
        linux: lines(profileSaveDraft.linuxPaths),
        macos: lines(profileSaveDraft.macosPaths),
        windows: lines(profileSaveDraft.windowsPaths),
      },
      installUrl: null,
      installInstructions: null,
      restoreInstructions: profileSaveTarget.instructions,
    };
    if (payload.name.length === 0 || Object.values(payload.paths).every((paths) => paths.length === 0)) {
      setError("Give the profile a name and add at least one path.");
      return;
    }
    setProfileSaveBusy(true);
    setError(null);
    try {
      const created = await api.createAppProfile(payload);
      await api.updateManifest(profileSaveTarget.id, { profileId: created.id });
      setProfileSaveTarget(null);
      setProfileSaveDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProfileSaveBusy(false);
    }
  }

  return (
    <div className="page">
      <PageHeader title="App settings" purpose="Back up application settings on this device and restore them on another." />
<div className="toolbar">
        <label className="scope-filter">
          Scope
          <select
            value={scopeKey(scope)}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__all__") setScope({ kind: "all" });
              else if (v === "__global__") setScope({ kind: "global" });
              else setScope({ kind: "host", hostId: v });
            }}
          >
            <option value="__all__">All devices</option>
            <option value="__global__">Global only</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.hostname}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="action primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "New app backup"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <HintText>
        {MISC_HINTS.dotfileManifest} {MISC_HINTS.dotfileOverride}
      </HintText>
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
            Device
            <select
              value={form.hostId}
              onChange={(e) => setForm({ ...form, hostId: e.target.value })}
            >
              <option value={GLOBAL_HOST_ID}>All devices (default)</option>
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
            {/* LAMA-267: plain-sentence preview of the next fire. */}
            {nextRunSentence(form.schedule) && (
              <span className="muted next-run">{nextRunSentence(form.schedule)}</span>
            )}
          </label>
          {/* LAMA-267: the raw cron input hides behind a reveal toggle and
              only auto-opens when the selected preset is "Custom". */}
          <details
            className="schedule-custom-reveal"
            open={form.schedulePreset === "custom"}
          >
            <summary>Advanced: custom cron</summary>
            <label>
              Cron expression
              <input
                placeholder="0 */6 * * *"
                value={form.schedule}
                onChange={(e) => setForm({ ...form, schedule: e.target.value })}
              />
            </label>
          </details>
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
            Device
            <select
              value={editForm.hostId}
              onChange={(e) => setEditForm({ ...editForm, hostId: e.target.value })}
              disabled
            >
              <option value={GLOBAL_HOST_ID}>All devices (default)</option>
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
            {/* LAMA-267: plain-sentence preview of the next fire. */}
            {nextRunSentence(editForm.schedule) && (
              <span className="muted next-run">
                {nextRunSentence(editForm.schedule)}
              </span>
            )}
          </label>
          {/* LAMA-267: the raw cron input hides behind a reveal toggle and
              only auto-opens when the selected preset is "Custom". */}
          <details
            className="schedule-custom-reveal"
            open={editForm.schedulePreset === "custom"}
          >
            <summary>Advanced: custom cron</summary>
            <label>
              Cron expression
              <input
                value={editForm.schedule}
                onChange={(e) => setEditForm({ ...editForm, schedule: e.target.value })}
              />
            </label>
          </details>
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
            <tr aria-busy="true">
              <td colSpan={8}><div className="skel skel-line" /></td>
            </tr>
          ) : items.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={8}>
                {scope.kind === "all"
                  ? "No app backups yet — an entry decides which app's settings get backed up, and where. Restoring runs from the TUI."
                  : scope.kind === "global"
                    ? "No global manifests yet"
                    : `No app backups for ${hostLabel(scope.hostId)} yet`}
              </td>
            </tr>
          ) : (
            items.map((m) => {
              const expanded = expandedId === m.id;
              const appVersions = versions[m.appName] ?? null;
              return (
                <Fragment key={m.id}>
                  <tr>
                    <td>{m.appName}</td>
                    <td className="muted">{hostLabel(m.hostId)}</td>
                    <td className="muted">{m.paths.join(", ")}</td>
                    <td className="muted">{(m.excludes ?? []).join(", ") || "—"}</td>
                    {/* LAMA-267: human sentence instead of raw cron; the raw
                        expression stays available as a hover tooltip. */}
                    <td className="muted">
                      {m.schedule ? (
                        <span className="next-run" title={m.schedule}>
                          {nextRunSentence(m.schedule) ?? "—"}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
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
                        onClick={() => void toggleVersions(m)}
                        disabled={versionsLoading}
                      >
                        {expanded ? "Hide versions" : "Versions"}
                      </button>
                      <button
                        type="button"
                        className="action"
                        onClick={() => beginSaveAsProfile(m)}
                        disabled={busy}
                      >
                        Save as profile
                      </button>
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
                  {expanded && (
                    <tr className="dotfile-versions-row">
                      <td colSpan={8}>
                        <h3 className="form-title">Versions — {m.appName}</h3>
                        {appVersions === null ? (
                          <span className="skel skel-line" aria-busy="true" />
                        ) : appVersions.length === 0 ? (
                          <span className="muted">
                            No versions yet — tarballs land here when the daemon backs up this
                            app.
                          </span>
                        ) : (
                          <table className="data">
                            <thead>
                              <tr>
                                <th>Version</th>
                                <th>Created</th>
                                <th>Size</th>
                                <th>Description</th>
                                <th />
                              </tr>
                            </thead>
                            <tbody>
                              {appVersions.map((v) => (
                                <tr key={v.id}>
                                  <td><code>{v.id.slice(0, 8)}</code></td>
                                  <td className="muted">{new Date(v.timestamp).toLocaleString()}</td>
                                  <td className="muted">{formatBytes(v.sizeBytes)}</td>
                                  <td className="muted">{v.description ?? "—"}</td>
                                  <td className="table-actions">
                                    <button
                                      type="button"
                                      className="action"
                                      onClick={() => void onDownloadVersion(m.appName, v)}
                                      disabled={busy}
                                    >
                                      Download
                                    </button>
                                    <button
                                      type="button"
                                      className="action danger"
                                      onClick={() => void onDeleteVersion(m.appName, v)}
                                      disabled={busy}
                                    >
                                      Delete
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        <p className="muted">
                          Selective restore lives in the TUI — run{" "}
                          <code>lamasync tui</code> → Dotfiles.
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })
          )}
        </tbody>
      </table>

      {deletingManifestId && (
        <ConfirmDialog
          title="Delete app backup"
          danger
          confirmLabel="Delete"
          message="Delete this app backup and all its saved versions?"
          onConfirm={() => void confirmDeleteManifest()}
          onCancel={() => setDeletingManifestId(null)}
        />
      )}

      {deletingVersion && (
        <ConfirmDialog
          title="Delete saved version"
          danger
          confirmLabel="Delete"
          message={`Delete dotfile version ${deletingVersion.version.id.slice(0, 8)}?`}
          onConfirm={() => void confirmDeleteVersion()}
          onCancel={() => setDeletingVersion(null)}
        />
      )}

      {profileSaveTarget && profileSaveDraft ? (
        <Modal
          title={`Save ${profileSaveTarget.appName} as a profile`}
          onClose={() => { setProfileSaveTarget(null); setProfileSaveDraft(null); }}
          footer={
            <>
              <button type="button" className="action" onClick={() => { setProfileSaveTarget(null); setProfileSaveDraft(null); }}>Cancel</button>
              <button type="button" className="action primary" disabled={profileSaveBusy} onClick={() => void saveAsProfile()}>{profileSaveBusy ? "Saving…" : "Save profile"}</button>
            </>
          }
        >
          <p className="muted">Turn this backup into a reusable template. You can add paths for other operating systems later from App profiles.</p>
          <label className="field"><span>Name</span><input value={profileSaveDraft.name} onChange={(e) => setProfileSaveDraft({ ...profileSaveDraft, name: e.target.value })} /></label>
          <div className="profile-identity-fields">
            <label className="field"><span>Emoji</span><input value={profileSaveDraft.emoji} maxLength={8} onChange={(e) => setProfileSaveDraft({ ...profileSaveDraft, emoji: e.target.value })} /></label>
            <label className="field"><span>Color</span><input type="color" value={profileSaveDraft.color} onChange={(e) => setProfileSaveDraft({ ...profileSaveDraft, color: e.target.value })} /></label>
          </div>
          <label className="field"><span>Description</span><input value={profileSaveDraft.description} onChange={(e) => setProfileSaveDraft({ ...profileSaveDraft, description: e.target.value })} /></label>
          <div className="profile-path-grid">
            <label className="field"><span>Linux paths</span><textarea rows={4} value={profileSaveDraft.linuxPaths} onChange={(e) => setProfileSaveDraft({ ...profileSaveDraft, linuxPaths: e.target.value })} /></label>
            <label className="field"><span>macOS paths</span><textarea rows={4} value={profileSaveDraft.macosPaths} onChange={(e) => setProfileSaveDraft({ ...profileSaveDraft, macosPaths: e.target.value })} /></label>
            <label className="field"><span>Windows paths</span><textarea rows={4} value={profileSaveDraft.windowsPaths} onChange={(e) => setProfileSaveDraft({ ...profileSaveDraft, windowsPaths: e.target.value })} /></label>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
