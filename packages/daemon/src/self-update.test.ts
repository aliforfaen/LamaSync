import { describe, expect, test } from "bun:test";
import { fetchLatestRelease, isNewer } from "./self-update.ts";

describe("isNewer", () => {
  test("strictly newer returns true", () => {
    expect(isNewer("0.2.0", "0.3.0")).toBe(true);
    expect(isNewer("0.2.0", "0.2.1")).toBe(true);
    expect(isNewer("0.2.0", "0.2.10")).toBe(true);
    expect(isNewer("1.0.0", "2.0.0")).toBe(true);
    expect(isNewer("0.0.0", "0.0.1")).toBe(true);
  });

  test("equal returns false", () => {
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
  });

  test("older returns false", () => {
    expect(isNewer("0.3.0", "0.2.0")).toBe(false);
    expect(isNewer("1.0.0", "0.9.9")).toBe(false);
  });

  test("invalid versions return false", () => {
    expect(isNewer("garbage", "0.3.0")).toBe(false);
    expect(isNewer("0.2.0", "garbage")).toBe(false);
    expect(isNewer("", "")).toBe(false);
  });

  test("ignores pre-release suffix on numeric prefix", () => {
    expect(isNewer("0.2.0", "0.3.0-rc.1")).toBe(true);
    expect(isNewer("  0.2.0  ", "  0.3.0  ")).toBe(true);
  });
});

describe("fetchLatestRelease", () => {
  test("returns object or null (network may be unavailable)", async () => {
    const result = await fetchLatestRelease();
    expect(result === null || typeof result === "object").toBe(true);
  }, { timeout: 10000 });
});
