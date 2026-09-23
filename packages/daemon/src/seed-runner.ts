// LAMA-346 Stage 2d — the seed side that lamasyncd runs.
//
// This is the SHIPPED daemon's seed executor. It is reached only from the
// `seed_job` case in the daemon's queued-action dispatcher, only through a
// dynamic `import()`, and only when the doubly-gated seam is on, so a build that
// never sets `LAMASYNC_SEED_E2E=1` AND `LAMASYNC_TEST=1` cannot reach the relay
// transport or the S3 store at all. `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` stays
// `false`, so the API still refuses to create a job by default.
//
// It reuses the primitives that already exist and are already tested:
//   * `buildSeedSourceManifest` / `buildSeedFilterUniverse` (the effective
//     filter universe, Stage 1a),
//   * `createSeedArchive` / `extractSeedArchive` / `verifyExtractedTree` /
//     `publishStagedTree` (the archive primitives),
//   * `uploadSeedArchive` / `uploadSeedManifest` / `downloadSeedArchive` /
//     `downloadSeedManifest` / `cleanupSeedRelayObjects` (the verified
//     transport, Stage 1b/2c),
//   * the real S3-compatible store (Stage 2c).
//
// It invents no state. The job row is the only source of truth: the phase the
// server reports is the phase this side is allowed to be in, the archive facts
// it reads are the ones the SOURCE wrote, and the terminal outcome it reports is
// the job's. The two sides never talk to each other — only to the server and the
// object space — so a second host is a real second host.
//
// TWO DELIBERATE, DOCUMENTED LIMITS
//
//   1. The resync peer for the target's `baseline_validation` phase comes from
//      the seam (`LAMASYNC_SEED_DAEMON_PEER_PATH`). In production the peer is
//      the assignment's resolved rclone remote
//      (`<remote>:<destination>` + the daemon's rclone config), and resolving it
//      inside this runner is the remaining orchestration item. Until then the
//      phase fails closed when no peer is supplied: the daemon NEVER reports a
//      seed completed without a real zero-change baseline.
//   2. The relay store's credentials come from the seam environment. That is
//      deliberate: the relay contract has no credential parameter, and where the
//      fleet's temporary seed space is configured is a product decision. A build
//      without the seam cannot construct a store.
//
// THE JOB LEASE IS KEPT ALIVE DURING A STAGE, NOT BETWEEN STAGES
//
// A healthy Projects-scale archive/upload/download/resync is far longer than
// `SEED_JOB_LEASE_MS`, so every long step below runs inside a
// `SeedJobLeaseSupervisor` (see `seed-lease-supervisor.ts`): a timer renews the
// JOB lease `POST /seed-jobs/:id/lease` well before it expires, hands every step
// an `AbortSignal`, and refuses to let an irreversible step proceed once the job
// has been cancelled, taken over, or lost. The queued ACTION lease that
// `lamasyncd` keeps alive is a DIFFERENT lease and is not touched here.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SEED_EMPTY_FILTER_FINGERPRINT,
  isTerminalSeedPhase,
  seedArchiveFactsComplete,
  seedJobPhaseRole,
  seedJobRoleFor,
  seedRelayArchiveKey,
  seedRelayManifestKey,
  seedStagingPath,
  type HostConfig,
  type SeedJob,
  type SeedJobArchiveFacts,
  type SeedJobPhase,
  type SeedJobPhaseOrTerminal,
  type SeedJobProgress,
  type SeedJobRole,
  type SeedManifestDocument,
  type SeedRelayStore,
} from "@lamasync/core";
import {
  createSeedArchive,
  detectArchiveTooling,
  extractSeedArchive,
  publishStagedTree,
  verifyExtractedTree,
  type SeedManifest,
} from "./seed-archive.ts";
import { buildSeedFilterUniverse, buildSeedSourceManifest } from "./seed-filter-universe.ts";
import { createS3SeedRelayStore } from "./seed-relay-s3.ts";
import { seedDaemonE2eEnabled } from "./seed-daemon-seam.ts";
import {
  SeedJobLeaseSupervisor,
  SeedStopped,
  type SeedLeaseScheduler,
} from "./seed-lease-supervisor.ts";
import {
  cleanupSeedRelayObjects,
  downloadSeedArchive,
  downloadSeedManifest,
  uploadSeedArchive,
  uploadSeedManifest,
} from "./seed-transport.ts";

// The seam lives in its own dependency-free module so the daemon's dispatcher
// can decide whether seed work is reachable without importing this file (and
// therefore without importing the transport or the store). Re-exported here so
// callers that already hold the runner keep one import.
export { seedDaemonE2eEnabled };

/** The relay store configuration, read from the seam environment. */
export interface SeedDaemonRelayConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function envValue(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Null unless EVERY relay variable is present — a partial config fails closed. */
export function seedDaemonRelayConfigFromEnv(): SeedDaemonRelayConfig | null {
  const endpoint = envValue("LAMASYNC_SEED_S3_ENDPOINT");
  const bucket = envValue("LAMASYNC_SEED_S3_BUCKET");
  const accessKeyId = envValue("LAMASYNC_SEED_S3_ACCESS_KEY");
  const secretAccessKey = envValue("LAMASYNC_SEED_S3_SECRET_KEY");
  if (endpoint === null || bucket === null || accessKeyId === null || secretAccessKey === null) {
    return null;
  }
  return { endpoint, bucket, region: envValue("LAMASYNC_SEED_S3_REGION") ?? "us-east-1", accessKeyId, secretAccessKey };
}

/** The resync peer the target validates its zero-change baseline against. */
export function seedDaemonPeerPathFromEnv(): string | null {
  return envValue("LAMASYNC_SEED_DAEMON_PEER_PATH");
}

/**
 * The server operations a seed side needs, stated structurally.
 *
 * The daemon's real `LamaSyncApiClient` satisfies this, so the dispatcher passes
 * it unchanged; the point of the narrower type is that a test can drive a whole
 * side against a deterministic fake — including a cancellation mid-stage —
 * without an HTTP server and without a cast.
 */
export interface SeedRunnerClient {
  getSeedJob(jobId: string): Promise<SeedJob>;
  reportSeedProgress(
    jobId: string,
    body: {
      phase: SeedJobPhase;
      message?: string;
      bytesDone?: number;
      bytesTotal?: number | null;
      entriesDone?: number;
      entriesTotal?: number | null;
      leaseMs?: number;
    },
  ): Promise<SeedJob>;
  recordSeedArchiveFacts(jobId: string, facts: SeedJobArchiveFacts): Promise<SeedJob>;
  renewSeedJobLease(jobId: string, leaseMs?: number): Promise<SeedJob>;
  completeSeedJob(
    jobId: string,
    body: { status: "completed" | "failed"; summary?: string | null; error?: string | null },
  ): Promise<SeedJob>;
}

export interface SeedActionContext {
  client: SeedRunnerClient;
  hostId: string;
  jobId: string;
  /** The role the queued action asked for; re-checked against the job. */
  payloadRole: SeedJobRole;
  getHostConfig: () => HostConfig | null;
  refreshConfig: () => Promise<boolean>;
  /** The daemon's data directory; every artifact this runner writes lives here. */
  dataDir: string;
  log: (message: string) => void;
  now?: () => number;
  /**
   * The relay store. Production builds the S3 store from the seam environment;
   * the field exists so a test can pass a deterministic store (the local object
   * store, or a wrapper that gates one call) without touching the seam env.
   */
  store?: SeedRelayStore;
  /** Lease tuning. Defaults to the shipped values; tests shrink them. */
  leaseMs?: number;
  leaseIntervalMs?: number;
  leaseScheduler?: SeedLeaseScheduler;
}

export interface SeedActionOutcome {
  status: "done" | "failed";
  /** Bounded, credential-free, operator-facing. */
  result: string;
}

/** The outcome of one `rclone bisync --resync` validation. */
export interface SeedBaselineVerdict {
  ok: boolean;
  message: string;
  transfers: number | null;
  bytes: number | null;
}

/** Strip rclone's ANSI colouring so a sentence can be matched exactly. */
function plainLog(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Decide whether a bisync run proved a ZERO-CHANGE baseline.
 *
 * The acceptance is "no file changed", not "no bytes moved": a run that
 * rewrites an mtime reports a changed file with zero bytes and would leave the
 * folder re-syncing forever. Pure, so the exact rule is pinned by a test rather
 * than inferred from a live run.
 */
export function seedBaselineVerdict(input: { exitCode: number; stderr: string }): SeedBaselineVerdict {
  const raw = plainLog(input.stderr);
  let transfers: number | null = null;
  let bytes: number | null = null;
  let errors: number | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { stats?: Record<string, number> };
      if (parsed.stats) {
        transfers = parsed.stats["totalTransfers"] ?? transfers;
        bytes = parsed.stats["bytes"] ?? bytes;
        errors = parsed.stats["errors"] ?? errors;
      }
    } catch {
      // rclone interleaves non-JSON progress lines.
    }
  }
  if (input.exitCode !== 0) {
    return { ok: false, message: `the post-seed resync exited ${input.exitCode}`, transfers, bytes };
  }
  if (!raw.includes("Bisync successful")) {
    return { ok: false, message: "the post-seed resync did not report Bisync successful", transfers, bytes };
  }
  if (transfers !== 0 || bytes !== 0) {
    return {
      ok: false,
      message: `the post-seed resync was not a no-op: ${transfers ?? "?"} file(s), ${bytes ?? "?"} byte(s)`,
      transfers,
      bytes,
    };
  }
  if (errors !== null && errors !== 0) {
    return { ok: false, message: `the post-seed resync reported ${errors} error(s)`, transfers, bytes };
  }
  if (raw.includes("File changed") || raw.includes("Safety abort")) {
    return { ok: false, message: "the post-seed resync reported a changed file or aborted on safety", transfers, bytes };
  }
  return { ok: true, message: "the post-seed resync moved nothing", transfers, bytes };
}

/** Thrown when the job left the phase this run was driving (cancel, takeover). */
function bounded(message: string, max = 300): string {
  return message.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * The seam-gated delay hook (E2E only).
 *
 * The E2E has to prove that a stage which OUTLIVES the lease TTL still completes,
 * and no real stage in a disposable sandbox takes ten minutes. This makes one
 * named phase sit still for a configured number of milliseconds so the lease
 * would lapse without a renewal. It is read ONLY when the doubly-gated seam is
 * open, so a production build cannot be slowed by it, and it can only ever make
 * a stage SLOWER — never change what the stage does.
 */
function seamStageDelayMs(phase: SeedJobPhase): number {
  if (!seedDaemonE2eEnabled()) return 0;
  const phaseName = envValue("LAMASYNC_SEED_STAGE_DELAY_PHASE");
  if (phaseName === null || phaseName !== phase) return 0;
  const raw = envValue("LAMASYNC_SEED_STAGE_DELAY_MS");
  if (raw === null) return 0;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, 10 * 60_000);
}

/**
 * The seam-gated lease window and renewal interval (E2E only).
 *
 * The E2E cannot wait ten real minutes for a lease to lapse, so it shortens the
 * lease to the smallest window the route accepts and proves renewal during a
 * stage that outlives it. Floored at the route's own minimum (`30_000`) so a seam
 * can never configure a lease the server would reject, and read ONLY when the
 * doubly-gated seam is open.
 */
function seamLeaseMs(): number | undefined {
  if (!seedDaemonE2eEnabled()) return undefined;
  const raw = envValue("LAMASYNC_SEED_LEASE_MS");
  if (raw === null) return undefined;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 30_000) return undefined;
  return Math.min(ms, 3_600_000);
}

function seamLeaseIntervalMs(): number | undefined {
  if (!seedDaemonE2eEnabled()) return undefined;
  const raw = envValue("LAMASYNC_SEED_LEASE_INTERVAL_MS");
  if (raw === null) return undefined;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(ms, 3_600_000);
}

/**
 * Run one side of one seed job to its terminal point.
 *
 * The caller (the daemon's action dispatcher) has already made sure the action
 * is single-flight and holds a renewed ACTION lease. That lease says nothing
 * about this job's lease, which is renewed by the supervisor below.
 */
export async function runSeedAction(ctx: SeedActionContext): Promise<SeedActionOutcome> {
  const now = ctx.now ?? (() => Date.now());
  const log = ctx.log;
  if (!seedDaemonE2eEnabled()) {
    return {
      status: "failed",
      result: "seed execution is not enabled on this build (the seed seam is off)",
    };
  }
  const relay = seedDaemonRelayConfigFromEnv();
  // Resolve the store BEFORE reading the job: with neither an injected store nor
  // a complete relay configuration there is nothing this side could do, so it
  // must fail without touching the network at all.
  const store = ctx.store ?? (relay === null ? null : createS3SeedRelayStore(relay));
  if (store === null) {
    return { status: "failed", result: "this device has no seed relay space configured" };
  }

  let job: SeedJob;
  try {
    job = await ctx.client.getSeedJob(ctx.jobId);
  } catch (err) {
    return { status: "failed", result: bounded(`the seed job could not be read: ${reason(err)}`) };
  }
  const role = seedJobRoleFor(job, ctx.hostId);
  if (role === null) {
    return {
      status: "failed",
      result: `this device (${ctx.hostId}) is not a party to seed job ${ctx.jobId}`,
    };
  }
  if (role !== ctx.payloadRole) {
    return {
      status: "failed",
      result: `the queued action asked for the ${ctx.payloadRole} side, but the job assigns this device the ${role} side`,
    };
  }
  if (isTerminalSeedPhase(job.phase)) {
    return { status: "done", result: `the seed job is already ${job.phase}` };
  }
  const workDir = join(ctx.dataDir, "seed-work", ctx.jobId);
  mkdirSync(workDir, { recursive: true });
  const runner = new SeedSideRunner(ctx, job, role, store, workDir, now, log);
  try {
    return role === "source" ? await runner.runSource() : await runner.runTarget();
  } catch (err) {
    if (err instanceof SeedStopped) {
      // A cancellation, a takeover, or a lease we could no longer renew. The
      // ACTION is done (the job is the server's to finish), and the staging this
      // run created is released by the runner's own cleanup.
      log(`[seed] job=${ctx.jobId} stopped: ${err.message}`);
      return { status: "done", result: bounded(`the seed job ended while this side was working: ${err.message}`) };
    }
    const message = bounded(reason(err));
    log(`[seed] job=${ctx.jobId} ${role} failed: ${message}`);
    await runner.failJob(message);
    return { status: "failed", result: message };
  } finally {
    await runner.release();
    rmSync(workDir, { recursive: true, force: true });
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sleep that a stop cuts short. Used only by the seam-gated stage delay, so a
 * cancelled E2E run does not have to wait out an artificial pause.
 */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** One side of one job, with the server as its only authority. */
class SeedSideRunner {
  private job: SeedJob;
  private readonly supervisor: SeedJobLeaseSupervisor;
  /** The staging sibling this run created, if any. Only ever removed by us. */
  private stagingDir: string | null = null;
  /** Once the rename has happened the staged tree IS the target. */
  private published = false;

  constructor(
    private readonly ctx: SeedActionContext,
    job: SeedJob,
    private readonly role: SeedJobRole,
    private readonly store: SeedRelayStore,
    private readonly workDir: string,
    private readonly now: () => number,
    private readonly log: (message: string) => void,
  ) {
    this.job = job;
    // The E2E shortens the lease through the seam; production uses the shipped
    // window. Either way the interval is bounded to half the lease by the
    // supervisor itself, so "renew well before expiry" cannot be misconfigured.
    const leaseMs = ctx.leaseMs ?? seamLeaseMs();
    const leaseIntervalMs = ctx.leaseIntervalMs ?? seamLeaseIntervalMs();
    this.supervisor = new SeedJobLeaseSupervisor({
      label: `${role} ${job.phase}`,
      renewal: {
        renew: (leaseMs) => ctx.client.renewSeedJobLease(ctx.jobId, leaseMs),
        read: () => ctx.client.getSeedJob(ctx.jobId),
      },
      log,
      now,
      ...(leaseMs === undefined ? {} : { leaseMs }),
      ...(leaseIntervalMs === undefined ? {} : { intervalMs: leaseIntervalMs }),
      ...(ctx.leaseScheduler === undefined ? {} : { scheduler: ctx.leaseScheduler }),
    });
  }

  /**
   * Start keeping this job's lease alive for the duration of the run.
   *
   * The renewal has to be a TIMER: a stage can take far longer than the lease,
   * and a side that only renewed between stages would lose the job mid-transfer
   * and then have its handover write refused — the failure the original issue
   * reported.
   */
  start(): void {
    this.supervisor.start();
  }

  /** Stop renewing and release anything this run created but did not publish. */
  async release(): Promise<void> {
    this.supervisor.stop();
    this.cleanupStaging();
  }

  /**
   * Remove ONLY the staging sibling this run created, and only while it is still
   * staging. Once published, the tree is the target's and must not be touched.
   */
  private cleanupStaging(): void {
    if (this.published || this.stagingDir === null) return;
    try {
      rmSync(this.stagingDir, { recursive: true, force: true });
    } catch (err) {
      this.log(`[seed] job=${this.ctx.jobId} could not remove the staging directory: ${reason(err)}`);
    }
    this.stagingDir = null;
  }

  /**
   * Report a phase and adopt the server's answer. The server owns the phase
   * machine, the ownership rules and the lease; this side only asks. A refusal
   * is fatal to the run — never retried silently — because a refused phase means
   * the job moved on without us.
   */
  private async enter(
    phase: SeedJobPhase,
    message: string,
    totals: { bytesTotal?: number | null; entriesTotal?: number | null } = {},
  ): Promise<void> {
    const expected = seedJobPhaseRole(phase);
    if (expected !== this.role) {
      throw new SeedStopped(`the ${phase} phase belongs to the ${expected} side`);
    }
    this.supervisor.assertLive();
    try {
      // The lease window is stated EXPLICITLY, so a phase entry grants the same
      // window the supervisor renews. Leaving it to the route's default would
      // grant a long lease on entry and then SHORTEN it on the first renewal,
      // which is a confusing mismatch between what the side asked for and what
      // its own grace window measures.
      this.job = await this.ctx.client.reportSeedProgress(this.ctx.jobId, {
        phase,
        message,
        leaseMs: this.supervisor.leaseMs,
        ...totals,
      });
    } catch (err) {
      throw new SeedStopped(`the server refused the ${phase} phase: ${reason(err)}`);
    }
    // A phase report writes a fresh `lease_expires_at`, so it IS a renewal: the
    // grace window has to measure from here, not from the last explicit call.
    this.supervisor.markRenewed();
    if (isTerminalSeedPhase(this.job.phase)) {
      throw new SeedStopped(`the job is ${this.job.phase}`);
    }
    this.log(`[seed] job=${this.ctx.jobId} ${this.role} phase=${phase}`);
    // The E2E's lease-outliving proof: one named phase can be made to sit still
    // long enough that an unrenewed lease would lapse. Seam-gated, and it can
    // only ever make the stage slower.
    const delayMs = seamStageDelayMs(phase);
    if (delayMs > 0) {
      this.log(`[seed] job=${this.ctx.jobId} ${this.role} holding phase=${phase} for ${delayMs}ms (seam delay)`);
      await sleepUnlessAborted(delayMs, this.supervisor.signal);
      this.supervisor.assertLive();
    }
  }

  /**
   * Read the job as the current truth: the poll `waitForSourceFacts` needs, and
   * a stop when the job went terminal under us.
   */
  private async readJob(): Promise<SeedJob | null> {
    let current: SeedJob;
    try {
      current = await this.ctx.client.getSeedJob(this.ctx.jobId);
    } catch {
      return null;
    }
    this.job = current;
    if (isTerminalSeedPhase(current.phase)) throw new SeedStopped(`the job is ${current.phase}`);
    return current;
  }

  async failJob(message: string): Promise<void> {
    try {
      await this.ctx.client.completeSeedJob(this.ctx.jobId, { status: "failed", error: message });
    } catch (err) {
      this.log(`[seed] job=${this.ctx.jobId} could not record the failure: ${reason(err)}`);
    }
  }

  /** The local assignment and folder this side is acting on. */
  private async assignment(): Promise<{ localPath: string; folderType: "sync" | "backup" }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const config = this.ctx.getHostConfig();
      const assignment = config?.assignments.find((a) => a.folderId === this.job.folderId) ?? null;
      const folder = config?.folders.find((f) => f.id === this.job.folderId) ?? null;
      if (assignment && folder) {
        return { localPath: assignment.localPath, folderType: folder.type === "backup" ? "backup" : "sync" };
      }
      if (attempt === 0) await this.ctx.refreshConfig();
    }
    throw new Error(`this device is not assigned folder ${this.job.folderId}`);
  }

  private assignmentRecord() {
    const config = this.ctx.getHostConfig();
    return config?.assignments.find((a) => a.folderId === this.job.folderId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Source
  // -------------------------------------------------------------------------

  async runSource(): Promise<SeedActionOutcome> {
    // The source owns `preflight` onward, so it takes the lease immediately and
    // the supervisor keeps it alive for the whole half.
    this.start();
    const { localPath, folderType } = await this.assignment();
    const assignment = this.assignmentRecord();
    if (assignment === null) throw new Error(`this device is not assigned folder ${this.job.folderId}`);
    if (folderType !== "sync") throw new Error("only sync assignments can be seeded");

    await this.enter("measuring_source", "Building the effective-filter manifest.");
    const built = await this.supervisor.run(async () => buildSeedSourceManifest(assignment, folderType));
    if (built.manifest === null || built.blocking.length > 0) {
      throw new Error(bounded(`the source manifest could not be built: ${built.blocking.join("; ")}`, 200));
    }
    const manifest = built.manifest;
    this.log(
      `[seed] job=${this.ctx.jobId} source manifest entries=${manifest.entries.length} fingerprint=${manifest.fingerprint}`,
    );

    const tooling = await detectArchiveTooling();
    if (!tooling.tar) throw new Error("tar is not available on this device");

    await this.enter("archiving_source", "Archiving the manifest's members.", {
      entriesTotal: manifest.entries.length,
    });
    const archivePath = join(this.workDir, "payload.archive");
    // The signal reaches GNU tar's process, so a cancellation stops the archive
    // instead of letting it finish for a job this side no longer owns. A tar
    // killed mid-write leaves a partial file in the WORK directory, which the
    // caller removes; nothing is published and nothing is uploaded.
    const archive = await this.supervisor.run((signal) =>
      createSeedArchive({
        format: this.job.archive.format,
        sourceRoot: localPath,
        outputPath: archivePath,
        manifest,
        filter: built.universe,
        signal,
      }),
    );
    if (!archive.ok || archive.sha256 === null) {
      throw new Error(bounded(`archive creation failed: ${archive.error ?? "no digest"}`, 200));
    }

    await this.enter("uploading_archive", "Uploading the archive and manifest to the temporary seed space.", {
      bytesTotal: archive.bytes,
    });
    const uploaded = await this.supervisor.run((signal) =>
      uploadSeedArchive({
        store: this.store,
        jobId: this.ctx.jobId,
        format: this.job.archive.format,
        archivePath,
        manifestFingerprint: manifest.fingerprint,
        memberCount: archive.memberCount,
        now: this.now(),
        signal,
      }),
    );
    if (!uploaded.ok || uploaded.metadata === null) {
      throw new Error(bounded(`archive upload failed: ${uploaded.error ?? "no metadata"}`, 200));
    }
    const manifestUpload = await this.supervisor.run((signal) =>
      uploadSeedManifest({
        store: this.store,
        jobId: this.ctx.jobId,
        manifest,
        now: this.now(),
        signal,
      }),
    );
    if (!manifestUpload.ok || manifestUpload.metadata === null) {
      throw new Error(bounded(`manifest upload failed: ${manifestUpload.error ?? "no metadata"}`, 200));
    }
    const facts: SeedJobArchiveFacts = {
      ...uploaded.archive,
      manifestObjectKey: manifestUpload.metadata.objectKey,
      manifestBytes: manifestUpload.metadata.bytes,
      manifestSha256: manifestUpload.metadata.sha256,
    };
    // The handover. Its write requires a LIVE lease, which is exactly why the
    // supervisor above has to have renewed during a long upload: without it the
    // server refuses (409) and a healthy multi-hour seed would fail here.
    await this.supervisor.verifyAuthority();
    await this.ctx.client.recordSeedArchiveFacts(this.ctx.jobId, facts);
    this.log(
      `[seed] job=${this.ctx.jobId} source recorded archive bytes=${facts.bytes} sha256=${facts.sha256} manifest=${facts.manifestFingerprint}`,
    );
    return {
      status: "done",
      result: bounded(
        `seed source finished: ${facts.bytes} byte archive, ${facts.memberCount} member(s), manifest ${facts.manifestFingerprint}`,
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Target
  // -------------------------------------------------------------------------

  /**
   * Wait for the SOURCE's immutable facts, then download, verify, extract,
   * publish and validate.
   *
   * The wait is bounded and fails closed: a job that ends, or facts that never
   * appear, end the run rather than letting it start against an unknown
   * universe.
   */
  private async waitForSourceFacts(timeoutMs: number): Promise<SeedJob> {
    // While the source holds the job the target owns NO lease, so it must not
    // try to renew one: the lease route would (correctly) refuse a renewal for a
    // phase that is not this side's, and a supervisor that read that refusal as
    // "the job is lost" would abandon a perfectly healthy wait. What the target
    // needs here is only to notice that the job ENDED — a cancellation, or a
    // source whose lease lapsed and was reaped — which is a read, not a renewal.
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const current = await this.readJob();
      if (current === null) {
        throw new Error("the seed job could not be read while waiting for the source's archive facts");
      }
      if (seedArchiveFactsComplete(current.archive)) return current;
      if (this.now() > deadline) {
        throw new Error("timed out waiting for the source to record its archive facts");
      }
      await Bun.sleep(500);
    }
  }

  async runTarget(): Promise<SeedActionOutcome> {
    const { localPath, folderType } = await this.assignment();
    if (folderType !== "sync") throw new Error("only sync assignments can be seeded");

    const job = await this.waitForSourceFacts(30 * 60_000);
    const archivePath = join(this.workDir, "payload.archive");
    // The handover has happened, so the lease is free and this side is about to
    // claim it: from here on the supervisor keeps it alive through every long
    // download, extraction, verification, publish and resync.
    this.start();

    await this.enter("downloading_archive", "Downloading the archive from the temporary seed space.", {
      bytesTotal: job.archive.bytes,
    });
    const downloaded = await this.supervisor.run((signal) =>
      downloadSeedArchive({
        store: this.store,
        archive: job.archive,
        jobId: this.ctx.jobId,
        destPath: archivePath,
        now: this.now(),
        signal,
      }),
    );
    if (!downloaded.ok) {
      throw new Error(bounded(`archive download failed: ${downloaded.error ?? "unknown"}`, 200));
    }

    await this.enter("verifying_archive", "Downloading the manifest and re-deriving the source universe.");
    const manifestPath = join(this.workDir, "manifest.json");
    const manifestDownload = await this.supervisor.run((signal) =>
      downloadSeedManifest({
        store: this.store,
        archive: job.archive,
        jobId: this.ctx.jobId,
        destPath: manifestPath,
        signal,
      }),
    );
    if (!manifestDownload.ok || manifestDownload.document === null) {
      throw new Error(bounded(`manifest download failed: ${manifestDownload.error ?? "unknown"}`, 200));
    }
    const document = manifestDownload.document;
    this.log(
      `[seed] job=${this.ctx.jobId} target re-derived manifest fingerprint=${document.fingerprint} entries=${document.entries.length}`,
    );

    // The staging directory must be this device's own derived sibling, in its
    // own parent, on the same filesystem. A wrong location never receives a byte.
    const stagingDir = seedStagingPath(localPath, this.ctx.jobId);
    if (stagingDir === null) {
      throw new Error("the assignment's local path cannot derive a staging sibling");
    }
    rmSync(stagingDir, { recursive: true, force: true });
    // Recorded BEFORE the first byte lands in it, so a failure at any point
    // below releases exactly this path and nothing else.
    this.stagingDir = stagingDir;

    await this.enter("extracting_target", "Extracting into the staging sibling.", {
      entriesTotal: document.entries.length,
    });
    const extracted = await this.supervisor.run((signal) =>
      extractSeedArchive({
        format: job.archive.format,
        archivePath,
        stagingDir,
        signal,
      }),
    );
    if (!extracted.ok) {
      throw new Error(bounded(`extraction failed: ${extracted.error ?? "unknown"}`, 200));
    }

    await this.enter("verifying_target", "Verifying the extracted tree against the transported manifest.");
    const verified = await this.supervisor.run((signal) =>
      verifyExtractedTree({ root: stagingDir, manifest: documentAsManifest(document), signal }),
    );
    if (!verified.ok) {
      throw new Error(bounded(`tree verification failed: ${verified.message}`, 200));
    }

    await this.enter("publishing", "Publishing the staging tree with one atomic rename.");
    // The LAST authority check before the one irreversible local act. A
    // cancellation that landed during extraction, verification or the archive
    // download is observed HERE, so a cancelled seed can never publish a tree
    // into the target — the operator asked for it to stop, not to finish.
    await this.supervisor.verifyAuthority();
    const published = publishStagedTree({ stagingDir, targetPath: localPath });
    if (!published.ok) {
      throw new Error(bounded(`publication failed: ${published.error ?? "unknown"}`, 200));
    }
    this.published = true;

    await this.enter("baseline_validation", "Running a resync against the assignment's peer and requiring no change.");
    const baseline = await this.supervisor.run((signal) => this.runBaselineValidation(signal));
    if (!baseline.ok) throw new Error(bounded(baseline.message, 200));

    // The LAST authority check before reporting the job finished. Reporting a
    // cancellation as a completed seed would be the same class of lie as
    // reporting a seed done without the zero-change proof.
    await this.supervisor.verifyAuthority();
    await this.ctx.client.completeSeedJob(this.ctx.jobId, {
      status: "completed",
      summary: bounded(
        `Seed transfer completed: ${document.fileCount} file(s) verified against the transported manifest, and the following resync moved nothing.`,
      ),
    });
    await this.cleanup();
    return { status: "done", result: bounded(`seed target finished: ${document.fileCount} file(s) verified, zero-change baseline confirmed`) };
  }

  /**
   * The post-seed resync, and the ONLY gate that lets a seed be reported
   * completed. A missing peer is a FAILURE, never a pass: reporting a seed done
   * without the zero-change proof is exactly the class of lie this whole
   * mechanism exists to prevent.
   *
   * INTERRUPTION: `rclone` has no graceful-cancel protocol, so a stop KILLS the
   * child process (Bun.spawn has no signal option, so the abort is wired to
   * `proc.kill()`), exactly as the archive helpers do for tar. Two things make
   * that safe rather than merely convenient:
   *   * the bisync work directory lives inside this run's WORK directory, which
   *     the caller removes, so no state from the killed attempt is reused by a
   *     later one and no lock is left from a run that no longer exists;
   *   * the verdict of a killed run is a non-zero exit, which is a FAILURE, and
   *     the supervisor's post-stage check turns it into a STOP before the job can
   *     be completed. `--resync` is restartable, so a retry is a fresh run rather
   *     than a resume, and a half-finished resync is never mistaken for a
   *     zero-change one.
   */
  private async runBaselineValidation(signal: AbortSignal): Promise<SeedBaselineVerdict> {
    const peer = seedDaemonPeerPathFromEnv();
    if (peer === null) {
      return {
        ok: false,
        message:
          "no resync peer is configured for this device, so the zero-change baseline could not be proven",
        transfers: null,
        bytes: null,
      };
    }
    const assignment = this.assignmentRecord();
    if (assignment === null) {
      return { ok: false, message: "this device is not assigned the seeded folder", transfers: null, bytes: null };
    }
    const universe = buildSeedFilterUniverse(assignment, "sync");
    const rulesPath = join(this.workDir, "filter-rules.txt");
    writeFileSync(rulesPath, universe.rules.length > 0 ? `${universe.rules.join("\n")}\n` : "");
    const stateDir = join(this.workDir, "bisync-state");
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });
    const localPath = assignment.localPath;
    const args = [
      "rclone",
      "bisync",
      peer,
      localPath,
      "--workdir",
      stateDir,
      "--filter-from",
      rulesPath,
      "--use-json-log",
      "-v",
      "--resilient",
      "--recover",
      "--max-lock",
      "10m",
      "--resync",
    ];
    this.log(`[seed] job=${this.ctx.jobId} target baseline resync over ${universe.rules.length} rule(s)`);
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const onAbort = (): void => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    signal.removeEventListener("abort", onAbort);
    return seedBaselineVerdict({ exitCode, stderr });
  }

  /** Delete this job's relay objects. Idempotent, and safe to retry. */
  private async cleanup(): Promise<void> {
    try {
      const result = await cleanupSeedRelayObjects({
        store: this.store,
        keys: [
          seedRelayArchiveKey(this.ctx.jobId, this.job.archive.format),
          seedRelayManifestKey(this.ctx.jobId),
        ],
        cleanup: this.job.archive.cleanup,
        now: this.now(),
      });
      this.log(
        `[seed] job=${this.ctx.jobId} relay cleanup complete=${result.complete} deleted=${result.deleted.length}`,
      );
    } catch (err) {
      this.log(`[seed] job=${this.ctx.jobId} relay cleanup failed: ${reason(err)}`);
    }
  }
}

/** The transported document as `verifyExtractedTree`'s manifest input. */
function documentAsManifest(document: SeedManifestDocument): SeedManifest {
  return {
    entries: document.entries.map((entry) => ({ ...entry })),
    fileCount: document.fileCount,
    dirCount: document.dirCount,
    totalBytes: document.totalBytes,
    fingerprint: document.fingerprint,
    statsFingerprint: "",
    unsupported: [],
    emptyDirsPruned: [],
    filter: {
      fingerprint: document.filterFingerprint ?? SEED_EMPTY_FILTER_FINGERPRINT,
      patternCount: 0,
      skippedCount: 0,
      skippedSample: [],
    },
  };
}
