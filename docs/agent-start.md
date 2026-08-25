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

Updated 2026-08-25. The foundation (LAMA-250 terminology) and design
overhaul (LAMA-275, owner-approved D1–D5) are **done** — do not redo them.
Batch 1 (LAMA-153/257/258/268/269/282/283) is shipped and audited green.
Current work orders:

### A. Coding-agent batch 2 (no live infra needed)

Work order: `docs/handoff-agent-batch2-2026-08-25.md` — LAMA-259
(time-travel browser), LAMA-265 (llama + confetti delight pass), and the
agent-planned polish run 2 (P-A web UX hardening + P-B cleanup leftovers).
Session contract is at the top of that file. Batch 1's contract and audit:
`docs/handoff-agent-batch-2026-08-24.md`.

### B. Live-LXC batch (needs SSH to the container)

Plans: `docs/handoff-273-266-plan.md` (LAMA-273 pause/slow mode,
LAMA-266 backup health fire drills) plus pending live verification of
LAMA-263/264 (see `docs/handoff-wrapup-2026-08-24.md`). Run against the
live app; the main orchestrator owns this one.

### Historical context

The original LAMA-275 sequencing (terminology → design proposal → shell
implementation) is preserved below for reference.

### C. Implementation sequence after approval

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
