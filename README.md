# LamaSync

Personal sync-fleet controller. One server manages folder syncs, backups,
and dotfile versions across your machines — all orchestrated through **rclone**
over a tailnet.

```
 TrueNAS (Docker)          Laptop                 Desktop
 ┌──────────────┐         ┌──────────┐          ┌──────────┐
 │ lamasync-    │◄──REST──┤lamasyncd │          │lamasyncd │
 │ server       │◄──WS────┤Unix sock │◄─────────┤Unix sock │
 │ SQLite       │         │lamasync- │          │lamasync- │
 │ rclone SFTP  │◄──rclone┤   tui    │          │   tui    │
 └──────────────┘         └──────────┘          └──────────┘
```

The server pushes **folder assignments, schedules, dotfile manifests, and a
generated rclone config** to each client. The client daemon runs rclone against
its local paths and reports results back.

## Features

- **Folder types**: `sync` (bidirectional via `rclone bisync`), `mount`
  (read-only SFTP via `rclone mount`), `backup` (one-way `rclone copy`),
  `dotfile` (tar.gz + `rclone copyto`)
- **Conflict strategies** per folder: `newer_wins`, `source_wins`, `keep_both`,
  `manual` (pauses for UI resolution)
- **`.lamasyncignore`** per-folder glob exclude patterns
- **Pre/post hooks** — shell scripts that run before/after each sync
- **Cron schedules** with `cron-parser`
- **Live WebSocket** for operation events
- **TUI** in OpenTUI: menu, local dashboard, fleet view, dotfile restore,
  log viewer
- **Systemd user service** with hardened sandbox
- **One-line install** on clients
- **Self-update** from GitHub Releases (`lamasyncd --update` or `curl | bash update.sh`)
- **CI/CD** with GitHub Actions (tests, builds, releases, Docker push)

![CI](https://github.com/aliforfaen/LamaSync/actions/workflows/ci.yml/badge.svg)

## Getting started

### 0. Prereqs

- [Bun](https://bun.sh) ≥ 1.3 on the server (for dev/build)
- [rclone](https://rclone.org/install/) on every client (and the server, if you
  want it to also be a client)
- A tailnet (Tailscale, Headscale, …) so all hosts have stable IPs

### 1. Start the server (Docker on TrueNAS)

```bash
git clone https://github.com/aliforfaen/LamaSync.git
cd LamaSync
cp docker/.env.example docker/.env
$EDITOR docker/.env  # set LAMASYNC_API_KEY and LAMASYNC_TAILNET_IP
docker compose -f docker/docker-compose.yml up -d
```

The server listens on `<tailnet-ip>:8080`. Verify:

```bash
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" http://100.64.0.1:8080/api/v1/health
# → {"status":"ok","hostCount":0,"onlineCount":0,"hosts":[]}
```

The Swagger UI is at `http://100.64.0.1:8080/swagger` and the machine-readable
spec at `http://100.64.0.1:8080/swagger/json`.

### 2. Install the daemon on a client

The daemon is a single static binary. Build once on the server, copy to clients,
or use the install script.

```bash
# On the client, with lamasyncd built and the server URL handy:
# (add --with-tui to also install lamasync-tui)
curl -sSL https://github.com/aliforfaen/LamaSync/raw/main/packaging/install/install.sh | bash -s -- \
  --server-url http://100.64.0.1:8080 \
  --api-key "$LAMASYNC_API_KEY" \
  --with-tui

# Or run from the repo:
./packaging/install/install.sh \
  --server-url http://100.64.0.1:8080 \
  --api-key "$LAMASYNC_API_KEY" \
  --with-tui

# Update an existing install:
curl -sSL https://github.com/aliforfaen/LamaSync/releases/latest/download/update.sh | bash
```

The script:
- Downloads the right `lamasyncd` binary into `~/.local/bin`
- Writes `~/.config/lamasync/client.toml` (mode 600)
- Installs the systemd **user** unit
- Enables lingering and starts the service

Verify:

```bash
systemctl --user status lamasyncd
journalctl --user -u lamasyncd -f
```

### 3. Open the Management Web UI (optional but recommended)

The server embeds a React management UI at `/`. After starting the server:

```bash
xdg-open http://100.64.0.1:8080/   # or open the URL in any browser
```

Log in with the same `$LAMASYNC_API_KEY`. The UI lets you:

- Browse the dashboard (hosts, recent operations, counts)
- Create, edit, and delete folders
- View folder assignments per folder
- Create and delete dotfile manifests
- Resolve pending sync conflicts
- Prune the operation log by age

The UI stores the API key in `sessionStorage` and talks to the same
`/api/v1/*` endpoints as the curl examples below.

### 4. Register a folder assignment

You can create folders and assignments through the Web UI, the TUI's GitHub
repo selector, or directly via the API:

```bash
# Create a folder
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"LamaFiles","type":"sync"}' \
  http://100.64.0.1:8080/api/v1/folders
# → {"id":"<FOLDER_ID>","name":"LamaFiles","type":"sync","createdAt":...}

# Assign it to your host
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "hostId":"'"$(hostname)"'",
    "role":"both",
    "localPath":"/home/'"$USER"'/LamaFiles",
    "syncExpr":"*/15 * * * *",
    "conflictStrategy":"newer_wins"
  }' \
  http://100.64.0.1:8080/api/v1/folders/<FOLDER_ID>/assign
```

Within 5 minutes (the daemon's config refresh interval), the daemon will pick
up the new assignment, write a temp rclone config, and start syncing on the
schedule.

### 5. Open the TUI

```bash
# Build the TUI binary (or copy from server)
bun run build

# Local mode (talks to lamasyncd over Unix socket)
./packages/tui/dist/lamasync-tui

# Or, if the daemon isn't running on this machine, point at the server:
LAMASYNC_SERVER_URL=http://100.64.0.1:8080 \
LAMASYNC_API_KEY="$LAMASYNC_API_KEY" \
  ./packages/tui/dist/lamasync-tui

# CLI fallback (no OpenTUI native renderer required)
LAMASYNC_NO_TUI=1 LAMASYNC_SERVER_URL=http://100.64.0.1:8080 LAMASYNC_API_KEY="$KEY" \
  ./packages/tui/dist/lamasync-tui
```

The TUI has five views: **Local**, **Fleet**, **Dotfiles**, **Logs**, **Quit**.
Hotkeys per view are shown in the bottom row.

### 6. Restore a dotfile version

1. Open the TUI, choose **Dotfiles**.
2. Pick an app (e.g. `nvim`) → pick a version → see the file list preview.
3. Confirm and choose an extraction directory. The tarball is downloaded from
   the server and extracted locally.

## Architecture

| Component | Purpose |
|-----------|---------|
| `lamasync-server` | REST API + WebSocket + SQLite + embedded React Management Web UI. Generates rclone config fragments per host. |
| `lamasyncd` | Per-host systemd user daemon. Manages rclone processes, schedules, ignore patterns, hooks, and exposes a Unix socket for the TUI. |
| `lamasync-tui` | OpenTUI terminal UI. Connects to local daemon over Unix socket, or directly to the server. |

Server endpoints are documented via Swagger at `/swagger` and the
`lamasync-server` agent skill (`packages/agent-skill/lamasync-server.md`).

### Configuration flow

1. Client registers via `POST /api/v1/register` with `{id, hostname, tailnetIp}`
2. Server returns 201; client appears in `GET /api/v1/health`
3. Daemon polls `GET /api/v1/config/:hostId` every 5 min (also on startup)
4. Response includes: folder assignments (with cron, hooks, ignore, conflict
   strategy), dotfile manifests, generated `rcloneConfig` string, server
   tailnet IP
5. Daemon writes the config to `~/.config/lamasync/config-cache.json`
6. Scheduler arms timers; on each fire, executor builds the rclone command,
   honors hooks, parses JSON log, reports to `POST /api/v1/report`

### rclone config

The server generates one rclone remote per folder assignment. Backends are
pluggable per folder:

- **SFTP** (default) — points at the server's tailnet IP (`LAMASYNC_TAILNET_IP`)
- **S3** — uses the folder's `s3Endpoint`, `s3Bucket`, and credentials
- **local** — for dotfile storage on the server backup directory

The daemon assembles these into a temp rclone config file per operation,
invokes rclone with `--config <path>`, and cleans up afterwards.

## Development

```bash
# Install
bun install

# Type check (always green before commit)
bun x tsc --noEmit

# Build the web UI before tests (the server test imports dist/index.html)
bun run build:web-ui

# Unit tests
bun test

# Build all binaries
bun run build

# Run the full Docker dogfood test (server + MinIO + daemon + TUI CLI fallback)
# 1. Build the test base image (one-time, needs outbound network):
./docker/build-test-base.sh
# 2. Run the full stack test:
./docker/test-stack.sh
# 3. Clean up when done:
# docker compose -f docker/docker-compose.test.yml --env-file docker/.env.test down -v

# Run individual services in dev mode
bun run dev:server     # Elysia with --watch
bun run dev:daemon     # uses ~/.config/lamasync/client.toml
bun run dev:tui        # OpenTUI
bun run dev:web-ui     # Vite dev server with API proxy to :8080
```

### End-to-end test harness

Run a fully isolated server + daemon on a random free port, with the Web UI,
Swagger, and TUI ready to use:

```bash
# Use existing binaries (or build first with bun run build)
./scripts/e2e-harness.sh

# Force a rebuild before starting
./scripts/e2e-harness.sh --rebuild
```

The harness prints the URL, API key, socket path, and example commands. Press
Ctrl+C to stop the server and daemon. Logs and temp data are left in
`./tmp/e2e/` for inspection.

## License

MIT
