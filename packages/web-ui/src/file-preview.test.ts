import { describe, expect, it } from "bun:test";
import {
  MEDIA_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  mimeTypeForName,
  previewPlanFor,
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

// LAMA-335: the viewer's agreed initial format set, its limits, and the clear
// fallback the issue requires. The plan (not just the kind) is what the UI
// renders, so the reason a file has no viewer is a decision, not a silence.
describe("previewPlanFor (LAMA-335)", () => {
  it("previews images of any size (the browser scales them)", () => {
    const plan = previewPlanFor("photo.png", 200 * 1024 * 1024);
    expect(plan.kind).toBe("image");
    expect(plan.reason).toBeNull();
    expect(plan.sniff).toBe(false);
  });

  it("previews audio and video under the media cap", () => {
    expect(previewPlanFor("track.mp3", 4 * 1024 * 1024).kind).toBe("audio");
    expect(previewPlanFor("clip.mp4", 40 * 1024 * 1024).kind).toBe("video");
    expect(previewPlanFor("clip.webm", 1024).kind).toBe("video");
  });

  it("refuses media over the cap and says why", () => {
    const plan = previewPlanFor("holiday.mov", MEDIA_PREVIEW_MAX_BYTES + 1);
    expect(plan.kind).toBeNull();
    expect(plan.reason).toContain("48 MB");
  });

  it("previews text under the cap and refuses it above", () => {
    expect(previewPlanFor("notes.md", 1024).kind).toBe("text");
    const big = previewPlanFor("notes.md", TEXT_PREVIEW_MAX_BYTES + 1);
    expect(big.kind).toBeNull();
    expect(big.reason).toContain("256 KB");
  });

  it("asks for a sniff only for extension-less files", () => {
    expect(previewPlanFor("README", 100).sniff).toBe(true);
    expect(previewPlanFor("readme.md", 100).sniff).toBe(false);
    // An extension-less file too large to decode is refused, not sniffed.
    const big = previewPlanFor("README", TEXT_PREVIEW_MAX_BYTES + 1);
    expect(big.kind).toBeNull();
    expect(big.sniff).toBe(false);
  });

  it("names the fallback for a type the viewer does not render", () => {
    const plan = previewPlanFor("archive.zip", 1024);
    expect(plan.kind).toBeNull();
    expect(plan.reason).toBeTruthy();
    // A reason is not an error: the modal shows it next to Download.
    expect(plan.reason).not.toContain("error");
  });

  it("stays consistent with previewKindForName", () => {
    const names: Array<[string, number]> = [
      ["a.png", 10],
      ["a.txt", 10],
      ["a.mp3", 10],
      ["a.mp4", MEDIA_PREVIEW_MAX_BYTES + 1],
      ["a.zip", 10],
      ["README", 10],
    ];
    for (const [name, size] of names) {
      expect(previewKindForName(name, size)).toBe(previewPlanFor(name, size).kind);
    }
  });
});

describe("mimeTypeForName (LAMA-335)", () => {
  it("types the media the preview binds to a Blob", () => {
    // A typeless Blob is what makes an <audio>/<video> element refuse to play.
    expect(mimeTypeForName("a.mp3")).toBe("audio/mpeg");
    expect(mimeTypeForName("a.m4a")).toBe("audio/mp4");
    expect(mimeTypeForName("a.flac")).toBe("audio/flac");
    expect(mimeTypeForName("a.mp4")).toBe("video/mp4");
    expect(mimeTypeForName("a.webm")).toBe("video/webm");
    expect(mimeTypeForName("a.mov")).toBe("video/quicktime");
  });

  it("types images, and falls back to octet-stream for anything else", () => {
    expect(mimeTypeForName("a.PNG")).toBe("image/png");
    expect(mimeTypeForName("a.jpeg")).toBe("image/jpeg");
    expect(mimeTypeForName("a.svg")).toBe("image/svg+xml");
    expect(mimeTypeForName("a.zip")).toBe("application/octet-stream");
    expect(mimeTypeForName("README")).toBe("application/octet-stream");
  });
});
