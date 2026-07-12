import { Elysia, t } from "elysia";
import { db } from "../db.ts";
import type { Folder, FolderAssignment, FolderType } from "@lamasync/core";

const FOLDER_TYPES: FolderType[] = ["sync", "mount", "backup", "dotfile"];

interface FolderRow {
  id: string;
  name: string;
  type: string;
  created_at: number | null;
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
  timeout_sec: number | null;
}

function rowToFolder(r: FolderRow): Folder {
  return { id: r.id, name: r.name, type: r.type as FolderType, createdAt: r.created_at ?? undefined };
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
    timeoutSec: r.timeout_sec,
  };
}

export const foldersRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/folders",
    () => {
      const rows = db
        .query<FolderRow, []>(
          "SELECT id, name, type, created_at FROM folders ORDER BY created_at DESC",
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
      const { name, type } = body as { name: string; type: FolderType };
      if (!FOLDER_TYPES.includes(type)) {
        set.status = 400;
        return { error: `Invalid folder type: ${type}` };
      }
      const id = crypto.randomUUID();
      const now = Date.now();
      db.run(
        "INSERT INTO folders (id, name, type, created_at) VALUES (?, ?, ?, ?)",
        [id, name, type, now],
      );
      set.status = 201;
      return { id, name, type, createdAt: now };
    },
    {
      body: t.Object({
        name: t.String(),
        type: t.Union([
          t.Literal("sync"),
          t.Literal("mount"),
          t.Literal("backup"),
          t.Literal("dotfile"),
        ]),
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
          "SELECT id, name, type, created_at FROM folders WHERE id = ?",
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
          "SELECT id, name, type, created_at FROM folders WHERE id = ?",
        )
        .get(params.id);
      if (!existing) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      const patch = body as { name?: string; type?: FolderType };
      if (patch.type && !FOLDER_TYPES.includes(patch.type)) {
        set.status = 400;
        return { error: `Invalid folder type: ${patch.type}` };
      }
      const newName = patch.name ?? existing.name;
      const newType = patch.type ?? (existing.type as FolderType);
      db.run("UPDATE folders SET name = ?, type = ? WHERE id = ?", [
        newName,
        newType,
        params.id,
      ]);
      return rowToFolder({
        ...existing,
        name: newName,
        type: newType,
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
          ]),
        ),
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
          "SELECT id, name, type, created_at FROM folders WHERE id = ?",
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
        timeoutSec?: number | null;
      };
      const id = crypto.randomUUID();
      db.run(
        `INSERT INTO folder_assignments
           (id, folder_id, host_id, role, local_path, remote_name, sync_expr, enabled,
            conflict_strategy, pre_sync_cmd, post_sync_cmd, ignore_path, timeout_sec)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          b.timeoutSec ?? null,
        ],
      );
      const row = db
        .query<AssignmentRow, [string]>(
          `SELECT id, folder_id, host_id, role, local_path, remote_name, sync_expr, enabled,
                  conflict_strategy, pre_sync_cmd, post_sync_cmd, ignore_path, timeout_sec
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
