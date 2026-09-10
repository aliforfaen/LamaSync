// Core wire/DB types — single source of truth for the whole system.

export type HostStatus = "online" | "offline" | "degraded" | "unknown";

// LAMA-298: host "class" — what kind of device this is. Drives per-class
// icons in the web-ui, offline-notification routing (laptops/phones are
// expected to sleep; servers are not), and the fleet-degraded status (only
// an always-on host going stale degrades the fleet).
export type HostClass =
  | "server"
  | "desktop"
  | "laptop"
  | "nas"
  | "phone"
  | "tablet"
  | "unknown";

export type FolderType = "sync" | "mount" | "backup" | "dotfile" | "git";
export type FolderBackend = "sftp" | "s3" | "local" | "nfs" | "restic";
// `b2` uses Backblaze's S3-compatible API (rather than rclone's separate
// native `b2` remote) so it shares the reusable S3 backend model.
export type S3Provider = "exoscale" | "aws" | "b2" | "other";

export type OperationStatus =
  | "started"
  | "success"
  | "failed"
  | "conflict"
  | "recovery"  // bisync state was corrupted and recovered
  | "retry"     // transient failure, will retry
  | "deferred"; // lock contention or control-plane outage; no transfer started, will retry

// LAMA-222: first-class reusable backend (S3 today; local/nfs/restic future).
export type BackendKind = "s3" | "local" | "nfs" | "restic";

/**
 * A reusable storage backend. `Folder.backend` references `Backend.id`;
 * S3 credentials are stored once here instead of per-folder. Secrets are
 * encrypted at rest (AES-256-GCM under LAMASYNC_SECRET_KEY); the plaintext
 * never appears in API responses — `hasSecret` is the write-only signal.
 */
export interface Backend {
  id: string;
  /** User-facing label; unique across all backends. */
  name: string;
  kind: BackendKind;
  // s3-specific:
  s3Provider?: S3Provider | null;
  s3Endpoint?: string | null;
  s3Region?: string | null;
  s3AccessKeyId?: string | null;
  /** True when an encrypted secret is stored (UI shows masked value). */
  hasSecret?: boolean;
  /** Write-only: accepted on create/update, never returned. */
  s3SecretAccessKey?: string | null;
  // local / nfs-specific: server-side directory path (rclone type = local).
  localPath?: string | null;
  // restic-specific: centralized repository + password for the
  // per-assignment restic execution path. The password is write-only
  // (hasResticPassword reports presence, mirroring hasSecret).
  resticRepository?: string | null;
  /** True when an encrypted restic password is stored. */
  hasResticPassword?: boolean;
  /** Write-only: accepted on create/update, never returned. */
  resticPassword?: string | null;
  createdAt: number;
  // LAMA-266: most recent successful-or-not "prove it" restore stamp.
  // `lastProveAt` is epoch ms (null = never proven); `lastProveOk` is the
  // boolean outcome of that run. The UI renders a "Verified 2h ago" badge
  // from this pair without re-running the test. Additive: existing rows
  // report null/null and the badge shows "not yet verified".
  lastProveAt?: number | null;
  lastProveOk?: boolean | null;
}

/** Account-level B2 credential used only for bucket management. It stays
 * separate from per-destination transfer credentials and is write-only. */
export interface B2ManagementConfig {
  endpoint: string;
  region: string;
  applicationKeyId: string;
  hasApplicationKey: boolean;
}

// LAMA-259: one row in the folder-scoped backup-history slider. Shape is
// intentionally thinner than `ResticSnapshot` so the wire is small (the
// Data Browser may render hundreds of these in a scrubber) and so we can
// rearrange internals without a contract change. `id` is restic's own
// snapshot id (matches the `restic_snapshots.snapshot_id` column) — that
// is what the slider feeds back into
// `GET /folders/:folderId/snapshots/:snapshotId/files` to drill in.
export interface FolderSnapshot {
  /** Restic's snapshot id (NOT the LamaSync internal `restic_snapshots.id`). */
  id: string;
  /** Epoch ms when the snapshot was taken. */
  time: number;
  /** Host that produced the snapshot (matches `ResticSnapshot.hostId`). */
  host?: string | null;
  /** Source paths recorded by restic at backup time. */
  paths?: string[];
}

export interface FolderSnapshotsResponse {
  snapshots: FolderSnapshot[];
}

// LAMA-221: configurable notification delivery channels (ntfy / webhook).
export type NotificationChannelKind = "ntfy" | "webhook";

export interface NotificationChannel {
  id: string;
  kind: NotificationChannelKind;
  name: string;
  url: string;
  enabled: boolean;
  /** Severity levels this channel delivers (allowlist). */
  severities: NotificationSeverity[];
  lastDeliveryStatus: "success" | "failed" | null;
  lastDeliveryAt: number | null;
  createdAt: number;
}

// LAMA-225: host rename request body (PATCH /hosts/:id).
export interface PatchHost {
  hostname: string;
}

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

// LAMA-239: per-host override for folders whose folder.type is "sync" or
// "mount". "inherit" falls back to the folder-level type; "sync"/"mount"
// force the effective type for this host. No-op for backup/dotfile/git
// folders (see effectiveFolderType in ./effective-type.ts).
export type AssignmentMode = "inherit" | "sync" | "mount";

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
  // LAMA-282: device OS label + storage used, reported by the daemon on
  // each heartbeat for the device cards. `os` is a display string
  // (e.g. "Linux 6.8.0"); `storageUsedBytes` is the bytes used on the
  // device's primary filesystem.
  os?: string | null;
  storageUsedBytes?: number | null;
  // LAMA-298: daemon-detected host class (server/laptop/phone/...). The
  // daemon seeds it on first heartbeat; the operator can override it in
  // the web-ui. `unknown` is the fallback for legacy rows / uncertainty.
  hostClass?: HostClass;
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
  | "refresh_config"
  // LAMA-299: admin-initiated remote daemon update. No caller-provided
  // payload — the daemon always targets the latest release via the server's
  // release proxy and picks its own supported asset. Older daemons report
  // this as an unknown action type, so the UI gates the button on
  // REMOTE_DAEMON_UPDATE_MIN_VERSION (see ./remote-update.ts).
  | "update_daemon";

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

// LAMA-260: response shape for `POST /folders/:id/files` (multipart
// upload). Distinct from the browse-job model — this is a synchronous
// `rclone copyto` pushed onto the folder's destination backend, not an
// async tracked job. The file is server-resident long enough to be
// spawned by rclone, then removed.
export interface FolderFileUploadResponse {
  ok: true;
  name: string;
  /** Combined target path relative to the folder's destination root.
   *  Empty string when the file was uploaded to the root. */
  path: string;
  /** Bytes written to the destination (post-cap, matching the body
   *  length the server streamed to its temp file). */
  size: number;
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
  // LAMA-222: `backend` is the kind (sftp/local/s3); `backendId` references
  // the reusable Backend row that holds S3 credentials. For s3 folders only
  // the bucket name stays per-folder — endpoint/keys/region live on Backend.
  backend?: FolderBackend | null;
  backendId?: string | null;
  s3Bucket?: string | null;
}

// LAMA-222: fully-resolved S3 settings for a folder, produced server-side
// by joining the folder's backendId against the backends table and
// decrypting the stored secret. Only used internally (rclone config
// generation, Data Browser, stats) — never exposed on the wire.
export interface S3FolderConfig {
  folderId: string;
  backendId: string;
  provider: S3Provider;
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string | null;
}

// LAMA-232/hidden-api-power: fully-resolved settings for the `local` /
// `nfs` backend kinds — a server-side directory the server can rclone
// against (an attached disk, or an NFS export already mounted on the
// server). Produced server-side; never exposed on the wire.
export interface LocalFolderConfig {
  folderId: string;
  backendId: string;
  /** Absolute server-side directory (rclone type = local). */
  localPath: string;
}

// LAMA-232/hidden-api-power: fully-resolved restic defaults. The
// per-assignment resticRepository/resticPassword overrides keep working;
// this backend is the default when the assignment doesn't override.
export interface ResticBackendConfig {
  backendId: string;
  repository: string;
  /** Decrypted password — callers must never log or return it. */
  password: string;
}

export interface FolderAssignment {
  id: string;
  folderId: string;
  hostId: string;
  role: string; // "source" | "target" | "both"
  localPath: string;
  remoteName?: string | null;
  // LAMA-294: explicit destination path/prefix on the remote, distinct from
  // the connection alias (remoteName). Host-scoped by default for backups
  // (e.g. "<folder-name>/<host-id>") so different hosts don't merge or
  // starve each other; sync/mount stay shared ("<folder-name>"). The
  // canonical destination key (see ./destination.ts) is derived from this
  // and is the server-side lock identity. null/omitted => derived default.
  destination?: string | null;
  syncExpr?: string | null; // cron expression
  enabled: boolean;
  // LAMA-239: per-host override. "inherit" (the default) lets the
  // folder-level type decide; "sync"/"mount" forces the effective type for
  // this host — useful for "sync on most hosts, mount on the resource-
  // constrained one" without changing the folder globally. Only honored
  // when folder.type is "sync" or "mount" (see effectiveFolderType).
  mode?: AssignmentMode;
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
  // LAMA-302: event-triggered sync for active local worktrees. Watch settings
  // are only honored for effective `sync` assignments (see effectiveFolderType)
  // and are opt-in / default-off. `watchQuietSec` is the debounce window after
  // the last local change before one debounced `runOnce`; null => the 30 s
  // default (validated 10-300 at the API boundary). `ignoreGitMetadata`
  // excludes the `.git/` tree from both watcher significance and the
  // rclone/bisync filter; `respectGitignore` applies Git's actual ignore
  // semantics (nested .gitignore, negations, .git/info/exclude, global
  // excludes) via a deterministic filter snapshot rather than passing
  // `.gitignore` straight to rclone.
  watchEnabled?: boolean;       // default false
  watchQuietSec?: number | null; // null => 30; validated range 10-300 seconds
  ignoreGitMetadata?: boolean;   // default false; exclude .git/
  respectGitignore?: boolean;    // default false; apply Git ignore semantics
}

// ---------------------------------------------------------------------------
// LAMA-316 — application templates, protections, snapshots (canonical "apps"
// contract). This replaces the dotfile-manifest/profile/version model above.
// ---------------------------------------------------------------------------

/** LAMA-315: stable path taxonomy. Classifications are suggestions for
 *  planning/review — nothing consumes a class to change capture or exclusion.
 *  `unknown` is "not yet classified" and stays visibly unknown; `custom` is
 *  an operator's explicit assignment. */
export type PathClassification =
  | "portable_config"
  | "machine_state"
  | "cache"
  | "secrets"
  | "custom"
  | "unknown";

/** LAMA-315: provenance of a path's `classification` value.
 *  - `default`    untouched initial state — always `unknown`.
 *  - `suggested`  placed by the deterministic recommender, not yet
 *                 operator-confirmed. Carries the matching `confidence`.
 *  - `manual`     operator override/confirmation — the only source that
 *                 locks a recommendation in; confidence is dropped. */
export type ClassificationSource = "default" | "suggested" | "manual";

/** A single classified path entry inside a capture spec. */
export interface CaptureSpecPath {
  path: string;
  classification: PathClassification;
  rationale?: string | null;
  /** LAMA-315: provenance of `classification`; absent/null reads as
   *  `"default"` on the wire (legacy entries round-trip as unknown/default). */
  classificationSource?: ClassificationSource | null;
  /** 0..1 — present only when `classificationSource === "suggested"`.
   *  Dropped/ignored for `manual`; null for `default`. */
  confidence?: number | null;
  /** Snapshot-only deterministic archive member root. Never client supplied. */
  archivePath?: string | null;
}

/** The named capture-spec shape (replaces anonymous OS-keyed JSON). Extensible
 *  for LAMA-315. `notes` carries operator instructions about the recipe. */
export interface CaptureSpec {
  paths: {
    linux?: CaptureSpecPath[];
    macos?: CaptureSpecPath[];
    windows?: CaptureSpecPath[];
  };
  excludes: string[];
  notes: string | null;
}

/** Operator-owned reusable recipe. Never a fleet rollout policy. */
export interface ApplicationTemplate {
  id: string;
  name: string;
  origin: "built_in" | "custom";
  description: string | null;
  emoji: string | null;
  color: string | null;
  /** Candidate paths keyed by OS. */
  paths: CaptureSpec;
  installUrl: string | null;
  installInstructions: string | null;
  restoreInstructions: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** The only object that makes a template active on one machine. */
export interface ApplicationProtection {
  id: string;
  templateId: string;
  templateRevision: number;
  hostId: string;
  name: string;
  enabled: boolean;
  schedule: string | null;
  /** Display destination label. `server_archive` when backendId is null,
   *  otherwise the backend's name (LAMA-324: destinations are selectable). */
  destination: string;
  /** LAMA-324: backend future captures are relayed to; null = server
   *  archive. Controls FUTURE captures only — each snapshot persists its
   *  own immutable physical location. */
  backendId: string | null;
  /** Backend name for display; null when backendId is null. List DTOs
   *  carry it so the UI does not N+1 fetch backends (LAMA-324). */
  backendName: string | null;
  /** LAMA-324: bucket for s3-kind backends (required then); null for
   *  local/nfs kinds and server archive. */
  s3Bucket: string | null;
  /** Copied at enrollment; never mutated by template edits. */
  captureSpec: CaptureSpec;
  createdAt: number;
  updatedAt: number;
}

/** Immutable archive metadata — not a mutable version of the template. */
export interface ApplicationSnapshot {
  id: string;
  protectionId: string;
  templateId: string;
  templateRevision: number;
  sourceHostId: string;
  createdAt: number;
  /** Location path within the snapshot's destination. For server-local
   *  archives this is BACKUP_DIR-relative; for backend snapshots it is the
   *  backend-relative object key (same value as objectKey). */
  archivePath: string;
  /** LAMA-324: immutable physical backend this snapshot lives on (null =
   *  server-local archive). Frozen at capture time; never derived from the
   *  protection's current backend. */
  backendId: string | null;
  /** Backend-relative object key when backendId is non-null, else null. */
  objectKey: string | null;
  /** LAMA-324: bucket the object lives in (s3-kind snapshots only). */
  s3Bucket: string | null;
  archiveFormat: "tar.gz";
  sizeBytes: number | null;
  checksumSha256: string | null;
  description: string | null;
  /** Exact host OS bucket and archive mapping captured at capture time. */
  capturedSpec: CaptureSpec;
  integrityStatus: "verified" | "unverified" | "failed";
}

/** Daemon wire entry delivered inside HostConfig for capture. Replaces
 *  dotfile-manifest wire entry in that contract. */
export interface AppCaptureAssignment {
  appName: string;
  hostId: string;
  protectionId: string;
  /** Logical configured paths, retained so the archive layout is portable. */
  paths: string[];
  /** Daemon-local path expansion paired by index with `paths`. */
  resolvedPaths?: string[];
  excludes?: string[] | null;
  schedule?: string | null;
  instructions?: string | null;
}

/** Concise protection list row (JOINs template identity and latest snapshot)
 *  so list UIs need no N+1 fetches (LAMA-316). */
export interface ApplicationProtectionListItem extends ApplicationProtection {
  templateOrigin: "built_in" | "custom";
  templateName: string;
  templateEmoji: string | null;
  templateColor: string | null;
  latestSnapshot:
    | { id: string; createdAt: number; sizeBytes: number | null; integrityStatus: string }
    | null;
}

export interface Conflict {
  id: string;
  hostId: string;
  folderId: string;
  path: string;
  localMtime?: number | null;
  remoteMtime?: number | null;
  // LAMA-268: per-side file sizes for the side-by-side conflict cards.
  // The daemon stats the local file; `remoteSizeBytes` is null when the
  // remote size is unknown (no extra rclone call) — the UI renders "—".
  localSizeBytes?: number | null;
  remoteSizeBytes?: number | null;
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

// LAMA-302: who kicked off an operation — the local filesystem watcher
// (`watch`), the periodic cron schedule (`schedule`), or an operator action
// (`manual`, e.g. socket sync / queued action). Additive; older rows report
// null.
export type TriggerOrigin = "watch" | "schedule" | "manual";

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
  trigger?: TriggerOrigin | null;
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

// LAMA-264: demo-mode state. Returned by GET /api/v1/demo so the web UI
// can decide between a "See a demo fleet" entry point and an active-demo
// banner with a "Delete demo data" action. `counts` reflects only rows
// flagged demo = 1; real data is never counted here.
export interface DemoState {
  hasDemo: boolean;
  counts: {
    hosts: number;
    folders: number;
    assignments: number;
    operations: number;
    snapshots: number;
    manifests: number;
    templates: number;
    protections: number;
    appSnapshots: number;
  };
}

// LAMA-264: summary returned after a demo seed, so the UI can confirm what
// was created. Mirrors the per-table demo counts.
export interface DemoSeedSummary {
  hosts: number;
  folders: number;
  assignments: number;
  backends: number;
  operations: number;
  snapshots: number;
  manifests: number;
  templates: number;
  protections: number;
  appSnapshots: number;
  /** Number of seeded pending conflicts (LAMA-268). */
  conflicts?: number;
  /** Server-side seed directory the demo file viewer reads from. */
  seedDir: string;
}

// API request/response shapes
export interface HealthResponse {
  status: "ok";
  hostCount: number;
  onlineCount: number;
  hosts: Host[];
  // UX workstream 4: server self-description for the Admin page.
  serverVersion: string;
  dbSizeBytes: number | null;
}

// UX workstream 4: shape of `GET /api/v1/release/latest` (the server proxies
// the GitHub latest release; shared so the web UI can render the Admin
// update badge without importing server-only code).
export interface ReleaseAssetView {
  name: string;
  downloadUrl: string;
  size: number;
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  publishedAt: string;
  assets: ReleaseAssetView[];
}

export interface HostConfig {
  host: Host;
  assignments: FolderAssignment[];
  folders: Folder[];
  apps: AppCaptureAssignment[];
  rcloneConfig: string;
  serverTailnetIp: string | null;
  // LAN peers detected at config-generation time. When the current host's
  // role is "serve", the daemon will spawn `rclone serve sftp` so the peer
  // can sync directly. When the role is "use", the daemon can swap the
  // server-relayed remote for `peerRemote` for the listed folder ids.
  peers: Peer[];
  // LAMA-273: effective pause for this host. Resolved by the server as
  // (host row if present, else global row); expired rows are pruned on
  // read so daemons see `null` for past windows. The daemon honors this
  // by skipping scheduled runs while `until > now` and (in slow mode)
  // appending `--bwlimit` to its rclone argv via the existing
  // bandwidthSchedule plumbing. Additive: existing daemons without the
  // pause handler ignore it without any change in behavior.
  pause?: EffectivePause | null;
}

// LAN direct peer entry — server-detected same-/24 host that can be reached
// without going through the public server. The server picks a single
// consistent role (serve or use) for the pair so both sides agree.
export type PeerRole = "serve" | "use";

export interface Peer {
  peerHostId: string;
  peerLanIp: string;
  // LAMA-223: the peer's tailnet (100.x.x.x) address when reported; the
  // rclone SFTP section prefers this over peerLanIp.
  peerTailnetIp?: string | null;
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
  // LAMA-223: daemon-reported tailnet (100.x.x.x / fd7a:...) address.
  // When the tailnet interface is down the daemon reports null and the
  // server config generator falls back to lanIp for peer SFTP targets.
  tailnetIp?: string | null;
  // LAMA-199: optional daemon version. Heartbeats without a `version`
  // preserve whatever the daemon reported last, so transient blank reports
  // don't downgrade the stored value.
  version?: string | null;
  // LAMA-282: device OS label + bytes used on the primary filesystem,
  // reported by the daemon on each heartbeat.
  os?: string | null;
  storageUsedBytes?: number | null;
  // LAMA-298: daemon-detected host class, reported on each heartbeat so
  // the server can route offline notifications and fleet status by class.
  hostClass?: HostClass;
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
  // LAMA-302: which path started this run (watch / schedule / manual).
  trigger?: TriggerOrigin | null;
  // Dotfile deployment tracking (LAMA-168): when set, the report also updates
  // the matching dotfile manifest's lastSyncAt/lastSyncDirection.
  dotfileAppName?: string | null;
  dotfileDirection?: "upload" | "download" | null;
}

// LAMA-294: orphaned legacy shared backup data under backup folder roots.
// Reports (dry-run) and prune results for the `backup legacy-root` flow.
export interface LegacyRootOrphanEntry {
  folderId: string;
  folderName: string;
  remotePath: string;
  /** Top-level child name under the legacy root that is orphaned (or kept). */
  name: string;
  /** null when sizes were not requested (fast path) — see `?sizes=true`. */
  sizeBytes: number | null;
  itemCount: number | null;
  /** true when this child is a live host-scoped prefix (never pruned). */
  isHostPrefix: boolean;
  /** true when any live assignment explicitly uses this child/root. */
  isProtected: boolean;
}

export interface LegacyRootReport {
  folderId: string;
  folderName: string;
  remotePath: string;
  orphaned: LegacyRootOrphanEntry[];
  /** Total bytes of orphaned (non host-prefix) children only; null when
   *  sizes were not requested (fast path). */
  orphanedBytes: number | null;
}

export interface LegacyRootPruneResult {
  folderId: string;
  folderName: string;
  remotePath: string;
  pruned: string[];
  skippedHostPrefixes: string[];
  errors: string[];
}

// -------------------------------------------------------------------------
// LAMA-327 — live rclone sync phases (non-terminal, in-memory, WS-delivered)
// -------------------------------------------------------------------------

/**
 * Live phase of one daemon rclone run. Phases are driven by REAL rclone
 * `--use-json-log` INFO messages and daemon lifecycle milestones — never
 * invented progress. `enumerating` is the honest generic for bisync's
 * `Building Path1 and Path2 listings` (it lists BOTH sides in one phase and
 * the daemon cannot attribute one side); `enumerating_local` /
 * `enumerating_remote` exist in the contract for future single-side ops.
 * `working` is the honest fallback while rclone runs without emitting a
 * recognisable phase signal (e.g. a one-way `copy` planning a large
 * remote listing emits no INFO phase message before the first transfer).
 * `success` / `failed` are terminal: the server removes the registry entry
 * right after broadcasting the terminal event, so clients drop the row.
 */
export type LiveSyncPhase =
  | "queued" // run requested, waiting for the in-process/destination lock
  | "lock" // destination lock acquired
  | "preparing" // building command, filters, pre-hooks, disk checks
  | "enumerating" // bisync building both path listings (long on first runs)
  | "enumerating_local"
  | "enumerating_remote"
  | "reconciling" // comparing listings / building the change plan
  | "transferring" // copying/uploading with counters
  | "checking" // verifying files (checks counter advancing, no transfers)
  | "finalizing" // listing / state-db updates at the end of a run
  | "retrying" // transient failure; waiting before the next attempt
  | "working" // rclone running, no recognisable phase signal yet
  | "success" // terminal — entry removed after broadcast
  | "failed"; // terminal — entry removed after broadcast

/**
 * Daemon→server body of `POST /api/v1/sync-progress`. Deliberately narrow:
 * no credentials, no rclone argv, no raw config, and no server-owned fields
 * (`updatedAt` / `elapsedMs` are computed by the server). `detail` is a
 * single bounded line derived from rclone's own message text.
 */
export interface LiveSyncProgressUpdate {
  runId: string;
  hostId: string;
  /** Display label — the daemon's last known hostname (server trusted). */
  hostname?: string | null;
  folderId?: string | null;
  folderName?: string | null;
  /** Folder type driving the run (`sync` / `backup` / `mount` / ...). */
  operation: string;
  phase: LiveSyncPhase;
  /** Epoch ms the run started — anchor for elapsed-time ticking. */
  startedAt: number;
  /** Epoch ms the current phase started. */
  phaseStartedAt: number;
  transfers?: number | null;
  bytes?: number | null;
  checks?: number | null;
  errors?: number | null;
  files?: number | null;
  /** Bounded one-line detail — never credentials, argv, or raw config. */
  detail?: string | null;
}

/**
 * Full wire shape of a live sync run as broadcast on the `sync_progress`
 * WebSocket event and returned by the admin hydration read
 * (`GET /api/v1/sync-progress`). `updatedAt` / `elapsedMs` are always
 * refreshed by the server at broadcast/read time so reconnecting clients
 * see a live elapsed value even when only counters are throttled.
 */
export interface LiveSyncProgress extends Omit<LiveSyncProgressUpdate, "detail"> {
  /** Epoch ms of the last server-side update/broadcast. */
  updatedAt: number;
  /** Server-computed: `updatedAt - startedAt` (live elapsed). */
  elapsedMs: number | null;
  detail?: string | null;
}

/** Wire body of `GET /api/v1/sync-progress` (hydration for reconnecting
 *  admin/reconnecting clients). Active non-terminal runs only. */
export interface LiveSyncProgressList {
  runs: LiveSyncProgress[];
}

// WebSocket event payload broadcast on /api/v1/ws
export type WSEvent =
  | { kind: "operation"; entry: OperationLog }
  | { kind: "host"; host: Host }
  // LAMA-225: emitted after a host rename (id == hostname). The UI shows a
  // banner and re-fetches host lists; other fields reference the NEW id.
  | { kind: "host_renamed"; oldId: string; newId: string; hostname: string }
  | { kind: "lock"; folderId: string; hostId: string; action: "acquired" | "released" | "reaped"; status?: string; lockId?: string; destinationKey?: string }
  | { kind: "mount"; folderId: string; status: MountEntry["status"]; path: string }
  | { kind: "conflict"; conflict: Conflict }
  | { kind: "restic_snapshot"; snapshot: ResticSnapshot }
  | { kind: "restic_restore"; job: ResticRestoreJob }
  | { kind: "action"; action: QueuedAction }
  // LAMA-226: Data Browser write-operation progress.
  | { kind: "browse_job"; job: BrowseJob }
  // LAMA-301: server-deploy job state change (pending/running/succeeded/
  // failed). Broadcast so the Admin card can reconnect after the expected
  // server restart mid-deploy.
  | { kind: "server_deploy"; job: ServerDeployJob }
  // LAMA-327: live non-terminal rclone sync phase. Sent on phase transitions
  // and throttled counter snapshots; a terminal phase (success/failed) is
  // broadcast once and then the entry is removed from the server registry.
  | { kind: "sync_progress"; progress: LiveSyncProgress };

export interface PruneResult {
  deleted: number;
  olderThanMs: number;
}

// P-B op-log archival (cleanup #6): count of rows included in an export,
// the on-disk path of the resulting archive, and the rows removed from
// the DB after a successful archive write. `file` is `null` when nothing
// was exported (zero rows in the cutoff window — the call is still 200
// and idempotent so the daily timer can re-fire safely).
export interface OperationLogExport {
  archived: number;
  file: string | null;
  deleted: number;
  olderThanMs: number;
  targetDir: string;
}

// Network share definition (NFS / SMB). The server exposes its list via
// GET /api/v1/shares; clients can render an fstab line per share.
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

// LAMA-321: one detected freedesktop trash directory inside a browse
// listing. Only two exact layouts are recognized at the listed directory's
// root: `.Trash-<numeric uid>` and `.Trash/<numeric uid>` (the latter only
// when the `.Trash` directory actually contains that numeric-uid child).
// `prefix` is the trash location relative to the listing path — the same
// value the size/delete browse operations accept as a `prefix`/`name`.
export interface BrowseTrash {
  /** Numeric uid that owns the trash (e.g. 1000). */
  uid: number;
  /** Folder-relative trash prefix, e.g. ".Trash-1000" or ".Trash/1000". */
  prefix: string;
}

// LAMA-321: computed recursive size of one folder-relative prefix, produced
// by an async browse "size" job and cached server-side. `calculatedAt` is
// the epoch-ms timestamp of the measurement.
export interface BrowsePrefixSize {
  objectCount: number;
  bytes: number;
  calculatedAt: number;
}

/** Response of `GET /browse/size` — a fresh cache hit or a miss (the client
 *  then POSTs `/browse/size` to start the async measurement job). */
export type BrowsePrefixSizeResult =
  | { cached: true; objectCount: number; bytes: number; calculatedAt: number }
  | { cached: false };

// LAMA-259: the Data Browser's "history" mode renders files from inside a
// restic snapshot instead of from a live filesystem. `backend` discriminates
// the source so the UI can render either shape with a single switch.
export type BrowseBackend = "local" | "s3" | "restic-snapshot";

export interface BrowseResponse {
  backend: BrowseBackend;
  path: string;
  entries: BrowseEntry[];
  // LAMA-321: present only when the listing's directory entries contain one
  // of the exact freedesktop trash layouts (see BrowseTrash). Populated for
  // live local/s3 listings, never for restic snapshots.
  trash?: BrowseTrash[];
  // LAMA-259: present only when backend === "restic-snapshot". Tells the
  // slider UI which snapshot (and folder) this listing came from so it can
  // re-fetch on path navigation without an extra round-trip.
  snapshotId?: string;
  folderId?: string;
}

// LAMA-224: storage statistics. The server computes each entry lazily and
// caches the report for 5 minutes so dashboard loads don't spawn a swarm of
// rclone/du processes. Backends with errors keep their entry (error set).
export interface StorageReport {
  generatedAt: number;
  totalBytes: number;
  backends: Array<{
    backendId: string | null; // null for local roots
    label: string; // e.g. "S3: backups-prod (s3.example.com)"
    kind: "local" | "s3" | "nfs" | "restic";
    bytes: number;
    objectCount: number | null;
    error: string | null;
  }>;
}

// LAMA-224/304: last-known size of one folder's working set (rclone size).
// S3-only: non-S3 folders are not measurable server-side (their paths live
// on daemon hosts) and return bytes: null (P1-7). S3 folders are measured per
// destination prefix (`stats:<bucket>/<prefix>` via LAMA-304), so a folder
// reports only its own prefixes, never the whole shared bucket.
//
// LAMA-328: reads are stale-while-revalidate. `measuredAt` is when `bytes` were
// really measured (null when nothing has ever been measured, or when the folder
// is not measurable server-side), while `stale`/`refreshing` describe the read
// itself: stale bytes are last-known, not current, and a bounded background
// refresh is scheduled or running for them.
export interface FolderSize {
  folderId: string;
  bytes: number | null;
  objectCount: number | null;
  error: string | null;
  measuredAt: number | null;
  stale?: boolean;
  refreshing?: boolean;
}

// LAMA-328: `GET /folders` carries each folder's assignments so the Folders
// page no longer issues one request per folder (the N+1 reported in LAMA-328).
// The embedded rows are summaries, not full assignments: a list read has no
// use for the restic repository password, and stamping it into every list
// response broadened plaintext-secret exposure across Dashboard/Folders/etc.
// (LAMA-328 review). `GET /folders/:id/assignments` and the daemon's
// `GET /config/:hostId` still return full `FolderAssignment` rows — those are
// the dedicated surfaces that actually need the override secret.
export type FolderAssignmentSummary = Omit<FolderAssignment, "resticPassword">;

export interface FolderWithAssignments extends Folder {
  assignments: FolderAssignmentSummary[];
}

// LAMA-226: Data Browser write operations. Jobs are created when an op
// starts, updated as entries complete (progress_bytes/total_bytes count
// entries when rclone byte-level stats are unavailable), and written to
// operation_log once terminal for the audit trail.
// LAMA-321: "size" is a read-only job — it measures the recursive size of
// one folder-relative prefix (paginated S3 listing / local walk) and seeds
// the browse size cache instead of mutating anything.
export type BrowseJobOperation =
  | "copy"
  | "move"
  | "upload"
  | "rename"
  | "mkdir"
  | "delete"
  | "size";
export type BrowseJobStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface BrowseJob {
  id: string;
  operation: BrowseJobOperation;
  source: string;
  destination: string;
  status: BrowseJobStatus;
  error: string | null;
  progressBytes: number | null;
  totalBytes: number | null;
  createdAt: number;
  updatedAt: number;
}

// LAMA-226: a source or destination reference for a browse operation.
// `local` paths are relative to the server's backup root (same root the
// read-only browser uses); `s3` references a folder's backend + prefix.
export interface BrowseRef {
  kind: "local" | "s3";
  folderId?: string | null;
  path: string;
}

// LAMA-273: pause / slow mode toggle. The fleet can be paused globally or
// per-device for a fixed window; slow mode caps rclone bandwidth via the
// existing `bandwidthSchedule` plumbing (single value, not a schedule).
// `until` is an ISO timestamp; the daemon treats rows past that instant as
// absent. `bwlimit` is a single rclone size string (e.g. "1M") — there's no
// support for schedules, only a flat cap, so the field is reused by the
// executor as a single-segment `--bwlimit` value.
export type PauseMode = "pause" | "slow";
export type PauseScope = "global" | "host";

export interface PauseState {
  scope: PauseScope;
  /** Present when scope === "host"; absent when scope === "global". */
  hostId?: string;
  /** ISO timestamp the pause window ends at. Past = effectively no pause. */
  until: string;
  mode: PauseMode;
  /** Single-segment bandwidth cap; honored only when mode === "slow". */
  bwlimit?: string | null;
}

/**
 * LAMA-273: effective pause for one host as resolved by the server. A daemon
 * pulls this from `/config/:hostId`; the server picks the host row when
 * present and falls back to the global row. `null` means "no pause applies"
 * (expired, absent, or a host row that's explicitly been cleared).
 */
export interface EffectivePause {
  until: string;
  mode: PauseMode;
  /** Single-segment bandwidth cap (e.g. "1M"); honored only when mode === "slow". */
  bwlimit: string | null;
}

// LAMA-266: one row in the `health_drills` table. `kind` distinguishes a
// manual "Prove it" (POST /backends/:id/prove) from a scheduled fire-drill
// (POST /backends/:id/drill or the monthly scheduler). `detail` is a
// scrubbed server-side summary — never raw restic stderr and never
// secrets. The summary shown to the UI is `summary` (kept inline on
// operation_log + health_drills.detail) plus `durationMs`/`checkedAt`.
export interface HealthDrill {
  id: string;
  backendId: string;
  kind: "prove" | "drill";
  ranAt: number;
  ok: boolean;
  detail: string | null;
}

// LAMA-262: pairing-session model. The web UI shows a short human code
// (`lama-72B4-9PQ1`) plus an optional QR; the device operator runs
// `lamasync register --code lama-72B4-9PQ1 --server URL` to exchange the
// code for an API key. Sessions are single-use: a successful
// `POST /pairing/:code/exchange` marks the row `used` and any second
// exchange returns 409. Expired sessions read as `expired` and cannot be
// exchanged (410 / 409 per the spec — see route for the exact contract).
// The code is the public identifier; the id is the row PK.
export type PairingSessionStatus = "pending" | "used" | "expired";

export interface PairingSessionCreateResponse {
  /** Human-readable code, e.g. `lama-72B4-9PQ1`. */
  code: string;
  /** TTL in seconds — operators can show a countdown from this. */
  expiresInSeconds: number;
}

export interface PairingSessionStatusResponse {
  status: PairingSessionStatus;
  /** ISO timestamp when the session expires (UTC). */
  expiresAt: string;
}

export interface PairingSessionExchangeResponse {
  /** The managed `device` API key minted by the exchange. Never the
   *  master `LAMASYNC_API_KEY` (LAMA-234). The field name is stable so
   *  registration clients keep working unchanged. */
  apiKey: string;
}

// LAMA-234: device-identity body for the pairing exchange. The code proves
// intent; hostId/hostname let the server bind the minted device key to the
// registering host so a compromised key is containable to one device.
export interface PairingSessionExchangeRequest {
  hostId: string;
  hostname: string;
}

// LAMA-234: managed API keys. The environment `LAMASYNC_API_KEY` remains the
// `master` credential; managed keys are `admin`, `device`, or (LAMA-301)
// `deploy`. Device keys are bound to one host and may only touch that
// host's resources. Deploy keys are the LXC-resident deploy agent's
// credential: they may only claim/progress/complete server-deploy jobs —
// never enqueue one, never touch any other route. A managed secret is
// surfaced exactly twice in its lifetime: at creation and on an explicit
// admin reveal. List/read responses carry masked metadata only.
export type ApiKeyKind = "admin" | "device" | "deploy";

/**
 * Resolved credential identity for one request, attached to the Elysia
 * context by the auth plugin (see server/src/auth.ts) and mirrored for
 * WebSocket subscriptions (server/src/ws.ts).
 */
export type AuthPrincipal =
  | { kind: "master"; keyId: null; hostId: null }
  | { kind: "admin"; keyId: string; hostId: null }
  | { kind: "device"; keyId: string; hostId: string }
  // LAMA-301: the deploy agent's dedicated principal. Narrowly scoped —
  // only the server-deploy claim/progress/complete routes admit it.
  | { kind: "deploy"; keyId: string; hostId: null }
  // LAMA-296: a mobile NATIVE credential (Android app bearer). Bound to one
  // mobile registration; allowed only on /api/v1/mobile/me + check-in, never
  // fleet admin, config, keys, or the web-session bootstrap.
  | { kind: "mobile"; hostId: string }
  // LAMA-296: a cookie-authenticated mobile WEB session (issued by the
  // web-session bootstrap). `admin` mirrors the web grant's admin snapshot;
  // admin sessions map to admin REST permissions. Mutations under this
  // principal require the session CSRF token + an exact trusted Origin.
  | {
      kind: "web-session";
      sessionId: string;
      hostId: string;
      admin: boolean;
      /** Session-bound CSRF token (derived from the cookie secret). */
      csrfToken: string;
      /** Absolute epoch-ms session expiry. */
      expiresAt: number;
      /** Registration display name (labels /auth/me and audits). */
      displayName: string;
      /** Registration client family (android in phase 1). */
      clientType: MobileClientType;
    };

/** Masked managed-key metadata. Deliberately contains no secret material. */
export interface ApiKeySummary {
  /** Public opaque key id; also embedded in the token for O(1) lookup. */
  id: string;
  name: string;
  kind: ApiKeyKind;
  /** Present and required when kind === "device"; null for admin keys. */
  hostId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  revealedAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
  /** Short digest of the token hash, e.g. "a3f2b9c01d" — for display/masking. */
  fingerprint: string;
}

export interface ApiKeyCreateRequest {
  name: string;
}

export interface ApiKeyCreateResponse {
  key: ApiKeySummary;
  /** Raw token. Returned exactly once, at creation. */
  secret: string;
}

export interface ApiKeyRevealResponse {
  id: string;
  secret: string;
  revealedAt: number;
}

export interface ApiKeyRevokeRequest {
  reason?: string;
}

export interface ApiKeyRevokeResponse {
  id: string;
  revokedAt: number;
}

/**
 * LAMA-234 + LAMA-296: credential identity for the Web UI / SPA auth
 * discovery. One endpoint (GET /api/v1/auth/me) serves both modes:
 *
 *   - `mode: "bearer"` — master/admin/device/deploy resolved from the
 *     Authorization header (LAMA-234 shape, additive `authenticated` +
 *     `mode` fields).
 *   - `mode: "session"` — a cookie-authenticated mobile web session issued
 *     by POST /api/v1/mobile/web-session. `csrfToken` is the session-bound
 *     CSRF token the SPA must send on cookie-authenticated mutations;
 *     `name`/`displayName` carry the registration's display name.
 *
 * An invalid Bearer never falls back to the session cookie; with no
 * Authorization header and no (or stale/revoked) session cookie the
 * endpoint returns 401.
 */
export type AuthMeResponse =
  | {
      authenticated: true;
      mode: "bearer";
      kind: "master" | "admin" | "device" | "deploy";
      keyId: string | null;
      name: string | null;
      hostId: string | null;
    }
  | {
      authenticated: true;
      mode: "session";
      kind: "mobile-session";
      keyId: null;
      name: string;
      hostId: string;
      displayName: string;
      clientType: MobileClientType;
      /** Absolute epoch-ms session expiry (12 h from bootstrap). */
      expiresAt: number;
      csrfToken: string;
    };

// LAMA-301: manual production server deploy control. The deploy agent (an
// LXC-resident systemd service with a dedicated `deploy` credential) claims
// pending jobs, runs the FIXED update script with no arguments, and reports
// sanitized, capped output. The server container itself never receives
// Docker socket access, host SSH credentials, or a shell-execution
// endpoint — this job model is the entire deploy surface.
export type ServerDeployStatus = "pending" | "running" | "succeeded" | "failed";

export interface ServerDeployJob {
  id: string;
  requestedAt: number;
  /** Managed-key id/name of the requester when available; never a secret. */
  requestedBy: string | null;
  status: ServerDeployStatus;
  startedAt: number | null;
  completedAt: number | null;
  target: "production";
  summary: string | null;
  /** Scrubbed, capped (final 16 KiB) script output. */
  outputTail: string | null;
}

/** Shape of GET /api/v1/server-deploys/config (LAMA-301). */
export interface ServerDeployConfig {
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// LAMA-296 — Android companion enrollment and mobile auth wire contract.
// Additive: the CLI pairing flow (LAMA-262) above is untouched. Phase 1
// establishes the enrollment → registration → web-session lifecycle the
// Android app and the desktop QR flow exchange over the wire. All secrets
// (QR secret, native token, web grant, session secret) are opaque and
// one-time: the server persists only their hashes and never replays them,
// and none of these types ever carries backend host config or fleet data.
// ---------------------------------------------------------------------------

/** Client family that participates in the mobile flow. Only `android`
 *  exists in phase 1; future clients add a member here, never a new table. */
export type MobileClientType = "android";

/**
 * The versioned QR payload the authenticated desktop web UI renders and the
 * app scans. Keys and case are preserved verbatim — never uppercased (the
 * legacy CLI pairing QR normalization does NOT apply to this payload).
 * `secret` is a one-time 256-bit QR secret; it exists only on the QR the app
 * scans, never in a stored server response.
 */
export interface MobileEnrollmentQrV1 {
  kind: "lamasync.android.enroll";
  version: 1;
  /** Validated canonical HTTPS origin, e.g. `https://fleet.example.com`. */
  serverOrigin: string;
  enrollmentId: string;
  secret: string;
}

/** Lifecycle of one mobile enrollment (mirrors the record status column). */
export type MobileEnrollmentStatus = "pending" | "used" | "expired" | "revoked";

/** Admin body creating an Android enrollment (POST /api/v1/mobile/enrollments). */
export interface MobileEnrollmentCreateRequest {
  /** Whether the paired app may obtain a web grant carrying admin authority.
   *  Explicit (not inferred) per the "explicit web-admin grant" record flag;
   *  the desktop flow always sends true. */
  webAdmin: boolean;
  /** Client type this enrollment will register (defaults to android). */
  clientType?: MobileClientType;
}

/** Admin create response. `secret` is the one-time QR secret, returned
 *  exactly once here. */
export interface MobileEnrollmentCreateResponse {
  enrollmentId: string;
  /** One-time QR secret (only place it is ever returned). */
  secret: string;
  /** Validated canonical HTTPS origin baked into the QR. */
  serverOrigin: string;
  clientType: MobileClientType;
  /** Whether the resulting registration may bootstrap an admin web session. */
  webAdmin: boolean;
  /** Epoch-ms instant the enrollment expires (10 min). */
  expiresAt: number;
  /** Seconds until expiry (drives a QR countdown). */
  expiresInSeconds: number;
}

/** Minimal, revocation-safe metadata about a paired device. Deliberately
 *  contains no secrets and no host config; only identity + presence. */
export interface MobilePairedHostSummary {
  hostId: string;
  displayName: string;
  clientType: MobileClientType;
  appVersion: string;
  /** Epoch-ms instant the enrollment was exchanged. */
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

/** Admin status read (GET /api/v1/mobile/enrollments/:id). Never secrets. */
export interface MobileEnrollmentStatusResponse {
  enrollmentId: string;
  status: MobileEnrollmentStatus;
  /** Epoch-ms expiry instant. */
  expiresAt: number;
  /** Present once the enrollment has been used (a registration exists). */
  host: MobilePairedHostSummary | null;
}

/** Exchange body (POST /api/v1/mobile/enrollments/:id/exchange). Exactly
 *  unauthenticated: enrollment id + QR secret prove intent; the client never
 *  chooses a host id or grant level. */
export interface MobileEnrollmentExchangeRequest {
  enrollmentId: string;
  /** One-time QR secret from the scanned QR. */
  secret: string;
  /** Operator-chosen device display name, e.g. "Pixel 9". */
  displayName: string;
  /** App version string, e.g. "1.2.0". */
  appVersion: string;
}

/** One-time exchange result. Server-chosen host id and freshly minted
 *  authority (native token + separate web grant). Each secret is returned
 *  exactly once here. */
export interface MobileEnrollmentExchangeResponse {
  /** Server-created host id for the new registration. */
  hostId: string;
  /** Opaque native credential; returned exactly once. */
  nativeToken: string;
  /** Separate opaque web grant (admin iff enrollment.webAdmin); returned once. */
  webGrant: string;
  /** Validated canonical HTTPS origin. */
  serverOrigin: string;
  displayName: string;
  clientType: MobileClientType;
}

/** Web-session bootstrap (POST /api/v1/mobile/web-session): authenticates
 *  with the web grant and issues the session cookie + CSRF token to the HTTP
 *  client. Accepts no cross-origin browser request; native token alone → 403. */
export interface MobileWebSessionBootstrapRequest {
  /** The opaque web grant issued by the enrollment exchange. */
  grant: string;
}

export interface MobileWebSessionBootstrapResponse {
  hostId: string;
  displayName: string;
  /** Epoch-ms absolute session expiry (12 h). */
  expiresAt: number;
  /** Session-bound CSRF token for cookie-authenticated mutations. */
  csrfToken: string;
}

/** GET /api/v1/mobile/me — the native principal's own registration,
 *  revocation-safe and minimal. No backend config, secrets, fleet data, or
 *  upload capabilities. */
export interface MobileMeResponse {
  hostId: string;
  displayName: string;
  clientType: MobileClientType;
  appVersion: string;
  /** Epoch-ms instant the device paired (registration created). */
  pairedAt: number;
  serverOrigin: string;
}

export interface MobileCheckInRequest {
  /** App version reported on launch/resume check-in. */
  appVersion: string;
}

export interface MobileCheckInResponse {
  hostId: string;
  /** Epoch-ms server-recorded last-seen instant after this check-in. */
  lastSeenAt: number;
}

/** Admin revoke body (POST /api/v1/mobile/registrations/:hostId/revoke).
 *  Revokes native access, web grant, and all web sessions atomically. */
export interface MobileRegistrationRevokeRequest {
  reason?: string;
}

/**
 * One row of the admin paired-device projection
 * (GET /api/v1/mobile/registrations). Deliberately minimal: host identity
 * and presence metadata only — never secret hashes, grant/session links,
 * or host config. Revoked registrations are included so the desktop device
 * list can show and filter them.
 */
export interface MobileRegistrationSummary {
  hostId: string;
  displayName: string;
  clientType: MobileClientType;
  appVersion: string;
  /** Epoch-ms instant the device paired (registration created). */
  createdAt: number;
  /** Epoch-ms last check-in, or null when the device never checked in. */
  lastSeenAt: number | null;
  /** Epoch-ms revocation instant, or null while the device is live. */
  revokedAt: number | null;
  /** Revocation reason (operator-supplied at revoke time), or null. */
  revokedReason: string | null;
}

export interface MobileRegistrationRevokeResponse {
  hostId: string;
  /** Epoch-ms revocation instant. */
  revokedAt: number;
}

/** POST /api/v1/mobile/web-session/logout (current session, CSRF-protected).
 *  Invalidates that session + clears the cookie; does not revoke native. */
export interface MobileWebSessionLogoutResponse {
  loggedOut: true;
}

// ---------------------------------------------------------------------------
// LAMA-296 stage 1 — scoped mobile upload destinations and the resumable
// transfer contract. A destination grants ONE registration the right to
// publish files under a server-computed landing path such as
// `Mobile/<hostId>/Inbox` (see spec-296-stage-1-manual-uploads.md). No
// destination row => no upload access, even for a live registration.
// Request bodies carry only destination ids + validated file names — never
// arbitrary roots, backend credentials, or another host's inbox. Uploads
// are host-bound, idempotency-keyed, chunk-resumable, SHA-256 verified and
// atomically published; a final file is the durability point.
// ---------------------------------------------------------------------------

/** One authorized landing path owned by exactly one mobile registration. */
export interface MobileUploadDestination {
  /** Server-issued destination id (the only thing clients may reference). */
  id: string;
  /** Owning registration host id (server-derived, never client-chosen). */
  registrationId: string;
  /** Admin-chosen label, e.g. "Inbox". */
  label: string;
  /** Validated server-computed path relative to the mobile landing root,
   *  e.g. `Mobile/mob-abc123/Inbox`. */
  relPath: string;
  /** Epoch-ms creation instant. */
  createdAt: number;
  /** Epoch-ms revocation instant, or null while active. */
  revokedAt: number | null;
}

/** Admin body creating a destination for one registration. The path is
 *  always `Mobile/<hostId>/<slug>`; the client can never pick a root or
 *  another host's inbox. */
export interface MobileUploadDestinationCreateRequest {
  /** Human label, e.g. "Inbox" (also the default slug source). */
  label: string;
  /** Optional path segment; defaults to the sanitized label. */
  slug?: string;
}

export interface MobileUploadDestinationCreateResponse {
  destination: MobileUploadDestination;
}

export interface MobileUploadDestinationRevokeResponse {
  id: string;
  /** Epoch-ms revocation instant. */
  revokedAt: number;
}

/** Lifecycle of one upload intent (see spec state machine). */
export type MobileUploadStatus =
  | "created"
  | "uploading"
  | "ready"
  | "verifying"
  | "publishing"
  | "finalized"
  | "failed"
  | "cancelled";

/** Browse-ref the completed file is visible under (existing local browser). */
export interface MobileUploadBrowseRef {
  kind: "local";
  /** Path relative to the browse/backup root, e.g. `Mobile/<hostId>/Inbox/f.pdf`. */
  path: string;
}

/** Persisted, retry-safe completion receipt (returned again by finalize). */
export interface MobileUploadReceipt {
  uploadId: string;
  fileName: string;
  /** Final published path relative to the landing root. */
  finalRelPath: string;
  /** Where the existing Data Browser lists the published file. */
  browseRef: MobileUploadBrowseRef;
  /** Verified size in bytes. */
  sizeBytes: number;
  /** Verified SHA-256 hex digest. */
  sha256: string;
  /** Epoch-ms publication instant. */
  finalizedAt: number;
}

/** Full wire state of one upload. `idempotencyKey` is deliberately not
 *  echoed (it is a client claim); the client correlates by id. */
export interface MobileUpload {
  id: string;
  destinationId: string;
  destinationLabel: string;
  fileName: string;
  /** Reserved final path relative to the landing root. */
  finalRelPath: string;
  /** Client-declared expected size, or null when unknown. */
  sizeBytes: number | null;
  /** Durable resumable offset (bytes durably accepted). */
  bytesReceived: number;
  /** Verified SHA-256 hex digest once verification passed (else null). */
  sha256: string | null;
  status: MobileUploadStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finalizedAt: number | null;
  receipt: MobileUploadReceipt | null;
  /** Server-negotiated maximum bytes per chunk request. */
  chunkSizeBytes: number;
  /** Server-enforced maximum total upload size. */
  maxSizeBytes: number;
}

/** Native body creating an upload (POST /api/v1/mobile/uploads). */
export interface MobileUploadCreateRequest {
  /** Authorized destination id (own registration only). */
  destinationId: string;
  /** Final file name — single segment, validated server-side. */
  fileName: string;
  /** Expected total size (optional but recommended; enables early caps). */
  sizeBytes?: number | null;
  /** Client-computed SHA-256 hex of the whole file (optional; verified at
   *  finalize when present). */
  sha256?: string | null;
}

export interface MobileUploadCreateResponse {
  upload: MobileUpload;
}

export interface MobileUploadStateResponse {
  upload: MobileUpload;
}

export interface MobileUploadListResponse {
  uploads: MobileUpload[];
}

export interface MobileUploadFinalizeResponse {
  receipt: MobileUploadReceipt;
}

export interface MobileUploadCancelResponse {
  upload: MobileUpload;
}
