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
import { resolveFolderLocalConfig, resolveFolderResticConfig, resolveFolderS3Config } from "../backends.ts";
import { effectiveFolderType } from "@lamasync/core";

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
  config_revision: number | null;
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
  // LAMA-239: per-host override. Rows written before the migration may have
  // NULL here; default to "inherit" so the row maps cleanly to the new shape.
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

interface ManifestRow {
  id: string;
  host_id: string;
  app_name: string;
  paths: string;
  excludes: string | null;
  schedule: string | null;
  instructions: string | null;
}

function rowToFolder(r: FolderRow): Folder {
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
    type: r.type as Folder["type"],
    createdAt: r.created_at ?? undefined,
    encrypted: (r.encrypted ?? 0) === 1,
    cryptPassword: r.crypt_password,
    backend: normalizedBackend,
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
    // LAMA-239: belt-and-braces default — older rows written before the
    // migration have mode = NULL. The column also has NOT NULL DEFAULT
    // 'inherit', so post-migration rows never hit this branch.
    mode: r.mode === "sync" || r.mode === "mount" || r.mode === "inherit"
      ? r.mode
      : "inherit",
    conflictStrategy: (r.conflict_strategy as FolderAssignment["conflictStrategy"]) ?? null,
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
      // LAMA-223: prefer the tailnet address for peer SFTP targets; the
      // config generator falls back to the LAN IP when this is null.
      peerTailnetIp: other.tailnet_ip,
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

  function writeS3Backend(name: string, folder: Folder, description: string, localPath: string): boolean {
    // LAMA-222: S3 credentials come from the folder's referenced Backend row
    // (encrypted at rest, decrypted here only for the rclone config).
    const s3 = resolveFolderS3Config(activeDb, folder);
    if (!s3) {
      console.warn(
        `[config] folder ${folder.id} (${folder.name}) is S3-typed but has no resolvable backend; skipping`,
      );
      return false;
    }
    const provider = s3.provider === "aws" ? "AWS" : "Other";
    lines.push(`[${name}]`);
    lines.push("type = s3");
    lines.push(`provider = ${provider}`);
    lines.push("env_auth = false");
    lines.push(`access_key_id = ${s3.accessKeyId}`);
    lines.push(`secret_access_key = ${s3.secretAccessKey}`);
    lines.push(`endpoint = ${s3.endpoint}`);
    if (s3.region && s3.region !== "") {
      lines.push(`region = ${s3.region}`);
    }
    lines.push(`description = "${description}"`);
    lines.push(`# bucket: ${s3.bucket}`);
    lines.push(`# local path on client: ${localPath}`);
    return true;
  }

  function writeLocalBackend(
    name: string,
    folder: Folder,
    description: string,
    localPath: string,
  ): boolean {
    // LAMA-232: local/nfs backends are server-side directories (rclone
    // type = local, root = /). The daemon appends the folder name, so the
    // alias points at the backend's absolute path.
    const resolved = resolveFolderLocalConfig(activeDb, folder);
    if (!resolved) {
      console.warn(
        `[config] folder ${folder.id} (${folder.name}) is ${folder.backend}-typed but has no resolvable backend; skipping`,
      );
      return false;
    }
    lines.push(`[${name}]`);
    lines.push("type = local");
    lines.push(`description = "${description}"`);
    lines.push(`# local path on client: ${localPath}`);
    lines.push(`# server path: ${resolved.localPath}`);
    return true;
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
    const backendKind = folder.backend ?? "sftp";
    const useS3 = backendKind === "s3";
    const useLocalBackend = backendKind === "local" || backendKind === "nfs";
    if (isEncrypted) {
      const backendName = `lamasync-${folder.id}-backend`;
      if (useS3) {
        const s3 = resolveFolderS3Config(activeDb, folder);
        const wrote = s3 !== null
          ? writeS3Backend(backendName, folder, `${folder.name} (${folder.type}) — encrypted S3 backend`, a.localPath)
          : false;
        if (!wrote) continue;
      } else if (useLocalBackend) {
        const wrote = writeLocalBackend(
          backendName,
          folder,
          `${folder.name} (${folder.type}) — encrypted ${backendKind} backend`,
          a.localPath,
        );
        if (!wrote) continue;
      } else if (serverTailnetIp) {
        lines.push(`[${backendName}]`);
        lines.push("type = sftp");
        lines.push(`host = ${serverTailnetIp}`);
        lines.push("user = lamasync");
        lines.push(`description = "${folder.name} (${folder.type}) — encrypted backend"`);
        lines.push(`# local path on client: ${a.localPath}`);
      } else {
        lines.push(`[${backendName}]`);
        lines.push("type = local");
        lines.push(`description = "${folder.name} (${folder.type}) — encrypted backend; server unavailable"`);
        lines.push(`# local path on client: ${a.localPath}`);
      }
      lines.push("");
      lines.push(`[${cryptName}]`);
      lines.push("type = crypt");
      const cryptRemoteBase = useS3
        ? (resolveFolderS3Config(activeDb, folder) ?? { bucket: "" }).bucket
        : useLocalBackend
          ? ((resolveFolderLocalConfig(activeDb, folder) ?? { localPath: "" }).localPath)
          : folder.name;
      lines.push(`remote = ${backendName}:${cryptRemoteBase}`);
      lines.push(`password = ${folder.cryptPassword}`);
      lines.push(`password2 = ${folder.cryptPassword}`);
      lines.push(`description = "${folder.name} (encrypted ${folder.type})"`);
      lines.push("");
    } else {
      if (folder.type === "dotfile") {
        lines.push(`[${remoteName}]`);
        lines.push("type = local");
        lines.push(`description = "${folder.name} (dotfile backup)"`);
        lines.push(`# local path on client: ${a.localPath}`);
        lines.push(`# server path: ${backupDir}/dotfiles/${folder.name}/`);
      } else if (useS3) {
        const backendName = `lamasync-${folder.id}-backend`;
        const s3 = resolveFolderS3Config(activeDb, folder);
        const wrote = s3 !== null
          ? writeS3Backend(backendName, folder, `${folder.name} (${folder.type}) — S3 backend`, a.localPath)
          : false;
        if (!wrote) continue;
        lines.push("");
        lines.push(`[${remoteName}]`);
        lines.push("type = alias");
        lines.push(`remote = ${backendName}:${(resolveFolderS3Config(activeDb, folder) ?? { bucket: "" }).bucket}`);
        lines.push(`description = "${folder.name} (${folder.type}) — S3 alias"`);
        lines.push(`# local path on client: ${a.localPath}`);
      } else if (useLocalBackend) {
        const backendName = `lamasync-${folder.id}-backend`;
        const wrote = writeLocalBackend(
          backendName,
          folder,
          `${folder.name} (${folder.type}) — ${backendKind} backend`,
          a.localPath,
        );
        if (!wrote) continue;
        lines.push("");
        lines.push(`[${remoteName}]`);
        lines.push("type = alias");
        lines.push(`remote = ${backendName}:${(resolveFolderLocalConfig(activeDb, folder) ?? { localPath: "" }).localPath}`);
        lines.push(`description = "${folder.name} (${folder.type}) — ${backendKind} alias"`);
        lines.push(`# local path on client: ${a.localPath}`);
      } else if (serverTailnetIp) {
        lines.push(`[${remoteName}]`);
        lines.push("type = sftp");
        lines.push(`host = ${serverTailnetIp}`);
        lines.push("user = lamasync");
        lines.push(`description = "${folder.name} (${folder.type})"`);
        lines.push(`# local path on client: ${a.localPath}`);
      } else {
        lines.push(`[${remoteName}]`);
        lines.push("type = local");
        lines.push(`description = "${folder.name} (${folder.type}) — server unavailable"`);
        lines.push(`# local path on client: ${a.localPath}`);
      }
      lines.push("");
    }
  }

  for (const p of peers) {
    // LAMA-223 P1-4: emit two rclone sections per peer when both addresses
    // are known — `lamasync-peer-<id>` (tailnet, preferred) and
    // `lamasync-peer-<id>-lan` (fallback). The daemon's `usePeer` TCP-probes
    // both and selects the reachable one. The previous single-section form
    // pinned the host at config-generation time, so a tailscale outage
    // stranded the peer entirely.
    const sections: Array<{ name: string; host: string; via: string }> = [];
    if (p.peerTailnetIp) {
      sections.push({ name: p.peerRemote, host: p.peerTailnetIp, via: "tailnet" });
      if (p.peerLanIp && p.peerLanIp !== p.peerTailnetIp) {
        sections.push({
          name: `${p.peerRemote}-lan`,
          host: p.peerLanIp,
          via: "lan",
        });
      }
    }
    // Last-resort fallback: only the LAN IP exists.
    if (sections.length === 0 && p.peerLanIp) {
      sections.push({ name: p.peerRemote, host: p.peerLanIp, via: "lan" });
    }
    for (const section of sections) {
      lines.push(`[${section.name}]`);
      lines.push("type = sftp");
      lines.push(`host = ${section.host}`);
      lines.push(`user = ${PEER_SFTP_USER}`);
      lines.push(
        `description = "LAN peer ${p.peerHostId} (${p.role}) via ${section.via} (${section.host})"`,
      );
      if (apiKey) {
        lines.push(`pass = ${apiKey}`);
      }
      lines.push("");
    }
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
        "SELECT id, hostname, tailnet_ip, last_seen, status, lan_ip, config_revision FROM hosts WHERE id = ?",
      )
      .get(hostId);
    if (!host) {
      set.status = 404;
      return { error: `Host '${hostId}' not found` };
    }
    const assignmentRows = activeDb
      .query<AssignmentRow, [string]>(
        `SELECT id, folder_id, host_id, role, local_path, remote_name, sync_expr, enabled,
                mode, conflict_strategy, pre_sync_cmd, post_sync_cmd, ignore_path, mount_ignore_path,
                timeout_sec, bandwidth_schedule, max_retries, available_space_threshold,
                cache_profile, cache_max_size, restic_repository, restic_password
         FROM folder_assignments WHERE host_id = ?`,
      )
      .all(hostId);

    const folderIds = Array.from(new Set(assignmentRows.map((r) => r.folder_id)));
    const folderRows = folderIds.length
      ? activeDb
          .query<FolderRow, string[]>(
            `SELECT id, name, type, created_at, encrypted, crypt_password, backend, backend_id, s3_bucket FROM folders WHERE id IN (${folderIds
              .map(() => "?")
              .join(",")})`,
          )
          .all(...folderIds)
      : [];

    const globalManifestRows = activeDb
      .query<ManifestRow, []>(
        `SELECT id, host_id, app_name, paths, excludes, schedule, instructions
         FROM dotfile_manifests WHERE host_id = '_global'`,
      )
      .all();
    const hostManifestRows = activeDb
      .query<ManifestRow, [string]>(
        `SELECT id, host_id, app_name, paths, excludes, schedule, instructions
         FROM dotfile_manifests WHERE host_id = ?`,
      )
      .all(hostId);
    const manifestRowsByApp = new Map<string, ManifestRow>();
    for (const r of globalManifestRows) manifestRowsByApp.set(r.app_name, r);
    for (const r of hostManifestRows) manifestRowsByApp.set(r.app_name, r);

    const allHostRows = activeDb
      .query<HostRow, []>(
        "SELECT id, hostname, tailnet_ip, last_seen, status, lan_ip, config_revision FROM hosts",
      )
      .all();

    const assignments = assignmentRows.map(rowToAssignment);
    const folders = folderRows.map(rowToFolder);
    const manifests = Array.from(manifestRowsByApp.values()).map(rowToManifest);

    // LAMA-232: restic-kind backends provide the default repository +
    // password for restic folders whose assignment doesn't override them.
    // The resolved password is decrypted here and travels only inside the
    // daemon-bound HostConfig, never back through the API surface.
    const resticDefaults = new Map<string, { repository: string; password: string }>();
    for (const folder of folders) {
      const resolved = resolveFolderResticConfig(activeDb, folder);
      if (resolved) {
        resticDefaults.set(folder.id, {
          repository: resolved.repository,
          password: resolved.password,
        });
      }
    }
    for (const assignment of assignments) {
      const def = resticDefaults.get(assignment.folderId);
      if (!def) continue;
      // Fill each field independently: an assignment overriding only the
      // repository still gets the backend's default password (and vice
      // versa) — otherwise a partial override silently degrades the backup
      // to a plain rclone copy (daemon-side hasResticConfig needs both).
      if (!assignment.resticRepository) assignment.resticRepository = def.repository;
      if (!assignment.resticPassword) assignment.resticPassword = def.password;
    }

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
        configRevision: host.config_revision ?? 0,
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
