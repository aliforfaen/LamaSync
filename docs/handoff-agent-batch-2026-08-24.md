# Handoff — coding-agent batch: web polish + TUI rendering (2026-08-24)

Work-order for a coding-agent session on `feature/product-finish`. Five
Multica issues picked because they are **web-first/additive, need no live
daemon or LXC access**, and fit the branch session contract. Two small
add-ons (LAMA-282, LAMA-283) can ride the same session.

State at handoff time: branch pushed through `1ad8d56`, PR #1 open CI green,
tests 630 pass / 1 skip / 0 fail, skill-drift warning-free. Audit context:
`docs/handoff-wrapup-2026-08-24.md`.

## Session contract (same as handoff-flourishes.md)

1. One issue per commit; gates after each:
   `bun x tsc --noEmit` → `bun run build:web-ui` → `bun test` →
   (`--strict` drift check once LAMA-283 lands).
2. **No renames** of API routes / DB columns / config keys / CLI commands /
   wire types. Additive endpoints/columns only; schema changes go in BOTH
   `SERVER_SCHEMA` and `MIGRATIONS`.
3. Glossary per `docs/terminology.md` (devices, storage destinations,
   app settings backups). User-facing copy only.
4. After each feature: append `docs/whats-new-for-owner.md`, tick
   `docs/dogfood-2026-08-23.md`, flip the Multica issue to done with a ship
   comment.
5. Merge flow: commits land directly on `feature/product-finish` for batch
   review via PR #1.

Suggested order: quick wins first — 258 → 269 → 257 → 268 → 153, then the
LAMA-282/283 add-ons.

---

## LAMA-258 — Human-sentence activity feed + timeline

- Operations rows already carry `summary` strings written by the server;
  the feed renders them raw (`packages/web-ui/src/pages/Operations.tsx`
  renders `op.summary ?? "—"`).
- Add a formatter that turns operation rows into glossary sentences:
  "Backed up **Dev configs** from **cachy** to **Exoscale** · 2h ago · ok",
  with relative timestamps and status words never conveyed by color alone.
- Reuse the pattern from LAMA-267 (`next-run.ts`): pure module
  (`operation-sentence.ts`) + unit tests; both Operations page and Dashboard
  timeline consume it.
- Keep the raw summary available behind a title/tooltip or "advanced"
  affordance — do not delete information.

**Acceptance**: feed reads as sentences on Devices/Dashboard/Activity;
unit-tested formatter; no wire changes.

---

## LAMA-269 — Storage as a picture: donut + growth sparkline per destination

- Data source: existing per-folder size endpoint (`GET /folders/:id/size`,
  S3-only, 15-min cache) plus backend listing. **Gap to expect**: sizes may
  be missing for non-S3 backends — render an explicit "not measured yet"
  state, never a fake zero (ties into LAMA-282's storage-used work).
- New pure component(s) in `packages/web-ui/src/components/` drawing SVG
  donut + sparkline from a plain data array (no chart dependency unless one
  is already in the lockfile). CSS-drawn or inline SVG consistent with the
  EmptyState glyph approach (no emoji/assets).
- Wire into `pages/Backends.tsx` (per-destination card header) and optionally
  Dashboard storage summary.

**Acceptance**: donut + sparkline render from real size data; graceful
"unmeasured" state; unit tests for the aggregation math.

---

## LAMA-257 — Dry-run preview: "What's going to happen?" drawer

- Seam: daemon's rclone invocation layer (`packages/daemon/src/rclone.ts`)
  and the action executor (`executor.ts`). rclone supports `--dry-run`;
  bisync has `--dry-run` too.
- Additive surface: new action type or query flag that runs the planned
  transfer with `--dry-run` and streams back the file list; server relays
  via the existing action model (no new long-lived connections).
- Web: drawer on the folder detail / assignment view ("Preview next run")
  showing would-transfer / would-delete counts and a capped file list
  (e.g. first 200 lines).
- **Safety**: dry-run must never create queued side effects, bump
  `config_revision`, or write operation_log rows marked as real transfers —
  tag them distinctly if logged at all.

**Acceptance**: preview matches the subsequent real run's file set on a
local backend (testable offline with rclone + local dirs); additive route/
action only; unit tests around the flag plumbing.

---

## LAMA-268 — Smart conflict cards (side-by-side preview)

- Conflict data exists on the wire: `Conflict` type in
  `packages/core/src/types.ts`, `conflict_pending` op status, WS event
  `{ kind: "conflict", conflict }`. Check what fields it carries today —
  expect additive extension (sizes, mtimes, per-side paths) rather than a
  new table.
- Web: conflict list becomes cards with side-by-side local vs destination
  columns (name, size, mtime), actions Keep-local / Keep-remote resolved
  through the existing conflict-resolution verb (find it in
  `server/src/routes/report.ts` / folders routes before inventing one).
- Never color-alone for winner/loser indication; use text labels.

**Acceptance**: seeded conflicts (can reuse the LAMA-264 demo seed pattern)
render as cards; resolve actions work against existing verbs; additive wire
changes only.

---

## LAMA-153 — Markdown table rendering & foldable sections in TUI

- TUI-only. Only current markdown-ish handling found in
  `packages/tui/src/views/dotfiles.ts`; check whether OpenTUI exposes any
  text-markup primitives before hand-rolling.
- Scope: render markdown tables as aligned fixed-width tables (respect the
  80-col constraint — see the owner-relook tabWidth lessons in
  `docs/status.md`) and `<details>`-style folds as expandable rows keyed by
  Enter on the focused row (focused widget owns Enter — LAMA-173 rule).
- Where used: adaptive help output and any view that prints structured
  lists (`logs`, help).

**Acceptance**: golden-output style tests for the renderer module; no
regression to the six-tabs-fit-80-cols layout.

---

## Add-ons (same session, trivial)

- **LAMA-283** — flip drift check to `--strict` in CI + AGENTS.md policy
  line. Do this EARLY so later commits in the session are held to the bar.
- **LAMA-282** — host OS + storage-used on the wire; pairs naturally with
  LAMA-269's "storage per destination".

## Out of scope here (needs live LXC — separate orchestrator session)

LAMA-273 (pause/slow mode), LAMA-266 (backup fire drills),
LAMA-262 (pairing), live verification of LAMA-263/264 — plan:
`docs/handoff-273-266-plan.md`.
