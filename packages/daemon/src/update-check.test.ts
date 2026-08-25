// Update-check throttle tests (LAMA-243). Exercise the persisted cooldown
// with an injected state path so the real ~/.config/lamasync/update-state.json
// is never touched.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UPDATE_CHECK_COOLDOWN_MS,
  markUpdateCheckAttempted,
  withinUpdateCooldown,
} from "./update-check.ts";

function tmpStatePath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "lamasync-update-check-"));
  return { dir, path: join(dir, "update-state.json") };
}

describe("withinUpdateCooldown", () => {
  test("false when no state file exists yet", () => {
    const { dir, path } = tmpStatePath();
    try {
      expect(withinUpdateCooldown(Date.now(), path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("false just past the cooldown, true inside it", () => {
    const { dir, path } = tmpStatePath();
    try {
      const t0 = 1_000_000_000_000;
      markUpdateCheckAttempted(t0, path);
      // Inside the window: skip.
      expect(withinUpdateCooldown(t0 + UPDATE_CHECK_COOLDOWN_MS - 1, path)).toBe(true);
      // Exactly at the boundary: the window has elapsed.
      expect(withinUpdateCooldown(t0 + UPDATE_CHECK_COOLDOWN_MS, path)).toBe(false);
      // Well past: check again.
      expect(withinUpdateCooldown(t0 + 10 * UPDATE_CHECK_COOLDOWN_MS, path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a crash-loop cadence stays throttled across restarts", () => {
    const { dir, path } = tmpStatePath();
    try {
      // Simulate a crash loop: the process restarts every 10s but the state
      // file survives. Only the first attempt may check; every subsequent
      // restart is within the 15-min cooldown.
      const first = 1_000_000_000_000;
      markUpdateCheckAttempted(first, path);
      for (let i = 1; i <= 30; i++) {
        const now = first + i * 10_000;
        expect(withinUpdateCooldown(now, path)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // LAMA-247 #18: persisted lastCheckAt vs the daemon's local clock can
  // drift (NTP, suspend, manual clock changes). The cooldown math is a pure
  // delta so drift must never cause a re-fire storm: a clock that jumped
  // backward still throttles (negative delta), a forward jump just expires
  // the window early.
  test("tolerates clock drift between the persisted lastCheckAt and now", () => {
    const { dir, path } = tmpStatePath();
    try {
      const t0 = 1_000_000_000_000;
      markUpdateCheckAttempted(t0, path);
      // Clock jumped an hour BACK: still < 15-min cooldown → throttled.
      expect(withinUpdateCooldown(t0 - 3_600_000, path)).toBe(true);
      // Clock jumped a day FORWARD: window long past → allow a check.
      expect(withinUpdateCooldown(t0 + 86_400_000, path)).toBe(false);
      // Fresh state with lastCheckAt in the future (filesystem mtime skew)
      // must also throttle.
      const future = 2_000_000_000_000;
      markUpdateCheckAttempted(future, path);
      expect(withinUpdateCooldown(1_000_000_000_000, path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
