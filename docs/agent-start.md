# Agent start — LamaSync

Read this after `AGENTS.md` when entering a coding worktree.

## Current work

LAMA-316's app-backup data contract is implemented. The next product work is
LAMA-315 path classification, LAMA-313 retention, and the separate safe
application setup/restore executor. LAMA-302 needs only a real-worktree soak.
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
