# Handoff — coding-agent batch 2: time-travel, delight, polish run 2 (2026-08-25)

Follow-up to `docs/handoff-agent-batch-2026-08-24.md` (all seven issues of
batch 1 shipped and audited green: 679 pass / 1 skip / 0 fail, drift
`--strict` enforced). Same session contract applies:

1. One issue per commit; gates after each:
   `bun x tsc --noEmit` → `bun run build:web-ui` → `bun test` →
   `bun scripts/check-skill-drift.ts --strict` (**strict now fails CI**).
2. No renames of routes/columns/config keys/wire types/CLI commands;
   additive only; schema changes go in BOTH `SERVER_SCHEMA` + `MIGRATIONS`.
3. Glossary copy per `docs/terminology.md`.
4. After each: append `whats-new-for-owner.md`, tick dogfood checklist,
   flip the Multica issue to done with a ship comment.
5. Commits land on `feature/product-finish` for review via PR #1.

---

## LAMA-259 — Time-travel browser: slider through backup history

**Existing seams (use them, don't invent):**
- `restic_snapshots` table + WS event `{ kind: "restic_snapshot", snapshot }`
  (`packages/core/src/types.ts`).
- Server routes: `packages/server/src/routes/restic.ts` (snapshot listing +
  trigger verbs) and `browse.ts` (file browsing, incl. S3/local paths).
- Web: `pages/DataBrowser.tsx` already browses live folder contents.
- Daemon runs restic through the rclone remote (`rclone:<backend>`).

**Design sketch:**
- DataBrowser gains a **history mode** when the viewed folder belongs to a
  backup-type destination: a horizontal snapshot slider (time-scrubber)
  fed by `GET`-ing that folder's snapshots (additive query param or small
  endpoint on `restic.ts` — no renames).
- Selecting a snapshot lists its files at that point in time. Prefer
  restic `ls <snapshot>` executed through the existing daemon action relay
  (same pattern LAMA-257 used for dry-run) so the server never talks to the
  repo directly. Cache per (folderId, snapshotId) briefly if needed.
- Restore affordance stays out of scope unless trivial — browsing history
  is the deliverable; deep-linking `/browse?folder=X&at=<snapshotId>` is a
  stretch goal.
- **Offline-testable**: unit tests against fixture snapshot rows; the demo
  seed (LAMA-264 pattern) can grow one extra fake snapshot set for UI dev.
- Slider must be keyboard-operable (arrow keys) and reduced-motion safe.

**Acceptance**: history slider renders from real snapshot rows; file list
matches `restic ls` output shape; additive wire surface only; unit tests
for selection state + endpoint parsing.

---

## LAMA-265 — Hopping llama + confetti: UI delight pass

**Guardrails first:** this is a *delight* pass, not a mascot invasion. The
product voice is calm homelab utility (LAMA-275 direction, owner-approved).
No emoji, no image assets — inline SVG / CSS-drawn only, consistent with
`EmptyState`.

**Design sketch:**
- **Llama glyph**: one reusable `<Llama />` SVG component
  (`components/Llama.tsx`) — the hopping llama from the project branding,
  drawn in currentColor. Appears in: empty states (optional slot, replacing
  the plain CSS glyph where it earns its place), the Dashboard success
  toast spot, and `404`/error page if one exists.
- **Confetti**: fires exactly once per milestone event, gated by a
  `localStorage` flag per milestone: first successful backup ever observed
  on the Dashboard, first device paired, first app-settings backup created
  via Presets. Never on repeat events; never on failures.
- Pure CSS confetti burst (transform keyframes, ~1.2s, auto-cleanup);
  respects `prefers-reduced-motion` → falls back to a static "✓ nice work"
  line.
- Zero dependencies. Component + trigger hook unit-tested; visual result
  screenshot into `docs/lama275-artifacts/`.

**Acceptance**: confetti fires once per milestone, never twice (reload-safe
via localStorage), reduced-motion honored, no new deps.

---

## Polish run 2 — agent-planned spec (no Multica issue yet)

Two commits' worth of hygiene after batch 1 + this batch. Split as
**P-A (web UX hardening)** and **P-B (cleanup leftovers)**. If either grows
past ~300 lines changed, stop and split further.

### P-A — Web UX hardening

1. **Focus & keyboard audit of overlays**: DryRunDrawer, CommandPalette,
   ConfirmDialog/Modal, Presets device picker. Every overlay must: trap Tab,
   close on Esc, return focus to the invoker, carry correct
   `role`/`aria-modal`/`aria-label`. Fix gaps found; add a shared
   `useOverlayA11y` hook if 3+ components need the same logic.
2. **Reduced-motion sweep**: donut, sparkline, confetti, palette fade,
   pulsing status dots — all animation gated behind
   `prefers-reduced-motion`. One grep-able helper.
3. **Error states over silent dashes**: pages currently collapse fetch
   failures into `—` placeholders (Admin pattern flagged in cleanup P2 #9).
   Sweep Dashboard/Hosts/Backends/Operations: failed fetches show an inline
   error caption + retry link, not blank cells.
4. **<900px responsive check** of everything added since batch 1 (Presets
   gallery, conflict cards, HostDetail dry-run button, storage donuts) in
   the grouped-rail→drawer breakpoint. Fix overflow/touch-target misses.
5. **Glossary sweep of batches 1–2 copy** against `docs/terminology.md`
   (devices / storage destinations / app settings backups), including the
   operation-sentence templates.

### P-B — Cleanup leftovers (from `docs/cleanup-2026-08-18.md`)

Only items confirmed still open (8/10/11/12/14 landed in the LAMA-247
batch):

6. **Operation-log archival export** — `POST /api/v1/admin/export`
   (+ optional `--target` on `lamasync admin prune`) writing a tarball to
   the backup dir before deletion; unit test round-trips it.
7. **Dead `ntfyUrl` hookup removal** — delete the unused legacy env path in
   `server/src/notifications.ts` + dev-docs env table row. (LAMA-200 engine
   owns notifications.)
8. **Dotfile diff preview in TUI restore** — `tar -tzf` listing compared
   against disk, unified diff shown before extraction
   (`tui/src/views/dotfiles.ts`).
9. **Renderer smoke tests** — 2–3 view-shape tests behind
   `LAMASYNC_TUI_TEST_VIEWS=1` locking the shell contract.
10. **Docs: `LAMASYNC_SOCKET_PATH` env table entry** in
    `docs/development.md`.

### Owner decision requested (do NOT let an agent guess)

11. **CLI fallback default** (cleanup P3 #13): should bare `lamasync` with
    no `client.toml` refuse to run, or keep friendly localhost/dev-key
    defaults with the louder warning? Currently parked; needs Aleksander's
    call before anyone codes it.

**Acceptance (both commits)**: gates green; before/after notes in
`whats-new-for-owner.md`; any behavior change (ntfy removal, error captions)
listed explicitly in the ship comment.
