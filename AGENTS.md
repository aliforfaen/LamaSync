# AGENTS.md — LamaSync

## Overview

LamaSync is a personal sync-fleet system: one server (Docker on an LXC
container, tailnet-only), a lightweight daemon on each client, and a terminal
UI for local & fleet views.
It wraps **rclone** for file transfers and uses a **pre-shared API key** for auth.
Everything is written in **TypeScript** running on **Bun**.

Bun workspace with five packages under `packages/`:
- `core` — shared types, DB schema, TOML config, API client
- `server` — Elysia REST + WebSocket + Swagger + auth
- `daemon` — client sync daemon (heartbeat, rclone, mounts, scheduler, Unix socket, `--update skill`)
- `tui` — OpenTUI tabbed shell (6 views, guided wizards) AND the LAMA-229 CLI (`packages/tui/src/cli/`)
- `web-ui` — React SPA embedded in the server binary
- `agent-skill` — globally-installed two-tier agent-skill bundle (SKILL.md + reference/)

**Onboarding as a user, not a developer?** If your task is to install and
run LamaSync as a client on your host (rather than hack on this repo), read
`packages/agent-skill/lamasync-client.md` first — it has the production
server URL, prereqs, install steps, and verification. Server API operations:
`packages/agent-skill/SKILL.md` (the CLI-first two-tier bundle — start with
`SKILL.md`, then `reference/cli.md` for the full `lamasync` subcommand
reference; `reference/api.md` is the REST/WS escape hatch). The legacy
`lamasync-server.md` content has been folded into `reference/api.md`.

Full annotated tree: `docs/repository-layout.md`. System design & DB schema:
`ARCHITECTURE.md`. Feature history by LAMA issue: `docs/features.md`.
Status log & work queue: `docs/status.md`.

## Quick start

```bash
bun install
bun x tsc --noEmit        # type check — always green before committing
bun test                  # needs web UI dist first: bun run build:web-ui
bun run build             # → standalone binaries in packages/*/dist/

# Local dev server
LAMASYNC_API_KEY=dev-key \
LAMASYNC_DATA_DIR=/tmp/lamasync-test \
LAMASYNC_BACKUP_DIR=/tmp/lamasync-test-backups \
  bun run dev:server
```

Full dev guide (daemon/TUI dev commands, env vars, Docker, recipes for adding
API endpoints and TUI views, release process): `docs/development.md`.

## Testing

- `bun test` — always works, no external deps needed
- Tests use `bun:test`, placed alongside source as `*.test.ts`
- E2E sandbox requires Docker + rclone installed on host
- Never install rclone inside a worktree — it's a system-level tool

## Code conventions

- **Imports use `.ts` extensions** — e.g., `import { foo } from "./bar.ts"`. Required because `tsconfig.json` has `allowImportingTsExtensions: true` and `moduleResolution: "bundler"`. Bun resolves these natively.
- **Shared types live in `packages/core/src/types.ts`** — the single source of truth for all wire/DB shapes.
- **Barrel re-exports** — each package's `src/index.ts` re-exports its public surface. Internal helpers stay in their own files.
- **Flat route structure** — each route file in `packages/server/src/routes/` exports one Elysia plugin with its own `prefix: "/api/v1"` and a Swagger `detail` block. Compose in `packages/server/src/index.ts`; the `swagger` plugin is the first middleware (before auth).
- **No `console.log` in library code** — daemon/server log to stdout/stderr; the TUI renders via OpenTUI only.
- **`bun build --compile`** — each package's `build` script produces a standalone binary.
- **No `any` or inline casts** — use `unknown` with `in`/`typeof` narrowing and real type guards.
- **DB columns go in both `SERVER_SCHEMA` and the `MIGRATIONS` array** — required for existing databases.
- **TUI state-machine semantics** (LAMA-173): wizard state lives in `WizardRunner`; views mount once and `ViewManager.show()` only flips `container.visible`. Enter is NEVER handled globally in `app/shell.ts` — focused widgets own it. Post-mount-mutated OpenTUI nodes must be real renderables via `realize()` (LAMA-181).

## Architecture decisions (for context)

- **Bun over Node** — `bun:sqlite`, `bun build --compile`, `Bun.spawn`.
- **Elysia over Express/Koa** — lightweight, built-in validation, one-liner Swagger. Fallback: `hono` + `zod`.
- **rclone as the file engine** — mature, supports every backend; LamaSync generates temp rclone configs per-operation.
- **Pre-shared API key** — no user management; tailnet provides transport encryption.
- **OpenTUI** — native rendering with CLI fallback via `LAMASYNC_NO_TUI=1` (`packages/tui/src/index.ts`).
- **TUI unification (LAMA-173)** — single `Shell` dispatches keys in this order: active wizard → view `handleKey` → view `hotkeys()` → global tab/quit/cycle.
- **Agent surface (LAMA-227)** — the `lamasync` binary is BOTH the TUI shell AND a non-interactive subcommand CLI (LAMA-229). Any positional argv routes to CLI dispatch (`packages/tui/src/cli/dispatch.ts`); bare invocation + TTY still boots the TUI; bare invocation + `LAMASYNC_NO_TUI=1` keeps the legacy CLI fallback. The REST/WS API is the documented escape hatch when the CLI can't express the operation (LAMA-230 + LAMA-231 fill the full CRUD surface here). The install pipeline persists a skill-install preference in `~/.lamasync/install-state.json`; `lamasyncd --update skill` refreshes the skill bundle in lockstep with the binary version.

## Version and release

- Version source of truth: root `package.json`; `scripts/gen-version.ts` generates `packages/core/src/version.ts`.
- All binaries support `--version` / `-V`. CI (`.github/workflows/ci.yml`) builds and publishes binaries + GHCR Docker image on `v*` tags.
- Daemon self-update via GitHub Releases; server proxies at `GET /api/v1/release/latest`.

## Current status

Project version **0.2.3**, tests green. See `docs/status.md` for the rolling
status log and the next-session work queue.
