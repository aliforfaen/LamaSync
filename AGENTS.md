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
        api-client.ts         # LamaSyncApiClient (16 endpoint methods)
        db/
          schema.ts           # SERVER_SCHEMA: CREATE TABLE statements + indexes
          client.ts           # initDb(path) : opens SQLite + applies schema
        index.ts              # barrel re-exports
        test.test.ts          # 7 unit tests (DB schema, config parsing)
    server/                   # @lamasync/server — Elysia REST API + Swagger
      src/
        index.ts              # swagger → auth → routes → listen(:8080)
        auth.ts               # Bearer token middleware (fails fast on missing key)
        db.ts                 # exports `db` (SQLite handle at <dataDir>/lamasync.db)
        routes/
          health.ts           # GET /api/v1/health
          hosts.ts            # POST /register, POST /report/health
          config.ts           # GET /config/:hostId (bundled assignments + rclone)
          folders.ts          # CRUD + assign/unassign
          dotfiles.ts         # upload (multipart), list, download, delete
          operations.ts       # GET /operations (filterable, newest-first)
          report.ts           # POST /report (log + schedule_state update)
    daemon/                   # @lamasync/daemon — client heartbeat daemon
      src/
        index.ts              # 30s heartbeat loop, SIGINT/SIGTERM graceful exit
        config.ts             # reads ~/.config/lamasync/client.toml
        server.ts             # LamaSyncApiClient singleton
    tui/                      # @lamasync/tui — OpenTUI frontend
      src/
        index.ts              # menu → local / fleet views, key-driven navigation
        api.ts                # client builder (env → config file → defaults)
    agent-skill/              # @lamasync/agent-skill — OMP managed skill
      lamasync-server.md      # skill body: endpoint table, auth, example workflows
      README.md               # install instructions for OMP managed-skills dir
```

## What's implemented (v0.1.0)

| Component | Status |
|-----------|--------|
| `@lamasync/core` — shared types, DB schema, TOML config, API client | done |
| `@lamasync/server` — all 12 REST endpoints, Swagger, auth | done |
| `@lamasync/daemon` — heartbeat loop (no rclone yet) | skeleton |
| `@lamasync/tui` — OpenTUI menu + views, CLI fallback | skeleton |
| Agent skill (`lamasync-server.md`) | done (+ installed) |
| Docker: `Dockerfile.server`, `docker-compose.yml` | done |
| `bun run build` → standalone binaries (95–104 MB) | working |
| Unit tests (core) — 7 passing | done |
| End-to-end smoke verification (health, register, folders, dotfiles, daemon, TUI) | done |

## What's deferred (not yet implemented)

These are the gaps between the skeleton and the full architecture:

### Daemon (`lamasyncd`)
- **rclone execution** — the daemon only heartbeats; it does not yet spawn
  `rclone mount`, `rclone bisync`, or `rclone copy`. The skeleton has
  `packages/daemon/src/index.ts` as a heartbeat-only main. Extend it with:
  - rclone config generation from the server's `GET /config/:hostId` response
  - `Bun.spawn("rclone", [...])` for each assigned folder
  - stdout/stderr capture → status detection (exit code, conflict markers)
  - reporting results via `POST /api/v1/report`
- **Schedule engine** — parse `syncExpr` (cron expressions) from folder
  assignments and fire syncs on schedule. Use `bun:ffi` cron or a JS parser.
- **Unix socket** — the TUI in local mode should connect to a Unix socket
  (`/run/user/1000/lamasync.sock`). The daemon should expose sync status,
  operation logs, and accept manual-trigger commands.
- **`.lamasyncignore`** — per-folder glob exclude patterns (like `.gitignore`).
  The daemon should generate `--filter-from` or `--exclude` before invoking
  rclone.
- **Pre/post hooks** — shell scripts that run before/after a sync (DB dump,
  encryption, service restart, NTFY notification). Configurable per folder.
- **Retry + backoff** — the heartbeat loop catches errors but doesn't retry
  within the same cycle. Add exponential backoff on persistent failures.
- **Disk space pre-flight** — check available space before large operations.

### TUI (`lamasync-tui`)
- **Local mode over Unix socket** — currently the TUI connects directly to the
  server API for fleet view. Local mode (talking to `lamasyncd`) is a static
  placeholder. Wire the Unix socket and fetch live folder status / logs.
- **Conflict resolution** — `manual` conflict strategy should pause a folder
  and show conflicts in the TUI with per-file resolution (keep A, keep B,
  merge).
- **Dotfile restore** — the "Restore Dotfiles" flow: select app → select
  host → select version → preview file list → extract. Currently only the
  server API supports it; the TUI has no restore UI.
- **Real OpenTUI components** — the TUI uses raw `Box`/`Text` vnodes with a
  custom key handler. A production UI should use OpenTUI's `Select`,
  `Markdown`, `TabSelect`, or `Input` components for richer interaction.
  Currently `Select` is avoided because the vnode event model differs from
  what was initially assumed.

### Server
- **WebSocket event stream** — `ARCHITECTURE.md` defines `WS /api/v1/ws` for
  live operation events. Not implemented yet. Use Elysia's `@elysiajs/ws`.
- **User management / OAuth** — the API key is the only auth mechanism.
  Multi-user setups would need a `tokens` table, roles, and key rotation.
- **Operation log retention** — `operation_log` is append-only with no
  pruning. Add a configurable retention policy (e.g., trim entries older
  than 90 days).
- **Self-update** — the server binary self-update mechanism is not built.
  Docker redeployment is the current path.
- **Ntfy notifications** — server config has `ntfyUrl` but it's unused.

### Infrastructure
- **Systemd unit files** — `lamasyncd` should install as a systemd `--user`
  service. Provide a `lamasyncd.service` template and an install script
  (`curl | sh` or package).
- **CI/CD** — no GitHub Actions or build pipeline.
- **Windows/WSL support** — paths hardcoded to Unix conventions. rclone works
  on Windows but the daemon does not.

## Development instructions

### Prerequisites

- **Bun** ≥ 1.3 (required: `bun:sqlite`, `bun build --compile`)
- **rclone** (not needed in this iteration, but checked at Docker runtime)
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
| `LAMASYNC_API_KEY` | server, TUI | — (required for server) |
| `LAMASYNC_DATA_DIR` | server | `/data` |
| `LAMASYNC_BACKUP_DIR` | server | `/backups` |
| `PORT` | server | `8080` |
| `LAMASYNC_SERVER_URL` | TUI | `http://localhost:8080` (env fallback) |
| `LAMASYNC_NO_TUI` | TUI | — (set to `"1"` for CLI fallback) |

### Code conventions

- **Imports use `.ts` extensions** — e.g., `import { foo } from "./bar.ts"`.
  Required because `tsconfig.json` has `allowImportingTsExtensions: true`
  and `moduleResolution: "bundler"`. Bun resolves these natively.
- **Shared types live in `packages/core/src/types.ts`** — this is the single
  source of truth for all wire/DB shapes. Server route schemas and the
  API client both reference these interfaces.
- **Barrel re-exports** — each package's `src/index.ts` re-exports its public
  surface. Internal helpers stay in their own files and are imported directly.
- **Flat route structure** — each route file in `packages/server/src/routes/`
  exports one Elysia plugin. Compose them in `packages/server/src/index.ts`.
- **No `console.log` in library code** — `packages/core` has no console
  output. The daemon and server log to stdout/stderr; the TUI uses OpenTUI
  rendering only (stdout is the terminal).
- **`bun build --compile`** — each package's `build` script produces a
  standalone binary. These embed the Bun runtime and all dependencies.
  Core's build is technically unnecessary (it's a library) but kept for
  workspace consistency.
- **Swagger details** — every route has a `detail` block with `summary`,
  `tags`, and `responses`. The `swagger` plugin is the first middleware
  (before auth) so `/swagger` and `/swagger/json` are browsable without
  auth for discovery.

### Writing tests

Tests use `bun:test` (`describe`, `test`, `expect`). Place them alongside the
source files as `*.test.ts`. Run with `bun test` from the repo root.

Current coverage: `packages/core/src/test.test.ts` — 7 tests covering:
- `initDb` creates expected tables
- `parseServerConfig` applies defaults, rejects missing `apiKey`
- `parseClientConfig` applies defaults, rejects missing fields

### Adding a new API endpoint

1. Add the type (if needed) to `packages/core/src/types.ts`
2. Add the client method to `packages/core/src/api-client.ts`
3. Create a route file in `packages/server/src/routes/` exporting an Elysia
   plugin with a `detail` block (Swagger tags)
4. Import and `.use()` the plugin in `packages/server/src/index.ts`
5. Add the endpoint to the `lamasync-server.md` skill table
6. Run `bun x tsc --noEmit` and `curl`-test the endpoint

### Docker

Build and run:

```bash
cp docker/.env.example docker/.env
# edit docker/.env to set LAMASYNC_API_KEY

docker compose -f docker/docker-compose.yml up -d
# Server is now at http://127.0.0.1:8080 (or your tailnet IP)
```

The image includes `rclone` and `tini`. Volumes are named (`lamasync-data`,
`lamasync-backups`). The healthcheck pings `/api/v1/health` with the API key.

## Architecture decisions (for context)

- **Bun over Node** — for `bun:sqlite` (zero-dependency SQLite), `bun build --compile`
  (single-file binaries), and `Bun.spawn` (rclone process management).
- **Elysia over Express/Koa** — lightweight, built-in validation, Swagger
  plugin is a one-liner. If it doesn't work out, fallback is `hono` + `zod`.
- **rclone as the file engine** — mature, well-tested, supports every
  backend imaginable. LamaSync generates temp rclone configs per-operation.
- **Pre-shared API key** — no user management. Tailnet provides transport
  encryption; the key is a lightweight "you're allowed" check.
- **No route prefix middleware** — each route file declares its own
  `prefix: "/api/v1"`. This keeps each file self-contained and Swagger tags
  scoped.
- **OpenTUI** — the design calls for OpenTUI native rendering. If OpenTUI
  can't load (native binary mismatch, missing DYLD/LD path), the TUI falls
  back to CLI mode via `LAMASYNC_NO_TUI=1`. This is configured in
  `packages/tui/src/index.ts` `main()`.
