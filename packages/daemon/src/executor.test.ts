// Tests for the rclone argv builder. Pure function — no subprocess, no DB.

import { describe, expect, test } from "bun:test";
import type { EffectivePause, FolderAssignment } from "@lamasync/core";
import {
  buildRcloneCommand,
  classifyRcloneExit,
  effectiveSyncFilterPatterns,
  effectiveBandwidthSchedule,
  isPauseActive,
  pickConflictAction,
} from "./executor.ts";

describe("buildRcloneCommand", () => {
  test("sync emits bisync with resilient flags and workdir", () => {
    const argv = buildRcloneCommand({
      folderType: "sync",
      remotePath: "remote:Sync",
      localPath: "/tmp/Sync",
      configPath: "/tmp/rclone.conf",
      excludeFilePath: null,
      bisyncStateful: true,
      bisyncStateDir: "/tmp/state",
    });
    expect(argv).toEqual([
      "bisync",
      "remote:Sync",
      "/tmp/Sync",
      "--config",
      "/tmp/rclone.conf",
      "--use-json-log",
      "-v",
      "--workdir",
      "/tmp/state",
      "--resilient",
      "--recover",
      "--max-lock",
      "10m",
    ]);
  });

  test("sync dry-run omits stateful flags and adds --dry-run", () => {
    const argv = buildRcloneCommand({
      folderType: "sync",
      remotePath: "remote:Sync",
      localPath: "/tmp/Sync",
      configPath: "/tmp/rclone.conf",
      excludeFilePath: null,
      dryRun: true,
    });
    expect(argv).toContain("--dry-run");
    expect(argv).not.toContain("--resilient");
    expect(argv).not.toContain("--workdir");
  });

  test("backup emits copy with optional dry-run", () => {
    const argv = buildRcloneCommand({
      folderType: "backup",
      remotePath: "remote:Backup",
      localPath: "/tmp/Backup",
      configPath: "/tmp/rclone.conf",
      excludeFilePath: null,
    });
    expect(argv).toEqual([
      "copy",
      "/tmp/Backup",
      "remote:Backup",
      "--config",
      "/tmp/rclone.conf",
      "--use-json-log",
      "-v",
    ]);
    expect(argv).not.toContain("--dry-run");

    const dry = buildRcloneCommand({
      folderType: "backup",
      remotePath: "remote:Backup",
      localPath: "/tmp/Backup",
      configPath: "/tmp/rclone.conf",
      excludeFilePath: null,
      dryRun: true,
    });
    expect(dry).toContain("--dry-run");
  });

  test("mount emits mount with --daemon", () => {
    const argv = buildRcloneCommand({
      folderType: "mount",
      remotePath: "remote:Mount",
      localPath: "/mnt/Mount",
      configPath: "/tmp/rclone.conf",
      excludeFilePath: null,
    });
    expect(argv).toContain("mount");
    expect(argv).toContain("--daemon");
    expect(argv).toContain("/mnt/Mount");
  });

  test("excludeFilePath adds --filter-from with the file", () => {
    const argv = buildRcloneCommand({
      folderType: "sync",
      remotePath: "remote:Sync",
      localPath: "/tmp/Sync",
      configPath: "/tmp/rclone.conf",
      excludeFilePath: "/tmp/lamasync.exclude",
    });
    const idx = argv.indexOf("--filter-from");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("/tmp/lamasync.exclude");
  });

  test("ignoreGitMetadata excludes .git from the sync transfer", () => {
    expect(effectiveSyncFilterPatterns(["- node_modules/**"], "sync", true)).toEqual([
      "- .git/**",
      "- node_modules/**",
    ]);
    expect(effectiveSyncFilterPatterns(["- node_modules/**"], "mount", true)).toEqual([
      "- node_modules/**",
    ]);
  });

  test("bandwidthSchedule trims whitespace and adds --bwlimit", () => {
    const argv = buildRcloneCommand({
      folderType: "sync",
      remotePath: "remote:Sync",
      localPath: "/tmp/Sync",
      configPath: "/tmp/rclone.conf",
      excludeFilePath: null,
      bandwidthSchedule: "  10M  ",
    });
    const idx = argv.indexOf("--bwlimit");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("10M");
  });

  test("bandwidthSchedule empty string is ignored", () => {
    const argv = buildRcloneCommand({
      folderType: "sync",
      remotePath: "remote:Sync",
      localPath: "/tmp/Sync",
      configPath: "/tmp/rclone.conf",
      excludeFilePath: null,
      bandwidthSchedule: "   ",
    });
    expect(argv).not.toContain("--bwlimit");
  });

  test("unsupported folder types throw", () => {
    expect(() =>
      buildRcloneCommand({
        folderType: "dotfile" as never,
        remotePath: "r:d",
        localPath: "/tmp/d",
        configPath: "/tmp/c",
        excludeFilePath: null,
      }),
    ).toThrow(/unsupported folder type/);
  });
});

describe("classifyRcloneExit (LAMA-294)", () => {
  test("exit 0 is success", () => {
    expect(classifyRcloneExit(0)).toBe("success");
  });

  test("exit 9 is NoFilesTransferred (a success, not an error)", () => {
    expect(classifyRcloneExit(9)).toBe("no-transfer");
  });

  test("exit 5 is a retryable transient error", () => {
    expect(classifyRcloneExit(5)).toBe("retryable");
  });

  test("bisync exit 1 is retryable but copy exit 1 is not", () => {
    expect(classifyRcloneExit(1, "sync")).toBe("retryable");
    expect(classifyRcloneExit(1, "backup")).toBe("non-retryable");
  });

  test("missing paths, syntax, fatal, quota are non-retryable", () => {
    // DirNotFound, FileNotFound, UsageError, NoRetryError, FatalError,
    // TransferExceeded, DurationExceeded, Uncategorized.
    for (const code of [1, 2, 3, 4, 6, 7, 8, 10]) {
      expect(classifyRcloneExit(code)).toBe("non-retryable");
    }
  });
});

describe("pickConflictAction", () => {
  test("newer_wins picks local when local is newer", () => {
    expect(pickConflictAction("newer_wins", 200, 100, "both")).toEqual({ kind: "local_wins" });
  });

  test("newer_wins picks remote when remote is newer", () => {
    expect(pickConflictAction("newer_wins", 100, 200, "both")).toEqual({ kind: "remote_wins" });
  });

  test("newer_wins falls back to keep_both on equal mtimes", () => {
    expect(pickConflictAction("newer_wins", 100, 100, "both")).toEqual({ kind: "keep_both" });
  });

  test("newer_wins falls back to keep_both when mtimes are missing", () => {
    expect(pickConflictAction("newer_wins", undefined, undefined, "both")).toEqual({ kind: "keep_both" });
  });

  test("source_wins uses local for source and both roles", () => {
    expect(pickConflictAction("source_wins", 100, 200, "source")).toEqual({ kind: "local_wins" });
    expect(pickConflictAction("source_wins", 100, 200, "both")).toEqual({ kind: "local_wins" });
  });

  test("source_wins uses remote for target role", () => {
    expect(pickConflictAction("source_wins", 200, 100, "target")).toEqual({ kind: "remote_wins" });
  });

  test("keep_both always keeps both", () => {
    expect(pickConflictAction("keep_both", 200, 100, "source")).toEqual({ kind: "keep_both" });
    expect(pickConflictAction("keep_both", 100, 200, "target")).toEqual({ kind: "keep_both" });
  });
});

// LAMA-273: pause / slow-mode helpers. The helpers are pure so we can
// exercise them without touching rclone or the hostConfig cache.
describe("effectiveBandwidthSchedule (LAMA-273)", () => {
  const baseAssignment: Pick<FolderAssignment, "bandwidthSchedule"> = {
    bandwidthSchedule: "10M",
  };
  const now = 1_700_000_000_000;

  test("returns null with no pause and no schedule", () => {
    expect(effectiveBandwidthSchedule({ bandwidthSchedule: null }, null, now)).toBeNull();
  });

  test("returns the assignment schedule when no pause is active", () => {
    expect(effectiveBandwidthSchedule(baseAssignment, null, now)).toBe("10M");
  });

  test("slow-mode pause bwlimit wins over the assignment schedule", () => {
    const pause: EffectivePause = {
      until: new Date(now + 60_000).toISOString(),
      mode: "slow",
      bwlimit: "1M",
    };
    expect(effectiveBandwidthSchedule(baseAssignment, pause, now)).toBe("1M");
  });

  test("pause-mode bwlimit is ignored — only slow mode injects --bwlimit", () => {
    const pause: EffectivePause = {
      until: new Date(now + 60_000).toISOString(),
      mode: "pause",
      // Defensive: even if a pause row carried bwlimit, the executor
      // must not throttle. The route layer rejects this combo, but the
      // helper is the second line of defense.
      bwlimit: "1M",
    };
    expect(effectiveBandwidthSchedule(baseAssignment, pause, now)).toBe("10M");
  });

  test("expired pause falls back to the assignment schedule", () => {
    const pause: EffectivePause = {
      until: new Date(now - 1).toISOString(),
      mode: "slow",
      bwlimit: "1M",
    };
    expect(effectiveBandwidthSchedule(baseAssignment, pause, now)).toBe("10M");
  });

  test("slow pause without a bwlimit falls back to the assignment schedule", () => {
    const pause: EffectivePause = {
      until: new Date(now + 60_000).toISOString(),
      mode: "slow",
      bwlimit: null,
    };
    expect(effectiveBandwidthSchedule(baseAssignment, pause, now)).toBe("10M");
  });

  test("trims whitespace from either source", () => {
    const pause: EffectivePause = {
      until: new Date(now + 60_000).toISOString(),
      mode: "slow",
      bwlimit: "  512K  ",
    };
    expect(effectiveBandwidthSchedule({ bandwidthSchedule: "  10M  " }, pause, now)).toBe("512K");
    expect(effectiveBandwidthSchedule({ bandwidthSchedule: "  10M  " }, null, now)).toBe("10M");
  });
});

describe("isPauseActive (LAMA-273)", () => {
  const now = 1_700_000_000_000;
  test("null / undefined pauses are inactive", () => {
    expect(isPauseActive(null, now)).toBe(false);
    expect(isPauseActive(undefined, now)).toBe(false);
  });
  test("future until is active", () => {
    expect(isPauseActive({ until: new Date(now + 1).toISOString(), mode: "pause", bwlimit: null }, now)).toBe(true);
  });
  test("past until is inactive", () => {
    expect(isPauseActive({ until: new Date(now - 1).toISOString(), mode: "pause", bwlimit: null }, now)).toBe(false);
  });
  test("garbage until is treated as inactive (fail-safe)", () => {
    expect(isPauseActive({ until: "not-a-date", mode: "pause", bwlimit: null }, now)).toBe(false);
  });
});

// LAMA-273: belt-and-braces — executeAssignment must short-circuit with
// a clear "paused until <iso>" report when hostConfig.pause is active,
// without spawning rclone. We exercise the helper directly via a tiny
// fake ExecuteOptions shape to assert the refusal path.
describe("executeAssignment pause refusal (LAMA-273)", () => {
  test("refuses with a paused summary when hostConfig.pause is active", async () => {
    const { executeAssignment } = await import("./executor.ts");
    const futureIso = new Date(Date.now() + 60 * 60_000).toISOString();
    const report = await executeAssignment({
      assignment: {
        id: "a1",
        folderId: "f1",
        hostId: "h1",
        role: "source",
        localPath: "/tmp/lamasync-test",
        enabled: true,
      },
      folder: { id: "f1", name: "MySync", type: "sync" },
      hostConfig: {
        host: { id: "h1", hostname: "h1", status: "online" },
        assignments: [],
        folders: [],
        manifests: [],
        rcloneConfig: "[fake]\ntype = local\n",
        serverTailnetIp: null,
        peers: [],
        pause: { until: futureIso, mode: "pause", bwlimit: null },
      },
      client: {} as never, // pause refusal returns before any client call
      hostId: "h1",
      configPath: "/tmp/none",
    });
    expect(report.status).toBe("failed");
    expect(report.summary).toContain("sync skipped: paused until");
    expect(report.summary).toContain(futureIso);
    // No rclone was invoked — the rclone-missing error path would
    // produce a different summary, so the presence of the "paused"
    // marker is sufficient.
    expect(report.summary).not.toContain("rclone binary not found");
  });
});
