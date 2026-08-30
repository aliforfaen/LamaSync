# LamaSync — Architecture

## Overview

```
┌─ TrueNAS (Docker) ──────────────────────────────────────────┐
│  lamasync-server                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ REST API │ │ Scheduler│ │ Dotfile  │ │ rclone Config  │  │
│  │ (Elysia) │ │(heartbeat│ │ Registry │ │ Generator      │  │
│  │          │ │ + cron)  │ │          │ │                │  │
│  └────┬─────┘ └────┬─────┘ └────┬────┘ └───────┬────────┘  │
│       └──────────────┴───────────┴───────────────┘           │
│                         │ SQLite (bun:sqlite)                │
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

Three binaries per machine:

- **`lamasync-server`** — REST API + WS event stream, host & folder registry,
  dotfile storage, scheduler, rclone config generator. Runs in Docker on
  TrueNAS.
- **`lamasyncd`** — background daemon (`systemd --user`), spawns and supervises
  rclone processes, runs cron-driven sync schedules, reports status to the
  server, exposes a Unix socket for the local TUI.
- **`lamasync-tui`** — OpenTUI frontend, talks to the local daemon over a
  Unix socket for the local view and to the server REST/WS for the fleet view.
- **Management Web UI** — React SPA embedded in `lamasync-server` at `GET /`.
  Built with Vite and inlined into a single `dist/index.html` by
  `scripts/inline-web-ui.ts`; auth uses the same pre-shared API key via
  `sessionStorage` and REST/WebSocket calls.

The agent skill at `packages/agent-skill/SKILL.md` (CLI-first, two-tier
bundle: `SKILL.md` + `reference/{cli,api,recipes,troubleshooting,safety}.md`)
lets external agents register, manage folders, and report on operations
against the same API.

---

## Folder Types

| Type     | Direction      | Engine                           | Use Case                              |
|----------|----------------|----------------------------------|---------------------------------------|
| `sync`   | Bidirectional  | `rclone bisync`                  | LamaFiles between desktop + laptop    |
| `mount`  | Remote → local | `rclone mount` + VFS cache       | Large repos you don't want downloaded |
| `backup` | Local → server | `rclone copy` (one-way)          | `/opt/appdata`, home dir snapshots     |
| `dotfile`| Local → server | `tar czf` + rclone `copyto`      | Per-app configs, versioned on server  |
| `git`    | Local ↔ origin | `git fetch` + `git pull --rebase`| Git repos synced without re-downloading tree |

The `git` type runs a plain `git` binary instead of rclone. The daemon rejects
sync when the worktree is dirty, when no `origin` remote exists, or when the
upstream branch is not configured. The report includes `commitsAhead`,
`commitsBehind`, `dirtyFiles`, and `lastCommit` for monitoring.

---

## Database Schema (SQLite, server-side, `bun:sqlite`)

The full schema lives in `packages/core/src/db/schema.ts` and is applied on
DB open via `initDb()`. New columns are added in the same file's
`MIGRATIONS` array (idempotent `ALTER TABLE`).

```sql
-- Registered hosts (clients + server itself)
CREATE TABLE hosts (
    id          TEXT PRIMARY KEY,  -- hostname or uuid
    hostname    TEXT NOT NULL,
    tailnet_ip  TEXT,
    lan_ip      TEXT,              -- first non-internal IPv4 for LAN peer sync
    last_seen   INTEGER,
    status      TEXT DEFAULT 'unknown'  -- online, offline, degraded
);

-- Folder definitions (canonical, created once)
CREATE TABLE folders (
    id              TEXT PRIMARY KEY,   -- uuid
    name            TEXT NOT NULL,
    type            TEXT NOT NULL,      -- sync, mount, backup, dotfile, git
    encrypted       INTEGER DEFAULT 0,  -- rclone crypt wrapper
    crypt_password  TEXT,               -- base64 password (and password2 salt)
    created_at      INTEGER
);

-- Which hosts participate in which folders, and how
CREATE TABLE folder_assignments (
    id                          TEXT PRIMARY KEY,
    folder_id                   TEXT NOT NULL REFERENCES folders(id),
    host_id                     TEXT NOT NULL REFERENCES hosts(id),
    role                        TEXT NOT NULL,        -- source, target, both
    local_path                  TEXT NOT NULL,
    remote_name                 TEXT,
    sync_expr                   TEXT,                 -- cron expression
    enabled                     INTEGER DEFAULT 1,
    conflict_strategy           TEXT,                 -- newer_wins, source_wins, keep_both, manual
    pre_sync_cmd                TEXT,
    post_sync_cmd               TEXT,
    ignore_path                 TEXT,
    mount_ignore_path           TEXT,
    timeout_sec                 INTEGER,
    bandwidth_schedule          TEXT,                 -- rclone --bwlimit value
    max_retries                 INTEGER DEFAULT 3,
    available_space_threshold   INTEGER,              -- bytes; pre-flight check
    cache_profile               TEXT,                 -- normal / media / minimal
    cache_max_size              TEXT,                 -- e.g. "1G"
    UNIQUE(folder_id, host_id)
);

-- Dotfile manifests: which paths belong to which app
CREATE TABLE dotfile_manifests (
    id            TEXT PRIMARY KEY,
    host_id       TEXT NOT NULL,      -- hosts.id or '_global' for shared app definitions
    app_name      TEXT NOT NULL,
    paths         TEXT NOT NULL,      -- JSON array of paths
    schedule      TEXT,               -- cron expression
    instructions  TEXT,               -- setup notes shown during restore
    UNIQUE(host_id, app_name)
);

-- Versioned dotfile tarballs
CREATE TABLE dotfile_versions (
    id            TEXT PRIMARY KEY,
    manifest_id   TEXT NOT NULL REFERENCES dotfile_manifests(id),
    timestamp     INTEGER NOT NULL,
    tarball_path  TEXT NOT NULL,        -- relative to /backups volume
    size_bytes    INTEGER,
    checksum      TEXT,                 -- sha256
    description   TEXT                  -- optional label, e.g. "before nvim rewrite"
);

-- Operation log (sync runs, backups, errors)
CREATE TABLE operation_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   INTEGER NOT NULL,
    host_id     TEXT NOT NULL,
    folder_id   TEXT,
    operation   TEXT NOT NULL,          -- sync, mount, backup, dotfile_push, dotfile_pull, git
    status      TEXT NOT NULL,          -- started, success, failed, conflict, recovery, retry
    summary     TEXT,                   -- "42 files up, 3 conflicts"
    details     TEXT,                    -- JSON: file list, error messages
    duration_ms INTEGER
);

-- Per-assignment schedule + lock coordination
CREATE TABLE schedule_state (
    folder_assignment_id TEXT NOT NULL UNIQUE REFERENCES folder_assignments(id),
    last_run             INTEGER,
    next_run             INTEGER,
    last_status          TEXT,
    locked_by            TEXT,           -- host id holding the lock
    locked_at            INTEGER,
    lock_ttl             INTEGER DEFAULT 1200
);
```

Retention: a daily prune deletes `operation_log` rows older than
`LAMASYNC_LOG_RETENTION_DAYS` (default `90`), preserving the most recent
entry per host so offline hosts keep their last-known status.

---

## REST API (Server)

```
GET    /api/v1/health                          → fleet summary + host statuses
GET    /api/v1/config/:host_id                 → full config for a host
POST   /api/v1/register                        → new host self-registration
POST   /api/v1/report                          → client submits operation result
POST   /api/v1/report/health                   → client heartbeat + local stats

GET    /api/v1/dotfiles/manifests              → list effective manifests (global + host overrides)
POST   /api/v1/dotfiles/manifests              → create/update a manifest
PUT    /api/v1/dotfiles/manifests/:id          → update a manifest
DELETE /api/v1/dotfiles/manifests/:id          → delete a manifest and its versions
GET    /api/v1/dotfiles/:app_name              → list available versions
GET    /api/v1/dotfiles/:app_name/:version     → download tarball
POST   /api/v1/dotfiles/:app_name              → upload new version (multipart; records sha256 checksum)
DELETE /api/v1/dotfiles/:app_name/:version     → prune old version

GET    /api/v1/folders                         → list all folders
POST   /api/v1/folders                         → create folder definition
PUT    /api/v1/folders/:id                     → update folder
DELETE /api/v1/folders/:id                     → remove folder
POST   /api/v1/folders/:id/assign              → assign folder to host
DELETE /api/v1/folders/:id/assign/:host_id     → unassign

POST   /api/v1/operations/acquire              → acquire canonical destination lock (body `destinationKey?`)
POST   /api/v1/operations/heartbeat            → renew lock
POST   /api/v1/operations/release              → release lock
GET    /api/v1/operations/locks                → list active destination locks
GET    /api/v1/operations                      → list operation_log entries



GET    /api/v1/shares                          → NFS/SMB share catalog (env-driven)
GET    /api/v1/release/latest                  → latest GitHub release info (server proxy)
POST   /api/v1/admin/prune                     → manual operation_log prune

WS     /api/v1/ws                              → live event stream (operations, mounts, locks)
```

### Auth (LAMA-234: master / admin / device credentials)

Credentials resolve to one of three typed principals (`AuthPrincipal` in
`core/src/types.ts`) on every request:

- **master** — the pre-shared `LAMASYNC_API_KEY` env value. Super-admin,
  never stored in SQLite, never returned by any route, never shown in the
  UI. Existing clients keep working until they voluntarily re-pair.
  Production rotation is an intentional deployment operation (change
  `.env`, recreate, re-pair legacy clients), not an in-app button.
- **admin** — a managed key (`api_keys` table) created via the Web UI /
  `POST /api-keys`. Full admin surface, may manage other managed keys.
  The raw secret is surfaced only at creation and by an explicit, audited
  `POST /api-keys/:id/reveal`; it is stored as SHA-256 hash (auth) plus an
  AES-256-GCM copy (reveal only) via `server/src/crypto.ts` — the legacy
  plaintext fallback is never used for new keys.
- **device** — minted by the pairing exchange, bound to exactly one host.
  A route-level allowlist in `server/src/auth.ts` confines device keys to
  their own control-plane calls (config, registration, reports, action
  queue/completions, locks, conflicts, restic snapshots + restore jobs,
  dotfile uploads, release checks, `/auth/me`); everything else is 403 at
  the auth boundary. Host-bearing routes enforce ownership on top
  (`deviceMayAccessHost` / `requireAdmin`).

- REST: `Authorization: Bearer <key>`; `auth.ts` resolves once into the
  principal and attaches it to the Elysia store.
- WebSocket upgrades authenticate via `Sec-WebSocket-Protocol: lamasync-auth, <base64(key)>`;
  only master/admin keys may subscribe to the fleet stream (v1). The
  query-string `?apiKey=...` form is deprecated.
- Revoked managed keys resolve to 401 exactly like a bad key.
- Paired devices mint `lmsk.<keyId>.<secret>` tokens with the public keyId
  embedded for O(1) lookup; `last_used_at` writes are rate-limited.
- Tailnet provides transport encryption; the API key is a lightweight
  "you're allowed" check.

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
│  │  - bisync / sync / copy / mount     │ │
│  │  - retry + backoff                  │ │
│  │  - bisync state recovery            │ │
│  │  - mount lifecycle (stale detect)   │ │
│  │  - git (folders of type "git")      │ │
│  │  - disk-space pre-flight            │ │
│  │  - LAN peer sync (rclone serve sftp)│ │
│  └─────────────────────────────────────┘ │
│                                          │
│  Unix socket: $LAMASYNC_SOCKET_PATH      │
└──────────────────────────────────────────┘
```

**Lifecycle of a sync:**

1. Scheduler fires (or manual trigger from the TUI).
2. Pulls folder config from local cache (synced with the server).
3. Acquires the server-side lock keyed by the folder's **canonical
   destination/repository key** (`acquireLock`), with bounded backoff +
   jitter/coalescing via `acquireLockWithRetry`.
4. Pre-flight checks: rclone binary present, disk space >= threshold.
5. Spawns `rclone bisync source:path dest:path --config /tmp/lamasync-rclone.conf`.
6. Streams `--use-json-log` for transfer stats.
7. Detects bisync state corruption and auto-recovers (`--resync`).
8. Post-hook runs on success.
9. Releases the lock and posts the report via `POST /report`.

**Destination & lock model (LAMA-294):** the connection alias
(`FolderAssignment.remoteName`) is separate from the destination path/prefix
(`FolderAssignment.destination`). Ordinary backups host-scope by default to
`<folder-name>/<host-id>`, so different hosts never collapse onto one
namespace; sync/mount stay shared (`<folder-name>`). The **canonical
destination key** (from `core/destination.ts`) is the server-side lock
identity — `folder_locks` is keyed on `destination_key` (folder_id kept for
diagnostics). Two assignments that write the same physical destination (or
share a Restic repo) are serialized; distinct prefixes under one backend run
concurrently. Lock contention or a control-plane outage is a first-class
`deferred` outcome (not a failed backup), retried in-process so a
simultaneous schedule isn't skipped until the next cron.

### Self-update (LAMA-151)

The daemon checks for updates against GitHub Releases on startup and exposes
`--check-update` / `--update` CLI flags. The server provides
`GET /api/v1/release/latest` as a proxy so clients behind firewalls can fetch
release metadata without direct GitHub access. The `packaging/install/update.sh`
script is a standalone `curl | bash` updater for clients.

**Mount lifecycle (LAMA-130/LAMA-113):**

- Daemon owns the rclone process and tracks its PID in
  `/run/user/<uid>/lamasync/mounts/<folderId>.pid`.
- Cache profiles (`normal` / `media` / `minimal`) configure `--vfs-cache-mode`,
  `--vfs-cache-max-age`, and `--vfs-cache-max-size` defaults.
- Stale mounts (dead PID, FUSE still attached) are force-unmounted.
- On crash, restart backoff is 1 min → 5 min → 15 min, then give up.

**Sync ↔ Mount switch (LAMA-131):**

- `switch-to-mount`: flush sync, move local contents to
  `~/.local/share/lamasync/trash/<folderId>_<ts>/`, start the mount,
  schedule trash deletion in 24h.
- `switch-to-sync`: stop the mount, run a one-way rclone copy to pull files
  local.

**LAN peer sync (LAMA-123):**

- When two hosts are on the same `/24` subnet and both are online, the
  server emits a peer rclone remote.
- The lexicographically smaller host id serves via `rclone serve sftp` for
  the duration of the sync; the other connects SFTP to the peer's LAN IP.
- On 5s connection timeout, fall back to the standard server relay.

### `lamasync` (CLI + TUI, LAMA-229/276)

The `lamasync` binary is BOTH the OpenTUI shell AND a non-interactive CLI:
any positional subcommand (`lamasync status`, `lamasync folders list …`)
routes to non-interactive dispatch (exit codes 0/1/2/3/4 = ok/runtime/
usage/auth-failure/unreachable; `--json` everywhere); bare invocation with a
TTY boots the shell; `LAMASYNC_NO_TUI=1` keeps the legacy CLI fallback.

The shell's tabs are task-oriented (LAMA-275 D3/D4, approved):

- **This device** — folder list for the local host (hotkeys `1` sync all,
  `2` sync one, `3` refresh, `p` cache profile, `s` switch type,
  `n` network shares, `w` new backup; the footer repaints per-folder
  actions for the selected row).
- **All devices** — live fleet via `/api/v1/ws` host events.
- **Backups & apps** — fleet-wide backup folders + dotfile restores.
- **Conflicts** / **Activity** — pending resolutions / operation log.
- **More** — tools & integrations; GitHub (repo adoption via `gh`) is a
  drill-in view hidden from the tab bar, reached from More or the `g`
  hotkey, Esc returns to More.

**Local mode** (default, connects to Unix socket); **Fleet mode** connects
to server REST + WS and subscribes to `/api/v1/ws` host events.

---

## Dotfile Flow

### Manifest model

- Manifests are keyed by `(host_id, app_name)`. `host_id = "_global"` defines a
  shared app (e.g. `opencode`) for every host. A host-specific manifest for the
  same `app_name` overrides the global one, enabling per-machine subsets like
  restoring only `~/.config/opencode/agents` on an existing client.
- Manifests carry `paths` and optional `instructions` (setup notes shown in the
  TUI after restore).

### Backup (client → server)

```
TUI trigger / cron
       │
       ▼
lamasyncd reads effective dotfile manifest for app (e.g., opencode)
       │
       ▼
tar czf /tmp/lamasync-dotfile-opencode-<ts>.tar.gz \
    ~/.config/opencode
       │
       ▼
POST /api/v1/dotfiles/opencode (multipart tarball)
  → server stores file, computes sha256, records version in DB
       │
       ▼
Cleanup temp tarball
```

### Restore (server → client)

```
TUI: "Dotfiles"
       │
       ▼
Setup (fresh install): restore latest version of every effective app to /
  OR
Select app → select version → preview file list
       │
       ▼
GET /api/v1/dotfiles/opencode/<version-id>
       │
       ▼
Extract to original absolute paths (target = /) or a custom directory;
optionally filter by subpath(s) (e.g. extract only agents/)
```

---

## Server Config Distribution

When a new client registers (`POST /api/v1/register`):

1. Server upserts the `hosts` row with `tailnetIp` (and `lanIp` on the next
   health report).
2. Client does `GET /api/v1/config/:host_id` and receives:
   - All folder assignments with `local_path`, `role`, schedule, cache profile.
   - All dotfile manifests with paths.
   - rclone config fragments: each folder becomes a named remote. Encrypted
     folders emit a backend remote plus a `crypt` wrapper. When a LAN peer
     is detected, an extra peer remote is added.
   - Server's tailnet IP for SFTP remotes.
3. Client writes local config cache, sets up timers for schedules.
4. Client runs initial sync for each assigned folder.

Every config-affecting change (assignment updates, host rename,
`tailnet_ip` set/clear, write of a cached value) bumps `config_revision`;
clients compare it on every 30s heartbeat and re-pull immediately when it
moves, so peer remotes (tailnet + LAN sections) and schedules stay fresh
without waiting for the 5-minute refresh timer.

---

## Conflict Resolution Strategies

Configured per folder, stored in `folder_assignments.conflict_strategy`:

| Strategy      | Behavior                                                |
|---------------|---------------------------------------------------------|
| `newer_wins`  | Last-modified timestamp decides                         |
| `source_wins` | Designated source host always wins                      |
| `keep_both`   | Rename conflicting file with `.conflict-YYYYMMDD` suffix|
| `manual`      | Queue conflict, notify TUI, pause folder until resolved|

---

## Sanity Checks (per-operation)

1. **Pre-flight:** rclone installed, source path exists, destination
   reachable, disk space >= `availableSpaceThreshold`.
2. **In-flight:** rclone exit code, timeout detection, JSON-log stats.
3. **Post-flight:** post-hook (optional), bisync state recovery on
   corruption markers.
4. **Periodic:** operation_log retention prune (daily).

Failures → `POST /api/v1/report` with structured `OperationReport` → server
logs to `operation_log`, broadcasts a WS `operation` event, optionally
notifies via NTFY.

---

## Technology Stack

| Layer              | Choice                      | Rationale                                                |
|--------------------|-----------------------------|----------------------------------------------------------|
| Language           | TypeScript                  | Single-language stack across server, daemon, TUI         |
| Runtime            | Bun ≥ 1.3                   | `bun:sqlite`, `Bun.spawn`, single-file `--compile` binaries |
| HTTP server        | Elysia                      | Lightweight, built-in validation, Swagger plugin         |
| HTTP client        | global `fetch` (Bun)        | Zero-dependency HTTP                                      |
| WebSocket          | Elysia `ws`                 | Built-in, no extra dependency                            |
| Database           | SQLite via `bun:sqlite`     | Zero-admin, embedded, synchronous API                    |
| Schema migrations  | Idempotent `ALTER TABLE`    | Applied in `initDb()`; duplicate-column errors ignored   |
| Serialization      | `JSON.parse` / `JSON.stringify` | Standard, no schema framework needed for internal use |
| Config format      | TOML (server, client)       | Human-writable; server uses env for runtime config       |
| TUI framework      | OpenTUI (`@opentui/core`)   | Native terminal rendering with vnode model               |
| rclone integration | `Bun.spawn(["rclone", ...])`| Direct argv; no shell escaping concerns                   |
| Unix socket        | `node:net.Server`           | Daemon ↔ TUI control channel                             |
| Testing            | `bun:test`                  | Built-in test runner                                     |
| Build              | `bun build --compile`       | Produces standalone binaries per package                  |

---

## Deployment

### Server (Docker on TrueNAS)

```dockerfile
FROM oven/bun:1.3 AS builder
WORKDIR /src
COPY package.json bun.lock ./
COPY packages packages
RUN bun install --frozen-lockfile && bun run build

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends rclone ca-certificates tini && rm -rf /var/lib/apt/lists/*
COPY --from=builder /src/packages/server/dist/lamasync-server /usr/local/bin/
VOLUME ["/data", "/backups"]
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/lamasync-server"]
```

```yaml
# docker-compose.yml
services:
  lamasync:
    build: .
    image: lamasync-server:latest
    volumes:
      - /mnt/tank/lamasync/data:/data
      - /mnt/tank/lamasync/backups:/backups
    ports:
      - "100.64.0.1:8080:8080"  # Tailnet IP only
    environment:
      - LAMASYNC_API_KEY=...
      - LAMASYNC_LOG_RETENTION_DAYS=90
      - LAMASYNC_TAILNET_IP=100.64.0.1
    restart: unless-stopped
```

The image ships the precompiled Bun binary plus rclone and tini. Health check
pings `GET /api/v1/health` with the bearer token.

### CI/CD and releases

`.github/workflows/ci.yml` runs on every push/PR and on `v*` tags:

1. `check` job: type-check (`bun x tsc --noEmit`) and test (`bun test`).
2. `build` job: compile all three binaries and upload them as artifacts.
3. `release` job (tag push only): publish binaries to a GitHub Release and push a
   Docker image to `ghcr.io/<owner>/lamasync-server:<version>` and `:latest`.

The daemon also supports `lamasyncd --update` to fetch the latest binaries from a
GitHub Release directly. See `packaging/install/update.sh` for the standalone
`curl | bash` update path.

### Client

```bash
# One-liner install — pulls the platform-specific binary
# (omit --with-tui if you only need the daemon)
curl -sSL https://github.com/aliforfaen/LamaSync/releases/latest/download/install.sh | bash -s -- --with-tui
# → downloads lamasyncd and lamasync-tui, creates ~/.config/lamasync/,
#   installs systemd --user unit (see packaging/systemd/)

# One-liner update (checks GitHub Releases and replaces binaries)
curl -sSL https://github.com/aliforfaen/LamaSync/releases/latest/download/update.sh | bash
```

```
~/.config/lamasync/
├── client.toml          # server URL, API key, hostname
├── config-cache.json     # last pulled config from server
└── smb-credentials/      # LAMA-132: SMB credentials per share (mode 0600)

~/.local/share/lamasync/
├── bisync/<folderId>/    # persistent bisync state
├── trash/                # LAMA-131: 24h trash after sync→mount
└── logs/

~/.cache/lamasync/
└── vfs/<folderId>/       # mount VFS cache

/run/user/<uid>/lamasync/
├── lamasync.sock         # daemon control socket (LAMA-218; XDG fallback)
└── mounts/<folderId>.pid # LAMA-113: mount PID tracking

# LAMA-218: when $XDG_RUNTIME_DIR is unset (root containers, old shells),
# the socket falls back to ~/.lamasync/lamasync.sock rather than
# polluting $HOME itself. The shared helper that decides this lives in
# `@lamasync/core/socket-path.ts`.
```

```
# packaging/systemd/lamasyncd.service (template)
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
├── package.json              # Bun workspace root
├── tsconfig.json             # strict, bundler resolution, .ts extensions
├── bun.lock
├── AGENTS.md                 # working reference (source of truth for behavior)
├── ARCHITECTURE.md           # this file
├── docker/
│   ├── Dockerfile.server     # multi-stage: bun build → debian-slim + rclone
│   └── docker-compose.yml
├── packages/
│   ├── core/                 # @lamasync/core — shared types, DB, config, API client
│   │   ├── src/types.ts      # Host, Folder, FolderAssignment, HealthReport, …
│   │   ├── src/db/schema.ts  # SERVER_SCHEMA + MIGRATIONS
│   │   └── src/api-client.ts # 16 endpoint methods
│   ├── server/               # @lamasync/server — Elysia REST + WS
│   │   ├── src/auth.ts
│   │   ├── src/ws.ts         # WS auth via Sec-WebSocket-Protocol
│   │   └── src/routes/       # health, hosts, config, folders, dotfiles,
│   │                          # operations, report, admin, templates, shares
│   ├── daemon/               # @lamasync/daemon — lamasyncd
│   │   ├── src/index.ts      # heartbeat, scheduler, mount lifecycle
│   │   ├── src/executor.ts   # rclone / git dispatch table
│   │   ├── src/mounts.ts     # mount registry, restart, health-check
│   │   ├── src/socket.ts     # Unix socket control protocol
│   │   └── src/lock.ts       # server-side lock coordination
│   ├── tui/                  # @lamasync/tui — OpenTUI frontend
│   │   ├── src/index.ts
│   │   └── src/views/        # menu, local, fleet, logs, dotfiles
│   └── agent-skill/          # CLI-first agent skill (LAMA-230)
│       ├── SKILL.md          #   trigger + decision tree + safety summary
│       ├── reference/        #   cli.md, api.md, recipes.md, troubleshooting.md, safety.md
│       └── lamasync-client.md  # separate client-install onboarding skill
├── packaging/
│   ├── install/              # curl | bash installer
│   └── systemd/              # lamasyncd.service template
└── config-examples/
    ├── server.toml
    └── client.toml
```

---

## Open Questions / Future

1. **rclone bisync vs `rclone sync`** — bisync is bidirectional and well
   supported, with auto-recovery in our wrapper. We keep bisync as the
   default.
2. **Delta transfers** — rclone doesn't do block-level delta. For large
   frequently-changing files, an rsync backend per folder is a future
   addition.
3. **Encryption at rest** — implemented (LAMA-124) as an rclone `crypt`
   remote on top of SFTP. The crypt password is distributed inside the
   generated rclone config (which is itself 0o600 on disk).
4. **Mobile** — out of scope. This is a Linux-to-Linux tool.
5. **Windows/WSL** — paths are hardcoded to Unix conventions. rclone works
   on Windows but the daemon does not.
6. **v0.2.0 completionist verification** — the suite now stands at 118 unit
   tests across 19 files, including the Management Web UI and embedded-web-ui
   route. End-to-end verification of mount lifecycle and sync↔mount switch
   safety still requires a real SFTP/NFS target; the code paths are exercised
   and return the expected error states in unit tests.
