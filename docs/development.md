# Development guide — LamaSync

Detailed development instructions. The lean essentials live in `AGENTS.md`;
this file is the full reference.

## Prerequisites

- **Bun** ≥ 1.3 (required: `bun:sqlite`, `bun build --compile`)
- **rclone** (not needed in unit tests, but checked at Docker runtime)
- **TypeScript** 5.x (installed as devDependency)

## Quick start

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

## Environment variables

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
| `LAMASYNC_SOCKET_PATH` | daemon, TUI local mode | `$XDG_RUNTIME_DIR/lamasync.sock` (falls back to `~/.lamasync/lamasync.sock` when XDG is unset) |

## Writing tests

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
The Command Center v1 (LAMA-183 batches 1–2) browser dogfood brief lives in
`docs/handoff/command-center-testing.md` (test matrix + known limitations).

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

## Adding a new API endpoint

1. Add the type (if needed) to `packages/core/src/types.ts`
2. Add the client method to `packages/core/src/api-client.ts`
3. Add the endpoint to `packages/core/src/db/schema.ts` (if it needs persistence) and the migrations array
4. Create a route file in `packages/server/src/routes/` exporting an Elysia plugin with a `detail` block (Swagger tags)
5. Import and `.use()` the plugin in `packages/server/src/index.ts`
6. Add the endpoint to the `lamasync-server.md` skill table
7. Run `bun x tsc --noEmit` and `curl`-test the endpoint

## Adding a new TUI view (LAMA-173 contract)

1. Add the id to `ViewId` in `packages/tui/src/app/view-manager.ts` if it's new.
2. Create a class `XView implements View` in `packages/tui/src/views/x.ts` with `id`, `title`, `container: Renderable` (built once in the constructor), `hotkeys()`, `onShow(ctx)`, optional `onHide()`, `handleKey(e)`, `destroy()`. Every OpenTUI node the view mutates after mount — the container, body boxes, selects — MUST be a real renderable: take the renderer via the constructor (or `ctx.renderer`) and wrap each `Box()`/`Select()`/`Text()` VNode in `realize(renderer, vnode)` from `app/widgets.ts` (LAMA-181; VNode proxies silently drop post-mount mutations). Swap body content with `swapChildren(box, next)`. Renderer-less tests pass `renderer: null` and get the old proxy behavior.
3. Register the view in `packages/tui/src/boot.ts` inside the `views` array. The `Shell` builds `ViewSpec`s automatically.
4. Add a hotkey dispatch path: only if your view owns internal keys, set `ViewSpec.handleKey = view.handleKey.bind(view)`; otherwise global hotkeys via `view.hotkeys()`.
5. Add a unit test in `packages/tui/src/views/x.test.ts` if the view has pure logic; gate any renderer-bound test behind `process.env.LAMASYNC_TUI_TEST_VIEWS === "1"`.

## Docker

Build and run:

```bash
cp docker/.env.example docker/.env
# edit docker/.env to set LAMASYNC_API_KEY

docker compose -f docker/docker-compose.yml up -d
# Server is now at http://127.0.0.1:8080 (or your tailnet IP)
```

The image includes `rclone` and `tini`. Volumes are named (`lamasync-data`, `lamasync-backups`). The healthcheck pings `/api/v1/health` with the API key.

## Version and release

- **Version source of truth**: root `package.json` `version` field (currently `0.3.2`).
- **Generated constant**: `scripts/gen-version.ts` writes `packages/core/src/version.ts`, which is re-exported from `@lamasync/core`.
- **All three standalone binaries** support `--version` and `-V`:
  `lamasync-server`, `lamasyncd`, `lamasync-tui`. The web UI is bundled
  inside `lamasync-server` (built with `--loader .html:text`) and served
  from `GET /`; it has no separate version flag.
- **GitHub Actions**: `.github/workflows/ci.yml` runs type-checks, tests, builds the three binaries, publishes them to a GitHub Release on `v*` tags, and pushes a Docker image to GHCR.
- **Self-update**: daemon checks GitHub Releases on startup and supports `lamasyncd --check-update` / `lamasyncd --update`. The server proxies release info at `GET /api/v1/release/latest`. A standalone `curl | bash` updater lives in `packaging/install/update.sh`.
