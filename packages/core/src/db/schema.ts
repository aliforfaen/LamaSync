// Server SQLite schema. Applied on first DB open via initDb().

export const SERVER_SCHEMA = `
CREATE TABLE IF NOT EXISTS hosts (
    id          TEXT PRIMARY KEY,
    hostname    TEXT NOT NULL,
    tailnet_ip  TEXT,
    last_seen   INTEGER,
    status      TEXT DEFAULT 'unknown',
    lan_ip      TEXT
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
    s3_provider           TEXT DEFAULT 'other',
    s3_endpoint           TEXT,
    s3_bucket             TEXT,
    s3_access_key_id      TEXT,
    s3_secret_access_key  TEXT,
    s3_region             TEXT
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
    tags          TEXT -- JSON array
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
    error         TEXT
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
    status        TEXT NOT NULL DEFAULT 'pending',
    resolution    TEXT,
    created_at    INTEGER NOT NULL,
    resolved_at   INTEGER,
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
    duration_ms INTEGER
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
];
