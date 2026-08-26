// LAMA-260: pure, unit-testable helpers that decide whether a Data Browser
// file can be previewed and how. Kept free of React / DOM so the extension→
// kind classifier, the size cap, and the byte sniffing can be tested in
// isolation (see file-preview.test.ts).

export type PreviewKind = "image" | "text";

/** Text previews are capped at 256 KB — anything larger is not previewed. */
export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonl",
  "yml",
  "yaml",
  "toml",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "sh",
  "bash",
  "zsh",
  "fish",
  "conf",
  "cfg",
  "ini",
  "env",
  "gitignore",
  "gitattributes",
  "dockerignore",
  "editorconfig",
  "log",
  "csv",
  "tsv",
  "lock",
  "sql",
  "go",
  "rs",
  "c",
  "h",
  "hpp",
  "cpp",
  "cc",
  "java",
  "rb",
  "php",
  "vue",
  "svelte",
  "tf",
  "ipynb",
]);

/** Lowercased file extension (no dot), or "" when the name has none. */
export function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return "";
  return name.slice(idx + 1).toLowerCase();
}

/**
 * Classify a file for preview from its name + size alone (synchronous, no
 * bytes needed). Returns "image" for image extensions, "text" for common
 * text extensions under the size cap, and "text" for extension-less files
 * under the cap (their bytes are sniffed later, in the modal, to confirm).
 * Returns null when the file is not worth previewing.
 */
export function previewKindForName(name: string, size: number): PreviewKind | null {
  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (size > TEXT_PREVIEW_MAX_BYTES) return null;
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  // No recognised extension: extension-less files are the common "README" /
  // "LICENSE" / ".bashrc" case — optimistically text, confirmed by sniffing
  // the first bytes once fetched (see sniffPreviewKind).
  if (ext === "") return "text";
  return null;
}

// Magic-byte prefixes for the image types we promise in the UI.
const IMAGE_SIGNATURES: Array<{ kind: PreviewKind; bytes: number[] }> = [
  { kind: "image", bytes: [0x89, 0x50, 0x4e, 0x47] }, // PNG
  { kind: "image", bytes: [0xff, 0xd8, 0xff] }, // JPEG
  { kind: "image", bytes: [0x47, 0x49, 0x46] }, // GIF
  { kind: "image", bytes: [0x52, 0x49, 0x46, 0x46] }, // WEBP (RIFF....WEBP)
  { kind: "image", bytes: [0x42, 0x4d] }, // BMP
];

/**
 * Decide whether a byte buffer looks like an image or plain text by its
 * first bytes. Used for extension-less files once their content is fetched.
 * A buffer with any NUL bytes in its head is treated as binary (not a
 * previewable text file); otherwise it's text.
 */
export function sniffPreviewKind(head: Uint8Array): "image" | "text" | null {
  const probe = Math.min(head.length, 16);
  if (probe === 0) return null;
  for (const sig of IMAGE_SIGNATURES) {
    if (head.length >= sig.bytes.length && sig.bytes.every((b, i) => head[i] === b)) {
      return sig.kind;
    }
  }
  // Look ahead a little to catch the WEBP "WEBP" marker right after RIFF.
  if (
    head.length >= 12 &&
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  ) {
    return "image";
  }
  for (let i = 0; i < probe; i++) {
    if (head[i] === 0) return null; // binary — not a text preview
  }
  return "text";
}

/**
 * Enforce the text-preview cap. Returns the sliced text plus a flag so the
 * modal can render a "truncated" note when the source was cut off.
 */
export function truncateText(content: string, max = TEXT_PREVIEW_MAX_BYTES): { text: string; truncated: boolean } {
  if (content.length <= max) return { text: content, truncated: false };
  return { text: content.slice(0, max), truncated: true };
}
