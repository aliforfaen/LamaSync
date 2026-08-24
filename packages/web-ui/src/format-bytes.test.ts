import { describe, expect, it } from "bun:test";
import { formatBytes } from "./format-bytes.ts";

describe("formatBytes", () => {
  it("returns a dash for null/undefined/NaN", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });

  it("renders sub-KiB as bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("renders KiB/MiB with one decimal, large values with none", () => {
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
    expect(formatBytes(100 * 1024)).toBe("100 KiB");
  });

  it("handles GiB and beyond", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GiB");
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe("1.0 TiB");
  });
});
