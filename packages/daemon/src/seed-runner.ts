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
  type LamaSyncApiClient,
  type SeedJob,
  type SeedJobArchiveFacts,
  type SeedJobPhase,
  type SeedJobRole,
  type SeedManifestDocument,
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

export interface SeedActionContext {
  client: LamaSyncApiClient;
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
class SeedStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedStopped";
  }
}

function bounded(message: string, max = 300): string {
  return message.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Run one side of one seed job to its terminal point.
 *
 * The caller (the daemon's action dispatcher) has already made sure the action
 * is single-flight and holds a renewed action lease.
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
  if (relay === null) {
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

  const store = createS3SeedRelayStore(relay);
  const workDir = join(ctx.dataDir, "seed-work", ctx.jobId);
  mkdirSync(workDir, { recursive: true });
  const runner = new SeedSideRunner(ctx, job, role, store, workDir, now, log);
  try {
    return role === "source" ? await runner.runSource() : await runner.runTarget();
  } catch (err) {
    if (err instanceof SeedStopped) {
      log(`[seed] job=${ctx.jobId} stopped: ${err.message}`);
      return { status: "done", result: bounded(`the seed job ended while this side was working: ${err.message}`) };
    }
    const message = bounded(reason(err));
    log(`[seed] job=${ctx.jobId} ${role} failed: ${message}`);
    await runner.failJob(message);
    return { status: "failed", result: message };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One side of one job, with the server as its only authority. */
class SeedSideRunner {
  private job: SeedJob;

  constructor(
    private readonly ctx: SeedActionContext,
    job: SeedJob,
    private readonly role: SeedJobRole,
    private readonly store: ReturnType<typeof createS3SeedRelayStore>,
    private readonly workDir: string,
    private readonly now: () => number,
    private readonly log: (message: string) => void,
  ) {
    this.job = job;
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
    try {
      this.job = await this.ctx.client.reportSeedProgress(this.ctx.jobId, { phase, message, ...totals });
    } catch (err) {
      throw new SeedStopped(`the server refused the ${phase} phase: ${reason(err)}`);
    }
    if (isTerminalSeedPhase(this.job.phase)) {
      throw new SeedStopped(`the job is ${this.job.phase}`);
    }
    this.log(`[seed] job=${this.ctx.jobId} ${this.role} phase=${phase}`);
  }

  /** Renew the lease without changing the phase. */
  private async renew(): Promise<void> {
    try {
      await this.ctx.client.renewSeedJobLease(this.ctx.jobId);
    } catch {
      // A refusal means the lease is gone; the next phase report will say so.
    }
  }

  /** Stop as soon as the job is terminal — an operator cancellation, mostly. */
  private async checkLive(): Promise<void> {
    let current: SeedJob;
    try {
      current = await this.ctx.client.getSeedJob(this.ctx.jobId);
    } catch {
      return;
    }
    this.job = current;
    if (isTerminalSeedPhase(current.phase)) throw new SeedStopped(`the job is ${current.phase}`);
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
    const { localPath, folderType } = await this.assignment();
    const assignment = this.assignmentRecord();
    if (assignment === null) throw new Error(`this device is not assigned folder ${this.job.folderId}`);
    if (folderType !== "sync") throw new Error("only sync assignments can be seeded");

    await this.enter("measuring_source", "Building the effective-filter manifest.");
    const built = await buildSeedSourceManifest(assignment, folderType);
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
    const archive = await createSeedArchive({
      format: this.job.archive.format,
      sourceRoot: localPath,
      outputPath: archivePath,
      manifest,
      filter: built.universe,
    });
    if (!archive.ok || archive.sha256 === null) {
      throw new Error(bounded(`archive creation failed: ${archive.error ?? "no digest"}`, 200));
    }
    await this.checkLive();

    await this.enter("uploading_archive", "Uploading the archive and manifest to the temporary seed space.", {
      bytesTotal: archive.bytes,
    });
    const uploaded = await uploadSeedArchive({
      store: this.store,
      jobId: this.ctx.jobId,
      format: this.job.archive.format,
      archivePath,
      manifestFingerprint: manifest.fingerprint,
      memberCount: archive.memberCount,
      now: this.now(),
    });
    if (!uploaded.ok || uploaded.metadata === null) {
      throw new Error(bounded(`archive upload failed: ${uploaded.error ?? "no metadata"}`, 200));
    }
    const manifestUpload = await uploadSeedManifest({
      store: this.store,
      jobId: this.ctx.jobId,
      manifest,
      now: this.now(),
    });
    if (!manifestUpload.ok || manifestUpload.metadata === null) {
      throw new Error(bounded(`manifest upload failed: ${manifestUpload.error ?? "no metadata"}`, 200));
    }
    const facts: SeedJobArchiveFacts = {
      ...uploaded.archive,
      manifestObjectKey: manifestUpload.metadata.objectKey,
      manifestBytes: manifestUpload.metadata.bytes,
      manifestSha256: manifestUpload.metadata.sha256,
    };
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
    const deadline = this.now() + timeoutMs;
    for (;;) {
      await this.checkLive();
      if (seedArchiveFactsComplete(this.job.archive)) return this.job;
      if (this.now() > deadline) {
        throw new Error("timed out waiting for the source to record its archive facts");
      }
      await this.renew();
      await Bun.sleep(500);
    }
  }

  async runTarget(): Promise<SeedActionOutcome> {
    const { localPath, folderType } = await this.assignment();
    if (folderType !== "sync") throw new Error("only sync assignments can be seeded");

    const job = await this.waitForSourceFacts(30 * 60_000);
    const archivePath = join(this.workDir, "payload.archive");

    await this.enter("downloading_archive", "Downloading the archive from the temporary seed space.", {
      bytesTotal: job.archive.bytes,
    });
    const downloaded = await downloadSeedArchive({
      store: this.store,
      archive: job.archive,
      jobId: this.ctx.jobId,
      destPath: archivePath,
      now: this.now(),
    });
    if (!downloaded.ok) {
      throw new Error(bounded(`archive download failed: ${downloaded.error ?? "unknown"}`, 200));
    }

    await this.enter("verifying_archive", "Downloading the manifest and re-deriving the source universe.");
    const manifestPath = join(this.workDir, "manifest.json");
    const manifestDownload = await downloadSeedManifest({
      store: this.store,
      archive: job.archive,
      jobId: this.ctx.jobId,
      destPath: manifestPath,
    });
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

    await this.enter("extracting_target", "Extracting into the staging sibling.", {
      entriesTotal: document.entries.length,
    });
    const extracted = await extractSeedArchive({
      format: job.archive.format,
      archivePath,
      stagingDir,
    });
    if (!extracted.ok) {
      throw new Error(bounded(`extraction failed: ${extracted.error ?? "unknown"}`, 200));
    }

    await this.enter("verifying_target", "Verifying the extracted tree against the transported manifest.");
    const verified = await verifyExtractedTree({ root: stagingDir, manifest: documentAsManifest(document) });
    if (!verified.ok) {
      throw new Error(bounded(`tree verification failed: ${verified.message}`, 200));
    }

    await this.enter("publishing", "Publishing the staging tree with one atomic rename.");
    const published = publishStagedTree({ stagingDir, targetPath: localPath });
    if (!published.ok) {
      throw new Error(bounded(`publication failed: ${published.error ?? "unknown"}`, 200));
    }

    await this.enter("baseline_validation", "Running a resync against the assignment's peer and requiring no change.");
    const baseline = await this.runBaselineValidation();
    if (!baseline.ok) throw new Error(bounded(baseline.message, 200));

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
   */
  private async runBaselineValidation(): Promise<SeedBaselineVerdict> {
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
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
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
