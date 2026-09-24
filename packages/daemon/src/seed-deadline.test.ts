// LAMA-346: the progress-aware seed-stage deadline, exercised against real
// child processes.
//
// These tests prove the actual mechanism, not just the pure decision:
//
//   * an ordinary run still dies at its fixed wall-clock timeout;
//   * a seed stage that keeps reporting measurable progress survives well past
//     that same nominal timeout (the dev-vm case: 91,660 files, exit 143 at
//     600 s, before any completed transfer/check);
//   * a seed stage that stops progressing is killed promptly;
//   * a chatty-but-stuck stage is still bounded by the absolute hard cap;
//   * the SCOPE rule: a sync against a ready baseline keeps the fixed timeout,
//     while a first run with no baseline is supervised progress-aware.

import { afterEach, describe, expect, test } from "bun:test";
import { SEED_STAGE_HARD_CAP_MS, SEED_STALL_TIMEOUT_FALLBACK_SEC } from "@lamasync/core";
import { seedStageWatchdog, superviseProcess, syncRunIsProgressAware } from "./executor.ts";

const running: Array<{ kill: () => void }> = [];

afterEach(() => {
  for (const proc of running.splice(0)) {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }
});

function spawn(script: string): Bun.Subprocess<"ignore", "ignore", "ignore"> {
  const proc = Bun.spawn(["sh", "-c", script], { stdout: "ignore", stderr: "ignore" });
  running.push(proc);
  return proc;
}

describe("superviseProcess", () => {
  test("without a watchdog, the fixed wall-clock timeout still kills the run", async () => {
    const proc = spawn("sleep 10");
    const supervisor = superviseProcess(proc, { timeoutSec: 0.2 });
    const exitCode = await proc.exited;
    supervisor.stop();
    expect(supervisor.timedOut()).toBe(true);
    expect(supervisor.abortReason()).toContain("timed out after");
    expect(exitCode).not.toBe(0);
  });

  test("a progressing seed stage survives well past the nominal timeout", async () => {
    // ~40 progress ticks over ~400 ms while the nominal timeout is 50 ms.
    const proc = Bun.spawn(
      ["sh", "-c", "i=0; while [ $i -lt 20 ]; do echo tick; sleep 0.02; i=$((i+1)); done; exit 0"],
      { stdout: "pipe", stderr: "ignore" },
    );
    running.push(proc);
    const supervisor = superviseProcess(proc, {
      timeoutSec: 0.05,
      watchdog: { stallMs: 400, hardCapMs: 10_000, tickMs: 25 },
    });
    // Feed stdout lines as measurable progress, exactly as the executor's
    // JSON-line handler does.
    const decoder = new TextDecoder();
    void (async () => {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        if (decoder.decode(chunk).trim().length > 0) supervisor.progress();
      }
    })();
    const exitCode = await proc.exited;
    supervisor.stop();
    expect(supervisor.timedOut()).toBe(false);
    expect(exitCode).toBe(0);
  });

  test("a stalled seed stage is killed at the stall budget", async () => {
    const proc = spawn("sleep 10");
    const supervisor = superviseProcess(proc, {
      timeoutSec: 600,
      watchdog: { stallMs: 150, hardCapMs: 10_000, tickMs: 25 },
    });
    await proc.exited;
    supervisor.stop();
    expect(supervisor.timedOut()).toBe(true);
    expect(supervisor.abortReason()).toContain("seed-stage stalled");
  });

  test("progress resets the stall budget", async () => {
    // Prints for ~300 ms, then goes silent. stallMs is 200 ms, so the run
    // must survive the early silence (because progress arrived) and then be
    // killed once the quiet period exceeds the budget.
    const proc = spawn("i=0; while [ $i -lt 10 ]; do echo tick; sleep 0.02; i=$((i+1)); done; sleep 10");
    const supervisor = superviseProcess(proc, {
      timeoutSec: 600,
      watchdog: { stallMs: 200, hardCapMs: 10_000, tickMs: 25 },
    });
    await proc.exited;
    supervisor.stop();
    expect(supervisor.timedOut()).toBe(true);
    expect(supervisor.abortReason()).toContain("seed-stage stalled");
  });

  test("a chatty stage is still bounded by the absolute hard cap", async () => {
    const proc = spawn("while true; do echo tick; sleep 0.01; done");
    const supervisor = superviseProcess(proc, {
      timeoutSec: 600,
      watchdog: { stallMs: 10_000, hardCapMs: 200, tickMs: 25 },
    });
    // Feed progress so only the hard cap can end it.
    const ticker = setInterval(() => supervisor.progress(), 10);
    await proc.exited;
    clearInterval(ticker);
    supervisor.stop();
    expect(supervisor.timedOut()).toBe(true);
    expect(supervisor.abortReason()).toContain("hard_cap");
  });

  test("stop() clears the deadline so a finished run is never killed later", async () => {
    const proc = spawn("sleep 0.05");
    const supervisor = superviseProcess(proc, { timeoutSec: 0.3 });
    await proc.exited;
    supervisor.stop();
    await Bun.sleep(400);
    expect(supervisor.timedOut()).toBe(false);
  });
});

describe("syncRunIsProgressAware — the documented scope, not a slogan", () => {
  test("a sync with a READY baseline keeps the fixed wall-clock timeout", () => {
    expect(syncRunIsProgressAware({ baselineReady: true })).toBe(false);
    // Even a planned resync on an established baseline stays fixed.
    expect(syncRunIsProgressAware({ baselineReady: true, bisyncMode: "resync" })).toBe(false);
    expect(syncRunIsProgressAware({ baselineReady: true, bisyncMode: null })).toBe(false);
  });

  test("a FIRST run with no usable baseline gets the progress-aware deadline", () => {
    // This is the dev-vm shape: no baseline, killed at 600 s with exit 143
    // before any completed transfer/check.
    expect(syncRunIsProgressAware({ baselineReady: false })).toBe(true);
  });

  test("an explicit initialize/seed intervention and a flagged seed stage are progress-aware", () => {
    expect(syncRunIsProgressAware({ baselineReady: true, bisyncMode: "initialize" })).toBe(true);
    expect(syncRunIsProgressAware({ baselineReady: true, bisyncMode: "seed" })).toBe(true);
    expect(syncRunIsProgressAware({ baselineReady: true, seedStage: true })).toBe(true);
    expect(syncRunIsProgressAware({ baselineReady: false, seedStage: false })).toBe(true);
  });
});

describe("seedStageWatchdog", () => {
  test("reinterprets the 600 s assignment timeout as the stall budget", () => {
    const watchdog = seedStageWatchdog(undefined);
    expect(watchdog.stallMs).toBe(SEED_STALL_TIMEOUT_FALLBACK_SEC * 1000);
    expect(watchdog.hardCapMs).toBe(SEED_STAGE_HARD_CAP_MS);
  });

  test("an assignment timeout moves the stall budget, not the hard cap", () => {
    const watchdog = seedStageWatchdog(1800);
    expect(watchdog.stallMs).toBe(1_800_000);
    expect(watchdog.hardCapMs).toBe(SEED_STAGE_HARD_CAP_MS);
  });
});
