import { Elysia, t } from "elysia";
import { mkdirSync, statSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { db as defaultDb } from "../db.ts";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { DotfileManifest, DotfileVersion } from "@lamasync/core";

const BACKUP_DIR = process.env.LAMASYNC_BACKUP_DIR || "/backups";
const GLOBAL_HOST_ID = "_global";

let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

interface VersionRow {
  id: string;
  manifest_id: string;
  timestamp: number;
  tarball_path: string;
  size_bytes: number | null;
  checksum: string | null;
  description: string | null;
}

interface ManifestRow {
  id: string;
  host_id: string;
  app_name: string;
  paths: string;
  excludes: string | null;
  schedule: string | null;
  instructions: string | null;
  last_sync_at: number | null;
  last_sync_direction: string | null;
  original_uploader_host_id: string | null;
}

function rowToVersion(r: VersionRow): DotfileVersion {
  return {
    id: r.id,
    manifestId: r.manifest_id,
    timestamp: r.timestamp,
    tarballPath: r.tarball_path,
    sizeBytes: r.size_bytes,
    checksum: r.checksum,
    description: r.description,
  };
}

function rowToManifest(r: ManifestRow): DotfileManifest {
  let paths: string[] = [];
  let excludes: string[] | null = null;
  try {
    paths = JSON.parse(r.paths);
  } catch {
    paths = [];
  }
  if (r.excludes) {
    try {
      excludes = JSON.parse(r.excludes);
    } catch {
      excludes = [];
    }
  }
  return {
    id: r.id,
    hostId: r.host_id,
    appName: r.app_name,
    paths,
    excludes,
    schedule: r.schedule,
    instructions: r.instructions,
    lastSyncAt: r.last_sync_at,
    lastSyncDirection: (r.last_sync_direction as DotfileManifest["lastSyncDirection"]) ?? null,
    originalUploaderHostId: r.original_uploader_host_id,
  };
}

function parsePaths(input: unknown): string[] {
  if (Array.isArray(input)) return input.filter((p): p is string => typeof p === "string");
  if (typeof input === "string" && input.length > 0) return [input];
  return [];
}

async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Find a manifest for this (host, appName) or create one with empty paths. */
function ensureManifest(appName: string, hostId: string): string | null {
  const existing = activeDb
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM dotfile_manifests WHERE host_id = ? AND app_name = ?",
    )
    .get(hostId, appName);
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  try {
    activeDb.run(
      "INSERT INTO dotfile_manifests (id, host_id, app_name, paths) VALUES (?, ?, ?, ?)",
      [id, hostId, appName, JSON.stringify([])],
    );
    return id;
  } catch {
    return null;
  }
}

export const dotfilesRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/dotfiles/manifests",
    ({ query }) => {
      const hostId = (query as { hostId?: string }).hostId;
      const globalRows = activeDb
        .query<ManifestRow, [string]>(
          "SELECT id, host_id, app_name, paths, excludes, schedule, instructions, last_sync_at, last_sync_direction, original_uploader_host_id FROM dotfile_manifests WHERE host_id = ?",
        )
        .all(GLOBAL_HOST_ID);
      const byApp = new Map(globalRows.map((r) => [r.app_name, r]));
      if (hostId && hostId !== GLOBAL_HOST_ID) {
        const hostRows = activeDb
          .query<ManifestRow, [string]>(
            "SELECT id, host_id, app_name, paths, excludes, schedule, instructions, last_sync_at, last_sync_direction, original_uploader_host_id FROM dotfile_manifests WHERE host_id = ?",
          )
          .all(hostId);
        for (const r of hostRows) {
          byApp.set(r.app_name, r);
        }
      }
      return Array.from(byApp.values()).map(rowToManifest);
    },
    {
      query: t.Object({
        hostId: t.Optional(t.String()),
      }),
      detail: {
        summary: "List effective dotfile manifests for a host (global + overrides)",
        tags: ["Dotfiles"],
        responses: {
          200: { description: "Manifest list" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/dotfiles/manifests",
    ({ body, set }) => {
      const hostId = body.hostId ?? GLOBAL_HOST_ID;
      const id = crypto.randomUUID();
      const paths = parsePaths(body.paths);
      const excludes = parsePaths(body.excludes);
      try {
        activeDb.run(
          "INSERT INTO dotfile_manifests (id, host_id, app_name, paths, excludes, schedule, instructions, last_sync_at, last_sync_direction, original_uploader_host_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [id, hostId, body.appName, JSON.stringify(paths), JSON.stringify(excludes), body.schedule ?? null, body.instructions ?? null, null, null, null],
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set.status = 409;
        return { error: `Failed to create manifest: ${message}` };
      }
      const row = activeDb
        .query<ManifestRow, [string]>(
          "SELECT id, host_id, app_name, paths, excludes, schedule, instructions, last_sync_at, last_sync_direction, original_uploader_host_id FROM dotfile_manifests WHERE id = ?",
        )
        .get(id);
      set.status = 201;
      return rowToManifest(row!);
    },
    {
      body: t.Object({
        appName: t.String(),
        paths: t.Union([t.Array(t.String()), t.String()]),
        excludes: t.Optional(t.Union([t.Array(t.String()), t.String(), t.Null()])),
        schedule: t.Optional(t.Union([t.String(), t.Null()])),
        instructions: t.Optional(t.Union([t.String(), t.Null()])),
        hostId: t.Optional(t.String()),
      }),
      detail: {
        summary: "Create a dotfile manifest",
        tags: ["Dotfiles"],
        responses: {
          201: { description: "Manifest created" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .put(
    "/dotfiles/manifests/:id",
    ({ params, body, set }) => {
      const existing = activeDb
        .query<{ id: string }, [string]>("SELECT id FROM dotfile_manifests WHERE id = ?")
        .get(params.id);
      if (!existing) {
        set.status = 404;
        return { error: "Manifest not found" };
      }
      const updates: string[] = [];
      const values: SQLQueryBindings[] = [];
      if (body.appName !== undefined) {
        updates.push("app_name = ?");
        values.push(body.appName);
      }
      if (body.paths !== undefined) {
        updates.push("paths = ?");
        values.push(JSON.stringify(parsePaths(body.paths)));
      }
      if (body.excludes !== undefined) {
        updates.push("excludes = ?");
        values.push(JSON.stringify(parsePaths(body.excludes)));
      }
      if ("schedule" in body) {
        updates.push("schedule = ?");
        values.push(body.schedule ?? null);
      }
      if ("instructions" in body) {
        updates.push("instructions = ?");
        values.push(body.instructions ?? null);
      }
      if (updates.length === 0) {
        set.status = 400;
        return { error: "No fields to update" };
      }
      activeDb.run(
        `UPDATE dotfile_manifests SET ${updates.join(", ")} WHERE id = ?`,
        [...values, params.id],
      );
      const row = activeDb
        .query<ManifestRow, [string]>(
          "SELECT id, host_id, app_name, paths, excludes, schedule, instructions, last_sync_at, last_sync_direction, original_uploader_host_id FROM dotfile_manifests WHERE id = ?",
        )
        .get(params.id);
      return rowToManifest(row!);
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        appName: t.Optional(t.String()),
        paths: t.Optional(t.Union([t.Array(t.String()), t.String()])),
        excludes: t.Optional(t.Union([t.Array(t.String()), t.String(), t.Null()])),
        schedule: t.Optional(t.Union([t.String(), t.Null()])),
        instructions: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: {
        summary: "Update a dotfile manifest",
        tags: ["Dotfiles"],
        responses: {
          200: { description: "Manifest updated" },
          404: { description: "Not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .delete(
    "/dotfiles/manifests/:id",
    ({ params, set }) => {
      const existing = activeDb
        .query<{ id: string }, [string]>("SELECT id FROM dotfile_manifests WHERE id = ?")
        .get(params.id);
      if (!existing) {
        set.status = 404;
        return { error: "Manifest not found" };
      }
      activeDb.run("DELETE FROM dotfile_versions WHERE manifest_id = ?", [params.id]);
      activeDb.run("DELETE FROM dotfile_manifests WHERE id = ?", [params.id]);
      set.status = 204;
      return null;
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary: "Delete a dotfile manifest and its versions",
        tags: ["Dotfiles"],
        responses: {
          204: { description: "Manifest removed" },
          404: { description: "Not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/dotfiles",
    ({ query }) => {
      const hostId = (query as { hostId?: string }).hostId;
      if (!hostId) {
        return [];
      }
      const rows = activeDb
        .query<VersionRow, [string]>(
          `SELECT v.id, v.manifest_id, v.timestamp, v.tarball_path, v.size_bytes, v.checksum, v.description
           FROM dotfile_versions v
           WHERE v.manifest_id IN (SELECT id FROM dotfile_manifests WHERE host_id = ?)
           ORDER BY v.timestamp DESC`,
        )
        .all(hostId);
      return rows.map(rowToVersion);
    },
    {
      query: t.Object({
        hostId: t.Optional(t.String()),
      }),
      detail: {
        summary: "List dotfile versions for all apps owned by a host",
        tags: ["Dotfiles"],
        responses: {
          200: { description: "Version list for the host (empty when hostId omitted)" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/dotfiles/:appName",
    ({ params }) => {
      const rows = activeDb
        .query<VersionRow, [string]>(
          `SELECT v.id, v.manifest_id, v.timestamp, v.tarball_path, v.size_bytes, v.checksum, v.description
           FROM dotfile_versions v
           JOIN dotfile_manifests m ON m.id = v.manifest_id
           WHERE m.app_name = ?
           ORDER BY v.timestamp DESC`,
        )
        .all(params.appName);
      return rows.map(rowToVersion);
    },
    {
      params: t.Object({ appName: t.String() }),
      detail: {
        summary: "List versions of a dotfile app",
        tags: ["Dotfiles"],
        responses: {
          200: { description: "Version list" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/dotfiles/:appName",
    async ({ params, request, set }) => {
      const form = await request.formData();
      const hostIdRaw = form.get("hostId");
      const hostId =
        typeof hostIdRaw === "string" && hostIdRaw.length > 0 ? hostIdRaw : GLOBAL_HOST_ID;
      const uploaderHostIdRaw = form.get("uploaderHostId");
      const uploaderHostId =
        typeof uploaderHostIdRaw === "string" && uploaderHostIdRaw.length > 0
          ? uploaderHostIdRaw
          : hostId;
      const manifestId = ensureManifest(params.appName, hostId);
      if (!manifestId) {
        set.status = 500;
        return { error: "Failed to ensure manifest" };
      }
      const file = form.get("tarball");
      if (!(file instanceof File)) {
        set.status = 400;
        return { error: "Missing 'tarball' field in multipart body" };
      }

      const descriptionRaw = form.get("description");
      const description =
        typeof descriptionRaw === "string" && descriptionRaw.length > 0
          ? descriptionRaw
          : null;

      const appDir = join(BACKUP_DIR, "dotfiles", params.appName);
      mkdirSync(appDir, { recursive: true });

      const timestamp = Date.now();
      const filename = `${timestamp}.tar.gz`;
      const fullPath = join(appDir, filename);
      const relPath = join("dotfiles", params.appName, filename);

      const buf = Buffer.from(await file.arrayBuffer());
      await Bun.write(fullPath, buf);
      const checksum = await sha256Hex(file);

      const id = crypto.randomUUID();
      activeDb.run(
        `INSERT INTO dotfile_versions
           (id, manifest_id, timestamp, tarball_path, size_bytes, checksum, description)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, manifestId, timestamp, relPath, buf.length, checksum, description],
      );

      // Track deployment metadata on the manifest.
      activeDb.run(
        `UPDATE dotfile_manifests
         SET last_sync_at = ?, last_sync_direction = ?, original_uploader_host_id = COALESCE(original_uploader_host_id, ?)
         WHERE id = ?`,
        [timestamp, "upload", uploaderHostId, manifestId],
      );

      const row = activeDb
        .query<VersionRow, [string]>(
          "SELECT id, manifest_id, timestamp, tarball_path, size_bytes, checksum, description FROM dotfile_versions WHERE id = ?",
        )
        .get(id);

      set.status = 201;
      return rowToVersion(row!);
    },
    {
      params: t.Object({ appName: t.String() }),
      detail: {
        summary: "Upload a new dotfile tarball version (multipart)",
        tags: ["Dotfiles"],
        responses: {
          201: { description: "Version created" },
          400: { description: "Bad request" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/dotfiles/:appName/:version",
    ({ params, set }) => {
      const row = activeDb
        .query<VersionRow, [string]>(
          "SELECT id, manifest_id, timestamp, tarball_path, size_bytes, checksum, description FROM dotfile_versions WHERE id = ?",
        )
        .get(params.version);
      if (!row) {
        set.status = 404;
        return { error: "Version not found" };
      }
      const fullPath = join(BACKUP_DIR, row.tarball_path);
      if (!existsSync(fullPath)) {
        set.status = 404;
        return { error: "Tarball file missing on disk" };
      }
      const stat = statSync(fullPath);
      set.headers["Content-Type"] = "application/gzip";
      set.headers["Content-Length"] = String(stat.size);
      const file = Bun.file(fullPath);
      return new Response(file);
    },
    {
      params: t.Object({ appName: t.String(), version: t.String() }),
      detail: {
        summary: "Download a dotfile tarball",
        tags: ["Dotfiles"],
        responses: {
          200: { description: "Tarball bytes" },
          404: { description: "Not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .delete(
    "/dotfiles/:appName/:version",
    ({ params, set }) => {
      const row = activeDb
        .query<VersionRow, [string]>(
          "SELECT id, manifest_id, timestamp, tarball_path, size_bytes, checksum, description FROM dotfile_versions WHERE id = ?",
        )
        .get(params.version);
      if (!row) {
        set.status = 404;
        return { error: "Version not found" };
      }
      activeDb.run("DELETE FROM dotfile_versions WHERE id = ?", [params.version]);
      const fullPath = join(BACKUP_DIR, row.tarball_path);
      if (existsSync(fullPath)) {
        try {
          unlinkSync(fullPath);
        } catch {
          // best effort — file may be already gone
        }
      }
      set.status = 204;
      return null;
    },
    {
      params: t.Object({ appName: t.String(), version: t.String() }),
      detail: {
        summary: "Delete a dotfile version",
        tags: ["Dotfiles"],
        responses: {
          204: { description: "Version removed" },
          404: { description: "Not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );
