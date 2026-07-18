import { Elysia, t } from "elysia";
import { randomBytes } from "crypto";
import { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import type { Folder, FolderAssignment, FolderBackend, FolderType } from "@lamasync/core";

const FOLDER_TYPES: FolderType[] = ["sync", "mount", "backup", "dotfile", "git"];
const FOLDER_BACKENDS: FolderBackend[] = ["sftp", "s3", "local"];

let db: Database = defaultDb;
export function __setDb(next: Database): void {
  db = next;
}

function normalizeBackend(value: unknown): FolderBackend {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "sftp" || lower === "s3" || lower === "local") return lower;
  }
  return "sftp";
}

function requireS3Credentials(
  body: { s3Endpoint?: unknown; s3Bucket?: unknown; s3AccessKeyId?: unknown; s3SecretAccessKey?: unknown },
): string | null {
  const missing: string[] = [];
  if (typeof body.s3Endpoint !== "string" || body.s3Endpoint.trim() === "") missing.push("s3Endpoint");
  if (typeof body.s3Bucket !== "string" || body.s3Bucket.trim() === "") missing.push("s3Bucket");
  if (typeof body.s3AccessKeyId !== "string" || body.s3AccessKeyId.trim() === "") missing.push("s3AccessKeyId");
  if (typeof body.s3SecretAccessKey !== "string" || body.s3SecretAccessKey.trim() === "") missing.push("s3SecretAccessKey");
  if (missing.length === 0) return null;
  return `Missing required S3 fields: ${missing.join(", ")}`;
}

interface FolderRow {
  id: string;
  name: string;
  type: string;
  created_at: number | null;
  encrypted: number | null;
  crypt_password: string | null;
  git_provider: string | null;
  git_remote: string | null;
  backend: string | null;
  s3_endpoint: string | null;
  s3_bucket: string | null;
  s3_access_key_id: string | null;
  s3_secret_access_key: string | null;
  s3_region: string | null;
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
  const backend = r.backend;
  const normalizedBackend: Folder["backend"] =
    backend === "s3" || backend === "local" ? backend : "sftp";
  return {
    id: r.id,
    name: r.name,
    type: r.type as FolderType,
    createdAt: r.created_at ?? undefined,
    encrypted: (r.encrypted ?? 0) === 1,
    cryptPassword: r.crypt_password,
    gitProvider,
    gitRemote: r.git_remote,
    backend: normalizedBackend,
    s3Endpoint: r.s3_endpoint,
    s3Bucket: r.s3_bucket,
    s3AccessKeyId: r.s3_access_key_id,
    s3SecretAccessKey: r.s3_secret_access_key,
    s3Region: r.s3_region,
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
          "SELECT id, name, type, created_at, encrypted, crypt_password, git_provider, git_remote, backend, s3_endpoint, s3_bucket, s3_access_key_id, s3_secret_access_key, s3_region FROM folders ORDER BY created_at DESC",
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
      const b = body as {
        name: string;
        type: FolderType;
        encrypted?: boolean;
        cryptPassword?: string | null;
        gitProvider?: "git" | "gh" | null;
        gitRemote?: string | null;
        backend?: string | null;
        s3Endpoint?: string | null;
        s3Bucket?: string | null;
        s3AccessKeyId?: string | null;
        s3SecretAccessKey?: string | null;
        s3Region?: string | null;
      };
      const { name, type } = b;
      if (!FOLDER_TYPES.includes(type)) {
        set.status = 400;
        return { error: `Invalid folder type: ${type}` };
      }
      const backend = normalizeBackend(b.backend);
      if (backend === "s3") {
        const s3Error = requireS3Credentials(b);
        if (s3Error) {
          set.status = 400;
          return { error: s3Error };
        }
      }
      const isEncrypted = b.encrypted === true;
      const password =
        isEncrypted && (b.cryptPassword === null || b.cryptPassword === undefined || b.cryptPassword === "")
          ? randomBytes(32).toString("base64")
          : (b.cryptPassword ?? null);
      if (isEncrypted && (password === null || password === "")) {
        set.status = 500;
        return { error: "Failed to generate crypt password" };
      }
      if (b.gitProvider === "gh" && (typeof b.gitRemote !== "string" || b.gitRemote.trim() === "")) {
        set.status = 400;
        return { error: "gitRemote is required when gitProvider is \"gh\"" };
      }
      const normalizedGitRemote =
        b.gitProvider === "gh" && typeof b.gitRemote === "string" ? b.gitRemote.trim() : (b.gitRemote ?? null);
      const normalizedGitProvider = b.gitProvider ?? null;
      const id = crypto.randomUUID();
      const now = Date.now();
      const s3Endpoint = backend === "s3" ? (b.s3Endpoint ?? "").trim() : null;
      const s3Bucket = backend === "s3" ? (b.s3Bucket ?? "").trim() : null;
      const s3AccessKeyId = backend === "s3" ? (b.s3AccessKeyId ?? "").trim() : null;
      const s3SecretAccessKey = backend === "s3" ? (b.s3SecretAccessKey ?? "").trim() : null;
      const s3Region = backend === "s3" ? (b.s3Region?.trim() || null) ?? null : null;
      db.run(
        "INSERT INTO folders (id, name, type, created_at, encrypted, crypt_password, git_provider, git_remote, backend, s3_endpoint, s3_bucket, s3_access_key_id, s3_secret_access_key, s3_region) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, name, type, now, isEncrypted ? 1 : 0, password, normalizedGitProvider, normalizedGitRemote, backend, s3Endpoint, s3Bucket, s3AccessKeyId, s3SecretAccessKey, s3Region],
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
        backend,
        s3Endpoint,
        s3Bucket,
        s3AccessKeyId,
        s3SecretAccessKey,
        s3Region,
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
        backend: t.Optional(
          t.Union([t.String(), t.Null()]),
        ),
        s3Endpoint: t.Optional(t.Union([t.String(), t.Null()])),
        s3Bucket: t.Optional(t.Union([t.String(), t.Null()])),
        s3AccessKeyId: t.Optional(t.Union([t.String(), t.Null()])),
        s3SecretAccessKey: t.Optional(t.Union([t.String(), t.Null()])),
        s3Region: t.Optional(t.Union([t.String(), t.Null()])),
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
          "SELECT id, name, type, created_at, encrypted, crypt_password, git_provider, git_remote, backend, s3_endpoint, s3_bucket, s3_access_key_id, s3_secret_access_key, s3_region FROM folders WHERE id = ?",
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
  .get(
    "/folders/:id/assignments",
    ({ params, set }) => {
      const folder = db
        .query<{ id: string }, [string]>("SELECT id FROM folders WHERE id = ?")
        .get(params.id);
      if (!folder) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      const rows = db
        .query<AssignmentRow, [string]>(
          `SELECT id, folder_id, host_id, role, local_path, remote_name, sync_expr, enabled,
                  conflict_strategy, pre_sync_cmd, post_sync_cmd, ignore_path, mount_ignore_path,
                  timeout_sec, bandwidth_schedule, max_retries, available_space_threshold,
                  cache_profile, cache_max_size, restic_repository, restic_password
           FROM folder_assignments WHERE folder_id = ?`,
        )
        .all(params.id);
      return rows.map(rowToAssignment);
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary: "List assignments for a folder",
        tags: ["Folders"],
        responses: {
          200: { description: "Assignment list" },
          404: { description: "Folder not found" },
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
          "SELECT id, name, type, created_at, encrypted, crypt_password, git_provider, git_remote, backend, s3_endpoint, s3_bucket, s3_access_key_id, s3_secret_access_key, s3_region FROM folders WHERE id = ?",
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
        backend?: string | null;
        s3Endpoint?: string | null;
        s3Bucket?: string | null;
        s3AccessKeyId?: string | null;
        s3SecretAccessKey?: string | null;
        s3Region?: string | null;
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
      const existingBackend = existing.backend === "s3" || existing.backend === "local" ? existing.backend : "sftp";
      const effectiveBackend = patch.backend === undefined || patch.backend === null
        ? existingBackend
        : normalizeBackend(patch.backend);
      const s3Inputs = {
        s3Endpoint: patch.s3Endpoint ?? (existing.s3_endpoint ?? ""),
        s3Bucket: patch.s3Bucket ?? (existing.s3_bucket ?? ""),
        s3AccessKeyId: patch.s3AccessKeyId ?? (existing.s3_access_key_id ?? ""),
        s3SecretAccessKey: patch.s3SecretAccessKey ?? (existing.s3_secret_access_key ?? ""),
      };
      if (effectiveBackend === "s3") {
        const s3Error = requireS3Credentials(s3Inputs);
        if (s3Error) {
          set.status = 400;
          return { error: s3Error };
        }
      }
      const trimOrNull = (v: unknown): string | null => (typeof v === "string" ? v.trim() || null : null);
      const nextS3Endpoint = effectiveBackend === "s3" ? (typeof s3Inputs.s3Endpoint === "string" ? s3Inputs.s3Endpoint.trim() : "") : null;
      const nextS3Bucket = effectiveBackend === "s3" ? (typeof s3Inputs.s3Bucket === "string" ? s3Inputs.s3Bucket.trim() : "") : null;
      const nextS3AccessKeyId = effectiveBackend === "s3" ? (typeof s3Inputs.s3AccessKeyId === "string" ? s3Inputs.s3AccessKeyId.trim() : "") : null;
      const nextS3SecretAccessKey = effectiveBackend === "s3" ? (typeof s3Inputs.s3SecretAccessKey === "string" ? s3Inputs.s3SecretAccessKey.trim() : "") : null;
      const nextS3Region = effectiveBackend === "s3" ? trimOrNull(patch.s3Region ?? existing.s3_region) : null;
      db.run(
        "UPDATE folders SET name = ?, type = ?, encrypted = ?, crypt_password = ?, git_provider = ?, git_remote = ?, backend = ?, s3_endpoint = ?, s3_bucket = ?, s3_access_key_id = ?, s3_secret_access_key = ?, s3_region = ? WHERE id = ?",
        [newName, newType, newEncrypted ? 1 : 0, newPassword ?? null, effectiveGitProvider, effectiveGitRemote, effectiveBackend, nextS3Endpoint, nextS3Bucket, nextS3AccessKeyId, nextS3SecretAccessKey, nextS3Region, params.id],
      );
      return rowToFolder({
        ...existing,
        name: newName,
        type: newType,
        encrypted: newEncrypted ? 1 : 0,
        crypt_password: newPassword ?? null,
        git_provider: effectiveGitProvider,
        git_remote: effectiveGitRemote,
        backend: effectiveBackend,
        s3_endpoint: nextS3Endpoint,
        s3_bucket: nextS3Bucket,
        s3_access_key_id: nextS3AccessKeyId,
        s3_secret_access_key: nextS3SecretAccessKey,
        s3_region: nextS3Region,
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
        backend: t.Optional(
          t.Union([t.String(), t.Null()]),
        ),
        s3Endpoint: t.Optional(t.Union([t.String(), t.Null()])),
        s3Bucket: t.Optional(t.Union([t.String(), t.Null()])),
        s3AccessKeyId: t.Optional(t.Union([t.String(), t.Null()])),
        s3SecretAccessKey: t.Optional(t.Union([t.String(), t.Null()])),
        s3Region: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: {
        summary: "Update folder name, type, or backend",
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
  )
  .patch(
    "/folders/:id/assign/:hostId",
    ({ params, body, set }) => {
      const b = body as {
        cacheProfile?: string | null;
        cacheMaxSize?: string | null;
        syncExpr?: string | null;
        enabled?: boolean;
        preSyncCmd?: string | null;
        postSyncCmd?: string | null;
        conflictStrategy?: string | null;
        timeoutSec?: number | null;
        maxRetries?: number | null;
        availableSpaceThreshold?: number | null;
      };
      const sets: string[] = [];
      const args: (string | number | null)[] = [];
      if (b.cacheProfile !== undefined) {
        sets.push("cache_profile = ?");
        args.push(b.cacheProfile);
      }
      if (b.cacheMaxSize !== undefined) {
        sets.push("cache_max_size = ?");
        args.push(b.cacheMaxSize);
      }
      if (b.syncExpr !== undefined) {
        sets.push("sync_expr = ?");
        args.push(b.syncExpr);
      }
      if (b.enabled !== undefined) {
        sets.push("enabled = ?");
        args.push(b.enabled ? 1 : 0);
      }
      if (b.preSyncCmd !== undefined) {
        sets.push("pre_sync_cmd = ?");
        args.push(b.preSyncCmd);
      }
      if (b.postSyncCmd !== undefined) {
        sets.push("post_sync_cmd = ?");
        args.push(b.postSyncCmd);
      }
      if (b.conflictStrategy !== undefined) {
        sets.push("conflict_strategy = ?");
        args.push(b.conflictStrategy);
      }
      if (b.timeoutSec !== undefined) {
        sets.push("timeout_sec = ?");
        args.push(b.timeoutSec);
      }
      if (b.maxRetries !== undefined) {
        sets.push("max_retries = ?");
        args.push(b.maxRetries);
      }
      if (b.availableSpaceThreshold !== undefined) {
        sets.push("available_space_threshold = ?");
        args.push(b.availableSpaceThreshold);
      }
      if (sets.length === 0) {
        set.status = 400;
        return { error: "No fields to update" };
      }
      args.push(params.id, params.hostId);
      const result = db.run(
        `UPDATE folder_assignments SET ${sets.join(", ")} WHERE folder_id = ? AND host_id = ?`,
        args,
      );
      if (result.changes === 0) {
        set.status = 404;
        return { error: "Assignment not found" };
      }
      const row = db
        .query<AssignmentRow, [string, string]>(
          `SELECT id, folder_id, host_id, role, local_path, remote_name, sync_expr, enabled,
                  conflict_strategy, pre_sync_cmd, post_sync_cmd, ignore_path, mount_ignore_path,
                  timeout_sec, bandwidth_schedule, max_retries, available_space_threshold,
                  cache_profile, cache_max_size, restic_repository, restic_password
           FROM folder_assignments WHERE folder_id = ? AND host_id = ?`,
        )
        .get(params.id, params.hostId);
      if (!row) {
        set.status = 500;
        return { error: "Failed to load assignment" };
      }
      return rowToAssignment(row);
    },
    {
      params: t.Object({ id: t.String(), hostId: t.String() }),
      body: t.Object({
        cacheProfile: t.Optional(
          t.Union([
            t.Literal("normal"),
            t.Literal("media"),
            t.Literal("minimal"),
            t.Null(),
          ]),
        ),
        cacheMaxSize: t.Optional(t.Union([t.String(), t.Null()])),
        syncExpr: t.Optional(t.Union([t.String(), t.Null()])),
        enabled: t.Optional(t.Boolean()),
        preSyncCmd: t.Optional(t.Union([t.String(), t.Null()])),
        postSyncCmd: t.Optional(t.Union([t.String(), t.Null()])),
        conflictStrategy: t.Optional(t.Union([t.String(), t.Null()])),
        timeoutSec: t.Optional(t.Union([t.Number(), t.Null()])),
        maxRetries: t.Optional(t.Union([t.Number(), t.Null()])),
        availableSpaceThreshold: t.Optional(t.Union([t.Number(), t.Null()])),
      }),
      detail: {
        summary: "Update an existing assignment",
        tags: ["Folders"],
        responses: {
          200: { description: "Assignment updated" },
          400: { description: "No fields to update" },
          404: { description: "Assignment not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );
