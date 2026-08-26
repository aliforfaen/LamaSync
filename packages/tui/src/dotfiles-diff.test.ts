/**
 * Unit tests for the pure half of `dotfiles-diff.ts`.
 *
 * The IO layer (`listTarballEntries`, `readTarballContents`,
 * `computeRestoreDiff`, `readDiskEntries`) shells out to `tar` and walks
 * the live filesystem; the tests below only exercise the functions that
 * take pre-built fixtures and return deterministic output. The IO layer
 * is exercised in CI by the dotfiles view's own end-to-end flows; an
 * extra `tar`-spawning test would just be a thin wrapper around `tar`.
 *
 * Fixtures use small synthetic sha256 values (the diff ignores any real
 * cryptographic property — only equality matters).
 */

import { describe, expect, test } from "bun:test";

import {
  capDiff,
  diffTarAgainstDisk,
  formatDiffPreview,
  parseTarListing,
  type DiskEntry,
  type TarEntry,
} from "./dotfiles-diff.ts";

describe("diffTarAgainstDisk (pure seam)", () => {
  const disk = new Map<string, DiskEntry>([
    ["keep/same.txt", { path: "keep/same.txt", size: 5, sha256: "aaa" }],
    [
      "keep/changed.txt",
      { path: "keep/changed.txt", size: 5, sha256: "OLD" },
    ],
    [
      "keep/size-same-content-diff.txt",
      { path: "keep/size-same-content-diff.txt", size: 5, sha256: "OLD" },
    ],
    [
      "keep/size-same-no-hash.txt",
      { path: "keep/size-same-no-hash.txt", size: 5, sha256: "" },
    ],
  ]);

  test("classifies NEW / CHANGED / SAME", () => {
    const tar: TarEntry[] = [
      // File absent on disk → NEW.
      { path: "new/only-in-tar.txt", size: 10 },
      // Size + sha256 match → SAME.
      {
        path: "keep/same.txt",
        size: 5,
        sha256: "aaa",
      },
      // Size differs → CHANGED.
      {
        path: "keep/changed.txt",
        size: 7,
        sha256: "NEW",
      },
      // Same size, different sha256 → CHANGED (size X→X — content).
      {
        path: "keep/size-same-content-diff.txt",
        size: 5,
        sha256: "NEW",
      },
    ];

    const out = diffTarAgainstDisk(tar, disk);
    expect(out).toEqual([
      { kind: "NEW", path: "new/only-in-tar.txt", toSize: 10 },
      { kind: "SAME", path: "keep/same.txt", size: 5 },
      { kind: "CHANGED", path: "keep/changed.txt", fromSize: 5, toSize: 7 },
      {
        kind: "CHANGED",
        path: "keep/size-same-content-diff.txt",
        fromSize: 5,
        toSize: 5,
      },
    ]);
  });

  test("size match + missing tar sha256 → optimistic SAME", () => {
    // The IO layer can avoid hashing when sizes match by leaving
    // entry.sha256 undefined; we must not falsely report CHANGED in that
    // case. The caller can request a hash pass to upgrade to a real
    // comparison.
    const tar: TarEntry[] = [
      { path: "keep/size-same-no-hash.txt", size: 5, sha256: "" },
    ];
    const out = diffTarAgainstDisk(tar, disk);
    expect(out).toEqual([
      { kind: "SAME", path: "keep/size-same-no-hash.txt", size: 5 },
    ]);
  });

  test("empty tar entry list returns an empty diff", () => {
    expect(diffTarAgainstDisk([], disk)).toEqual([]);
  });

  test("disk map empty → every tar entry is NEW", () => {
    const tar: TarEntry[] = [
      { path: "a.txt", size: 1 },
      { path: "b.txt", size: 2, sha256: "x" },
    ];
    const out = diffTarAgainstDisk(tar, new Map());
    expect(out).toEqual([
      { kind: "NEW", path: "a.txt", toSize: 1 },
      { kind: "NEW", path: "b.txt", toSize: 2 },
    ]);
  });
});

describe("capDiff", () => {
  test("passes through when under the cap", () => {
    const lines = [
      { kind: "NEW" as const, path: "a", toSize: 1 },
      { kind: "SAME" as const, path: "b", size: 2 },
    ];
    const r = capDiff(lines, 50);
    expect(r.lines).toHaveLength(2);
    expect(r.truncated).toBe(0);
    expect(r.counts).toEqual({ NEW: 1, CHANGED: 0, SAME: 1, total: 2 });
  });

  test("trims and reports truncation count when over the cap", () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({
      kind: "NEW" as const,
      path: `f${i}`,
      toSize: i,
    }));
    const r = capDiff(lines, 50);
    expect(r.lines).toHaveLength(50);
    expect(r.truncated).toBe(10);
    expect(r.counts.total).toBe(60);
    expect(r.counts.NEW).toBe(60);
  });

  test("uses the documented default cap of 50", () => {
    // 51 entries → 50 shown, 1 trimmed, default cap = 50.
    const lines = Array.from({ length: 51 }, (_, i) => ({
      kind: "SAME" as const,
      path: `g${i}`,
      size: i,
    }));
    const r = capDiff(lines);
    expect(r.lines).toHaveLength(50);
    expect(r.truncated).toBe(1);
  });
});

describe("formatDiffPreview", () => {
  test("renders one row per line plus a Summary row", () => {
    const result = capDiff([
      { kind: "NEW", path: "a.txt", toSize: 12 },
      { kind: "SAME", path: "b.txt", size: 34 },
      { kind: "CHANGED", path: "c.txt", fromSize: 10, toSize: 20 },
    ]);
    const text = formatDiffPreview(result);
    expect(text).toContain("NEW       a.txt  (12 B)");
    expect(text).toContain("SAME      b.txt  (skipped)");
    expect(text).toContain("CHANGED   c.txt  (10 B → 20 B)");
    expect(text).toContain("Summary: 1 new, 1 changed, 1 same, 3 total");
  });

  test("appends '+N more' when the cap trimmed entries", () => {
    const lines = Array.from({ length: 51 }, (_, i) => ({
      kind: "NEW" as const,
      path: `f${i}`,
      toSize: i,
    }));
    const result = capDiff(lines, 50);
    const text = formatDiffPreview(result);
    expect(text).toContain("+1 more");
    // Summary still reflects the full count, not just the rendered slice.
    expect(text).toContain("51 new, 0 changed, 0 same, 51 total");
  });

  test("omits '+N more' when nothing was trimmed", () => {
    const result = capDiff([
      { kind: "NEW", path: "a", toSize: 1 },
    ]);
    const text = formatDiffPreview(result);
    expect(text).not.toContain("more");
    expect(text.endsWith("total")).toBe(true);
  });

  test("humanizes byte sizes (B / KiB / MiB / GiB)", () => {
    const result = capDiff([
      { kind: "NEW", path: "tiny", toSize: 500 },
      { kind: "NEW", path: "kib", toSize: 5 * 1024 },
      { kind: "NEW", path: "mib", toSize: 5 * 1024 * 1024 },
      { kind: "NEW", path: "gib", toSize: 2 * 1024 * 1024 * 1024 },
    ]);
    const text = formatDiffPreview(result);
    expect(text).toContain("(500 B)");
    expect(text).toContain("(5.0 KiB)");
    expect(text).toContain("(5.0 MiB)");
    expect(text).toContain("(2.0 GiB)");
  });
});

describe("parseTarListing", () => {
  test("parses a single tar -tvzf line", () => {
    const text =
      "-rw-r--r-- lamasync/lamasync 1234 2026-01-02 03:04 path/to/file.txt\n";
    const entries = parseTarListing(text);
    expect(entries).toEqual([
      { path: "path/to/file.txt", size: 1234 },
    ]);
  });

  test("parses multiple lines and skips directory entries", () => {
    const text = [
      "-rw-r--r-- lamasync/lamasync 100 2026-01-02 03:04 a.txt",
      "drwxr-xr-x lamasync/lamasync    0 2026-01-02 03:04 subdir/",
      "-rw-r--r-- lamasync/lamasync 200 2026-01-02 03:04 b.txt",
      "",
    ].join("\n");
    expect(parseTarListing(text)).toEqual([
      { path: "a.txt", size: 100 },
      { path: "b.txt", size: 200 },
    ]);
  });

  test("tolerates a path with embedded spaces (parts.slice(5).join(' '))", () => {
    // GNU tar quotes paths with spaces inside the archive, but the listing
    // uses the raw form: all tokens after the timestamp are the path.
    const text =
      "-rw-r--r-- lamasync/lamasync 5 2026-01-02 03:04 path/with space/file.txt\n";
    const entries = parseTarListing(text);
    expect(entries).toEqual([
      { path: "path/with space/file.txt", size: 5 },
    ]);
  });

  test("skips junk lines that don't have the expected shape", () => {
    const text = [
      "garbage",
      "-rw-r--r-- lamasync/lamasync notanumber 2026-01-02 03:04 junk.txt",
      "",
    ].join("\n");
    expect(parseTarListing(text)).toEqual([]);
  });
});