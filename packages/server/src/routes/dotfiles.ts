import { Elysia, t } from "elysia";
import { mkdirSync, statSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { db } from "../db.ts";
import type { DotfileVersion } from "@lamasync/core";

const BACKUP_DIR = process.env.LAMASYNC_BACKUP_DIR || "/backups";

interface VersionRow {
  id: string;
  manifest_id: string;
  timestamp: number;
  tarball_path: string;
  size_bytes: number | null;
  checksum: string | null;
  description: string | null;
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

/** Find a manifest for this (host, appName) or create one with no paths. */
function ensureManifest(appName: string): string | null {
  // We need a host_id. We support a default host id "_global" for app-scoped versions
  // that aren't tied to a specific host. Real per-host manifests are inserted elsewhere.
  const hostId = "_global";
  const existing = db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM dotfile_manifests WHERE host_id = ? AND app_name = ?",
    )
    .get(hostId, appName);
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  try {
    db.run(
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
    "/dotfiles",
    ({ query }) => {
      const hostId = (query as { hostId?: string }).hostId;
      if (!hostId) {
        return [];
      }
      const rows = db
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
      const rows = db
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
      const manifestId = ensureManifest(params.appName);
      if (!manifestId) {
        set.status = 500;
        return { error: "Failed to ensure manifest" };
      }
      const form = await request.formData();
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

      const id = crypto.randomUUID();
      db.run(
        `INSERT INTO dotfile_versions
           (id, manifest_id, timestamp, tarball_path, size_bytes, description)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, manifestId, timestamp, relPath, buf.length, description],
      );

      const row = db
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
      const row = db
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
      const row = db
        .query<VersionRow, [string]>(
          "SELECT id, manifest_id, timestamp, tarball_path, size_bytes, checksum, description FROM dotfile_versions WHERE id = ?",
        )
        .get(params.version);
      if (!row) {
        set.status = 404;
        return { error: "Version not found" };
      }
      db.run("DELETE FROM dotfile_versions WHERE id = ?", [params.version]);
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