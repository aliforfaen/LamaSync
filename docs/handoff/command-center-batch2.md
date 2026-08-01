# Handoff — Command Center v1, Batch 2 (LAMA-197)

**Audience:** implementing agent. Read `AGENTS.md` at the repo root first (layout
and conventions), then this document. This batch is **web UI only**.
**Epic:** LAMA-183 (LamaSync Expanded / Command Center v1). This doc covers
Batch 2 only. Batch 1 (LAMA-199 version visibility, LAMA-201 theme tokens) is
already merged — you build on top of it.

## Ground rules (violating these = failed review)

- Imports use `.ts` extensions: `import { foo } from "./bar.ts"`.
- No `any`, no inline casts. Use `unknown` + `typeof`/`in` narrowing.
- **Do NOT touch `packages/tui`, `packages/server`, `packages/core`,
  `packages/daemon`.** This batch is `packages/web-ui` only. If you find a
  genuine gap in the existing server APIs, FLAG it in your report — do not
  implement server changes.
- Keep changes minimal and scoped. No drive-by refactors.
- **Do NOT commit. Do NOT run git commands that mutate state.**
- No `console.log` in library code; the UI already shows errors via its
  `error` state pattern.

## Verify-before-done commands (all must pass)

```bash
bun x tsc --noEmit         # type check — must be green
bun run build:web-ui       # must succeed (inlines the SPA)
bun test                   # full suite must pass
```

Manual browser smoke is done by the parent/user — not you.

## Task — LAMA-197: Command Center dashboard (v1)

**Goal:** the landing page answers in 3 seconds: **what needs attention, fleet
status, recent failures, available updates.** ADHD-friendly means triage, not
more data.

**Decisions already made (user, 2026-08-01 — do not revisit):**

- **Evolve `packages/web-ui/src/pages/Dashboard.tsx` in place** at route `/`.
  No new route, no routing changes in `App.tsx`. The existing Dashboard data
  fetches + WS `mergeEvent` + `useWebSocket` are the backbone — keep them.
- **"What changed since last visit" highlighting is DEFERRED** (tracked as
  LAMA-203). Do NOT implement last-visit timestamps or NEW chips.
- **Quick actions link to existing pages only** (Folders, Conflicts). No dead
  links, no placeholders for host detail (that's LAMA-198).
- **No new server endpoints.** Use: `api.health()`, `api.listFolders()`,
  `api.listConflicts("pending")`, `api.listShares()`,
  `api.listResticSnapshots()`, `api.listOperations(limit)`.

**Available now from LAMA-199:** `Host` carries `version` and
`updateAvailable` (server-derived) — no client-side version comparison.

**Existing assets you build on:**

- Theme tokens (LAMA-201) in `index.css`: `--accent-critical` (red),
  `--accent-warn` (yellow), `--accent-ok` (green), `--accent-info` (blue),
  `--accent-storage` (purple), `--accent-sync` (teal), plus `--bg`,
  `--surface`, `--border`, `--text`, `--text-dim`, `--text-muted`,
  `--space-*`, `--radius-*`, `--font-size-*`.
- Existing classes: `.page`, `.toolbar`, `.section`, `.summary-grid`,
  `.summary-card`, `.table`, `.badge` + `.badge-{status}`, `.muted`, `.error`,
  `.empty-row`, `.action`.
- Icons in `components/icons.tsx`: `IconHost`, `IconFolder`, `IconDotfile`,
  `IconBackup`, `IconStorage`, `IconConflict`, `IconUpdate`,
  `IconNotification`.
- `OperationLog` fields: `id, timestamp, hostId, folderId, operation, status,
  summary, details, durationMs`; status ∈ started/success/failed/conflict/
  recovery/retry.
- `listOperations(limit)` clamps server-side (MAX_LIMIT); fetching 100 gives
  enough history for the 24h failed-op count.

## Scope (in) — sections of the page, in order

1. **"Needs attention"** (first, above the fold; empty state = a friendly
   green "All quiet" line):
   - Pending conflicts: count + up to 3 most recent, link to `/conflicts`
   - Failed operations in the last 24h: count + up to 3 most recent (op
     `status === "failed"` and `timestamp >= Date.now() - 24*3600*1000`)
   - Offline/degraded hosts: count + hostnames (`status === "offline" ||
     "degraded"`)
   - Updates available: hosts with `updateAvailable === true` (list hostname +
     version)
2. **Fleet cards**: one card per host — hostname, status badge, last seen
   (formatted), version (`v{version}` or "—"), update pill when
   `updateAvailable`. Healthy hosts stay compact; no per-host details yet.
3. **Recent activity feed**: last ~20 operations, live over WS — time, hostId,
   operation, status badge, summary. New entries prepend (existing
   `mergeEvent` does this; keep the cap).
4. **Quick actions**: links to `/folders` and `/conflicts` (existing pages).
   Keep it minimal.

You may keep the existing summary cards (Hosts/Online/Offline/Folders/
Conflicts/…) if they earn their place, but the page must NOT become a wall of
numbers — triage first, details behind links. Fold `DashboardData`/`mergeEvent`
as-is; they're correct. Any new CSS goes in `index.css` using `var(--…)`
tokens and must read well in BOTH themes (dark is the regression baseline;
light was added in LAMA-201).

## Scope (out)

- Host detail pages (LAMA-198), remote/queued actions, "update all" buttons
- Since-last-visit highlighting (LAMA-203)
- Any server/core/daemon/TUI change
- New pages or routing changes

## Acceptance criteria (from the issue)

- Command Center is the landing page of the web UI (route `/` — already the
  case; the rebuild must not break it)
- All sections live-update over WebSocket
- Critical state visible without scrolling on a typical fleet (≤10 hosts)

## Report when done

Files changed, `bun x tsc --noEmit` / `bun run build:web-ui` / `bun test`
results, and any deviation from this doc (including server gaps you found but
did not implement).
