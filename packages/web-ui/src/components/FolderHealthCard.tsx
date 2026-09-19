// LAMA-345 stage 4 — the Folder health card.
//
// Diagnose → Plan → Approve → Execute → Verify, in one component per
// assignment row. It renders the state, why it is that state, exact
// remediation, and the contextual actions; risky actions open a guided modal
// with the dry-run summary, explicit authority wording, plan-staleness
// protection and a confirmation.
//
// Nothing here can express an rclone flag: every action is one of the
// allowlisted ids in @lamasync/core/folder-health.

import { useCallback, useEffect, useState } from "react";
import type { FolderHealthRecord, FolderPlanWithValidity } from "@lamasync/core/folder-health";
import type { FolderHealthActionId } from "@lamasync/core/folder-health";
import type { QueuedActionType } from "@lamasync/core";
import { api } from "../api.ts";
import { Modal } from "./Modal.tsx";
import {
  actionLabel,
  authorityForAction,
  authorityWording,
  availableHealthActions,
  baselineSentence,
  filterSentence,
  freshnessSentence,
  healthLabel,
  healthTone,
  isGuardedAction,
  measurementSentence,
  planValiditySentence,
  watcherSentence,
} from "../folder-health.ts";

export interface FolderHealthCardProps {
  folderId: string;
  hostId: string;
  record: FolderHealthRecord;
  /** Called after an action is enqueued so the parent can refresh. */
  onQueued?: (message: string) => void;
  /** Test/UI seam: the action enqueuer. Defaults to the real API. */
  enqueue?: (
    hostId: string,
    body: { type: QueuedActionType; payload: Record<string, unknown> },
  ) => Promise<unknown>;
}

interface GuidedState {
  action: FolderHealthActionId;
  plan: FolderPlanWithValidity | null;
  planning: boolean;
  error: string | null;
}

export function FolderHealthCard({
  folderId,
  hostId,
  record,
  onQueued,
  enqueue,
}: FolderHealthCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guided, setGuided] = useState<GuidedState | null>(null);
  const [authority, setAuthority] = useState<"remote" | "local">("remote");

  const send = useCallback(
    async (type: QueuedActionType, payload: Record<string, unknown>) => {
      const fn = enqueue ?? ((h, b) => api.enqueueAction(h, b));
      return fn(hostId, { type, payload });
    },
    [enqueue, hostId],
  );

  const runQuickAction = useCallback(
    async (action: FolderHealthActionId) => {
      setBusy(true);
      setError(null);
      try {
        if (action === "diagnose") {
          await send("diagnose_folder", { folderId });
        } else if (action === "plan") {
          await send("plan_folder", { folderId, intervention: "initialize", authority: "remote" });
        } else if (action === "sync") {
          await send("trigger_sync", { folderId });
        } else if (action === "cancel") {
          await send("folder_intervention", { folderId, intervention: "cancel", confirm: true });
        } else if (action === "resume") {
          await send("folder_intervention", { folderId, intervention: "resume" });
        }
        onQueued?.(`${actionLabel(action)} queued for this device.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [folderId, onQueued, send],
  );

  /** Open the guided modal and immediately build the matching plan. */
  const openGuided = useCallback(
    async (action: FolderHealthActionId, chosen: "remote" | "local") => {
      setGuided({ action, plan: null, planning: true, error: null });
      try {
        const intervention =
          action === "initialize" ? "initialize" : action === "seed" ? "seed" : "resync";
        await send("plan_folder", {
          folderId,
          intervention,
          authority: action === "resync" ? chosen : authorityForAction(action, chosen),
        });
        setGuided((prev) => (prev ? { ...prev, planning: false } : prev));
        onQueued?.("Dry run queued — the plan appears here when the device finishes it.");
      } catch (err) {
        setGuided({
          action,
          plan: null,
          planning: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [folderId, onQueued, send],
  );

  const guidedAction = guided?.action ?? null;

  // Re-read the newest plan while the guided modal is open so the operator
  // reviews the plan the device just reported rather than a stale one.
  useEffect(() => {
    if (guidedAction === null) return;
    const wanted =
      guidedAction === "initialize" ? "initialize" : guidedAction === "seed" ? "seed" : "resync";
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const plans = await api.folderPlans(folderId, 3);
          if (cancelled) return;
          const relevant = plans.find((p) => p.plan.intervention === wanted);
          if (relevant) setGuided((prev) => (prev ? { ...prev, plan: relevant } : prev));
        } catch {
          // Ignore: the modal keeps its current (possibly empty) plan state.
        }
      })();
    }, 3_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [guidedAction, folderId]);

  /** Execute the reviewed plan. Guarded: a stale plan cannot be approved. */
  const approveGuided = useCallback(async () => {
    if (!guided) return;
    if (!guided.plan) {
      setGuided({ ...guided, error: "Wait for the dry run to finish before approving." });
      return;
    }
    if (!guided.plan.validity.valid) {
      setGuided({
        ...guided,
        error: `${planValiditySentence(guided.plan)} Plan again to continue.`,
      });
      return;
    }
    setBusy(true);
    try {
      const resolvedAuthority = authorityForAction(guided.action, authority) ?? "remote";
      await send("folder_intervention", {
        folderId,
        intervention:
          guided.action === "initialize"
            ? "initialize"
            : guided.action === "seed"
              ? "seed"
              : "resync",
        authority: resolvedAuthority,
        planId: guided.plan.plan.id,
        confirm: true,
      });
      onQueued?.(`${actionLabel(guided.action)} approved and queued.`);
      setGuided(null);
    } catch (err) {
      setGuided({ ...guided, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, [authority, folderId, guided, onQueued, send]);

  const actions = availableHealthActions(record);
  const tone = healthTone(record.state);
  const firstReason = record.reasons[0] ?? null;
  const measurement = measurementSentence(record);
  const watcher = watcherSentence(record);

  return (
    <div className={`folder-health folder-health--${tone}`}>
      <div className="folder-health-head">
        <span className={`badge folder-health-state folder-health-state--${tone}`}>
          {healthLabel(record.state)}
        </span>
        <span className="muted folder-health-freshness">{freshnessSentence(record)}</span>
        {record.active ? <span className="badge badge-unknown">running</span> : null}
      </div>

      {firstReason ? (
        <p className="folder-health-reason">
          {firstReason.message}
          <span className="muted"> — {firstReason.remediation}</span>
        </p>
      ) : null}
      {firstReason === null ? (
        <p className="muted">No issues reported.</p>
      ) : null}

      <dl className="folder-health-facts">
        <div>
          <dt>Baseline</dt>
          <dd>{baselineSentence(record)}</dd>
        </div>
        <div>
          <dt>Filters</dt>
          <dd>{filterSentence(record)}</dd>
        </div>
        <div>
          <dt>Local folder</dt>
          <dd>
            {record.facts.localDir === "ok" ? "Readable and writable" : record.facts.localDir}
            {record.facts.freeSpaceBytes !== null
              ? ` · ${formatBytes(record.facts.freeSpaceBytes)} free`
              : ""}
          </dd>
        </div>
        {record.facts.lastRun ? (
          <div>
            <dt>Last run</dt>
            <dd>
              {record.facts.lastRun.status}
              {record.facts.lastRun.summary ? ` — ${record.facts.lastRun.summary}` : ""}
            </dd>
          </div>
        ) : null}
        {measurement ? (
          <div>
            <dt>Measurement</dt>
            <dd>
              {measurement} · {record.facts.measurement?.pathCount ?? 0} entries,{" "}
              {formatBytes(record.facts.measurement?.totalBytes ?? 0)}
            </dd>
          </div>
        ) : (
          <div>
            <dt>Measurement</dt>
            <dd className="muted">Not measured — Diagnose now measures this device's tree.</dd>
          </div>
        )}
        {watcher ? (
          <div>
            <dt>Watcher</dt>
            <dd>{watcher}</dd>
          </div>
        ) : null}
      </dl>

      {error ? <div className="error">{error}</div> : null}

      <div className="folder-health-actions">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            className={`action ${action === "initialize" || action === "resync" ? "" : "primary"} ${
              action === "cancel" ? "danger" : ""
            }`}
            disabled={busy}
            onClick={() => {
              if (isGuardedAction(action)) {
                void openGuided(action, authority);
                return;
              }
              void runQuickAction(action);
            }}
          >
            {actionLabel(action)}
          </button>
        ))}
      </div>

      {guided ? (
        <Modal
          title={actionLabel(guided.action)}
          onClose={() => setGuided(null)}
          footer={
            <>
              <button type="button" className="action" onClick={() => setGuided(null)} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="action danger"
                disabled={busy || guided.plan === null}
                onClick={() => void approveGuided()}
              >
                Approve and run
              </button>
            </>
          }
        >
          <p className="muted">
            Nothing has changed yet. This builds a dry-run plan on the device, then runs it only
            after you approve it.
          </p>
          {guided.action === "resync" ? (
            <label>
              Which side wins?
              <select
                value={authority}
                onChange={(e) => {
                  const value = e.target.value === "local" ? "local" : "remote";
                  setAuthority(value);
                }}
              >
                <option value="remote">Remote wins (Path 1)</option>
                <option value="local">This device wins (Path 2)</option>
              </select>
            </label>
          ) : null}
          <p className="folder-health-authority">
            <strong>{authorityWording(authorityForAction(guided.action, authority) ?? "remote").short}</strong>
            {" — "}
            {authorityWording(authorityForAction(guided.action, authority) ?? "remote").long}
          </p>

          {guided.planning ? <p className="muted">Running a dry run on the device…</p> : null}
          {guided.error ? <div className="error">{guided.error}</div> : null}
          {guided.plan ? (
            <>
              <p className="folder-health-plan-summary">{guided.plan.plan.summary}</p>
              <p className={guided.plan.validity.valid ? "muted" : "error"}>
                {planValiditySentence(guided.plan)}
              </p>
              <ul className="folder-health-plan-changes">
                {guided.plan.plan.changes.wouldCopy.slice(0, 10).map((p) => (
                  <li key={`c-${p}`}>copy {p}</li>
                ))}
                {guided.plan.plan.changes.wouldDelete.slice(0, 10).map((p) => (
                  <li key={`d-${p}`}>delete {p}</li>
                ))}
                {guided.plan.plan.changes.wouldMkdir.slice(0, 10).map((p) => (
                  <li key={`m-${p}`}>mkdir {p}</li>
                ))}
                {guided.plan.plan.changes.wouldCopy.length === 0 &&
                guided.plan.plan.changes.wouldDelete.length === 0 &&
                guided.plan.plan.changes.wouldMkdir.length === 0 ? (
                  <li className="muted">No file changes detected</li>
                ) : null}
              </ul>
            </>
          ) : !guided.planning ? (
            <p className="muted">
              Waiting for the device to report the plan. If it does not appear, close this and
              press Diagnose now to check the device.
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
