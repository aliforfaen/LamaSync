import { Elysia, t } from "elysia";
import { db } from "../db.ts";
import type {
  DotfileManifest,
  Folder,
  FolderAssignment,
  HostConfig,
} from "@lamasync/core";

interface HostRow {
  id: string;
  hostname: string;
  tailnet_ip: string | null;
  last_seen: number | null;
  status: string | null;
}

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

interface ManifestRow {
  id: string;
  host_id: string;
  app_name: string;
  paths: string;
  schedule: string | null;
}

function rowToFolder(r: FolderRow): Folder {
  return { id: r.id, name: r.name, type: r.type as Folder["type"], createdAt: r.created_at ?? undefined };
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

function rowToManifest(r: ManifestRow): DotfileManifest {
  let paths: string[] = [];
  try {
    paths = JSON.parse(r.paths);
  } catch {
    paths = [];
  }
  return {
    id: r.id,
    hostId: r.host_id,
    appName: r.app_name,
    paths,
    schedule: r.schedule,
  };
}

function generateRcloneConfig(
  hostId: string,
  folders: Folder[],
  assignments: FolderAssignment[],
  serverTailnetIp: string | null,
  backupDir: string,
): string {
  const lines: string[] = [
    `# Generated for ${hostId} at ${new Date().toISOString()}`,
    `# Server tailnet IP: ${serverTailnetIp ?? "(unset)"}`,
    "",
  ];
  for (const a of assignments) {
    const folder = folders.find((f) => f.id === a.folderId);
    if (!folder) continue;
    const remoteName = a.remoteName ?? `lamasync-${folder.id}`;
    lines.push(`[${remoteName}]`);
    if (folder.type === "dotfile") {
      lines.push(`type = local`);
      lines.push(`description = "${folder.name} (dotfile backup)"`);
      lines.push(`# local path on client: ${a.localPath}`);
      lines.push(`# server path: ${backupDir}/dotfiles/${folder.name}/`);
    } else if (serverTailnetIp) {
      lines.push(`type = sftp`);
      lines.push(`host = ${serverTailnetIp}`);
      lines.push(`user = lamasync`);
      lines.push(`description = "${folder.name} (${folder.type})"`);
      lines.push(`# local path on client: ${a.localPath}`);
    } else {
      lines.push(`type = local`);
      lines.push(`description = "${folder.name} (${folder.type}) — server unavailable"`);
      lines.push(`# local path on client: ${a.localPath}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export const configRoutes = new Elysia({ prefix: "/api/v1" }).get(
  "/config/:hostId",
  ({ params, set }) => {
    const { hostId } = params;
    const host = db
      .query<HostRow, [string]>(
        "SELECT id, hostname, tailnet_ip, last_seen, status FROM hosts WHERE id = ?",
      )
      .get(hostId);
    if (!host) {
      set.status = 404;
      return { error: `Host '${hostId}' not found` };
    }

    const assignmentRows = db
      .query<AssignmentRow, [string]>(
        `SELECT id, folder_id, host_id, role, local_path, remote_name, sync_expr, enabled,
                conflict_strategy, pre_sync_cmd, post_sync_cmd, ignore_path, timeout_sec
         FROM folder_assignments WHERE host_id = ?`,
      )
      .all(hostId);

    const folderIds = Array.from(new Set(assignmentRows.map((r) => r.folder_id)));
    const folderRows = folderIds.length
      ? db
          .query<FolderRow, string[]>(
            `SELECT id, name, type, created_at FROM folders WHERE id IN (${folderIds
              .map(() => "?")
              .join(",")})`,
          )
          .all(...folderIds)
      : [];

    const manifestRows = db
      .query<ManifestRow, [string]>(
        `SELECT id, host_id, app_name, paths, schedule
         FROM dotfile_manifests WHERE host_id = ?`,
      )
      .all(hostId);

    const assignments = assignmentRows.map(rowToAssignment);
    const folders = folderRows.map(rowToFolder);
    const manifests = manifestRows.map(rowToManifest);

    const serverTailnetIp = process.env.LAMASYNC_TAILNET_IP ?? null;
    const backupDir = process.env.LAMASYNC_BACKUP_DIR ?? "/backups";

    const response: HostConfig = {
      host: {
        id: host.id,
        hostname: host.hostname,
        tailnetIp: host.tailnet_ip,
        lastSeen: host.last_seen,
        status: (host.status ?? "unknown") as HostConfig["host"]["status"],
      },
      assignments,
      folders,
      manifests,
      rcloneConfig: generateRcloneConfig(hostId, folders, assignments, serverTailnetIp, backupDir),
      serverTailnetIp,
    };
    return response;
  },
    {
      params: t.Object({ hostId: t.String() }),
      detail: {
        summary: "Fetch full configuration for a host",
        tags: ["Config"],
        responses: {
          200: { description: "Host configuration bundle" },
          404: { description: "Host not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );
