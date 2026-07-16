import { Elysia, t } from "elysia";
import { randomBytes } from "crypto";
import { db } from "../db.ts";
import type { Folder, FolderAssignment, FolderType } from "@lamasync/core";

const FOLDER_TYPES: FolderType[] = ["sync", "mount", "backup", "dotfile", "git"];

interface FolderRow {
  id: string;
  name: string;
  type: string;
  created_at: number | null;
  encrypted: number | null;
  crypt_password: string | null;
  git_provider: string | null;
  git_remote: string | null;
}

interface AssignmentRow {
  id: string;
  folder_id: string;
  host_id: string;
  role: string;
  local_path: string;
  remote_name: string | null;
  sync_expr: string | null;
  enabled: number;
  conflict_strategy: string | null;
  pre_sync_cmd: string | null;
  post_sync_cmd: string | null;
  ignore_path: string | null;
  mount_ignore_path: string | null;
  timeout_sec: number | null;
  bandwidth_schedule: string | null;
  max_retries: number | null;
  available_space_threshold: number | null;
  cache_profile: string | null;
  cache_max_size: string | null;
  restic_repository: string | null;
  restic_password: string | null;
}

function rowToFolder(r: FolderRow): Folder {
  const provider = r.git_provider;
  const gitProvider: Folder["gitProvider"] =
    provider === "git" || provider === "gh" ? provider : null;
  return {
    id: r.id,
    name: r.name,
    type: r.type as FolderType,
    createdAt: r.created_at ?? undefined,
    encrypted: (r.encrypted ?? 0) === 1,
    cryptPassword: r.crypt_password,
    gitProvider,
    gitRemote: r.git_remote,
  };
}

function rowToAssignment(r: AssignmentRow): FolderAssignment {
  return {
    id: r.id,
    folderId: r.folder_id,
    hostId: r.host_id,
    role: r.role,
    localPath: r.local_path,
    remoteName: r.remote_name,
    syncExpr: r.sync_expr,
    enabled: r.enabled === 1,
    conflictStrategy: (r.conflict_strategy as FolderAssignment["conflictStrategy"]) ?? null,
    preSyncCmd: r.pre_sync_cmd,
    postSyncCmd: r.post_sync_cmd,
    ignorePath: r.ignore_path,
    mountIgnorePath: r.mount_ignore_path,
    timeoutSec: r.timeout_sec,
    bandwidthSchedule: r.bandwidth_schedule,
    maxRetries: r.max_retries,
    availableSpaceThreshold: r.available_space_threshold,
    cacheProfile: (r.cache_profile as FolderAssignment["cacheProfile"]) ?? null,
    cacheMaxSize: r.cache_max_size,
    resticRepository: r.restic_repository,
    resticPassword: r.restic_password,
  };
}

export const foldersRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/folders",
    () => {
      const rows = db
        .query<FolderRow, []>(
          "SELECT id, name, type, created_at, encrypted, crypt_password, git_provider, git_remote FROM folders ORDER BY created_at DESC",
        )
        .all();
      return rows.map(rowToFolder);
    },
    {
      detail: {
        summary: "List all folders",
        tags: ["Folders"],
        responses: {
          200: { description: "Folder list" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/folders",
    ({ body, set }) => {
      const { name, type, encrypted, cryptPassword, gitProvider, gitRemote } = body as {
        name: string;
        type: FolderType;
        encrypted?: boolean;
        cryptPassword?: string | null;
        gitProvider?: "git" | "gh" | null;
        gitRemote?: string | null;
      };
      if (!FOLDER_TYPES.includes(type)) {
        set.status = 400;
        return { error: `Invalid folder type: ${type}` };
      }
      const isEncrypted = encrypted === true;
      const password =
        isEncrypted && (cryptPassword === null || cryptPassword === undefined || cryptPassword === "")
          ? randomBytes(32).toString("base64")
          : (cryptPassword ?? null);
      if (isEncrypted && (password === null || password === "")) {
        set.status = 500;
        return { error: "Failed to generate crypt password" };
      }
      if (gitProvider === "gh" && (typeof gitRemote !== "string" || gitRemote.trim() === "")) {
        set.status = 400;
        return { error: "gitRemote is required when gitProvider is \"gh\"" };
      }
      const normalizedGitRemote =
        gitProvider === "gh" && typeof gitRemote === "string" ? gitRemote.trim() : (gitRemote ?? null);
      const normalizedGitProvider = gitProvider ?? null;
      const id = crypto.randomUUID();
      const now = Date.now();
      db.run(
        "INSERT INTO folders (id, name, type, created_at, encrypted, crypt_password, git_provider, git_remote) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [id, name, type, now, isEncrypted ? 1 : 0, password, normalizedGitProvider, normalizedGitRemote],
      );
      set.status = 201;
      return {
        id,
        name,
        type,
        createdAt: now,
        encrypted: isEncrypted,
        cryptPassword: password,
        gitProvider: normalizedGitProvider,
        gitRemote: normalizedGitRemote,
      };
    },
    {
      body: t.Object({
        name: t.String(),
        type: t.Union([
          t.Literal("sync"),
          t.Literal("mount"),
          t.Literal("backup"),
          t.Literal("dotfile"),
          t.Literal("git"),
        ]),
        encrypted: t.Optional(t.Boolean()),
        cryptPassword: t.Optional(t.Union([t.String(), t.Null()])),
        gitProvider: t.Optional(
          t.Union([t.Literal("git"), t.Literal("gh"), t.Null()]),
        ),
        gitRemote: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: {
        summary: "Create a folder definition",
        tags: ["Folders"],
        responses: {
          201: { description: "Folder created" },
          400: { description: "Invalid input" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/folders/:id",
    ({ params, set }) => {
      const row = db
        .query<FolderRow, [string]>(
          "SELECT id, name, type, created_at, encrypted, crypt_password, git_provider, git_remote FROM folders WHERE id = ?",
        )
        .get(params.id);
      if (!row) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      return rowToFolder(row);
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary: "Get folder by id",
        tags: ["Folders"],
        responses: {
          200: { description: "Folder record" },
          404: { description: "Not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .put(
    "/folders/:id",
    ({ params, body, set }) => {
      const existing = db
        .query<FolderRow, [string]>(
          "SELECT id, name, type, created_at, encrypted, crypt_password, git_provider, git_remote FROM folders WHERE id = ?",
        )
        .get(params.id);
      if (!existing) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      const patch = body as {
        name?: string;
        type?: FolderType;
        encrypted?: boolean;
        cryptPassword?: string | null;
        gitProvider?: "git" | "gh" | null;
        gitRemote?: string | null;
      };
      if (patch.type && !FOLDER_TYPES.includes(patch.type)) {
        set.status = 400;
        return { error: `Invalid folder type: ${patch.type}` };
      }
      const newName = patch.name ?? existing.name;
      const newType = patch.type ?? (existing.type as FolderType);
      const existingEncrypted = (existing.encrypted ?? 0) === 1;
      const newEncrypted =
        patch.encrypted === undefined ? existingEncrypted : patch.encrypted === true;
      const wantsPassword = patch.cryptPassword !== undefined;
      const newPassword = wantsPassword
        ? patch.cryptPassword === null || patch.cryptPassword === ""
          ? (newEncrypted ? randomBytes(32).toString("base64") : null)
          : patch.cryptPassword
        : existing.crypt_password;
      if (newEncrypted && (newPassword === null || newPassword === "")) {
        set.status = 500;
        return { error: "Failed to generate crypt password" };
      }
      const existingProvider = (existing.git_provider === "git" || existing.git_provider === "gh")
        ? existing.git_provider
        : null;
      const effectiveGitProvider = patch.gitProvider === undefined ? existingProvider : patch.gitProvider;
      const providedRemote = patch.gitRemote;
      const effectiveGitRemote = providedRemote === undefined
        ? existing.git_remote
        : (providedRemote === null
            ? null
            : (typeof providedRemote === "string" ? providedRemote.trim() || null : existing.git_remote));
      if (effectiveGitProvider === "gh" && (effectiveGitRemote === null || effectiveGitRemote === "")) {
        set.status = 400;
        return { error: "gitRemote is required when gitProvider is \"gh\"" };
      }
      db.run(
        "UPDATE folders SET name = ?, type = ?, encrypted = ?, crypt_password = ?, git_provider = ?, git_remote = ? WHERE id = ?",
        [newName, newType, newEncrypted ? 1 : 0, newPassword ?? null, effectiveGitProvider, effectiveGitRemote, params.id],
      );
      return rowToFolder({
        ...existing,
        name: newName,
        type: newType,
        encrypted: newEncrypted ? 1 : 0,
        crypt_password: newPassword ?? null,
        git_provider: effectiveGitProvider,
        git_remote: effectiveGitRemote,
      });
     },
     {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        name: t.Optional(t.String()),
        type: t.Optional(
          t.Union([
            t.Literal("sync"),
            t.Literal("mount"),
            t.Literal("backup"),
            t.Literal("dotfile"),
            t.Literal("git"),
          ]),
        ),
        encrypted: t.Optional(t.Boolean()),
        cryptPassword: t.Optional(t.Union([t.String(), t.Null()])),
        gitProvider: t.Optional(
          t.Union([t.Literal("git"), t.Literal("gh"), t.Null()]),
        ),
        gitRemote: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: {
        summary: "Update folder name or type",
        tags: ["Folders"],
        responses: {
          200: { description: "Updated folder" },
          400: { description: "Invalid input" },
          404: { description: "Not found" },
          401: { description: "Unauthorized" },
        },
      },
     },
   )
  .delete(
    "/folders/:id",
    ({ params, set }) => {
      // Capture assignment ids first; SQLite has no FK cascade on these tables.
      const assignmentIds = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM folder_assignments WHERE folder_id = ?",
        )
        .all(params.id)
        .map((r) => r.id);
      if (assignmentIds.length > 0) {
        const placeholders = assignmentIds.map(() => "?").join(",");
        db.run(
          `DELETE FROM schedule_state WHERE folder_assignment_id IN (${placeholders})`,
          assignmentIds,
        );
      }
      db.run("DELETE FROM folder_assignments WHERE folder_id = ?", [params.id]);
      const result = db.run("DELETE FROM folders WHERE id = ?", [params.id]);
      if (result.changes === 0) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      set.status = 204;
      return null;
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary: "Delete folder and all its assignments",
        tags: ["Folders"],
        responses: {
          204: { description: "Folder removed" },
          404: { description: "Not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/folders/:id/assign",
    ({ params, body, set }) => {
      const folder = db
        .query<FolderRow, [string]>(
          "SELECT id, name, type, created_at, encrypted, crypt_password, git_provider, git_remote FROM folders WHERE id = ?",
        )
        .get(params.id);
      if (!folder) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      const b = body as {
        hostId: string;
        role: string;
        localPath: string;
        remoteName?: string | null;
        syncExpr?: string | null;
        enabled?: boolean;
        conflictStrategy?: string | null;
        preSyncCmd?: string | null;
        postSyncCmd?: string | null;
        ignorePath?: string | null;
        mountIgnorePath?: string | null;
        timeoutSec?: number | null;
        bandwidthSchedule?: string | null;
        maxRetries?: number | null;
        availableSpaceThreshold?: number | null;
        cacheProfile?: string | null;
        cacheMaxSize?: string | null;
        resticRepository?: string | null;
        resticPassword?: string | null;
      };
      const id = crypto.randomUUID();
      db.run(
        `INSERT INTO folder_assignments
           (id, folder_id, host_id, role, local_path, remote_name, sync_expr, enabled,
            conflict_strategy, pre_sync_cmd, post_sync_cmd, ignore_path, mount_ignore_path,
            timeout_sec, bandwidth_schedule, max_retries, available_space_threshold,
            cache_profile, cache_max_size, restic_repository, restic_password)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          params.id,
          b.hostId,
          b.role,
          b.localPath,
          b.remoteName ?? null,
          b.syncExpr ?? null,
          b.enabled === false ? 0 : 1,
          b.conflictStrategy ?? null,
          b.preSyncCmd ?? null,
          b.postSyncCmd ?? null,
          b.ignorePath ?? null,
          b.mountIgnorePath ?? null,
          b.timeoutSec ?? null,
          b.bandwidthSchedule ?? null,
          b.maxRetries ?? null,
          b.availableSpaceThreshold ?? null,
          b.cacheProfile ?? null,
          b.cacheMaxSize ?? null,
          b.resticRepository ?? null,
          b.resticPassword ?? null,
        ],
      );
      const row = db
        .query<AssignmentRow, [string]>(
          `SELECT id, folder_id, host_id, role, local_path, remote_name, sync_expr, enabled,
                  conflict_strategy, pre_sync_cmd, post_sync_cmd, ignore_path, mount_ignore_path,
                  timeout_sec, bandwidth_schedule, max_retries, available_space_threshold,
                  cache_profile, cache_max_size, restic_repository, restic_password
           FROM folder_assignments WHERE id = ?`,
        )
        .get(id);
      if (!row) {
        set.status = 500;
        return { error: "Failed to load assignment" };
      }
      set.status = 201;
      return rowToAssignment(row);
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        hostId: t.String(),
        role: t.String(),
        localPath: t.String(),
        remoteName: t.Optional(t.Union([t.String(), t.Null()])),
        syncExpr: t.Optional(t.Union([t.String(), t.Null()])),
        enabled: t.Optional(t.Boolean()),
        conflictStrategy: t.Optional(t.Union([t.String(), t.Null()])),
        preSyncCmd: t.Optional(t.Union([t.String(), t.Null()])),
        postSyncCmd: t.Optional(t.Union([t.String(), t.Null()])),
        ignorePath: t.Optional(t.Union([t.String(), t.Null()])),
        mountIgnorePath: t.Optional(t.Union([t.String(), t.Null()])),
        timeoutSec: t.Optional(t.Number()),
        bandwidthSchedule: t.Optional(t.String({ maxLength: 256 })),
        maxRetries: t.Optional(t.Number()),
        availableSpaceThreshold: t.Optional(t.Number()),
        cacheProfile: t.Optional(
          t.Union([
            t.Literal("normal"),
            t.Literal("media"),
            t.Literal("minimal"),
            t.Null(),
          ]),
        ),
        cacheMaxSize: t.Optional(t.String({ pattern: "^\\d+[KMGT]?$" })),
        resticRepository: t.Optional(t.Union([t.String(), t.Null()])),
        resticPassword: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: {
        summary: "Assign a folder to a host",
        tags: ["Folders"],
        responses: {
          201: { description: "Assignment created" },
          404: { description: "Folder not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .delete(
    "/folders/:id/assign/:hostId",
    ({ params, set }) => {
      const result = db.run(
        "DELETE FROM folder_assignments WHERE folder_id = ? AND host_id = ?",
        [params.id, params.hostId],
      );
      if (result.changes === 0) {
        set.status = 404;
        return { error: "Assignment not found" };
      }
      set.status = 204;
      return null;
    },
    {
      params: t.Object({ id: t.String(), hostId: t.String() }),
      detail: {
        summary: "Unassign a folder from a host",
        tags: ["Folders"],
        responses: {
          204: { description: "Assignment removed" },
          404: { description: "Not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );
