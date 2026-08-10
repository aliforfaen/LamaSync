// LAMA-198 / hidden-api-power: inline editor for a single folder
// assignment. Saves through `PATCH /folders/:id/assign/:hostId`
// (api.updateAssignment). Only fields the user changed are sent, so
// untouched settings are never clobbered. House style: plain inline
// `<form className="form">` panel — no modal framework.

import { useState } from "react";
import type { FolderAssignment } from "@lamasync/core";
import { api } from "../api.ts";
// Workstream 2: hint copy lives in the shared glossary now.
import { CONFLICT_STRATEGY_HINTS, ROLE_HINTS } from "../concepts.ts";
import { validateCronExpression } from "../cron.ts";

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
  role: string;
  schedulePreset: string;
  syncExpr: string;
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
    role: a.role ?? "both",
    schedulePreset: schedulePresetForCron(a.syncExpr),
    syncExpr: toStr(a.syncExpr),
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
  onSaved: () => void;
  onCancel: () => void;
}

export function AssignmentEditor({ assignment, folderName, hostName, onSaved, onCancel }: Props) {
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

  return (
    <form className="form assignment-editor" onSubmit={onSave}>
      <h2 className="form-title">
        Edit assignment — {folderName ?? assignment.folderId} on {hostName ?? assignment.hostId}
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
      </label>
      {state.schedulePreset === "custom" && (
        <label>
          Cron expression
          <input
            placeholder="*/15 * * * *"
            value={state.syncExpr}
            onChange={(e) => setCron(e.target.value)}
            aria-invalid={cronError !== null}
          />
          <span className="muted">
            Cron expression, e.g. <code>0 * * * *</code> = every hour. Leave
            empty to use the daemon's default schedule.
          </span>
          {cronError && <div className="error">{cronError}</div>}
        </label>
      )}

      <label>
        Conflict strategy
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
