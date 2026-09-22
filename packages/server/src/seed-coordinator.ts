// LAMA-346 Stage 2b — test-only seed job orchestration.
//
// This module drives ONE seed job through the EXISTING job state machine: the
// phases, the progress records, the renewable lease, the terminal outcomes and
// the archive facts are all the ones `seed-jobs.ts` and `folder-seed.ts`
// already define. It invents no parallel state, adds no table and no column,
// and it does not decide whether a seed is allowed — the plan and the job do.
//
// It exists to close the orchestration proof gap: Stage 2a proved the
// primitives compose locally, and this proves the LIFECYCLE around them is
// legal and safe — that a job moves one phase at a time, that its lease is
// renewed while work is in flight, that archive facts are persisted where the
// target can verify against them, that a cancellation or a lost lease stops
// the work instead of racing it, and that a terminal job's objects are cleaned
// up idempotently.
//
// WHY IT IS TEST-ONLY
//
// The two sides are injected. The server package must not import the daemon's
// archive, filter-universe or transport modules, and no production module
// imports this one — `seed-coordinator-bounded.test.ts` reads the module graph
// to assert that, and `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` stays `false`, so
// `POST /seed-jobs` still refuses. The relay store is injected too: the tests
// pass a local object store, and nothing here can reach a configured backend,
// a credential, an rclone config or a live host.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
//   * no resume: a job that fails is not restarted from its persisted phase
//     (the phase is recorded, so a later slice can);
//   * no scheduling, no WebSocket broadcast, no HTTP route — the server routes
//     remain the only production surface, and they are unchanged;
//   * no `--resync` of a live folder and no rclone invocation of any kind. The
//     baseline phase asks the TARGET side for a verdict and refuses to complete
//     the job without one.

import {
  SEED_JOB_LEASE_MS,
  canTransitionSeedPhase,
  initialSeedRelayCleanup,
  isTerminalSeedPhase,
  seedArchiveObjectKey,
  seedProgressFraction,
  startSeedProgress,
  type SeedArchiveFormat,
  type SeedJob,
  type SeedJobArchiveFacts,
  type SeedJobPhase,
  type SeedJobPhaseOrTerminal,
  type SeedRelayCleanup,
  type SeedRelayStore,
} from "@lamasync/core";
import {
  finishSeedJob,
  getSeedJob,
  updateSeedJobArchive,
  updateSeedJobProgress,
} from "./seed-jobs.ts";

/**
 * The cleanup step, injected like the two sides.
 *
 * The policy lives with the relay contract (it is pure logic over the store
 * interface), and its implementation ships with the daemon's transport module —
 * which this package must not import. Injecting it keeps that boundary and
 * keeps the coordinator honest: cleanup is REQUIRED, so it cannot be skipped.
 */
export type SeedCleanupStep = (input: {
  store: SeedRelayStore;
  keys: readonly string[];
  cleanup: SeedRelayCleanup;
  now: number;
}) => Promise<{
  cleanup: SeedRelayCleanup;
  deleted: string[];
  complete: boolean;
  error: string | null;
}>;

/** How long a lease renewal is asked for. The route clamps it the same way. */
export const SEED_COORDINATOR_LEASE_MS = SEED_JOB_LEASE_MS;
const LEASE_MIN_MS = 30_000;
const LEASE_MAX_MS = 60 * 60_000;
const MESSAGE_MAX = 300;

/** The phases the coordinator drives, in the order the state machine defines. */
export const SEED_COORDINATOR_PHASES = [
  "measuring_source",
  "archiving_source",
  "uploading_archive",
  "downloading_archive",
  "verifying_archive",
  "extracting_target",
  "verifying_target",
  "publishing",
  "baseline_validation",
] as const satisfies readonly SeedJobPhase[];

export type SeedCoordinatorPhase = (typeof SEED_COORDINATOR_PHASES)[number];

/**
 * What a side reports back. Both sides return the same shape so the
 * coordinator can persist it without knowing what happened inside.
 */
export interface SeedSideOutcome {
  ok: boolean;
  /** Bounded, credential-free reason when `ok` is false. */
  error: string | null;
  /** Archive facts to persist. The source fills the immutable metadata. */
  archive: SeedJobArchiveFacts | null;
  /**
   * The target's verdict on the published tree. A job may only COMPLETE with a
   * passing verdict, so a seed can never be reported as done without the
   * zero-content-change check having run.
   */
  baseline: SeedBaselineVerdict | null;
}

export interface SeedBaselineVerdict {
  validated: boolean;
  /** How it was validated, e.g. `manifest-equality` or `rclone-bisync`. */
  method: string;
  message: string;
}

/**
 * The handle a side uses to drive the job. Every method is the coordinator's,
 * so a side cannot write an illegal phase or forge an owner.
 */
export interface SeedPhaseReporter {
  /** The job as the coordinator last read it. */
  readonly job: SeedJob;
  /**
   * Advance to `phase` and record fresh progress. Refuses an illegal
   * transition (a side may not skip a phase) and refuses to act once the lease
   * is lost or the job is terminal.
   */
  enter(phase: SeedCoordinatorPhase, message: string, totals?: SeedProgressTotals): boolean;
  /** Update the current phase's bounded progress and renew the lease. */
  report(update: SeedProgressUpdate): boolean;
  /** True while this owner still holds the job and it is not terminal. */
  owned(): boolean;
  /** The current phase, as last persisted. */
  currentPhase(): SeedJobPhaseOrTerminal;
}

export interface SeedProgressTotals {
  bytesTotal?: number | null;
  entriesTotal?: number | null;
}

export interface SeedProgressUpdate {
  bytesDone?: number;
  entriesDone?: number;
  message?: string;
}

export type SeedSide = (reporter: SeedPhaseReporter) => Promise<SeedSideOutcome>;

export interface SeedCoordinatorOptions {
  db: Parameters<typeof getSeedJob>[0];
  store: SeedRelayStore;
  jobId: string;
  /** The lease owner id — daemon-shaped, e.g. the source host id. */
  owner: string;
  /** Injected: the source side's work (measure, archive, upload). */
  source: SeedSide;
  /** Injected: the target side's work (download, verify, extract, publish). */
  target: SeedSide;
  /** Injected: the idempotent cleanup of the job's relay objects. */
  cleanup: SeedCleanupStep;
  now?: () => number;
  leaseMs?: number;
  /**
   * Observability for tests and logs. Events carry phase names, reasons and
   * byte counts only — never a credential or a path from the store's config.
   */
  onEvent?: (event: SeedCoordinatorEvent) => void;
}

export type SeedCoordinatorEventKind =
  | "phase"
  | "progress"
  | "archive"
  | "cleanup"
  | "completed"
  | "failed"
  | "cancelled"
  | "lease_lost"
  | "illegal_phase";

export interface SeedCoordinatorEvent {
  kind: SeedCoordinatorEventKind;
  phase: SeedJobPhaseOrTerminal;
  message: string;
  bytesDone?: number;
  bytesTotal?: number | null;
}

export type SeedCoordinatorStatus = "completed" | "failed" | "cancelled" | "lease_lost";

export interface SeedCoordinatorOutcome {
  status: SeedCoordinatorStatus;
  /** The job as persisted at the end. */
  job: SeedJob;
  /** Bounded reason for a non-completed outcome. */
  error: string | null;
  /** The object keys the coordinator cleaned up. */
  cleanedKeys: string[];
  /** Phases the coordinator actually entered, in order. */
  phases: SeedJobPhase[];
}

function boundedMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX);
}

/**
 * Run one seed job to a terminal outcome, or stop safely when the lease is
 * gone.
 *
 * The shape of the run:
 *
 *   1. CLAIM — report `preflight` progress as this owner, which is what sets
 *      the lease and flips the job to `running` (the same contract the device
 *      route uses).
 *   2. SOURCE — the injected source side drives `measuring_source` →
 *      `archiving_source` → `uploading_archive`, and its returned archive facts
 *      are persisted with `updateSeedJobArchive`.
 *   3. TARGET — the injected target side drives `downloading_archive` →
 *      `verifying_archive` → `extracting_target` → `verifying_target` →
 *      `publishing` → `baseline_validation`.
 *   4. TERMINAL — `completed` only with a passing baseline verdict; otherwise
 *      `failed` with a bounded reason. A job that was cancelled underneath the
 *      run stays `cancelled`, and a job whose lease was lost is left alone.
 *   5. CLEANUP — the relay object is removed and the cleanup state recorded on
 *      the job, in every terminal case, idempotently.
 *
 * A side that asks for an illegal phase transition FAILS the job rather than
 * skipping: that is a bug in the side, and the state machine must not be
 * silently loosened to accommodate it.
 */
export async function runSeedJob(options: SeedCoordinatorOptions): Promise<SeedCoordinatorOutcome> {
  const now = options.now ?? (() => Date.now());
  const leaseMs = Math.min(Math.max(options.leaseMs ?? SEED_COORDINATOR_LEASE_MS, LEASE_MIN_MS), LEASE_MAX_MS);
  const phases: SeedJobPhase[] = [];
  const emit = (event: SeedCoordinatorEvent): void => options.onEvent?.(event);

  const read = (): SeedJob | null => getSeedJob(options.db, options.jobId);
  let job = read();
  if (job === null) {
    throw new Error(`seed job ${options.jobId} does not exist`);
  }

  /** Persist a progress record (and the lease) for the CURRENT phase. */
  const writeProgress = (
    phase: SeedJobPhase,
    message: string,
    totals: SeedProgressTotals,
    update: SeedProgressUpdate,
  ): SeedJob | null => {
    const stamp = now();
    const progress = startSeedProgress(phase, stamp, boundedMessage(message), {
      bytesTotal: totals.bytesTotal ?? null,
      entriesTotal: totals.entriesTotal ?? null,
    });
    progress.bytesDone = Math.max(0, Math.trunc(update.bytesDone ?? 0));
    progress.entriesDone = Math.max(0, Math.trunc(update.entriesDone ?? 0));
    return updateSeedJobProgress(options.db, options.jobId, progress, {
      owner: options.owner,
      expiresAt: stamp + leaseMs,
    });
  };

  /**
   * Ownership: this owner holds the lease AND the job has not ended. A job that
   * is `planned` with no owner is claimable; anything else owned by someone
   * else is not ours.
   */
  const owned = (): boolean => {
    const current = read();
    if (current === null) return false;
    if (isTerminalSeedPhase(current.phase)) return false;
    if (current.leaseOwner === null) return true;
    return current.leaseOwner === options.owner;
  };

  // 1. CLAIM. Reporting `preflight` is legal (re-entering the current phase is
  //    allowed) and is exactly what the device progress route does, so the
  //    lease and the `running` status come from the existing contract.
  const claimed = writeProgress("preflight", "Seed job claimed by the coordinator.", {}, {});
  if (claimed === null) {
    // Another owner holds it, or it ended while we were starting.
    const current = read() ?? job;
    return {
      status: isTerminalSeedPhase(current.phase) ? "cancelled" : "lease_lost",
      job: current,
      error: isTerminalSeedPhase(current.phase)
        ? `the seed job already ended (${current.phase}) before this owner claimed it`
        : "another owner holds this seed job's lease",
      cleanedKeys: [],
      phases,
    };
  }
  job = claimed;
  let currentPhase: SeedJobPhaseOrTerminal = "preflight";
  /**
   * A latched refusal. A side that asks for an illegal transition has a bug,
   * and a side that ignores the refusal must not be able to walk the job to
   * `completed` anyway: the refusal is recorded here and turns the run into a
   * failure even if the side reports success.
   */
  let illegalTransition: string | null = null;

  const reporter: SeedPhaseReporter = {
    get job() {
      return read() ?? job;
    },
    currentPhase: () => currentPhase,
    owned,
    enter(phase, message, totals = {}) {
      if (!owned()) return false;
      if (!canTransitionSeedPhase(currentPhase, phase)) {
        const message = `refused illegal transition ${currentPhase} → ${phase}; seed phases move forward one step at a time`;
        illegalTransition = illegalTransition ?? message;
        emit({ kind: "illegal_phase", phase: currentPhase, message });
        return false;
      }
      const updated = writeProgress(phase, message, totals, {});
      if (updated === null) return false;
      currentPhase = phase;
      phases.push(phase);
      emit({ kind: "phase", phase, message: boundedMessage(message) });
      return true;
    },
    report(update) {
      if (!owned()) return false;
      if (isTerminalSeedPhase(currentPhase)) return false;
      const totals: SeedProgressTotals = {
        bytesTotal: update.bytesDone !== undefined ? (reporter.job.progress.bytesTotal ?? null) : null,
        entriesTotal: update.entriesDone !== undefined ? (reporter.job.progress.entriesTotal ?? null) : null,
      };
      const updated = writeProgress(currentPhase, update.message ?? "", totals, update);
      if (updated === null) return false;
      emit({
        kind: "progress",
        phase: currentPhase,
        message: boundedMessage(update.message ?? ""),
        bytesDone: update.bytesDone,
        bytesTotal: totals.bytesTotal ?? null,
      });
      return true;
    },
  };

  // Every exit from here goes through the outcome below, so cleanup at the end
  // is unconditional and idempotent. The flow is deliberately explicit rather
  // than a chain of sentinel checks: a failure is a value, and the baseline
  // verdict is evaluated whether or not the target also returned archive facts.
  let failure: string | null = null;
  let leaseLost = false;
  let archiveFacts: SeedJobArchiveFacts | null = null;

  const runSide = async (side: SeedSide, label: "source" | "target"): Promise<SeedSideOutcome | null> => {
    if (!owned()) return null;
    try {
      return await side(reporter);
    } catch (err) {
      return {
        ok: false,
        error: boundedMessage(`${label} side threw: ${err instanceof Error ? err.message : String(err)}`),
        archive: null,
        baseline: null,
      };
    }
  };

  try {
    // 2. SOURCE.
    const source = await runSide(options.source, "source");
    if (source === null) {
      leaseLost = true;
    } else if (!source.ok) {
      failure = source.error ?? "the source side failed";
    } else if (source.archive !== null) {
      // The archive facts are the target's only authority for verification, so
      // they are persisted before the target side is allowed to run.
      archiveFacts = source.archive;
      if (updateSeedJobArchive(options.db, options.jobId, source.archive, now()) !== null) {
        emit({
          kind: "archive",
          phase: currentPhase,
          message: `archive facts recorded (${source.archive.bytes ?? 0} bytes)`,
        });
      }
    }

    // 3. TARGET. Skipped entirely when the source already failed or the lease
    //    is gone: a target must never act on an archive that was not verified
    //    and recorded.
    if (failure === null && !leaseLost) {
      const target = await runSide(options.target, "target");
      if (target === null) {
        leaseLost = true;
      } else if (!target.ok) {
        failure = target.error ?? "the target side failed";
      } else {
        if (target.archive !== null) {
          archiveFacts = target.archive;
          updateSeedJobArchive(options.db, options.jobId, target.archive, now());
        }
        // A seed may NOT be reported as completed without the
        // zero-content-change verdict: that check is the whole point of the
        // transfer, so its absence is a failure rather than a pass.
        const baseline = target.baseline;
        if (baseline === null) {
          failure = "the target side did not validate the published tree against the source universe";
        } else if (!baseline.validated) {
          failure = boundedMessage(`the published tree was not validated: ${baseline.message}`);
        }
      }
    }
  } catch (err) {
    failure = boundedMessage(`the seed run threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  // A latched illegal transition outranks a side's own success report.
  if (failure === null && illegalTransition !== null) failure = illegalTransition;
  let outcome: { status: SeedCoordinatorStatus; error: string | null } = leaseLost
    ? { status: "lease_lost", error: "this owner lost the seed job before it finished" }
    : failure === null
      ? { status: "completed", error: null }
      : { status: "failed", error: failure };

  // A cancellation (or a reap) that landed mid-run owns the terminal state. The
  // coordinator must not overwrite it — and `finishSeedJob` would refuse anyway,
  // because it only updates jobs that are still `planned`/`running`.
  const beforeFinish = read();
  if (beforeFinish !== null && isTerminalSeedPhase(beforeFinish.phase)) {
    outcome = {
      status: beforeFinish.status === "cancelled" ? "cancelled" : "lease_lost",
      error:
        beforeFinish.status === "cancelled"
          ? beforeFinish.summary ?? "the seed job was cancelled while it was running"
          : `the seed job was ended by another owner (${beforeFinish.phase})`,
    };
  }

  let finalJob = read() ?? job;
  if (outcome.status !== "lease_lost" && outcome.status !== "cancelled") {
    const finished = finishSeedJob(options.db, options.jobId, {
      status: outcome.status,
      phase: outcome.status,
      summary:
        outcome.status === "completed"
          ? "Seed transfer completed and the published tree validated against the source universe."
          : null,
      error: outcome.status === "failed" ? (outcome.error ?? "the seed run failed") : null,
      now: now(),
    });
    if (finished !== null) finalJob = finished;
  }
  emit({
    kind: outcome.status === "completed" ? "completed" : outcome.status === "cancelled" ? "cancelled" : outcome.status === "lease_lost" ? "lease_lost" : "failed",
    phase: finalJob.phase,
    message: outcome.error ?? "completed",
  });

  // 5. CLEANUP. Always, and idempotently: a terminal job has no use for its
  //    temporary object, and the recorded state makes a retry a no-op.
  const cleaned = await cleanupJobObjects({
    db: options.db,
    store: options.store,
    cleanup: options.cleanup,
    jobId: options.jobId,
    job: finalJob,
    archiveFacts,
    now,
    onEvent: emit,
  });

  return {
    status: outcome.status,
    job: cleaned.job,
    error: outcome.error,
    cleanedKeys: cleaned.deletedKeys,
    phases,
  };
}

/**
 * Remove a job's seed objects and record the result on the job.
 *
 * Deliberately not guarded on status: the objects become deletable exactly when
 * the job ends, which is why `updateSeedJobArchive` has no terminal guard. A
 * failure is recorded as a retryable `failed` state rather than thrown, because
 * cleanup runs on the failure path too.
 */
export async function cleanupJobObjects(input: {
  db: Parameters<typeof getSeedJob>[0];
  store: SeedRelayStore;
  cleanup: SeedCleanupStep;
  jobId: string;
  job: SeedJob;
  archiveFacts: SeedJobArchiveFacts | null;
  now: () => number;
  onEvent?: (event: SeedCoordinatorEvent) => void;
}): Promise<{ job: SeedJob; deletedKeys: string[]; cleanup: SeedRelayCleanup }> {
  const facts = input.archiveFacts ?? input.job.archive;
  const format: SeedArchiveFormat = facts.format;
  const keys = new Set<string>();
  if (facts.objectKey !== null) keys.add(facts.objectKey);
  // The archive key is derivable from the job id and format, so an object that
  // was uploaded but never recorded (a crash between the two) is still cleaned.
  keys.add(seedArchiveObjectKey(input.jobId, format));

  const result = await input.cleanup({
    store: input.store,
    keys: [...keys],
    cleanup: facts.cleanup ?? initialSeedRelayCleanup(),
    now: input.now(),
  });
  const nextFacts: SeedJobArchiveFacts = { ...facts, cleanup: result.cleanup };
  const updated = updateSeedJobArchive(input.db, input.jobId, nextFacts, input.now());
  input.onEvent?.({
    kind: "cleanup",
    phase: (updated ?? input.job).phase,
    message: result.error ?? `cleaned ${result.deleted.length} seed object(s)`,
  });
  return {
    job: updated ?? input.job,
    deletedKeys: result.deleted,
    cleanup: result.cleanup,
  };
}

/** Overall progress of a job, for a test or a UI to assert on. Never a guess. */
export function seedJobFraction(job: SeedJob): number | null {
  return seedProgressFraction(job.progress);
}
