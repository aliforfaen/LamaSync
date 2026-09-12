// LAMA-260: pure, unit-testable helpers that decide whether a Data Browser
// file can be previewed and how. Kept free of React / DOM so the extension→
// kind classifier, the size caps, the MIME mapping and the byte sniffing can
// be tested in isolation (see file-preview.test.ts).
//
// LAMA-335 extended this from "image | text" to the set the issue agreed on:
// image, text, audio and video, all rendered by the BROWSER itself (no viewer
// library, no new bundle weight), plus a reason string for every file that
// gets no in-app preview, so the UI can offer Download instead of a dead end.

export type PreviewKind = "image" | "text" | "audio" | "video";

/** Text previews are capped at 256 KB — anything larger is not previewed. */
export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;

/**
 * Every rendered preview (image, audio, video) is capped at 48 MB. The whole
 * payload arrives as base64 JSON before it becomes a Blob, so a larger file
 * would be decoded in memory on a phone to be shown by a renderer that cannot
 * buffer it from the network anyway. Images are capped too: the browser scales
 * them, but it still has to hold the decoded bytes. Over the cap the file gets
 * the Download fallback — but only while the transport can actually serve it.
 */
export const MEDIA_PREVIEW_MAX_BYTES = 48 * 1024 * 1024;

/**
 * The browse-download transport cap, mirroring `MAX_BROWSE_BYTES` in
 * `packages/server/src/browse-jobs.ts`. `POST /browse/download` returns 400
 * above this, and both Preview and Download go through that one endpoint, so
 * over this size there is no in-app action that can deliver the bytes and the
 * UI must not claim otherwise.
 */
export const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

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

/**
 * Lowercased file extension (no dot), or "" when the name has none.
 */
export function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return "";
  return name.slice(idx + 1).toLowerCase();
}

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "ogv", "mov", "mkv"]);

/**
 * The MIME type to construct the preview Blob with.
 *
 * The browse-download endpoint returns bytes without a content type, so the
 * SPA has to state one, and it matters: an `<audio>`/`<video>` element given a
 * typeless Blob is at the browser's mercy (`canPlayType` on an empty type is
 * "maybe" at best and often renders nothing). Extension-derived, never
 * content-sniffed, because the bytes are the user's own files and the element
 * gets no execution rights either way.
 */
export function mimeTypeForName(name: string): string {
  const ext = extensionOf(name);
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    case "avif":
      return "image/avif";
    case "mp3":
      return "audio/mpeg";
    case "m4a":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    case "ogg":
    case "oga":
      return "audio/ogg";
    case "opus":
      return "audio/opus";
    case "wav":
      return "audio/wav";
    case "flac":
      return "audio/flac";
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "ogv":
      return "video/ogg";
    case "mov":
      return "video/quicktime";
    case "mkv":
      return "video/x-matroska";
    case "txt":
    case "md":
    case "log":
    case "csv":
    case "tsv":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

/**
 * What the viewer should do with a file, including WHY it will not preview it.
 *
 * The issue's acceptance is "at least the agreed initial preview formats render
 * safely in app; unsupported formats have a clear fallback" — so "no preview"
 * is a decided outcome with a sentence, not a silent `null`.
 */
export interface PreviewPlan {
  /** The renderer to use, or null when the file gets no in-app preview. */
  kind: PreviewKind | null;
  /** One sentence naming the limit that applies, for the download fallback. */
  reason: string | null;
  /** The bytes must be sniffed before rendering (extension-less text). */
  sniff: boolean;
  /**
   * Whether the Download fallback can actually fetch these bytes. Preview and
   * Download ride the same base64 `POST /browse/download`, so above
   * [DOWNLOAD_MAX_BYTES] there is no working download to offer either.
   */
  downloadable: boolean;
}

export function previewPlanFor(name: string, size: number): PreviewPlan {
  const ext = extensionOf(name);

  // The transport is the hard floor. Above it the server rejects the request
  // outright, so there is neither a preview nor a download fallback to offer.
  if (size > DOWNLOAD_MAX_BYTES) {
    return { kind: null, reason: TRANSFER_TOO_LARGE_REASON, sniff: false, downloadable: false };
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    return size > MEDIA_PREVIEW_MAX_BYTES
      ? { kind: null, reason: MEDIA_TOO_LARGE_REASON, sniff: false, downloadable: true }
      : { kind: "image", reason: null, sniff: false, downloadable: true };
  }

  if (AUDIO_EXTENSIONS.has(ext)) {
    return size > MEDIA_PREVIEW_MAX_BYTES
      ? { kind: null, reason: MEDIA_TOO_LARGE_REASON, sniff: false, downloadable: true }
      : { kind: "audio", reason: null, sniff: false, downloadable: true };
  }

  if (VIDEO_EXTENSIONS.has(ext)) {
    return size > MEDIA_PREVIEW_MAX_BYTES
      ? { kind: null, reason: MEDIA_TOO_LARGE_REASON, sniff: false, downloadable: true }
      : { kind: "video", reason: null, sniff: false, downloadable: true };
  }

  if (size > TEXT_PREVIEW_MAX_BYTES && TEXT_EXTENSIONS.has(ext)) {
    return { kind: null, reason: TEXT_TOO_LARGE_REASON, sniff: false, downloadable: true };
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    return { kind: "text", reason: null, sniff: false, downloadable: true };
  }

  // No recognised extension: extension-less files are the common "README" /
  // "LICENSE" / ".bashrc" case — optimistically text, confirmed by sniffing
  // the first bytes once fetched (see sniffPreviewKind). The cap applies to
  // them too, because their bytes are what would have to be decoded.
  if (ext === "") {
    return size > TEXT_PREVIEW_MAX_BYTES
      ? { kind: null, reason: TEXT_TOO_LARGE_REASON, sniff: false, downloadable: true }
      : { kind: "text", reason: null, sniff: true, downloadable: true };
  }

  return { kind: null, reason: UNSUPPORTED_REASON, sniff: false, downloadable: true };
}

const MEDIA_TOO_LARGE_REASON =
  "This file is larger than the 48 MB in-app preview limit; download it to open it outside LamaSync.";
const TEXT_TOO_LARGE_REASON =
  "This file is larger than the 256 KB text preview limit; download it to open it outside LamaSync.";
const UNSUPPORTED_REASON =
  "There is no in-app viewer for this file type; download it to open it outside LamaSync.";
const TRANSFER_TOO_LARGE_REASON =
  "This file is larger than the 64 MB transfer limit, so it cannot be previewed or downloaded here.";

/**
 * Classify a file for preview from its name + size alone (synchronous, no
 * bytes needed). Kept because it is the shape the entries table wants; the
 * decision itself lives in [previewPlanFor].
 */
export function previewKindForName(name: string, size: number): PreviewKind | null {
  return previewPlanFor(name, size).kind;
}

// Magic-byte prefixes for the image types we promise in the UI.
const IMAGE_SIGNATURES: Array<{ kind: "image"; bytes: number[] }> = [
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
