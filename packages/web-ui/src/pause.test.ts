import { describe, expect, it } from "bun:test";
import type { PauseState } from "@lamasync/core";
import {
  BWLIMIT_RE,
  UNTIL_RESUME_MS,
  formatRemaining,
  formatUntilClock,
  pauseBannerText,
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
