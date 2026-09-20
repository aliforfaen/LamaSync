# Agent start — LamaSync

Read this after `AGENTS.md` when entering a coding worktree.

## Current work

LAMA-345's follow-up (Dashboard fleet-health summary with the evidence-based
update verdict, one derived health read path, the far-future-cron scheduler fix,
and the in-page scroll + Folders deep-link corrections) is implemented in this
worktree too, with a reusable isolated integration harness in
`scripts/lama345-integration.ts`. Two UI entry points are now load-bearing and
easy to break: the Dashboard urgent row is a plain button (never a fragment
Link, which HashRouter corrupts) and `/folders?folder=&host=` is consumed by
`folder-deep-link.ts`. dev-vm still runs the released
v0.3.11 daemon, so its Projects folder keeps resyncing on every run (the
`bisync.state` sentinel has never existed there — the paired
`*.path1.lst`/`*.path2.lst` files are on disk). Deployment gate and the
evidence are in the LAMA-345 comments.

LAMA-345 (managed-folder health diagnostics and guided bisync intervention) is
implemented in this worktree across all four planned stages — the shared health
contract, the lightweight daemon probe and server persistence, the read-only
diagnose/plan actions, the guarded initialize/seed/resync/resume/cancel
interventions with the paired-`*.path1.lst`/`*.path2.lst` baseline fix, and the
Web UI health card, four-step guided wizard and advanced typed settings. It
awaits review and release; see the status entry in [status.md](status.md). The
two-file listing pair replaces the old `bisync.state` sentinel, filter changes
are acknowledged only by a resync that actually established a baseline, and
execution is bound to the reviewed plan's semantics (intervention, winning side
and `--max-delete` percentage) rather than to the request that follows it.
Live v0.3.12 fleet validation then found a **release-blocking plan/execution
safety regression**, fixed in this worktree too: the dry-run accumulator never
matched modern rclone's `"skipped"` field, so a plan could report 0 changes and
then execute hundreds of transfers (cachy: plan 0 → 349 transfers / 803 MB).
Plans are now truthful, and the invariant is **no unreviewed content
mutation** rather than "never rebuild a baseline": a zero-content review is a
legitimate baseline-only recovery, but the daemon re-runs a fresh dry run with
the plan's own reviewed control before executing and refuses the run if
anything would transfer (the enqueue boundary no longer rejects it, since only
the daemon can run rclone). A claimed action holds a renewable lease
(`POST /api/v1/actions/:id/lease`)
so a long plan/intervention cannot be reclaimed and re-executed while it is
still running. The LAMA-345 comments carry the evidence and the deployment
gate; do not retry the cachy intervention from a pre-fix build.

LAMA-316's app-backup data contract, LAMA-324 storage destinations, LAMA-325
retention, and the LAMA-302 real-worktree soak are complete. LAMA-327 live
sync progress and LAMA-328 persisted stale-while-revalidate folder/storage
statistics are integrated with the current application-update baseline.
LAMA-336 (the
live-tree tar fix plus the whole file-operation/app-destination audit batch)
is merged and awaits release and a `dev-vm`
update — see follow-up 2 in [status.md](status.md). LAMA-337 (reconnect QR for
an existing Android registration: an admin-created one-time QR whose exchange
rotates that device's credentials in place, so its host id, inboxes and upload
history survive) is merged and awaits release plus
one owner call on the Android paired-state QR entry — see follow-up 1. The
next product work is LAMA-315 path classification (design handoff ready in
`docs/handoff-315-path-classification.md`; stages 1–2 are implemented), the
separate safe application setup/restore executor, and the LAMA-321
trash-retention follow-up. LAMA-311's two dev-vm fixes are implemented in the
worktree — the queued `trigger_sync`/`trigger_backup` dispatcher now refreshes
and re-selects before failing a folder absent from the cache, and
`lamasyncd --update` / `update_daemon` reconcile a stale systemd user unit even
when the binary is current. Both await a client rollout that restarts
`lamasyncd.service` (see follow-up 6 in [status.md](status.md)).
See [status.md](status.md) and the assigned Multica issue for scope; do not use
archived handoffs as a current specification.

## First five minutes

1. Run `git status --short --branch`; preserve unrelated work in a dirty tree.
2. Read the assigned Multica issue and its current comments.
3. Read the smallest relevant source-of-truth document: `ARCHITECTURE.md` for
   contracts, `development.md` for implementation recipes, or `prod-deploy.md`
   for production work.
4. Find the existing behavior and tests before changing types, routes, or UI.
5. Keep one writer per worktree and report an owner decision rather than
   inventing it.

## Guardrails

- Preserve wire/API/CLI compatibility unless the issue explicitly authorizes a
  break; document intentional breaks in the skill reference.
- New DB data belongs in both `SERVER_SCHEMA` and `MIGRATIONS`.
- New routes, commands, and flags must pass the strict skill-drift check.
- Application restore must not gain a direct write path before its setup-plan
  safety contract is implemented.

## Handoff baseline

Run the checks proportional to the change. For a normal cross-package change:

```bash
bun x tsc --noEmit
bun run build:web-ui
bun test
bun run scripts/check-skill-drift.ts --strict
```

Report changed files, validation results, any unavailable live check, and any
unresolved owner decision in the Multica update.
