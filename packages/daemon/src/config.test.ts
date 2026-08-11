// Unit tests for daemon config helpers (LAMA-241: missing-path warnings).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { expandHomePath, missingAssignmentPaths } from "./config.ts";

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
