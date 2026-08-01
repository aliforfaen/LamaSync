// Core wire/DB types — single source of truth for the whole system.

export type HostStatus = "online" | "offline" | "degraded" | "unknown";

export type FolderType = "sync" | "mount" | "backup" | "dotfile" | "git";
export type FolderBackend = "sftp" | "s3" | "local";
export type S3Provider = "exoscale" | "aws" | "other";

export type OperationStatus =
  | "started"
  | "success"
  | "failed"
  | "conflict"
  | "recovery"  // bisync state was corrupted and recovered
  | "retry";    // transient failure, will retry

export type ConflictStrategy =
  | "newer_wins"
  | "source_wins"
  | "keep_both"
  | "manual";

export type ConflictStatus = "pending" | "resolved";

export type ConflictResolution = "local" | "remote" | "both";

// Structured error envelope returned by API routes.
export interface ErrorResponse {
  error: string;
}

// rclone VFS cache profiles for mount type
export type CacheProfile = "normal" | "media" | "minimal";

// Active lock state for concurrent sync prevention
export interface LockInfo {
  folderId: string;
  lockedBy: string;
  lockedAt: number;
  lockTtl: number;
}

// Mount registry entry (daemon-side, exposed via socket)
export interface MountEntry {
  folderId: string;
  pid: number;
  path: string;
  cacheDir: string;
  startedAt: number;
  status: "starting" | "mounted" | "dead" | "unmounting";
  restartCount: number;
  cacheProfile: CacheProfile;
}

// rclone filter mode for selective sync
export type FilterMode = "sync" | "mount";

export interface Host {
  id: string;
  hostname: string;
  tailnetIp?: string | null;
  lanIp?: string | null;
  lastSeen?: number | null;
  status: HostStatus;
  // LAMA-199: daemon-reported version stored at last heartbeat. `null` when
  // the daemon has never reported one. `updateAvailable` is derived server-
  // side by comparing against the latest GitHub release.
  version?: string | null;
  updateAvailable?: boolean;
  // LAMA-198: server-side config revision counter. Bumped on any folder,
  // assignment, or dotfile change so daemons can detect "config drift" and
  // pull a fresh `/config/:hostId` without waiting for the 5-min refresh.
  configRevision?: number | null;
}

// LAMA-198: queued-action model. The control plane (Web UI) enqueues actions
// for a specific host; the daemon polls `GET /api/v1/actions/pending`,
// executes each one, and acks via `POST /api/v1/actions/:id/complete`. The
// completion also inserts an `operation_log` row so the audit trail is
// uniform with the regular sync/backup reports.
export type QueuedActionType =
  | "trigger_sync"
  | "trigger_backup"
  | "check_update"
  | "refresh_config";

export type QueuedActionStatus = "pending" | "taken" | "done" | "failed";

export interface QueuedAction {
  id: string;
  hostId: string;
  type: QueuedActionType;
  payload: Record<string, unknown> | null;
  status: QueuedActionStatus;
  createdAt: number;
  takenAt?: number | null;
  completedAt?: number | null;
  result?: string | null;
}

export interface Folder {
  id: string;
  name: string;
  type: FolderType;
  createdAt?: number;
  encrypted?: boolean;
  cryptPassword?: string | null;
  gitProvider?: "git" | "gh" | null;
  gitRemote?: string | null;
  backend?: FolderBackend | null;
  s3Provider?: S3Provider | null;
  s3Endpoint?: string | null;
  s3Bucket?: string | null;
  s3AccessKeyId?: string | null;
  // Write-only credential (LAMA-178): accepted on create/update, but folder
  // CRUD responses always return null here. The plaintext value is only
  // exposed to daemons via the /config/:hostId rclone config endpoint.
  s3SecretAccessKey?: string | null;
  s3Region?: string | null;
}

export interface FolderAssignment {
  id: string;
  folderId: string;
  hostId: string;
  role: string; // "source" | "target" | "both"
  localPath: string;
  remoteName?: string | null;
  syncExpr?: string | null; // cron expression
  enabled: boolean;
  conflictStrategy?: ConflictStrategy | null;
  preSyncCmd?: string | null;
  postSyncCmd?: string | null;
  ignorePath?: string | null; // path to .lamasyncignore relative to localPath
  mountIgnorePath?: string | null; // path to .lamasyncmountignore (falls back to ignorePath)
  timeoutSec?: number | null; // per-operation timeout
  bandwidthSchedule?: string | null; // rclone --bwlimit schedule e.g. "08:00,512K 12:00,10M"
  maxRetries?: number | null; // max sync retries on transient failure (default 3)
  availableSpaceThreshold?: number | null; // bytes, skip sync if less than this free
  cacheProfile?: CacheProfile | null; // mount VFS cache profile
  cacheMaxSize?: string | null; // e.g. "1G" for --vfs-cache-max-size
  resticRepository?: string | null; // absolute path or rclone remote for restic snapshots
  resticPassword?: string | null; // restic repository password
}

export interface DotfileManifest {
  id: string;
  hostId: string;
  appName: string;
  paths: string[];
  excludes?: string[] | null;
  schedule?: string | null;
  instructions?: string | null;
  lastSyncAt?: number | null;
  lastSyncDirection?: "upload" | "download" | null;
  originalUploaderHostId?: string | null;
}

export interface DotfileVersion {
  id: string;
  manifestId: string;
  timestamp: number;
  tarballPath: string;
  sizeBytes?: number | null;
  checksum?: string | null;
  description?: string | null; // optional label, e.g. "before nvim plugin rewrite"
}

export interface Conflict {
  id: string;
  hostId: string;
  folderId: string;
  path: string;
  localMtime?: number | null;
  remoteMtime?: number | null;
  status: ConflictStatus;
  resolution?: ConflictResolution | null;
  createdAt: number;
  resolvedAt?: number | null;
}

export interface ResticSnapshot {
  id: string; // LamaSync snapshot row id
  snapshotId: string; // restic's own snapshot id (short or long)
  folderId: string;
  hostId: string;
  timestamp: number;
  paths: string[];
  sizeBytes?: number | null;
  tags?: string[];
}

export interface ResticRestoreJob {
  id: string;
  snapshotId: string;
  folderId: string;
  targetHostId: string;
  targetPath: string;
  include?: string[] | null;
  status: "pending" | "running" | "done" | "failed";
  createdAt: number;
  resolvedAt?: number | null;
  error?: string | null;
}

export interface OperationLog {
  id: number;
  timestamp: number;
  hostId: string;
  folderId?: string | null;
  operation: string;
  status: OperationStatus;
  summary?: string | null;
  details?: string | null;
  durationMs?: number | null;
}

export type NotificationSeverity = "critical" | "default" | "info";

export type NotificationType =
  | "operation_failed"
  | "operation_success"
  | "conflict_pending"
  | "host_offline"
  | "host_online"
  | "update_available"
  | "restore_failed"
  | "restore_done"
  | "test";

export interface NotificationEvent {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  message: string;
  hostId?: string | null;
  folderId?: string | null;
  payload: Record<string, unknown> | null;
  createdAt: number;
  ntfyDelivered: boolean;
  webhookDelivered: boolean;
}

// API request/response shapes
export interface HealthResponse {
  status: "ok";
  hostCount: number;
  onlineCount: number;
  hosts: Host[];
}

export interface HostConfig {
  host: Host;
  assignments: FolderAssignment[];
  folders: Folder[];
  manifests: DotfileManifest[];
  rcloneConfig: string;
  serverTailnetIp: string | null;
  // LAN peers detected at config-generation time. When the current host's
  // role is "serve", the daemon will spawn `rclone serve sftp` so the peer
  // can sync directly. When the role is "use", the daemon can swap the
  // server-relayed remote for `peerRemote` for the listed folder ids.
  peers: Peer[];
}

// LAN direct peer entry — server-detected same-/24 host that can be reached
// without going through the public server. The server picks a single
// consistent role (serve or use) for the pair so both sides agree.
export type PeerRole = "serve" | "use";

export interface Peer {
  peerHostId: string;
  peerLanIp: string;
  peerRemote: string; // rclone section name in HostConfig.rcloneConfig
  role: PeerRole;
  folderIds: string[]; // folder ids whose rclone remotes can be replaced with the peer
}

export interface HealthReport {
  hostId: string;
  timestamp: number;
  status: HostStatus;
  uptimeSec?: number;
  lanIp?: string | null;
  // LAMA-199: optional daemon version. Heartbeats without a `version`
  // preserve whatever the daemon reported last, so transient blank reports
  // don't downgrade the stored value.
  version?: string | null;
}

export interface OperationReport {
  hostId: string;
  folderId?: string | null;
  operation: string;
  status: OperationStatus;
  summary?: string | null;
  details?: string | null;
  timestamp?: number;
  durationMs?: number | null;
  // Dotfile deployment tracking (LAMA-168): when set, the report also updates
  // the matching dotfile manifest's lastSyncAt/lastSyncDirection.
  dotfileAppName?: string | null;
  dotfileDirection?: "upload" | "download" | null;
}

// WebSocket event payload broadcast on /api/v1/ws
export type WSEvent =
  | { kind: "operation"; entry: OperationLog }
  | { kind: "host"; host: Host }
  | { kind: "lock"; folderId: string; hostId: string; action: "acquired" | "released"; status?: string; lockId?: string }
  | { kind: "mount"; folderId: string; status: MountEntry["status"]; path: string }
  | { kind: "conflict"; conflict: Conflict }
  | { kind: "restic_snapshot"; snapshot: ResticSnapshot }
  | { kind: "restic_restore"; job: ResticRestoreJob }
  | { kind: "action"; action: QueuedAction };

export interface PruneResult {
  deleted: number;
  olderThanMs: number;
}

// Network share definition (NFS / SMB). The server exposes its list via
// GET /api/v1/shares; the TUI renders an fstab line per share.
export interface Share {
  id: string;
  name: string;
  server: string;
  path: string;
  type: "nfs" | "smb";
  options: string;
}

// LAMA-202: read-only Data Browser entries.
export interface BrowseEntry {
  name: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
  folderId?: string;
}

export interface BrowseResponse {
  backend: "local" | "s3";
  path: string;
  entries: BrowseEntry[];
}

