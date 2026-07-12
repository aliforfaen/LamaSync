# LamaSync — Architecture

## Overview

```
┌─ TrueNAS (Docker) ──────────────────────────────────────────┐
│  lamasync-server                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ REST API │ │ Scheduler│ │ Dotfile  │ │ rclone Config  │  │
│  │          │ │          │ │ Registry │ │ Generator      │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───────┬────────┘  │
│       └──────────────┴───────────┴───────────────┘           │
│                         │ SQLite                             │
│  Volumes: /data (DB), /backups (tarballs)                    │
└──────────────────────────┼──────────────────────────────────┘
                           │ Tailnet
        ┌──────────────────┼──────────────────┐
        │                  │                  │
┌───────┴───────┐  ┌───────┴───────┐  ┌───────┴───────┐
│ Client A      │  │ Client B      │  │ Client C      │
│ lamasyncd     │  │ lamasyncd     │  │ lamasyncd     │
│ lamasync-tui  │  │ lamasync-tui  │  │ lamasync-tui  │
│ rclone        │  │ rclone        │  │ rclone        │
└───────────────┘  └───────────────┘  └───────────────┘
```

Two binaries per client:
- **`lamasyncd`** — background daemon (systemd `--user`), manages rclone processes, schedules, reports to server
- **`lamasync-tui`** — OpenTUI frontend, talks to local daemon via Unix socket, optionally connects to server for fleet view

One binary on the server:
- **`lamasync-server`** — REST API, config registry, dotfile store, scheduler coordination

---

## Folder Types

| Type | Direction | Engine | Use Case |
|------|-----------|--------|----------|
| `sync` | Bidirectional | `rclone bisync` | LamaFiles between desktop + laptop |
| `mount` | Remote → local | `rclone mount` + VFS cache | Large repos you don't want downloaded |
| `backup` | Local → server | `rclone copy` (one-way) | `/opt/appdata`, home dir snapshots |
| `dotfile` | Local → server | `tar czf` + rclone push | Per-app configs, versioned on server |

---

## Database Schema (SQLite, server-side)

```sql
-- Registered hosts (clients + server itself)
CREATE TABLE hosts (
    id          TEXT PRIMARY KEY,  -- hostname or uuid
    hostname    TEXT NOT NULL,
    tailnet_ip  TEXT,
    last_seen   INTEGER,
    status      TEXT DEFAULT 'unknown'  -- online, offline, degraded
);

-- Folder definitions (canonical, created once)
CREATE TABLE folders (
    id          TEXT PRIMARY KEY,  -- uuid
    name        TEXT NOT NULL,     -- "LamaFiles", "dotfiles-nvim"
    type        TEXT NOT NULL,     -- sync, mount, backup, dotfile
    created_at  INTEGER
);

-- Which hosts participate in which folders, and how
CREATE TABLE folder_assignments (
    id            TEXT PRIMARY KEY,
    folder_id     TEXT NOT NULL REFERENCES folders(id),
    host_id       TEXT NOT NULL REFERENCES hosts(id),
    role          TEXT NOT NULL,        -- source, target, both
    local_path    TEXT NOT NULL,        -- /home/user/LamaFiles
    remote_name   TEXT,                 -- rclone remote name for this pairing
    sync_expr     TEXT,                 -- cron expression
    enabled       INTEGER DEFAULT 1,
    UNIQUE(folder_id, host_id)
);

-- Dotfile manifests: which paths belong to which app
CREATE TABLE dotfile_manifests (
    id          TEXT PRIMARY KEY,
    host_id     TEXT NOT NULL REFERENCES hosts(id),
    app_name    TEXT NOT NULL,          -- "nvim", "omp", "fish"
    paths       TEXT NOT NULL,          -- JSON array of paths
    schedule    TEXT,                   -- cron expression
    UNIQUE(host_id, app_name)
);

-- Versioned dotfile tarballs
CREATE TABLE dotfile_versions (
    id            TEXT PRIMARY KEY,
    manifest_id   TEXT NOT NULL REFERENCES dotfile_manifests(id),
    timestamp     INTEGER NOT NULL,
    tarball_path  TEXT NOT NULL,        -- relative to /backups volume
    size_bytes    INTEGER,
    checksum      TEXT                  -- sha256
);

-- Operation log (sync runs, backups, errors)
CREATE TABLE operation_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   INTEGER NOT NULL,
    host_id     TEXT NOT NULL,
    folder_id   TEXT,
    operation   TEXT NOT NULL,          -- sync, mount, backup, dotfile_push, dotfile_pull
    status      TEXT NOT NULL,          -- started, success, failed, conflict
    summary     TEXT,                   -- "42 files up, 3 conflicts"
    details     TEXT                    -- JSON: file list, error messages
);

-- Server-side schedule tracking (avoids cron on every client)
CREATE TABLE schedule_state (
    folder_assignment_id TEXT NOT NULL REFERENCES folder_assignments(id),
    last_run             INTEGER,
    next_run             INTEGER,
    last_status          TEXT
);
```

---

## REST API (Server)

```
GET    /api/v1/health                          → fleet summary + host statuses
GET    /api/v1/config/:host_id                 → full config for a host (folders, schedules, dotfile manifests)
POST   /api/v1/register                        → new host self-registration
POST   /api/v1/report                          → client submits operation result
POST   /api/v1/report/health                   → client heartbeat + local stats

GET    /api/v1/dotfiles/:app_name              → list available versions
GET    /api/v1/dotfiles/:app_name/:version     → download tarball
POST   /api/v1/dotfiles/:app_name              → upload new version (multipart)
DELETE /api/v1/dotfiles/:app_name/:version     → prune old version

GET    /api/v1/folders                         → list all folders
POST   /api/v1/folders                         → create folder definition
PUT    /api/v1/folders/:id                     → update folder
DELETE /api/v1/folders/:id                     → remove folder
POST   /api/v1/folders/:id/assign              → assign folder to host
DELETE /api/v1/folders/:id/assign/:host_id     → unassign

WS     /api/v1/ws                              → live event stream (operations, health changes)
```

### Auth
- Pre-shared API key in server config
- Clients store it in `~/.config/lamasync/client.toml`
- All requests include `Authorization: Bearer <key>`
- Tailnet provides transport encryption; API key is a lightweight "you're allowed" check

---

## Client Architecture

### `lamasyncd` (daemon)

```
┌──────────────────────────────────────────┐
│ lamasyncd                                │
│                                          │
│  ┌─────────┐  ┌──────────┐  ┌─────────┐ │
│  │ Config  │  │ Scheduler│  │ Health  │ │
│  │ Manager │──│ (cron)   │  │ Reporter│ │
│  └────┬────┘  └────┬─────┘  └────┬────┘ │
│       │            │              │      │
│  ┌────┴────────────┴──────────────┴────┐ │
│  │         rclone Executor             │ │
│  │  - spawns rclone mount/sync/copy    │ │
│  │  - monitors child processes         │ │
│  │  - captures output, detects errors  │ │
│  └─────────────────────────────────────┘ │
│                                          │
│  Unix socket: /run/user/1000/lamasync.sock
└──────────────────────────────────────────┘
```

**Lifecycle of a sync:**
1. Scheduler fires (or manual trigger from TUI)
2. Pulls folder config from local cache (synced with server)
3. Ensures rclone remote is configured
4. Spawns `rclone bisync source:path dest:path --config /tmp/lamasync-rclone.conf`
5. Parses output for conflicts, errors, transfer count
6. Reports to server via `POST /report`
7. On conflict: queues for TUI resolution if strategy is `manual`

**rclone config management:**
- Server generates rclone config fragments
- Client assembles them into a temp config file per operation
- Each folder assignment gets a named remote: `[lamasync-folderId]`
- Avoids polluting the user's own rclone config

### `lamasync-tui` (OpenTUI)

**Local mode** (default, connects to Unix socket):
```
┌─────────────────────────────────────────────────┐
│ LamaSync — desktop                              │  ← hostname
│                                                 │
│ Folders                           Status        │
│ ├─ LamaFiles/                     ▲ synced 2m   │
│ ├─ dotfiles-nvim/                 ▲ backed 1h   │
│ ├─ opt-appdata/                   ▼ failed      │
│ └─ projects-mount/                ◆ mounted     │
│                                                 │
│ [1] Sync All  [2] Backup All  [3] Details       │
│ [4] Restore Dotfiles  [5] Logs  [6] Fleet View  │
└─────────────────────────────────────────────────┘
```

**Fleet mode** (connects to server API):
```
┌─────────────────────────────────────────────────┐
│ LamaSync — Fleet                                │
│                                                 │
│ Host          Status     Folders   Last Seen     │
│ desktop       ● online     4/4      now          │
│ laptop        ● online     3/4      2m ago       │
│ homelab       ○ offline    0/4      3h ago       │
│                                                 │
│ [1] Host Details  [2] Trigger Sync  [3] Refresh │
└─────────────────────────────────────────────────┘
```

---

## Dotfile Flow

### Backup (client → server)
```
TUI trigger / cron
       │
       ▼
lamasyncd reads dotfile manifest for app (e.g., nvim)
       │
       ▼
tar czf /tmp/lamasync-dotfile-nvim-20260712.tar.gz \
    ~/.config/nvim ~/.local/share/nvim
       │
       ▼
rclone copyto /tmp/lamasync-*.tar.gz \
    lamasync-server:/backups/dotfiles/nvim/20260712_143022.tar.gz
       │
       ▼
POST /api/v1/dotfiles/nvim  → server records version in DB
       │
       ▼
Cleanup temp tarball
```

### Restore (server → client)
```
TUI: "Restore dotfiles" → select app → select host → select version
       │
       ▼
GET /api/v1/dotfiles/nvim/20260712_143022
       │
       ▼
lamasyncd downloads tarball, shows preview (file list)
       │
       ▼
User confirms → extract to original paths (or custom dir)
```

---

## Server Config Distribution

When a new client registers (`POST /api/v1/register` with hostname + tailnet IP):

1. Server creates `hosts` row
2. If pre-configured folders exist for this hostname, assigns them
3. Client does `GET /api/v1/config/:host_id` → receives:
   - All folder assignments with `local_path`, `role`, schedule
   - All dotfile manifests with paths
   - rclone config fragments for each remote pairing
   - Server's tailnet IP for rclone SFTP remotes
4. Client writes local config cache, sets up systemd timer units for schedules
5. Client runs initial sync for each assigned folder

---

## Conflict Resolution Strategies

Configured per folder, stored in `folder_assignments`:

| Strategy | Behavior |
|----------|----------|
| `newer_wins` | Last-modified timestamp decides |
| `source_wins` | Designated source host always wins |
| `keep_both` | Rename conflicting file with `.conflict-YYYYMMDD` suffix |
| `manual` | Queue conflict, notify TUI, pause that folder until resolved |

---

## Sanity Checks (per-operation)

1. **Pre-flight:** source path exists, destination reachable, disk space > threshold
2. **In-flight:** rclone exit code check, timeout detection (stalled transfer)
3. **Post-flight:** file count diff, checksum spot-check, permission audit
4. **Periodic:** integrity scan compares checksums of last N backups against source

Failures → `POST /api/v1/report` with structured error → server logs → optional NTFY webhook.

---

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language | Rust | OpenTUI ecosystem, single binary, no runtime |
| TUI | OpenTUI (ratatui) | Already chosen, mature Rust TUI |
| HTTP server | axum | Async, well-typed, tower middleware |
| HTTP client | reqwest | De facto Rust HTTP client |
| Database | SQLite via rusqlite | Zero-admin, embedded |
| Serialization | serde + serde_json | Standard |
| Config format | TOML | Human-writable, serde support |
| Async runtime | tokio | Required by axum, standard |
| rclone integration | std::process::Command | Shell-out, parse JSON output (`--use-json-log`) |
| Unix socket | tokio::net::UnixListener | daemon ↔ TUI IPC |
| Logging | tracing | Structured, levels, multiple subscribers |
| Testing | cargo test + testcontainers (integration) | Standard Rust |

---

## Deployment

### Server (Docker on TrueNAS)

```dockerfile
FROM rust:alpine AS builder
# ... build release binary

FROM alpine:latest
RUN apk add --no-cache rclone ca-certificates
COPY --from=builder /app/lamasync-server /usr/local/bin/
VOLUME /data /backups
EXPOSE 8080
ENTRYPOINT ["lamasync-server"]
```

```yaml
# docker-compose.yml
services:
  lamasync:
    image: lamasync-server:latest
    volumes:
      - /mnt/tank/lamasync/data:/data      # SQLite DB
      - /mnt/tank/lamasync/backups:/backups  # dotfile tarballs
    ports:
      - "100.64.0.1:8080:8080"  # Tailnet IP only, not exposed to LAN
    environment:
      - LAMASYNC_API_KEY=...
      - LAMASYNC_NTFY_URL=https://ntfy.sh/...
    restart: unless-stopped
```

### Client

```bash
# One-liner install
curl -sSL https://your-server/install.sh | bash
# → downloads binary, creates ~/.config/lamasync/, installs systemd user unit
```

```
~/.config/lamasync/
├── client.toml          # server URL, API key, hostname
├── config-cache.json     # last pulled config from server
└── rclone/
    └── lamasync.conf     # generated rclone remotes

~/.local/share/lamasync/
└── logs/
```

```
# ~/.config/systemd/user/lamasyncd.service
[Unit]
Description=LamaSync Daemon

[Service]
ExecStart=%h/.local/bin/lamasyncd
Restart=on-failure

[Install]
WantedBy=default.target
```

---

## Project Layout

```
lamasync/
├── ARCHITECTURE.md
├── Cargo.toml              # workspace
├── crates/
│   ├── lamasync-core/      # shared types, DB schema, config models
│   ├── lamasync-server/    # axum server, API handlers, scheduler
│   ├── lamasync-daemon/    # client daemon binary
│   ├── lamasync-tui/       # OpenTUI application
│   └── lamasync-cli/       # thin CLI for quick ops, service install
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── config-examples/
│   ├── server.toml
│   └── client.toml
└── tests/
    └── integration/
```

---

## Open Questions / Future

1. **rclone bisync vs `rclone sync`** — bisync is bidirectional but newer and less battle-tested. Start with one-way `sync` per direction and graduate to bisync when stable.
2. **Delta transfers** — rclone doesn't do block-level delta. For large files that change frequently, consider `rsync` as an optional backend for specific folders.
3. **Encryption at rest** — rclone crypt remote on top of SFTP for sensitive folders. Trivial to add later since rclone handles it.
4. **Mobile** — out of scope. This is a Linux-to-Linux tool.
5. **Windows/WSL** — not a priority, but Rust + rclone both work on Windows. Design the paths to be configurable, not hardcoded to `/home`.
