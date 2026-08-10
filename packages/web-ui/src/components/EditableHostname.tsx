import { useEffect, useRef, useState } from "react";
import type { Host } from "@lamasync/core";
import { api, errorText } from "../api.ts";

interface EditableHostnameProps {
  host: Host;
  /** Called after a successful rename so the parent can refetch. */
  onRenamed: () => void;
}

/**
 * LAMA-225: inline hostname edit (pencil → text input → Enter/blur saves,
 * Escape cancels). Clicking the controls never triggers the surrounding
 * <Link> navigation — both preventDefault and stopPropagation are used.
 * The host id stays stable; only the display label changes.
 */
export function EditableHostname({ host, onRenamed }: EditableHostnameProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(host.hostname);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Refs mirror the state so the blur handler (fired asynchronously after
  // Enter/Escape) can tell whether edit mode is still active.
  const editingRef = useRef(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function start(e: React.MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    setDraft(host.hostname);
    setErr(null);
    editingRef.current = true;
    setEditing(true);
  }

  async function save(): Promise<void> {
    if (savingRef.current) return;
    const next = draft.trim();
    if (!next || next === host.hostname) {
      cancel();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setErr(null);
    try {
      await api.patchHost(host.id, { hostname: next });
      cancel();
      onRenamed();
    } catch (error) {
      setErr(errorText(error));
      setSaving(false);
      savingRef.current = false;
    }
  }

  function cancel(): void {
    editingRef.current = false;
    setEditing(false);
    setErr(null);
  }

  if (editing) {
    return (
      <span className="hostname-edit" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="hostname-edit-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") cancel();
          }}
          onBlur={() => {
            if (editingRef.current && !savingRef.current) void save();
          }}
          disabled={saving}
          aria-label="New hostname"
        />
        {saving ? <span className="muted">saving…</span> : null}
        {err ? <span className="hostname-edit-error">{err}</span> : null}
      </span>
    );
  }

  return (
    <span className="hostname-edit">
      <strong>{host.hostname}</strong>
      <button
        type="button"
        className="hostname-edit-btn"
        title="Rename host"
        aria-label={`Rename host ${host.hostname}`}
        onClick={(e) => start(e)}
      >
        ✎
      </button>
    </span>
  );
}
