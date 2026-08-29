// Core wire/DB types — single source of truth for the whole system.

export type HostStatus = "online" | "offline" | "degraded" | "unknown";

export type FolderType = "sync" | "mount" | "backup" | "dotfile" | "git";
export type FolderBackend = "sftp" | "s3" | "local" | "nfs" | "restic";
export type S3Provider = "exoscale" | "aws" | "other";

export type OperationStatus =
  | "started"
  | "success"
  | "failed"
  | "conflict"
  | "recovery"  // bisync state was corrupted and recovered
  | "retry";    // transient failure, will retry

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
}

export interface DotfileManifest {
  id: string;
  hostId: string;
  appName: string;
  paths: string[];
  /** Optional reusable app profile that generated this manifest. */
  profileId?: string | null;
  excludes?: string[] | null;
  schedule?: string | null;
  instructions?: string | null;
  lastSyncAt?: number | null;
  lastSyncDirection?: "upload" | "download" | null;
  originalUploaderHostId?: string | null;
}

/** Reusable user-defined app-settings template. */
export interface AppProfile {
  id: string;
  name: string;
  description?: string | null;
  emoji?: string | null;
  color?: string | null;
  /** Suggested appdata paths keyed by operating system. */
  paths: {
    linux?: string[];
    macos?: string[];
    windows?: string[];
  };
  installUrl?: string | null;
  installInstructions?: string | null;
  restoreInstructions?: string | null;
  createdAt: number;
  updatedAt: number;
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
    backends: number;
    operations: number;
    snapshots: number;
    manifests: number;
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
  manifests: DotfileManifest[];
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
  // LAMA-225: emitted after a host rename (id == hostname). The UI shows a
  // banner and re-fetches host lists; other fields reference the NEW id.
  | { kind: "host_renamed"; oldId: string; newId: string; hostname: string }
  | { kind: "lock"; folderId: string; hostId: string; action: "acquired" | "released" | "reaped"; status?: string; lockId?: string }
  | { kind: "mount"; folderId: string; status: MountEntry["status"]; path: string }
  | { kind: "conflict"; conflict: Conflict }
  | { kind: "restic_snapshot"; snapshot: ResticSnapshot }
  | { kind: "restic_restore"; job: ResticRestoreJob }
  | { kind: "action"; action: QueuedAction }
  // LAMA-226: Data Browser write-operation progress.
  | { kind: "browse_job"; job: BrowseJob };

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

// LAMA-259: the Data Browser's "history" mode renders files from inside a
// restic snapshot instead of from a live filesystem. `backend` discriminates
// the source so the UI can render either shape with a single switch.
export type BrowseBackend = "local" | "s3" | "restic-snapshot";

export interface BrowseResponse {
  backend: BrowseBackend;
  path: string;
  entries: BrowseEntry[];
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

// LAMA-224: last-known size of one folder's working set (rclone size).
// S3-only: non-S3 folders are not measurable server-side (their paths live
// on daemon hosts) and return bytes: null (P1-7). Note the measurement is
// BUCKET-level, not prefix-level — folders sharing a bucket each report the
// full bucket size.
export interface FolderSize {
  folderId: string;
  bytes: number | null;
  objectCount: number | null;
  error: string | null;
  measuredAt: number;
}

// LAMA-226: Data Browser write operations. Jobs are created when an op
// starts, updated as entries complete (progress_bytes/total_bytes count
// entries when rclone byte-level stats are unavailable), and written to
// operation_log once terminal for the audit trail.
export type BrowseJobOperation =
  | "copy"
  | "move"
  | "upload"
  | "rename"
  | "mkdir"
  | "delete";
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
  /** The pre-shared API key. Today this is always the server's
   *  `LAMASYNC_API_KEY` env value (see server's pairing route). The
   *  field is named so a future per-device rotation can swap the
   *  issuer without changing the wire. */
  apiKey: string;
}
