import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { db as defaultDb } from "../db.ts";
import type { BrowseEntry, BrowseResponse, BrowseRef, Folder } from "@lamasync/core";
import { resolveBrowsePath, statEntry, validateBrowseInput } from "../browse-paths.ts";
import { listS3Objects, S3ListObjectsError } from "../s3-list.ts";
import { resolveFolderS3Config } from "../backends.ts";
import {
  downloadBrowseFile,
  listBrowseJobs,
  startBrowseCopyMove,
  startBrowseDelete,
  startBrowseMkdir,
  startBrowseRename,
  startBrowseUpload,
} from "../browse-jobs.ts";
// LAMA-226 P1-9: write-op bodies share a single validated `ref` shape.
// The Elysia-validated body is used directly (no `as` casts) so the type
// system proves we never feed untrusted input to rclone/DB helpers.
const browseRefSchema = t.Object({
  kind: t.Union([t.Literal("local"), t.Literal("s3")]),
  folderId: t.Optional(t.Union([t.String(), t.Null()])),
  path: t.String(),
});

let activeDb: Database = defaultDb;
let listS3 = listS3Objects;

export function __setDb(next: Database): void {
  activeDb = next;
}

export function __setListS3Impl(impl: typeof listS3Objects): void {
  listS3 = impl;
}

interface FolderRow {
  id: string;
  name: string;
  backend: string | null;
  backend_id: string | null;
  s3_bucket: string | null;
}

function rowToFolder(r: FolderRow): Folder {
  const backend = r.backend === "s3" || r.backend === "local" ? r.backend : "sftp";
  return {
    id: r.id,
    name: r.name,
    type: "sync" as const,
    backend,
    backendId: backend === "s3" ? r.backend_id : null,
    s3Bucket: r.s3_bucket,
  };
}

function getBackupRoot(): string {
  return process.env.LAMASYNC_BACKUP_DIR ?? "/backups";
}

function folderNameMap(): Map<string, string> {
  const rows = activeDb
    .query<{ id: string; name: string }, []>("SELECT id, name FROM folders")
    .all();
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.name, row.id);
  return map;
}

function isValidS3Path(input: string): boolean {
  if (input.includes("\0")) return false;
  if (input.startsWith("/")) return false;
  const segments = input.replace(/\\/g, "/").split("/").filter((s) => s !== "");
  return !segments.some((segment) => segment === "" || segment === "..");
}

/** Normalize a browse path into its canonical relative form (no leading /
 * trailing slashes, no duplicate separators, no "." segments). ".." is
 * impossible here — it is rejected before this runs. */
function canonicalRelativePath(input: string): string {
  return input
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .join("/");
}

export const browseRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/browse/local",
    ({ query, set }) => {
      const rawPath = query.path ?? "";
      // Safety first: traversal / absolute / null-byte / empty segments are
      // rejected with 400 before any filesystem access.
      if (!validateBrowseInput(rawPath)) {
        set.status = 400;
        return { error: "invalid path" };
      }

      const root = getBackupRoot();
      const normalized = rawPath.replace(/\\/g, "/");
      const target = rawPath === "" ? root : join(root, normalized);

      // Distinguish "does not exist" (404) from "rejected for safety" (400).
      let isDirectory = false;
      try {
        isDirectory = statSync(target).isDirectory();
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
          set.status = 404;
          return { error: "path not found" };
        }
        if (err instanceof Error && "code" in err && err.code === "ENOTDIR") {
          // A path segment resolves to a file (e.g. file.txt/sub).
          set.status = 400;
          return { error: "path is not a directory" };
        }
        // Unexpected fs failure (EACCES, EIO, …): log server-side, never
        // leak the raw error (it embeds absolute server paths) to the client.
        console.error(`[browse] stat failed for ${JSON.stringify(rawPath)}:`, err);
        set.status = 500;
        return { error: "failed to read path" };
      }
      if (!isDirectory) {
        set.status = 400;
        return { error: "path is not a directory" };
      }

      const resolved = resolveBrowsePath(root, rawPath);
      if (resolved === null) {
        // Unreachable after the stat above except for a symlink escaping the
        // root, which is a safety rejection.
        set.status = 400;
        return { error: "invalid path" };
      }

      let names: string[];
      try {
        names = readdirSync(resolved);
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOTDIR") {
          set.status = 400;
          return { error: "path is not a directory" };
        }
        console.error(`[browse] readdir failed for ${JSON.stringify(rawPath)}:`, err);
        set.status = 500;
        return { error: "failed to list directory" };
      }

      const namesMap = folderNameMap();
      const rootReal = realpathSync(getBackupRoot());
      const entries: BrowseEntry[] = names
        .map((name) => {
          const stat = statEntry(join(resolved, name));
          if (!stat) return null;
          const entry: BrowseEntry = {
            name,
            type: stat.type,
            size: stat.size,
            mtime: stat.mtime,
          };
          if (resolved === rootReal) {
            const folderId = namesMap.get(name);
            if (folderId) entry.folderId = folderId;
          }
          return entry;
        })
        .filter((entry): entry is BrowseEntry => entry !== null)
        .sort((a, b) => a.name.localeCompare(b.name));

      const response: BrowseResponse = {
        backend: "local",
        path: canonicalRelativePath(rawPath),
        entries,
      };
      return response;
    },
    {
      query: t.Object({ path: t.Optional(t.String()) }),
      detail: {
        summary: "Browse local backup directory",
        tags: ["Data Browser"],
        responses: {
          200: { description: "Directory listing" },
          400: { description: "Invalid path or path is not a directory" },
          404: { description: "Path not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/browse/s3",
    async ({ query, set }) => {
      const folderId = query.folderId ?? "";
      const rawPath = query.path ?? "";
      if (!folderId) {
        set.status = 400;
        return { error: "folderId is required" };
      }
      if (!isValidS3Path(rawPath)) {
        set.status = 400;
        return { error: "invalid path" };
      }
      const row = activeDb
        .query<FolderRow, [string]>(
          "SELECT id, name, backend, backend_id, s3_bucket FROM folders WHERE id = ?",
        )
        .get(folderId);
      if (!row) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      const folder = rowToFolder(row);
      // LAMA-222: S3 credentials come from the referenced Backend row;
      // the resolved config is only used to sign the listing request.
      const s3 = resolveFolderS3Config(activeDb, folder);
      if (!s3) {
        set.status = 400;
        return { error: "folder has no resolvable S3 backend" };
      }
      try {
        const listing = await listS3(s3, rawPath, 1000);
        const response: BrowseResponse = {
          backend: "s3",
          path: canonicalRelativePath(rawPath),
          entries: listing.entries.map((entry) => ({
            name: entry.name,
            type: entry.type,
            size: entry.size,
            mtime: entry.lastModified,
            folderId: folder.id,
          })),
        };
        return response;
      } catch (err) {
        if (err instanceof S3ListObjectsError) {
          // Don't leak the upstream S3 error body to the client.
          console.error(`[browse] S3 listing failed: ${err.message}`);
          set.status = 502;
          return { error: "S3 request failed" };
        }
        throw err;
      }
    },
    {
      query: t.Object({
        folderId: t.Optional(t.String()),
        path: t.Optional(t.String()),
      }),
      detail: {
        summary: "Browse an S3 folder by prefix",
        tags: ["Data Browser"],
        responses: {
          200: { description: "S3 object listing" },
          400: { description: "Invalid input" },
          404: { description: "Folder not found" },
          502: { description: "S3 request failed" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/browse/restic",
    () => {
      const rows = activeDb
        .query<
          {
            id: string;
            folder_id: string;
            host_id: string;
            snapshot_id: string;
            timestamp: number;
            paths: string;
            size_bytes: number | null;
            tags: string | null;
          },
          []
        >(
          "SELECT id, folder_id, host_id, snapshot_id, timestamp, paths, size_bytes, tags FROM restic_snapshots ORDER BY timestamp DESC",
        )
        .all();
      return rows.map((r) => ({
        id: r.id,
        folderId: r.folder_id,
        hostId: r.host_id,
        snapshotId: r.snapshot_id,
        timestamp: r.timestamp,
        paths: parseStringArray(r.paths),
        sizeBytes: r.size_bytes,
        tags: parseStringArray(r.tags),
      }));
    },
    {
      detail: {
        summary: "List restic snapshots (read-only browser view)",
        tags: ["Data Browser"],
        responses: {
          200: { description: "Snapshot list" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  // LAMA-226: Data Browser write operations. Each op runs as a browse_job
  // (status + progress, WS events) and appends an operation_log row when
  // terminal.
  .get(
    "/browse/jobs",
    ({ query }) => {
      const rawLimit = query.limit;
      const parsed =
        typeof rawLimit === "number"
          ? rawLimit
          : rawLimit
            ? Number.parseInt(rawLimit, 10)
            : 50;
      return listBrowseJobs(activeDb, Number.isFinite(parsed) ? parsed : 50);
    },
    {
      query: t.Object({ limit: t.Optional(t.Union([t.Number(), t.String()])) }),
      detail: {
        summary: "List recent Data Browser write jobs",
        tags: ["Data Browser"],
        responses: {
          200: { description: "Browse job list" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/browse/copy",
    async ({ body, set }) => {
      const { source, destination, names } = body;
      try {
        const result = await startBrowseCopyMove(
          activeDb,
          "copy",
          source,
          destination,
          names,
          sourceLabel(source),
        );
        if (result.busy) {
          set.status = 409;
          return { error: "destination busy — another operation is writing there" };
        }
        set.status = 201;
        return result.job;
      } catch (error) {
        return scrubWriteError(set, error, "copy");
      }
    },
    {
      body: t.Object({
        source: browseRefSchema,
        destination: browseRefSchema,
        names: t.Array(t.String()),
      }),
      detail: {
        summary: "Copy entries from one browse path to another",
        tags: ["Data Browser"],
        responses: {
          201: { description: "Job started" },
          400: { description: "Invalid input" },
          409: { description: "Destination busy" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/browse/move",
    async ({ body, set }) => {
      const { source, destination, names } = body;
      try {
        const result = await startBrowseCopyMove(
          activeDb,
          "move",
          source,
          destination,
          names,
          sourceLabel(source),
        );
        if (result.busy) {
          set.status = 409;
          return { error: "destination busy — another operation is writing there" };
        }
        set.status = 201;
        return result.job;
      } catch (error) {
        return scrubWriteError(set, error, "move");
      }
    },
    {
      body: t.Object({
        source: browseRefSchema,
        destination: browseRefSchema,
        names: t.Array(t.String()),
      }),
      detail: {
        summary: "Move entries (copy then delete source)",
        tags: ["Data Browser"],
        responses: {
          201: { description: "Job started" },
          400: { description: "Invalid input" },
          409: { description: "Destination busy" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/browse/delete",
    async ({ body, set }) => {
      const { ref, names } = body;
      try {
        const result = await startBrowseDelete(activeDb, ref, names, sourceLabel(ref));
        if (result.busy) {
          set.status = 409;
          return { error: "destination busy — another operation is writing there" };
        }
        set.status = 201;
        return result.job;
      } catch (error) {
        return scrubWriteError(set, error, "delete");
      }
    },
    {
      body: t.Object({
        ref: browseRefSchema,
        names: t.Array(t.String()),
      }),
      detail: {
        summary: "Delete entries (files + directories) from a browse path",
        tags: ["Data Browser"],
        responses: {
          201: { description: "Job started" },
          400: { description: "Invalid input" },
          409: { description: "Destination busy" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/browse/download",
    async ({ body, set }) => {
      const { ref, name } = body;
      if (!name) {
        set.status = 400;
        return { error: "name is required" };
      }
      try {
        const outcome = await downloadBrowseFile(activeDb, ref, name);
        if (!outcome.ok) {
          set.status = outcome.status;
          return { error: outcome.error };
        }
        return outcome.data;
      } catch (error) {
        return scrubWriteError(set, error, "download");
      }
    },
    {
      body: t.Object({
        ref: browseRefSchema,
        name: t.String(),
      }),
      detail: {
        summary: "Download a file (base64, <= 64 MiB) from a browse path",
        tags: ["Data Browser"],
        responses: {
          200: { description: "File content (base64)" },
          400: { description: "Invalid input, directory, or over the 64 MiB cap" },
          404: { description: "Entry not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/browse/rename",
    async ({ body, set }) => {
      const { ref, from, to } = body;
      if (!from || !to || from === to) {
        set.status = 400;
        return { error: "from and to are required and must differ" };
      }
      try {
        const job = await startBrowseRename(activeDb, ref, from, to, sourceLabel(ref));
        set.status = 201;
        return job;
      } catch (error) {
        return scrubWriteError(set, error, "rename");
      }
    },
    {
      body: t.Object({
        ref: browseRefSchema,
        from: t.String(),
        to: t.String(),
      }),
      detail: {
        summary: "Rename an entry in place",
        tags: ["Data Browser"],
        responses: {
          201: { description: "Job started" },
          400: { description: "Invalid input" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/browse/mkdir",
    async ({ body, set }) => {
      const { ref, name } = body;
      if (!name) {
        set.status = 400;
        return { error: "name is required" };
      }
      try {
        const job = await startBrowseMkdir(activeDb, ref, name, sourceLabel(ref));
        set.status = 201;
        return job;
      } catch (error) {
        return scrubWriteError(set, error, "mkdir");
      }
    },
    {
      body: t.Object({
        ref: browseRefSchema,
        name: t.String(),
      }),
      detail: {
        summary: "Create a directory at the current path",
        tags: ["Data Browser"],
        responses: {
          201: { description: "Job started" },
          400: { description: "Invalid input" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/browse/upload",
    async ({ body, set }) => {
      const { destination, name, content } = body;
      if (!name || typeof content !== "string" || content.length === 0) {
        set.status = 400;
        return { error: "name and base64 content are required" };
      }
      try {
        const job = await startBrowseUpload(
          activeDb,
          destination,
          name,
          content,
          sourceLabel(destination),
        );
        set.status = 201;
        return job;
      } catch (error) {
        return scrubWriteError(set, error, "upload");
      }
    },
    {
      body: t.Object({
        destination: browseRefSchema,
        name: t.String(),
        content: t.String(),
      }),
      detail: {
        summary: "Upload a small file (base64, <= 64 MiB) to a directory",
        tags: ["Data Browser"],
        responses: {
          201: { description: "Job started" },
          400: { description: "Invalid input" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

// hostId used for the operation_log audit row — the server is the actor for
// browse operations, so a stable synthetic id keeps the log uniform.
function sourceLabel(ref: BrowseRef): string {
  return ref.kind === "s3" ? (ref.folderId ?? "server") : "server";
}

/**
 * LAMA-226 P1-9: write-op failures must not leak the underlying rclone
 * stderr (it embeds bucket names, access key prefixes, and absolute local
 * paths). The job row carries the full error for the audit trail + UI
 * details; the API response returns only a stable, generic message tagged
 * with the operation type so the client can correlate with the listed job.
 */
function scrubWriteError(
  set: { status?: number | string },
  error: unknown,
  op: string,
): { error: string } {
  const fullMessage = error instanceof Error ? error.message : String(error);
  console.error(`[browse/${op}] ${fullMessage}`);
  set.status = 400;
  return { error: `${op} failed` };
}
