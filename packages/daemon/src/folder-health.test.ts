// LAMA-345 — the daemon health probe: lightweight facts, layered cost, and
// the fixtures the acceptance criteria name.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { FolderAssignment } from "@lamasync/core";
import {
  DEEP_MEASURE_ENTRY_CAP,
  cheapEffectiveFilter,
  diagnoseFolder,
  freeSpaceBytes,
  liveFilterFingerprint,
  measureLocalTree,
  probeFolderHealth,
  probeLocalDir,
  seedStagingProofFor,
} from "./folder-health.ts";
import { RESYNC_REQUIRED_FILENAME } from "./bisync-baseline.ts";

function tempDir(prefix = "lamasync-health-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function listing(entries: number): string {
  const lines = [JSON.stringify({ path1: "remote:P", path2: "/local/P" })];
  for (let i = 0; i < entries; i += 1) lines.push(JSON.stringify({ Path: `f${i}` }));
  return `${lines.join("\n")}\n`;
}

function assignment(overrides: Partial<FolderAssignment> = {}): FolderAssignment {
  return {
    id: "a1",
    folderId: "f1",
    hostId: "dev-vm",
    role: "both",
    localPath: "/tmp/does-not-need-to-exist",
    enabled: true,
    ...overrides,
  };
}

function probe(
  localPath: string,
  stateDir: string,
  overrides: Partial<Parameters<typeof probeFolderHealth>[0]> = {},
) {
  return probeFolderHealth({
    assignment: assignment({ localPath }),
    effectiveType: "sync",
    enabled: true,
    paused: false,
    runInProgress: false,
    activePhase: null,
    rcloneAvailable: true,
    pendingConflicts: 0,
    watcher: { enabled: false, running: false, quietSec: 30 },
    lastRun: null,
    measurement: null,
    readCounts: false,
    stateDir,
    ...overrides,
  });
}

describe("probeLocalDir", () => {
  test("classifies a real directory as ok", () => {
    const dir = tempDir();
    expect(probeLocalDir(dir)).toBe("ok");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a missing path is missing and a file is not a directory", () => {
    const dir = tempDir();
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    expect(probeLocalDir(join(dir, "absent"))).toBe("missing");
    expect(probeLocalDir(file)).toBe("not_directory");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("freeSpaceBytes", () => {
  test("reports a positive reading for a real directory", () => {
    const bytes = freeSpaceBytes(tmpdir());
    expect(bytes === null || bytes > 0).toBe(true);
  });

  test("a missing path resolves to null rather than throwing", () => {
    expect(freeSpaceBytes(join(tmpdir(), "lamasync-absent-path-xyz"))).toBeNull();
  });
});

describe("measureLocalTree", () => {
  test("counts files and bytes recursively, bounded by the entry cap", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "a.txt"), "12345");
    writeFileSync(join(dir, "sub", "b.txt"), "123");
    const measured = measureLocalTree(dir);
    // one file + one directory + one nested file
    expect(measured.pathCount).toBe(3);
    expect(measured.totalBytes).toBe(8);
    expect(DEEP_MEASURE_ENTRY_CAP).toBeGreaterThan(1000);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("cheapEffectiveFilter", () => {
  test("reads .lamasyncignore patterns without touching a Git worktree", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".lamasyncignore"), "# comment\n- *.tmp\n\n- cache/\n");
    const info = cheapEffectiveFilter(
      assignment({ localPath: dir, ignorePath: ".lamasyncignore" }),
      "sync",
    );
    expect(info.patterns).toEqual(["- *.tmp", "- cache/"]);
    expect(info.source).toBe("lamasyncignore");
    rmSync(dir, { recursive: true, force: true });
  });

  test("ignoreGitMetadata prepends the .git rule", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".lamasyncignore"), "- *.tmp\n");
    const info = cheapEffectiveFilter(
      assignment({ localPath: dir, ignorePath: ".lamasyncignore", ignoreGitMetadata: true }),
      "sync",
    );
    expect(info.patterns[0]).toBe("- .git/**");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("liveFilterFingerprint", () => {
  test("changes when .lamasyncignore changes", () => {
    const dir = tempDir();
    const ignore = join(dir, ".lamasyncignore");
    writeFileSync(ignore, "- a\n");
    const first = liveFilterFingerprint(
      assignment({ localPath: dir, ignorePath: ".lamasyncignore" }),
      "sync",
    );
    writeFileSync(ignore, "- b\n");
    const second = liveFilterFingerprint(
      assignment({ localPath: dir, ignorePath: ".lamasyncignore" }),
      "sync",
    );
    expect(first.fingerprint).not.toBeNull();
    expect(second.fingerprint).not.toBe(first.fingerprint);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no filters at all is a null fingerprint", () => {
    const dir = tempDir();
    const info = liveFilterFingerprint(assignment({ localPath: dir }), "sync");
    expect(info.fingerprint).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("seedStagingProofFor — the target's own sibling proof", () => {
  test("proves the staging sibling shares the target's parent on a real directory", () => {
    const local = tempDir();
    const target = join(local, "Projects");
    mkdirSync(target, { recursive: true });
    const proof = seedStagingProofFor(target, 1_234);
    expect(proof.targetPath).toBe(target);
    expect(proof.targetParent).toBe(local);
    // `seedStagingPath` derives a sibling, so the two parents are the SAME
    // directory — which is the whole proof.
    expect(proof.stagingParent).toBe(proof.targetParent);
    expect(proof.sameFilesystem).toBe(true);
    expect(typeof proof.device).toBe("number");
    expect(proof.checkedAt).toBe(1_234);
    rmSync(local, { recursive: true, force: true });
  });

  test("an unreadable parent is UNKNOWN, never optimistically true", () => {
    // `/tmp/lamasync-does-not-exist-<n>` is not created.
    const proof = seedStagingProofFor("/tmp/lamasync-does-not-exist-346/Projects", 7);
    expect(proof.stagingParent).toBe(proof.targetParent);
    expect(proof.sameFilesystem).toBeNull();
    expect(proof.device).toBeNull();
  });

  test("a relative local path cannot produce a proof at all", () => {
    const proof = seedStagingProofFor("relative/Projects", 7);
    expect(proof.targetPath).toBeNull();
    expect(proof.targetParent).toBeNull();
    expect(proof.stagingParent).toBeNull();
    expect(proof.sameFilesystem).toBeNull();
  });
});

describe("probeFolderHealth", () => {
  test("the heartbeat carries the archive tooling and the staging proof", () => {
    const local = tempDir();
    const state = tempDir();
    const target = join(local, "Projects");
    mkdirSync(target, { recursive: true });
    const { report } = probe(target, state);
    expect(report.facts.archive).not.toBeNull();
    expect(typeof report.facts.archive?.tar).toBe("boolean");
    expect(report.facts.seedStaging?.sameFilesystem).toBe(true);
    expect(report.facts.seedStaging?.targetParent).toBe(local);
    rmSync(local, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  test("a ready paired listing set with a clean last run is healthy", () => {
    const local = tempDir();
    const state = tempDir();
    writeFileSync(join(state, "P.path1.lst"), listing(4));
    writeFileSync(join(state, "P.path2.lst"), listing(4));
    const { report } = probe(local, state, {
      lastRun: { status: "success", summary: "ok", at: Date.now() },
    });
    expect(report.state).toBe("healthy");
    expect(report.facts.baseline.ready).toBe(true);
    rmSync(local, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  test("a fresh host with no pair is new_host, never healthy", () => {
    const local = tempDir();
    const state = tempDir();
    const { report } = probe(local, state);
    expect(report.state).toBe("new_host");
    expect(report.reasons[0]?.code).toBe("baseline_missing");
    rmSync(local, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  test("the dev-vm shape: an empty remote listing beside local content is resync_required", () => {
    const local = tempDir();
    const state = tempDir();
    writeFileSync(join(state, "P.path1.lst"), listing(0));
    writeFileSync(join(state, "P.path2.lst"), listing(850));
    const { report } = probe(local, state, { readCounts: true });
    expect(report.state).toBe("resync_required");
    expect(report.reasons.map((r) => r.code)).toContain("baseline_not_established");
    expect(report.facts.baseline.path1Count).toBe(0);
    expect(report.facts.baseline.path2Count).toBe(850);
    rmSync(local, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  test("a pending resync marker makes the filter change visible and blocks 'healthy'", () => {
    const local = tempDir();
    const state = tempDir();
    writeFileSync(join(state, "P.path1.lst"), listing(2));
    writeFileSync(join(state, "P.path2.lst"), listing(2));
    writeFileSync(join(state, RESYNC_REQUIRED_FILENAME), "fp");
    const { report, resyncPending } = probe(local, state);
    expect(resyncPending).toBe(true);
    expect(report.facts.filter.changedSinceBaseline).toBe(true);
    expect(report.state).toBe("resync_required");
    rmSync(local, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  test("an rclone critical error is unsafe", () => {
    const local = tempDir();
    const state = tempDir();
    writeFileSync(join(state, "P.path1.lst"), listing(2));
    writeFileSync(join(state, "P.path2.lst"), listing(2));
    writeFileSync(join(state, "P.lst-err"), "critical");
    const { report } = probe(local, state);
    expect(report.state).toBe("unsafe");
    rmSync(local, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  test("a missing local directory blocks the run", () => {
    const state = tempDir();
    const { report } = probe("/tmp/lamasync-missing-local-dir", state);
    expect(report.state).toBe("blocked");
    expect(report.reasons.map((r) => r.code)).toContain("local_path_missing");
    rmSync(state, { recursive: true, force: true });
  });

  test("a missing rclone blocks the run", () => {
    const local = tempDir();
    const state = tempDir();
    const { report } = probe(local, state, { rcloneAvailable: false });
    expect(report.state).toBe("blocked");
    expect(report.reasons.map((r) => r.code)).toContain("rclone_missing");
    rmSync(local, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  test("the lightweight probe reports counts as null unless asked", () => {
    const local = tempDir();
    const state = tempDir();
    writeFileSync(join(state, "P.path1.lst"), listing(4));
    writeFileSync(join(state, "P.path2.lst"), listing(4));
    const light = probe(local, state);
    expect(light.report.facts.baseline.path1Count).toBeNull();
    const deep = probe(local, state, { readCounts: true });
    expect(deep.report.facts.baseline.path1Count).toBe(4);
    rmSync(local, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  test("an in-flight run is busy", () => {
    const local = tempDir();
    const state = tempDir();
    const { report } = probe(local, state, { runInProgress: true });
    expect(report.state).toBe("busy");
    rmSync(local, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });
});

describe("diagnoseFolder", () => {
  test("reports the listing-pair identity and both fingerprints", () => {
    const local = tempDir();
    const state = tempDir();
    writeFileSync(join(state, "P.path1.lst"), listing(7));
    writeFileSync(join(state, "P.path2.lst"), listing(3));
    writeFileSync(join(local, ".lamasyncignore"), "- *.log\n");
    const diagnosis = diagnoseFolder({
      assignment: assignment({ localPath: local, ignorePath: ".lamasyncignore" }),
      effectiveType: "sync",
      enabled: true,
      paused: false,
      runInProgress: false,
      activePhase: null,
      rcloneAvailable: true,
      pendingConflicts: 0,
      watcher: null,
      lastRun: null,
      measurement: null,
      readCounts: true,
      stateDir: state,
    });
    expect(diagnosis.baseline.present).toBe(true);
    expect(diagnosis.baseline.path1Count).toBe(7);
    expect(diagnosis.baseline.path2Count).toBe(3);
    expect(diagnosis.baseline.fingerprint).not.toBe("none");
    expect(diagnosis.filter.patternCount).toBe(1);
    expect(diagnosis.filter.pendingFingerprint).toBeNull();
    rmSync(local, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });
});
