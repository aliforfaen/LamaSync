# Agent start — LamaSync

Read this after `AGENTS.md` when entering a coding worktree.

## Current work

LAMA-328 (storage/folder page performance: persisted stale-while-revalidate
sizes, embedded folder assignments, bounded storage history, progressive
Storage-destinations rendering) is implemented on `lama-328-persisted-swr-stats`
and green on all repo gates. The review-fix pass is also on that branch:
secret-free `FolderAssignmentSummary` embedded rows, a durable
`folder_size_invalidations` watermark, strict `?days` validation, and the
single-folder size refresh under the shared scheduler. LAMA-316's app-backup data contract, LAMA-324
storage destinations, LAMA-325 retention, and the LAMA-302 real-worktree soak
are complete. The next product work is LAMA-315 path classification (design
handoff ready in `docs/handoff-315-path-classification.md`; implement its stage
1), the separate safe application setup/restore executor, and the LAMA-321
trash-retention follow-up.
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
