import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DotfileManifest, Folder, FolderAssignment } from "@lamasync/core";
import { Scheduler } from "./scheduler.ts";

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

function makeManifest(overrides: Partial<DotfileManifest> = {}): DotfileManifest {
  return {
    id: "m1",
    hostId: "_global",
    appName: "myapp",
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

  test("dotfile assignment reads schedule from manifest", async () => {
    const ticks: string[] = [];
    const scheduler = new Scheduler({
      onTick: (a) => { ticks.push(a.id); },
      getAssignments: () => [
        makeAssignment({ id: "a-dot", folderId: "f-dot", syncExpr: null }),
      ],
      getFolders: () => [makeFolder({ id: "f-dot", name: "myapp", type: "dotfile" })],
      getManifests: () => [makeManifest({ appName: "myapp", schedule: "@reboot" })],
      rebootDelayMs: 10,
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(ticks).toEqual(["a-dot"]);
    scheduler.stop();
  });

  test("dotfile manifest cron schedule wins over empty assignment syncExpr", () => {
    const scheduler = new Scheduler({
      onTick: () => undefined,
      getAssignments: () => [
        makeAssignment({ id: "a-dot", folderId: "f-dot", syncExpr: null }),
      ],
      getFolders: () => [makeFolder({ id: "f-dot", name: "myapp", type: "dotfile" })],
      getManifests: () => [makeManifest({ appName: "myapp", schedule: "0 0 * * *" })],
    });

    scheduler.start();
    const next = scheduler.nextRunFor(
      makeAssignment({ id: "a-dot", folderId: "f-dot", syncExpr: null }),
    );
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(Date.now());
    scheduler.stop();
  });

  test("non-dotfile assignment ignores manifest schedule", async () => {
    const ticks: string[] = [];
    const scheduler = new Scheduler({
      onTick: (a) => { ticks.push(a.id); },
      getAssignments: () => [makeAssignment({ syncExpr: null })],
      getFolders: () => [makeFolder({ type: "sync" })],
      getManifests: () => [makeManifest({ schedule: "@reboot" })],
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
});
