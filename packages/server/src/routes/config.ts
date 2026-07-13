import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import type {
  DotfileManifest,
  Folder,
  FolderAssignment,
  HostConfig,
  Peer,
} from "@lamasync/core";

// Test seam: allows unit tests to substitute the production DB. Production
// code never calls this; the default `db` is the live one.
let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

interface HostRow {
  id: string;
  hostname: string;
  tailnet_ip: string | null;
  last_seen: number | null;
  status: string | null;
  lan_ip: string | null;
}

// SFTP credentials embedded in the generated rclone config so the daemon
// can address the peer directly. The same secret is the pre-shared API key
// carried by every host — no new credential is created.
const PEER_SFTP_USER = "lamasync";

interface FolderRow {
  id: string;
  name: string;
  type: string;
  created_at: number | null;
  encrypted: number | null;
  crypt_password: string | null;
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
}

interface ManifestRow {
  id: string;
  host_id: string;
  app_name: string;
  paths: string;
  schedule: string | null;
}

function rowToFolder(r: FolderRow): Folder {
  return {
    id: r.id,
    name: r.name,
    type: r.type as Folder["type"],
    createdAt: r.created_at ?? undefined,
    encrypted: (r.encrypted ?? 0) === 1,
    cryptPassword: r.crypt_password,
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

// IPv4 /24 subnet string. Returns `null` for malformed, IPv6, loopback, or
// link-local addresses — none of those qualify as a LAN peer.
export function ipv4Subnet24(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  }
  if (parts[0] === "127") return null;
  if (parts[0] === "0") return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

// Lexicographic ordering between two host ids: the smaller one serves. Stable
// across regenerations and identical on both peers.
export function pickPeerRole(
  currentHostId: string,
  peerHostId: string,
): "serve" | "use" {
  return currentHostId < peerHostId ? "serve" : "use";
}

// Build the list of `Peer` entries for `currentHostId` from the full set of
// online hosts. Two hosts are peers when they share an IPv4 /24 subnet.
export function detectLanPeers(
  currentHostId: string,
  hosts: ReadonlyArray<HostRow>,
  apiKey: string | null,
): Peer[] {
  const current = hosts.find((h) => h.id === currentHostId);
  if (!current) return [];
  const mySubnet = ipv4Subnet24(current.lan_ip);
  if (!mySubnet) return [];
  const peers: Peer[] = [];
  for (const other of hosts) {
    if (other.id === currentHostId) continue;
    if (other.status !== "online") continue;
    const otherSubnet = ipv4Subnet24(other.lan_ip);
    if (otherSubnet !== mySubnet) continue;
    if (!other.lan_ip) continue;
    const role = pickPeerRole(currentHostId, other.id);
    peers.push({
      peerHostId: other.id,
      peerLanIp: other.lan_ip,
      peerRemote: `lamasync-peer-${other.id}`,
      role,
      folderIds: [],
    });
  }
  return peers;
}

interface GenerateResult {
  rcloneConfig: string;
  peers: Peer[];
}

export function generateRcloneConfig(
  hostId: string,
  folders: Folder[],
  assignments: FolderAssignment[],
  serverTailnetIp: string | null,
  backupDir: string,
  peers: ReadonlyArray<Peer> = [],
  apiKey: string | null = null,
): GenerateResult {
  const lines: string[] = [
    `# Generated for ${hostId} at ${new Date().toISOString()}`,
    `# Server tailnet IP: ${serverTailnetIp ?? "(unset)"}`,
    "",
  ];

  const myFolderIds = new Set(assignments.map((a) => a.folderId));
  const peerSharedFolderIds = new Set<string>();
  if (myFolderIds.size > 0) {
    for (const p of peers) {
      const peerFolderIds = activeDb
        .query<{ folder_id: string }, [string]>(
          "SELECT folder_id FROM folder_assignments WHERE host_id = ?",
        )
        .all(p.peerHostId)
        .map((r) => r.folder_id);
      for (const fa of peerFolderIds) {
        if (myFolderIds.has(fa)) peerSharedFolderIds.add(fa);
      }
    }
  }

  for (const a of assignments) {
    const folder = folders.find((f) => f.id === a.folderId);
    if (!folder) continue;
    const remoteName = a.remoteName ?? `lamasync-${folder.id}`;
    // Encrypted folders: the crypt section is always `lamasync-<folderId>`
    // (matching the daemon's getRemoteName default). A custom
    // assignment.remoteName on an encrypted folder is ignored for the
    // section name — the operator must remove it.
    const cryptName = `lamasync-${folder.id}`;
    const isEncrypted =
      folder.encrypted === true &&
      folder.cryptPassword !== null &&
      folder.cryptPassword !== undefined &&
      folder.cryptPassword !== "" &&
      folder.type !== "dotfile";
    if (isEncrypted) {
      const backendName = `lamasync-${folder.id}-backend`;
      lines.push(`[${backendName}]`);
      if (serverTailnetIp) {
        lines.push("type = sftp");
        lines.push(`host = ${serverTailnetIp}`);
        lines.push("user = lamasync");
        lines.push(`description = "${folder.name} (${folder.type}) — encrypted backend"`);
        lines.push(`# local path on client: ${a.localPath}`);
      } else {
        lines.push("type = local");
        lines.push(`description = "${folder.name} (${folder.type}) — encrypted backend; server unavailable"`);
        lines.push(`# local path on client: ${a.localPath}`);
      }
      lines.push("");
      lines.push(`[${cryptName}]`);
      lines.push("type = crypt");
      lines.push(`remote = ${backendName}:${folder.name}`);
      lines.push(`password = ${folder.cryptPassword}`);
      lines.push(`password2 = ${folder.cryptPassword}`);
      lines.push(`description = "${folder.name} (encrypted ${folder.type})"`);
      lines.push("");
    } else {
      lines.push(`[${remoteName}]`);
      if (folder.type === "dotfile") {
        lines.push("type = local");
        lines.push(`description = "${folder.name} (dotfile backup)"`);
        lines.push(`# local path on client: ${a.localPath}`);
        lines.push(`# server path: ${backupDir}/dotfiles/${folder.name}/`);
      } else if (serverTailnetIp) {
        lines.push("type = sftp");
        lines.push(`host = ${serverTailnetIp}`);
        lines.push("user = lamasync");
        lines.push(`description = "${folder.name} (${folder.type})"`);
        lines.push(`# local path on client: ${a.localPath}`);
      } else {
        lines.push("type = local");
        lines.push(`description = "${folder.name} (${folder.type}) — server unavailable"`);
        lines.push(`# local path on client: ${a.localPath}`);
      }
      lines.push("");
    }
  }

  for (const p of peers) {
    lines.push(`[${p.peerRemote}]`);
    lines.push("type = sftp");
    lines.push(`host = ${p.peerLanIp}`);
    lines.push(`user = ${PEER_SFTP_USER}`);
    lines.push(`description = "LAN peer ${p.peerHostId} (${p.role})"`);
    if (apiKey) {
      lines.push(`pass = ${apiKey}`);
    }
    lines.push("");
  }

  const enriched: Peer[] = peers.map((p) => {
    const folderIds: string[] = [];
    for (const a of assignments) {
      if (peerSharedFolderIds.has(a.folderId)) folderIds.push(a.folderId);
    }
    return { ...p, folderIds };
  });

  return { rcloneConfig: lines.join("\n"), peers: enriched };
}

export const configRoutes = new Elysia({ prefix: "/api/v1" }).get(
  "/config/:hostId",
  ({ params, set }) => {
    const { hostId } = params;
    const host = activeDb
      .query<HostRow, [string]>(
        "SELECT id, hostname, tailnet_ip, last_seen, status, lan_ip FROM hosts WHERE id = ?",
      )
      .get(hostId);
    if (!host) {
      set.status = 404;
      return { error: `Host '${hostId}' not found` };
    }
    const assignmentRows = activeDb
      .query<AssignmentRow, [string]>(
        `SELECT id, folder_id, host_id, role, local_path, remote_name, sync_expr, enabled,
                conflict_strategy, pre_sync_cmd, post_sync_cmd, ignore_path, mount_ignore_path,
                timeout_sec, bandwidth_schedule, max_retries, available_space_threshold,
                cache_profile, cache_max_size
         FROM folder_assignments WHERE host_id = ?`,
      )
      .all(hostId);

    const folderIds = Array.from(new Set(assignmentRows.map((r) => r.folder_id)));
    const folderRows = folderIds.length
      ? activeDb
          .query<FolderRow, string[]>(
            `SELECT id, name, type, created_at, encrypted, crypt_password FROM folders WHERE id IN (${folderIds
              .map(() => "?")
              .join(",")})`,
          )
          .all(...folderIds)
      : [];

    const manifestRows = activeDb
      .query<ManifestRow, [string]>(
        `SELECT id, host_id, app_name, paths, schedule
         FROM dotfile_manifests WHERE host_id = ?`,
      )
      .all(hostId);

    const allHostRows = activeDb
      .query<HostRow, []>(
        "SELECT id, hostname, tailnet_ip, last_seen, status, lan_ip FROM hosts",
      )
      .all();

    const assignments = assignmentRows.map(rowToAssignment);
    const folders = folderRows.map(rowToFolder);
    const manifests = manifestRows.map(rowToManifest);

    const serverTailnetIp = process.env.LAMASYNC_TAILNET_IP ?? null;
    const backupDir = process.env.LAMASYNC_BACKUP_DIR ?? "/backups";
    const apiKey = process.env.LAMASYNC_API_KEY ?? null;

    const peers = detectLanPeers(hostId, allHostRows, apiKey);
    const generated = generateRcloneConfig(
      hostId,
      folders,
      assignments,
      serverTailnetIp,
      backupDir,
      peers,
      apiKey,
    );

    const response: HostConfig = {
      host: {
        id: host.id,
        hostname: host.hostname,
        tailnetIp: host.tailnet_ip,
        lanIp: host.lan_ip,
        lastSeen: host.last_seen,
        status: (host.status ?? "unknown") as HostConfig["host"]["status"],
      },
      assignments,
      folders,
      manifests,
      rcloneConfig: generated.rcloneConfig,
      serverTailnetIp,
      peers: generated.peers,
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
