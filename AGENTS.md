# AGENTS.md — LamaSync

## Overview

LamaSync is a personal sync-fleet system: one server (on TrueNAS/Docker), a
lightweight daemon on each client, and a terminal UI for local & fleet views.
It wraps **rclone** for file transfers and uses a **pre-shared API key** for auth.
Everything is written in **TypeScript** running on **Bun**.

## What's implemented (v0.2.0)

|Component|Status|
|---|---|
|`@lamasync/core` — shared types, DB schema, TOML config, API client|done|
|`@lamasync/server` — REST + WebSocket + Swagger + auth|done|
|`@lamasync/daemon` — heartbeat, rclone execution, mounts, scheduler, socket server|done|
|`@lamasync/tui` — Single tabbed shell with 6 views + guided wizards + CLI fallback (LAMA-173)|done|
|`@lamasync/web-ui` — React SPA embedded in the server binary (Dashboard, Folders, Dotfiles, Conflicts, Admin)|done|
|Agent skill (`lamasync-server.md`)|done (+ installed)|
|Docker: `Dockerfile.server`, `docker-compose.yml`|done|
|`bun run build` → standalone binaries|working|
|Unit tests (core + server + daemon + self-update + TUI + executor + offset + web-ui + wizard)|**179 passing** (23 files)|
|End-to-end smoke verification (health, register, folders, dotfiles, daemon, TUI, web UI)|done|

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
    docker-compose.yml        # volumes for /data, /backups; tailnet-bound port (override IP for local test)
    .env.example
  config-examples/            # reference TOML configs (server.toml, client.toml)
  packages/
    core/                     # @lamasync/core — shared types, DB, config, API client
      src/
        types.ts              # Host, Folder, FolderAssignment, DotfileVersion, …
        config.ts             # TOML parsers for server & client config
        api-client.ts         # LamaSyncApiClient (all endpoint methods)
        version.ts            # generated version constant (from root package.json)
        db/
          schema.ts           # SERVER_SCHEMA + MIGRATIONS
          client.ts           # initDb(path) : opens SQLite + applies schema
        index.ts              # barrel re-exports
        test.test.ts          # core unit tests
    server/                   # @lamasync/server — Elysia REST API + Swagger + WS
      src/
        index.ts              # swagger → routes → listen(:8080); --version flag
        auth.ts               # lazy Bearer token middleware (skips Upgrade: websocket)
        db.ts                 # singleton SQLite handle (lazy + test-safe)
        ws.ts                 # WebSocket event stream (subprotocol auth)
        routes/
          health.ts           # GET /api/v1/health
          hosts.ts            # POST /register, POST /report/health
          config.ts           # GET /config/:hostId (assignments + rclone + peers)
          folders.ts          # CRUD + assign/unassign + templates
          dotfiles.ts         # manifest CRUD, upload (multipart), list, download, delete
          operations.ts       # GET /operations (filterable, newest-first)
          report.ts           # POST /report (log + schedule_state update)
          shares.ts           # GET /api/v1/shares (NFS shares)
          admin.ts            # operation-log pruning, retention helpers
          restic.ts           # restic config for backup/dotfile types
          conflicts.ts        # conflict resolution API
          release.ts          # GET /api/v1/release/latest
    daemon/                   # @lamasync/daemon — client sync daemon
      src/
        index.ts              # heartbeat + Unix socket server + --version/--check-update/--update
        config.ts             # reads ~/.config/lamasync/client.toml
        server.ts             # LamaSyncApiClient singleton
        socket.ts             # Unix socket server (commands + status)
        socket.test.ts        # socket command tests
        executor.ts           # rclone spawn, dry-run, bandwidth, disk-space pre-flight
        scheduler.ts          # cron expression sync engine
        mounts.ts             # mount lifecycle: start/stop/health/backoff
        rclone.ts             # rclone config generation helpers
        ignore.ts             # .lamasyncignore / .lamasyncmountignore parsing
        hooks.ts              # pre/post sync shell hooks (with timeout)
        lan-peer.ts           # LAN IP detection + peer SFTP discovery
        lock.ts               # server-side lock coordination (contention vs unreachable, same-host overlap guard, abort on lock loss)
        config-cache.ts       # cached server config for offline operation
        report-queue.ts       # disk-backed queue for failed operation reports
        self-update.ts        # GitHub release check + binary replacement
        self-update.test.ts   # self-update unit tests
        systemd.ts            # systemd unit generation helpers
        systemd.test.ts       # systemd unit template tests
    tui/                      # @lamasync/tui — OpenTUI frontend, tabbed shell (LAMA-173)
      src/
        index.ts              # slim entry: flags, CLI fallback, bootShell()
        boot.ts               # wires Shell with Local/Fleet/Dotfiles/Conflicts/Logs/Gh views
        api.ts                # client builder (env → config file → defaults)
        socket-client.ts      # Unix socket client for local mode
        cli-fallback.ts       # LAMASYNC_NO_TUI=1 CLI mode
        app/
          theme.ts            # status prefixes + title strings
          widgets.ts          # pageShell, hotkeyFooter, statusBox, loading/error/emptyBox
          keymap.ts           # Hotkey type + matchHotkey() (char / name dispatch)
          keymap.test.ts      # keymap dispatch unit tests
          view-manager.ts     # View interface, ViewSpec, ViewManager (visible-toggle)
          view-manager.test.ts # view-manager unit tests (fake + gated real renderer)
          shell.ts            # Shell class — TabSelect bar + global dispatch + status
          wizard.ts           # WizardRunner + Wizard/WizardStep + registry
          wizard.test.ts      # wizard state-machine tests (pure)
          fleet-service.ts    # createFleetService() — WS subscription lifted out
          schedule-presets.ts # preset table (mirror web-ui/Dotfiles.tsx:27-36)
        views/
          local.ts            # LocalView (folder list + sync/cache/wizard hotkeys)
          fleet.ts            # FleetView (uses FleetService for live WS hosts)
          dotfiles.ts         # DotfilesView (manifest browser + restore state machine)
          conflicts.ts        # ConflictsView (highlighted-row resolution + confirm)
          logs.ts             # LogsView (ScrollBox + paginated operations)
          gh-selector.ts      # GhView (GitHub repo adoption via `gh` CLI)
        flows/
          backup-setup.ts     # Wizard factory: create folder + assign host
          dotfile-manifest.ts # Wizard factory: create dotfile manifest
    agent-skill/              # @lamasync/agent-skill — OMP managed skill
      lamasync-server.md      # skill body: endpoint table, auth, example workflows
      README.md               # install instructions for OMP managed-skills dir
    web-ui/                   # @lamasync/web-ui — embedded React SPA (Vite build)
      index.html              # Vite entry HTML
      vite.config.ts          # single-file inlined build (see scripts/inline-web-ui.ts)
      tsconfig.json           # extends root, adds jsx support
      src/
        main.tsx              # React 18 root + StrictMode
        App.tsx               # HashRouter + auth gate
        api.ts                # browser fetch client (sessionStorage bearer)
        index.css             # hand-rolled dashboard styles
        components/
          Login.tsx           # API-key sign-in form
          Nav.tsx             # top navigation bar (Dashboard, Folders, Dotfiles, Conflicts, Admin)
        hooks/
          useWebSocket.ts     # /api/v1/ws client with exponential-backoff reconnect
        pages/
          Dashboard.tsx       # summary cards, hosts table, recent operations
          Folders.tsx         # list + create + delete (admin)
          Dotfiles.tsx        # manifest list + create + delete (admin)
          Conflicts.tsx       # pending conflicts + resolve (local/remote/both)
          Admin.tsx           # operation-log prune (days)
  docker/
    Dockerfile.server         # multi-stage: bun compile → debian-slim + rclone
    docker-compose.yml        # volumes for /data, /backups; tailnet-bound port
  scripts/
    gen-version.ts            # writes packages/core/src/version.ts from root package.json
    inline-web-ui.ts          # post-vite inliner: embeds JS/CSS into dist/index.html (single-file SPA)
    e2e-harness.sh            # isolated server + daemon end-to-end test harness
    test-install.sh           # Docker smoke test for curl | bash install path
    test-update.sh            # Docker smoke test for curl | bash update path
    e2e-sandbox/              # full client end-to-end sandbox (Docker Compose: server + client)
      docker-compose.yml      # server (ghcr image) + client (Ubuntu, runs install.sh)
      client.Dockerfile       # client test image
      client-test.sh          # install → register → backup → dotfile → log verification
      socket-send.py          # sends JSON commands to the lamasyncd Unix socket
  packaging/                  # curl | bash installer + systemd template
    install/
      install.sh              # install lamasyncd (+ optional TUI) and systemd unit
      update.sh               # standalone self-update script
    systemd/
      lamasyncd.service       # systemd user-unit template
  .github/
    workflows/
      ci.yml                  # type-check, test, build, release, docker push
  docs/
    plans/                    # execution plans (LAMA-XXX-tui-unification.md, etc.)
```

### Implemented features (LAMA-104..173)

| Issue | Feature | Location |
|-------|---------|----------|
| LAMA-114 | Bandwidth scheduling (`--bwlimit`) | `daemon/src/executor.ts`, `folders.ts` |
| LAMA-115 | (was not in this batch) | — |
| LAMA-116 | Disk-space pre-flight | `daemon/src/executor.ts` |
| LAMA-117 | Operation-log retention | `server/src/routes/admin.ts`, `server/src/index.ts` |
| LAMA-118 | WebSocket auth via subprotocol | `server/src/ws.ts`, `server/src/auth.ts`, `tui/src/views/fleet.ts` |
| LAMA-119 | Dry-run mode | `daemon/src/executor.ts` |
| LAMA-120 | `"git"` folder type | `daemon/src/executor.ts` |
| LAMA-104 | Error handling (core hardening) | `server/src/routes/report.ts`, `core/src/api-client.ts`, `server/src/index.ts`, `daemon/src/lock.ts`, `daemon/src/report-queue.ts`, `daemon/src/hooks.ts` |
| LAMA-162 | Automatic conflict strategies (`newer_wins`, `source_wins`, `keep_both`) | `core/src/types.ts`, `daemon/src/executor.ts` |
| LAMA-109 | App-specific "backup" dotfile system | `core/src/types.ts`, `core/src/db/schema.ts`, `server/src/routes/dotfiles.ts`, `server/src/routes/config.ts`, `daemon/src/executor.ts`, `tui/src/views/dotfiles.ts` |
| LAMA-123 | LAN peer sync | `daemon/src/lan-peer.ts`, `server/src/routes/config.ts` |
| LAMA-124 | Encryption-at-rest | `server/src/routes/folders.ts`, `server/src/routes/config.ts` |
| LAMA-125 | `ARCHITECTURE.md` rewrite | `ARCHITECTURE.md` |
| LAMA-151 | Self-update (daemon + server release proxy) | `daemon/src/self-update.ts`, `server/src/routes/release.ts`, `packaging/install/update.sh` |
| LAMA-147 | Management Web UI (dashboard + admin CRUD) | `packages/web-ui/`, `packages/server/src/routes/web-ui.ts`, `scripts/inline-web-ui.ts` |
| LAMA-173 | TUI unification: tabbed shell, 6 views, guided wizards | `packages/tui/src/{boot.ts,index.ts,app/*,views/*,flows/*}` |

### Server
- **User management / OAuth** — the API key is the only auth mechanism. Multi-user setups would need a `tokens` table, roles, and key rotation.
- **Ntfy notifications** — server config has `ntfyUrl` but it's unused.
- **Operation log retention beyond daily pruning** — retention is configurable; long-term archival is not.

### TUI
LAMA-173 unified the TUI into a single persistent `Shell` with a `TabSelect` bar, six views (Local, Fleet, Dotfiles, Conflicts, Logs, Gh), and two guided wizard flows (backup-setup, dotfile-manifest). Views build their container once; `ViewManager.show()` only toggles `container.visible` — no destroy/rebuild, no `process.nextTick` focus hack. The LAMA-167 Enter-crash fix invariants are codified in `app/shell.ts` and `app/view-manager.ts`. Hotkey tables are declared once per view; the same array drives both the footer and the global dispatcher.
- **Dotfile diff preview** — restore does not yet show a diff against current disk files before extraction.

### Infrastructure
- **Windows/WSL support** — paths hardcoded to Unix conventions. rclone works on Windows but the daemon does not.
- **Server-side in-place self-update** — Docker/CI/CD is the path for the server; a live binary replacement path for the server is not built (the daemon/TUI self-update exists, LAMA-151).

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

# Run tests (web UI dist must exist first; see build:web-ui below)
bun test

# Build all distributable binaries
bun run build
# → packages/server/dist/lamasync-server
# → packages/daemon/dist/lamasyncd
# → packages/tui/dist/lamasync-tui

# Or, just build the web UI so server tests pass:
# bun run build:web-ui

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
- **TUI state-machine semantics** (LAMA-173): wizard state lives in `WizardRunner`; views mount once and `ViewManager.show()` only flips `container.visible`. Enter is NEVER handled globally in `app/shell.ts` — focused widgets own it.

### Writing tests

Tests use `bun:test` (`describe`, `test`, `expect`). Place them alongside the source files as `*.test.ts`. Run with `bun test` from the repo root.

For a quick end-to-end smoke that starts a real server + daemon and exercises the TUI and web UI routes, run:

```bash
./scripts/e2e-harness.sh
```

For isolated Docker tests of the `curl | bash` install and update paths:

```bash
./scripts/test-install.sh
./scripts/test-update.sh
```

For a full client end-to-end sandbox (install, registration, normal backup,
dotfile backup, operation-log verification) in Docker Compose:

```bash
cd scripts/e2e-sandbox && docker compose up --build --abort-on-container-exit
```

The complete testing handoff (including the realistic Proxmox-over-tailnet
path and the production-smoke checklist) is in `docs/handoff/client-testing.md`.

Current coverage:
- `packages/core/src/test.test.ts` — DB schema, config parsing, version constant
- `packages/server/src/routes/config.test.ts` — rclone config generation, encryption, peer detection
- `packages/server/src/routes/shares.test.ts` — shares parsing and endpoint
- `packages/server/src/routes/operations.test.ts` — operation locks and API
- `packages/server/src/routes/restic.test.ts` — restic config generation
- `packages/server/src/routes/conflicts.test.ts` — conflict resolution API
- `packages/daemon/src/socket.test.ts` — socket command handling
- `packages/daemon/src/systemd.test.ts` — systemd unit template generation
- `packages/daemon/src/self-update.test.ts` — release parsing and version comparison
- `packages/tui/src/index.test.ts` — `describeFolder` cases (legacy view helpers)
- `packages/tui/src/app/keymap.test.ts` — hotkey dispatch (`matchHotkey`)
- `packages/tui/src/app/view-manager.test.ts` — visibility toggling + lifecycle hooks
- `packages/tui/src/app/wizard.test.ts` — wizard state-machine (next/back/validate/finish/cancel/onKey)

### Adding a new API endpoint

1. Add the type (if needed) to `packages/core/src/types.ts`
2. Add the client method to `packages/core/src/api-client.ts`
3. Add the endpoint to `packages/core/src/db/schema.ts` (if it needs persistence) and the migrations array
4. Create a route file in `packages/server/src/routes/` exporting an Elysia plugin with a `detail` block (Swagger tags)
5. Import and `.use()` the plugin in `packages/server/src/index.ts`
6. Add the endpoint to the `lamasync-server.md` skill table
7. Run `bun x tsc --noEmit` and `curl`-test the endpoint

### Adding a new TUI view (LAMA-173 contract)

1. Add the id to `ViewId` in `packages/tui/src/app/view-manager.ts` if it's new.
2. Create a class `XView implements View` in `packages/tui/src/views/x.ts` with `id`, `title`, `container: Renderable` (built once in the constructor), `hotkeys()`, `onShow(ctx)`, optional `onHide()`, `handleKey(e)`, `destroy()`. Use a single `as unknown as Renderable` cast at the container field boundary; live body mutations go through a captured `ProxiedVNode<typeof BoxRenderable>` ref.
3. Register the view in `packages/tui/src/boot.ts` inside the `views` array. The `Shell` builds `ViewSpec`s automatically.
4. Add a hotkey dispatch path: only if your view owns internal keys, set `ViewSpec.handleKey = view.handleKey.bind(view)`; otherwise global hotkeys via `view.hotkeys()`.
5. Add a unit test in `packages/tui/src/views/x.test.ts` if the view has pure logic; gate any renderer-bound test behind `process.env.LAMASYNC_TUI_TEST_VIEWS === "1"`.

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
- **TUI unification (LAMA-173)** — single `Shell` owns the global keypress handler and dispatches in this order: active wizard → active view's `handleKey` → active view's `hotkeys()` → global tab/quit/cycle shortcuts. Views build their container once and only mutate a captured body `BoxRenderable`; the TabSelect bar replaces the old menu screen.

## Version and release

- **Version source of truth**: root `package.json` `version` field (currently `0.2.1`).
- **Generated constant**: `scripts/gen-version.ts` writes `packages/core/src/version.ts`, which is re-exported from `@lamasync/core`.
- **All four binaries** support `--version` and `-V`.
  (`lamasync-server`, `lamasyncd`, `lamasync-tui`, plus the bundled web UI at `GET /`)
- **GitHub Actions**: `.github/workflows/ci.yml` runs type-checks, tests, builds the three binaries, publishes them to a GitHub Release on `v*` tags, and pushes a Docker image to GHCR.
- **Self-update**: daemon checks GitHub Releases on startup and supports `lamasyncd --check-update` / `lamasyncd --update`. The server proxies release info at `GET /api/v1/release/latest`. A standalone `curl | bash` updater lives in `packaging/install/update.sh`.

## Current status (as of 2026-07-21)

- Project version: **0.2.1**
- Tests: **187 passing** across 26 files, 1 skip, 0 failures.
- **Install scripts**: `packaging/install/install.sh` and `packaging/install/update.sh` patched to be self-contained and aligned with the CI-published binary names (`lamasyncd`, `lamasync-tui`). Docker smoke tests (`scripts/test-install.sh`, `scripts/test-update.sh`) both pass.
- **Release**: v0.2.1 tag pushed; GitHub Actions will publish the matching release assets (`lamasyncd`, `lamasync-tui`, `lamasync-server`) and the GHCR Docker image.
- **LAMA-173 done**: TUI unified into a tabbed shell with 6 persistent views and 2 guided wizards; LAMA-167 Enter-crash invariants preserved.
- Open Multica issues: LAMA-105 (Exoscale S3), LAMA-110 (OMP inspiration), LAMA-104 (error handling backlog), LAMA-157 (installation documentation), LAMA-165 (CI/CD binary release), LAMA-168 (dotfile manifest improvements), LAMA-171 (`@reboot` / `@login` dotfile schedule triggers).
- **Production server**: running on LXC container `lamasync` at `100.113.52.108` via Docker image `ghcr.io/aliforfaen/lamasync-server:latest`, with daily cron auto-update at 04:00.

## Next session options

Ready-to-pick work, ordered by likely value/urgency:

1. **LAMA-105 — Backend storage: Exoscale S3 backend + basic tests** (in_progress, urgent)
   - Wire up the Exoscale S3-compatible backend as a folder target.
   - Add validation for `s3Endpoint`, `s3Bucket`, `s3AccessKeyId`, `s3SecretAccessKey`.
   - Run basic end-to-end tests: create folder, assign, daemon sync, verify object listing in bucket.
   - Revisit rclone config generation for S3 in `server/src/routes/config.ts` and folder validation in `server/src/routes/folders.ts`.

2. **LAMA-168 / LAMA-171 — Dotfile manifest improvements + `@reboot`/`@login` triggers** (in_progress, urgent)
   - Host selector, excludes, cron presets, deployment tracking; scheduler special-token tests already added.

3. **LAMA-104 — Error handling** (backlog, high)
   - Harden error propagation, structured error responses, and retry/circuit-breaker behavior across the daemon and server.

4. **LAMA-110 — Oh-My-Pi inspiration** (todo, urgent)
   - Pull OMP-specific features/conventions into a lighter Pi runtime. Likely overlaps with management UI and runtime simplification.

5. **Polish / tech debt**
   - Dotfile diff preview against current disk files before extraction.
   - `nts` / tabbed-cycle keyboard interactions in OpenTUI native mode.
   - ntfy notifications, multi-user auth scoping, operation-log archival.
   - Renderer smoke tests behind `LAMASYNC_TUI_TEST_VIEWS` (foundation already wired the gating).

