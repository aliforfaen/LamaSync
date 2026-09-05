// Unit tests for daemon config helpers (LAMA-241: missing-path warnings,
// LAMA-309: config-load path expansion).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AppCaptureAssignment, FolderAssignment, HostConfig } from "@lamasync/core";
import { expandConfigPaths, expandHomePath, missingAssignmentPaths } from "./config.ts";

describe("expandHomePath", () => {
  test("leaves absolute paths untouched", () => {
    expect(expandHomePath("/srv/data")).toBe("/srv/data");
  });

  test("expands bare ~ and ~/ to the home directory", () => {
    const home = process.env.HOME ?? "/nonexistent-home";
    expect(expandHomePath("~")).toBe(home);
    expect(expandHomePath("~/sessions")).toBe(join(home, "sessions"));
  });

  test("expands ~user to /home/user", () => {
    // Works for any absolute home root (e.g. /home on Linux, /root).
    const expected = join("/", "home", "someone", "code");
    expect(expandHomePath("~someone/code")).toBe(expected);
  });
});

describe("missingAssignmentPaths", () => {
  test("flags assignments whose local path does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "lamasync-missing-path-"));
    const existing = join(dir, "exists");
    mkdirSync(existing);
    try {
      const missing = missingAssignmentPaths(
        [
          { folderId: "f1", localPath: existing },
          { folderId: "f2", localPath: join(dir, "nope") },
        ],
        (id) => (id === "f2" ? "fish-folder" : null),
      );
      expect(missing).toEqual([
        { folderId: "f2", folderName: "fish-folder", localPath: join(dir, "nope") },
      ]);
      expect(existsSync(existing)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolves ~ before checking", () => {
    const missing = missingAssignmentPaths(
      [{ folderId: "f3", localPath: "~/definitely-not-a-real-lamasync-path" }],
      () => "dotfiles",
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]!.localPath).toBe("~/definitely-not-a-real-lamasync-path");
  });

  test("empty assignments → no warnings", () => {
    expect(missingAssignmentPaths([], () => null)).toEqual([]);
  });
});

// LAMA-309: assignment local paths must be expanded once at config load so
// every consumer (rclone argv, df, watch existsSync, mounts, systemd) sees
// an absolute path — rclone does NOT expand `~` itself.
describe("expandConfigPaths (LAMA-309)", () => {
  const mk = (localPath: string): FolderAssignment => ({
    id: "a1",
    folderId: "f1",
    hostId: "h1",
    role: "source",
    localPath,
    enabled: true,
  });

  const makeApp = (paths: string[]): AppCaptureAssignment => ({
    appName: "nvim",
    hostId: "h1",
    protectionId: "p1",
    paths,
    schedule: null,
  });

  const makeConfig = (
    assignments: FolderAssignment[],
    apps: AppCaptureAssignment[] = [],
  ): HostConfig => ({
    host: { id: "h1", hostname: "h1", status: "online" },
    assignments,
    folders: [],
    apps,
    rcloneConfig: "[fake]\ntype = local\n",
    serverTailnetIp: null,
    peers: [],
  });

  test("expands ~ / ~/ assignment paths to absolute paths", () => {
    const cfg = makeConfig([mk("~/sessions"), mk("/srv/data")]);
    const out = expandConfigPaths(cfg);
    expect(out).not.toBe(cfg);
    expect(out.assignments[0]!.localPath).toBe(expandHomePath("~/sessions"));
    expect(out.assignments[0]!.localPath).not.toBe("~/sessions");
    expect(out.assignments[1]!.localPath).toBe("/srv/data");
  });

  test("returns the same reference when no path uses ~ (no needless copy)", () => {
    const cfg = makeConfig([mk("/srv/data"), mk("/var/lib/foo")], [makeApp(["/srv/app"])]);
    expect(expandConfigPaths(cfg)).toBe(cfg);
  });

  test("does not mutate the input config", () => {
    const cfg = makeConfig([mk("~/sessions")]);
    expandConfigPaths(cfg);
    expect(cfg.assignments[0]!.localPath).toBe("~/sessions");
  });

  test("keeps logical app paths and supplies paired local resolved paths", () => {
    const cfg = makeConfig([], [makeApp(["~/.config/nvim", "/etc/example"])]);
    const out = expandConfigPaths(cfg);
    expect(out).not.toBe(cfg);
    expect(out.apps[0]!.paths).toEqual(["~/.config/nvim", "/etc/example"]);
    expect(out.apps[0]!.resolvedPaths).toEqual([
      expandHomePath("~/.config/nvim"),
      "/etc/example",
    ]);
    expect(cfg.apps[0]!.paths[0]).toBe("~/.config/nvim");
  });
});
