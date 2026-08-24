// LAMA-263 — App presets gallery.
//
// A page of curated apps. For each app the user can: open the install/docs
// link, back its appdata up as an app-settings backup on a chosen device
// (reusing the existing dotfile-manifest model — no new server verbs), and
// see which devices already back it up. Restore is handled on the App
// settings page (it already downloads app-settings versions).

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { DotfileManifest, Host } from "@lamasync/core";
import { api, errorText } from "../api.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { Modal } from "../components/Modal.tsx";
import {
  APP_PRESETS,
  detectOs,
  pathsForOs,
  type AppPreset,
  type OSKey,
} from "../presets.ts";

interface BackupDraft {
  preset: AppPreset;
  hostId: string;
  paths: string;
}

export function Presets() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [manifests, setManifests] = useState<DotfileManifest[]>([]);
  const [os, setOs] = useState<OSKey>(detectOs());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<BackupDraft | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const [hostList, manifestList] = await Promise.all([
        api.listHosts(),
        api.listManifests(),
      ]);
      setHosts(hostList);
      setManifests(manifestList);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Map appName -> hostIds that already back it up (excluding the global
  // "_global" pseudo-host, which is a template, not a real device).
  const devicesByApp = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const m of manifests) {
      if (m.hostId === "_global") continue;
      const list = map.get(m.appName) ?? [];
      if (!list.includes(m.hostId)) list.push(m.hostId);
      map.set(m.appName, list);
    }
    return map;
  }, [manifests]);

  function hostnameFor(hostId: string): string {
    return hosts.find((h) => h.id === hostId)?.hostname ?? hostId;
  }

  function beginBackup(preset: AppPreset): void {
    setDraft({
      preset,
      hostId: hosts[0]?.id ?? "",
      paths: pathsForOs(preset, os).join("\n"),
    });
  }

  async function confirmBackup(): Promise<void> {
    if (!draft) return;
    const paths = draft.paths
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (draft.hostId.length === 0) {
      setError("Pick a device to back this app up on.");
      return;
    }
    if (paths.length === 0) {
      setError("Add at least one path to back up.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createManifest({
        appName: draft.preset.name,
        hostId: draft.hostId,
        paths,
        instructions: `Backed up from the ${draft.preset.name} preset.`,
      });
      setDraft(null);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section">
      <PageHeader
        title="App presets"
        purpose="Back up an app's settings in one click. Pick an app, choose a device, and LamaSync stores its appdata as an app-settings backup."
      />

      {error ? <div className="error">{error}</div> : null}

      {loading ? (
        <div className="empty-row" aria-busy="true">
          <div className="skel skel-line" />
        </div>
      ) : (
        <div className="fleet-grid">
          {APP_PRESETS.map((preset) => {
            const deviceIds = devicesByApp.get(preset.name) ?? [];
            return (
              <div className="fleet-card preset-card" key={preset.id}>
                <div className="fleet-card-head">
                  <strong>{preset.name}</strong>
                </div>
                <p className="muted preset-blurb">{preset.blurb}</p>

                {deviceIds.length > 0 ? (
                  <div className="preset-devices">
                    <span className="badge badge-online">
                      {deviceIds.length} device{deviceIds.length === 1 ? "" : "s"}
                    </span>
                    <span className="muted">
                      {deviceIds.map(hostnameFor).join(", ")}
                    </span>
                  </div>
                ) : (
                  <span className="muted">Not backed up yet</span>
                )}

                <div className="preset-actions">
                  <a
                    className="action"
                    href={preset.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Install
                  </a>
                  <button
                    type="button"
                    className="action primary"
                    disabled={hosts.length === 0}
                    title={
                      hosts.length === 0
                        ? "Register a device first"
                        : `Back up ${preset.name} on a device`
                    }
                    onClick={() => beginBackup(preset)}
                  >
                    Backup
                  </button>
                  <Link className="action" to="/dotfiles">
                    Manage
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {hosts.length === 0 && !loading ? (
        <p className="muted preset-hint">
          Register a device on the <Link to="/hosts">Devices</Link> page before
          backing up an app.
        </p>
      ) : null}

      {draft ? (
        <Modal
          title={`Back up ${draft.preset.name}`}
          onClose={() => setDraft(null)}
          footer={
            <>
              <button
                type="button"
                className="action"
                onClick={() => setDraft(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="action primary"
                disabled={busy}
                onClick={() => void confirmBackup()}
              >
                {busy ? "Backing up…" : "Back up"}
              </button>
            </>
          }
        >
          <label className="field">
            <span>Device</span>
            <select
              value={draft.hostId}
              onChange={(e) =>
                setDraft({ ...draft, hostId: e.target.value })
              }
            >
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.hostname}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Paths to back up (one per line)</span>
            <textarea
              rows={6}
              value={draft.paths}
              onChange={(e) => setDraft({ ...draft, paths: e.target.value })}
            />
          </label>
          <p className="muted">
            These paths are backed up as an app-settings backup for{" "}
            {draft.preset.name}. Restore them anytime from the{" "}
            <Link to="/dotfiles">App settings</Link> page.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
