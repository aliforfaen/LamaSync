# Status & work queue — LamaSync

Updated 2026-09-03. This is the current state, not an append-only changelog.
Older release notes and completed work are in
[`archive/status-2026-08-through-2026-09-03.md`](archive/status-2026-08-through-2026-09-03.md).

## Current release

v0.3.7 is deployed. The server, daemon, TUI/CLI, web UI, agent skill, and
deploy agent build from the same Bun workspace. CI runs type-check, web build,
tests, strict skill drift, and distributable binary build.

## Recently shipped

- **LAMA-316 — application templates, protections, and snapshots.** The
  legacy profile/manifest/version model is replaced by an explicit
  `ApplicationTemplate → ApplicationProtection → ApplicationSnapshot` contract.
  Protections are host-bound, schedule directly in the daemon, and retain an
  immutable snapshot history. Legacy tables remain read-only for migration
  safety; `_global` inheritance and the `lamasync dotfiles` CLI namespace are
  gone.
- **LAMA-307–311 — device setup and release hardening.** New sync targets are
  created safely where appropriate, duplicate runs are serialized, home paths
  expand correctly, initial read-only mount setup is available, and sandbox
  release discovery is documented.
- **LAMA-299/301 — remote daemon update and controlled server deploy.** The
  server has no Docker socket or arbitrary shell endpoint; a narrowly scoped
  LXC deploy agent runs the fixed deployment script.

## Active follow-ups

1. **LAMA-315 — path classification and recommendation UX.** Classify app
   paths and use that knowledge for safer capture selection.
2. **LAMA-313 — retention policy.** Define and implement practical snapshot
   retention/pruning before histories grow unchecked.
3. **Application setup/restore executor.** Build the target-side wizard:
   preflight, dry-run/change plan, populated-target decisions, revalidation
   before writes, rollback artifact, and execution journal. Direct app restore
   remains intentionally unavailable until this exists.
4. **LAMA-302 — event-triggered sync.** Implementation is complete; the
   remaining work is a live soak on a busy Git worktree. See
   [`handoff-302-event-triggered-sync.md`](handoff-302-event-triggered-sync.md).

## Known limitations

- App-capture archive rewriting currently relies on GNU tar's `--transform`
  behavior and is verified on Linux. There are no macOS or Windows clients in
  the fleet today; qualify their archive tooling before onboarding either
  platform for application capture.
- Application restore is inspect/download-only until the setup executor lands.
- The web UI emits a production bundle warning at roughly 727 kB minified.
  Code splitting is maintenance work, not a release blocker.

## Recent verification baseline

After the LAMA-316 behavior pass: `bun x tsc --noEmit`, `bun test` (1353 pass,
9 renderer-dependent skips), strict skill drift, `bun run build`, skill-tarball
creation, and the local app-snapshot smoke flow all passed.
