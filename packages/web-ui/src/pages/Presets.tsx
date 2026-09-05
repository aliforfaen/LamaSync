// LAMA-316 — App templates page. Templates are operator-owned reusable
// capture recipes (paths per OS). A template never reaches a device on its
// own: enrolling it on a host creates an application protection, and
// snapshots are captured from that protection (see Dotfiles.tsx, the App
// backups page). Nothing on this page restores files.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type {
  ApplicationTemplate,
  CaptureSpec,
  CaptureSpecPath,
  Host,
} from "@lamasync/core";
import { api, errorText } from "../api.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { Modal } from "../components/Modal.tsx";
import { APP_PRESETS, type AppPreset } from "../presets.ts";
import { SCHEDULE_PRESETS } from "../schedule-presets.ts";

// ---------------------------------------------------------------------------
// Card model: a mix of built-in starters (not yet materialized server-side,
// id null) and saved templates (server rows). Starters become templates the
// first time they are enrolled, so enrollment always targets a real
// template id.
// ---------------------------------------------------------------------------

export interface TemplateCardData {
  id: string | null;
  origin: ApplicationTemplate["origin"];
  name: string;
  description: string;
  emoji: string;
  color: string;
  spec: CaptureSpec;
  installUrl: string | null;
  installInstructions: string | null;
  restoreInstructions: string | null;
  revision: number;
}

/** Editor state for create / edit / duplicate. */
interface TemplateDraft {
  id: string | null;
  name: string;
  description: string;
  emoji: string;
  color: string;
  linuxPaths: string;
  macosPaths: string;
  windowsPaths: string;
  excludes: string;
  notes: string;
  installUrl: string;
  installInstructions: string;
  restoreInstructions: string;
}

/** Enrollment dialog state. */
interface EnrollDraft {
  card: TemplateCardData;
  hostId: string;
  name: string;
  schedulePreset: string;
  schedule: string;
}

export type TemplateCreatePayload = Omit<
  ApplicationTemplate,
  "id" | "origin" | "revision" | "createdAt" | "updatedAt"
>;

const STARTER_EMOJI: Record<string, string> = {
  vscode: "⌘",
  neovim: "✦",
  zsh: "〰",
  firefox: "◉",
  git: "⎇",
  tmux: "▦",
};

const STARTER_COLOR = "#5dd6c0";

function toEntries(paths: string[] | undefined): CaptureSpecPath[] | undefined {
  return paths && paths.length > 0
    ? paths.map((path) => ({ path, classification: "unknown" as const }))
    : undefined;
}

function starterSpec(preset: AppPreset): CaptureSpec {
  return {
    paths: {
      linux: toEntries(preset.paths.linux),
      macos: toEntries(preset.paths.macos),
      windows: toEntries(preset.paths.windows),
    },
    excludes: [],
    notes: null,
  };
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function cardFromStarter(preset: AppPreset): TemplateCardData {
  return {
    id: null,
    origin: "built_in",
    name: preset.name,
    description: preset.blurb,
    emoji: STARTER_EMOJI[preset.id] ?? "▦",
    color: STARTER_COLOR,
    spec: starterSpec(preset),
    installUrl: preset.docsUrl,
    installInstructions: null,
    restoreInstructions: null,
    revision: 1,
  };
}

function cardFromTemplate(template: ApplicationTemplate): TemplateCardData {
  return {
    id: template.id,
    origin: template.origin,
    name: template.name,
    description: template.description ?? "",
    emoji: template.emoji ?? "▦",
    color: template.color ?? STARTER_COLOR,
    spec: template.paths,
    installUrl: template.installUrl,
    installInstructions: template.installInstructions,
    restoreInstructions: template.restoreInstructions,
    revision: template.revision,
  };
}

function specPathText(entries: CaptureSpecPath[] | undefined): string {
  return (entries ?? []).map((entry) => entry.path).join("\n");
}

function draftFromCard(card: TemplateCardData, duplicate: boolean): TemplateDraft {
  return {
    id: duplicate ? null : card.id,
    name: duplicate ? `${card.name} copy` : card.name,
    description: card.description,
    emoji: card.emoji,
    color: card.color,
    linuxPaths: specPathText(card.spec.paths.linux),
    macosPaths: specPathText(card.spec.paths.macos),
    windowsPaths: specPathText(card.spec.paths.windows),
    excludes: card.spec.excludes.join("\n"),
    notes: card.spec.notes ?? "",
    installUrl: card.installUrl ?? "",
    installInstructions: card.installInstructions ?? "",
    restoreInstructions: card.restoreInstructions ?? "",
  };
}

function specFromDraft(draft: TemplateDraft): CaptureSpec {
  const paths: CaptureSpec["paths"] = {};
  const linuxPaths = lines(draft.linuxPaths);
  const macosPaths = lines(draft.macosPaths);
  const windowsPaths = lines(draft.windowsPaths);
  if (linuxPaths.length > 0) {
    paths.linux = linuxPaths.map((path) => ({ path, classification: "unknown" as const }));
  }
  if (macosPaths.length > 0) {
    paths.macos = macosPaths.map((path) => ({ path, classification: "unknown" as const }));
  }
  if (windowsPaths.length > 0) {
    paths.windows = windowsPaths.map((path) => ({ path, classification: "unknown" as const }));
  }
  return {
    paths,
    excludes: lines(draft.excludes),
    notes: draft.notes.trim() || null,
  };
}

function payloadFromDraft(draft: TemplateDraft): TemplateCreatePayload {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    emoji: draft.emoji.trim() || null,
    color: draft.color.trim() || null,
    paths: specFromDraft(draft),
    installUrl: draft.installUrl.trim() || null,
    installInstructions: draft.installInstructions.trim() || null,
    restoreInstructions: draft.restoreInstructions.trim() || null,
  };
}

// ---------------------------------------------------------------------------
// Enrollment / deletion flows — exported so the page test can exercise the
// exact handlers the buttons call (repo convention: DOM-free page tests,
// see pages/apps.test.ts).
// ---------------------------------------------------------------------------

export interface TemplateEnrollServices {
  listAppTemplates(): Promise<ApplicationTemplate[]>;
  createAppTemplate(body: TemplateCreatePayload): Promise<ApplicationTemplate>;
  enrollAppProtection(body: {
    templateId: string;
    hostId: string;
    schedule?: string | null;
    name?: string;
  }): Promise<unknown>;
}

export interface EnrollOptions {
  /** The card being enrolled. `id` null = built-in starter: materialize it
   *  into a custom template first (name is unique server-side, so repeat
   *  enrollments find the existing row instead of duplicating). */
  template: TemplateCardData;
  hostId: string;
  /** Optional protection name; omitted => server defaults to template name. */
  name?: string;
  schedule?: string | null;
}

/**
 * Enroll a template (or a built-in starter, materializing it first) on one
 * host. Returns null on success, otherwise the error text the page should
 * render — a duplicate (host, template) enrollment surfaces the server's
 * 409 via this return value.
 */
export async function runTemplateEnrollment(
  services: TemplateEnrollServices,
  opts: EnrollOptions,
): Promise<string | null> {
  try {
    const { template } = opts;
    let templateId = template.id;
    if (templateId === null) {
      // Starter: find an already-saved template with the same name, else
      // materialize one (origin is server-assigned on create).
      const known = (await services.listAppTemplates()).find(
        (existing) => existing.name === template.name,
      );
      if (known) {
        templateId = known.id;
      } else {
        const created = await services.createAppTemplate(payloadFromCard(template));
        templateId = created.id;
      }
    }
    const protectionName = opts.name?.trim();
    const body: {
      templateId: string;
      hostId: string;
      schedule?: string | null;
      name?: string;
    } = { templateId, hostId: opts.hostId };
    if (protectionName) body.name = protectionName;
    if (opts.schedule) body.schedule = opts.schedule;
    await services.enrollAppProtection(body);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export interface TemplateDeleteServices {
  deleteAppTemplate(id: string): Promise<void>;
}

/**
 * Delete a saved template. Returns null on success; otherwise the error text
 * to render (the server answers 409 "template has active protections" when
 * protections reference the template — the page surfaces that verbatim).
 */
export async function tryDeleteTemplate(
  services: TemplateDeleteServices,
  templateId: string,
): Promise<string | null> {
  try {
    await services.deleteAppTemplate(templateId);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function payloadFromCard(card: TemplateCardData): TemplateCreatePayload {
  return {
    name: card.name.trim(),
    description: card.description.trim() || null,
    emoji: card.emoji.trim() || null,
    color: card.color.trim() || null,
    paths: card.spec,
    installUrl: card.installUrl,
    installInstructions: card.installInstructions,
    restoreInstructions: card.restoreInstructions,
  };
}

function emptyDraft(): TemplateDraft {
  return {
    id: null,
    name: "",
    description: "",
    emoji: "▦",
    color: STARTER_COLOR,
    linuxPaths: "",
    macosPaths: "",
    windowsPaths: "",
    excludes: "",
    notes: "",
    installUrl: "",
    installInstructions: "",
    restoreInstructions: "",
  };
}

// ---------------------------------------------------------------------------
// Presentational pieces.
// ---------------------------------------------------------------------------

function TemplateCardView({
  card,
  deviceHostnames,
  enrolled,
  onEnroll,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  card: TemplateCardData;
  deviceHostnames: string[];
  enrolled: boolean;
  onEnroll: (card: TemplateCardData) => void;
  onEdit: (card: TemplateCardData) => void;
  onDuplicate: (card: TemplateCardData) => void;
  onDelete: (card: TemplateCardData) => void;
}) {
  return (
    <div className="fleet-card preset-card" style={{ borderTopColor: card.color }}>
      <div className="fleet-card-head">
        <strong>
          <span className="preset-emoji" aria-hidden="true">{card.emoji}</span> {card.name}
        </strong>
        <span className="badge">
          {card.origin === "built_in" ? "Built-in" : "Custom"}
        </span>
      </div>
      <p className="muted preset-blurb">{card.description}</p>
      {enrolled ? (
        <div className="preset-devices">
          <span className="badge badge-online">
            {deviceHostnames.length} device{deviceHostnames.length === 1 ? "" : "s"}
          </span>
          <span className="muted">{deviceHostnames.join(", ")}</span>
        </div>
      ) : (
        <span className="muted">Not enrolled yet</span>
      )}
      <div className="preset-actions">
        <button type="button" className="action primary" onClick={() => onEnroll(card)}>
          Enroll on host…
        </button>
        <details className="row-menu">
          <summary className="action">More</summary>
          <div className="row-menu-panel">
            {card.installUrl ? (
              <a href={card.installUrl} target="_blank" rel="noopener noreferrer">
                Documentation
              </a>
            ) : null}
            <Link to="/apps/backups">View app backups</Link>
            {card.id !== null ? (
              <>
                <button type="button" onClick={() => onEdit(card)}>Edit template</button>
                <button type="button" onClick={() => onDuplicate(card)}>Duplicate template</button>
                <button type="button" className="danger" onClick={() => onDelete(card)}>Delete template</button>
              </>
            ) : null}
          </div>
        </details>
      </div>
    </div>
  );
}

function TemplateEditor({
  draft,
  busy,
  onChange,
  onSave,
  onClose,
}: {
  draft: TemplateDraft;
  busy: boolean;
  onChange: (draft: TemplateDraft) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={draft.id ? "Edit application template" : "New application template"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="action" onClick={onClose}>Cancel</button>
          <button type="button" className="action primary" disabled={busy} onClick={onSave}>
            {busy ? "Saving…" : "Save template"}
          </button>
        </>
      }
    >
      <div className="profile-identity-fields">
        <label className="field"><span>Name</span><input required value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} /></label>
        <label className="field"><span>Emoji</span><input value={draft.emoji} maxLength={8} onChange={(e) => onChange({ ...draft, emoji: e.target.value })} /></label>
        <label className="field"><span>Color</span><input type="color" value={draft.color || STARTER_COLOR} onChange={(e) => onChange({ ...draft, color: e.target.value })} /></label>
      </div>
      <label className="field"><span>Description</span><input value={draft.description} onChange={(e) => onChange({ ...draft, description: e.target.value })} /></label>
      <div className="profile-path-grid">
        <label className="field"><span>Linux paths</span><textarea rows={4} placeholder="One path per line" value={draft.linuxPaths} onChange={(e) => onChange({ ...draft, linuxPaths: e.target.value })} /></label>
        <label className="field"><span>macOS paths</span><textarea rows={4} placeholder="One path per line" value={draft.macosPaths} onChange={(e) => onChange({ ...draft, macosPaths: e.target.value })} /></label>
        <label className="field"><span>Windows paths</span><textarea rows={4} placeholder="One path per line" value={draft.windowsPaths} onChange={(e) => onChange({ ...draft, windowsPaths: e.target.value })} /></label>
      </div>
      <label className="field"><span>Excluded paths (one per line, optional)</span><textarea rows={2} value={draft.excludes} onChange={(e) => onChange({ ...draft, excludes: e.target.value })} /></label>
      <label className="field"><span>Capture notes (optional)</span><textarea rows={2} value={draft.notes} onChange={(e) => onChange({ ...draft, notes: e.target.value })} /></label>
      <label className="field"><span>Install or documentation URL (optional)</span><input type="url" value={draft.installUrl} onChange={(e) => onChange({ ...draft, installUrl: e.target.value })} /></label>
      <label className="field"><span>Install notes (optional)</span><textarea rows={2} value={draft.installInstructions} onChange={(e) => onChange({ ...draft, installInstructions: e.target.value })} /></label>
      <label className="field"><span>Restore notes (optional)</span><textarea rows={2} value={draft.restoreInstructions} onChange={(e) => onChange({ ...draft, restoreInstructions: e.target.value })} /></label>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

export function AppTemplates() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [templates, setTemplates] = useState<ApplicationTemplate[]>([]);
  // Protections across the fleet: template cards show where a template is
  // enrolled (device count + names), and delete can warn about 409s.
  const [protectionsByTemplateName, setProtectionsByTemplateName] = useState<
    Map<string, string[]>
  >(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enrollDraft, setEnrollDraft] = useState<EnrollDraft | null>(null);
  const [editorDraft, setEditorDraft] = useState<TemplateDraft | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TemplateCardData | null>(null);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const [hostList, templateList, protectionList] = await Promise.all([
        api.listHosts(),
        api.listAppTemplates(),
        api.listAppProtections(),
      ]);
      setHosts(hostList);
      setTemplates(templateList);
      const byName = new Map<string, string[]>();
      for (const protection of protectionList) {
        const hostnames = byName.get(protection.templateName) ?? [];
        const hostname =
          hostList.find((host) => host.id === protection.hostId)?.hostname ??
          protection.hostId;
        if (!hostnames.includes(hostname)) hostnames.push(hostname);
        byName.set(protection.templateName, hostnames);
      }
      setProtectionsByTemplateName(byName);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const starterCards = useMemo(() => APP_PRESETS.map(cardFromStarter), []);
  const builtInRows = useMemo(
    () => [
      ...starterCards,
      ...templates
        .filter((template) => template.origin === "built_in")
        .map(cardFromTemplate),
    ],
    [starterCards, templates],
  );
  const customCards = useMemo(
    () => templates.filter((template) => template.origin === "custom").map(cardFromTemplate),
    [templates],
  );

  function beginEnroll(card: TemplateCardData): void {
    if (hosts.length === 0) {
      setError("Register a device before enrolling a template on it.");
      return;
    }
    setEnrollDraft({
      card,
      hostId: hosts[0].id,
      name: "",
      schedulePreset: "custom",
      schedule: "",
    });
  }

  function beginEdit(card: TemplateCardData): void {
    setEditorDraft(draftFromCard(card, false));
  }

  function beginDuplicate(card: TemplateCardData): void {
    setEditorDraft(draftFromCard(card, true));
  }

  async function saveTemplate(): Promise<void> {
    if (!editorDraft) return;
    const payload = payloadFromDraft(editorDraft);
    if (payload.name.length === 0) {
      setError("Give the application template a name.");
      return;
    }
    const spec = specFromDraft(editorDraft);
    if (
      (spec.paths.linux ?? []).length === 0 &&
      (spec.paths.macos ?? []).length === 0 &&
      (spec.paths.windows ?? []).length === 0
    ) {
      setError("Add at least one path on one operating system.");
      return;
    }
    setEditorBusy(true);
    setError(null);
    try {
      if (editorDraft.id) {
        await api.updateAppTemplate(editorDraft.id, payload);
      } else {
        await api.createAppTemplate(payload);
      }
      setEditorDraft(null);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setEditorBusy(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget || deleteTarget.id === null) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    setBusy(true);
    setError(null);
    try {
      const message = await tryDeleteTemplate(api, deleteTarget.id);
      if (message !== null) {
        // Server 409 ("template has active protections") surfaces verbatim.
        setError(message);
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnroll(): Promise<void> {
    if (!enrollDraft) return;
    if (enrollDraft.hostId.length === 0) {
      setError("Pick a device to enroll this template on.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const message = await runTemplateEnrollment(api, {
        template: enrollDraft.card,
        hostId: enrollDraft.hostId,
        name: enrollDraft.name,
        schedule: enrollDraft.schedule.trim() || null,
      });
      if (message !== null) {
        setError(message);
        return;
      }
      setEnrollDraft(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section">
      <PageHeader
        title="App templates"
        purpose="Reusable recipes that define which settings to capture. Enrolling a template on a device creates an application protection; snapshots are captured from the protection."
      />
      {error ? <div className="error">{error}</div> : null}
      {loading ? (
        <div className="empty-row" aria-busy="true"><div className="skel skel-line" /></div>
      ) : (
        <>
          <div className="preset-toolbar">
            <div>
              <h2>Built-in templates</h2>
              <p className="muted">Curated starting points. Enrolling one saves it as your own template first.</p>
            </div>
            <button type="button" className="action primary" onClick={() => setEditorDraft(emptyDraft())}>
              New template
            </button>
          </div>
          <div className="fleet-grid">
            {builtInRows.map((card) => (
              <TemplateCardView
                key={card.id ?? `starter:${card.name}`}
                card={card}
                enrolled={(protectionsByTemplateName.get(card.name)?.length ?? 0) > 0}
                deviceHostnames={protectionsByTemplateName.get(card.name) ?? []}
                onEnroll={beginEnroll}
                onEdit={beginEdit}
                onDuplicate={beginDuplicate}
                onDelete={setDeleteTarget}
              />
            ))}
          </div>
          <div className="preset-toolbar preset-toolbar-my">
            <div>
              <h2>My templates</h2>
              <p className="muted">Custom recipes you own. Editing one never changes protections already enrolled from it.</p>
            </div>
          </div>
          {customCards.length === 0 ? (
            <p className="muted preset-empty">
              No custom templates yet. Create one with “New template” or enroll a built-in starter above.
            </p>
          ) : null}
          <div className="fleet-grid">
            {customCards.map((card) => (
              <TemplateCardView
                key={card.id ?? card.name}
                card={card}
                enrolled={(protectionsByTemplateName.get(card.name)?.length ?? 0) > 0}
                deviceHostnames={protectionsByTemplateName.get(card.name) ?? []}
                onEnroll={beginEnroll}
                onEdit={beginEdit}
                onDuplicate={beginDuplicate}
                onDelete={setDeleteTarget}
              />
            ))}
          </div>
        </>
      )}
      {hosts.length === 0 && !loading ? (
        <p className="muted preset-hint">
          Register a device on the <Link to="/hosts">Devices</Link> page before enrolling a template.
        </p>
      ) : null}

      {enrollDraft ? (
        <Modal
          title={`Enroll ${enrollDraft.card.emoji} ${enrollDraft.card.name} on a device`}
          onClose={() => setEnrollDraft(null)}
          footer={
            <>
              <button type="button" className="action" onClick={() => setEnrollDraft(null)}>Cancel</button>
              <button type="button" className="action primary" disabled={busy} onClick={() => void confirmEnroll()}>
                {busy ? "Enrolling…" : "Enroll"}
              </button>
            </>
          }
        >
          <label className="field">
            <span>Device</span>
            <select
              value={enrollDraft.hostId}
              onChange={(e) => setEnrollDraft({ ...enrollDraft, hostId: e.target.value })}
            >
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>{host.hostname}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Protection name (optional)</span>
            <input
              placeholder={`Defaults to ${enrollDraft.card.name}`}
              value={enrollDraft.name}
              onChange={(e) => setEnrollDraft({ ...enrollDraft, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Capture schedule (optional)</span>
            <select
              value={enrollDraft.schedulePreset}
              onChange={(e) => {
                const preset = e.target.value;
                if (preset === "custom") {
                  setEnrollDraft({ ...enrollDraft, schedulePreset: preset, schedule: "" });
                } else {
                  const match = SCHEDULE_PRESETS.find((p) => p.value === preset);
                  setEnrollDraft({
                    ...enrollDraft,
                    schedulePreset: preset,
                    schedule: match?.cron ?? "",
                  });
                }
              }}
            >
              {SCHEDULE_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>{preset.label}</option>
              ))}
            </select>
          </label>
          {enrollDraft.schedulePreset === "custom" ? (
            <label className="field">
              <span>Cron expression</span>
              <input
                placeholder="0 */6 * * *"
                value={enrollDraft.schedule}
                onChange={(e) => setEnrollDraft({ ...enrollDraft, schedule: e.target.value })}
              />
            </label>
          ) : null}
          {enrollDraft.schedule ? (
            <p className="muted">Snapshots will be captured on this schedule once the device’s daemon has a matching folder assignment.</p>
          ) : null}
          {enrollDraft.card.id === null ? (
            <p className="muted">
              This built-in starter is not saved yet — enrolling saves it as a custom template first,
              then creates the protection on the chosen device.
            </p>
          ) : null}
          <p className="muted">Creating a protection starts future captures; it never copies or restores files.</p>
        </Modal>
      ) : null}

      {editorDraft ? (
        <TemplateEditor
          draft={editorDraft}
          busy={editorBusy}
          onChange={setEditorDraft}
          onSave={() => void saveTemplate()}
          onClose={() => setEditorDraft(null)}
        />
      ) : null}

      {deleteTarget && deleteTarget.id !== null ? (
        <Modal
          title={`Delete ${deleteTarget.name}?`}
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <button type="button" className="action" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button type="button" className="action danger" disabled={busy} onClick={() => void confirmDelete()}>
                Delete template
              </button>
            </>
          }
        >
          <p className="muted">
            Existing protections stay safe — this only removes the reusable template. A template that
            is still enrolled on any device cannot be deleted.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
