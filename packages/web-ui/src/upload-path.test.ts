import { describe, expect, it } from "bun:test";
import { isValidUploadPath, normalizeUploadPath } from "./upload-path.ts";

describe("isValidUploadPath", () => {
  it("accepts empty and simple relative paths", () => {
    expect(isValidUploadPath("")).toBe(true);
    expect(isValidUploadPath("   ")).toBe(true);
    expect(isValidUploadPath("subdir")).toBe(true);
    expect(isValidUploadPath("a/b/c")).toBe(true);
  });

  it("rejects absolute paths", () => {
    expect(isValidUploadPath("/etc")).toBe(false);
    expect(isValidUploadPath("/")).toBe(false);
  });

  it("rejects parent traversal", () => {
    expect(isValidUploadPath("..")).toBe(false);
    expect(isValidUploadPath("../etc")).toBe(false);
    expect(isValidUploadPath("a/../etc")).toBe(false);
    expect(isValidUploadPath("a/..")).toBe(false);
  });

  it("rejects NUL bytes", () => {
    expect(isValidUploadPath("a\0b")).toBe(false);
  });

  it("normalises backslashes but still blocks traversal", () => {
    expect(isValidUploadPath("a\\b")).toBe(true);
    expect(isValidUploadPath("..\\..\\etc")).toBe(false);
  });
});

describe("normalizeUploadPath", () => {
  it("strips leading/trailing slashes and collapses separators", () => {
    expect(normalizeUploadPath("photos/")).toBe("photos");
    expect(normalizeUploadPath("/photos")).toBe("photos");
    expect(normalizeUploadPath("a//b")).toBe("a/b");
    expect(normalizeUploadPath("  a\\b\\ ")).toBe("a/b");
  });

  it("maps empty / root-only input to an empty string", () => {
    expect(normalizeUploadPath("")).toBe("");
    expect(normalizeUploadPath("   ")).toBe("");
    expect(normalizeUploadPath("/")).toBe("");
  });
});
