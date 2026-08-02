import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { db as defaultDb } from "../db.ts";
import type { BrowseEntry, BrowseResponse, Folder } from "@lamasync/core";
import { resolveBrowsePath, statEntry, validateBrowseInput } from "../browse-paths.ts";
import { listS3Objects, S3ListObjectsError } from "../s3-list.ts";
import { resolveFolderS3Config } from "../backends.ts";

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
