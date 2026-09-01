// LAMA-302: debounce/single-flight controller tests. Pure — uses a fake watch
// factory and a fake clock, never touches the filesystem or a real timer.

import { describe, expect, test } from "bun:test";
import type { FolderAssignment } from "@lamasync/core";
import {
  WatchController,
  type FolderWatchFactory,
  type FolderWatchHandle,
  type WatchTimers,
} from "./folder-watch.ts";

const QUIET = 10; // seconds, for fast tests

/** Yield to the microtask queue enough times to settle async controller code. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function assignment(overrides: Partial<FolderAssignment> = {}): FolderAssignment {
  return {
    id: "a-1",
    folderId: "f-1",
    hostId: "h-1",
    role: "both",
    localPath: "/tmp/w",
    enabled: true,
    watchEnabled: true,
    watchQuietSec: QUIET,
    ...overrides,
  };
}

class FakeClock implements WatchTimers {
  now = 0;
  private timers: Array<{ id: number; fireAt: number; fn: () => void }> = [];
  private nextId = 1;
  // Ordered list of (time) -> fired-count snapshots for assertions.
  fired: string[] = [];
  setTimeout(fn: () => void, ms: number): unknown {
    const t = { id: this.nextId++, fireAt: this.now + ms, fn };
    this.timers.push(t);
    return t;
  }
  clearTimeout(t: unknown): void {
    this.timers = this.timers.filter((x) => x !== t);
  }
  /** Advance the clock, firing due timers in chronological order. */
  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const due = this.timers
        .filter((t) => t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.now = due.fireAt;
      this.fired.push(String(due.fireAt));
      due.fn();
    }
    this.now = target;
  }
  pendingTimers(): number {
    return this.timers.length;
  }
}

class FakeFactory implements FolderWatchFactory {
  handles: Array<{
    closed: boolean;
    onDirty: () => void;
    onError: (e: Error) => void;
  }> = [];
  failing = false;
  start(options: {
    assignment: FolderAssignment;
    onDirty(): void;
    onError(error: Error): void;
  }): FolderWatchHandle {
    if (this.failing) {
      throw new Error("path missing");
    }
    const h = {
      closed: false,
      onDirty: options.onDirty,
      onError: options.onError,
      close() {
        h.closed = true;
      },
    };
    this.handles.push(h);
    return h;
  }
}

class Deferred {
  resolve!: () => void;
  promise = new Promise<void>((r) => {
    this.resolve = r;
  });
}

function makeController(opts: {
  factory: FakeFactory;
  clock: FakeClock;
  run: () => Promise<void>;
  log?: (m: string) => void;
}) {
  const controller = new WatchController({
    assignment: assignment(),
    factory: opts.factory,
    run: opts.run,
    timers: opts.clock,
    log: opts.log,
  });
  controller.start();
  return controller;
}

describe("WatchController", () => {
  test("a burst of events produces exactly one run after the quiet period", () => {
    const factory = new FakeFactory();
    const clock = new FakeClock();
    let runs = 0;
    const ctl = makeController({ factory, clock, run: async () => { runs += 1; } });

    // A burst of writes, then silence.
    for (let i = 0; i < 20; i += 1) factory.handles[0].onDirty();
    expect(clock.pendingTimers()).toBe(1);
    clock.advance(QUIET * 1000);
    expect(runs).toBe(1);
    expect(clock.pendingTimers()).toBe(0);
    ctl.stop();
  });

  test("each new event resets the quiet timer (debounce)", () => {
    const factory = new FakeFactory();
    const clock = new FakeClock();
    let runs = 0;
    const ctl = makeController({ factory, clock, run: async () => { runs += 1; } });

    factory.handles[0].onDirty(); // t=0
    clock.advance((QUIET - 2) * 1000); // t=8s
    factory.handles[0].onDirty(); // reset
    clock.advance((QUIET - 2) * 1000); // t=16s → first timer was at t=10 but reset, so not fired yet
    expect(runs).toBe(0);
    clock.advance(3 * 1000); // t=19s; second event at t=8 fires at t=18
    expect(runs).toBe(1);
    ctl.stop();
  });

  test("events during a run coalesce into at most one follow-up run", async () => {
    const factory = new FakeFactory();
    const clock = new FakeClock();
    const gate = new Deferred();
    let runs = 0;
    const ctl = makeController({
      factory,
      clock,
      run: async () => { runs += 1; await gate.promise; },
    });

    factory.handles[0].onDirty();
    clock.advance(QUIET * 1000); // run 1 starts, awaiting gate
    expect(runs).toBe(1);

    // Multiple writes while the first run is in flight.
    factory.handles[0].onDirty();
    factory.handles[0].onDirty();
    factory.handles[0].onDirty();

    gate.resolve();
    await flush(); // let the controller's post-run await resolve
    // At most one follow-up scheduled.
    expect(clock.pendingTimers()).toBe(1);

    clock.advance(QUIET * 1000); // follow-up run 2 fires
    // Follow-up was a no-op (nothing dirtied during it) → no chain continues.
    await flush();
    expect(runs).toBe(2);
    expect(clock.pendingTimers()).toBe(0);
    ctl.stop();
  });

  test("no follow-up when the run makes no changes", async () => {
    const factory = new FakeFactory();
    const clock = new FakeClock();
    let runs = 0;
    const ctl = makeController({ factory, clock, run: async () => { runs += 1; } });

    factory.handles[0].onDirty();
    clock.advance(QUIET * 1000);
    expect(runs).toBe(1);
    await Promise.resolve();
    expect(clock.pendingTimers()).toBe(0);
    ctl.stop();
  });

  test("stop closes the watcher handle and cancels a pending run", async () => {
    const factory = new FakeFactory();
    const clock = new FakeClock();
    let runs = 0;
    const ctl = makeController({ factory, clock, run: async () => { runs += 1; } });

    factory.handles[0].onDirty();
    expect(clock.pendingTimers()).toBe(1);
    ctl.stop();
    expect(factory.handles[0].closed).toBe(true);
    clock.advance(QUIET * 1000);
    expect(runs).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  test("an inotify overflow / error marks dirty and schedules a run", () => {
    const factory = new FakeFactory();
    const clock = new FakeClock();
    let runs = 0;
    const ctl = makeController({ factory, clock, run: async () => { runs += 1; } });

    factory.handles[0].onError(new Error("inotify overflow"));
    expect(runs).toBe(0);
    clock.advance(QUIET * 1000);
    expect(runs).toBe(1);
    ctl.stop();
  });

  test("a failing factory start (vanished path) is logged, not fatal", () => {
    const factory = new FakeFactory();
    const clock = new FakeClock();
    const logs: string[] = [];
    let runs = 0;
    factory.failing = true;
    const ctl = makeController({
      factory,
      clock,
      run: async () => { runs += 1; },
      log: (m) => logs.push(m),
    });
    // No handle was created and no run was scheduled; the coordinator will
    // retry on the next config refresh.
    expect(runs).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
    expect(logs.some((m) => m.includes("failed to start watcher"))).toBe(true);
    clock.advance(QUIET * 1000);
    expect(runs).toBe(0);
    ctl.stop();
  });
});
