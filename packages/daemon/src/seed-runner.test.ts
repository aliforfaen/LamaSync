// LAMA-346 Stage 2e — the shipped daemon's seed side, driven by a fake server.
//
// What this file is for: the E2E proves the real path end to end, but it cannot
// cheaply prove the NEGATIVE cases — a cancellation that lands in the middle of a
// long stage, a lease that has to survive one, or the exact set of files a failed
// run is allowed to remove. So the server here is a small model that enforces the
// rules the routes enforce (role ownership of a phase, adjacency, a LIVE lease for
// the handover write, terminal states), a fake clock drives the lease, and an
// injectable relay store lets one call block so a cancellation can be injected
// exactly where it matters.
//
// No network, no Docker and no rclone are needed for any of it.

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptySeedJobArchiveFacts,
  isTerminalSeedPhase,
  LamaSyncApiError,
  seedJobPhaseRole,
  seedPhaseIndex,
  type HostConfig,
  type SeedJob,
  type SeedJobArchiveFacts,
  type SeedJobPhase,
  type SeedJobPhaseOrTerminal,
  type SeedJobRole,
  type SeedRelayStore,
} from "@lamasync/core";
import { detectArchiveTooling } from "./seed-archive.ts";
import { createLocalSeedRelayStore } from "./seed-relay-local.ts";
import {
  normalizeSeedRelayEndpoint,
  runSeedAction,
  type SeedRunnerClient,
} from "./seed-runner.ts";
import type { SeedLeaseScheduler } from "./seed-lease-supervisor.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "lama346-runner-"));
const SOURCE_ROOT = join(SANDBOX, "source");
const TARGET_ROOT = join(SANDBOX, "target");
const DATA_DIR = join(SANDBOX, "data");
const FOLDER_ID = "runner-folder";
const JOB_ID = "stage2e-job-0001";
const SOURCE_HOST = "runner-source";
const TARGET_HOST = "runner-target";

/**
 * A fresh relay namespace per test. The store is immutable per key, and a job id
 * is reused across these tests, so sharing one root would (correctly) refuse the
 * second test's differently-timestamped archive.
 */
function newRelayRoot(): string {
  return mkdtempSync(join(SANDBOX, "relay-"));
}

const tooling = await detectArchiveTooling();
const FORMAT = tooling.zstd === true ? ("tar.zstd" as const) : ("tar.gz" as const);
const RCLONE_AVAILABLE = Bun.which("rclone") !== null;

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

test("bare S3 relay endpoints default to HTTPS; explicit schemes are retained", () => {
  expect(normalizeSeedRelayEndpoint("s3.eu-central-003.backblazeb2.com")).toBe(
    "https://s3.eu-central-003.backblazeb2.com/",
  );
  expect(normalizeSeedRelayEndpoint("http://127.0.0.1:39001")).toBe("http://127.0.0.1:39001/");
  expect(normalizeSeedRelayEndpoint("https://s3.example.com")).toBe("https://s3.example.com/");
  expect(() => normalizeSeedRelayEndpoint("ftp://s3.example.com")).toThrow(
    "the seed relay endpoint must use HTTP or HTTPS",
  );
});

/** The Projects shape in miniature: content, an ignored subtree and git metadata. */
function buildSource(): void {
  rmSync(SOURCE_ROOT, { recursive: true, force: true });
  mkdirSync(SOURCE_ROOT, { recursive: true });
  writeFileSync(join(SOURCE_ROOT, ".lamasyncignore"), "- node_modules/\n- *.log\n");
  for (let i = 0; i < 12; i += 1) {
    const dir = join(SOURCE_ROOT, "src", `module-${String(i % 3).padStart(2, "0")}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `file-${String(i).padStart(3, "0")}.ts`), `export const n${i} = ${i};\n`);
  }
  writeFileSync(join(SOURCE_ROOT, "README.md"), "# runner fixture\n");
  mkdirSync(join(SOURCE_ROOT, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(SOURCE_ROOT, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  mkdirSync(join(SOURCE_ROOT, ".git", "objects"), { recursive: true });
  writeFileSync(join(SOURCE_ROOT, ".git", "config"), "[core]\n");
  writeFileSync(join(SOURCE_ROOT, "debug.log"), "ignored\n");
}

function assignment(hostId: string, localPath: string) {
  return {
    id: `${hostId}-assignment`,
    folderId: FOLDER_ID,
    hostId,
    role: "both" as const,
    localPath,
    enabled: true,
    ignorePath: ".lamasyncignore",
    ignoreGitMetadata: true,
  };
}

function hostConfig(hostId: string, localPath: string, badPeer = false): HostConfig {
  return {
    host: { id: hostId, hostname: hostId, status: "online" },
    // `badPeer` makes the assignment's destination an absolute path, which the
    // canonical destination rule refuses. That models "this device has no usable
    // resync peer" deterministically, without needing rclone or a real remote.
    assignments: [
      {
        ...assignment(hostId, localPath),
        ...(badPeer ? { destination: "/absolute/path" } : {}),
      },
    ],
    folders: [{ id: FOLDER_ID, name: "runner-folder", type: "sync" }],
    apps: [],
    rcloneConfig: "",
    serverTailnetIp: null,
    peers: [],
  };
}

function jobFixture(overrides: Partial<SeedJob> = {}): SeedJob {
  const now = 1_000_000;
  return {
    id: JOB_ID,
    planId: "plan-1",
    folderId: FOLDER_ID,
    hostId: TARGET_HOST,
    sourceHostId: SOURCE_HOST,
    assignmentId: `${TARGET_HOST}-assignment`,
    status: "running",
    phase: "preflight",
    progress: {
      phase: "preflight",
      phaseIndex: 0,
      phaseCount: 10,
      message: "",
      bytesDone: 0,
      bytesTotal: null,
      entriesDone: 0,
      entriesTotal: null,
      updatedAt: now,
    },
    source: { fileCount: 0, totalBytes: 0, measuredAt: now, measuredOnHostId: SOURCE_HOST, manifestFingerprint: null },
    archive: emptySeedJobArchiveFacts(FORMAT),
    staging: { path: "", targetPath: "", requiredFreeBytes: 0, freeBytesAtPlan: 0 },
    leaseOwner: null,
    leaseExpiresAt: null,
    error: null,
    summary: null,
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    finishedAt: null,
    ...overrides,
  };
}

/**
 * A model of the seed routes, not of the runner's expectations.
 *
 * It enforces the three rules that matter to the runner: a phase belongs to one
 * role and follows the previous one, the handover write needs a LIVE lease held
 * by the source, and a terminal job refuses everything.
 */
class FakeSeedServer implements SeedRunnerClient {
  phase: SeedJobPhaseOrTerminal = "preflight";
  status: "running" | "completed" | "failed" | "cancelled" = "running";
  leaseOwner: string | null = null;
  leaseExpiresAt: number | null = null;
  archive: SeedJobArchiveFacts = emptySeedJobArchiveFacts(FORMAT);
  error: string | null = null;
  summary: string | null = null;

  renewals = 0;
  progressReports: SeedJobPhase[] = [];
  factsWrites = 0;
  completions = 0;
  failures = 0;
  refusals = 0;
  /** The SOURCE's facts, handed over only after a few reads (a real wait). */
  pendingFacts: SeedJobArchiveFacts | null = null;
  factsAfterReads = 3;
  private readsForFacts = 0;
  /**
   * A trap, not a preference: a TARGET that renews the lease before it holds any
   * phase is asking the server to renew a phase that belongs to the source. The
   * lease route refuses that, and a supervisor that read the refusal as "the job
   * is lost" would abandon a healthy wait — the bug this flag exists to catch.
   */
  refuseRenewBeforeClaim = false;

  constructor(
    private readonly now: () => number,
    private readonly role: SeedJobRole,
    private readonly hostId: string,
  ) {}

  private job(): SeedJob {
    return jobFixture({
      phase: this.phase,
      status: this.status,
      leaseOwner: this.leaseOwner,
      leaseExpiresAt: this.leaseExpiresAt,
      archive: this.archive,
      error: this.error,
      summary: this.summary,
    });
  }

  private refuse(why: string): never {
    this.refusals += 1;
    throw new LamaSyncApiError(409, JSON.stringify({ error: why }));
  }

  async getSeedJob(_jobId: string): Promise<SeedJob> {
    if (this.pendingFacts !== null) {
      this.readsForFacts += 1;
      if (this.readsForFacts >= this.factsAfterReads) {
        this.archive = this.pendingFacts;
        this.pendingFacts = null;
      }
    }
    return this.job();
  }

  async reportSeedProgress(
    _jobId: string,
    body: { phase: SeedJobPhase; bytesTotal?: number | null; entriesTotal?: number | null },
  ): Promise<SeedJob> {
    if (this.status !== "running" || isTerminalSeedPhase(this.phase)) this.refuse("not running");
    if (seedJobPhaseRole(body.phase) !== this.role) this.refuse("wrong side");
    const current = seedPhaseIndex(this.phase);
    const next = seedPhaseIndex(body.phase);
    if (next !== current && next !== current + 1) this.refuse("not adjacent");
    // A phase report renews the lease for the reporting side.
    this.phase = body.phase;
    this.leaseOwner = this.hostId;
    this.leaseExpiresAt = this.now() + 30_000;
    this.progressReports.push(body.phase);
    return this.job();
  }

  async recordSeedArchiveFacts(_jobId: string, facts: SeedJobArchiveFacts): Promise<SeedJob> {
    if (this.phase !== "uploading_archive") this.refuse("wrong phase for the handover");
    if (this.leaseOwner !== this.hostId) this.refuse("not the lease holder");
    // The rule the whole stage-supervisor exists for: the handover needs a LIVE
    // lease. Without a renewal during a long upload this is exactly where a
    // healthy seed would die.
    if (this.leaseExpiresAt === null || this.leaseExpiresAt <= this.now()) this.refuse("lease lapsed");
    if (this.archive.sha256 !== null) {
      this.factsWrites += 1;
      if (JSON.stringify(this.archive) === JSON.stringify(facts)) return this.job();
      this.refuse("facts are immutable");
    }
    this.archive = { ...facts };
    this.leaseOwner = null;
    this.leaseExpiresAt = null;
    this.factsWrites += 1;
    return this.job();
  }

  async renewSeedJobLease(_jobId: string, leaseMs: number): Promise<SeedJob> {
    this.renewals += 1;
    if (this.refuseRenewBeforeClaim && this.progressReports.length === 0) {
      throw new Error("a side renewed the job lease before it owned any phase");
    }
    if (this.status !== "running" || isTerminalSeedPhase(this.phase)) this.refuse("not running");
    if (this.leaseOwner !== this.hostId) this.refuse("not the lease holder");
    if (this.leaseExpiresAt === null || this.leaseExpiresAt <= this.now()) this.refuse("lease lapsed");
    this.leaseExpiresAt = this.now() + leaseMs;
    return this.job();
  }

  async completeSeedJob(
    _jobId: string,
    body: { status: "completed" | "failed"; summary?: string | null; error?: string | null },
  ): Promise<SeedJob> {
    if (this.status !== "running" || isTerminalSeedPhase(this.phase)) this.refuse("already finished");
    if (body.status === "completed") {
      if (this.role !== "target") this.refuse("only the target completes a job");
      this.completions += 1;
    } else {
      this.failures += 1;
    }
    this.status = body.status === "completed" ? "completed" : "failed";
    this.phase = this.status;
    this.summary = body.summary ?? null;
    this.error = body.error ?? null;
    this.leaseOwner = null;
    this.leaseExpiresAt = null;
    return this.job();
  }
}

/** A scheduler whose registered callback the test fires by hand. */
function manualScheduler(): { scheduler: SeedLeaseScheduler; pending: Array<() => void> } {
  const pending: Array<() => void> = [];
  return {
    scheduler: (fn) => {
      pending.push(fn);
      return {
        cancel: () => {
          const index = pending.indexOf(fn);
          if (index >= 0) pending.splice(index, 1);
        },
      };
    },
    pending,
  };
}

/** Wrap a store so one operation can be held open (and abort-aware). */
function gatedStore(
  inner: SeedRelayStore,
  gate: { onPut?: (signal: AbortSignal | undefined) => Promise<void>; onGet?: (signal: AbortSignal | undefined) => Promise<void> },
): SeedRelayStore {
  return {
    kind: inner.kind,
    put: async (input) => {
      if (gate.onPut) await gate.onPut(input.signal);
      return inner.put(input);
    },
    head: (key) => inner.head(key),
    get: async (input) => {
      if (gate.onGet) await gate.onGet(input.signal);
      return inner.get(input);
    },
    delete: (key) => inner.delete(key),
    list: (prefix) => inner.list(prefix),
  };
}

function context(
  client: SeedRunnerClient,
  hostId: string,
  localPath: string,
  extras: {
    store?: SeedRelayStore;
    now: () => number;
    scheduler?: SeedLeaseScheduler;
    peer?: string;
    /** Make the assignment's destination unresolvable (no usable peer). */
    badPeer?: boolean;
  },
): Parameters<typeof runSeedAction>[0] {
  if (extras.peer !== undefined) process.env.LAMASYNC_SEED_DAEMON_PEER_PATH = extras.peer;
  else delete process.env.LAMASYNC_SEED_DAEMON_PEER_PATH;
  return {
    client,
    hostId,
    jobId: JOB_ID,
    payloadRole: hostId === SOURCE_HOST ? "source" : "target",
    getHostConfig: () => hostConfig(hostId, localPath, extras.badPeer === true),
    refreshConfig: async () => true,
    dataDir: DATA_DIR,
    log: () => {},
    now: extras.now,
    leaseMs: 30_000,
    leaseIntervalMs: 15_000,
    ...(extras.store === undefined ? {} : { store: extras.store }),
    ...(extras.scheduler === undefined ? {} : { leaseScheduler: extras.scheduler }),
  };
}

/** The seam must be open for the runner to do anything at all. */
function openSeam(): void {
  process.env.LAMASYNC_SEED_E2E = "1";
  process.env.LAMASYNC_TEST = "1";
}

/** Resolve once the run has reached the given phase, or fail on a timeout. */
async function waitForPhase(logs: string[], phase: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (logs.some((line) => line.includes(`phase=${phase}`))) return;
    await Bun.sleep(10);
  }
  throw new Error(`the run never entered ${phase}: ${logs.join(" | ")}`);
}

describe("the source side", () => {
  test("archives, uploads, records the facts and finishes", async () => {
    openSeam();
    buildSource();
    const clock = { now: 1_000_000 };
    const server = new FakeSeedServer(() => clock.now, "source", SOURCE_HOST);
    const store = createLocalSeedRelayStore({ rootDir: newRelayRoot() });
    process.env.LAMASYNC_SEED_STAGE_DELAY_PHASE = "uploading_archive";
    process.env.LAMASYNC_SEED_STAGE_DELAY_MS = "30";
    try {
      const outcome = await runSeedAction(
        context(server, SOURCE_HOST, SOURCE_ROOT, { store, now: () => clock.now }),
      );
      expect(outcome.status).toBe("done");
      expect(server.progressReports).toEqual([
        "measuring_source",
        "archiving_source",
        "uploading_archive",
      ]);
      expect(server.factsWrites).toBe(1);
      expect(server.archive.sha256).not.toBeNull();
      expect(server.archive.manifestSha256).not.toBeNull();
      // The handover cleared the lease: the target can claim, the source cannot
      // keep renewing into the target's half.
      expect(server.leaseOwner).toBeNull();
      expect(server.refusals).toBe(0);
    } finally {
      delete process.env.LAMASYNC_SEED_STAGE_DELAY_PHASE;
      delete process.env.LAMASYNC_SEED_STAGE_DELAY_MS;
    }
  });
});

describe("a cancellation during a long source stage", () => {
  test("stops the side, records no facts, and does not report a job failure", async () => {
    openSeam();
    buildSource();
    const clock = { now: 1_000_000 };
    const server = new FakeSeedServer(() => clock.now, "source", SOURCE_HOST);
    const inner = createLocalSeedRelayStore({ rootDir: newRelayRoot() });
    const manual = manualScheduler();

    let enteredUpload: () => void = () => {};
    const uploading = new Promise<void>((resolve) => {
      enteredUpload = resolve;
    });
    let abortSeen = false;
    const store = gatedStore(inner, {
      onPut: (signal) =>
        new Promise<void>((resolve) => {
          enteredUpload();
          if (signal?.aborted === true) {
            abortSeen = true;
            resolve();
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              abortSeen = true;
              resolve();
            },
            { once: true },
          );
        }),
    });

    const logs: string[] = [];
    const run = runSeedAction({
      ...context(server, SOURCE_HOST, SOURCE_ROOT, { store, now: () => clock.now, scheduler: manual.scheduler }),
      log: (message: string) => logs.push(message),
    });
    await uploading;
    // The operator cancels mid-upload, and the lease timer fires: the supervisor
    // asks the server, is refused, reads the row, and latches a stop.
    server.status = "cancelled";
    server.phase = "cancelled";
    for (const fire of [...manual.pending]) fire();

    const outcome = await run;
    expect(outcome.status).toBe("done"); // a stop, NOT a failed job
    expect(outcome.result).toContain("the job is cancelled");
    expect(abortSeen).toBe(true); // the stage really was interrupted
    expect(server.factsWrites).toBe(0);
    expect(server.failures).toBe(0);
    expect(logs.some((line) => line.includes("stopped"))).toBe(true);
  });
});

describe("a cancellation during the target's download", () => {
  test("publishes nothing, and removes only its own staging and work directory", async () => {
    openSeam();
    buildSource();
    rmSync(TARGET_ROOT, { recursive: true, force: true });
    mkdirSync(TARGET_ROOT, { recursive: true });
    const clock = { now: 1_000_000 };
    const server = new FakeSeedServer(() => clock.now, "source", SOURCE_HOST);
    const inner = createLocalSeedRelayStore({ rootDir: newRelayRoot() });
    // The facts the target needs, as the source would have written them.
    const sourceRun = await runSeedAction(
      context(server, SOURCE_HOST, SOURCE_ROOT, { store: inner, now: () => clock.now }),
    );
    expect(sourceRun.status).toBe("done");

    const target = new FakeSeedServer(() => clock.now, "target", TARGET_HOST);
    target.archive = server.archive;
    target.phase = "downloading_archive";
    const manual = manualScheduler();
    let enteredDownload: () => void = () => {};
    const downloading = new Promise<void>((resolve) => {
      enteredDownload = resolve;
    });
    let abortSeen = false;
    const store = gatedStore(inner, {
      onGet: (signal) =>
        new Promise<void>((resolve) => {
          enteredDownload();
          if (signal?.aborted === true) {
            abortSeen = true;
            resolve();
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              abortSeen = true;
              resolve();
            },
            { once: true },
          );
        }),
    });

    const logs: string[] = [];
    const run = runSeedAction({
      ...context(target, TARGET_HOST, TARGET_ROOT, { store, now: () => clock.now, scheduler: manual.scheduler }),
      log: (message: string) => logs.push(message),
    });
    await downloading;
    await waitForPhase(logs, "downloading_archive");
    target.status = "cancelled";
    target.phase = "cancelled";
    for (const fire of [...manual.pending]) fire();

    const outcome = await run;
    expect(outcome.status).toBe("done");
    expect(outcome.result).toContain("the job is cancelled");
    expect(abortSeen).toBe(true);

    // The headline assertion: NOTHING was published, and the run left no
    // half-extracted tree for the next attempt to trip over.
    expect(target.completions).toBe(0);
    expect(target.failures).toBe(0);
    expect(existsSync(join(TARGET_ROOT, "README.md"))).toBe(false);
    const stagingLeft = readdirSync(SANDBOX).filter((name) => name.includes("lamasync-seed-staging"));
    expect(stagingLeft).toEqual([]);
    expect(existsSync(join(DATA_DIR, "seed-work", JOB_ID))).toBe(false);
  });
});

describe("the target's wait for the source", () => {
  test("never renews the job lease while the source owns the job", async () => {
    openSeam();
    buildSource();
    rmSync(TARGET_ROOT, { recursive: true, force: true });
    mkdirSync(TARGET_ROOT, { recursive: true });
    const clock = { now: 1_000_000 };
    const source = new FakeSeedServer(() => clock.now, "source", SOURCE_HOST);
    const store = createLocalSeedRelayStore({ rootDir: newRelayRoot() });
    expect(
      (await runSeedAction(context(source, SOURCE_HOST, SOURCE_ROOT, { store, now: () => clock.now }))).status,
    ).toBe("done");

    const target = new FakeSeedServer(() => clock.now, "target", TARGET_HOST);
    target.phase = "uploading_archive";
    // The facts appear only after a few polls, so the wait really runs.
    target.pendingFacts = source.archive;
    target.refuseRenewBeforeClaim = true;
    const outcome = await runSeedAction(
      context(target, TARGET_HOST, TARGET_ROOT, { store, now: () => clock.now, badPeer: true }),
    );
    // It got past the wait, claimed and published — and only the unusable peer
    // stopped it from completing, which is the fail-closed gate.
    expect(outcome.status).toBe("failed");
    expect(outcome.result).toContain("could not be resolved");
    expect(target.progressReports[0]).toBe("downloading_archive");
    expect(target.refusals).toBe(0);
    expect(target.completions).toBe(0);
  });
});

describe("the target's fail-closed completion gate", () => {
  test("publishes the verified tree but refuses to complete without a usable resync peer", async () => {
    openSeam();
    buildSource();
    rmSync(TARGET_ROOT, { recursive: true, force: true });
    mkdirSync(TARGET_ROOT, { recursive: true });
    const clock = { now: 1_000_000 };
    const server = new FakeSeedServer(() => clock.now, "source", SOURCE_HOST);
    const store = createLocalSeedRelayStore({ rootDir: newRelayRoot() });
    const sourceRun = await runSeedAction(
      context(server, SOURCE_HOST, SOURCE_ROOT, { store, now: () => clock.now }),
    );
    expect(sourceRun.status).toBe("done");

    const target = new FakeSeedServer(() => clock.now, "target", TARGET_HOST);
    target.archive = server.archive;
    target.phase = "downloading_archive";
    const outcome = await runSeedAction(
      context(target, TARGET_HOST, TARGET_ROOT, { store, now: () => clock.now, badPeer: true }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.result).toContain("could not be resolved");
    expect(target.completions).toBe(0);
    // It DID publish: the tree was verified first, and the missing proof is the
    // only thing that stopped the job from being reported complete.
    expect(readFileSync(join(TARGET_ROOT, "README.md"), "utf8")).toContain("runner fixture");
    expect(existsSync(join(TARGET_ROOT, "node_modules"))).toBe(false);
    expect(existsSync(join(TARGET_ROOT, "debug.log"))).toBe(false);
  });
});

describe("a target that completes with a real zero-change baseline", () => {
  test.skipIf(!RCLONE_AVAILABLE)("completes, cleans the relay objects and leaves no staging", async () => {
    openSeam();
    buildSource();
    rmSync(TARGET_ROOT, { recursive: true, force: true });
    mkdirSync(TARGET_ROOT, { recursive: true });
    const clock = { now: 1_000_000 };
    const server = new FakeSeedServer(() => clock.now, "source", SOURCE_HOST);
    const store = createLocalSeedRelayStore({ rootDir: newRelayRoot() });
    expect(
      (await runSeedAction(context(server, SOURCE_HOST, SOURCE_ROOT, { store, now: () => clock.now }))).status,
    ).toBe("done");

    const target = new FakeSeedServer(() => clock.now, "target", TARGET_HOST);
    target.archive = server.archive;
    target.phase = "downloading_archive";
    const logs: string[] = [];
    const outcome = await runSeedAction({
      ...context(target, TARGET_HOST, TARGET_ROOT, { store, now: () => clock.now, peer: SOURCE_ROOT }),
      log: (message: string) => logs.push(message),
    });
    expect(outcome.status).toBe("done");
    expect(target.completions).toBe(1);
    expect(logs.some((line) => line.includes("relay cleanup complete=true"))).toBe(true);
    expect(readFileSync(join(TARGET_ROOT, "README.md"), "utf8")).toContain("runner fixture");
  });
});
