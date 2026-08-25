/**
 * Pure tests for the pause / slow-mode helpers (LAMA-273). Every helper here
 * accepts a `now` argument so the suite controls clock skew without mocking
 * the system clock.
 */
import { describe, expect, test } from "bun:test";
import type { PauseState } from "@lamasync/core";

import {
  computeUntilMs,
  formatBwlimit,
  formatEffectivePauseCaption,
  formatPauseDuration,
  formatPauseIndicator,
  formatPauseIndicatorAscii,
  isPauseActive,
  PAUSE_DURATION_PRESETS,
  parseUntilMs,
  resolveEffectivePause,
} from "./pause.ts";

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const DAY = 24 * HOUR;

function isoFromNow(deltaMs: number, now: number): string {
  return new Date(now + deltaMs).toISOString();
}

describe("computeUntilMs", () => {
  const now = 1_700_000_000_000;

  test("1h adds one hour", () => {
    expect(computeUntilMs("1h", now)).toBe(now + HOUR);
  });

  test("4h adds four hours", () => {
    expect(computeUntilMs("4h", now)).toBe(now + 4 * HOUR);
  });

  test("24h adds a day", () => {
    expect(computeUntilMs("24h", now)).toBe(now + DAY);
  });

  test("until-resume adds 30 days (long enough to be indefinite)", () => {
    expect(computeUntilMs("until-resume", now)).toBe(now + 30 * DAY);
  });
});

describe("PAUSE_DURATION_PRESETS", () => {
  test("declares exactly the four UX presets the dialog exposes", () => {
    expect(PAUSE_DURATION_PRESETS.map((p) => p.value)).toEqual([
      "1h",
      "4h",
      "24h",
      "until-resume",
    ]);
  });
});

describe("parseUntilMs + isPauseActive", () => {
  const now = 1_700_000_000_000;

  test("parses a valid ISO timestamp into epoch ms", () => {
    const parsed = parseUntilMs(isoFromNow(HOUR, now));
    expect(parsed).toBe(now + HOUR);
  });

  test("returns null for malformed input", () => {
    expect(parseUntilMs("not-a-date")).toBeNull();
    expect(parseUntilMs("")).toBeNull();
  });

  test("isPauseActive is true when the row is in the future", () => {
    const pause: PauseState = {
      scope: "global",
      until: isoFromNow(HOUR, now),
      mode: "pause",
    };
    expect(isPauseActive(pause, now)).toBe(true);
  });

  test("isPauseActive is false when the row is in the past", () => {
    const pause: PauseState = {
      scope: "global",
      until: isoFromNow(-HOUR, now),
      mode: "pause",
    };
    expect(isPauseActive(pause, now)).toBe(false);
  });

  test("isPauseActive is false for null / undefined / unparseable rows", () => {
    expect(isPauseActive(null, now)).toBe(false);
    const garbage: PauseState = {
      scope: "global",
      until: "not-a-date",
      mode: "pause",
    };
    expect(isPauseActive(garbage, now)).toBe(false);
  });
});

describe("formatPauseDuration", () => {
  const now = 1_700_000_000_000;

  test("under one minute shows the <1m sentinel", () => {
    expect(formatPauseDuration(isoFromNow(30 * 1000, now), now)).toBe("<1m");
  });

  test("minutes-only window rounds down to whole minutes", () => {
    expect(formatPauseDuration(isoFromNow(39 * MIN, now), now)).toBe("39m");
    expect(formatPauseDuration(isoFromNow(MIN, now), now)).toBe("1m");
  });

  test("hour window drops trailing zero minutes", () => {
    expect(formatPauseDuration(isoFromNow(2 * HOUR, now), now)).toBe("2h");
  });

  test("hour window with leftover minutes keeps both segments", () => {
    expect(formatPauseDuration(isoFromNow(1 * HOUR + 20 * MIN, now), now)).toBe(
      "1h 20m",
    );
  });

  test("multi-day renders as Nd", () => {
    expect(formatPauseDuration(isoFromNow(3 * DAY + 5 * HOUR, now), now)).toBe(
      "3d",
    );
  });

  test("expired pause shows the <expired> sentinel", () => {
    expect(formatPauseDuration(isoFromNow(-HOUR, now), now)).toBe("<expired>");
  });

  test("malformed until renders an em-dash so the indicator never lies", () => {
    expect(formatPauseDuration("not-a-date", now)).toBe("—");
  });
});

describe("formatBwlimit", () => {
  test("passes through non-empty strings (after trimming)", () => {
    expect(formatBwlimit("1M")).toBe("1M");
    expect(formatBwlimit("  512K  ")).toBe("512K");
  });

  test("collapses empty / whitespace / nullish to null", () => {
    expect(formatBwlimit(null)).toBeNull();
    expect(formatBwlimit(undefined)).toBeNull();
    expect(formatBwlimit("")).toBeNull();
    expect(formatBwlimit("   ")).toBeNull();
  });
});

describe("formatPauseIndicator + ascii variant", () => {
  const now = 1_700_000_000_000;

  test("pause mode renders ⏸ paused <duration>", () => {
    const pause: PauseState = {
      scope: "global",
      until: isoFromNow(39 * MIN, now),
      mode: "pause",
    };
    expect(formatPauseIndicator(pause, now)).toBe("⏸ paused 39m");
  });

  test("slow mode with bwlimit renders 🐢 slow <bw> · <duration>", () => {
    const pause: PauseState = {
      scope: "global",
      until: isoFromNow(2 * HOUR, now),
      mode: "slow",
      bwlimit: "1M",
    };
    expect(formatPauseIndicator(pause, now)).toBe("🐢 slow 1M · 2h");
  });

  test("slow mode without bwlimit omits the bw segment", () => {
    const pause: PauseState = {
      scope: "global",
      until: isoFromNow(2 * HOUR, now),
      mode: "slow",
      bwlimit: null,
    };
    expect(formatPauseIndicator(pause, now)).toBe("🐢 slow 2h");
  });

  test("ascii variant uses bracket-style glyphs", () => {
    const pause: PauseState = {
      scope: "global",
      until: isoFromNow(39 * MIN, now),
      mode: "pause",
    };
    expect(formatPauseIndicatorAscii(pause, now)).toBe("[paused 39m]");
    const slow: PauseState = {
      scope: "host",
      hostId: "cachy",
      until: isoFromNow(2 * HOUR, now),
      mode: "slow",
      bwlimit: "5M",
    };
    expect(formatPauseIndicatorAscii(slow, now)).toBe("[slow 5M · 2h]");
  });
});

describe("resolveEffectivePause", () => {
  const now = 1_700_000_000_000;

  test("returns null when neither global nor host is paused", () => {
    expect(
      resolveEffectivePause({ global: null, hosts: [] }, "cachy", now),
    ).toBeNull();
  });

  test("falls back to global when host has no row", () => {
    const global: PauseState = {
      scope: "global",
      until: isoFromNow(HOUR, now),
      mode: "pause",
    };
    expect(resolveEffectivePause({ global, hosts: [] }, "cachy", now)).toBe(
      global,
    );
  });

  test("prefers the matching host row over global", () => {
    const global: PauseState = {
      scope: "global",
      until: isoFromNow(HOUR, now),
      mode: "pause",
    };
    const host: PauseState = {
      scope: "host",
      hostId: "cachy",
      until: isoFromNow(2 * HOUR, now),
      mode: "slow",
      bwlimit: "1M",
    };
    expect(
      resolveEffectivePause({ global, hosts: [host] }, "cachy", now),
    ).toBe(host);
  });

  test("ignores expired rows and falls through to the next active row", () => {
    const expired: PauseState = {
      scope: "host",
      hostId: "cachy",
      until: isoFromNow(-HOUR, now),
      mode: "pause",
    };
    const global: PauseState = {
      scope: "global",
      until: isoFromNow(HOUR, now),
      mode: "pause",
    };
    expect(
      resolveEffectivePause({ global, hosts: [expired] }, "cachy", now),
    ).toBe(global);
  });

  test("ignores a host row belonging to a different device", () => {
    const otherHost: PauseState = {
      scope: "host",
      hostId: "norheim",
      until: isoFromNow(HOUR, now),
      mode: "pause",
    };
    const global: PauseState = {
      scope: "global",
      until: isoFromNow(HOUR, now),
      mode: "slow",
      bwlimit: "5M",
    };
    expect(
      resolveEffectivePause({ global, hosts: [otherHost] }, "cachy", now),
    ).toBe(global);
  });
});

describe("formatEffectivePauseCaption", () => {
  const now = 1_700_000_000_000;

  test("returns null when no pause applies (no decoration overhead)", () => {
    expect(
      formatEffectivePauseCaption({ global: null, hosts: [] }, "cachy", now),
    ).toBeNull();
  });

  test("returns the emoji-formatted indicator by default", () => {
    const global: PauseState = {
      scope: "global",
      until: isoFromNow(39 * MIN, now),
      mode: "pause",
    };
    expect(
      formatEffectivePauseCaption({ global, hosts: [] }, "cachy", now),
    ).toBe("⏸ paused 39m");
  });

  test("returns the ascii form when requested", () => {
    const global: PauseState = {
      scope: "global",
      until: isoFromNow(2 * HOUR, now),
      mode: "slow",
      bwlimit: "1M",
    };
    expect(
      formatEffectivePauseCaption(
        { global, hosts: [] },
        "cachy",
        now,
        { ascii: true },
      ),
    ).toBe("[slow 1M · 2h]");
  });

  test("respects the host-row-wins rule for the indicator", () => {
    const global: PauseState = {
      scope: "global",
      until: isoFromNow(HOUR, now),
      mode: "pause",
    };
    const host: PauseState = {
      scope: "host",
      hostId: "cachy",
      until: isoFromNow(2 * HOUR, now),
      mode: "slow",
      bwlimit: "5M",
    };
    expect(
      formatEffectivePauseCaption({ global, hosts: [host] }, "cachy", now),
    ).toBe("🐢 slow 5M · 2h");
  });
});