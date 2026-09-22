// LAMA-346 — the "large initial transfer" seed panel.
//
// One panel per sync assignment, rendered beside the Folder health card. It
// does three things and nothing more:
//
//   1. says whether a seed transfer is RECOMMENDED for this device (above
//      3,000 entries) and that nothing happens without an explicit approval;
//   2. prepares and shows a read-only plan — source size, archive format,
//      staging rule, and the exact free space the target must reserve;
//   3. reports the execution verdict honestly. Seed execution is not
//      implemented yet, so the Run control is DISABLED with the server's own
//      reason — never a button that pretends to work.
//
// Nothing here can express an rclone flag or a path: the only inputs are the
// allowlisted API calls.

import { useCallback, useEffect, useState } from "react";
import type { FolderHealthRecord } from "@lamasync/core/folder-health";
import type { SeedJob, SeedPlan, SeedPlanValidity } from "@lamasync/core/folder-seed";
import { api } from "../api.ts";
import {
  SEED_GLOSSARY,
  seedArchiveSentence,
  seedJobTone,
  seedPhaseLabel,
  seedProgressPercent,
  seedProgressSentence,
  seedRecommendationSentence,
  seedRecommended,
  seedRunnableVerdict,
  seedSpaceSentence,
  seedSpaceTone,
  seedStagingSentence,
  seedUnavailableHelp,
  shouldOfferSeed,
  type SeedTone,
} from "../folder-seed.ts";

export interface FolderSeedPlanCardProps {
  folderId: string;
  hostId: string;
  record: FolderHealthRecord;
  /** Test/UI seam: plan lookup. Defaults to the real API. */
  fetchPlans?: (folderId: string) => Promise<Array<{ plan: SeedPlan; validity: SeedPlanValidity }>>;
  /** Test/UI seam: plan creation. Defaults to the real API. */
  preparePlan?: (folderId: string, hostId: string) => Promise<{ plan: SeedPlan; validity: SeedPlanValidity }>;
  /** Test/UI seam: job creation. Defaults to the real API. */
  startJob?: (planId: string) => Promise<SeedJob>;
}

export function FolderSeedPlanCard({
  folderId,
  hostId,
  record,
  fetchPlans,
  preparePlan,
  startJob,
}: FolderSeedPlanCardProps) {
  const [entry, setEntry] = useState<{ plan: SeedPlan; validity: SeedPlanValidity } | null>(null);
  const [job, setJob] = useState<SeedJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const loadPlans = useCallback(async () => {
    const fn = fetchPlans ?? ((id: string) => api.seedPlans(id, 1));
    return fn(folderId);
  }, [fetchPlans, folderId]);

  const loadJobs = useCallback(async () => {
    return api.seedJobs(folderId, 1);
  }, [folderId]);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const plans = await loadPlans();
        if (cancelled) return;
        const forHost = plans.find((p) => p.plan.hostId === hostId) ?? null;
        setEntry(forHost);
        if (forHost) {
          const jobs = await loadJobs();
          if (cancelled) return;
          setJob(jobs.find((j) => j.planId === forHost.plan.id) ?? null);
        }
      } catch {
        // A missing plan list is not an error state for the panel.
      }
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [hostId, loadJobs, loadPlans]);

  const onPrepare = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const fn =
        preparePlan ??
        ((id: string, host: string) => api.createSeedPlan(id, { hostId: host, confirm: true }));
      const created = await fn(folderId, hostId);
      setEntry(created);
      setStatus(
        "Plan prepared. Nothing has been transferred and nothing on the target has changed — this is a read-only measurement.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [folderId, hostId, preparePlan]);

  const onStart = useCallback(async () => {
    if (!entry) return;
    setBusy(true);
    setError(null);
    try {
      const fn = startJob ?? ((planId: string) => api.createSeedJob({ planId, confirm: true }));
      const created = await fn(entry.plan.id);
      setJob(created);
      setStatus("Seed job created. The device will report each phase as it runs.");
    } catch (err) {
      // The server refuses with an explicit reason while the transport is
      // unimplemented; surface it verbatim instead of inventing one.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [entry, startJob]);

  // Non-bisync folders have no seed path at all.
  if (record.facts.effectiveType !== "sync") return null;

  const recommended = seedRecommended(record);
  const offer = shouldOfferSeed(record);
  const verdict = entry
    ? seedRunnableVerdict(entry.plan, entry.validity)
    : null;

  return (
    <div className="folder-seed" data-testid="folder-seed-panel">
      <details open={recommended || entry !== null}>
        <summary>
          <span className="folder-seed-title">Large initial transfer (seed)</span>
          {recommended ? (
            <span className="badge folder-seed-badge folder-seed-badge--warn">recommended</span>
          ) : null}
        </summary>

        <p className="folder-seed-recommendation">{seedRecommendationSentence(record)}</p>

        {!offer ? (
          <p className="muted">
            Choose <strong>Check this device now</strong> on this device to measure the folder before preparing a seed
            plan.
          </p>
        ) : null}

        {offer && entry === null ? (
          <div className="folder-seed-actions">
            <button type="button" className="action" disabled={busy} onClick={() => void onPrepare()}>
              Prepare a seed plan (read-only)
            </button>
          </div>
        ) : null}

        {entry ? <SeedPlanSummary plan={entry.plan} validity={entry.validity} /> : null}

        {entry && verdict ? (
          <div className={`folder-seed-verdict folder-seed-verdict--${verdict.runnable ? "ok" : "bad"}`}>
            <p>{verdict.message}</p>
            {!verdict.runnable && !entry.plan.execution.available ? (
              <p className="muted">{seedUnavailableHelp()}</p>
            ) : null}
            <div className="folder-seed-actions">
              <button
                type="button"
                className="action primary"
                disabled={busy || !verdict.runnable}
                onClick={() => void onStart()}
                aria-disabled={busy || !verdict.runnable}
              >
                Start the seed transfer
              </button>
              {!verdict.runnable ? (
                <span className="muted folder-seed-disabled-reason">
                  Unavailable: {entry.plan.execution.available ? "the plan is not runnable" : "seed transport not implemented"}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {job ? <SeedJobProgress job={job} /> : null}

        <p className="folder-seed-status muted" role="status" aria-live="polite">
          {status ?? ""}
        </p>
        <div className="error" role="alert" aria-live="assertive">
          {error ?? ""}
        </div>

        <details className="folder-seed-glossary">
          <summary>What do these terms mean?</summary>
          <dl>
            {SEED_GLOSSARY.map((item) => (
              <div key={item.term}>
                <dt>{item.term}</dt>
                <dd>{item.plain}</dd>
              </div>
            ))}
          </dl>
        </details>
      </details>
    </div>
  );
}

/** Presentational: the plan's facts, in the operator's language. */
export function SeedPlanSummary({
  plan,
  validity,
}: {
  plan: SeedPlan;
  validity: SeedPlanValidity;
}) {
  const tone = seedSpaceTone(plan);
  return (
    <div className="folder-seed-plan">
      <dl className="folder-seed-facts">
        <div>
          <dt>Source size</dt>
          <dd>
            {plan.source.fileCount.toLocaleString("en-US")} entries ·{" "}
            {plan.source.totalBytes > 0 ? formatBytes(plan.source.totalBytes) : "size not measured"}
            {plan.source.measuredOnHostId ? <span className="muted"> (measured on {plan.source.measuredOnHostId})</span> : null}
          </dd>
        </div>
        <div>
          <dt>Target free space</dt>
          <dd>{plan.target.freeBytes === null ? "not reported" : formatBytes(plan.target.freeBytes)}</dd>
        </div>
        <div>
          <dt>Space to reserve</dt>
          <dd className={`folder-seed-space folder-seed-space--${tone}`}>
            {formatBytes(plan.space.requiredFreeBytes)}
            {plan.space.ok ? null : (
              <span className="folder-seed-warning"> — {formatBytes(plan.space.shortfallBytes)} short</span>
            )}
          </dd>
        </div>
      </dl>

      <p className={tone === "ok" ? "muted" : "folder-seed-warning"}>{seedSpaceSentence(plan)}</p>
      <p className="muted">{seedArchiveSentence(plan)}</p>
      <p className="muted">{seedStagingSentence(plan)}</p>
      <p className={validity.valid ? "muted" : "folder-seed-warning"}>
        {validity.valid ? "This plan is still current." : validity.message}
      </p>

      <details className="folder-seed-technical">
        <summary>Technical details</summary>
        <ul>
          <li>
            Peak staging footprint: archive ({formatBytes(plan.space.archiveBytesEstimate)}) + extracted tree (
            {formatBytes(plan.space.extractedBytes)}), times the safety factor, plus fixed overhead.
          </li>
          <li>
            The archive is built with {plan.archive.format === "tar.zstd" ? "tar + zstd" : "tar + gzip"} and verified
            by SHA-256 before anything is unpacked.
          </li>
          <li>
            The staging directory is a sibling of the target and is published with a single atomic rename. A non-empty
            target is refused rather than merged.
          </li>
          <li>
            After publishing, a fresh bisync baseline validation must report zero content changes; otherwise the seed is
            treated as failed.
          </li>
        </ul>
      </details>
    </div>
  );
}

/** Presentational: the job's phase, counters and outcome. */
export function SeedJobProgress({ job }: { job: SeedJob }) {
  const tone: SeedTone = seedJobTone(job.status);
  const percent = seedProgressPercent(job);
  return (
    <div className={`folder-seed-job folder-seed-job--${tone}`}>
      <div className="folder-seed-job-head">
        <span className={`badge folder-seed-badge folder-seed-badge--${tone}`}>{seedPhaseLabel(job.phase)}</span>
        <span className="muted">{job.status}</span>
      </div>
      <p className="folder-seed-progress">{seedProgressSentence(job)}</p>
      {percent !== null ? (
        <progress
          className="folder-seed-progressbar"
          max={100}
          value={percent}
          aria-label={`${seedPhaseLabel(job.phase)}: ${percent}%`}
        />
      ) : null}
      {job.progress.message ? <p className="muted">{job.progress.message}</p> : null}
      {job.error ? (
        <p className="error" role="alert">
          {job.error}
        </p>
      ) : null}
      {job.summary ? <p className="muted">{job.summary}</p> : null}
    </div>
  );
}

/** Local byte formatting so the panel does not import the whole barrel. */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "unknown";
  if (n < 1024) return `${Math.floor(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
