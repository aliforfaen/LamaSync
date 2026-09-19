// LAMA-345 — the concrete bisync baseline defect.
//
// rclone persists a *paired* listing set (`*.path1.lst` + `*.path2.lst`) under
// `--workdir`; the daemon used to look for a `bisync.state` file rclone has
// never written. These tests pin the real on-disk shapes.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  FILTER_FINGERPRINT_FILENAME,
  RESYNC_REQUIRED_FILENAME,
  baselineFingerprint,
  bisyncStateDir,
  countListingEntries,
  effectiveFilterFingerprint,
  gitignoreOnlyFingerprint,
  inspectBisyncBaseline,
  readAcknowledgedFingerprint,
  readPendingResyncFingerprint,
  reconcileFingerprint,
} from "./bisync-baseline.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "lamasync-bisync-test-"));
}

/** A realistic rclone listing: one JSON header line, then one per entry. */
function listing(entries: number): string {
  const lines = [JSON.stringify({ path1: "remote:Proj", path2: "/home/u/Proj" })];
  for (let i = 0; i < entries; i += 1) {
    lines.push(JSON.stringify({ Path: `file${i}.txt`, Size: 10 }));
  }
  return `${lines.join("\n")}\n`;
}

describe("bisyncStateDir", () => {
  test("is the daemon's per-folder workdir under the user's data dir", () => {
    expect(bisyncStateDir("f1", "/home/u")).toBe(
      "/home/u/.local/share/lamasync/bisync/f1",
    );
  });
});

describe("countListingEntries", () => {
  test("counts entries, not the header line", () => {
    const dir = tempDir();
    const file = join(dir, "pair.path1.lst");
    writeFileSync(file, listing(3));
    expect(countListingEntries(file)).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an empty listing (header only) is zero, and a missing file is zero too", () => {
    const dir = tempDir();
    const file = join(dir, "pair.path1.lst");
    writeFileSync(file, listing(0));
    expect(countListingEntries(file)).toBe(0);
    expect(countListingEntries(join(dir, "nope.lst"))).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("inspectBisyncBaseline", () => {
  test("a fresh workdir — the bisync.state sentinel is NOT a baseline", () => {
    const dir = tempDir();
    // The file the old code looked for. rclone does not write it, and its
    // presence must not be mistaken for a baseline either.
    writeFileSync(join(dir, "bisync.state"), "{}");
    const inspection = inspectBisyncBaseline(dir);
    expect(inspection.present).toBe(false);
    expect(inspection.ready).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a matching path1+path2 listing pair is ready and resumable", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Proj..remote.Proj.path1.lst"), listing(5));
    writeFileSync(join(dir, "Proj..remote.Proj.path2.lst"), listing(5));
    const inspection = inspectBisyncBaseline(dir, { readCounts: true });
    expect(inspection.present).toBe(true);
    expect(inspection.ready).toBe(true);
    expect(inspection.stems).toEqual(["Proj..remote.Proj"]);
    expect(inspection.path1Count).toBe(5);
    expect(inspection.path2Count).toBe(5);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a lone path1 listing is not a usable baseline", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Proj..remote.Proj.path1.lst"), listing(5));
    const inspection = inspectBisyncBaseline(dir);
    expect(inspection.present).toBe(false);
    expect(inspection.ready).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an in-flight .lst-new file makes the pair not ready", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Proj..remote.Proj.path1.lst"), listing(5));
    writeFileSync(join(dir, "Proj..remote.Proj.path2.lst"), listing(5));
    writeFileSync(join(dir, "Proj..remote.Proj.path1.lst-new"), "");
    const inspection = inspectBisyncBaseline(dir);
    expect(inspection.present).toBe(true);
    expect(inspection.ready).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an .lst-err marker is a critical error state", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Proj..remote.Proj.path1.lst"), listing(5));
    writeFileSync(join(dir, "Proj..remote.Proj.path2.lst"), listing(5));
    writeFileSync(join(dir, "Proj..remote.Proj.lst-err"), "critical");
    const inspection = inspectBisyncBaseline(dir);
    expect(inspection.error).toBe(true);
    expect(inspection.ready).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an .lst-err with no surviving pair is still reported as an error", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Proj..remote.Proj.lst-err"), "critical");
    const inspection = inspectBisyncBaseline(dir);
    expect(inspection.error).toBe(true);
    expect(inspection.present).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a missing workdir is simply no baseline", () => {
    const inspection = inspectBisyncBaseline(join(tmpdir(), "definitely-absent-xyz"));
    expect(inspection).toMatchObject({ present: false, ready: false, error: false });
  });
});

describe("baselineFingerprint", () => {
  test("changes when the pair is rewritten, is stable otherwise", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.path1.lst"), listing(1));
    writeFileSync(join(dir, "a.path2.lst"), listing(1));
    const first = baselineFingerprint(inspectBisyncBaseline(dir));
    const second = baselineFingerprint(inspectBisyncBaseline(dir));
    expect(second).toBe(first);
    // A resync rewrites the listings with a newer mtime.
    const later = new Date(Date.now() + 5_000);
    writeFileSync(join(dir, "a.path1.lst"), listing(2));
    utimesSync(join(dir, "a.path1.lst"), later, later);
    expect(baselineFingerprint(inspectBisyncBaseline(dir))).not.toBe(first);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no pair is the literal 'none'", () => {
    expect(baselineFingerprint(inspectBisyncBaseline(join(tmpdir(), "absent-xyz")))).toBe("none");
  });
});

describe("effective filter fingerprint", () => {
  test("changes when either the gitignore rules or the patterns change", () => {
    const base = effectiveFilterFingerprint([], []);
    expect(effectiveFilterFingerprint(["- a"], [])).not.toBe(base);
    expect(effectiveFilterFingerprint([], ["- b"])).not.toBe(base);
    expect(effectiveFilterFingerprint(["x"], ["y"])).toBe(effectiveFilterFingerprint(["x"], ["y"]));
  });
});

describe("fingerprint acknowledgement and the pending-resync marker", () => {
  test("a failed resync leaves the marker in place; a success clears it", () => {
    const dir = tempDir();
    writeFileSync(join(dir, FILTER_FINGERPRINT_FILENAME), "acknowledged");
    expect(readAcknowledgedFingerprint(dir)).toBe("acknowledged");
    writeFileSync(join(dir, RESYNC_REQUIRED_FILENAME), "pending");
    expect(readPendingResyncFingerprint(dir)).toBe("pending");
    rmSync(join(dir, RESYNC_REQUIRED_FILENAME), { force: true });
    expect(readPendingResyncFingerprint(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the legacy gitignore-only hash still counts as acknowledged", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".filter-snapshot.hash"), "legacy");
    expect(readAcknowledgedFingerprint(dir)).toBe("legacy");
    rmSync(dir, { recursive: true, force: true });
  });

  test("reconcile adopts the unified fingerprint from a legacy hash without a resync", () => {
    const rules = ["- node_modules/"];
    const legacy = gitignoreOnlyFingerprint(rules);
    const unified = effectiveFilterFingerprint(rules, ["- *.tmp"]);
    expect(reconcileFingerprint(null, unified, legacy)).toEqual({
      changed: true,
      acknowledge: unified,
    });
    expect(reconcileFingerprint(unified, unified, legacy)).toEqual({
      changed: false,
      acknowledge: unified,
    });
    // Migration: the stored value is the old gitignore-only hash.
    expect(reconcileFingerprint(legacy, unified, legacy)).toEqual({
      changed: false,
      acknowledge: unified,
    });
    // A genuinely different stored value is a real change.
    expect(reconcileFingerprint("something-else", unified, legacy)).toEqual({
      changed: true,
      acknowledge: unified,
    });
  });
});

describe("mkdir safety net", () => {
  test("a workdir created by the daemon is inspectable", () => {
    const dir = join(tempDir(), "nested", "bisync", "f1");
    mkdirSync(dir, { recursive: true });
    expect(inspectBisyncBaseline(dir).present).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
