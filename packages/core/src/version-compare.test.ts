import { describe, expect, test } from "bun:test";
import { isNewer } from "./version-compare.ts";

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
    expect(isNewer("0.3.0-rc.1", "0.2.0")).toBe(false);
    expect(isNewer("  0.2.0  ", "  0.3.0  ")).toBe(true);
  });

  test("tolerates a leading v", () => {
    expect(isNewer("v0.2.0", "v0.3.0")).toBe(true);
    expect(isNewer("0.2.0", "v0.3.0")).toBe(true);
    expect(isNewer("v0.3.0", "0.2.0")).toBe(false);
    expect(isNewer("V0.2.0", "V0.3.0")).toBe(true);
  });

  test("missing segments return false", () => {
    expect(isNewer("0.2", "0.3.0")).toBe(false);
    expect(isNewer("0.2.0", "0.3")).toBe(false);
  });
});
