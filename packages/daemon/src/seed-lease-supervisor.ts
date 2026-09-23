// LAMA-346 Stage 2e — the SEED JOB lease supervisor.
//
// Why this exists
// ---------------
// A seed stage is not a short operation. The incident that opened LAMA-346 was a
// 43.5-minute attempt against a 10-minute budget, and a healthy Projects-scale
// archive/upload/download/resync is comfortably longer than
// `SEED_JOB_LEASE_MS` (10 minutes). A side that only renewed its job lease
// BETWEEN stages would therefore lose the job in the middle of a perfectly
// healthy transfer: the server's reaper would end the run, and the source's
// handover write — which requires a LIVE lease — would be refused. That is the
// exact failure the original issue reported, so the fix has to be a timer that
// runs ALONGSIDE the stage, not a step between stages.
//
// The two leases are different things, and this file only touches one
// -----------------------------------------------------------------------
// `queued_actions.lease_expires_at` (the ACTION lease, renewed by the daemon's
// `actionLeaseTimer`, `ACTION_LEASE_MS`) says "this daemon is still executing
// the action it claimed"; it is what stops the server from handing the same
// action to a second poller. `folder_seed_jobs.lease_expires_at` (the SEED JOB
// lease) says "this HOST is still driving this seed's current phase"; it is what
// makes the source→target handover meaningful and what lets the server end a run
// whose device vanished.
//
// Neither implies the other. A seed job can legitimately outlive the action that
// started it, and a daemon that keeps its action lease alive can still lose the
// job (cancellation, a takeover, an unreachable server) — in which case it must
// stop, not carry on writing. So this supervisor renews the JOB lease through
// the seed-job routes and knows nothing about the action lease.
//
// What it guarantees
// ------------------
//   * RENEW WELL BEFORE EXPIRY. Every `intervalMs` (default one minute, and
//     never more than half the lease) it calls the existing
//     `POST /seed-jobs/:id/lease`.
//   * BOUNDED TOLERANCE. A renewal that fails for a TRANSPORT reason is
//     tolerated only until `SEED_JOB_LEASE_STOP_GRACE_MS` has passed since the
//     last SUCCESSFUL renewal — strictly inside the lease lifetime — and then
//     the run is stopped. It never discovers the loss by having a write refused.
//   * STOP ON A REFUSAL. A 4xx is the server saying no (cancelled, taken over,
//     wrong phase, not running). The supervisor reads the job to report WHY, and
//     latches a stop. It never retries its way past a refusal.
//   * ONE SIGNAL. The stop is also an `AbortSignal`, so an in-flight tar,
//     extraction, upload, download or `rclone bisync` is terminated rather than
//     left running against a job it no longer owns.
//   * NOTHING IRREVERSIBLE WITHOUT A LIVE LEASE. `verifyAuthority()` is called
//     immediately before publishing the staged tree and immediately before
//     reporting completion, so a cancellation that lands while a long stage was
//     running can never publish or complete.
//
// `renewSeedJobLeaseGuarded` deliberately refuses a renewal once the lease has
// LAPSED ("a lease that lapsed counts as lost, so the reaper decides that job").
// That is why the grace window is strictly inside the lease: a correct
// supervisor stops while its lease is still nominally live, and a side that has
// already lapsed can only stop.

import {
  isTerminalSeedPhase,
  LamaSyncApiError,
  SEED_JOB_LEASE_MS,
  SEED_JOB_LEASE_RENEW_INTERVAL_MS,
  type SeedJob,
} from "@lamasync/core";

/** Thrown when the run must stop: cancelled, taken over, or out of grace. */
export class SeedStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedStopped";
  }
}

/** Renew, and read the job to explain a refusal. Both are the real API client. */
export interface SeedLeaseRenewal {
  renew: (leaseMs: number) => Promise<SeedJob>;
  read: () => Promise<SeedJob>;
}

/** A cancellable repeating timer, injectable so a test can tick exactly. */
export interface SeedLeaseTimer {
  cancel: () => void;
}

export type SeedLeaseScheduler = (fn: () => void, ms: number) => SeedLeaseTimer;

/** The real scheduler. `unref` so a leaked timer can never hold the daemon up. */
export const defaultSeedLeaseScheduler: SeedLeaseScheduler = (fn, ms) => {
  const handle = setInterval(fn, ms);
  handle.unref?.();
  return {
    cancel: () => clearInterval(handle),
  };
};

export interface SeedJobLeaseSupervisorOptions {
  /** A short label for the log line, e.g. "uploading_archive". */
  label: string;
  renewal: SeedLeaseRenewal;
  log: (message: string) => void;
  intervalMs?: number;
  leaseMs?: number;
  now?: () => number;
  scheduler?: SeedLeaseScheduler;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A 4xx is a refusal; anything else is a transport problem we may outlast. */
function isRefusal(err: unknown): boolean {
  return err instanceof LamaSyncApiError && err.status >= 400 && err.status < 500;
}

export class SeedJobLeaseSupervisor {
  private readonly renewal: SeedLeaseRenewal;
  private readonly label: string;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly scheduler: SeedLeaseScheduler;
  private readonly controller = new AbortController();

  /** The lease this supervisor asks for, and how often it asks. */
  readonly leaseMs: number;
  readonly intervalMs: number;
  /** How long a failing renewal is tolerated before the run stops. */
  readonly graceMs: number;

  private stopped: SeedStopped | null = null;
  private timer: SeedLeaseTimer | null = null;
  private ticking = false;
  private lastRenewedAt: number;
  constructor(options: SeedJobLeaseSupervisorOptions) {
    this.renewal = options.renewal;
    this.label = options.label;
    this.log = options.log;
    this.now = options.now ?? (() => Date.now());
    this.scheduler = options.scheduler ?? defaultSeedLeaseScheduler;
    this.leaseMs = clamp(options.leaseMs ?? SEED_JOB_LEASE_MS, 30_000, 3_600_000);
    // "Well before expiry" is enforced, not merely documented: half the lease is
    // the loosest interval accepted, whatever a caller asks for.
    this.intervalMs = clamp(
      options.intervalMs ?? SEED_JOB_LEASE_RENEW_INTERVAL_MS,
      1_000,
      Math.floor(this.leaseMs / 2),
    );
    this.graceMs = Math.max(this.leaseMs - this.intervalMs, 1_000);
    this.lastRenewedAt = this.now();
  }

  /** Aborted when the run must stop — threaded into every long operation. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The latch, for a caller that wants to report why it stopped. */
  get failure(): SeedStopped | null {
    return this.stopped;
  }

  /** Start renewing. Idempotent, and a no-op once stopped. */
  start(): void {
    if (this.timer !== null || this.stopped !== null) return;
    this.timer = this.scheduler(() => {
      void this.tick().catch((err: unknown) => {
        // `tick` latches its own failures and never rejects by design, so
        // reaching here means a bug in the supervisor itself. It must be
        // visible rather than become an unhandled rejection in the daemon.
        this.log(`[seed] ${this.label} lease renewal tick failed: ${describe(err)}`);
      });
    }, this.intervalMs);
  }

  /** Stop renewing. Idempotent. Does NOT latch a failure (a clean finish). */
  stop(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  /** Throw unless this side may still act on the job. */
  assertLive(): void {
    if (this.stopped !== null) throw this.stopped;
  }

  /**
   * Record a renewal that happened through ANOTHER write.
   *
   * A phase report renews the lease server-side (`reportSeedJobProgressGuarded`
   * writes a fresh `lease_expires_at`), so the grace window must measure from
   * that write rather than from the last explicit lease call. Without this the
   * window would be needlessly tight after every phase entry — and a slow stage
   * would stop earlier than the lease actually requires.
   */
  markRenewed(): void {
    this.lastRenewedAt = this.now();
  }

  /** Latch a stop exactly once, abort in-flight work, and say why. */
  private latch(reason: string): void {
    if (this.stopped !== null) return;
    this.stopped = new SeedStopped(reason);
    this.stop();
    this.controller.abort();
    this.log(`[seed] ${this.label} lease supervisor stopped: ${reason}`);
  }

  /**
   * One renewal. Public so the run can force a renewal at a stage boundary (and
   * so a test can drive it deterministically); overlapping calls are collapsed.
   */
  async tick(): Promise<void> {
    if (this.stopped !== null || this.ticking) return;
    this.ticking = true;
    try {
      const job = await this.renewal.renew(this.leaseMs);
      this.lastRenewedAt = this.now();
      if (isTerminalSeedPhase(job.phase)) this.latch(`the job is ${job.phase}`);
    } catch (err) {
      await this.onRenewalFailure(err);
    } finally {
      this.ticking = false;
    }
  }

  private async onRenewalFailure(err: unknown): Promise<void> {
    if (isRefusal(err)) {
      // The server refused. Read the row so the operator gets the real reason
      // ("the job is cancelled") instead of our guess at it.
      const current = await this.readQuietly();
      if (current !== null && isTerminalSeedPhase(current.phase)) {
        this.latch(`the job is ${current.phase}`);
        return;
      }
      this.latch(`the server refused to renew this seed job's lease: ${describe(err)}`);
      return;
    }
    const silentFor = this.now() - this.lastRenewedAt;
    if (silentFor >= this.graceMs) {
      this.latch(
        `the seed lease could not be renewed for ${Math.round(silentFor / 1000)}s, which is inside the ${Math.round(
          this.leaseMs / 1000,
        )}s lifetime it was granted for, so this run is treated as lost`,
      );
      return;
    }
    this.log(
      `[seed] ${this.label} lease renewal failed (${describe(err)}); ${Math.round(
        (this.graceMs - silentFor) / 1000,
      )}s of grace left`,
    );
  }

  private async readQuietly(): Promise<SeedJob | null> {
    try {
      return await this.renewal.read();
    } catch {
      return null;
    }
  }

  /**
   * The authoritative check before an irreversible step.
   *
   * A GET of the job, so this is the server's answer rather than our cached
   * view: a cancellation or a takeover that landed while a long stage ran is
   * observed HERE, and only a job that is still live lets the caller proceed.
   */
  async verifyAuthority(): Promise<void> {
    this.assertLive();
    let current: SeedJob;
    try {
      current = await this.renewal.read();
    } catch (err) {
      if (isRefusal(err)) {
        this.latch(`the job could not be read before an irreversible step: ${describe(err)}`);
        this.assertLive();
      }
      // A transport blip is not a refusal: the supervisor's grace window governs.
      return;
    }
    if (isTerminalSeedPhase(current.phase)) this.latch(`the job is ${current.phase}`);
    this.assertLive();
  }

  /**
   * Run one stage inside the supervisor.
   *
   * The stage receives the abort signal (every long operation in the seed
   * transport takes one), and the check is repeated AFTER it returns: a stage
   * that was aborted half-way must be interpreted as a stop, never as its own
   * failure, so a cancellation cannot be reported as a job failure and an
   * interrupted archive cannot be mistaken for a bad one.
   */
  async run<T>(stage: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertLive();
    let result: T;
    try {
      result = await stage(this.signal);
    } catch (err) {
      // A stage that was aborted usually THROWS rather than returning its own
      // failure — a killed pipe, an aborted fetch, a rejected pipeline. The stop
      // is the truth, so `assertLive` wins and the stage's error is dropped.
      this.assertLive();
      throw err;
    }
    this.assertLive();
    return result;
  }
}
