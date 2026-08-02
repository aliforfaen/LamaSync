import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBrowsePath, statEntry, validateBrowseInput } from "./browse-paths.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lamasync-browse-"));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "file.txt"), "hello");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("validateBrowseInput", () => {
  test("accepts root and relative paths", () => {
    expect(validateBrowseInput("")).toBe(true);
    expect(validateBrowseInput("sub/file.txt")).toBe(true);
    expect(validateBrowseInput("a\\b")).toBe(true);
  });

  test("rejects traversal segments", () => {
    expect(validateBrowseInput("../etc")).toBe(false);
    expect(validateBrowseInput("a/../../etc")).toBe(false);
    expect(validateBrowseInput("sub/../../../etc")).toBe(false);
  });

  test("rejects absolute paths", () => {
    expect(validateBrowseInput("/etc/passwd")).toBe(false);
  });

  test("rejects null bytes", () => {
    expect(validateBrowseInput("sub\0file")).toBe(false);
  });

  test("rejects empty segments", () => {
    expect(validateBrowseInput("sub//file.txt")).toBe(false);
    expect(validateBrowseInput("sub/")).toBe(false);
  });
});

describe("resolveBrowsePath", () => {
  test("root itself is valid", () => {
    expect(resolveBrowsePath(root, "")).toBe(root);
  });

  test("nested valid path resolves", () => {
    expect(resolveBrowsePath(root, "sub/file.txt")).toBe(join(root, "sub", "file.txt"));
  });

  test("rejects traversal segments", () => {
    expect(resolveBrowsePath(root, "../etc")).toBeNull();
    expect(resolveBrowsePath(root, "a/../../etc")).toBeNull();
    expect(resolveBrowsePath(root, "sub/../../../etc")).toBeNull();
  });

  test("rejects absolute paths", () => {
    expect(resolveBrowsePath(root, "/etc/passwd")).toBeNull();
  });

  test("rejects null bytes", () => {
    expect(resolveBrowsePath(root, "sub\0file")).toBeNull();
  });

  test("rejects empty segments", () => {
    expect(resolveBrowsePath(root, "sub//file.txt")).toBeNull();
  });

  test("returns null for missing directory", () => {
    expect(resolveBrowsePath(root, "missing")).toBeNull();
  });

  test("symlinks escaping root are rejected", () => {
    const outside = mkdtempSync(join(tmpdir(), "lamasync-browse-out-"));
    try {
      symlinkSync(outside, join(root, "escape"), "dir");
      expect(resolveBrowsePath(root, "escape")).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("statEntry", () => {
  test("reports file size and mtime", () => {
    const stat = statEntry(join(root, "sub", "file.txt"));
    expect(stat).not.toBeNull();
    expect(stat?.type).toBe("file");
    expect(stat?.size).toBe(5);
    expect(stat?.mtime).toBeGreaterThan(0);
  });

  test("reports directory with zero size", () => {
    const stat = statEntry(join(root, "sub"));
    expect(stat?.type).toBe("dir");
    expect(stat?.size).toBe(0);
  });

  test("returns null for missing path", () => {
    expect(statEntry(join(root, "missing"))).toBeNull();
  });
});
