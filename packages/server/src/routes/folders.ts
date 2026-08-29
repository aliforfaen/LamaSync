import { Elysia, t } from "elysia";
import { randomBytes } from "crypto";
import { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import type { AssignmentMode, Folder, FolderAssignment, FolderBackend, FolderSize, FolderType } from "@lamasync/core";
import { normalizeAssignmentMode } from "@lamasync/core";
import { getBackend } from "../backends.ts";
import {
  bumpConfigRevision,
  bumpConfigRevisionForFolder,
} from "../config-revision.ts";
import { getFolderSize } from "../stats.ts";
import { deviceMayAccessHost, principalOf } from "../auth.ts";

const FOLDER_TYPES: FolderType[] = ["sync", "mount", "backup", "dotfile", "git"];
// LAMA-232: local/nfs are server-side directory targets; restic folders
// get their repository/password from the referenced restic backend.
const FOLDER_BACKENDS: FolderBackend[] = ["sftp", "s3", "local", "nfs", "restic"];

let db: Database = defaultDb;
export function __setDb(next: Database): void {
  db = next;
}

function normalizeBackend(value: unknown): FolderBackend {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (
      lower === "sftp" ||
      lower === "s3" ||
      lower === "local" ||
      lower === "nfs" ||
      lower === "restic"
    ) {
      return lower;
    }
  }
  return "sftp";
}

// LAMA-222: an s3 folder needs only a backend reference (credentials live
// on the Backend row) plus the per-folder bucket name. The referenced
// backend must exist and be a usable S3 backend.
function requireS3Backend(body: {
  backendId?: unknown;
  s3Bucket?: unknown;
}): string | null {
  if (typeof body.backendId !== "string" || body.backendId.trim() === "") {
    return "Missing required S3 field: backendId";
  }
  if (typeof body.s3Bucket !== "string" || body.s3Bucket.trim() === "") {
    return "Missing required S3 field: s3Bucket";
  }
  const backend = getBackend(db, body.backendId.trim());
  if (!backend) return `backend '${body.backendId}' not found`;
  if (backend.kind !== "s3") return `backend '${backend.name}' is not an S3 backend`;
  return null;
}

// LAMA-232: local/nfs/restic folders reference a Backend row of the
// matching kind (server-side path target, or a centralized restic repo).
function requireKindBackend(
  folderKind: "local" | "nfs" | "restic",
  body: { backendId?: unknown },
): string | null {
  if (typeof body.backendId !== "string" || body.backendId.trim() === "") {
    return `Missing required ${folderKind} field: backendId`;
  }
  const backend = getBackend(db, body.backendId.trim());
  if (!backend) return `backend '${body.backendId}' not found`;
  if (backend.kind !== folderKind) {
    return `backend '${backend.name}' is a ${backend.kind} backend, not ${folderKind}`;
  }
  return null;
}

function validateS3Provider(
  provider: string,
  endpoint: string,
  region: string | null,
): string | null {
  if (provider === "exoscale") {
    if (!/^sos-[a-z0-9-]+\.exo\.io$/i.test(endpoint.trim())) {
      return `Exoscale endpoint must match sos-ZONE.exo.io (got: ${endpoint})`;
    }
    return null;
  }
  if (provider === "aws") {
    if (!region || region.trim() === "") {
      return "AWS S3 provider requires s3Region";
    }
    return null;
  }
  return null;
}

function normalizeS3Region(provider: string, region: string | null | undefined): string | null {
  if (provider === "exoscale") {
    return "other-v2-signature";
  }
  return region?.trim() || null;
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
  backend_id: string | null;
  s3_bucket: string | null;
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
  // LAMA-239: per-host override. Default "inherit" matches the schema NOT
  // NULL DEFAULT; older rows pre-migration may have NULL.
  mode: string | null;
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
    backend === "s3" ||
    backend === "local" ||
    backend === "nfs" ||
    backend === "restic"
      ? backend
      : "sftp";
  const backendNeedsRef =
    normalizedBackend === "s3" ||
    normalizedBackend === "local" ||
    normalizedBackend === "nfs" ||
    normalizedBackend === "restic";
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
    // LAMA-222: S3 credentials live on the Backend row; the folder only
    // carries the reference and the bucket name. Secrets never appear here.
    backendId: backendNeedsRef ? r.backend_id : null,
    s3Bucket: normalizedBackend === "s3" ? r.s3_bucket : null,
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
    // LAMA-239: belt-and-braces default for rows pre-dating the migration
    // (column has NOT NULL DEFAULT, so post-migration rows never hit this).
    mode: r.mode === "sync" || r.mode === "mount" || r.mode === "inherit"
      ? r.mode
      : "inherit",
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
          "SELECT id, name, type, created_at, encrypted, crypt_password, git_provider, git_remote, backend, backend_id, s3_bucket FROM folders ORDER BY created_at DESC",
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
        backendId?: string | null;
        s3Bucket?: string | null;
      };
      const { name, type } = b;
      if (!FOLDER_TYPES.includes(type)) {
        set.status = 400;
        return { error: `Invalid folder type: ${type}` };
      }
      // LAMA-241: when the caller omits `backend` entirely, default to the
      // first existing backend instead of the credential-less sftp fallback
      // (which always failed with a handshake error). An explicit `sftp` is
      // still honored for legacy inline-backend folders.
      const explicitBackend =
        typeof b.backend === "string" && b.backend.trim() !== ""
          ? normalizeBackend(b.backend)
          : null;
      let backend = explicitBackend;
      let resolvedBackendId =
        typeof b.backendId === "string" ? b.backendId.trim() : "";
      if (backend === null) {
        const first = db
          .query<{ id: string; kind: string }, []>(
            "SELECT id, kind FROM backends ORDER BY created_at ASC LIMIT 1",
          )
          .get();
        if (first) {
          backend = normalizeBackend(first.kind);
          resolvedBackendId = first.id;
        } else {
          set.status = 400;
          return {
            error: "no backends configured; create a backend first or specify backend",
          };
        }
      }
      const bWithDefault = { ...b, backendId: resolvedBackendId };
      // LAMA-222: an s3 folder references a reusable Backend (credentials
      // live there) and only needs the per-folder bucket name here.
      // LAMA-232: local/nfs/restic folders reference a matching-kind
      // Backend (server-side path, or centralized restic repo).
      if (backend === "s3") {
        const s3Error = requireS3Backend(bWithDefault);
        if (s3Error) {
          set.status = 400;
          return { error: s3Error };
        }
      } else if (backend === "local" || backend === "nfs" || backend === "restic") {
        const kindError = requireKindBackend(backend, bWithDefault);
        if (kindError) {
          set.status = 400;
          return { error: kindError };
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
      const backendNeedsRef =
        backend === "s3" || backend === "local" || backend === "nfs" || backend === "restic";
      const backendId = backendNeedsRef ? resolvedBackendId : null;
      const s3Bucket = backend === "s3" ? (b.s3Bucket ?? "").trim() : null;
      db.run(
        "INSERT INTO folders (id, name, type, created_at, encrypted, crypt_password, git_provider, git_remote, backend, backend_id, s3_bucket) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, name, type, now, isEncrypted ? 1 : 0, password, normalizedGitProvider, normalizedGitRemote, backend, backendId, s3Bucket],
      );
      // LAMA-198: a new folder has no assignments yet, but it does change
      // the per-host folder list — bump every host so daemons re-pull.
      bumpConfigRevision();
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
        backendId,
        s3Bucket,
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
        backendId: t.Optional(t.Union([t.String(), t.Null()])),
        s3Bucket: t.Optional(t.Union([t.String(), t.Null()])),
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
          "SELECT id, name, type, created_at, encrypted, crypt_password, git_provider, git_remote, backend, backend_id, s3_bucket FROM folders WHERE id = ?",
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
                  mode, conflict_strategy, pre_sync_cmd, post_sync_cmd, ignore_path, mount_ignore_path,
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
  .get(
    "/folders/:id/size",
    async ({ params, set }) => {
      const row = db
        .query<FolderRow, [string]>(
          "SELECT id, name, type, created_at, encrypted, crypt_password, git_provider, git_remote, backend, backend_id, s3_bucket FROM folders WHERE id = ?",
        )
        .get(params.id);
      if (!row) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      const folder = rowToFolder(row);
      // LAMA-224 P1-7: only S3 folder sizes are measurable server-side.
      // The local / mount / sftp backends store their working set on the
      // daemon host — running `du` here against `folder_assignments.local_path`
      // always returns ENOENT in real deployments and showed a dash on
      // the Folders Size column for every non-S3 row. The endpoint now
      // returns a typed null for non-S3 folders; the UI renders "n/a".
      if (folder.backend !== "s3") {
        return {
          folderId: folder.id,
          bytes: null,
          objectCount: null,
          error: "not measurable server-side",
          measuredAt: Date.now(),
        };
      }
      const size = await getFolderSize(db, folder, false);
      return size;
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary: "Last-known working-set size for an S3 folder (cached 15 min)",
        tags: ["Folders"],
        responses: {
          200: {
            description:
              "Folder size; non-S3 folders return {bytes:null, error:'not measurable server-side'}",
          },
          404: { description: "Not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/folders/sizes",
    async () => {
      // LAMA-269: bulk last-known working-set sizes for every folder, used
      // by the storage donut to compose a destination from its folders.
      // Each call measures (or serves the 15-min cache for) S3 folders only;
      // non-S3 folders return a typed null the UI renders as "n/a".
      const rows = db
        .query<FolderRow, []>(
          "SELECT id, name, type, created_at, encrypted, crypt_password, git_provider, git_remote, backend, backend_id, s3_bucket FROM folders",
        )
        .all();
      const out: Record<string, FolderSize> = {};
      for (const row of rows) {
        const folder = rowToFolder(row);
        out[folder.id] = await getFolderSize(db, folder, false);
      }
      return out;
    },
    {
      detail: {
        summary: "Bulk last-known working-set sizes for all folders (S3 only; 15-min cache)",
        tags: ["Folders"],
        responses: {
          200: { description: "Map of folderId -> FolderSize; non-S3 folders have bytes:null" },
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
          "SELECT id, name, type, created_at, encrypted, crypt_password, git_provider, git_remote, backend, backend_id, s3_bucket FROM folders WHERE id = ?",
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
        backendId?: string | null;
        s3Bucket?: string | null;
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
      const existingBackend =
        existing.backend === "s3" ||
        existing.backend === "local" ||
        existing.backend === "nfs" ||
        existing.backend === "restic"
          ? existing.backend
          : "sftp";
      const effectiveBackend = patch.backend === undefined || patch.backend === null
        ? existingBackend
        : normalizeBackend(patch.backend);
      // LAMA-222: s3 folders reference a reusable Backend; credentials are
      // never part of the folder record. Switching backend kind to/from s3
      // requires a valid backendId when entering s3 mode. LAMA-232 extends
      // the same rule to local/nfs/restic folders.
      const nextBackendNeedsRef =
        effectiveBackend === "s3" ||
        effectiveBackend === "local" ||
        effectiveBackend === "nfs" ||
        effectiveBackend === "restic";
      const nextBackendId = nextBackendNeedsRef
        ? (typeof patch.backendId === "string" && patch.backendId.trim() !== ""
            ? patch.backendId.trim()
            : existing.backend_id)
        : null;
      const nextS3Bucket = effectiveBackend === "s3"
        ? (typeof patch.s3Bucket === "string" ? patch.s3Bucket.trim() || null : existing.s3_bucket)
        : null;
      if (effectiveBackend === "s3") {
        const s3Error = requireS3Backend({ backendId: nextBackendId, s3Bucket: nextS3Bucket });
        if (s3Error) {
          set.status = 400;
          return { error: s3Error };
        }
      } else if (effectiveBackend === "local" || effectiveBackend === "nfs" || effectiveBackend === "restic") {
        const kindError = requireKindBackend(effectiveBackend, { backendId: nextBackendId });
        if (kindError) {
          set.status = 400;
          return { error: kindError };
        }
      }
      db.run(
        "UPDATE folders SET name = ?, type = ?, encrypted = ?, crypt_password = ?, git_provider = ?, git_remote = ?, backend = ?, backend_id = ?, s3_bucket = ? WHERE id = ?",
        [newName, newType, newEncrypted ? 1 : 0, newPassword ?? null, effectiveGitProvider, effectiveGitRemote, effectiveBackend, nextBackendId, nextS3Bucket, params.id],
      );
      // LAMA-198: bump every host that has this folder assigned. The
      // assignment table is the source of truth for "who needs a refresh".
      bumpConfigRevisionForFolder(params.id);
      return rowToFolder({
        ...existing,
        name: newName,
        type: newType,
        encrypted: newEncrypted ? 1 : 0,
        crypt_password: newPassword ?? null,
        git_provider: effectiveGitProvider,
        git_remote: effectiveGitRemote,
        backend: effectiveBackend,
        backend_id: nextBackendId,
        s3_bucket: nextS3Bucket,
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
        backendId: t.Optional(t.Union([t.String(), t.Null()])),
        s3Bucket: t.Optional(t.Union([t.String(), t.Null()])),
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
      // LAMA-198: assignments for this folder were deleted above. Bump
      // every host (the "who used to have this folder" set was already
      // cascaded away, but other hosts may now see an empty folder list
      // for assignment-shape reasons).
      bumpConfigRevision();
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
        // LAMA-239: per-host mount/sync override. Omitted → "inherit".
        mode?: AssignmentMode;
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
      const host = db
        .query<{ id: string }, [string]>("SELECT id FROM hosts WHERE id = ?")
        .get(b.hostId);
      if (!host) {
        set.status = 404;
        return { error: "Host not found" };
      }
      const id = crypto.randomUUID();
      db.run(
        `INSERT INTO folder_assignments
           (id, folder_id, host_id, role, local_path, remote_name, sync_expr, enabled,
            mode, conflict_strategy, pre_sync_cmd, post_sync_cmd, ignore_path, mount_ignore_path,
            timeout_sec, bandwidth_schedule, max_retries, available_space_threshold,
            cache_profile, cache_max_size, restic_repository, restic_password)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          params.id,
          b.hostId,
          b.role,
          b.localPath,
          b.remoteName ?? null,
          b.syncExpr ?? null,
          b.enabled === false ? 0 : 1,
          // LAMA-239: default "inherit" preserves today's behavior.
          normalizeAssignmentMode(b.mode),
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
                  mode, conflict_strategy, pre_sync_cmd, post_sync_cmd, ignore_path, mount_ignore_path,
                  timeout_sec, bandwidth_schedule, max_retries, available_space_threshold,
                  cache_profile, cache_max_size, restic_repository, restic_password
           FROM folder_assignments WHERE id = ?`,
        )
        .get(id);
      if (!row) {
        set.status = 500;
        return { error: "Failed to load assignment" };
      }
      // LAMA-198: only the host that owns this assignment needs to re-pull.
      bumpConfigRevision([b.hostId]);
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
        // LAMA-239: per-host sync/mount override.
        mode: t.Optional(
          t.Union([
            t.Literal("inherit"),
            t.Literal("sync"),
            t.Literal("mount"),
            t.Null(),
          ]),
        ),
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
          404: { description: "Folder or host not found" },
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
      // LAMA-198: only the unassigned host needs to drop the folder.
      bumpConfigRevision([params.hostId]);
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
    ({ params, body, set, store }) => {
      // LAMA-234: the daemon toggles its own mount⇄sync mode here — a
      // device key may only touch its own host's assignment.
      if (!deviceMayAccessHost(principalOf(store), params.hostId)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const b = body as {
        cacheProfile?: string | null;
        cacheMaxSize?: string | null;
        syncExpr?: string | null;
        enabled?: boolean;
        // LAMA-239: per-host sync/mount override. Setting it to null on the
        // wire resets to "inherit".
        mode?: AssignmentMode | null;
        preSyncCmd?: string | null;
        postSyncCmd?: string | null;
        conflictStrategy?: string | null;
        timeoutSec?: number | null;
        maxRetries?: number | null;
        availableSpaceThreshold?: number | null;
        role?: string | null;
        localPath?: string | null;
        bandwidthSchedule?: string | null;
        // LAMA-259 follow-up: per-host restic repository/password
        // override. null on the wire CLEARS the override (back to the
        // folder/backend default). Both fields must travel together —
        // resolveFolderResticConfigForHost refuses a partial override
        // and falls back, matching daemon-side behavior.
        resticRepository?: string | null;
        resticPassword?: string | null;
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
      if (b.mode !== undefined) {
        sets.push("mode = ?");
        // null → "inherit" (the wire-reset semantic). Anything else runs
        // through the narrower so an invalid string can't reach the column.
        args.push(b.mode === null ? "inherit" : normalizeAssignmentMode(b.mode));
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
      if (b.role !== undefined) {
        sets.push("role = ?");
        args.push(b.role);
      }
      if (b.localPath !== undefined) {
        sets.push("local_path = ?");
        args.push(b.localPath);
      }
      if (b.bandwidthSchedule !== undefined) {
        sets.push("bandwidth_schedule = ?");
        args.push(b.bandwidthSchedule);
      }
      if (b.resticRepository !== undefined) {
        // Trim so leading/trailing whitespace doesn't poison the
        // later-LAMA-259 override check (resolveFolderResticConfigForHost
        // refuses a repository whose trimmed form is ""). null is the
        // documented "clear the override" shape — store NULL so the
        // helper falls back to the folder-level default.
        sets.push("restic_repository = ?");
        args.push(
          b.resticRepository === null
            ? null
            : b.resticRepository.trim() === ""
            ? null
            : b.resticRepository.trim(),
        );
      }
      if (b.resticPassword !== undefined) {
        sets.push("restic_password = ?");
        // Password is opaque (encrypted at rest server-side); we keep
        // an empty string honest — the per-host resolver treats "" as
        // "fall back", which is what an empty PATCH payload should do
        // rather than overwriting a real password.
        args.push(
          b.resticPassword === null || b.resticPassword === ""
            ? null
            : b.resticPassword,
        );
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
                  mode, conflict_strategy, pre_sync_cmd, post_sync_cmd, ignore_path, mount_ignore_path,
                  timeout_sec, bandwidth_schedule, max_retries, available_space_threshold,
                  cache_profile, cache_max_size, restic_repository, restic_password
           FROM folder_assignments WHERE folder_id = ? AND host_id = ?`,
        )
        .get(params.id, params.hostId);
      if (!row) {
        set.status = 500;
        return { error: "Failed to load assignment" };
      }
      // LAMA-198: only the patched host needs to re-pull.
      bumpConfigRevision([params.hostId]);
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
        // LAMA-239: per-host sync/mount override. null on the wire resets
        // the override to "inherit".
        mode: t.Optional(
          t.Union([
            t.Literal("inherit"),
            t.Literal("sync"),
            t.Literal("mount"),
            t.Null(),
          ]),
        ),
        preSyncCmd: t.Optional(t.Union([t.String(), t.Null()])),
        postSyncCmd: t.Optional(t.Union([t.String(), t.Null()])),
        conflictStrategy: t.Optional(t.Union([t.String(), t.Null()])),
        timeoutSec: t.Optional(t.Union([t.Number(), t.Null()])),
        maxRetries: t.Optional(t.Union([t.Number(), t.Null()])),
        availableSpaceThreshold: t.Optional(t.Union([t.Number(), t.Null()])),
        role: t.Optional(t.Union([t.String(), t.Null()])),
        localPath: t.Optional(t.Union([t.String(), t.Null()])),
        bandwidthSchedule: t.Optional(t.Union([t.String(), t.Null()])),
        // LAMA-259 follow-up: per-host restic override. null clears the
        // override (back to folder/backend defaults). Both fields
        // must travel together; resolveFolderResticConfigForHost treats
        // a partial override as "no override".
        resticRepository: t.Optional(t.Union([t.String(), t.Null()])),
        resticPassword: t.Optional(t.Union([t.String(), t.Null()])),
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
  )
  // LAMA-241: assignments are addressed by (folderId, hostId), not by a
  // global assignment id. These never-existed-by-id routes returned a bare
  // `not_found` that cost the operator a Swagger detour; a 405 with the
  // real path is actionable instead.
  .put(
    "/assignments/:id",
    ({ set }) => {
      set.status = 405;
      return {
        error: "assignments are addressed by folder+host; use PATCH /api/v1/folders/:folderId/assign/:hostId",
      };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary: "405 — use PATCH /folders/:folderId/assign/:hostId",
        tags: ["Folders"],
        responses: { 405: { description: "Method not allowed — wrong path shape" } },
      },
    },
  )
  .patch(
    "/assignments/:id",
    ({ set }) => {
      set.status = 405;
      return {
        error: "assignments are addressed by folder+host; use PATCH /api/v1/folders/:folderId/assign/:hostId",
      };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary: "405 — use PATCH /folders/:folderId/assign/:hostId",
        tags: ["Folders"],
        responses: { 405: { description: "Method not allowed — wrong path shape" } },
      },
    },
  )
  .delete(
    "/assignments/:id",
    ({ set }) => {
      set.status = 405;
      return {
        error: "assignments are addressed by folder+host; use DELETE /api/v1/folders/:folderId/assign/:hostId",
      };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary: "405 — use DELETE /folders/:folderId/assign/:hostId",
        tags: ["Folders"],
        responses: { 405: { description: "Method not allowed — wrong path shape" } },
      },
    },
  );
