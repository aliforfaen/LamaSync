# Contributing to LamaSync

Thanks for helping! This guide is the dev-facing onboarding — the user-facing
README and the operational docs (`docs/`) cover the rest.

## What this project is

A personal sync-fleet controller: one server (Docker/LXC, tailnet-only), a
daemon per device, and a terminal UI + web UI over a small REST/WS API.
Everything is TypeScript on [Bun](https://bun.sh). The full picture lives in
`ARCHITECTURE.md` and `docs/repository-layout.md`.

## Setting up

```bash
bun install
bun x tsc --noEmit        # type check — green before you commit
bun run build:web-ui      # one-time per session; bun test needs the dist
bun test
```

Run a local dev server:

```bash
LAMASYNC_API_KEY=dev-key \
LAMASYNC_DATA_DIR=/tmp/lamasync-test \
LAMASYNC_BACKUP_DIR=/tmp/lamasync-test-backups \
  bun run dev:server
```

`bun run dev:daemon`, `bun run dev:tui`, and `bun run dev:web-ui` start the
other pieces (see `docs/development.md` for the full dev guide and recipes).

## Validation gates (CI runs these too)

1. `bun x tsc --noEmit` — must be clean.
2. `bun run build:web-ui` — needed before tests.
3. `bun test` — the whole suite must pass (expect the TUI suite to be fast
   and hermetic; e2e rclone/Docker tests skip cleanly when tools are absent).
4. `bun scripts/check-skill-drift.ts` — after **any** CLI/help copy change or
   new route/command: the agent-skill `reference/*.md` must match the binaries.
5. `bun run build` — before anything that touches packaging/releases.

## Conventions (esp. for agents)

- **Imports use `.ts` extensions** (`import { foo } from "./bar.ts"`).
- **Shared types live in `packages/core/src/types.ts`** — the single source
  of truth for wire/DB shapes; other packages import from there.
- **Barrel re-exports**: each package's `src/index.ts` re-exports its public
  surface; internal helpers stay in their own files.
- **Flat route structure**: one Elysia plugin per file in
  `packages/server/src/routes/` with its own `prefix` + Swagger `detail`.
- **DB changes** go in BOTH `SERVER_SCHEMA` and the `MIGRATIONS` array.
- **No `console.log` in library code**; daemon/server log to stdout/stderr,
  the TUI renders via OpenTUI only.
- **No `any` / inline casts** — narrow with `unknown` + type guards.
- **Glossary**: user-facing copy uses *devices*, *storage destinations*,
  *app settings backups*, *Activity* — see `docs/terminology.md`. Never
  rename API routes, DB columns, config keys, CLI commands/flags, wire types,
  or JSON keys for cosmetic reasons (the drift-check + agents depend on them).
- **Commits**: small and focused, conventional prefixes used in this repo
  (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). One logical
  change per commit; reference the Multica/issue key when one exists.

## Branch & PR workflow

- Work on a focused feature branch off `master`; keep larger programs split
  into reviewable, independently verifiable changes.
- Push and open a PR; CI runs **check** (tsc + tests + drift) and **build**
  (bun build + web dist) on every PR. `release`/`docker` jobs run on `v*`
  tags and `master` pushes.
- Keep PRs reviewable: tests green, screenshots/captures for UI changes,
  docs updated in the same PR.
- Destructive changes (config flags, DB migrations, CLI/API behavior) get a
  clear callout in the PR body.

## Where to look for guidance

- `AGENTS.md` — project overview, quick start, conventions.
- `docs/agent-start.md` — current work-order routing (agents).
- `docs/status.md` — current status, active queue, and limitations.
- `docs/README.md` — living-document map and archive policy.
- `docs/features.md` — feature history by Multica issue.
- `docs/development.md` — full dev guide, recipes, release process.
- `docs/prod-deploy.md` — production LXC operations (SSH/update/rollback).

## Releases

Version source of truth: root `package.json` (`scripts/gen-version.ts`).
`v*` tags publish standalone binaries + the GHCR Docker image; daemons
self-update via GitHub Releases (see `docs/development.md`).
