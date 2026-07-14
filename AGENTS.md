# AGENTS.md — LamaSync

## Overview

LamaSync is a personal sync-fleet system: one server (on TrueNAS/Docker), a
lightweight daemon on each client, and a terminal UI for local & fleet views.
It wraps **rclone** for file transfers and uses a **pre-shared API key** for auth.
Everything is written in **TypeScript** running on **Bun**.

## Repository layout

```
lamasync/                     # Bun workspace root
  package.json                # workspaces: ["packages/*"]
  tsconfig.json               # strict, bundler resolution, paths → @lamasync/*
  bun.lock
  ARCHITECTURE.md             # full system design & DB schema (source of truth)
  AGENTS.md                   # this file
  docker/
    Dockerfile.server         # multi-stage: bun compile → debian-slim + rclone
    docker-compose.yml        # volumes for /data, /backups; tailnet-bound port
    .env.example
  packages/
    core/                     # @lamasync/core — shared types, DB, config, API client
      src/
        types.ts              # Host, Folder, FolderAssignment, DotfileVersion, …
        config.ts             # TOML parsers for server & client config
        api-client.ts         # LamaSyncApiClient (all endpoint methods)
        db/
          schema.ts           # SERVER_SCHEMA + MIGRATIONS
          client.ts           # initDb(path) : opens SQLite + applies schema
        index.ts              # barrel re-exports
        test.test.ts          # core unit tests
    server/                   # @lamasync/server — Elysia REST API + Swagger + WS
      src/
        index.ts              # swagger → auth → routes → listen(:8080)
        auth.ts               # Bearer token middleware (skips Upgrade: websocket)
        db.ts                 # singleton SQLite handle (lazy + test-safe)
        ws.ts                 # WebSocket event stream (subprotocol auth)
        routes/
          health.ts           # GET /api/v1/health
          hosts.ts            # POST /register, POST /report/health
          config.ts           # GET /config/:hostId (assignments + rclone + peers)
          folders.ts          # CRUD + assign/unassign
          dotfiles.ts         # upload (multipart), list, download, delete
          operations.ts       # GET /operations (filterable, newest-first)
          report.ts           # POST /report (log + schedule_state update)
          shares.ts           # GET /api/v1/shares (NFS shares)
          admin.ts            # operation-log pruning, retention helpers
    daemon/                   # @lamasync/daemon — client sync daemon
      src/
        index.ts              # heartbeat + Unix socket server + switch commands
        config.ts             # reads ~/.config/lamasync/client.toml
        server.ts             # LamaSyncApiClient singleton
        socket.ts             # Unix socket server (commands + status)
        socket.test.ts        # socket command tests
        executor.ts           # rclone spawn, dry-run, bandwidth, disk-space pre-flight
        scheduler.ts          # cron expression sync engine
        mounts.ts             # mount lifecycle: start/stop/health/backoff
        rclone.ts             # rclone config generation helpers
        ignore.ts             # .lamasyncignore / .lamasyncmountignore parsing
        hooks.ts              # pre/post sync shell hooks
        lan-peer.ts           # LAN IP detection + peer SFTP discovery
        lock.ts               # per-folder operation locking
        config-cache.ts       # cached server config for offline operation
    tui/                      # @lamasync/tui — OpenTUI frontend
      src/
        index.ts              # menu, local/fleet views, CLI fallback
        api.ts                # client builder (env → config file → defaults)
        socket-client.ts      # Unix socket client for local mode
        cli-fallback.ts       # LAMASYNC_NO_TUI=1 CLI mode
        views/
          menu.ts             # main menu
          local.ts            # local daemon status + commands
          fleet.ts            # fleet view + WebSocket events
          dotfiles.ts         # dotfile list/restore
          logs.ts             # operation log viewer
    agent-skill/              # @lamasync/agent-skill — OMP managed skill
      lamasync-server.md      # skill body: endpoint table, auth, example workflows
      README.md               # install instructions for OMP managed-skills dir
```

## What's implemented (v0.2.0)

| Component | Status |
|-----------|--------|
| `@lamasync/core` — shared types, DB schema, TOML config, API client | done |
| `@lamasync/server` — REST + WebSocket + Swagger + auth | done |
| `@lamasync/daemon` — heartbeat, rclone execution, mounts, scheduler, socket server | done |
| `@lamasync/tui` — OpenTUI + CLI fallback, local/fleet/dotfiles/logs views | done |
| Agent skill (`lamasync-server.md`) | done (+ installed) |
| Docker: `Dockerfile.server`, `docker-compose.yml` | done |
| `bun run build` → standalone binaries | working |
| Unit tests (core + server + daemon) | 27 passing |
| End-to-end smoke verification (health, register, folders, dotfiles, daemon, TUI) | done |

### Implemented features (LAMA-114..132)

| Issue | Feature | Location |
|-------|---------|----------|
| LAMA-114 | Bandwidth scheduling (`--bwlimit`) | `daemon/src/executor.ts`, `folders.ts` |
| LAMA-115 | (was not in this batch) | — |
| LAMA-116 | Disk-space pre-flight | `daemon/src/executor.ts` |
| LAMA-117 | Operation-log retention | `server/src/routes/admin.ts`, `server/src/index.ts` |
| LAMA-118 | WebSocket auth via subprotocol | `server/src/ws.ts`, `server/src/auth.ts`, `tui/src/views/fleet.ts` |
| LAMA-119 | Dry-run mode | `daemon/src/executor.ts` |
| LAMA-120 | `"git"` folder type | `daemon/src/executor.ts` |
| LAMA-121 | Dotfile template packs | `server/src/routes/folders.ts`, `core/src/types.ts` |
| LAMA-123 | LAN peer sync | `daemon/src/lan-peer.ts`, `server/src/routes/config.ts` |
| LAMA-124 | Encryption-at-rest | `server/src/routes/folders.ts`, `server/src/routes/config.ts` |
| LAMA-125 | `ARCHITECTURE.md` rewrite | `ARCHITECTURE.md` |
| LAMA-130 | Cache profile validation | `server/src/routes/folders.ts` |
| LAMA-131 | Switch-to-mount / sync, trash quarantine | `daemon/src/index.ts`, `daemon/src/mounts.ts`, `tui/src/views/local.ts` |
| LAMA-132 | NFS shares endpoint + TUI `n` hotkey | `server/src/routes/shares.ts`, `tui/src/views/fleet.ts` |

## What's deferred (not yet implemented)

### Server
- **User management / OAuth** — the API key is the only auth mechanism. Multi-user setups would need a `tokens` table, roles, and key rotation.
- **Self-update** — the server binary self-update mechanism is not built. Docker redeployment is the current path.
- **Ntfy notifications** — server config has `ntfyUrl` but it's unused.
- **Operation log retention beyond daily pruning** — retention is configurable; long-term archival is not.

### TUI
- **Conflict resolution UI** — `manual` conflict strategy is accepted by the schema but the TUI does not yet pause and show per-file resolution (keep A, keep B, merge).
- **Real OpenTUI components** — the TUI uses raw `Box`/`Text` vnodes with a custom key handler. A production UI should use OpenTUI's `Select`, `Markdown`, `TabSelect`, or `Input` components for richer interaction. Currently `Select` is avoided because the vnode event model differs from what was initially assumed.
- **Dotfile diff preview** — restore does not yet show a diff against current disk files before extraction.

### Infrastructure
- **Systemd unit files** — `lamasyncd` should install as a systemd `--user` service. Provide a `lamasyncd.service` template and an install script (`curl | sh` or package).
- **CI/CD** — no GitHub Actions or build pipeline.
- **Windows/WSL support** — paths hardcoded to Unix conventions. rclone works on Windows but the daemon does not.

### Future ideas (not planned)
- Health dashboard with predictive transfer-throughput alerts.
- Preset manifest packs (`dev-node`, `dev-python`, `omp`).
- `nix` folder type that triggers `home-manager switch` after sync.
- Git-folder sync with ahead/behind and dirty-worktree reporting.

## Development instructions

### Prerequisites

- **Bun** ≥ 1.3 (required: `bun:sqlite`, `bun build --compile`)
- **rclone** (not needed in unit tests, but checked at Docker runtime)
- **TypeScript** 5.x (installed as devDependency)

### Quick start

```bash
# Install dependencies (one-time)
bun install

# Type check (always green before committing)
bun x tsc --noEmit

# Run tests
bun test

# Build all distributable binaries
bun run build
# → packages/server/dist/lamasync-server
# → packages/daemon/dist/lamasyncd
# → packages/tui/dist/lamasync-tui

# Start the server for local dev
LAMASYNC_API_KEY=dev-key \
LAMASYNC_DATA_DIR=/tmp/lamasync-test \
LAMASYNC_BACKUP_DIR=/tmp/lamasync-test-backups \
  bun run dev:server

# Run the daemon (needs a running server + ~/.config/lamasync/client.toml)
bun run dev:daemon

# Run the TUI
LAMASYNC_SERVER_URL=http://localhost:8080 LAMASYNC_API_KEY=dev-key \
  bun run dev:tui

# Run the TUI in CLI fallback mode (no OpenTUI native renderer required)
LAMASYNC_SERVER_URL=http://localhost:8080 LAMASYNC_API_KEY=dev-key \
LAMASYNC_NO_TUI=1 \
  bun run dev:tui
```

### Environment variables

| Variable | Used by | Default |
|----------|---------|---------|
| `LAMASYNC_API_KEY` | server, TUI, daemon | — (required for server) |
| `LAMASYNC_DATA_DIR` | server, daemon cache, shares.json | `/data` |
| `LAMASYNC_BACKUP_DIR` | server, config generator | `/backups` |
| `LAMASYNC_LOG_RETENTION_DAYS` | server | `90` |
| `LAMASYNC_TAILNET_IP` | server config generator | `null` |
| `LAMASYNC_SHARES` | server shares route | `null` (falls back to `shares.json`) |
| `PORT` | server | `8080` |
| `LAMASYNC_SERVER_URL` | TUI | `http://localhost:8080` (env fallback) |
| `LAMASYNC_NO_TUI` | TUI | — (set to `"1"` for CLI fallback) |
| `LAMASYNC_SOCKET_PATH` | daemon, TUI local mode | `~/lamasync.sock` |

### Code conventions

- **Imports use `.ts` extensions** — e.g., `import { foo } from "./bar.ts"`. Required because `tsconfig.json` has `allowImportingTsExtensions: true` and `moduleResolution: "bundler"`. Bun resolves these natively.
- **Shared types live in `packages/core/src/types.ts`** — this is the single source of truth for all wire/DB shapes. Server route schemas and the API client both reference these interfaces.
- **Barrel re-exports** — each package's `src/index.ts` re-exports its public surface. Internal helpers stay in their own files and are imported directly.
- **Flat route structure** — each route file in `packages/server/src/routes/` exports one Elysia plugin. Compose them in `packages/server/src/index.ts`.
- **No `console.log` in library code** — `packages/core` has no console output. The daemon and server log to stdout/stderr; the TUI uses OpenTUI rendering only (stdout is the terminal).
- **`bun build --compile`** — each package's `build` script produces a standalone binary. These embed the Bun runtime and all dependencies. Core's build is technically unnecessary (it's a library) but kept for workspace consistency.
- **Swagger details** — every route has a `detail` block with `summary`, `tags`, and `responses`. The `swagger` plugin is the first middleware (before auth) so `/swagger` and `/swagger/json` are browsable without auth for discovery.
- **No `any` or inline casts** — use `unknown` with `in`/`typeof` narrowing and real type guards.
- **DB columns go in both `SERVER_SCHEMA` and the `MIGRATIONS` array** — required for existing databases.

### Writing tests

Tests use `bun:test` (`describe`, `test`, `expect`). Place them alongside the source files as `*.test.ts`. Run with `bun test` from the repo root.

Current coverage:
- `packages/core/src/test.test.ts` — DB schema, config parsing
- `packages/server/src/routes/config.test.ts` — rclone config generation, encryption, peer detection
- `packages/server/src/routes/shares.test.ts` — shares parsing and endpoint
- `packages/daemon/src/socket.test.ts` — socket command handling

### Adding a new API endpoint

1. Add the type (if needed) to `packages/core/src/types.ts`
2. Add the client method to `packages/core/src/api-client.ts`
3. Add the endpoint to `packages/core/src/db/schema.ts` (if it needs persistence) and the migrations array
4. Create a route file in `packages/server/src/routes/` exporting an Elysia plugin with a `detail` block (Swagger tags)
5. Import and `.use()` the plugin in `packages/server/src/index.ts`
6. Add the endpoint to the `lamasync-server.md` skill table
7. Run `bun x tsc --noEmit` and `curl`-test the endpoint

### Docker

Build and run:

```bash
cp docker/.env.example docker/.env
# edit docker/.env to set LAMASYNC_API_KEY

docker compose -f docker/docker-compose.yml up -d
# Server is now at http://127.0.0.1:8080 (or your tailnet IP)
```

The image includes `rclone` and `tini`. Volumes are named (`lamasync-data`, `lamasync-backups`). The healthcheck pings `/api/v1/health` with the API key.

## Architecture decisions (for context)

- **Bun over Node** — for `bun:sqlite` (zero-dependency SQLite), `bun build --compile` (single-file binaries), and `Bun.spawn` (rclone process management).
- **Elysia over Express/Koa** — lightweight, built-in validation, Swagger plugin is a one-liner. If it doesn't work out, fallback is `hono` + `zod`.
- **rclone as the file engine** — mature, well-tested, supports every backend imaginable. LamaSync generates temp rclone configs per-operation.
- **Pre-shared API key** — no user management. Tailnet provides transport encryption; the key is a lightweight "you're allowed" check.
- **No route prefix middleware** — each route file declares its own `prefix: "/api/v1"`. This keeps each file self-contained and Swagger tags scoped.
- **OpenTUI** — the design calls for OpenTUI native rendering. If OpenTUI can't load (native binary mismatch, missing DYLD/LD path), the TUI falls back to CLI mode via `LAMASYNC_NO_TUI=1`. This is configured in `packages/tui/src/index.ts` `main()`.
