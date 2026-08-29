// LAMA-291 — reusable app profiles layered over app-settings manifests.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { AppProfile, DotfileManifest, Host } from "@lamasync/core";
import { api, errorText } from "../api.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { Modal } from "../components/Modal.tsx";
import { Confetti, useMilestoneConfetti } from "../components/Confetti.tsx";
import { APP_PRESETS, type AppPreset, type OSKey } from "../presets.ts";

interface ProfileCard {
  id: string;
  name: string;
  description: string;
  emoji: string;
  color: string;
  paths: AppProfile["paths"];
  installUrl: string | null;
  installInstructions: string | null;
  restoreInstructions: string | null;
  starter: boolean;
}

interface BackupDraft {
  profile: ProfileCard;
  hostId: string;
  os: OSKey;
  paths: string;
  backupName: string;
}

interface ProfileDraft {
  id: string | null;
  name: string;
  description: string;
  emoji: string;
  color: string;
  linuxPaths: string;
  macosPaths: string;
  windowsPaths: string;
  installUrl: string;
  installInstructions: string;
  restoreInstructions: string;
}

const EMPTY_PROFILE: ProfileDraft = {
  id: null,
  name: "",
  description: "",
  emoji: "🧩",
  color: "#5dd6c0",
  linuxPaths: "",
  macosPaths: "",
  windowsPaths: "",
  installUrl: "",
  installInstructions: "",
  restoreInstructions: "",
};

function pathsForProfile(paths: AppProfile["paths"], os: OSKey): string[] {
  return paths[os] ?? paths.linux ?? paths.macos ?? paths.windows ?? [];
}

function profileDraftFrom(profile: ProfileCard): ProfileDraft {
  return {
    id: profile.starter ? null : profile.id,
    name: profile.name,
    description: profile.description,
    emoji: profile.emoji,
    color: profile.color,
    linuxPaths: (profile.paths.linux ?? []).join("\n"),
    macosPaths: (profile.paths.macos ?? []).join("\n"),
    windowsPaths: (profile.paths.windows ?? []).join("\n"),
    installUrl: profile.installUrl ?? "",
    installInstructions: profile.installInstructions ?? "",
    restoreInstructions: profile.restoreInstructions ?? "",
  };
}

function profilePayload(draft: ProfileDraft): Omit<AppProfile, "id" | "createdAt" | "updatedAt"> {
  const lines = (value: string): string[] => value.split("\n").map((part) => part.trim()).filter((part) => part.length > 0);
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    emoji: draft.emoji.trim() || null,
    color: draft.color.trim() || null,
    paths: {
      linux: lines(draft.linuxPaths),
      macos: lines(draft.macosPaths),
      windows: lines(draft.windowsPaths),
    },
    installUrl: draft.installUrl.trim() || null,
    installInstructions: draft.installInstructions.trim() || null,
    restoreInstructions: draft.restoreInstructions.trim() || null,
  };
}

function cardFromProfile(profile: AppProfile): ProfileCard {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description ?? "A reusable app-settings profile.",
    emoji: profile.emoji ?? "🧩",
    color: profile.color ?? "#5dd6c0",
    paths: profile.paths,
    installUrl: profile.installUrl ?? null,
    installInstructions: profile.installInstructions ?? null,
    restoreInstructions: profile.restoreInstructions ?? null,
    starter: false,
  };
}

function cardFromStarter(preset: AppPreset): ProfileCard {
  const emojiById: Record<string, string> = {
    vscode: "⌘",
    neovim: "✦",
    zsh: "〰",
    firefox: "◉",
    git: "⎇",
  };
  return {
    id: `starter:${preset.id}`,
    name: preset.name,
    description: preset.blurb,
    emoji: emojiById[preset.id] ?? "▦",
    color: "#5dd6c0",
    paths: preset.paths,
    installUrl: preset.docsUrl,
    installInstructions: null,
    restoreInstructions: null,
    starter: true,
  };
}

function hostOs(host: Host | undefined): OSKey {
  const label = (host?.os ?? "").toLowerCase();
  if (label.includes("darwin") || label.includes("mac")) return "macos";
  if (label.includes("win")) return "windows";
  return "linux";
}

function ProfileCardView({
  profile,
  deviceIds,
  hostnameFor,
  onApply,
  onCustomize,
  onDelete,
}: {
  profile: ProfileCard;
  deviceIds: string[];
  hostnameFor: (hostId: string) => string;
  onApply: (profile: ProfileCard) => void;
  onCustomize: (profile: ProfileCard) => void;
  onDelete: (profile: ProfileCard) => void;
}) {
  return (
    <div className="fleet-card preset-card" style={{ borderTopColor: profile.color }}>
      <div className="fleet-card-head">
        <strong><span className="preset-emoji" aria-hidden="true">{profile.emoji}</span> {profile.name}</strong>
        <span className="badge">{profile.starter ? "Starter" : "Yours"}</span>
      </div>
      <p className="muted preset-blurb">{profile.description}</p>
      {deviceIds.length > 0 ? (
        <div className="preset-devices">
          <span className="badge badge-online">{deviceIds.length} device{deviceIds.length === 1 ? "" : "s"}</span>
          <span className="muted">{deviceIds.map(hostnameFor).join(", ")}</span>
        </div>
      ) : <span className="muted">Not backed up yet</span>}
      <div className="preset-actions">
        {profile.installUrl ? <a className="action" href={profile.installUrl} target="_blank" rel="noopener noreferrer">Install</a> : null}
        <button type="button" className="action primary" onClick={() => onApply(profile)}>Apply to device</button>
        <Link className="action" to="/dotfiles">Manage</Link>
        <button type="button" className="action" onClick={() => onCustomize(profile)}>{profile.starter ? "Customize" : "Edit"}</button>
        {!profile.starter ? <button type="button" className="action danger" onClick={() => onDelete(profile)}>Delete</button> : null}
      </div>
    </div>
  );
}

function ProfileEditor({
  draft,
  busy,
  onChange,
  onSave,
  onClose,
}: {
  draft: ProfileDraft;
  busy: boolean;
  onChange: (draft: ProfileDraft) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={draft.id ? "Edit app profile" : "Create app profile"}
      onClose={onClose}
      footer={<><button type="button" className="action" onClick={onClose}>Cancel</button><button type="button" className="action primary" disabled={busy} onClick={onSave}>{busy ? "Saving…" : "Save profile"}</button></>}
    >
      <div className="profile-identity-fields">
        <label className="field"><span>Name</span><input required value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} /></label>
        <label className="field"><span>Emoji</span><input value={draft.emoji} maxLength={8} onChange={(e) => onChange({ ...draft, emoji: e.target.value })} /></label>
        <label className="field"><span>Color</span><input type="color" value={draft.color || "#5dd6c0"} onChange={(e) => onChange({ ...draft, color: e.target.value })} /></label>
      </div>
      <label className="field"><span>Description</span><input value={draft.description} onChange={(e) => onChange({ ...draft, description: e.target.value })} /></label>
      <div className="profile-path-grid">
        <label className="field"><span>Linux paths</span><textarea rows={4} placeholder="One path per line" value={draft.linuxPaths} onChange={(e) => onChange({ ...draft, linuxPaths: e.target.value })} /></label>
        <label className="field"><span>macOS paths</span><textarea rows={4} placeholder="One path per line" value={draft.macosPaths} onChange={(e) => onChange({ ...draft, macosPaths: e.target.value })} /></label>
        <label className="field"><span>Windows paths</span><textarea rows={4} placeholder="One path per line" value={draft.windowsPaths} onChange={(e) => onChange({ ...draft, windowsPaths: e.target.value })} /></label>
      </div>
      <label className="field"><span>Install or documentation URL (optional)</span><input type="url" value={draft.installUrl} onChange={(e) => onChange({ ...draft, installUrl: e.target.value })} /></label>
      <label className="field"><span>Install notes (optional)</span><textarea rows={2} value={draft.installInstructions} onChange={(e) => onChange({ ...draft, installInstructions: e.target.value })} /></label>
      <label className="field"><span>Restore notes (optional)</span><textarea rows={2} value={draft.restoreInstructions} onChange={(e) => onChange({ ...draft, restoreInstructions: e.target.value })} /></label>
    </Modal>
  );
}

export function Presets() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [manifests, setManifests] = useState<DotfileManifest[]>([]);
  const [profiles, setProfiles] = useState<AppProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<BackupDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [collision, setCollision] = useState<DotfileManifest | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProfileCard | null>(null);
  const { fire: fireFirstPresetBackup, visible: showPresetConfetti } = useMilestoneConfetti("first-preset-backup");

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const hostList = await api.listHosts();
      const [globalManifests, profileList] = await Promise.all([api.listManifests(), api.listAppProfiles()]);
      const perHostLists = await Promise.all(hostList.map((host) => api.listManifests(host.id)));
      const byId = new Map<string, DotfileManifest>();
      for (const manifest of globalManifests) byId.set(manifest.id, manifest);
      for (const list of perHostLists) for (const manifest of list) byId.set(manifest.id, manifest);
      setHosts(hostList);
      setManifests(Array.from(byId.values()));
      setProfiles(profileList);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const devicesByApp = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const manifest of manifests) {
      if (manifest.hostId === "_global") continue;
      const list = map.get(manifest.appName) ?? [];
      if (!list.includes(manifest.hostId)) list.push(manifest.hostId);
      map.set(manifest.appName, list);
    }
    return map;
  }, [manifests]);

  const devicesByProfile = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const manifest of manifests) {
      if (manifest.hostId === "_global" || !manifest.profileId) continue;
      const list = map.get(manifest.profileId) ?? [];
      if (!list.includes(manifest.hostId)) list.push(manifest.hostId);
      map.set(manifest.profileId, list);
    }
    return map;
  }, [manifests]);

  const cards = useMemo(() => [...APP_PRESETS.map(cardFromStarter), ...profiles.map(cardFromProfile)], [profiles]);

  function hostnameFor(hostId: string): string {
    return hosts.find((host) => host.id === hostId)?.hostname ?? hostId;
  }

  function beginBackup(profile: ProfileCard): void {
    const host = hosts[0];
    if (!host) {
      setError("Register a device before applying a profile.");
      return;
    }
    const selectedOs = hostOs(host);
    setDraft({ profile, hostId: host.id, os: selectedOs, paths: pathsForProfile(profile.paths, selectedOs).join("\n"), backupName: profile.name });
  }

  function beginCustomize(profile: ProfileCard): void {
    setProfileDraft(profileDraftFrom(profile));
  }

  async function saveProfile(): Promise<void> {
    if (!profileDraft) return;
    const payload = profilePayload(profileDraft);
    if (payload.name.length === 0) {
      setError("Give the app profile a name.");
      return;
    }
    if (Object.values(payload.paths).every((paths) => paths.length === 0)) {
      setError("Add at least one path on one operating system.");
      return;
    }
    setProfileBusy(true);
    setError(null);
    try {
      if (profileDraft.id) await api.updateAppProfile(profileDraft.id, payload);
      else await api.createAppProfile(payload);
      setProfileDraft(null);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setProfileBusy(false);
    }
  }

  async function deleteProfile(profile: ProfileCard): Promise<void> {
    if (profile.starter) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAppProfile(profile.id);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmBackup(forceExisting = false): Promise<void> {
    if (!draft) return;
    const paths = draft.paths.split("\n").map((path) => path.trim()).filter((path) => path.length > 0);
    if (draft.hostId.length === 0) {
      setError("Pick a device to apply this profile on.");
      return;
    }
    if (draft.backupName.trim().length === 0) {
      setError("Give this app-settings backup a name.");
      return;
    }
    if (paths.length === 0) {
      setError("Add at least one path to back up.");
      return;
    }
    const existing = manifests.find((manifest) => manifest.hostId === draft.hostId && manifest.appName === draft.backupName.trim());
    if (existing && !forceExisting) {
      setCollision(existing);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const values = {
        paths,
        instructions: draft.profile.restoreInstructions ?? draft.profile.installInstructions ?? null,
        profileId: draft.profile.starter ? null : draft.profile.id,
      };
      if (existing) await api.updateManifest(existing.id, values);
      else await api.createManifest({ appName: draft.backupName.trim(), hostId: draft.hostId, ...values });
      setDraft(null);
      setCollision(null);
      await refresh();
      fireFirstPresetBackup();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section">
      <PageHeader title="App profiles" purpose="Reuse app-settings paths across devices with starter templates or profiles you define." />
      {showPresetConfetti ? <Confetti fallback={<span>✓ Nice work — first app-settings backup created.</span>} /> : null}
      {error ? <div className="error">{error}</div> : null}
      {loading ? <div className="empty-row" aria-busy="true"><div className="skel skel-line" /></div> : (
        <>
          <div className="preset-toolbar">
            <div><h2>Starter profiles</h2><p className="muted">Curated templates you can apply or customize.</p></div>
            <button type="button" className="action primary" onClick={() => setProfileDraft({ ...EMPTY_PROFILE })}>Create profile</button>
          </div>
          <div className="fleet-grid">
            {cards.filter((profile) => profile.starter).map((profile) => <ProfileCardView key={profile.id} profile={profile} deviceIds={devicesByApp.get(profile.name) ?? []} hostnameFor={hostnameFor} onApply={beginBackup} onCustomize={beginCustomize} onDelete={() => undefined} />)}
          </div>
          <div className="preset-toolbar preset-toolbar-my"><div><h2>My profiles</h2><p className="muted">Reusable app-settings templates you own and can update explicitly.</p></div></div>
          {profiles.length === 0 ? <p className="muted preset-empty">No personal profiles yet. Create one here or use “Save as profile” from an existing app backup.</p> : null}
          <div className="fleet-grid">
            {cards.filter((profile) => !profile.starter).map((profile) => <ProfileCardView key={profile.id} profile={profile} deviceIds={devicesByProfile.get(profile.id) ?? []} hostnameFor={hostnameFor} onApply={beginBackup} onCustomize={beginCustomize} onDelete={setDeleteTarget} />)}
          </div>
        </>
      )}
      {hosts.length === 0 && !loading ? <p className="muted preset-hint">Register a device on the <Link to="/hosts">Devices</Link> page before applying a profile.</p> : null}

      {draft ? <Modal title={`Apply ${draft.profile.emoji} ${draft.profile.name}`} onClose={() => setDraft(null)} footer={<><button type="button" className="action" onClick={() => setDraft(null)}>Cancel</button><button type="button" className="action primary" disabled={busy} onClick={() => void confirmBackup()}>{busy ? "Applying…" : "Apply profile"}</button></>}>
        <label className="field"><span>Device</span><select value={draft.hostId} onChange={(e) => { const nextHost = hosts.find((host) => host.id === e.target.value); const nextOs = hostOs(nextHost); setDraft({ ...draft, hostId: e.target.value, os: nextOs, paths: pathsForProfile(draft.profile.paths, nextOs).join("\n") }); }}>{hosts.map((host) => <option key={host.id} value={host.id}>{host.hostname}</option>)}</select></label>
        <label className="field"><span>Backup name</span><input value={draft.backupName} onChange={(e) => setDraft({ ...draft, backupName: e.target.value })} /></label>
        <label className="field"><span>Paths to back up (one per line)</span><textarea rows={6} value={draft.paths} onChange={(e) => setDraft({ ...draft, paths: e.target.value })} /></label>
        <p className="muted">This creates or updates an app-settings backup on one device. Existing backups are never overwritten silently.</p>
      </Modal> : null}

      {profileDraft ? <ProfileEditor draft={profileDraft} busy={profileBusy} onChange={setProfileDraft} onSave={() => void saveProfile()} onClose={() => setProfileDraft(null)} /> : null}

      {deleteTarget ? <Modal title={`Delete ${deleteTarget.name}?`} onClose={() => setDeleteTarget(null)} footer={<><button type="button" className="action" onClick={() => setDeleteTarget(null)}>Cancel</button><button type="button" className="action danger" disabled={busy} onClick={() => { const target = deleteTarget; setDeleteTarget(null); void deleteProfile(target); }}>Delete profile</button></>}><p className="muted">Existing app-settings backups stay safe. This only removes the reusable profile.</p></Modal> : null}

      {collision ? <Modal title="Backup already exists" onClose={() => setCollision(null)} footer={<><button type="button" className="action" onClick={() => { setCollision(null); window.location.hash = "#/dotfiles"; }}>Open existing</button><button type="button" className="action" onClick={() => { setCollision(null); setDraft((current) => current ? { ...current, backupName: `${current.backupName} copy` } : current); }}>Use different name</button><button type="button" className="action primary" disabled={busy} onClick={() => { setCollision(null); void confirmBackup(true); }}>Update from profile</button></>}><p className="muted">“{collision.appName}” already exists on this device. Choose whether to open it, create a differently named backup, or explicitly update it from this profile.</p></Modal> : null}
    </div>
  );
}
