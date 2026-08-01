# Handoff — Command Center v1, Batch 6 (LAMA-203)

**Audience:** implementing agent. Small, web-ui-only batch. Read `AGENTS.md`
first (conventions), then the ground rules in
`docs/handoff/command-center-batch1.md`.
**Epic:** LAMA-183. Batches 1–5 merged. You build on the Command Center
(`packages/web-ui/src/pages/Dashboard.tsx`, as rebuilt by LAMA-197) and the
theme tokens (LAMA-201).

## Decisions already made (do not revisit)

- **localStorage key `lamasync-last-visit`** (millisecond timestamp).
- **First visit semantics:** when no stored value exists, initialize it to
  `now` WITHOUT highlighting anything (don't mark the entire first render as
  "new"). On every Command Center mount, update the stored value to `now`
  AFTER computing the highlights, so "new since last visit" is always the
  delta since the previous load.
- **Highlight = timestamp comparison only** (`op.timestamp >
  lastVisit` / `conflict.createdAt > lastVisit`). No new server endpoints.
- **Keep it subtle:** a small `NEW` chip (existing `.badge` styling or a
  `.chip-new` token-based class) on feed entries and per-section counts in
  the "Needs attention" header (e.g. "3 new").

## Task — "what changed since last visit"

1. **`packages/web-ui/src/pages/Dashboard.tsx`**
   - Read `lastVisit` from localStorage at mount; compute highlights BEFORE
     writing the new visit timestamp back (so this load's items are measured
     against the previous visit, not this one).
   - `Recent activity` feed rows: when `op.timestamp > lastVisit`, append a
     `NEW` chip next to the status badge.
   - `Needs attention`:
     - pending conflicts newer than `lastVisit` → count shown in the section
       header (e.g. `Pending conflicts (2 · 1 new)` or a chip on the item).
     - failed operations in the 24h window that are also newer than
       `lastVisit` → same treatment.
     - offline hosts / updates available are state, not deltas — leave them
       (don't chip them).
   - Live WS events keep working: a newly arrived operation with
     `timestamp > lastVisit` gets the chip too (pure timestamp math — no
     extra bookkeeping).
   - Guard: `localStorage` may be unavailable (SSR-ish edge) — use the same
     `typeof localStorage !== "undefined"` guard pattern as `theme.ts`.
2. **`packages/web-ui/src/index.css`** — one small rule for the chip if
   needed (`.chip-new` using `var(--accent-info)`), or reuse `.badge
   badge-update` — your call, keep it minimal. Both themes legible.
3. **No other files.** No App.tsx routing, no api.ts, no server changes.

## Scope (out)

- Persisting per-item "seen" state, unread counts across multiple pages,
  server-side last-visit (multi-device sync) — all future work.

## Acceptance criteria (from LAMA-203)

- Operations/conflicts newer than the previous visit are visually marked on
  the Command Center.
- Markers clear on the next visit (fresh delta).

## Verify before done

`bun x tsc --noEmit`, `bun run build:web-ui`, `bun test` (full suite must
pass). Manual browser check is done by the parent/user. Do NOT commit.

## Report when done

Files changed, verify results, any deviations.
