import { describe, expect, it } from "bun:test";
import type { PauseState } from "@lamasync/core";
import {
  BWLIMIT_RE,
  UNTIL_RESUME_MS,
  formatRemaining,
  formatUntilClock,
  pauseBannerText,
  pauseControlState,
  presetUntil,
  validateBwlimit,
} from "./pause.ts";

const NOW = new Date("2026-08-25T12:00:00Z");

describe("validateBwlimit", () => {
  it("accepts single-segment rclone sizes", () => {
    expect(validateBwlimit("1M")).toBe(true);
    expect(validateBwlimit("512K")).toBe(true);
    expect(validateBwlimit("2.5G")).toBe(true);
    expect(validateBwlimit("10T")).toBe(true);
    expect(validateBwlimit(" 1M ")).toBe(true);
    expect(validateBwlimit("")).toBe(true);
  });
  it("rejects schedules / junk", () => {
    expect(validateBwlimit("1M,2M")).toBe(false);
    expect(validateBwlimit("abc")).toBe(false);
    expect(validateBwlimit("1")).toBe(true); // bare number is valid
    expect(validateBwlimit("1M extra")).toBe(false);
  });
  it("BWLIMIT_RE matches the documented pattern", () => {
    expect(BWLIMIT_RE.test("1M")).toBe(true);
    expect(BWLIMIT_RE.test("512K")).toBe(true);
    expect(BWLIMIT_RE.test("2.5G")).toBe(true);
    expect(BWLIMIT_RE.test("10T")).toBe(true);
    expect(BWLIMIT_RE.test("1M,2M")).toBe(false);
    expect(BWLIMIT_RE.test("abc")).toBe(false);
  });
});

describe("presetUntil", () => {
  it("adds the duration to now and returns ISO", () => {
    expect(presetUntil(3600_000, NOW)).toBe(
      new Date(NOW.getTime() + 3600_000).toISOString(),
    );
  });
  it("Until-resume preset is one year out", () => {
    const until = presetUntil(UNTIL_RESUME_MS, NOW);
    expect(new Date(until).getTime()).toBe(NOW.getTime() + UNTIL_RESUME_MS);
  });
});

describe("formatRemaining", () => {
  it("formats minutes", () => {
    const until = new Date(NOW.getTime() + 39 * 60_000).toISOString();
    expect(formatRemaining(until, NOW)).toBe("39m");
  });
  it("formats whole hours", () => {
    const until = new Date(NOW.getTime() + 2 * 3600_000).toISOString();
    expect(formatRemaining(until, NOW)).toBe("2h");
  });
  it("formats hours + minutes with zero padding", () => {
    const until = new Date(NOW.getTime() + (2 * 3600_000 + 5 * 60_000)).toISOString();
    expect(formatRemaining(until, NOW)).toBe("2h 05m");
  });
  it("returns 0m for past / now instants", () => {
    const past = new Date(NOW.getTime() - 1000).toISOString();
    expect(formatRemaining(past, NOW)).toBe("0m");
    expect(formatRemaining(NOW.toISOString(), NOW)).toBe("0m");
  });
});

describe("pauseBannerText", () => {
  const base: PauseState = {
    scope: "global",
    until: new Date(NOW.getTime() + 39 * 60_000).toISOString(),
    mode: "pause",
    bwlimit: null,
  };
  it("pause mode shows the countdown", () => {
    expect(pauseBannerText(base, NOW)).toBe("Syncs paused · resumes in 39m");
  });
  it("slow mode shows the cap and end clock", () => {
    const slow: PauseState = {
      ...base,
      mode: "slow",
      until: new Date("2026-08-25T18:00:00Z").toISOString(),
      bwlimit: "1M",
    };
    // Local clock rendering depends on the runtime timezone, so assert it
    // contains the cap and the label prefix rather than a fixed clock string.
    const text = pauseBannerText(slow, NOW);
    expect(text.startsWith("Slow mode · 1M until")).toBe(true);
  });
  it("slow mode without a cap omits the separator", () => {
    const slow: PauseState = { ...base, mode: "slow", bwlimit: null };
    expect(pauseBannerText(slow, NOW).startsWith("Slow mode until")).toBe(true);
  });
});

describe("formatUntilClock", () => {
  it("returns a non-empty local time string", () => {
    const text = formatUntilClock("2026-08-25T18:00:00Z");
    expect(text.length).toBeGreaterThan(0);
  });
});

// LAMA-334 item 5: the dashboard's pause control must describe the LIVE state.
// The old control's label was always "Pause…", so a paused fleet and a running
// fleet looked identical, and the resume path was a separate banner.
describe("pauseControlState (LAMA-334)", () => {
  const window: PauseState = {
    scope: "global",
    mode: "pause",
    until: "2026-08-25T15:00:00Z",
    bwlimit: null,
  };
  const slow: PauseState = {
    scope: "global",
    mode: "slow",
    until: "2026-08-25T15:00:00Z",
    bwlimit: "1M",
  };

  it("offers pause while syncing runs", () => {
    const s = pauseControlState({ state: null, busy: false });
    expect(s.action).toBe("pause");
    expect(s.label).toBe("Pause");
    expect(s.active).toBe(false);
    expect(s.disabled).toBe(false);
    // The label and the accessible name agree, and neither is generic.
    expect(s.ariaLabel).toContain("Pause");
    expect(s.label).not.toContain("…");
  });

  it("offers resume, not pause, while a window is in effect", () => {
    const s = pauseControlState({ state: window, busy: false });
    expect(s.action).toBe("resume");
    expect(s.label).toBe("Resume");
    expect(s.active).toBe(true);
    // The title carries the state's own sentence (countdown), so hovering the
    // control explains what is in effect rather than repeating "Pause".
    expect(s.title).toContain("paused");
  });

  it("names slow mode as the active state and still offers full speed", () => {
    const s = pauseControlState({ state: slow, busy: false });
    expect(s.slow).toBe(true);
    expect(s.action).toBe("resume");
    expect(s.ariaLabel).toContain("slow mode");
    expect(s.title).toContain("Slow mode");
  });

  it("says which transition is running instead of looking inert", () => {
    expect(pauseControlState({ state: null, busy: true }).label).toBe("Pausing…");
    const resuming = pauseControlState({ state: window, busy: true });
    expect(resuming.label).toBe("Resuming…");
    expect(resuming.disabled).toBe(true);
  });

  it("explains why an unavailable control cannot act", () => {
    const s = pauseControlState({
      state: null,
      busy: false,
      unavailableReason: "Server unreachable",
    });
    expect(s.disabled).toBe(true);
    expect(s.disabledReason).toBe("Server unreachable");
    // The reason replaces the generic hint rather than being hidden behind it.
    expect(s.title).toBe("Server unreachable");
  });

  it("keeps the resume action available when a window is up but offline", () => {
    // Disabled, but still labelled for the state it is in — a Resume control
    // that reads "Pause" while paused is the bug this derivation exists for.
    const s = pauseControlState({
      state: slow,
      busy: false,
      unavailableReason: "Offline",
    });
    expect(s.action).toBe("resume");
    expect(s.disabled).toBe(true);
    expect(s.label).toBe("Resume");
  });
});
