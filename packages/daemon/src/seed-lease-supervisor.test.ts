// LAMA-346 Stage 2e — the seed job lease supervisor.
//
// These tests are about ONE thing: a healthy, still-progressing seed stage must
// never lose its job lease, and a run that HAS lost it (or been cancelled) must
// stop before it does anything irreversible. The stage is simulated with a fake
// clock and an explicitly fired timer so the policy is deterministic — the
// alternative (sleeping for ten real minutes) would test nothing reliably.

import { describe, expect, test } from "bun:test";
import {
  emptySeedJobArchiveFacts,
  isTerminalSeedPhase,
  LamaSyncApiError,
  SEED_JOB_LEASE_MS,
  type SeedJob,
  type SeedJobPhaseOrTerminal,
} from "@lamasync/core";
import {
  SeedJobLeaseSupervisor,
  SeedStopped,
  type SeedLeaseScheduler,
} from "./seed-lease-supervisor.ts";

const OWNER = "seed-source";

function jobFixture(overrides: Partial<SeedJob> = {}): SeedJob {
  const now = Date.now();
  return {
    id: "job-1",
    planId: "plan-1",
    folderId: "f1",
    hostId: "seed-target",
    sourceHostId: OWNER,
    assignmentId: "a1",
    status: "running",
    phase: "uploading_archive",
    progress: {
      phase: "uploading_archive",
      phaseIndex: 0,
      phaseCount: 10,
      message: "",
      bytesDone: 0,
      bytesTotal: null,
      entriesDone: 0,
      entriesTotal: null,
      updatedAt: now,
    },
    source: { fileCount: 10, totalBytes: 1_000, measuredAt: now, measuredOnHostId: OWNER, manifestFingerprint: null },
    archive: emptySeedJobArchiveFacts("tar.zstd"),
    staging: { path: "", targetPath: "/data/t", requiredFreeBytes: 1, freeBytesAtPlan: 10 },
    leaseOwner: OWNER,
    leaseExpiresAt: now + SEED_JOB_LEASE_MS,
    error: null,
    summary: null,
    createdAt: now,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    ...overrides,
  };
}

/**
 * A model of the server's lease rules, not a mock of our own expectations:
 * `renew` mirrors `renewSeedJobLeaseGuarded` exactly (same phase, still running,
 * our lease, STILL LIVE), and `reap` mirrors `reapStaleSeedJobs` (expired lease,
 * or no lease at all for the handover grace). A renewal that our supervisor
 * fails to make in time therefore fails here for the same reason it fails in
 * production: the statement's predicate stops matching.
 */
class FakeLeaseServer {
  phase: SeedJobPhaseOrTerminal = "uploading_archive";
  status: "running" | "completed" | "failed" | "cancelled" = "running";
  leaseOwner: string | null = OWNER;
  leaseExpiresAt: number | null = 0;
  updatedAt = 0;
  renewals = 0;
  reads = 0;
  refusals = 0;
  /** Injected transport failure: a plain Error, i.e. NOT an HTTP refusal. */
  transportError: string | null = null;

  constructor(private readonly now: () => number) {}

  job(): SeedJob {
    return jobFixture({
      phase: this.phase,
      status: this.status,
      leaseOwner: this.leaseOwner,
      leaseExpiresAt: this.leaseExpiresAt,
      updatedAt: this.updatedAt,
    });
  }

  renew = async (leaseMs: number): Promise<SeedJob> => {
    this.renewals += 1;
    if (this.transportError !== null) throw new Error(this.transportError);
    const refuse = (why: string): never => {
      this.refusals += 1;
      throw new LamaSyncApiError(409, JSON.stringify({ error: why }));
    };
    if (this.status !== "running" || isTerminalSeedPhase(this.phase)) refuse("This seed job is not running.");
    if (this.leaseOwner !== OWNER) refuse("This device no longer holds its lease.");
    if (this.leaseExpiresAt === null || this.leaseExpiresAt <= this.now()) {
      refuse("The lease has lapsed; the reaper decides this job now.");
    }
    this.leaseExpiresAt = this.now() + leaseMs;
    this.updatedAt = this.now();
    return this.job();
  };

  read = async (): Promise<SeedJob> => {
    this.reads += 1;
    if (this.transportError !== null) throw new Error(this.transportError);
    return this.job();
  };

  /** Mirrors the server's reaper. Non-zero means a healthy run was killed. */
  reap(): number {
    if (this.status !== "running") return 0;
    if (this.leaseExpiresAt !== null && this.leaseExpiresAt <= this.now()) return 1;
    return 0;
  }
}

/** A scheduler that records what `start()` registered and fires it on demand. */
function manualScheduler(): { scheduler: SeedLeaseScheduler; pending: Array<() => void> } {
  const pending: Array<() => void> = [];
  const scheduler: SeedLeaseScheduler = (fn) => {
    pending.push(fn);
    return {
      cancel: () => {
        const index = pending.indexOf(fn);
        if (index >= 0) pending.splice(index, 1);
      },
    };
  };
  return { scheduler, pending };
}

function logging(): { log: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (message: string) => lines.push(message), lines };
}

function supervisor(
  server: FakeLeaseServer,
  options: { now: () => number; scheduler?: SeedLeaseScheduler; leaseMs?: number; intervalMs?: number; lines?: string[] },
): SeedJobLeaseSupervisor {
  return new SeedJobLeaseSupervisor({
    label: "uploading_archive",
    renewal: server,
    log: options.lines === undefined ? () => {} : (message) => options.lines!.push(message),
    now: options.now,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
  });
}

describe("the supervisor's bounds", () => {
  test("renewal is always well inside the lease, whatever the caller asks", () => {
    let clock = 0;
    const server = new FakeLeaseServer(() => clock);
    // Asking to renew ONCE PER LEASE would leave no margin at all.
    const loose = supervisor(server, { now: () => clock, leaseMs: 600_000, intervalMs: 600_000 });
    expect(loose.leaseMs).toBe(600_000);
    expect(loose.intervalMs).toBe(300_000);
    expect(loose.graceMs).toBe(300_000);

    const fast = supervisor(server, { now: () => clock, leaseMs: 600_000, intervalMs: 1 });
    expect(fast.intervalMs).toBe(1_000);

    // The lease itself is bounded to what the route accepts.
    expect(supervisor(server, { now: () => clock, leaseMs: 1 }).leaseMs).toBe(30_000);
    expect(supervisor(server, { now: () => clock, leaseMs: 99_999_999 }).leaseMs).toBe(3_600_000);
    clock = 0;
  });
});

describe("a stage that outlives the lease TTL", () => {
  test("keeps the lease alive for 40 fake minutes, so no reaper can end it", async () => {
    let clock = 1_000_000;
    const server = new FakeLeaseServer(() => clock);
    server.leaseOwner = OWNER;
    server.leaseExpiresAt = clock + 30_000; // granted when the phase was entered
    const lines: string[] = [];
    const manual = manualScheduler();
    const sup = supervisor(server, {
      now: () => clock,
      scheduler: manual.scheduler,
      leaseMs: 30_000,
      intervalMs: 15_000,
      lines,
    });
    sup.start();
    expect(manual.pending.length).toBe(1);

    // A 40-minute stage. Every 15 s the registered timer fires; the stage keeps
    // working the whole time (this is the exact shape the incident had: a long,
    // perfectly healthy transfer against a 10-minute budget).
    const renewalsDuringStage: number[] = [];
    const aborted = await sup.run(async (signal) => {
      for (let second = 0; second < 2_400; second += 1) {
        clock += 1_000;
        if (clock % 15_000 === 0) {
          for (const fire of [...manual.pending]) fire();
          await Bun.sleep(0);
          renewalsDuringStage.push(server.renewals);
        }
      }
      return signal.aborted;
    });

    expect(aborted).toBe(false);
    expect(sup.failure).toBeNull();
    expect(server.refusals).toBe(0);
    // The timer really did renew DURING the stage, many times, not just at its end.
    expect(renewalsDuringStage.length).toBe(160);
    expect(server.renewals).toBeGreaterThanOrEqual(79);
    // And the lease is still live at the end, so the server's reaper would not
    // have ended a healthy run.
    expect(server.leaseExpiresAt).not.toBeNull();
    expect(server.leaseExpiresAt! > clock).toBe(true);
    expect(server.reap()).toBe(0);
    expect(lines.filter((line) => line.includes("stopped"))).toEqual([]);
    sup.stop();
  });

  test("without renewals the very same stage loses the job — the reported bug", async () => {
    let clock = 1_000_000;
    const server = new FakeLeaseServer(() => clock);
    server.leaseExpiresAt = clock + 30_000;
    const sup = supervisor(server, { now: () => clock, leaseMs: 30_000, intervalMs: 15_000 });
    // No timer is started, so nothing renews: this is the behaviour the review
    // found, and it must fail loudly rather than silently continue.
    clock += 31_000;
    expect(server.reap()).toBe(1);
    await sup.tick();
    expect(sup.failure).toBeInstanceOf(SeedStopped);
    expect(sup.failure?.message).toContain("refused to renew");
    expect(sup.signal.aborted).toBe(true);
  });
});

describe("stopping on the server's answer", () => {
  test("a cancellation is reported as the job's state, not as a failed renewal", async () => {
    let clock = 0;
    const server = new FakeLeaseServer(() => clock);
    server.leaseExpiresAt = clock + 30_000;
    const sup = supervisor(server, { now: () => clock, leaseMs: 30_000, intervalMs: 15_000 });
    sup.start();
    const lines: string[] = [];
    clock += 5_000;
    expect(await sup.tick().then(() => sup.failure)).toBeNull();

    // The operator cancels while the stage is running.
    server.status = "cancelled";
    server.phase = "cancelled";
    await sup.tick();
    expect(sup.failure?.message).toContain("the job is cancelled");
    expect(sup.signal.aborted).toBe(true);
    expect(lines).toEqual([]);
  });

  test("an aborted long operation is a stop, not a stage failure", async () => {
    let clock = 0;
    const server = new FakeLeaseServer(() => clock);
    server.leaseExpiresAt = clock + 30_000;
    const manual = manualScheduler();
    const sup = supervisor(server, { now: () => clock, scheduler: manual.scheduler, leaseMs: 30_000, intervalMs: 15_000 });
    sup.start();

    // The stage models an upload that honours the signal, like the real
    // transport does. Its own result must never be interpreted as a failure.
    const outcome = sup.run(
      (signal) =>
        new Promise<string>((resolve) => {
          if (signal.aborted) {
            resolve("aborted");
            return;
          }
          signal.addEventListener("abort", () => resolve("aborted"), { once: true });
        }),
    );
    // Attached immediately: the rejection is expected, and an unhandled
    // rejection would be a test artefact rather than a finding.
    const settled = outcome.then(
      () => "resolved" as const,
      (err: unknown) => err,
    );
    clock += 20_000;
    server.status = "failed";
    server.phase = "failed";
    for (const fire of manual.pending) fire();
    await Bun.sleep(0);

    const result = await settled;
    expect(result).toBeInstanceOf(SeedStopped);
    expect(sup.failure?.message).toContain("the job is failed");
  });

  test("a stage that THROWS while aborted is still a stop, not that throw", async () => {
    let clock = 0;
    const server = new FakeLeaseServer(() => clock);
    server.leaseExpiresAt = clock + 30_000;
    const manual = manualScheduler();
    const sup = supervisor(server, { now: () => clock, scheduler: manual.scheduler, leaseMs: 30_000, intervalMs: 15_000 });
    sup.start();

    // A killed pipe, an aborted fetch and a rejected pipeline all surface as a
    // throw rather than as a failure result, so the stop has to win.
    const outcome = sup.run(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("The operation was aborted.")), { once: true });
        }),
    );
    const settled = outcome.then(
      () => "resolved" as const,
      (err: unknown) => err,
    );
    server.status = "cancelled";
    server.phase = "cancelled";
    for (const fire of manual.pending) fire();
    await Bun.sleep(0);

    const result = await settled;
    expect(result).toBeInstanceOf(SeedStopped);
    expect(result instanceof Error ? result.message : "").toContain("the job is cancelled");
  });

  test("a stage that throws while the job is live keeps its own error", async () => {
    let clock = 0;
    const server = new FakeLeaseServer(() => clock);
    server.leaseExpiresAt = clock + 30_000;
    const sup = supervisor(server, { now: () => clock, leaseMs: 30_000, intervalMs: 15_000 });
    const settled = await sup
      .run(async () => {
        throw new Error("the archive was unreadable");
      })
      .then(
        () => "resolved" as const,
        (err: unknown) => err,
      );
    expect(settled).toBeInstanceOf(Error);
    expect(settled instanceof Error ? settled.message : "").toBe("the archive was unreadable");
  });

  test("a 5xx is a transport problem, not a refusal, and is tolerated", async () => {
    let clock = 0;
    const server = new FakeLeaseServer(() => clock);
    server.leaseExpiresAt = clock + 30_000;
    const sup = supervisor(server, { now: () => clock, leaseMs: 30_000, intervalMs: 15_000 });
    server.renew = async () => {
      throw new LamaSyncApiError(503, "{}");
    };
    await sup.tick();
    expect(sup.failure).toBeNull();
  });
});

describe("the bounded grace window", () => {
  test("tolerates transport failures strictly inside the lease, then stops", async () => {
    let clock = 0;
    const server = new FakeLeaseServer(() => clock);
    server.leaseExpiresAt = clock + 30_000;
    server.transportError = "fetch failed";
    const lines: string[] = [];
    const sup = supervisor(server, { now: () => clock, leaseMs: 30_000, intervalMs: 15_000, lines });
    sup.start();

    await sup.tick(); // 0 s: no time lost yet
    expect(sup.failure).toBeNull();
    clock = 14_000;
    await sup.tick(); // still inside the 15 s grace
    expect(sup.failure).toBeNull();
    expect(lines.some((line) => line.includes("grace left"))).toBe(true);

    clock = 15_000;
    await sup.tick();
    expect(sup.failure).toBeInstanceOf(SeedStopped);
    expect(sup.failure?.message).toContain("could not be renewed");
    // It stopped while the lease was still nominally live: at 15 s of a 30 s
    // lease. A correct supervisor never has to be told by a refused write.
    expect(clock < (server.leaseExpiresAt ?? 0)).toBe(true);
  });

  test("a successful renewal resets the grace window", async () => {
    let clock = 0;
    const server = new FakeLeaseServer(() => clock);
    server.leaseExpiresAt = clock + 30_000;
    const sup = supervisor(server, { now: () => clock, leaseMs: 30_000, intervalMs: 15_000 });
    server.transportError = "fetch failed";
    clock = 10_000;
    await sup.tick();
    expect(sup.failure).toBeNull();
    server.transportError = null;
    await sup.tick(); // succeeds: the clock restarts here
    expect(sup.failure).toBeNull();
    server.transportError = "fetch failed";
    clock = 20_000;
    await sup.tick();
    expect(sup.failure).toBeNull();
  });

  test("overlapping ticks collapse into one renewal", async () => {
    let clock = 0;
    const server = new FakeLeaseServer(() => clock);
    server.leaseExpiresAt = clock + 30_000;
    const sup = supervisor(server, { now: () => clock, leaseMs: 30_000, intervalMs: 15_000 });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const original = server.renew;
    server.renew = async (leaseMs: number) => {
      calls += 1;
      await gate;
      return original(leaseMs);
    };
    const first = sup.tick();
    const second = sup.tick();
    await Bun.sleep(0);
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(server.renewals).toBe(1);
    expect(sup.failure).toBeNull();
  });
});

describe("authority immediately before an irreversible step", () => {
  test("refuses when the job went terminal while a long stage ran", async () => {
    let clock = 0;
    const server = new FakeLeaseServer(() => clock);
    server.leaseExpiresAt = clock + 30_000;
    const sup = supervisor(server, { now: () => clock, leaseMs: 30_000, intervalMs: 15_000 });
    server.status = "cancelled";
    server.phase = "cancelled";
    await expect(sup.verifyAuthority()).rejects.toThrow(SeedStopped);
    expect(sup.failure?.message).toContain("the job is cancelled");
  });

  test("proceeds when the job is still ours and live", async () => {
    let clock = 0;
    const server = new FakeLeaseServer(() => clock);
    server.leaseExpiresAt = clock + 30_000;
    const sup = supervisor(server, { now: () => clock, leaseMs: 30_000, intervalMs: 15_000 });
    await sup.verifyAuthority();
    expect(sup.failure).toBeNull();
    expect(server.reads).toBe(1);
    // It READS the server; it does not trust a cached view.
    server.phase = "publishing";
    await sup.verifyAuthority();
    expect(server.reads).toBe(2);
    expect(sup.failure).toBeNull();
  });

  test("a transport blip while reading is governed by the grace window, not by a refusal", async () => {
    let clock = 0;
    const server = new FakeLeaseServer(() => clock);
    server.leaseExpiresAt = clock + 30_000;
    const sup = supervisor(server, { now: () => clock, leaseMs: 30_000, intervalMs: 15_000 });
    server.transportError = "ECONNRESET";
    await sup.verifyAuthority();
    expect(sup.failure).toBeNull();
  });

  test("a refusal while reading is a stop", async () => {
    let clock = 0;
    const server = new FakeLeaseServer(() => clock);
    server.leaseExpiresAt = clock + 30_000;
    const sup = supervisor(server, { now: () => clock, leaseMs: 30_000, intervalMs: 15_000 });
    server.read = async () => {
      throw new LamaSyncApiError(404, "{}");
    };
    await expect(sup.verifyAuthority()).rejects.toThrow(SeedStopped);
    expect(sup.failure?.message).toContain("could not be read");
  });
});

describe("lifecycle", () => {
  test("stop() is clean: no failure, no abort, and the timer is cancelled", async () => {
    let clock = 0;
    const server = new FakeLeaseServer(() => clock);
    server.leaseExpiresAt = clock + 30_000;
    const manual = manualScheduler();
    const sup = supervisor(server, { now: () => clock, scheduler: manual.scheduler, leaseMs: 30_000, intervalMs: 15_000 });
    sup.start();
    sup.start(); // idempotent
    expect(manual.pending.length).toBe(1);
    sup.stop();
    expect(manual.pending.length).toBe(0);
    expect(sup.failure).toBeNull();
    expect(sup.signal.aborted).toBe(false);
    await sup.tick(); // a manual tick after stop still works...
    expect(sup.failure).toBeNull();
  });

  test("a stop is latched once and never re-explained", async () => {
    let clock = 0;
    const server = new FakeLeaseServer(() => clock);
    server.leaseExpiresAt = clock + 30_000;
    const lines: string[] = [];
    const sup = supervisor(server, { now: () => clock, leaseMs: 30_000, intervalMs: 15_000, lines });
    server.status = "cancelled";
    server.phase = "cancelled";
    await sup.tick();
    const first = sup.failure?.message;
    await sup.tick();
    await sup.tick();
    expect(sup.failure?.message).toBe(first);
    expect(lines.filter((line) => line.includes("lease supervisor stopped")).length).toBe(1);
  });
});
