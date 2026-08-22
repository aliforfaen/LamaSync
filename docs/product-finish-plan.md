# Product-finish execution plan — worktree `feature/product-finish`

Worktree-local plan for the LAMA-249 "user-oriented interfaces" program.
This is the operational plan for THIS worktree; strategy and decisions live in
Multica LAMA-249 (parent) + its children, orientation in `docs/agent-start.md`.

## Sequencing decisions (owner, 2026-08-22)

- **LAMA-275**: proposal/mockup first; owner decides the five open questions
  by reacting to it — no silent choices.
- **LAMA-251 web copy pass is folded into the LAMA-275 page-recomposition
  sweep** (each page touched once). LAMA-253 CLI/TUI help copy stays a
  separate pass after the glossary.
- **Merge flow: one PR per phase** back to master (CI + review moment each).

## Baseline (established 2026-08-22)

- Branch `feature/product-finish` fast-forwarded to `0c053c3` (includes the
  2026-08-18 docs cleanup; `docs/handoff/` + `docs/plans/` are gone).
- `docs/agent-start.md` copied from the main checkout (untracked there — do
  not lose it when the main checkout commits or cleans up).
- Gates green: `bun x tsc --noEmit` clean, web-ui dist builds,
  **583 tests pass / 1 skip / 0 fail**.

## Scope guardrails (from LAMA-249 decision #1)

- **No renames** of API routes, config keys, DB columns, wire types, CLI
  command paths, JSON keys, or daemon behavior. Presentation + repo polish only.
- Sync-first positioning: "sync-fleet controller" identity stays.
- `scripts/check-skill-drift.ts` must stay green after any copy pass.
- Feature ideas in other LAMA-249 children (pairing, presets, demo mode,
  timeline, etc.) are OUT OF SCOPE here.

## Phases

### Phase 1 — LAMA-250: terminology glossary + audit checklist ✅ starting point
Create `docs/terminology.md`: host→device, backend→storage destination,
dotfile→app settings backup, sync/mount→synced folders (+ read-only sub-label),
cron→schedule presets, conflict strategies in plain language. Include an audit
checklist table mapping every surface (web-ui views, TUI wizards/views, CLI
`--help`, README) to its current terms. No code changes. This unblocks every
later phase.

### Phase 2 — LAMA-275: inventory + design proposal (owner decisions)
Inventory current web/TUI shells with before screenshots at representative
sizes. Produce a small design proposal answering the five open owner decisions:
visual direction, web navigation shape, task-oriented TUI tabs, GitHub view
placement, minimum viewport floor — with a recommendation for each. Post to
LAMA-275 comments; owner approves/adjusts there. Reversible work only until
approved.

### Phase 3 — LAMA-275 implementation + LAMA-251 web copy (after approval)
Shared design contract → web shell/navigation/responsive → TUI shell/IA/
selection/contextual actions → recompose representative pages → sweep rest,
applying the terminology glossary to every page as it is recomposed (LAMA-251
folded in here). Before/after artifacts at all supported sizes.

### Phase 4 — copy passes against the glossary (LAMA-251 folded in, LAMA-253)
The **web-ui view copy (LAMA-251) is applied during Phase 3's page sweep**, not
as a separate pass. This phase covers only LAMA-253: CLI/TUI `--help` + usage
blocks + wizard text + error messages. Strings only; commands/flags/exit
codes/JSON keys unchanged. Re-run drift check after.

### Phase 5 — LAMA-252: README rewrite
Sync-first headline, what-does-this-do-for-me → 15-minute setup → architecture;
public-safe (SSH/IP/fleet specifics move to `docs/prod-deploy.md` only);
glossary applied.

### Phase 6 — LAMA-254: repo polish + fresh-eyes onboarding audit
Screenshots/GIFs (AFTER wording is final), CONTRIBUTING.md, issue templates +
PR template, stranger-flow install→register→folder→first-backup audit with
findings filed as follow-up issues.

## Merge discipline

Each phase ends with a PR from this branch to master (CI runs on the PR);
merge after review. No direct pushes of feature work to master.

## Validation gates (every phase before commit)

```bash
bun x tsc --noEmit
bun run build:web-ui   # needed once per session before bun test
bun test
# after any CLI/TUI copy change:
bun scripts/check-skill-drift.ts   # or via CI check job
```

## Handoff rules

Update this file's phase checkboxes + Multica issue status at end of each
session. Unresolved owner decisions go into the LAMA-275 handoff comment,
never buried in code.
