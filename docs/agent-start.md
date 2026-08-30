# Agent starting point — current LamaSync work

This is the short orientation for an agent entering LamaSync through a fresh
worktree. It is intentionally shorter than the historical status log and the
Multica issue descriptions.

## Read this order

1. `AGENTS.md` — repository rules and architecture constraints.
2. This file — current work-order routing and guardrails.
3. `docs/status.md` — current implementation status and known queue.
4. Multica **LAMA-249** — user-oriented interfaces parent.
5. The specific child issue assigned to the worktree.

The canonical design work order is **LAMA-275 — Design system + web/TUI shell
overhaul**. Its implementation scope is deliberately separate from the
feature ideas in the other LAMA-249 children.

## Where to begin today

Updated 2026-08-30. The foundation (LAMA-250 terminology) and design
overhaul (LAMA-275, owner-approved D1–D5) are **done** — do not redo them.
The feature batches, LAMA-234 managed keys, and TUI access-key work are
shipped and audited green. The current work order is release verification:

### A. v0.3.3 release verification

Confirm the tag CI produces the three binaries, agent-skill bundle, and GHCR
image. Then update and health-check production using `docs/prod-deploy.md`.
Do not claim production is updated until the live image and boot log are
verified.

### B. Maintenance follow-ups

Optional follow-ups are the 507 kB web-bundle split, a fuller browser/PTY
artifact set, and live managed-key migration/pairing smoke testing. These are
not prerequisites for the already-green build or release tag.

### Historical context

The original LAMA-275 sequencing (terminology → design proposal → shell
implementation) is preserved below for reference.

### Historical LAMA-275 implementation sequence

1. Define the shared design contract: type scale, spacing, surfaces, status
   semantics, action hierarchy, focus/selection behavior, and theme rules.
2. Reshape the web application shell: navigation hierarchy, page context,
   max-width/layout strategy, responsive behavior, and primary actions.
3. Reshape the TUI shell: task-oriented orientation, less permanent chrome,
   unmistakable selection, contextual actions, adaptive help, and terminal-safe
   semantic colors.
4. Recompose representative pages/views, then sweep the rest.
5. Capture before/after browser screenshots and terminal recordings at the
   supported sizes.

The web UI is the fleet control plane and detailed configuration surface. The
TUI is the fast local/SSH action cockpit. Aim for conceptual parity, not pixel
parity.

## Scope guardrails

- Preserve REST routes, DB schema, config keys, wire types, CLI command paths,
  JSON keys, and daemon behavior.
- Do not absorb the existing LAMA-249 feature children into this design issue:
  app presets, pairing, demo data, activity timeline, dry runs, time travel,
  file viewer, health drills, schedule presets, conflict cards, charts,
  command palette, empty-state coaching, device cards, pause/slow mode, or
  llama/personality work.
- Keep one writer per worktree. Start with `git status --short --branch` and
  do not overwrite unrelated changes if the checkout is not clean.
- Do not recreate the deleted `docs/handoff/` or `docs/plans/` trees. Historical
  notes may mention them, but active instructions belong here, in `docs/status.md`,
  and in the linked Multica issue.

## Validation before handoff

Run the relevant checks after implementation:

```bash
bun x tsc --noEmit
bun run build:web-ui
bun test
```

The final Multica update should include changed files, commands run, test
results, screenshots/recordings or a note explaining why they were unavailable,
and any unresolved owner decision. Never claim an owner decision was made when
it was only assumed.
