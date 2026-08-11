# Handoff — Agent surface: CLI v1, skill bundle, CLI full CRUD

**Date:** 2026-08-11
**Source:** Multica LAMA-227 (umbrella design, status `in_review`) with child
issues LAMA-229 / LAMA-230 / LAMA-231 (all `todo`). The issue bodies are the
contract — this document grounds them in the current repo and sequences the
work. If anything here conflicts with an issue body, the issue wins; flag the
drift in the PR notes.

**Status check (2026-08-11, verified against the tree):** none of the three
issues has been started. `packages/tui/src/index.ts` still only handles
`--version`/`-V` and the `LAMASYNC_NO_TUI=1` fallback;
`packages/agent-skill/` still holds the two flat files
(`lamasync-server.md`, `lamasync-client.md`) with no `SKILL.md`/`reference/`
bundle, no install pipeline, and no CI drift-check.

## Mission

Make agents first-class operators of a LamaSync fleet. Agents in harnesses
are shell-first; today every agent hand-rolls curl with auth headers, no
validation, no exit codes, no idempotency. The fix (locked in LAMA-227):
**the `lamasync` CLI is the primary agent surface; the REST/WS API is its
implementation detail and documented escape hatch.** The agent skill teaches
the CLI, not raw curl recipes.

Three phases, matching the three issues:

- **Phase A — LAMA-229 (high):** CLI v1 workflow subcommands in the existing
  `lamasync` binary. Everything else builds on its conventions.
- **Phase B — LAMA-230 (medium):** agent skill two-tier bundle + install
  pipeline + CI drift-check. Recipes reference the Phase A CLI.
- **Phase C — LAMA-231 (low):** CLI full CRUD coverage (dotfiles, conflicts,
  restic, browse, notifications, hosts/register, shares, admin).

Do A first; B and C can then run in parallel (both only depend on A's
framework and conventions).

## Maintainer decisions (locked in LAMA-227 — follow, do not re-decide)

1. **CLI lives in the same `lamasync` binary.** Bare `lamasync` → TUI
   (`bootShell()`); any subcommand → non-interactive execution, print, exit.
   `gh`-style. No separate binary.
2. **v1 CLI is workflow-scoped** — fleet status, folder create/assign,
   backends, sync trigger, operation log, `doctor`, and the local-daemon
   socket wrapper. Full CRUD is Phase C.
3. **No MCP server.** Explicitly rejected — revisit only if a daily-driver
   harness demands it.
4. **`lamasync local` (daemon socket wrapper) is in scope.** The socket
   protocol stays internal; agents get CLI subcommands, never raw `socat`.
5. **Six safety rules** are the skill's contract (verbatim in
   `reference/safety.md`, summarised in `SKILL.md`):
   1. API trust, no users — the pre-shared API key is the *only* trust
      boundary; escalate to a human instead of inventing per-user authz.
   2. Never invoke `rclone` directly — all transfers go through the daemon
      executor.
   3. Prefer the WebSocket for live state; don't poll `GET /api/v1/operations`
      in a tight loop.
   4. Mask the API key — `lamasync_…xxxx` (first 8 + last 4) in all output,
      examples, and diagnostics.
   5. Mutations need intent — reads are free; writes/destructive commands
      need explicit user intent (confirm before delete folder, force restore,
      rotate key, stop mounts).
   6. Never invent local state — if the CLI can't express the operation, stop
      and ask; don't hand-edit `config.toml`, the SQLite DB, or rclone
      configs.
6. **Explicitly rejected:** MCP server; browser agents driving the web UI;
   teaching agents the raw socket protocol; teaching curl as the primary
   path.

## Repo orientation

Bun workspace, TypeScript everywhere. Anchors for this task:

- `packages/tui/src/index.ts` — binary entry. Currently: `--version`/`-V`
  print, `LAMASYNC_NO_TUI=1` → `runCliFallback()`, else `bootShell()` with a
  renderer-failure fallback to CLI mode. **Phase A dispatches subcommands
  here, before `bootShell()`.**
- `packages/tui/src/api.ts` — `buildClient()` auth discovery: env
  (`LAMASYNC_SERVER_URL` / `LAMASYNC_API_KEY`) →
  `~/.config/lamasync/client.toml` (via `parseClientConfig` from core) →
  localhost/dev-key defaults with `needsSetup: true`. Phase A adds
  `--server` / `--api-key` flags *ahead* of this chain and reuses the rest.
  Note: the daemon installer writes the same `client.toml`
  (`packages/daemon/src/config.ts:6`), so on a daemon host an agent needs
  zero setup — this is an acceptance criterion.
- `packages/tui/src/cli-fallback.ts` — the current non-interactive print;
  superseded by `lamasync status` (keep the file working: `LAMASYNC_NO_TUI=1`
  with no subcommand routes to `status` human output).
- `packages/core/src/api-client.ts` — `LamaSyncApiClient` already covers
  almost everything the CLI needs: health, hosts, actions
  (`enqueueAction`, `listHostActions`), folders CRUD + assign/unassign/
  updateAssignment, dotfiles, operations list + prune, backends CRUD +
  `testBackend`, restic snapshots/restore, browse, conflicts, shares,
  storage report. Extend here if a command needs a missing call — one
  client, no parallel HTTP code.
- `packages/tui/src/socket-client.ts` — existing line-JSON socket client
  (`connectSocket`, `requestSyncOne`, `requestSyncAll`,
  `requestSwitchMount/Sync`). Reuse for `lamasync local`; do not duplicate
  the protocol.
- `packages/daemon/src/socket.ts` — socket command vocabulary: `status`,
  `list-folders`, `list-ops`, `sync`, `sync-all`, `switch-to-mount`,
  `switch-to-sync` (line ~187-209). `lamasync local` maps 1:1 onto these.
- `packages/core/src/socket-path.ts` — `defaultSocketPath()` /
  `defaultSocketDir()` (env `LAMASYNC_SOCKET_PATH` → `$XDG_RUNTIME_DIR` →
  `~/.lamasync`). Use it; no duplicated path logic.
- `packages/daemon/src/self-update.ts` — `fetchLatestRelease()` +
  `isNewer()`; reuse for `doctor`'s version-drift check.
- `packages/tui/src/index.test.ts` — test idiom: `bun:test`, pure helpers
  unit-tested; note the comment explaining why the OpenTUI render path isn't
  exercised in CI. Spin up a real server on an ephemeral port for command
  tests where practical (see `packages/server/src/routes/*.test.ts` for the
  in-memory Elysia `app.handle(new Request(...))` pattern).
- `packages/agent-skill/` — current state: `lamasync-server.md` (400 lines,
  server-API only — its content folds into `reference/api.md`),
  `lamasync-client.md` (148 lines, client onboarding — stays a separate
  skill), `README.md` (documents the copy-to-managed-skills install; rewrite
  for the new bundle).
- `packaging/install/install.sh` + `update.sh` — Phase B adds the skill
  install prompt + `~/.lamasync/install-state.json` persistence here.
- `.github/workflows/ci.yml` — jobs: `check` (install → build web UI →
  tsc → bun test), `build`, `release` (publishes `dist/lamasync-*/`
  binaries). Phase B adds the drift-check to `check` and the skill bundle to
  the release assets.
- `scripts/gen-version.ts` — generates `packages/core/src/version.ts`;
  skill version = repo version, no separate versioning.

### Conventions you must obey

- **Imports use `.ts` extensions** — `import { foo } from "./bar.ts"`.
- **Shared types live in `packages/core/src/types.ts`** — CLI `--json`
  output shapes come from there.
- **No `any` or inline casts** — `unknown` with `in`/`typeof` narrowing and
  real type guards.
- **Hand-rolled arg parsing, no new dependency** — match the project's
  zero-dep style.
- **No `console.log` in library code** — the CLI is the exception: its
  stdout *is* the product (the TUI's OpenTUI-only rule doesn't apply to
  non-interactive subcommands).
- Tests use `bun:test` as `*.test.ts` alongside source.
- Make minimal changes. No drive-by refactors, renames, or reformatting.

### Verification commands

```bash
bun install                      # if needed
bun run build:web-ui && bun test # tests FAIL without the web UI dist first
bun x tsc --noEmit               # type check
bun run build                    # binaries in packages/*/dist/ — smoke the CLI
```

## Execution protocol

1. Implement phases in order A → B → C (B and C may be split to different
   agents after A lands; do not start either before A's conventions exist).
2. Each phase ends with a **"Done when"** condition — check it before moving
   on. After each phase, run `bun x tsc --noEmit` and `bun test`; keep the
   tree green.
3. Do NOT run any git mutations (no commit/push/reset). Leave the working
   tree dirty for the maintainer to review.
4. No server or daemon changes are expected in Phase A or C; if a command
   genuinely needs one, flag it in the PR notes instead of silently growing
   scope. Phase B *does* touch the daemon (`--update skill`) and install
   scripts — that is in scope there.
5. When all phases are done: update `docs/features.md` with new rows, append
   a status note to `docs/status.md`, refresh `AGENTS.md` if the CLI changes
   what agents should know, and comment + set statuses on LAMA-229/230/231
   in Multica (`multica issue status LAMA-229 done` etc.).

---

## Phase A — CLI v1 (LAMA-229)

### Layout

New `packages/tui/src/cli/` directory, one module per command group:

```
packages/tui/src/cli/
  args.ts          — hand-rolled flag/positional parsing, usage errors (exit 2)
  output.ts        — table printer + --json switch + key masking (first 8 + last 4)
  client.ts        — auth discovery: flags → env → client.toml → error
  index.ts         — dispatch table; called from packages/tui/src/index.ts
  status.ts
  folders.ts       — list, create, assign
  backends.ts      — list, create, test
  sync.ts
  ops.ts           — list
  doctor.ts
  local.ts         — daemon socket wrapper
```

Dispatch in `packages/tui/src/index.ts` **before** `bootShell()`: no
subcommand (+ TTY) → TUI as today; subcommand → parse, execute, print, exit.
`LAMASYNC_NO_TUI=1` with no subcommand keeps working (route to `status`
human output).

### Commands

- `lamasync status [--json]` — fleet health + per-host status
  (`client.getHealth()`).
- `lamasync folders list [--json]`
- `lamasync folders create --name <n> --type <sync|mount|backup|dotfile|git>
  [--backend sftp|s3|local] [--s3-provider … --s3-endpoint … --s3-bucket …
  --s3-access-key-id … --s3-secret-access-key … --s3-region …]`
- `lamasync folders assign <folderId> --host <hostId> --path <localPath>
  [--role source|target|both] [--schedule <cron>] [--enabled]`
- `lamasync backends list|create|test [--json]` — `test` wraps
  `client.testBackend(id)`.
- `lamasync sync [folderId] [--host <id>]` — `client.enqueueAction(...)`
  `trigger_sync` / `trigger_backup`; without `folderId`, sync all
  assignments on the host.
- `lamasync ops list [--status failed|success|…] [--host <id>] [--limit N]
  [--json]` — `client.listOperations(...)`.
- `lamasync doctor [--json]` — structured health report: env vars present,
  API key valid (**masked** in output), server reachable, daemon socket
  probe via `defaultSocketPath()`, binary vs latest release drift
  (`fetchLatestRelease` + `isNewer`). **Exit non-zero when any check
  fails** so agents can branch on it.
- `lamasync local status|folders|ops|sync [folderId]|sync-all|mount <id>|
  unmount <id> [--json]` — thin wrapper over the daemon Unix socket using
  `packages/tui/src/socket-client.ts`; agents must never hand-roll `socat`.

### Conventions (contract — the skill's `cli.md` drift-checks against this)

- **`--json` on every command**; human-readable tables by default.
- **Exit codes**: 0 ok, 1 runtime error, 2 usage error, 3 auth failure
  (401/403), 4 server unreachable. Document in `--help`.
- **Auth discovery order**: `--server` / `--api-key` flags →
  `LAMASYNC_SERVER_URL` / `LAMASYNC_API_KEY` env →
  `~/.config/lamasync/client.toml` (written by the daemon installer).
- **Mask the API key** everywhere: first 8 + last 4.
- Every command has `--help`; help output is the source the Phase B
  drift-check scrapes.

### Done when

- On a daemon host with no env vars set, `lamasync doctor` exits 0 and
  `lamasync status --json` prints fleet health — zero agent setup.
- An agent can create an S3-backed folder, assign it to a host with a cron
  schedule, trigger a sync, and list the resulting operation — using only
  these commands.
- `bun x tsc --noEmit` and `bun test` green; new tests follow the
  `packages/tui/src/index.test.ts` pattern.

---

## Phase B — Agent skill bundle (LAMA-230)

### Layout (replaces `lamasync-server.md`; its content folds into `reference/api.md`)

```
packages/agent-skill/
  SKILL.md                  — trigger description, decision tree
                              (CLI first → API fallback → escalate),
                              safety summary, pointers into reference/
  reference/
    cli.md                  — full `lamasync` subcommand reference (Phase A)
    api.md                  — REST + WS reference; defers to /swagger/json
    recipes.md              — set up a backup, add a sync folder, fix 401s,
                              trigger + verify a sync, restore a snapshot,
                              resolve a conflict
    troubleshooting.md      — heartbeat missing, mount stuck, stale lock,
                              update failures
    safety.md               — the six rules, verbatim (see Maintainer
                              decisions §5 above)
  lamasync-client.md        — unchanged; stays a separate onboarding skill
```

Installed to `~/.agents/skills/lamasync/` (SKILL.md + reference/). Global
user scope — never committed to a consuming repo. SKILL.md frontmatter must
trigger on: `lamasync`, `lamasyncd`, sync fleet, rclone fleet, backup host,
`register host`, `add folder`, `set up backup`, `check for update`,
`snapshot`, `lamasync 401`, `lamasync auth failed`.

### Deployment & versioning

- Ships in the GitHub release bundle alongside the binaries (extend the
  `release` job in `.github/workflows/ci.yml` to package
  `packages/agent-skill/` as a tarball asset).
- `packaging/install/install.sh` prompts once ("Install the LamaSync agent
  skill to `~/.agents`? [Y/n]"), persists the answer in
  `~/.lamasync/install-state.json`, auto-updates on upgrade (default-on,
  opt-out flag). Uninstall leaves the skill in place. Keep
  `scripts/test-install.sh` / `test-update.sh` passing — extend them to
  assert the skill lands.
- Skill version = repo version. `lamasyncd --check-update` reports binary +
  skill versions; `lamasyncd --update skill` refreshes the skill from the
  release matching the local binary version (extends
  `packages/daemon/src/self-update.ts` — this is the one sanctioned daemon
  change). **Remember: daemons ≤ v0.3.0 can't self-update binaries at all
  (broken `argv[1]` bunfs path); the skill update path is new code and must
  not inherit that bug.**
- **CI drift-check**: new script (e.g. `scripts/check-skill-drift.ts`) run
  in the `check` job — every route in `api.md` must exist in
  `packages/server/src/routes/`, every command/flag in `cli.md` must appear
  in the CLI's `--help` output. Skill fails CI when it references a dead
  surface.

### Done when

- A fresh agent on a daemon host can auth-troubleshoot and set up a
  scheduled backup using only the skill — no repo read needed.
- Six safety rules verbatim in `safety.md`; SKILL.md summarises.
- Install/upgrade scripts auto-install per persisted preference; Docker
  smoke tests pass.
- CI drift-check green; `--update skill` round-trips on a real release.
- No secrets in examples — placeholders only.

---

## Phase C — CLI full CRUD coverage (LAMA-231)

Inherit everything from Phase A: `--json` everywhere, exit-code contract,
auth discovery, key masking, tables by default, one module per group.

### Command groups to add

- `lamasync folders update|delete|unassign|assignments` — delete cascades
  assignments.
- `lamasync dotfiles list|upload|download|manifests` — manifest CRUD +
  tarball push/pull (`client.uploadDotfile` / `downloadDotfile`).
- `lamasync conflicts list|resolve <id> --keep local|remote|both`.
- `lamasync snapshots list [--folder <id>]` and
  `lamasync restore <snapshotId> --to <hostId> [--path <p>] [--status <jobId>]`
  — restic restore jobs.
- `lamasync browse local|s3|restic …` — read-only browse, including
  `browse jobs` for write-job status.
- `lamasync notifications list|channels|test`.
- `lamasync hosts list|rename` and `lamasync register --hostname …
  [--tailnet-ip …]` — registration stays primarily a web UI /
  install-script flow; the CLI path is the agent fallback.
- `lamasync shares list`, `lamasync admin prune [--older-than <ms>]`.

Destructive commands (`folders delete`, `admin prune`, `restore`) prompt for
confirmation on a TTY and require `--yes` non-interactively — this is how
the CLI enforces safety rule 5.

### Route-coverage audit

Every non-daemon route in `packages/server/src/routes/` gets a CLI
equivalent or a documented reason it doesn't (e.g. the WS stream,
`web-ui.ts` static serving, daemon-only `report`/`config`/`release`
endpoints). Put the audit table in the PR description.

### Done when

- The route-coverage audit is complete with no undocumented gaps.
- `bun x tsc --noEmit` and `bun test` green; new commands have tests in the
  established pattern.
- The skill's `reference/cli.md` and the CI drift-check are updated in the
  same PR series (if Phase B has landed; otherwise file the drift-check
  update as a follow-up note in the PR).

---

## Umbrella acceptance (LAMA-227 — verify at the very end)

- A fresh agent on a daemon host, given only the skill, can: diagnose auth,
  create an S3-backed folder, assign it with a schedule, trigger a sync, and
  verify the result in the operation log — no repo read, no raw curl, no
  human at the TUI.
- Every flag/route the skill references exists in code (CI drift-check).
- Six safety rules verbatim in the skill; CLI enforces rule 5 via
  confirmation prompts / `--yes`.
- No MCP server, no secrets in examples, no new trust boundaries.
