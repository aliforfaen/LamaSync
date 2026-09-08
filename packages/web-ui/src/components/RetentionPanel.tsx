// LAMA-325: retention policy editor + read-only preview + confirmed
// execution, shared by the App backups page (app protections) and the
// Folders page (restic-backed folders). Safety: preview never mutates;
// destructive execution requires an explicit confirm checkbox and re-runs
// server-side against fresh state; failed deletions are surfaced as
// failures, never as pruned.

import { useEffect, useMemo, useState } from "react";
import type { RetentionPolicy, RetentionRule } from "@lamasync/core";
import { api, type RetentionOutcome, type RetentionPolicyView, type RetentionPreview } from "../api.ts";
import { Modal } from "./Modal.tsx";
import { formatBytes } from "../format-bytes.ts";

export interface RetentionPanelProps {
  scope: "app" | "folder";
  resourceId: string;
  resourceLabel: string;
  open: boolean;
  onClose: () => void;
}

const SMART_PRESET = { daily: 7, weekly: 4, monthly: 12, yearly: 2 };

function emptyPolicy(): RetentionPolicy {
  return { enabled: false, rules: [], keepAtLeastOne: true };
}

export function RetentionPanel({ scope, resourceId, resourceLabel, open, onClose }: RetentionPanelProps) {
  const [view, setView] = useState<RetentionPolicyView | null>(null);
  const [draft, setDraft] = useState<RetentionPolicy | null>(null);
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RetentionOutcome[] | null>(null);
  const [pruneError, setPruneError] = useState<string | null>(null);

  const isApp = scope === "app";
  const base = isApp
    ? `/apps/protections/${encodeURIComponent(resourceId)}`
    : `/folders/${encodeURIComponent(resourceId)}`;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setView(null);
    setDraft(null);
    setPreview(null);
    setOutcome(null);
    setPruneError(null);
    setConfirmChecked(false);
    setError(null);
    void (async () => {
      try {
        const v = isApp
          ? await api.getAppRetentionPolicy(resourceId)
          : await api.getFolderRetentionPolicy(resourceId);
        if (cancelled) return;
        setView(v);
        setDraft(v.policy ?? emptyPolicy());
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, resourceId, isApp]);

  const evaluation = useMemo(() => preview?.evaluation ?? null, [preview]);

  async function savePolicy(): Promise<void> {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const body = { enabled: draft.enabled, rules: draft.rules };
      const saved = isApp
        ? await api.setAppRetentionPolicy(resourceId, body)
        : await api.setFolderRetentionPolicy(resourceId, body);
      setView(saved);
      setDraft(saved.policy ?? draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runPreview(): Promise<void> {
    setBusy(true);
    setError(null);
    // Preview first persists the CURRENT draft so the projection matches
    // what execution would evaluate (execution itself never trusts it).
    if (draft) {
      try {
        await savePolicy();
      } catch {
        setBusy(false);
        return;
      }
    }
    try {
      const p = isApp
        ? await api.previewAppRetention(resourceId)
        : await api.previewFolderRetention(resourceId);
      setPreview(p);
      setOutcome(null);
      setConfirmChecked(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runExecute(): Promise<void> {
    if (!confirmChecked) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    setPruneError(null);
    try {
      const result = isApp
        ? await api.executeAppRetention(resourceId)
        : await api.executeFolderRetention(resourceId);
      setOutcome(result.outcomes);
      setPreview(result.revalidatedPreview);
      if (result.prune && !result.prune.ok) {
        setPruneError(result.prune.error ?? "restic prune failed");
      }
      setConfirmChecked(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function mergeRule(index: number, rule: RetentionRule): void {
    if (!draft) return;
    setDraft({ ...draft, rules: draft.rules.map((r, i) => (i === index ? rule : r)) });
  }

  function addRule(kind: RetentionRule["kind"]): void {
    if (!draft) return;
    if (kind === "keepLast") {
      setDraft({ ...draft, rules: [...draft.rules, { kind, count: 5 }] });
    } else if (kind === "keepAge") {
      setDraft({ ...draft, rules: [...draft.rules, { kind, maxAgeMs: 30 * 86_400_000 }] });
    } else {
      const unit = kind as "daily" | "weekly" | "monthly" | "yearly";
      setDraft({ ...draft, rules: [...draft.rules, { kind: "calendar", unit, count: 7 }] });
    }
  }

  if (!open) return null;

  const deleteCount = evaluation?.deleteCount ?? 0;
  const deleted = outcome?.filter((o) => o.status === "deleted").length ?? 0;
  const failed = outcome?.filter((o) => o.status === "failed") ?? [];
  const absent = outcome?.filter((o) => o.status === "absent").length ?? 0;

  return (
    <Modal
      title={`Retention — ${resourceLabel}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="action" onClick={onClose}>Close</button>
          {draft ? (
            <button type="button" className="action" disabled={busy} onClick={() => void savePolicy()}>
              Save policy
            </button>
          ) : null}
          <button type="button" className="action" disabled={busy} onClick={() => void runPreview()}>
            Preview
          </button>
        </>
      }
    >
      {error ? <div className="error">{error}</div> : null}

      {view === null && draft === null ? (
        <p className="muted" aria-busy="true">Loading policy…</p>
      ) : draft === null ? null : (
        <>
          <p className="muted">{view?.policyDescription ?? "Retention disabled."}</p>

          <label className="field">
            <span>Retention</span>
            <select
              value={draft.enabled ? (draft.rules.length === 0 ? "enabled-empty" : "enabled") : "disabled"}
              onChange={(e) => {
                const v = e.target.value;
                setDraft({
                  ...draft,
                  enabled: v === "enabled" || v === "enabled-empty",
                });
              }}
            >
              <option value="disabled">Disabled — keep every snapshot</option>
              <option value="enabled">Enabled</option>
              <option value="enabled-empty">Enabled (keep everything — no rules yet)</option>
            </select>
          </label>

          {draft.enabled ? (
            <>
              <div className="preset-toolbar">
                <div className="muted">
                  <button
                    type="button"
                    className="action"
                    disabled={busy}
                    onClick={() => setDraft({ ...draft, rules: smartRules() })}
                  >
                    Apply Smart retention (7d + 4w + 12m + 2y)
                  </button>
                  <button
                    type="button"
                    className="action"
                    disabled={busy}
                    onClick={() => setDraft({ ...draft, rules: [] })}
                  >
                    Clear rules
                  </button>
                  <select
                    className="retention-add-rule"
                    value=""
                    onChange={(e) => {
                      const kind = e.target.value as RetentionRule["kind"];
                      if (kind) addRule(kind);
                    }}
                  >
                    <option value="">Add rule…</option>
                    <option value="keepLast">Keep last N snapshots</option>
                    <option value="keepAge">Keep snapshots younger than N days</option>
                    <option value="daily">Daily buckets</option>
                    <option value="weekly">Weekly buckets</option>
                    <option value="monthly">Monthly buckets</option>
                    <option value="yearly">Yearly buckets</option>
                  </select>
                </div>
              </div>
              {draft.rules.length === 0 ? (
                <p className="muted">No rules yet — previewing will keep everything (disabled-equivalent).</p>
              ) : (
                <table className="data">
                  <tbody>
                    {draft.rules.map((rule, index) => (
                      <tr key={`${rule.kind}-${index}`}>
                        <td>
                          <select
                            value={rule.kind}
                            onChange={(e) => {
                              const kind = e.target.value as RetentionRule["kind"];
                              mergeRule(
                                index,
                                kind === "keepLast"
                                  ? { kind, count: rule.kind === "keepLast" ? (rule as { count: number }).count : 5 }
                                  : kind === "keepAge"
                                    ? { kind, maxAgeMs: rule.kind === "keepAge" ? (rule as { maxAgeMs: number }).maxAgeMs : 30 * 86_400_000 }
                                    : { kind: "calendar", unit: kind as "daily" | "weekly" | "monthly" | "yearly", count: 7 },
                              );
                            }}
                          >
                            <option value="keepLast">Keep last N</option>
                            <option value="keepAge">Keep for age</option>
                            <option value="daily">Daily bucket</option>
                            <option value="weekly">Weekly bucket</option>
                            <option value="monthly">Monthly bucket</option>
                            <option value="yearly">Yearly bucket</option>
                          </select>
                        </td>
                        <td>
                          {rule.kind === "keepLast" ? (
                            <input
                              type="number"
                              min={1}
                              value={rule.count}
                              onChange={(e) => mergeRule(index, { kind: "keepLast", count: Math.max(1, Number(e.target.value) || 1) })}
                            />
                          ) : rule.kind === "keepAge" ? (
                            <span className="muted">
                              younger than{" "}
                              <input
                                type="number"
                                min={1}
                                value={Math.round(rule.maxAgeMs / 86_400_000)}
                                onChange={(e) => mergeRule(index, { kind: "keepAge", maxAgeMs: Math.max(1, Number(e.target.value) || 1) * 86_400_000 })}
                              />{" "}
                              days
                            </span>
                          ) : (
                            <span className="muted">
                              keep newest successful snapshot in each of the last{" "}
                              <input
                                type="number"
                                min={1}
                                value={rule.count}
                                onChange={(e) => mergeRule(index, { kind: "calendar", unit: rule.unit, count: Math.max(1, Number(e.target.value) || 1) })}
                              />{" "}
                              {rule.unit}
                            </span>
                          )}
                        </td>
                        <td className="table-actions">
                          <button
                            type="button"
                            className="action danger"
                            onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, i) => i !== index) })}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ) : null}

          {preview ? (
            <div className="retention-preview">
              <h3 className="form-title">Projected outcome (read-only)</h3>
              <p className="muted">
                Deletes <strong>{deleteCount}</strong> snapshot{deleteCount === 1 ? "" : "s"}
                {evaluation && evaluation.reclaimableBytes > 0 ? (
                  <> (≈ {formatBytes(evaluation.reclaimableBytes)} reclaimed)</>
                ) : null}
                {" · "}keeps <strong>{evaluation?.keptCount ?? 0}</strong>
                {evaluation && evaluation.unknownSizeCount > 0 ? (
                  <>
                    {" · "}
                    <span className="badge badge-unknown">
                      {evaluation.unknownSizeCount} without size data (reclaim estimate excludes them)
                    </span>
                  </>
                ) : null}
                {evaluation && evaluation.guardCount > 0 ? (
                  <>
                    {" · "}
                    <span className="badge badge-unknown">{evaluation.guardCount} protected (hold / rollback)</span>
                  </>
                ) : null}
              </p>
              {preview.snapshots.length === 0 ? (
                <p className="muted">No snapshots yet.</p>
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th>Created</th>
                      <th>Size</th>
                      <th>Decision</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.snapshots.map((s) => (
                      <tr key={s.id}>
                        <td className="muted">{new Date(s.createdAt).toLocaleString()}</td>
                        <td className="muted">{formatBytes(s.sizeBytes)}</td>
                        <td>
                          <span className={`badge ${s.decision.action === "keep" ? "badge-success" : "badge-failed"}`}>
                            {s.decision.action === "keep" ? "Keep" : "Delete"}
                          </span>
                        </td>
                        <td className="muted">{s.decision.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {outcome ? (
                <div className="retention-outcome">
                  <h3 className="form-title">Execution result</h3>
                  <p className="muted">
                    Deleted {deleted}, already absent {absent}, failed {failed.length}.
                  </p>
                  {failed.length > 0 ? (
                    <ul>
                      {failed.map((f) => (
                        <li key={f.id} className="error">
                          <code>{f.id.slice(0, 8)}</code>: {f.error ?? "failed"}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {pruneError ? <p className="error">restic prune failed: {pruneError}</p> : null}
                </div>
              ) : null}

              {deleteCount > 0 ? (
                <>
                  <label className="field">
                    <span>
                      Confirm irreversible deletion of{" "}
                      <strong>{deleteCount}</strong> snapshot{deleteCount === 1 ? "" : "s"}:
                    </span>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={confirmChecked}
                        onChange={(e) => setConfirmChecked(e.target.checked)}
                      />
                      I understand this deletes snapshot archives{" "}
                      {isApp ? "from their stored destinations" : "from the restic repository"}.
                    </label>
                  </label>
                  <button
                    type="button"
                    className="action danger"
                    disabled={busy || !confirmChecked}
                    onClick={() => void runExecute()}
                  >
                    {busy ? "Executing…" : "Execute retention"}
                  </button>
                  <p className="muted">
                    Execution re-evaluates against the latest state; deletions that fail are
                    reported as failures and never counted as pruned.
                  </p>
                </>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Modal>
  );
}

function smartRules(): RetentionRule[] {
  return [
    { kind: "calendar", unit: "daily", count: SMART_PRESET.daily },
    { kind: "calendar", unit: "weekly", count: SMART_PRESET.weekly },
    { kind: "calendar", unit: "monthly", count: SMART_PRESET.monthly },
    { kind: "calendar", unit: "yearly", count: SMART_PRESET.yearly },
  ];
}