// Server SQLite schema. Applied on first DB open via initDb().

export const SERVER_SCHEMA = `
CREATE TABLE IF NOT EXISTS hosts (
    id          TEXT PRIMARY KEY,
    hostname    TEXT NOT NULL,
    tailnet_ip  TEXT,
    last_seen   INTEGER,
    status      TEXT DEFAULT 'unknown',
    lan_ip      TEXT,
    version     TEXT,
    config_revision INTEGER DEFAULT 0,
    os          TEXT,
    storage_used_bytes INTEGER,
    demo        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS folders (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    type                  TEXT NOT NULL,
    created_at            INTEGER,
    encrypted             BOOLEAN DEFAULT 0,
    crypt_password        TEXT,
    git_provider          TEXT,
    git_remote            TEXT,
    backend               TEXT DEFAULT 'sftp',
    backend_id            TEXT REFERENCES backends(id),
    s3_bucket             TEXT,
    demo                  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS folder_assignments (
    id                  TEXT PRIMARY KEY,
    folder_id           TEXT NOT NULL REFERENCES folders(id),
    host_id             TEXT NOT NULL REFERENCES hosts(id),
    role                TEXT NOT NULL,
    local_path          TEXT NOT NULL,
    remote_name         TEXT,
    sync_expr           TEXT,
    enabled             INTEGER DEFAULT 1,
    -- LAMA-239: per-host override ("inherit" | "sync" | "mount"). Default
    -- is "inherit" so existing assignments reproduce today's behavior
    -- exactly (a mount folder stays mounted everywhere, a sync folder
    -- stays synced everywhere). The override is only honored when the
    -- folder's type is sync or mount - see effectiveFolderType in
    -- ./effective-type.ts.
    mode                TEXT NOT NULL DEFAULT 'inherit',
    conflict_strategy   TEXT,
    pre_sync_cmd        TEXT,
    post_sync_cmd       TEXT,
    ignore_path         TEXT,
    mount_ignore_path   TEXT,
    timeout_sec         INTEGER,
    bandwidth_schedule  TEXT,
    max_retries         INTEGER DEFAULT 3,
    available_space_threshold INTEGER,
    cache_profile       TEXT,
    cache_max_size      TEXT,
    restic_repository   TEXT,
    restic_password     TEXT,
    demo                INTEGER NOT NULL DEFAULT 0,
    UNIQUE(folder_id, host_id)
);

CREATE TABLE IF NOT EXISTS dotfile_manifests (
    id            TEXT PRIMARY KEY,
    host_id       TEXT NOT NULL REFERENCES hosts(id),
    app_name      TEXT NOT NULL,
    paths         TEXT NOT NULL,
    excludes      TEXT,
    schedule      TEXT,
    instructions  TEXT,
    last_sync_at  INTEGER,
    last_sync_direction TEXT,
    original_uploader_host_id TEXT,
    demo                    INTEGER NOT NULL DEFAULT 0,
    UNIQUE(host_id, app_name)
);

CREATE TABLE IF NOT EXISTS dotfile_versions (
    id            TEXT PRIMARY KEY,
    manifest_id   TEXT NOT NULL REFERENCES dotfile_manifests(id),
    timestamp     INTEGER NOT NULL,
    tarball_path  TEXT NOT NULL,
    size_bytes    INTEGER,
    checksum      TEXT,
    description   TEXT
);

CREATE TABLE IF NOT EXISTS restic_snapshots (
    id            TEXT PRIMARY KEY,
    folder_id     TEXT NOT NULL REFERENCES folders(id),
    host_id       TEXT NOT NULL REFERENCES hosts(id),
    snapshot_id   TEXT NOT NULL,
    timestamp     INTEGER NOT NULL,
    paths         TEXT NOT NULL, -- JSON array
    size_bytes    INTEGER,
    tags          TEXT, -- JSON array
    demo          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_restic_snapshots_folder_host
    ON restic_snapshots(folder_id, host_id);

CREATE TABLE IF NOT EXISTS restic_restore_jobs (
    id            TEXT PRIMARY KEY,
    snapshot_id   TEXT NOT NULL,
    folder_id     TEXT NOT NULL REFERENCES folders(id),
    target_host_id TEXT NOT NULL,
    target_path   TEXT NOT NULL,
    include       TEXT, -- JSON array
    status        TEXT NOT NULL DEFAULT 'pending',
    created_at    INTEGER NOT NULL,
    resolved_at   INTEGER,
    error         TEXT,
    demo          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_restic_restore_jobs_target
    ON restic_restore_jobs(target_host_id, status);

CREATE TABLE IF NOT EXISTS conflicts (
    id            TEXT PRIMARY KEY,
    host_id       TEXT NOT NULL,
    folder_id     TEXT NOT NULL REFERENCES folders(id),
    path          TEXT NOT NULL,
    local_mtime   INTEGER,
    remote_mtime  INTEGER,
    local_size    INTEGER,
    remote_size   INTEGER,
    status        TEXT NOT NULL DEFAULT 'pending',
    resolution    TEXT,
    created_at    INTEGER NOT NULL,
    resolved_at   INTEGER,
    demo          INTEGER NOT NULL DEFAULT 0,
    UNIQUE(host_id, folder_id, path)
);

CREATE INDEX IF NOT EXISTS idx_conflicts_host_folder
    ON conflicts(host_id, folder_id, status);

CREATE TABLE IF NOT EXISTS operation_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   INTEGER NOT NULL,
    host_id     TEXT NOT NULL,
    folder_id   TEXT,
    operation   TEXT NOT NULL,
    status      TEXT NOT NULL,
    summary     TEXT,
    details     TEXT,
    duration_ms INTEGER,
    demo        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notification_events (
    id                  TEXT PRIMARY KEY,
    type                TEXT NOT NULL,
    severity            TEXT NOT NULL,
    message             TEXT NOT NULL,
    host_id             TEXT,
    folder_id           TEXT,
    payload             TEXT,
    created_at          INTEGER NOT NULL,
    ntfy_delivered      INTEGER DEFAULT 0,
    webhook_delivered   INTEGER DEFAULT 0
);

-- LAMA-221: configurable delivery channels. Replaces the env-only
-- LAMASYNC_NTFY_URL / LAMASYNC_LAMADB_WEBHOOK_URL gates; the env values
-- seed a channel row on first boot (see notifications.ts).
CREATE TABLE IF NOT EXISTS notification_channels (
    id                   TEXT PRIMARY KEY,
    kind                 TEXT NOT NULL,      -- 'ntfy' | 'webhook'
    name                 TEXT NOT NULL,
    url                  TEXT NOT NULL,
    enabled              INTEGER DEFAULT 1,
    severities           TEXT NOT NULL DEFAULT '["critical","default","info"]', -- JSON allowlist
    last_delivery_status TEXT,               -- 'success' | 'failed' | NULL
    last_delivery_at     INTEGER,
    created_at           INTEGER NOT NULL
);

-- LAMA-222: reusable backends. folders.backend becomes a reference to
-- backends.id; S3 credentials live here once instead of per folder. Secrets
-- are encrypted at rest (AES-256-GCM) in s3_secret_key_enc.
-- LAMA-232/hidden-api-power: backend kinds local / nfs / restic. local is
-- a server-side directory path (rclone type = local), nfs is an export
-- already mounted on the server (also rclone type = local, but the kind
-- documents provenance), and restic centralizes the per-assignment
-- resticRepository/resticPassword pair (the password stays encrypted).
CREATE TABLE IF NOT EXISTS backends (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL UNIQUE,
    kind               TEXT NOT NULL DEFAULT 's3',
    s3_provider        TEXT DEFAULT 'other',
    s3_endpoint        TEXT,
    s3_region          TEXT,
    s3_access_key_id   TEXT,
    s3_secret_key_enc  TEXT,
    local_path         TEXT,
    restic_repository  TEXT,
    restic_password_enc TEXT,
    demo               INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL
);

-- LAMA-226: Data Browser write operations (copy/move/upload/rename/mkdir).
-- Rows are created when an operation starts and updated as it progresses,
-- giving the UI a pollable + WS-driven progress source. A terminal
-- operation_log row is also written for the audit trail.
CREATE TABLE IF NOT EXISTS browse_jobs (
    id             TEXT PRIMARY KEY,
    operation      TEXT NOT NULL,   -- copy | move | upload | rename | mkdir
    source         TEXT NOT NULL,   -- human label, e.g. "local:dotfiles/pi"
    destination    TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|failed|cancelled
    error          TEXT,
    progress_bytes INTEGER,
    total_bytes    INTEGER,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_state (
    folder_assignment_id TEXT NOT NULL UNIQUE REFERENCES folder_assignments(id),
    last_run             INTEGER,
    next_run             INTEGER,
    last_status          TEXT,
    locked_by            TEXT,
    locked_at            INTEGER,
    lock_ttl             INTEGER DEFAULT 1200
);
CREATE INDEX IF NOT EXISTS idx_operation_log_host_ts
    ON operation_log(host_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_dotfile_versions_manifest_ts
    ON dotfile_versions(manifest_id, timestamp);

CREATE TABLE IF NOT EXISTS folder_locks (
    folder_id   TEXT PRIMARY KEY,
    locked_by   TEXT,
    locked_at   INTEGER,
    lock_ttl    INTEGER DEFAULT 1200,
    lock_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_folder_locks_locked_by
    ON folder_locks(locked_by);

CREATE TABLE IF NOT EXISTS queued_actions (
    id            TEXT PRIMARY KEY,
    host_id       TEXT NOT NULL REFERENCES hosts(id),
    type          TEXT NOT NULL,
    payload       TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    created_at    INTEGER NOT NULL,
    taken_at      INTEGER,
    completed_at  INTEGER,
    result        TEXT
);

CREATE INDEX IF NOT EXISTS idx_queued_actions_host_status
    ON queued_actions(host_id, status);

-- LAMA-269: size time series for the storage donut + growth sparkline.
-- folder-scoped rows record each measured folder working set; backend-
-- scoped rows aggregate a destination's total so the sparkline can plot
-- growth without re-aggregating per-folder history on every request.
CREATE TABLE IF NOT EXISTS size_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    scope         TEXT NOT NULL,        -- 'folder' | 'backend'
    ref_id        TEXT NOT NULL,        -- folder id or backend id
    bytes         INTEGER,
    object_count  INTEGER,
    measured_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_size_history_ref_scope
    ON size_history(ref_id, scope, measured_at);
`;

// Columns to attempt adding for existing databases that predate the schema update.
// Each ALTER TABLE is tried; "duplicate column" errors are ignored.
export const MIGRATIONS: string[] = [
  "ALTER TABLE folder_assignments ADD COLUMN mount_ignore_path TEXT",
  "ALTER TABLE folder_assignments ADD COLUMN bandwidth_schedule TEXT",
  "ALTER TABLE folder_assignments ADD COLUMN max_retries INTEGER DEFAULT 3",
  "ALTER TABLE folder_assignments ADD COLUMN available_space_threshold INTEGER",
  "ALTER TABLE folders ADD COLUMN encrypted BOOLEAN DEFAULT 0",
  "ALTER TABLE folders ADD COLUMN crypt_password TEXT",
  "ALTER TABLE folder_assignments ADD COLUMN cache_profile TEXT",
  "ALTER TABLE folder_assignments ADD COLUMN cache_max_size TEXT",
  "ALTER TABLE schedule_state ADD COLUMN locked_by TEXT",
  "ALTER TABLE schedule_state ADD COLUMN locked_at INTEGER",
  "ALTER TABLE schedule_state ADD COLUMN lock_ttl INTEGER DEFAULT 1200",
  "ALTER TABLE hosts ADD COLUMN lan_ip TEXT",
  "ALTER TABLE folder_assignments ADD COLUMN restic_repository TEXT",
  "ALTER TABLE folder_assignments ADD COLUMN restic_password TEXT",
  "ALTER TABLE dotfile_manifests ADD COLUMN instructions TEXT",
  "ALTER TABLE restic_restore_jobs ADD COLUMN include TEXT",
  "CREATE INDEX IF NOT EXISTS idx_conflicts_host_folder ON conflicts(host_id, folder_id, status)",
  // LAMA-268: per-side sizes for the conflict cards + demo flag so seeded
  // demo conflicts are wiped by the demo-delete.
  "ALTER TABLE conflicts ADD COLUMN local_size INTEGER",
  "ALTER TABLE conflicts ADD COLUMN remote_size INTEGER",
  "ALTER TABLE conflicts ADD COLUMN demo INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE folders ADD COLUMN git_provider TEXT",
  "ALTER TABLE folders ADD COLUMN git_remote TEXT",
  "CREATE TABLE IF NOT EXISTS folder_locks (folder_id TEXT PRIMARY KEY, locked_by TEXT, locked_at INTEGER, lock_ttl INTEGER DEFAULT 1200, lock_id TEXT)",
  "INSERT OR REPLACE INTO folder_locks (folder_id, locked_by, locked_at, lock_ttl) SELECT fa.folder_id, ss.locked_by, ss.locked_at, ss.lock_ttl FROM folder_assignments fa JOIN schedule_state ss ON ss.folder_assignment_id = fa.id WHERE ss.locked_by IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_folder_locks_locked_by ON folder_locks(locked_by)",
  "ALTER TABLE folders ADD COLUMN s3_provider TEXT DEFAULT 'other'",
  "ALTER TABLE folders ADD COLUMN backend TEXT DEFAULT 'sftp'",
  "ALTER TABLE folders ADD COLUMN s3_endpoint TEXT",
  "ALTER TABLE folders ADD COLUMN s3_bucket TEXT",
  "ALTER TABLE folders ADD COLUMN s3_access_key_id TEXT",
  "ALTER TABLE folders ADD COLUMN s3_secret_access_key TEXT",
  "ALTER TABLE folders ADD COLUMN s3_region TEXT",
  "ALTER TABLE dotfile_manifests ADD COLUMN excludes TEXT",
  "ALTER TABLE dotfile_manifests ADD COLUMN last_sync_at INTEGER",
  "ALTER TABLE dotfile_manifests ADD COLUMN last_sync_direction TEXT",
  "ALTER TABLE dotfile_manifests ADD COLUMN original_uploader_host_id TEXT",
  "ALTER TABLE hosts ADD COLUMN version TEXT",
  "ALTER TABLE hosts ADD COLUMN config_revision INTEGER DEFAULT 0",
  // LAMA-282: device OS label + storage used for the device cards.
  "ALTER TABLE hosts ADD COLUMN os TEXT",
  "ALTER TABLE hosts ADD COLUMN storage_used_bytes INTEGER",
  "CREATE TABLE IF NOT EXISTS queued_actions (id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id), type TEXT NOT NULL, payload TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, taken_at INTEGER, completed_at INTEGER, result TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_queued_actions_host_status ON queued_actions(host_id, status)",
  "CREATE TABLE IF NOT EXISTS notification_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL, host_id TEXT, folder_id TEXT, payload TEXT, created_at INTEGER NOT NULL, ntfy_delivered INTEGER DEFAULT 0, webhook_delivered INTEGER DEFAULT 0)",
  // LAMA-223: hosts.tailnet_ip was added to SERVER_SCHEMA but never shipped
  // as a migration — existing databases would crash on HOST_SELECT. This is
  // the missing piece; "duplicate column" errors are ignored by initDb.
  "ALTER TABLE hosts ADD COLUMN tailnet_ip TEXT",
  "CREATE TABLE IF NOT EXISTS notification_channels (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, enabled INTEGER DEFAULT 1, severities TEXT NOT NULL DEFAULT '[\"critical\",\"default\",\"info\"]', last_delivery_status TEXT, last_delivery_at INTEGER, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS backends (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 's3', s3_provider TEXT DEFAULT 'other', s3_endpoint TEXT, s3_region TEXT, s3_access_key_id TEXT, s3_secret_key_enc TEXT, created_at INTEGER NOT NULL)",
  "ALTER TABLE backends ADD COLUMN local_path TEXT",
  "ALTER TABLE backends ADD COLUMN restic_repository TEXT",
  "ALTER TABLE backends ADD COLUMN restic_password_enc TEXT",
  // LAMA-222: folders gain a backend reference. The legacy per-folder s3_*
  // columns are NOT dropped here — see LEGACY_S3_DROP_MIGRATIONS below.
  "ALTER TABLE folders ADD COLUMN backend_id TEXT",
  "CREATE TABLE IF NOT EXISTS browse_jobs (id TEXT PRIMARY KEY, operation TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT, progress_bytes INTEGER, total_bytes INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  // LAMA-239: per-host sync/mount override. Default "inherit" reproduces
  // today's behavior so existing assignments (and existing dev databases)
  // need no migration other than this ADD COLUMN.
  "ALTER TABLE folder_assignments ADD COLUMN mode TEXT NOT NULL DEFAULT 'inherit'",
  // LAMA-264: demo-mode flag on every table the demo seeder writes. Demo
  // rows are flagged (demo = 1) so a single confirmed DELETE wipes them
  // without touching any real data, and a real daemon never acts on them
  // (demo hosts have no heartbeat; a daemon only pulls its own host id).
  "ALTER TABLE hosts ADD COLUMN demo INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE folders ADD COLUMN demo INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE folder_assignments ADD COLUMN demo INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE backends ADD COLUMN demo INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE operation_log ADD COLUMN demo INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE restic_snapshots ADD COLUMN demo INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE dotfile_manifests ADD COLUMN demo INTEGER NOT NULL DEFAULT 0",
  // LAMA-264: restic_restore_jobs can reference demo folders/hosts; flag it
  // too so a demo delete is exhaustive. No seeder writes restore jobs yet,
  // but the column keeps the demo-cleanup contract complete.
  "ALTER TABLE restic_restore_jobs ADD COLUMN demo INTEGER NOT NULL DEFAULT 0",
  // LAMA-269: size time series for the storage donut + growth sparkline.
  "CREATE TABLE IF NOT EXISTS size_history (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, ref_id TEXT NOT NULL, bytes INTEGER, object_count INTEGER, measured_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_size_history_ref_scope ON size_history(ref_id, scope, measured_at)",
];

/**
 * LAMA-222 / P0-3: drops for the legacy per-folder s3_* columns (values
 * were lifted into `backends` by the server-side migration in
 * packages/server/src/backends.ts). These are deliberately NOT part of the
 * unconditional MIGRATIONS runner: a failed lift must never cascade into
 * dropping the only copy of the credentials. initDb applies them only when
 * called with `{ dropLegacyS3Columns: true }`, which the server does solely
 * after the lift reports success (or finds nothing to lift).
 * "no such column" errors are safe to ignore (fresh schemas never had them;
 * SQLite cannot DROP COLUMN IF EXISTS).
 */
export const LEGACY_S3_DROP_MIGRATIONS = [
  "ALTER TABLE folders DROP COLUMN s3_provider",
  "ALTER TABLE folders DROP COLUMN s3_endpoint",
  "ALTER TABLE folders DROP COLUMN s3_access_key_id",
  "ALTER TABLE folders DROP COLUMN s3_secret_access_key",
  "ALTER TABLE folders DROP COLUMN s3_region",
];
