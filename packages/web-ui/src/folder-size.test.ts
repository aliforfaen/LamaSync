// LAMA-328: the FolderSize -> Size column contract. These assertions are the
// guard rail for "never present stale bytes as current": every freshness
// combination the server can emit has an explicit expected display.

import { describe, expect, it } from "bun:test";
import type { FolderSize } from "@lamasync/core";
import { sizeSuffix, sizeTitle, toSizeCell } from "./folder-size.ts";

const NOW = Date.now();

function size(overrides: Partial<FolderSize> = {}): FolderSize {
  return {
    folderId: "folder-1",
    bytes: 1024,
    objectCount: 5,
    error: null,
    measuredAt: NOW - 60_000,
    stale: false,
    refreshing: false,
    ...overrides,
  };
}

describe("toSizeCell", () => {
  it("renders a known value with no suffix", () => {
    const cell = toSizeCell(size());
    expect(cell.text).toBe("1.0 KiB");
    expect(sizeSuffix(cell)).toBeNull();
  });

  it("shows a stale last-known value as stale, never as current", () => {
    const cell = toSizeCell(size({ stale: true, refreshing: true }));
    expect(cell.text).toBe("1.0 KiB");
    expect(sizeSuffix(cell)).toBe("stale");
  });

  it("shows a refresh in flight on a value that is not stale yet", () => {
    const cell = toSizeCell(size({ stale: false, refreshing: true }));
    expect(cell.text).toBe("1.0 KiB");
    expect(sizeSuffix(cell)).toBe("refreshing");
  });

  it("says a never-measured folder is measuring while a refresh runs", () => {
    const cell = toSizeCell(
      size({ bytes: null, objectCount: null, measuredAt: null, stale: true, refreshing: true }),
    );
    expect(cell.text).toBe("measuring…");
    // "measuring…" already says it; a "· stale" suffix would be noise.
    expect(sizeSuffix(cell)).toBeNull();
  });

  it("says n/a when nothing can be measured and no refresh is pending", () => {
    const cell = toSizeCell(
      size({
        bytes: null,
        objectCount: null,
        measuredAt: null,
        error: "not measurable server-side",
        stale: false,
        refreshing: false,
      }),
    );
    expect(cell.text).toBe("n/a");
    expect(cell.error).toBe(true);
    expect(sizeSuffix(cell)).toBeNull();
  });

  it("renders an em dash for a folder the response omitted", () => {
    expect(toSizeCell(undefined)).toEqual({ text: "—" });
  });

  it("keeps an unreachable backend's last known bytes and flags the failure", () => {
    const cell = toSizeCell(
      size({ error: "S3 unavailable", measuredAt: NOW - 3 * 60 * 60 * 1000, stale: true }),
    );
    expect(cell.text).toBe("1.0 KiB");
    expect(cell.error).toBe(true);
    expect(sizeSuffix(cell)).toBe("stale");
    expect(sizeTitle(cell)).toContain("last refresh failed");
  });
});

describe("sizeTitle", () => {
  it("reports the measurement age for a current value", () => {
    expect(sizeTitle(toSizeCell(size()))).toContain("measured");
  });

  it("explains a stale value", () => {
    expect(sizeTitle(toSizeCell(size({ stale: true })))).toContain("refreshing in the background");
  });

  it("explains a growing folder that has never been measured", () => {
    const title = sizeTitle(
      toSizeCell(size({ bytes: null, measuredAt: null, error: "backend not found" })),
    );
    expect(title).toContain("size unavailable");
  });

  it("has no tooltip for a missing response", () => {
    expect(sizeTitle(toSizeCell(undefined))).toBeUndefined();
  });
});
