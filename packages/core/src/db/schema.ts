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
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL,
    created_at      INTEGER,
    encrypted       BOOLEAN DEFAULT 0,
    crypt_password  TEXT
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
    UNIQUE(folder_id, host_id)
);

CREATE TABLE IF NOT EXISTS dotfile_manifests (
    id          TEXT PRIMARY KEY,
    host_id     TEXT NOT NULL REFERENCES hosts(id),
    app_name    TEXT NOT NULL,
    paths       TEXT NOT NULL,
    schedule    TEXT,
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
];
