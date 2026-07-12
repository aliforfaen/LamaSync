// Server SQLite schema. Applied on first DB open via initDb().

export const SERVER_SCHEMA = `
CREATE TABLE IF NOT EXISTS hosts (
    id          TEXT PRIMARY KEY,
    hostname    TEXT NOT NULL,
    tailnet_ip  TEXT,
    last_seen   INTEGER,
    status      TEXT DEFAULT 'unknown'
);

CREATE TABLE IF NOT EXISTS folders (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    created_at  INTEGER
);

CREATE TABLE IF NOT EXISTS folder_assignments (
    id            TEXT PRIMARY KEY,
    folder_id     TEXT NOT NULL REFERENCES folders(id),
    host_id       TEXT NOT NULL REFERENCES hosts(id),
    role          TEXT NOT NULL,
    local_path    TEXT NOT NULL,
    remote_name   TEXT,
    sync_expr     TEXT,
    enabled       INTEGER DEFAULT 1,
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
    checksum      TEXT
);

CREATE TABLE IF NOT EXISTS operation_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   INTEGER NOT NULL,
    host_id     TEXT NOT NULL,
    folder_id   TEXT,
    operation   TEXT NOT NULL,
    status      TEXT NOT NULL,
    summary     TEXT,
    details     TEXT
);

CREATE TABLE IF NOT EXISTS schedule_state (
    folder_assignment_id TEXT NOT NULL REFERENCES folder_assignments(id),
    last_run             INTEGER,
    next_run             INTEGER,
    last_status          TEXT
);

CREATE INDEX IF NOT EXISTS idx_operation_log_host_ts
    ON operation_log(host_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_dotfile_versions_manifest_ts
    ON dotfile_versions(manifest_id, timestamp);
`;
