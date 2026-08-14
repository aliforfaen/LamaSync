// LAMA-239: per-host mount/sync override — pure helper tests.

import { describe, expect, test } from "bun:test";
import { effectiveFolderType, normalizeAssignmentMode } from "./effective-type.ts";
import type { Folder, FolderAssignment } from "./types.ts";

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: "f1",
    name: "docs",
    type: "sync",
    encrypted: false,
    cryptPassword: null,
    ...overrides,
  };
}

function makeAssignment(overrides: Partial<FolderAssignment> = {}): FolderAssignment {
  return {
    id: "a1",
    folderId: "f1",
    hostId: "h1",
    role: "both",
    localPath: "/tmp/d",
    enabled: true,
    ...overrides,
  };
}

describe("effectiveFolderType (LAMA-239)", () => {
  test("inherit on a sync folder resolves to sync", () => {
    expect(effectiveFolderType(makeFolder({ type: "sync" }), makeAssignment({ mode: "inherit" }))).toBe("sync");
  });

  test("inherit on a mount folder resolves to mount", () => {
    expect(effectiveFolderType(makeFolder({ type: "mount" }), makeAssignment({ mode: "inherit" }))).toBe("mount");
  });

  test("undefined mode on a sync folder resolves to sync (default = inherit)", () => {
    expect(effectiveFolderType(makeFolder({ type: "sync" }), makeAssignment())).toBe("sync");
  });

  test("sync override on a mount folder flips the host to sync", () => {
    const folder = makeFolder({ type: "mount" });
    const assignment = makeAssignment({ mode: "sync" });
    expect(effectiveFolderType(folder, assignment)).toBe("sync");
  });

  test("mount override on a sync folder flips the host to mount", () => {
    const folder = makeFolder({ type: "sync" });
    const assignment = makeAssignment({ mode: "mount" });
    expect(effectiveFolderType(folder, assignment)).toBe("mount");
  });

  test("override is ignored on backup folders", () => {
    const folder = makeFolder({ type: "backup" });
    expect(effectiveFolderType(folder, makeAssignment({ mode: "sync" }))).toBe("backup");
    expect(effectiveFolderType(folder, makeAssignment({ mode: "mount" }))).toBe("backup");
    expect(effectiveFolderType(folder, makeAssignment({ mode: "inherit" }))).toBe("backup");
  });

  test("override is ignored on dotfile folders", () => {
    const folder = makeFolder({ type: "dotfile" });
    expect(effectiveFolderType(folder, makeAssignment({ mode: "mount" }))).toBe("dotfile");
  });

  test("override is ignored on git folders", () => {
    const folder = makeFolder({ type: "git" });
    expect(effectiveFolderType(folder, makeAssignment({ mode: "sync" }))).toBe("git");
  });

  test("invalid mode string falls back to inherit (belt-and-braces)", () => {
    // The narrower is the source of truth at the wire boundary; this
    // helper still won't crash on a bogus value.
    const folder = makeFolder({ type: "sync" });
    const bogus = { ...makeAssignment(), mode: "bogus" as FolderAssignment["mode"] };
    expect(effectiveFolderType(folder, bogus)).toBe("sync");
  });
});

describe("normalizeAssignmentMode (LAMA-239)", () => {
  test("accepts the three valid values", () => {
    expect(normalizeAssignmentMode("inherit")).toBe("inherit");
    expect(normalizeAssignmentMode("sync")).toBe("sync");
    expect(normalizeAssignmentMode("mount")).toBe("mount");
  });

  test("falls back to inherit for null / undefined / unknown", () => {
    expect(normalizeAssignmentMode(null)).toBe("inherit");
    expect(normalizeAssignmentMode(undefined)).toBe("inherit");
    expect(normalizeAssignmentMode("")).toBe("inherit");
    expect(normalizeAssignmentMode("bogus")).toBe("inherit");
    expect(normalizeAssignmentMode(42)).toBe("inherit");
  });
});