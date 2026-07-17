// Tests for the rclone argv builder. Pure function — no subprocess, no DB.

import { describe, expect, test } from "bun:test";
import { buildRcloneCommand, pickConflictAction } from "./executor.ts";

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
