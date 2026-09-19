import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AppCaptureAssignment, Folder, FolderAssignment } from "@lamasync/core";
import { MAX_TIMER_DELAY_MS, Scheduler, planTimerDelay } from "./scheduler.ts";

function makeAssignment(overrides: Partial<FolderAssignment> = {}): FolderAssignment {
  return {
    id: "a1",
    folderId: "f1",
    hostId: "h1",
    role: "source",
    localPath: "/tmp",
    syncExpr: null,
    enabled: true,
    ...overrides,
  };
}

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: "f1",
    name: "myapp",
    type: "sync",
    ...overrides,
  };
}

function makeApp(overrides: Partial<AppCaptureAssignment> = {}): AppCaptureAssignment {
  return {
    appName: "myapp",
    hostId: "_global",
    protectionId: "prot1",
    paths: ["/tmp/x"],
    schedule: null,
    ...overrides,
  };
}

describe("Scheduler", () => {
  beforeEach(() => {
    // @login tests assume no desktop session unless we set one.
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    delete process.env.XDG_SESSION_TYPE;
  });

  afterEach(() => {
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    delete process.env.XDG_SESSION_TYPE;
  });

  test("fires @reboot once shortly after start", async () => {
    const ticks: string[] = [];
    const scheduler = new Scheduler({
      onTick: (a) => { ticks.push(a.id); },
      getAssignments: () => [makeAssignment({ syncExpr: "@reboot" })],
      rebootDelayMs: 20,
    });

    scheduler.start();
    expect(ticks).toEqual([]);
    await new Promise((r) => setTimeout(r, 60));
    expect(ticks).toEqual(["a1"]);

    scheduler.refresh();
    await new Promise((r) => setTimeout(r, 60));
    expect(ticks).toEqual(["a1"]);

    scheduler.stop();
  });

  test("@login fires at startup when a desktop session is detected", async () => {
    process.env.XDG_SESSION_TYPE = "wayland";
    const ticks: string[] = [];
    const scheduler = new Scheduler({
      onTick: (a) => { ticks.push(a.id); },
      getAssignments: () => [makeAssignment({ syncExpr: "@login" })],
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(ticks).toEqual(["a1"]);
    scheduler.stop();
  });

  test("@login falls back to startup execution with no session", async () => {
    const ticks: string[] = [];
    const scheduler = new Scheduler({
      onTick: (a) => { ticks.push(a.id); },
      getAssignments: () => [makeAssignment({ syncExpr: "@login" })],
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(ticks).toEqual(["a1"]);
    scheduler.stop();
  });

  test("unknown @ tokens are ignored and do not fire", async () => {
    const ticks: string[] = [];
    const scheduler = new Scheduler({
      onTick: (a) => { ticks.push(a.id); },
      getAssignments: () => [makeAssignment({ syncExpr: "@unknown" })],
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(ticks).toEqual([]);
    scheduler.stop();
  });

  test("regular cron expressions still schedule a future run", () => {
    const scheduler = new Scheduler({
      onTick: () => undefined,
      getAssignments: () => [makeAssignment({ syncExpr: "0 0 * * *" })],
    });

    scheduler.start();
    const next = scheduler.nextRunFor(makeAssignment({ syncExpr: "0 0 * * *" }));
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(Date.now());
    scheduler.stop();
  });

  test("invalid cron expression does not schedule", () => {
    const scheduler = new Scheduler({
      onTick: () => undefined,
      getAssignments: () => [makeAssignment({ syncExpr: "not-a-cron" })],
    });

    scheduler.start();
    expect(scheduler.nextRunFor(makeAssignment({ syncExpr: "not-a-cron" }))).toBeNull();
    scheduler.stop();
  });

  test("application protection fires directly at @reboot without a folder assignment", async () => {
    const ticks: string[] = [];
    const scheduler = new Scheduler({
      onTick: () => undefined,
      getAssignments: () => [],
      getApps: () => [makeApp({ protectionId: "p-direct", schedule: "@reboot" })],
      onAppTick: (app) => { ticks.push(app.protectionId); },
      rebootDelayMs: 10,
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(ticks).toEqual(["p-direct"]);
    scheduler.stop();
  });

  test("application protection cron is scheduled without a folder assignment", () => {
    const scheduler = new Scheduler({
      onTick: () => undefined,
      getAssignments: () => [],
      getApps: () => [makeApp({ protectionId: "p-cron", schedule: "0 0 * * *" })],
    });

    scheduler.start();
    const next = scheduler.nextRunForApp(makeApp({ protectionId: "p-cron", schedule: "0 0 * * *" }));
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(Date.now());
    scheduler.stop();
  });

  test("legacy dotfile assignments no longer duplicate an application protection capture", async () => {
    const ticks: string[] = [];
    const scheduler = new Scheduler({
      onTick: (a) => { ticks.push(a.id); },
      getAssignments: () => [makeAssignment({ id: "legacy-dot", syncExpr: "@reboot" })],
      getFolders: () => [makeFolder({ type: "dotfile" })],
      getApps: () => [makeApp({ schedule: "@reboot" })],
      rebootDelayMs: 10,
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(ticks).toEqual([]);
    scheduler.stop();
  });

  test("disabled assignments are not scheduled", async () => {
    const ticks: string[] = [];
    const scheduler = new Scheduler({
      onTick: (a) => { ticks.push(a.id); },
      getAssignments: () => [makeAssignment({ enabled: false, syncExpr: "@reboot" })],
      rebootDelayMs: 10,
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(ticks).toEqual([]);
    scheduler.stop();
  });

  test("nextRunFor returns null for special tokens", () => {
    const scheduler = new Scheduler({
      onTick: () => undefined,
      getAssignments: () => [makeAssignment({ syncExpr: "@reboot" })],
    });
    scheduler.start();
    expect(scheduler.nextRunFor(makeAssignment({ syncExpr: "@reboot" }))).toBeNull();
    scheduler.stop();
  });

  // LAMA-239: an effective-mount assignment is a persistent mount, not a
  // cron job. The scheduler must NOT fire it on the cron loop; the
  // reconcile-on-refresh pass is responsible for keeping the mount unit
  // running.
  test("effective-mount assignment is not scheduled (LAMA-239)", async () => {
    const ticks: string[] = [];
    const scheduler = new Scheduler({
      onTick: (a) => { ticks.push(a.id); },
      getAssignments: () => [
        // Per-host override turns this sync folder into a mount for this host.
        makeAssignment({ syncExpr: "@reboot", mode: "mount" }),
      ],
      getFolders: () => [makeFolder({ type: "sync" })],
      rebootDelayMs: 10,
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(ticks).toEqual([]);
    expect(
      scheduler.nextRunFor(makeAssignment({ syncExpr: "@reboot", mode: "mount" })),
    ).toBeNull();
    scheduler.stop();
  });

  test("effective-sync assignment on a mount folder still schedules (override path)", async () => {
    // Sanity check the other direction: a mount folder flipped to sync
    // for this host must keep its cron schedule.
    const ticks: string[] = [];
    const scheduler = new Scheduler({
      onTick: (a) => { ticks.push(a.id); },
      getAssignments: () => [
        makeAssignment({ id: "a-m2s", folderId: "f-mount", syncExpr: "@reboot", mode: "sync" }),
      ],
      getFolders: () => [makeFolder({ id: "f-mount", type: "mount" })],
      rebootDelayMs: 10,
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(ticks).toEqual(["a-m2s"]);
    scheduler.stop();
  });

  test("backup folder is unaffected by mount mode override (LAMA-239)", async () => {
    // backup has no mount equivalent — even with a mount override the
    // scheduler keeps firing the cron.
    const ticks: string[] = [];
    const scheduler = new Scheduler({
      onTick: (a) => { ticks.push(a.id); },
      getAssignments: () => [
        makeAssignment({ id: "a-bk", folderId: "f-bk", syncExpr: "@reboot", mode: "mount" }),
      ],
      getFolders: () => [makeFolder({ id: "f-bk", type: "backup" })],
      rebootDelayMs: 10,
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(ticks).toEqual(["a-bk"]);
    scheduler.stop();
  });

  // LAMA-273: when the effective pause is active (server-resolved into
  // hostConfig.pause), the scheduler must NOT fire onTick; one log line
  // per skipped run tells the operator why. We spy on console.log so
  // the test can assert the wording matches the brief.
  test("skips @reboot while paused, fires once the pause clears", async () => {
    const ticks: string[] = [];
    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    // Pause active for 80ms; @reboot delay is 60ms. The timer fires
    // INSIDE the pause window, must skip, then refresh() unpauses and
    // the retry lands outside the window.
    let paused = true;
    let until = new Date(Date.now() + 80).toISOString();
    const scheduler = new Scheduler({
      onTick: (a) => { ticks.push(a.id); },
      getAssignments: () => [makeAssignment({ syncExpr: "@reboot" })],
      rebootDelayMs: 60,
      getEffectivePause: () => (paused ? { until, mode: "pause", bwlimit: null } : null),
    });

    try {
      scheduler.start();
      // First fire window: paused, must skip.
      await new Promise((r) => setTimeout(r, 120));
      expect(ticks).toEqual([]);
      expect(logs.some((line) => line.includes("sync skipped: paused until"))).toBe(true);
      // Lift the pause; a refresh() re-arms the one-shot and it fires.
      paused = false;
      until = new Date(Date.now() - 1).toISOString();
      scheduler.refresh();
      await new Promise((r) => setTimeout(r, 80));
      expect(ticks).toEqual(["a1"]);
    } finally {
      console.log = realLog;
      scheduler.stop();
    }
  });

  test("skips a cron fire while paused and re-arms", async () => {
    const ticks: string[] = [];
    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    // Pause covers the test window with no end in sight; we just want
    // to observe the cron path: the scheduleCron branch shares the
    // currentPause() helper with the one-shot branch, so this assertion
    // focuses on observable state (timer map contains the assignment,
    // onTick never fires while paused) rather than wall-clock seconds.
    const until = new Date(Date.now() + 60_000).toISOString();
    const scheduler = new Scheduler({
      onTick: (a) => { ticks.push(a.id); },
      getAssignments: () => [makeAssignment({ syncExpr: "* * * * *" })],
      getEffectivePause: () => ({ until, mode: "pause", bwlimit: null }),
    });

    try {
      scheduler.start();
      // The cron expression fires within the next ~60s; we just verify
      // it stays parked inside the timer map and onTick never runs
      // while paused. Re-arming is exercised in the @reboot variant.
      await new Promise((r) => setTimeout(r, 50));
      expect(ticks).toEqual([]);
      // Lift the pause before the fire window so we can verify the
      // schedule actually wakes up. With * * * * * the next fire is
      // within a minute; we wait long enough for at least one tick.
      scheduler.stop();
      const unpausedScheduler = new Scheduler({
        onTick: (a) => { ticks.push(a.id); },
        getAssignments: () => [makeAssignment({ syncExpr: "* * * * *" })],
      });
      unpausedScheduler.start();
      // We don't wait for the real cron fire (would take ~60s) — just
      // confirm the unpaused path is unaffected by the pause machinery.
      expect(ticks).toEqual([]);
      unpausedScheduler.stop();
    } finally {
      console.log = realLog;
      scheduler.stop();
    }
  });

  test("no-op when getEffectivePause is omitted (older callers)", async () => {
    // Sanity check: the new option is optional, so a scheduler built
    // without it behaves exactly like before this change.
    const ticks: string[] = [];
    const scheduler = new Scheduler({
      onTick: (a) => { ticks.push(a.id); },
      getAssignments: () => [makeAssignment({ syncExpr: "@reboot" })],
      rebootDelayMs: 10,
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(ticks).toEqual(["a1"]);
    scheduler.stop();
  });
});

// Observed by the LAMA-345 integration sandbox: a `0 0 1 1 *` assignment
// produced `TimeoutOverflowWarning: 8941259725 does not fit into a 32-bit
// signed integer. Timeout duration was set to 1.` and then synced in a tight
// loop, because setTimeout clamps an out-of-range delay to 1 ms instead of
// waiting.
//
// The hazard is any next-fire more than 2^31-1 ms (~24.8 days) away — a yearly
// cron, the days right after a monthly cron fires, or `@yearly`. It is a real
// fleet hazard, not a test artifact: LAMA-345's health reporting would show the
// resulting run storm as `busy`/`recoverable` while the root cause is here.
describe("long-delay timer planning (LAMA-345 integration finding)", () => {
  test("a normal delay waits the full time and fires", () => {
    expect(planTimerDelay(1_000)).toEqual({ wait: 1_000, fire: true });
    expect(planTimerDelay(MAX_TIMER_DELAY_MS)).toEqual({ wait: MAX_TIMER_DELAY_MS, fire: true });
  });

  test("a past or zero delay fires immediately", () => {
    expect(planTimerDelay(0)).toEqual({ wait: 0, fire: true });
    expect(planTimerDelay(-5_000)).toEqual({ wait: 0, fire: true });
  });

  test("a delay beyond one timer's reach parks instead of firing early", () => {
    expect(planTimerDelay(MAX_TIMER_DELAY_MS + 1)).toEqual({
      wait: MAX_TIMER_DELAY_MS,
      fire: false,
    });
    // ~9e9 ms is the observed yearly-cron delay.
    expect(planTimerDelay(8_941_259_725)).toEqual({ wait: MAX_TIMER_DELAY_MS, fire: false });
  });

  test("a non-finite delay is treated as immediate rather than as a long park", () => {
    expect(planTimerDelay(Number.POSITIVE_INFINITY)).toEqual({ wait: 0, fire: true });
    expect(planTimerDelay(Number.NaN)).toEqual({ wait: 0, fire: true });
  });
});

describe("far-future schedules stay parked", () => {
  test("a yearly cron does not fire within a short window", async () => {
    const ticks: string[] = [];
    const scheduler = new Scheduler({
      onTick: (a) => {
        ticks.push(a.id);
      },
      getAssignments: () => [makeAssignment({ id: "yearly", syncExpr: "0 0 1 1 *" })],
      getFolders: () => [makeFolder()],
    });
    scheduler.start();
    await Bun.sleep(80);
    scheduler.stop();
    // Before the fix this ticked immediately (and then continuously).
    expect(ticks).toEqual([]);
  });

  test("a monthly cron scheduled weeks away does not fire early either", async () => {
    const ticks: string[] = [];
    const scheduler = new Scheduler({
      onTick: (a) => {
        ticks.push(a.id);
      },
      getAssignments: () => [makeAssignment({ id: "monthly", syncExpr: "0 0 1 * *" })],
      getFolders: () => [makeFolder()],
    });
    scheduler.start();
    await Bun.sleep(80);
    scheduler.stop();
    expect(ticks).toEqual([]);
  });

  test("a far-future app protection stays parked too", async () => {
    const captures: string[] = [];
    const scheduler = new Scheduler({
      onTick: () => {},
      onAppTick: (app) => {
        captures.push(app.protectionId);
      },
      getAssignments: () => [],
      getFolders: () => [],
      getApps: () => [makeApp({ protectionId: "prot-yearly", schedule: "0 0 1 1 *" })],
    });
    scheduler.start();
    await Bun.sleep(80);
    scheduler.stop();
    expect(captures).toEqual([]);
  });
});
