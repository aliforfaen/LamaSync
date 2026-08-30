// LAMA-198 / hidden-api-power: inline editor for a single folder
// assignment. Saves through `PATCH /folders/:id/assign/:hostId`
// (api.updateAssignment). Only fields the user changed are sent, so
// untouched settings are never clobbered. House style: plain inline
// `<form className="form">` panel — no modal framework.

import { useState } from "react";
import type { Folder, FolderAssignment } from "@lamasync/core";
import { api } from "../api.ts";
// Workstream 2: hint copy lives in the shared glossary now.
import { CONFLICT_STRATEGY_HINTS, ROLE_HINTS } from "../concepts.ts";
import { validateCronExpression } from "../cron.ts";
// LAMA-267: presets + the "Next: …" sentence live in shared helpers so every
// web-ui surface (and the TUI copy) stays in lock-step.
import { SCHEDULE_PRESETS, schedulePresetForCron } from "../schedule-presets.ts";
import { nextRunSentence } from "../next-run.ts";

function toStr(v: string | number | null | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

/** Parse a numeric text field; NaN signals an invalid entry. */
function toNumOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

interface EditorState {
  localPath: string;
  destination: string;
  role: string;
  schedulePreset: string;
  syncExpr: string;
  // LAMA-239: per-host mount/sync override. Default "inherit" mirrors the
  // column default and the wire shape — null on save resets to "inherit".
  mode: "inherit" | "sync" | "mount";
  conflictStrategy: string;
  timeoutSec: string;
  maxRetries: string;
  availableSpaceThreshold: string;
  preSyncCmd: string;
  postSyncCmd: string;
  bandwidthSchedule: string;
}

function stateFromAssignment(a: FolderAssignment): EditorState {
  return {
    localPath: toStr(a.localPath),
    destination: toStr(a.destination),
    role: a.role ?? "both",
    schedulePreset: schedulePresetForCron(a.syncExpr),
    syncExpr: toStr(a.syncExpr),
    mode: a.mode === "sync" || a.mode === "mount" ? a.mode : "inherit",
    conflictStrategy: a.conflictStrategy ?? "newer_wins",
    timeoutSec: toStr(a.timeoutSec),
    maxRetries: toStr(a.maxRetries),
    availableSpaceThreshold: toStr(a.availableSpaceThreshold),
    preSyncCmd: toStr(a.preSyncCmd),
    postSyncCmd: toStr(a.postSyncCmd),
    bandwidthSchedule: toStr(a.bandwidthSchedule),
  };
}

interface Props {
  assignment: FolderAssignment;
  // WS6 P4: optional display names so callers can show "Edit assignment —
  // Documents on homelab" instead of raw UUIDs. Both fall back to the
  // id if absent, so this stays a non-breaking add for any future caller.
  folderName?: string;
  hostName?: string;
  // LAMA-239: the parent folder. Required to gate the Mode dropdown —
  // the override only applies when folder.type is "sync" or "mount".
  // Optional for back-compat (older callers pass nothing); when omitted
  // the dropdown renders when the assignment's effective type makes it
  // meaningful, falling back to always-hidden when we can't tell.
  folder?: Folder;
  onSaved: () => void;
  onCancel: () => void;
}

export function AssignmentEditor({ assignment, folder, folderName, hostName, onSaved, onCancel }: Props) {
  // LAMA-239: render the Mode dropdown only when the folder-level type
  // supports an override (sync / mount). backup / dotfile / git folders
  // ignore mode, so showing it would mislead the operator.
  const showMode = folder !== undefined && (folder.type === "sync" || folder.type === "mount");
  const initial = stateFromAssignment(assignment);
  const [state, setState] = useState<EditorState>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // WS6 P3: live cron validation — same pattern as the Folders assign form.
  // Empty stays valid (optional schedule); presets (`@reboot`/`@login`/etc.)
  // are accepted by the validator as-is, so a preset-selected state never
  // raises the error.
  const [cronError, setCronError] = useState<string | null>(
    state.schedulePreset === "custom" && state.syncExpr.trim() !== ""
      ? validateCronExpression(state.syncExpr)
      : null,
  );

  const set = (patch: Partial<EditorState>) => setState((s) => ({ ...s, ...patch }));

  function pickPreset(value: string) {
    const preset = SCHEDULE_PRESETS.find((p) => p.value === value);
    if (preset && value !== "custom") {
      set({ schedulePreset: value, syncExpr: preset.cron });
      setCronError(null);
    } else {
      set({ schedulePreset: "custom", syncExpr: "" });
      setCronError(null);
    }
  }

  function setCron(value: string) {
    set({ syncExpr: value });
    setCronError(value.trim() === "" ? null : validateCronExpression(value));
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // WS6 P3: block save while the cron expression is invalid. Empty is
    // allowed (matches the Folders assign form: the schedule is optional
    // and the daemon falls back to its default). Presets short-circuit to
    // a known-good expression.
    if (state.schedulePreset === "custom" && state.syncExpr.trim() !== "") {
      const err = validateCronExpression(state.syncExpr);
      if (err) {
        setCronError(err);
        return;
      }
    }
    const body: Record<string, unknown> = {};

    const numeric = [
      ["timeoutSec", state.timeoutSec, assignment.timeoutSec],
      ["maxRetries", state.maxRetries, assignment.maxRetries],
      [
        "availableSpaceThreshold",
        state.availableSpaceThreshold,
        assignment.availableSpaceThreshold,
      ],
    ] as const;
    for (const [key, raw, initialValue] of numeric) {
      const n = toNumOrNull(raw);
      if (Number.isNaN(n)) {
        setError(`${key} must be a number`);
        return;
      }
      const target = n ?? null;
      const was = initialValue ?? null;
      if (target !== was) body[key] = target;
    }

    const text = [
      ["localPath", state.localPath, assignment.localPath],
      ["destination", state.destination, assignment.destination],
      ["role", state.role, assignment.role],
      ["syncExpr", state.syncExpr, assignment.syncExpr],
      ["conflictStrategy", state.conflictStrategy, assignment.conflictStrategy],
      ["preSyncCmd", state.preSyncCmd, assignment.preSyncCmd],
      ["postSyncCmd", state.postSyncCmd, assignment.postSyncCmd],
      ["bandwidthSchedule", state.bandwidthSchedule, assignment.bandwidthSchedule],
    ] as const;
    for (const [key, raw, initialValue] of text) {
      const target = raw.trim() === "" ? null : raw.trim();
      const was = initialValue ?? null;
      if (target !== was) body[key] = target;
    }

    // LAMA-239: only include mode when the folder supports an override,
    // so the wire payload stays clean for backup/dotfile/git folders.
    if (showMode) {
      const currentMode = assignment.mode === "sync" || assignment.mode === "mount"
        ? assignment.mode
        : "inherit";
      if (state.mode !== currentMode) body.mode = state.mode;
    }

    if (Object.keys(body).length === 0) {
      onCancel();
      return;
    }

    setBusy(true);
    try {
      await api.updateAssignment(assignment.folderId, assignment.hostId, body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const roleHint = ROLE_HINTS.find((r) => r.value === state.role)?.hint;
  const conflictHint = CONFLICT_STRATEGY_HINTS.find(
    (c) => c.value === state.conflictStrategy,
  )?.hint;
  // LAMA-267: "Next: …" preview of the schedule being edited. Computed once
  // per render; null when nothing schedulable is set yet.
  const nextRun = nextRunSentence(state.syncExpr);

  return (
    <form className="form assignment-editor" onSubmit={onSave}>
      <h2 className="form-title">
        Edit “{folderName ?? assignment.folderId}” on {hostName ?? assignment.hostId}
      </h2>
      {error && <div className="error">{error}</div>}

      <label>
        Local path
        <input
          required
          value={state.localPath}
          placeholder="~/Documents"
          onChange={(e) => set({ localPath: e.target.value })}
        />
      </label>

      {folder?.type === "backup" ? (
        <label>
          Remote prefix (optional)
          <input
            placeholder={`${folderName ?? assignment.folderId}/shared`}
            value={state.destination}
            onChange={(e) => set({ destination: e.target.value })}
          />
          <span className="muted">
            Leave empty for this device&apos;s host-scoped path. Use a prefix
            only when intentionally sharing backup data.
          </span>
        </label>
      ) : null}

      <label>
        Role
        <select
          value={state.role}
          onChange={(e) => set({ role: e.target.value })}
        >
          {ROLE_HINTS.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
        <span className="muted">{roleHint}</span>
      </label>

      <label>
        Schedule
        <select
          value={state.schedulePreset}
          onChange={(e) => pickPreset(e.target.value)}
        >
          {SCHEDULE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        {/* LAMA-267: a plain-sentence preview of the next fire instead of
            the raw cron, matching what the daemon will actually do. */}
        {nextRun && <span className="muted next-run">{nextRun}</span>}
      </label>
      {/* LAMA-267: the raw cron input hides behind a reveal toggle and only
          auto-opens when "Custom" is the selected preset. */}
      <details
        className="schedule-custom-reveal"
        open={state.schedulePreset === "custom"}
      >
        <summary>Advanced: custom cron</summary>
        <label>
          Custom schedule
          <input
            placeholder="*/15 * * * *"
            value={state.syncExpr}
            onChange={(e) => setCron(e.target.value)}
            aria-invalid={cronError !== null}
          />
          <span className="muted">
            Schedule in cron format, e.g. <code>0 * * * *</code> = every hour.
            Leave empty for this device's default schedule.
          </span>
          {cronError && <div className="error">{cronError}</div>}
        </label>
      </details>

      <label>
        When both sides changed
        <select
          value={state.conflictStrategy}
          onChange={(e) => set({ conflictStrategy: e.target.value })}
        >
          {CONFLICT_STRATEGY_HINTS.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        <span className="muted">{conflictHint}</span>
      </label>

      {showMode ? (
        <label>
          {/* LAMA-239: per-host sync/mount override. "Inherit" falls back
              to the folder's type; "Sync"/"Mount" force the effective
              type for THIS host (other hosts keep the folder type). */}
          Mode
          <select
            value={state.mode}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "sync" || v === "mount" || v === "inherit") {
                set({ mode: v });
              }
            }}
          >
            <option value="inherit">Use folder default</option>
            <option value="sync">Sync</option>
            <option value="mount">Read-only mount</option>
          </select>
          <span className="muted">
            Override how this device uses the folder. "Use folder default"
            follows the folder's type; the other two force syncing or a
            read-only mount on this device only. Other devices are unaffected.
          </span>
        </label>
      ) : null}

      <details className="assignment-editor-advanced">
        <summary>Advanced</summary>
        <label>
          Timeout (seconds)
          <input
            type="number"
            min={0}
            placeholder="e.g. 3600"
            value={state.timeoutSec}
            onChange={(e) => set({ timeoutSec: e.target.value })}
          />
        </label>
        <label>
          Max retries
          <input
            type="number"
            min={0}
            placeholder="3"
            value={state.maxRetries}
            onChange={(e) => set({ maxRetries: e.target.value })}
          />
        </label>
        <label>
          Available-space threshold (bytes)
          <input
            type="number"
            min={0}
            placeholder="skip sync when less than this is free"
            value={state.availableSpaceThreshold}
            onChange={(e) => set({ availableSpaceThreshold: e.target.value })}
          />
        </label>
        <label>
          Pre-sync command
          <input
            value={state.preSyncCmd}
            placeholder="e.g. git pull --rebase"
            onChange={(e) => set({ preSyncCmd: e.target.value })}
          />
        </label>
        <label>
          Post-sync command
          <input
            value={state.postSyncCmd}
            placeholder="e.g. systemctl --user restart service"
            onChange={(e) => set({ postSyncCmd: e.target.value })}
          />
        </label>
        <label>
          Bandwidth schedule
          <input
            value={state.bandwidthSchedule}
            placeholder='e.g. "08:00,512K 12:00,10M"'
            onChange={(e) => set({ bandwidthSchedule: e.target.value })}
          />
        </label>
      </details>

      <div className="actions">
        <button type="submit" className="action primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="action" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
