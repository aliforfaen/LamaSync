import { describe, expect, it, test } from "bun:test";
import { detectHostClass, osLabel, storageUsedBytes } from "./device-info.ts";

describe("device-info", () => {
  it("osLabel is non-empty and names a known platform", () => {
    const label = osLabel();
    expect(label.length).toBeGreaterThan(0);
    expect(label).toMatch(/^(Linux|Darwin|Windows_NT|FreeBSD)/);
  });

  it("storageUsedBytes returns a positive number for the working dir", () => {
    const used = storageUsedBytes(".");
    expect(typeof used).toBe("number");
    expect(used).toBeGreaterThan(0);
  });

  it("storageUsedBytes expands a tilde dataDir instead of throwing ENOENT", () => {
    expect(() => storageUsedBytes("~/.local/share/lamasync")).not.toThrow();
    expect(storageUsedBytes("~")).toBeGreaterThan(0);
  });
});

describe("detectHostClass (LAMA-298)", () => {
  test("battery + desktop-ish -> laptop", () => {
    expect(
      detectHostClass({ hasBattery: true, isMobile: false, isServerLike: false }),
    ).toBe("laptop");
  });

  test("battery + mobile -> phone", () => {
    expect(
      detectHostClass({ hasBattery: true, isMobile: true, isServerLike: false }),
    ).toBe("phone");
  });

  test("no battery + mobile -> tablet", () => {
    expect(
      detectHostClass({ hasBattery: false, isMobile: true, isServerLike: false }),
    ).toBe("tablet");
  });

  test("no battery + server-like -> server", () => {
    expect(
      detectHostClass({ hasBattery: false, isMobile: false, isServerLike: true }),
    ).toBe("server");
  });

  test("no battery + not server-like -> desktop", () => {
    expect(
      detectHostClass({ hasBattery: false, isMobile: false, isServerLike: false }),
    ).toBe("desktop");
  });
});
