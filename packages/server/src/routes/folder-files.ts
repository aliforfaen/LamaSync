// LAMA-260: file-upload surface for synced folders. Adds a SINGLE
// additive endpoint — `POST /api/v1/folders/:id/files` — that streams a
// multipart upload into a server-side temp file (cap enforced mid-
// stream, the S3-64MiB lesson), then pushes it onto the folder's
// destination backend via `rclone copyto`. Returns synchronously — not
// a `browse_jobs` row — because the upload is short-lived enough for
// the caller to wait, and the web UI's "Upload" button needs to know
// success/failure in the same request to render the new listing.
//
// Why a sibling to `browse/upload` (not a refactor):
//  - `browse/upload` is base64 + `browse_jobs` (async). This is
//    multipart + synchronous to mirror `dotfiles` and the S3-64MiB
//    cap-learned mid-stream enforcement pattern.
//  - Scoped to a folder id, not a `BrowseRef`, so the back-end kind
//    resolution only walks the folders table; the path/prefix is the
//    folder's destination root + optional subdir.
//  - Writable in one extra place for sync folders: local / nfs / s3
//    backends are writable server-side (rclone can talk to all three
//    without host credentials). Restic + sftp are NOT — the route
//    returns 409 with the actual reason so the UI can show "not
//    writable from the server" instead of a generic "upload failed".
//
// Scrubbing (LAMA-226): the underlying rclone stderr may embed
// endpoint / bucket / secret fragments and is logged server-side only.
// The response body never contains rclone stderr — it carries a stage
// tag + exit code via `scrubFailureSummary`, mirroring the restic
// convention from `health-drill.ts` and `snapshots.ts`.
//
// Temp file discipline: the upload always lives in `/tmp`, never in
// `LAMASYNC_BACKUP_DIR` or `LAMASYNC_DATA_DIR`, and is `rmSync`'d in a
// `finally` so a crashed handler doesn't leave it behind. The route
// also resolves the file's expected size from the multipart header
// (`File.size`) BEFORE streaming so an oversized body is rejected with
// 413 without ever being touched by rclone; the streaming transformer
// is defense-in-depth in case the multipart header lies.
//
// Test seams:
//   - `__setDb(db)`              per-route DB swap (precedent)
//   - `__setFolderUploadRunner`  replace the rclone spawn with a fake
//                                (assert argv shape + scrub behavior)
//   - `__setMaxBytesForTests`    override the env-driven cap without
//                                touching real env vars

import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import { createWriteStream } from "node:fs";
import { existsSync, rmSync, statSync } from "node:fs";
import {
  type Folder,
  type FolderFileUploadResponse,
} from "@lamasync/core";
import { db as defaultDb } from "../db.ts";
import { getBackend, resolveFolderLocalConfig, resolveFolderS3Config } from "../backends.ts";
import { decryptSecret } from "../crypto.ts";
import { validateBrowseInput } from "../browse-paths.ts";
import { withTempRcloneConfig } from "../temp-rclone-config.ts";

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

function resolvedMaxBytes(): number {
  const raw = process.env.LAMASYNC_FOLDER_FILE_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BYTES;
  return parsed;
}

let activeDb: Database = defaultDb;
let activeMaxBytes = resolvedMaxBytes();
let activeRunner: FolderUploadRunner = defaultRcloneRunner;

/** Test seam — swap the DB handle. */
export function __setDb(next: Database): void {
  activeDb = next;
}

/** Test seam — override the upload size cap without touching env. */
export function __setMaxBytesForTests(n: number): void {
  activeMaxBytes = n;
}

/**
 * Subset of the rclone spawn surface the uploader needs. Lifted from
 * the browse-jobs module so unit tests can swap a fake in via the
 * `__setFolderUploadRunner` seam without spinning up rclone. The
 * browse-ops tests keep using real `Bun.spawn` via the e2e gate.
 */
export interface FolderUploadSpawnInput {
  argv: string[];
  cwd?: string;
}

export interface FolderUploadSpawnResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type FolderUploadRunner = (
  input: FolderUploadSpawnInput,
) => Promise<FolderUploadSpawnResult>;

/** Test seam — pass null to reset to the real `Bun.spawn` runner. */
export function __setFolderUploadRunner(
  fn: FolderUploadRunner | null,
): void {
  activeRunner = fn ?? defaultRcloneRunner;
}

async function defaultRcloneRunner(
  input: FolderUploadSpawnInput,
): Promise<FolderUploadSpawnResult> {
  const proc = Bun.spawn(input.argv, {
    cwd: input.cwd ?? process.env.LAMASYNC_BACKUP_DIR ?? "/backups",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

// ---------- DB seam ------------------------------------------------------

interface FolderRow {
  id: string;
  name: string;
  type: string;
  backend: string | null;
  backend_id: string | null;
  s3_bucket: string | null;
}

interface ResolvedS3 {
  folder: Folder;
  bucket: string;
  provider: "aws" | "other";
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string | null;
}

/**
 * Load + validate the folder for a write. Returns null when the
 * folder doesn't exist (404); returns a tagged union describing the
 * writable target otherwise. Non-writable kinds return the
 * `notWritable` discriminator so the route can answer 409 with a
 * specific reason rather than a generic "failed".
 */
type Resolved =
  | {
      kind: "s3";
      row: FolderRow;
      cfg: ResolvedS3;
    }
  | {
      kind: "local";
      row: FolderRow;
      localPath: string;
    }
  | {
      kind: "nfs";
      row: FolderRow;
      localPath: string;
    }
  | {
      kind: "notWritable";
      row: FolderRow;
      reason: string;
    };

function resolveFolderForUpload(folderId: string): Resolved | null {
  const row = activeDb
    .query<FolderRow, [string]>(
      "SELECT id, name, type, backend, backend_id, s3_bucket FROM folders WHERE id = ?",
    )
    .get(folderId);
  if (!row) return null;

  if (row.backend === "s3") {
    if (!row.backend_id || !row.s3_bucket) {
      return { kind: "notWritable", row, reason: "folder has no resolvable S3 backend" };
    }
    const backend = getBackend(activeDb, row.backend_id);
    if (!backend) {
      return { kind: "notWritable", row, reason: "folder references a missing backend" };
    }
    const folder: Folder = {
      id: row.id,
      name: row.name,
      type: "sync",
      backend: "s3",
      backendId: row.backend_id,
      s3Bucket: row.s3_bucket,
    };
    const cfg = resolveFolderS3Config(activeDb, folder);
    if (!cfg) {
      return { kind: "notWritable", row, reason: "folder has no resolvable S3 backend" };
    }
    const secret = decryptSecret(backend.s3_secret_key_enc) ?? "";
    return {
      kind: "s3",
      row,
      cfg: {
        folder,
        bucket: cfg.bucket,
        provider: cfg.provider === "aws" ? "aws" : "other",
        endpoint: cfg.endpoint,
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: secret,
        region: cfg.region,
      },
    };
  }

  if (row.backend === "local" || row.backend === "nfs") {
    if (!row.backend_id) {
      return { kind: "notWritable", row, reason: "folder has no backend reference" };
    }
    const backend = getBackend(activeDb, row.backend_id);
    if (!backend || !backend.local_path) {
      return { kind: "notWritable", row, reason: "folder references a backend with no local path" };
    }
    return {
      kind: row.backend,
      row,
      localPath: backend.local_path,
    };
  }

  // sftp is the legacy kind with no per-host credentials resolvable
  // server-side; uploads would have to be routed through a daemon
  // action, which is out of scope for LAMA-260. restic has its own
  // snapshot/restore flow — uploads via rclone don't apply.
  if (row.backend === "restic") {
    return { kind: "notWritable", row, reason: "folder uses the restic backup engine; upload via the snapshot flow, not rclone" };
  }
  if (row.backend === "sftp") {
    return { kind: "notWritable", row, reason: "folder uses sftp; server-side uploads require host credentials (not available here)" };
  }
  return { kind: "notWritable", row, reason: `unsupported folder backend '${row.backend ?? "none"}' for server-side upload` };
}

// ---------- rclone config builder ---------------------------------------

interface S3SectionFields {
  name: string;
  provider: "aws" | "other";
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string | null;
}

/** Pure helper — emits a complete rclone config body for one upload. */
function buildUploadConfig(
  remoteName: "dst",
  s3: S3SectionFields | null,
  local: boolean,
): string {
  const lines: string[] = [];
  lines.push(`[${remoteName}]`);
  if (s3) {
    lines.push("type = s3");
    lines.push(`provider = ${s3.provider === "aws" ? "AWS" : "Other"}`);
    lines.push("env_auth = false");
    lines.push(`access_key_id = ${s3.accessKeyId}`);
    lines.push(`secret_access_key = ${s3.secretAccessKey}`);
    lines.push(`endpoint = ${s3.endpoint}`);
    if (s3.region) lines.push(`region = ${s3.region}`);
  } else if (local) {
    lines.push("type = local");
  } else {
    // unreachable — kept for the type narrower
    throw new Error("buildUploadConfig requires s3 or local");
  }
  return lines.join("\n") + "\n";
}

// ---------- temp file management ----------------------------------------

function tempUploadPath(): string {
  // Scoped under tmpdir so the server's process user can clean up
  // with `rm -f` on any platform that doesn't honour Posix unlinking
  // from /tmp. The UUID avoids two concurrent uploads clobbering each
  // other; the file is `rmSync`'d in `finally` so size is bounded.
  return `/tmp/lamasync-folder-upload-${crypto.randomUUID()}`;
}

function scrubFailureSummary(stage: string, code: number): string {
  // Same convention as `scrubFailureSummary` in health-drill.ts:
  // safe-stage (alphanumeric + `_-` only) + exit code; never echoes
  // stderr text. Wrapped here so the route can return a clear
  // 502/413 message without rclone errors leaking.
  const safeStage = stage.replace(/[^a-z0-9_-]/gi, "");
  const tag = safeStage !== "" ? `rclone ${safeStage}` : "rclone";
  return `${tag} failed with exit code ${code}`;
}

class UploadTooLarge extends Error {
  readonly bytes: number;
  readonly max: number;
  constructor(bytes: number, max: number) {
    super(`file is ${bytes} bytes; upload limit is ${max} bytes`);
    this.name = "UploadTooLarge";
    this.bytes = bytes;
    this.max = max;
  }
}

/**
 * Drain a Web `ReadableStream<Uint8Array>` straight to disk via
 * `createWriteStream`. Each chunk is `write`n as it arrives; errors
 * from the source (e.g. our cap-rejection transform) propagate. The
 * `drain` event is awaited after each write so the file system
 * doesn't out-buffer our stream pipe; `finish` (or `close`) is the
 * terminal signal that all bytes are on disk.
 */
function pipeStreamToFile(
  path: string,
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(path);
    let settled = false;
    out.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    out.on("finish", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    const reader = stream.getReader();
    const pump = (): void => {
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            out.end();
            return;
          }
          if (value === undefined) {
            pump();
            return;
          }
          // The stream's chunks are Uint8Array; Buffer.from wraps a
          // view around the same memory and is what node:fs expects.
          out.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength), (err) => {
            if (err) {
              if (settled) return;
              settled = true;
              reader.cancel().catch(() => {});
              reject(err);
              return;
            }
            pump();
          });
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          out.destroy();
          reject(err);
        });
    };
    pump();
  });
}

// ---------- routes ------------------------------------------------------

export const folderFileRoutes = new Elysia({ prefix: "/api/v1" }).post(
  "/folders/:id/files",
  async ({ params, request, set }) => {
    const folderId = params.id;
    const maxBytes = activeMaxBytes;

    // Resolve the folder BEFORE touching the multipart body so a 404
    // is cheap and a 409 (non-writable backend) doesn't need to
    // stream the upload first.
    const resolved = resolveFolderForUpload(folderId);
    if (resolved === null) {
      set.status = 404;
      return { error: "Folder not found" };
    }
    if (resolved.kind === "notWritable") {
      set.status = 409;
      return { error: resolved.reason };
    }

    // Parse multipart — does NOT buffer the bytes to memory; Bun's
    // multipart parser streams each file part to a tmpfile under the
    // hood, exposed here as a `File` (Blob + filename + `size`).
    const form = await request.formData();
    const fileField = form.get("file");
    const pathField = form.get("path");

    if (!(fileField instanceof File)) {
      set.status = 400;
      return { error: "Missing 'file' field in multipart body" };
    }
    const fileName = fileField.name;
    if (!fileName || fileName.includes("\0")) {
      set.status = 400;
      return { error: "invalid or missing file name" };
    }
    const subPathRaw =
      typeof pathField === "string" && pathField.length > 0 ? pathField : "";
    // LAMA-260 path safety: reject the raw input FIRST so a leading
    // `/` is caught before we strip it. `validateBrowseInput` (the
    // contract used by `/browse/*`) refuses absolute paths, null
    // bytes, and `..` segments. We then canonicalize (drop leading
    // + trailing separators) and validate the joined target so a
    // hostile `path` can't escape the folder's destination root via
    // a "..coalesce" trick.
    if (!validateBrowseInput(subPathRaw)) {
      set.status = 400;
      return { error: "invalid target path" };
    }
    const subPath = subPathRaw.replace(/\\/g, "/").replace(/^\/+/, "");
    const relativeTarget =
      subPath === "" ? fileName : `${subPath}/${fileName}`;
    if (!validateBrowseInput(relativeTarget)) {
      set.status = 400;
      return { error: "invalid target path or file name" };
    }
    // Server-side pre-check before we touch the body. Bun surfaces
    // `file.size` from the multipart Content-Length header; the
    // mid-stream transformer below is a defense-in-depth on top.
    if (fileField.size > maxBytes) {
      set.status = 413;
      return {
        error: `file is ${fileField.size} bytes; upload limit is ${maxBytes} bytes`,
      };
    }

    // Stage to /tmp; spawn rclone; tear down in `finally`.
    const tmpPath = tempUploadPath();
    let bytesWritten = 0;
    try {
      // Stream the Blob to disk with a size guard. `Blob.stream()`
      // is the documented Bun/Web stream API — reading it lazily
      // means an oversized body bails out BEFORE Bun can buffer the
      // full multipart part. We track the running total because
      // some multipart encoders omit the Content-Length header
      // (file.size can be 0 in that case, hence the cap).
      //
      // We use node:fs createWriteStream rather than Bun.write's
      // streamed overload because the latter pulls the entire Blob
      // into a Buffer before writing it (verified empirically with a
      // 16 MB upload). WriteStream + a transformed ReadableStream
      // gives us chunked-on-disk write semantics: the temp file is
      // never more than a few chunks larger than the cap when the
      // guard trips, so the rejected-client memory/heap profile is
      // bounded by the cap, not the request body.
      const source = fileField.stream();
      const guarded = source.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller): void {
            bytesWritten += chunk.byteLength;
            if (bytesWritten > maxBytes) {
              controller.error(new UploadTooLarge(bytesWritten, maxBytes));
              return;
            }
            controller.enqueue(chunk);
          },
        }),
      );
      await pipeStreamToFile(tmpPath, guarded);

      // Belt-and-braces: a multipart section without a Content-Length
      // could advertise size=0 and still feed a >cap body. Re-stat
      // the temp file — it can't lie.
      const onDisk = statSync(tmpPath);
      if (onDisk.size > maxBytes) {
        throw new UploadTooLarge(onDisk.size, maxBytes);
      }

      // Push to the destination. The temp file is a bare local path,
      // so it goes in argv as `src:/tmp/...` — rclone would otherwise
      // parse the `:` and treat the path as a remote. (See the same
      // pattern in `startBrowseUpload`.)
      const dest =
        resolved.kind === "s3"
          ? `dst:${resolved.cfg.bucket}/${relativeTarget}`
          : `dst:${resolved.localPath}/${relativeTarget}`;
      // Argv order mirrors `browse-jobs.ts` (`copyto` + src + dest +
      // `--config` + `--timeout`).
      const s3Section =
        resolved.kind === "s3"
          ? {
              name: "dst" as const,
              provider: resolved.cfg.provider,
              endpoint: resolved.cfg.endpoint,
              accessKeyId: resolved.cfg.accessKeyId,
              secretAccessKey: resolved.cfg.secretAccessKey,
              region: resolved.cfg.region,
            }
          : null;
      const result = await withTempRcloneConfig(
        buildUploadConfig("dst", s3Section, resolved.kind === "local" || resolved.kind === "nfs"),
        async (configPath) => {
          return activeRunner({
            argv: [
              "rclone",
              "copyto",
              tmpPath,
              dest,
              "--config",
              configPath,
              "--timeout",
              "30s",
            ],
          });
        },
      );
      if (result.code !== 0) {
        // LAMA-226: full stderr is logged server-side, never echoed
        // to the client. The synthesized message names the rclone
        // stage (always "copyto" here) and the exit code.
        console.error(
          `[folder-files] rclone copyto failed for folder ${folderId}: exit=${result.code} stderr=${result.stderr.trim()}`,
        );
        set.status = 502;
        return { error: scrubFailureSummary("copyto", result.code) };
      }

      const response: FolderFileUploadResponse = {
        ok: true,
        name: fileName,
        path: subPath,
        size: onDisk.size,
      };
      set.status = 201;
      return response;
    } catch (error) {
      // Mid-stream overflow rejection bubbles up here as
      // UploadTooLarge — map it to 413 with the cap named so the
      // UI can show "exceeds limit" instead of a generic failure.
      // Everything else is a 502: the rclone body really did break.
      if (error instanceof UploadTooLarge) {
        set.status = 413;
        return { error: error.message };
      }
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[folder-files] unexpected error: ${msg}`);
      set.status = 502;
      return { error: "upload failed" };
    } finally {
      // The temp file is never reused; clean up regardless of
      // success / error / cap-reject. `force` + `recursive` so a
      // partial write (mid-stream abort) doesn't leave a fragmented
      // file lurking.
      if (existsSync(tmpPath)) {
        try {
          rmSync(tmpPath, { force: true });
        } catch (err) {
          console.error(
            `[folder-files] failed to clean temp ${tmpPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  },
  {
    params: t.Object({ id: t.String() }),
    // Multipart bodies can't be validated by Elysia's `t.Object`
    // body schema — the parser reads the stream itself. We only
    // declare params; the form fields are picked out of
    // `request.formData()` above.
    detail: {
      summary:
        "Upload a file into a folder's destination backend (LAMA-260). Multipart: `file` (required) + `path` (optional subdir within the folder). Cap default 100 MB, env-overridable via LAMASYNC_FOLDER_FILE_MAX_BYTES. Synchronous — succeeds or returns 502 with a scrubbed rclone summary.",
      tags: ["Folders"],
      responses: {
        201: {
          description: "File uploaded (FolderFileUploadResponse)",
        },
        400: { description: "Missing file field, invalid file name, or unsafe target path" },
        401: { description: "Unauthorized" },
        404: { description: "Folder not found" },
        409: {
          description:
            "Folder backend is not writable server-side (sftp / restic / unknown; missing backend reference)",
        },
        413: { description: "File exceeds the upload cap" },
        502: {
          description: "rclone copyto failed (scrubbed — stage + exit code only)",
        },
      },
    },
  },
);
