// LAMA-345 stage 4 — the Folder health card.
//
// Diagnose → Plan → Approve → Execute → Verify, in one component per
// assignment row. It renders the state, why it is that state, exact
// remediation, and the contextual actions; the reseeding actions open a
// four-step guided wizard (choose the winning side → preview running → review
// totals and samples → run it).
//
// Nothing here can express an rclone flag: every action is one of the
// allowlisted ids in @lamasync/core/folder-health, and the plan the operator
// reviews is bound to the side and deletion threshold shown in the wizard.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FolderHealthRecord,
  FolderPlanWithValidity,
} from "@lamasync/core/folder-health";
import type { FolderHealthActionId } from "@lamasync/core/folder-health";
import type { QueuedActionType } from "@lamasync/core";
import { api } from "../api.ts";
import { Modal } from "./Modal.tsx";
import {
  HEALTH_GLOSSARY,
  actionLabel,
  actionPurpose,
  actionTone,
  actionChoosesAuthority,
  authorityForAction,
  authorityWording,
  availableHealthActions,
  baselineSentence,
  filterSentence,
  formatBytes,
  freshnessSentence,
  healthLabel,
  healthTone,
  isGuardedAction,
  measurementSentence,
  needsSimpleConfirm,
  planIsFromThisRequest,
  planMatchesSelection,
  planTotals,
  planValiditySentence,
  previewFailureNextStep,
  relativeMinutes,
  technicalDetails,
  watcherSentence,
  wizardStep,
  wizardStepLabel,
  wizardVisibleSteps,
  type WizardStage,
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
  /** Test/UI seam: plan lookup. Defaults to the real API. */
  fetchPlans?: (folderId: string) => Promise<FolderPlanWithValidity[]>;
}

interface WizardState {
  action: FolderHealthActionId;
  stage: WizardStage;
  authority: "remote" | "local";
  maxDeletePercent: number | null;
  /** When the current dry run was requested — used to reject older plans. */
  requestedAt: number | null;
  plan: FolderPlanWithValidity | null;
  error: string | null;
  nextStep: string | null;
}

interface SimpleConfirm {
  action: FolderHealthActionId;
}

export function FolderHealthCard({
  folderId,
  hostId,
  record,
  onQueued,
  enqueue,
  fetchPlans,
}: FolderHealthCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wizard, setWizard] = useState<WizardState | null>(null);
  const [confirming, setConfirming] = useState<SimpleConfirm | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const send = useCallback(
    async (type: QueuedActionType, payload: Record<string, unknown>) => {
      const fn = enqueue ?? ((h, b) => api.enqueueAction(h, b));
      return fn(hostId, { type, payload });
    },
    [enqueue, hostId],
  );

  const loadPlans = useCallback(
    async (): Promise<FolderPlanWithValidity[]> => {
      if (fetchPlans) return fetchPlans(folderId);
      return api.folderPlans(folderId, 5);
    },
    [fetchPlans, folderId],
  );

  /** Read-only and safe: refresh this device's facts and measurement. */
  const runDiagnose = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await send("diagnose_folder", { folderId });
      setStatus("Check queued. The card updates as soon as this device reports back.");
      onQueued?.(`${actionLabel("diagnose")} queued for this device.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [folderId, onQueued, send]);

  const runSyncNow = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await send("trigger_sync", { folderId });
      setStatus("Sync queued. Nothing is copied until this device picks it up.");
      onQueued?.(`${actionLabel("sync")} queued for this device.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [folderId, onQueued, send]);

  /**
   * Continue a stopped run, or stop a live one. Both mutating, both explained
   * first — a confirmation dialog rather than a wizard, because neither takes
   * a plan.
   */
  const runSimple = useCallback(
    async (action: FolderHealthActionId) => {
      setConfirming(null);
      setBusy(true);
      setError(null);
      try {
        if (action === "cancel") {
          await send("folder_intervention", {
            folderId,
            intervention: "cancel",
            confirm: true,
          });
          setStatus("Stop requested. The run ends after the current file.");
        } else {
          // `resume` is a mutation too, so it carries the same explicit
          // confirmation the server requires for every non-cancel intervention.
          await send("folder_intervention", {
            folderId,
            intervention: "resume",
            confirm: true,
          });
          setStatus("Continue queued. Nothing new is discarded — the run picks up where it stopped.");
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

  const openWizard = useCallback((action: FolderHealthActionId) => {
    setError(null);
    setStatus(null);
    setWizard({
      action,
      stage: "choose",
      authority: action === "seed" ? "local" : "remote",
      maxDeletePercent: null,
      requestedAt: null,
      plan: null,
      error: null,
      nextStep: null,
    });
  }, []);

  /** Step 1 → 2: queue the dry run for the chosen side and threshold. */
  const requestPreview = useCallback(async () => {
    if (!wizard) return;
    const requestedAt = Date.now();
    const intervention =
      wizard.action === "initialize" ? "initialize" : wizard.action === "seed" ? "seed" : "resync";
    const authority = authorityForAction(wizard.action, wizard.authority);
    setWizard({
      ...wizard,
      stage: "previewing",
      requestedAt,
      plan: null,
      error: null,
      nextStep: null,
    });
    try {
      await send("plan_folder", {
        folderId,
        intervention,
        authority,
        ...(wizard.maxDeletePercent !== null
          ? { maxDeletePercent: wizard.maxDeletePercent }
          : {}),
      });
      setStatus("Preview queued. It runs read-only on this device; nothing is written.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setWizard((prev) =>
        prev
          ? {
              ...prev,
              stage: "failed",
              error: message,
              nextStep: previewFailureNextStep(message),
            }
          : prev,
      );
    }
  }, [folderId, send, wizard]);

  const wizardStage = wizard?.stage ?? null;
  const wizardAction = wizard?.action ?? null;
  const wizardRequestedAt = wizard?.requestedAt ?? null;
  const wizardAuthority = wizard?.authority ?? "remote";
  const wizardMaxDelete = wizard?.maxDeletePercent ?? null;

  /**
   * While a preview is in flight, look for the plan THIS request produced.
   * Only a plan that matches the selected operation, side and threshold (and
   * that is newer than the request) is accepted — an older plan for the same
   * side must never be shown as if it were current.
   */
  useEffect(() => {
    if (wizardStage !== "previewing" || wizardAction === null || wizardRequestedAt === null) {
      return;
    }
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const plans = await loadPlans();
        if (cancelled) return;
        const match = plans.find(
          (entry) =>
            planIsFromThisRequest(entry.plan, wizardRequestedAt) &&
            planMatchesSelection(entry.plan, {
              intervention: wizardAction,
              authority: wizardAuthority,
              maxDeletePercent: wizardMaxDelete,
            }).ok,
        );
        if (match) {
          setWizard((prev) => (prev ? { ...prev, stage: "review", plan: match } : prev));
        }
      } catch {
        // The wizard keeps waiting; the operator can close it at any time.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 3_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    loadPlans,
    wizardAction,
    wizardAuthority,
    wizardMaxDelete,
    wizardRequestedAt,
    wizardStage,
  ]);

  /** Step 3 → 4: approve. A stale or mismatched plan must never run. */
  const approveWizard = useCallback(async () => {
    if (!wizard || wizard.plan === null) return;
    const selected = {
      intervention: wizard.action,
      authority: wizard.authority,
      maxDeletePercent: wizard.maxDeletePercent,
    };
    const matches = planMatchesSelection(wizard.plan.plan, selected);
    if (!matches.ok) {
      setWizard((prev) =>
        prev ? { ...prev, stage: "failed", error: matches.message, nextStep: previewFailureNextStep("") } : prev,
      );
      return;
    }
    if (!wizard.plan.validity.valid) {
      setWizard((prev) =>
        prev
          ? {
              ...prev,
              stage: "failed",
              error: planValiditySentence(wizard.plan!),
              nextStep: previewFailureNextStep(""),
            }
          : prev,
      );
      return;
    }
    setBusy(true);
    try {
      const intervention =
        wizard.action === "initialize"
          ? "initialize"
          : wizard.action === "seed"
            ? "seed"
            : "resync";
      await send("folder_intervention", {
        folderId,
        intervention,
        authority: authorityForAction(wizard.action, wizard.authority),
        planId: wizard.plan.plan.id,
        ...(wizard.maxDeletePercent !== null
          ? { maxDeletePercent: wizard.maxDeletePercent }
          : {}),
        confirm: true,
      });
      setWizard({ ...wizard, stage: "executing" });
      setStatus("Approved and queued. This device runs the reviewed plan now.");
      onQueued?.(`${actionLabel(wizard.action)} approved and queued.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setWizard((prev) =>
        prev
          ? { ...prev, stage: "failed", error: message, nextStep: previewFailureNextStep(message) }
          : prev,
      );
    } finally {
      setBusy(false);
    }
  }, [folderId, onQueued, send, wizard]);

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
      ) : (
        <p className="muted">No issues reported.</p>
      )}

      <dl className="folder-health-facts">
        <div>
          <dt>Sync record</dt>
          <dd>{baselineSentence(record)}</dd>
        </div>
        <div>
          <dt>Ignore set</dt>
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
        <div>
          <dt>Measurement</dt>
          {measurement ? (
            <dd>
              {measurement} · {record.facts.measurement?.pathCount ?? 0} entries,{" "}
              {formatBytes(record.facts.measurement?.totalBytes ?? 0)}
            </dd>
          ) : (
            <dd className="muted">
              Not measured — Check this device now measures this device&rsquo;s tree.
            </dd>
          )}
        </div>
        {watcher ? (
          <div>
            <dt>Watching</dt>
            <dd>{watcher}</dd>
          </div>
        ) : null}
      </dl>

      {/* Polite live region: queued/reviewed status without stealing focus. */}
      <p className="folder-health-status muted" role="status" aria-live="polite">
        {status ?? ""}
      </p>
      <div className="error" role="alert" aria-live="assertive">
        {error ?? ""}
      </div>

      <div className="folder-health-actions">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            className={actionButtonClass(action)}
            disabled={busy || action === "cancel"}
            onClick={() => {
              if (isGuardedAction(action)) {
                openWizard(action);
                return;
              }
              if (needsSimpleConfirm(action)) {
                setConfirming({ action });
                return;
              }
              if (action === "diagnose") void runDiagnose();
              else if (action === "sync") void runSyncNow();
            }}
          >
            {actionLabel(action)}
          </button>
        ))}
        {/* Stop is offered only while a run is live, and is never confused
            with the read-only checks above it. */}
        {record.active || record.state === "busy" ? (
          <button
            type="button"
            className="action danger"
            disabled={busy}
            onClick={() => setConfirming({ action: "cancel" })}
          >
            {actionLabel("cancel")}
          </button>
        ) : null}
      </div>

      <details className="folder-health-glossary">
        <summary>What do these terms mean?</summary>
        <dl>
          {HEALTH_GLOSSARY.map((entry) => (
            <div key={entry.term}>
              <dt>{entry.term}</dt>
              <dd>{entry.plain}</dd>
            </div>
          ))}
        </dl>
      </details>

      {confirming ? (
        <Modal
          title={actionLabel(confirming.action)}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <button type="button" className="action" onClick={() => setConfirming(null)} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className={`action ${confirming.action === "cancel" ? "danger" : "primary"}`}
                disabled={busy}
                onClick={() => void runSimple(confirming.action)}
              >
                {confirming.action === "cancel" ? "Stop the run" : "Continue the sync"}
              </button>
            </>
          }
        >
          {confirming.action === "cancel" ? (
            <>
              <p>
                This stops the run that is happening on this device right now. The current file
                finishes, then rclone exits.
              </p>
              <p className="muted">
                Stopping is not a failure: the saved sync record is left as it was, so you can
                continue later without rebuilding anything.
              </p>
            </>
          ) : (
            <>
              <p>
                This continues the sync that stopped earlier on this device. It reuses the saved
                sync record, so nothing already synced is copied again.
              </p>
              <p className="muted">
                Unlike rebuilding the baseline, this does not discard the record and does not need
                a winning side to be chosen.
              </p>
            </>
          )}
          <details className="folder-health-technical">
            <summary>Technical details</summary>
            <ul>
              {technicalDetails(confirming.action, "remote", null).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </details>
        </Modal>
      ) : null}

      {wizard ? (
        <Modal
          title={actionLabel(wizard.action)}
          onClose={() => setWizard(null)}
          footer={
            <FolderHealthWizardFooter
              action={wizard.action}
              stage={wizard.stage}
              busy={busy}
              hasPlan={wizard.plan !== null}
              onClose={() => setWizard(null)}
              onPreview={() => void requestPreview()}
              onApprove={() => void approveWizard()}
              onRetry={() =>
                setWizard({ ...wizard, stage: "choose", error: null, nextStep: null, plan: null })
              }
            />
          }
        >
          <FolderHealthWizard
            action={wizard.action}
            stage={wizard.stage}
            authority={wizard.authority}
            maxDeletePercent={wizard.maxDeletePercent}
            plan={wizard.plan}
            error={wizard.error}
            nextStep={wizard.nextStep}
            onAuthorityChange={(authority) =>
              // Changing the side invalidates the preview: the plan must be
              // rebuilt for the newly chosen side, never approved under the
              // previous one.
              setWizard((prev) => (prev ? { ...prev, authority, plan: null, stage: "choose" } : prev))
            }
            onMaxDeletePercentChange={(value) =>
              setWizard((prev) =>
                prev ? { ...prev, maxDeletePercent: value, plan: null, stage: "choose" } : prev,
              )
            }
          />
        </Modal>
      ) : null}
    </div>
  );
}

/** Footer actions for the guided wizard, gated by the current step. */
export function FolderHealthWizardFooter({
  action,
  stage,
  busy,
  hasPlan,
  onClose,
  onPreview,
  onApprove,
  onRetry,
}: {
  action: FolderHealthActionId;
  stage: WizardStage;
  busy: boolean;
  hasPlan: boolean;
  onClose: () => void;
  onPreview: () => void;
  onApprove: () => void;
  onRetry: () => void;
}) {
  return (
    <>
      <button type="button" className="action" onClick={onClose} disabled={busy}>
        {stage === "executing" ? "Close" : "Cancel"}
      </button>
      {stage === "choose" ? (
        <button type="button" className="action primary" disabled={busy} onClick={onPreview}>
          Preview changes
        </button>
      ) : null}
      {stage === "review" ? (
        <button
          type="button"
          className="action danger"
          disabled={busy || !hasPlan}
          onClick={onApprove}
        >
          Run it now
        </button>
      ) : null}
      {stage === "failed" ? (
        <button type="button" className="action primary" disabled={busy} onClick={onRetry}>
          Preview again
        </button>
      ) : null}
      <span className="visually-hidden" aria-live="polite">
        {stage === "review" && hasPlan ? `${actionLabel(action)} is ready to review and run.` : ""}
      </span>
    </>
  );
}

export interface FolderHealthWizardProps {
  action: FolderHealthActionId;
  stage: WizardStage;
  authority: "remote" | "local";
  maxDeletePercent: number | null;
  plan: FolderPlanWithValidity | null;
  error: string | null;
  nextStep: string | null;
  onAuthorityChange: (authority: "remote" | "local") => void;
  onMaxDeletePercentChange: (value: number | null) => void;
}

/**
 * The guided flow body. Presentational on purpose: the card owns the
 * orchestration (enqueue, poll, approve) and this renders one of the four
 * explicit steps, so every step can be pinned by a static-markup test.
 */
export function FolderHealthWizard({
  action,
  stage,
  authority,
  maxDeletePercent,
  plan,
  error,
  nextStep,
  onAuthorityChange,
  onMaxDeletePercentChange,
}: FolderHealthWizardProps) {
  return (
    <>
      <WizardSteps action={action} stage={stage} />

      {stage === "choose" ? (
        <div className="folder-health-wizard-step">
          <p>{actionPurpose(action)}</p>
          {actionChoosesAuthority(action) ? (
            <label htmlFor="folder-health-authority">
              Which version should win when a file changed on both sides?
              <select
                id="folder-health-authority"
                name="folder-health-authority"
                value={authority}
                onChange={(e) => onAuthorityChange(e.target.value === "local" ? "local" : "remote")}
              >
                <option value="remote">Keep the remote&rsquo;s version</option>
                <option value="local">Keep this device&rsquo;s version</option>
              </select>
            </label>
          ) : null}
          <p className="folder-health-authority">
            <strong>{authorityWording(authorityForAction(action, authority) ?? "remote").short}</strong>
            {" — "}
            {authorityWording(authorityForAction(action, authority) ?? "remote").long}
          </p>
          <label htmlFor="folder-health-maxdelete">
            Deletion threshold (per cent)
            <input
              id="folder-health-maxdelete"
              name="folder-health-maxdelete"
              type="number"
              min={0}
              max={100}
              step={1}
              autoComplete="off"
              inputMode="numeric"
              placeholder="rclone&rsquo;s default (50%)"
              value={maxDeletePercent ?? ""}
              onChange={(e) => {
                const raw = e.target.value.trim();
                const parsed = raw === "" ? null : Number.parseInt(raw, 10);
                onMaxDeletePercentChange(
                  parsed === null || Number.isNaN(parsed) ? null : Math.min(100, Math.max(0, parsed)),
                );
              }}
            />
            <span className="muted">
              The run stops before deleting more than this share of a side&rsquo;s files. Leaving it
              blank uses rclone&rsquo;s own limit — 50%, never &ldquo;no limit&rdquo;.
            </span>
          </label>
          <details className="folder-health-technical">
            <summary>Technical details</summary>
            <ul>
              {technicalDetails(
                action,
                authorityForAction(action, authority) ?? "remote",
                maxDeletePercent,
              ).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}

      {stage === "previewing" ? (
        <div className="folder-health-wizard-step">
          <p role="status" aria-live="polite">
            Running a read-only preview on this device&hellip; nothing has been written yet.
          </p>
          <p className="muted">
            A large folder takes a while: this lists both sides completely so the numbers below are
            real. You can close this and come back — the folder is unchanged.
          </p>
        </div>
      ) : null}

      {stage === "review" && plan ? (
        <PlanReview
          action={action}
          authority={authority}
          maxDeletePercent={maxDeletePercent}
          entry={plan}
        />
      ) : null}

      {stage === "executing" ? (
        <div className="folder-health-wizard-step">
          <p role="status" aria-live="polite">
            Approved and queued. This device is running the plan you reviewed.
          </p>
          <p className="muted">
            The card updates with progress and the result. Afterwards, run Check this device now to
            confirm the new sync record — LamaSync only reports success once the saved record is
            complete.
          </p>
        </div>
      ) : null}

      {stage === "failed" ? (
        <div className="folder-health-wizard-step">
          <p className="error" role="alert" aria-live="assertive">
            {error}
          </p>
          <p>{nextStep}</p>
        </div>
      ) : null}
    </>
  );
}

function actionButtonClass(action: FolderHealthActionId): string {
  const tone = actionTone(action);
  if (tone === "primary") return "action primary";
  if (tone === "danger") return "action danger";
  return "action";
}

function WizardSteps({ action, stage }: { action: FolderHealthActionId; stage: WizardStage }) {
  const visible = wizardVisibleSteps(action);
  const current = wizardStep(stage);
  return (
    <ol className="folder-health-steps" aria-label="Steps">
      {visible.map((step) => (
        <li
          key={step}
          className={
            step === current
              ? "folder-health-step folder-health-step--current"
              : step < current
                ? "folder-health-step folder-health-step--done"
                : "folder-health-step"
          }
          aria-current={step === current ? "step" : undefined}
        >
          <span className="folder-health-step-index">{step}</span>
          {wizardStepLabel(step)}
        </li>
      ))}
    </ol>
  );
}

function PlanReview({
  action,
  authority,
  maxDeletePercent,
  entry,
}: {
  action: FolderHealthActionId;
  authority: "remote" | "local";
  maxDeletePercent: number | null;
  entry: FolderPlanWithValidity;
}) {
  const totals = planTotals(entry.plan);
  const matches = planMatchesSelection(entry.plan, {
    intervention: action,
    authority,
    maxDeletePercent,
  });
  const created = relativeMinutes(Date.now() - entry.plan.createdAt);
  return (
    <div className="folder-health-wizard-step">
      <p className="folder-health-plan-summary">{entry.plan.summary}</p>
      <p className={entry.validity.valid && matches.ok ? "muted" : "error"}>
        {matches.ok ? planValiditySentence(entry) : matches.message}
      </p>
      <p className="muted">Previewed {created} ago.</p>

      <dl className="folder-health-totals">
        <div>
          <dt>To copy</dt>
          <dd>{totals.copies}</dd>
        </div>
        <div>
          <dt>To delete</dt>
          <dd className={totals.deletes > 0 ? "folder-health-totals-delete" : undefined}>
            {totals.deletes}
          </dd>
        </div>
        <div>
          <dt>Folders to create</dt>
          <dd>{totals.mkdirs}</dd>
        </div>
        <div>
          <dt>Data (reported)</dt>
          <dd>{totals.bytes > 0 ? formatBytes(totals.bytes) : "not reported"}</dd>
        </div>
      </dl>

      {totals.deletes > 0 ? (
        <p className="folder-health-warning">
          This plan deletes {totals.deletes} {totals.deletes === 1 ? "item" : "items"} on one side.
          Check the sample list below before running it.
        </p>
      ) : (
        <p className="muted">Nothing would be deleted by this plan.</p>
      )}

      <details className="folder-health-samples" open={totals.deletes > 0}>
        <summary>Sample of what would change</summary>
        {totals.sampled ? (
          <p className="muted">
            This device keeps the first {totals.sampleCap} entries per list, so the sample below is
            the beginning of each list — the totals above are exact.
          </p>
        ) : null}
        <ul>
          {entry.plan.changes.wouldCopy.map((p) => (
            <li key={`c-${p}`}>copy {p}</li>
          ))}
          {entry.plan.changes.wouldDelete.map((p) => (
            <li key={`d-${p}`}>delete {p}</li>
          ))}
          {entry.plan.changes.wouldMkdir.map((p) => (
            <li key={`m-${p}`}>create folder {p}</li>
          ))}
          {totals.copies === 0 && totals.deletes === 0 && totals.mkdirs === 0 ? (
            <li className="muted">No file changes detected</li>
          ) : null}
        </ul>
      </details>

      <p className="folder-health-authority">
        <strong>{authorityWording(entry.plan.authority).short}</strong>
        {" — "}
        {authorityWording(entry.plan.authority).conflict}
      </p>
      <details className="folder-health-technical">
        <summary>Technical details</summary>
        <ul>
          {technicalDetails(action, entry.plan.authority, entry.plan.maxDeletePercent).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
