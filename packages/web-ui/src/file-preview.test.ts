import { describe, expect, it } from "bun:test";
import {
  TEXT_PREVIEW_MAX_BYTES,
  extensionOf,
  previewKindForName,
  sniffPreviewKind,
  truncateText,
} from "./file-preview.ts";

describe("extensionOf", () => {
  it("returns the lowercased last extension", () => {
    expect(extensionOf("photo.PNG")).toBe("png");
    expect(extensionOf("README.md")).toBe("md");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });

  it("returns '' for no or dot-prefixed names", () => {
    expect(extensionOf("README")).toBe("");
    expect(extensionOf(".bashrc")).toBe("");
    expect(extensionOf("trailing.")).toBe("");
  });
});

describe("previewKindForName", () => {
  it("classifies images regardless of size", () => {
    for (const name of ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.svg"]) {
      expect(previewKindForName(name, 1000)).toBe("image");
      expect(previewKindForName(name, TEXT_PREVIEW_MAX_BYTES + 1)).toBe("image");
    }
  });

  it("classifies common text extensions under the cap", () => {
    for (const name of ["a.txt", "a.md", "a.json", "a.yml", "a.yaml", "a.sh", "a.py", "a.ts"]) {
      expect(previewKindForName(name, 1000)).toBe("text");
    }
  });

  it("rejects text extensions above the size cap", () => {
    expect(previewKindForName("a.txt", TEXT_PREVIEW_MAX_BYTES)).toBe("text");
    expect(previewKindForName("a.txt", TEXT_PREVIEW_MAX_BYTES + 1)).toBeNull();
  });

  it("treats extension-less names as optimistic text under the cap", () => {
    expect(previewKindForName("README", 1000)).toBe("text");
    expect(previewKindForName(".bashrc", 1000)).toBe("text");
  });

  it("rejects unknown extensions", () => {
    expect(previewKindForName("a.exe", 1000)).toBeNull();
    expect(previewKindForName("a.bin", 1000)).toBeNull();
    expect(previewKindForName("a.zzz", TEXT_PREVIEW_MAX_BYTES + 1)).toBeNull();
  });
});

describe("sniffPreviewKind", () => {
  it("recognises PNG/JPEG/GIF/WEBP magic bytes", () => {
    expect(sniffPreviewKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("image");
    expect(sniffPreviewKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image");
    expect(sniffPreviewKind(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe("image");
    const webp = new Uint8Array(12);
    webp.set([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffPreviewKind(webp)).toBe("image");
  });

  it("treats readable bytes without NULs as text", () => {
    expect(sniffPreviewKind(new TextEncoder().encode("hello world\n"))).toBe("text");
  });

  it("rejects binary buffers (NUL bytes) and empty input", () => {
    expect(sniffPreviewKind(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
    expect(sniffPreviewKind(new Uint8Array(0))).toBeNull();
  });
});

describe("truncateText", () => {
  it("passes through content under the cap", () => {
    expect(truncateText("short")).toEqual({ text: "short", truncated: false });
  });

  it("slices content over the cap and flags it", () => {
    const long = "x".repeat(TEXT_PREVIEW_MAX_BYTES + 10);
    const { text, truncated } = truncateText(long);
    expect(truncated).toBe(true);
    expect(text.length).toBe(TEXT_PREVIEW_MAX_BYTES);
  });
});
