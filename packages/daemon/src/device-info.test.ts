import { describe, expect, it } from "bun:test";
import { osLabel, storageUsedBytes } from "./device-info.ts";

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
});
