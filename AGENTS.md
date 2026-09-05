# LamaSync agent guide

LamaSync is a personal, tailnet-only sync fleet: one Docker/LXC server, a
lightweight daemon on each device, and web and terminal management surfaces.
It is a TypeScript/Bun workspace; rclone performs transfers and managed bearer
keys are the trust boundary.

## Workspace

- `core` — shared types, SQLite schema/migrations, TOML, API client
- `server` — Elysia REST, WebSocket, Swagger, auth
- `daemon` — heartbeat, scheduler, rclone, mounts, local socket
- `tui` — OpenTUI shell and `lamasync` non-interactive CLI
- `web-ui` — embedded React SPA
- `agent-skill` — installed CLI-first operator guidance
- `deploy-agent` — fixed-script LXC production deploy runner

## Read first

1. `docs/agent-start.md` — current work and handoff baseline.
2. `docs/status.md` — active follow-ups and limitations.
3. The assigned Multica issue.
4. `ARCHITECTURE.md` for contracts, `docs/development.md` for recipes, or
   `docs/prod-deploy.md` for production work.

For client installation rather than repository work, start with
`packages/agent-skill/lamasync-client.md`.

## Normal validation

```bash
bun install
bun x tsc --noEmit
bun run build:web-ui
bun test
bun run scripts/check-skill-drift.ts --strict
```

Use `bun run build` for packaging or release changes. The E2E sandbox needs
Docker and a system-installed rclone; never install rclone in a worktree.

## Non-negotiable conventions

- Imports use `.ts` extensions.
- Shared wire/DB types live in `packages/core/src/types.ts`; package public
  surfaces use their `src/index.ts` barrel.
- Each server route is an Elysia plugin under `packages/server/src/routes/`,
  with `/api/v1` prefix and Swagger detail; compose it in `server/src/index.ts`.
- DB changes go in both `SERVER_SCHEMA` and `MIGRATIONS`.
- No `any` or inline casts: narrow `unknown` with type guards.
- No `console.log` in library code; daemon/server may log operationally, while
  the TUI renders through OpenTUI.
- Any route, CLI command, or flag change must update
  `packages/agent-skill/reference/`; CI enforces strict drift checking.
- TUI wizards use `WizardRunner`; `ViewManager.show()` only changes visibility;
  never add a global Enter handler in `app/shell.ts`.

## Safety and release

Preserve unrelated dirty-worktree changes. Do not hand-edit fleet state, rclone
configuration, or production databases. The version source of truth is root
`package.json`; `scripts/gen-version.ts` generates the core version file.
`v*` tags publish binaries and the Docker image. See `docs/README.md` for the
living documentation map and archive policy.
