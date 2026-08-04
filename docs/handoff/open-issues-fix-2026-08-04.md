# Handoff: LamaSync open-issue fix pass — 2026-08-04

**Audience:** an implementation agent working the LamaSync repo at
`/home/messhias/LamaFiles/projects/lamasync` (Bun workspace, TypeScript).
Every issue below was re-verified against the working tree on 2026-08-04 —
the file/line references are current.

## Board state summary (Multica, project `f430dbc3`)

- ~70 issues `done`, 2 `cancelled`, 2 `backlog` (LAMA-174, LAMA-175 — low-value
  refactors, **do not touch**), 1 `in_review` (LAMA-176 — human review
  pending, **do not touch**), 1 `todo` that is design-only (LAMA-227,
  theorycraft for an agent skill — **no code to write**).
- **7 issues need code fixes** — all verified still reproducible in the tree:

| Issue | Pri | Area | One-liner |
|---|---|---|---|
| LAMA-216 | high | TUI | Backup-setup wizard coded but never wired to `w` hotkey |
| LAMA-211 | high | web-ui | Edit-form schedule preset clobbers dotfile manifest form |
| LAMA-215 | medium | server | `POST /folders/:id/assign` accepts non-existent hostId |
| LAMA-214 | medium | web-ui | No Operations page; "Failed operations" item not clickable |
| LAMA-213 | medium | web-ui | Conflict resolve fires on a single click, no confirm |
| LAMA-182 | medium | TUI | Process lingers after `q` — WS + parked promise keep loop alive |
| LAMA-217 | low | web-ui | Dead icons + brittle 401 detection |

## Ground rules (from AGENTS.md — read it first)

- Imports use `.ts` extensions: `import { foo } from "./bar.ts"`.
- No `any`, no inline casts — narrow `unknown` with type guards.
- No `console.log` in library code.
- Before finishing **every** issue run:
  - `bun x tsc --noEmit` — must stay green.
  - `bun run build:web-ui && bun test` — tests need the web-ui dist first.
- Make minimal, scoped edits. Match surrounding code style. Do not refactor
  unrelated code.
- When an issue is fixed, mark it on Multica:
  `multica issue status LAMA-XXX in_review` (not `done` — a human reviews).

---

## LAMA-216 — TUI: wire the backup-setup wizard (high)

**Problem:** `packages/tui/src/flows/backup-setup.ts` exports a complete
7-step wizard (`createBackupSetupWizard(opts: { ctx: ViewContext })` at :140;
its `onFinish` calls `ctx.api.createFolder(...)` then `assignFolder(...)` at
:263-269) but **nothing imports it**. Both views show a placeholder instead:

- `packages/tui/src/views/local.ts:511-524` — `w` hotkey shows a
  "Backup wizard not yet wired" modal.
- `packages/tui/src/views/fleet.ts:327-334` — same placeholder.

**Fix:** In both views, replace the placeholder with
`ctx.openWizard(createBackupSetupWizard({ ctx }))` (the `ViewContext` already
carries `openWizard` — see `packages/tui/src/boot.ts:78-88`). Follow the
existing wizard-open pattern in `packages/tui/src/views/dotfiles.ts` (the `n`
hotkey). Remove the now-dead placeholder modal code and stale "slice I will
wire this" comments.

**Verify:** `bun x tsc --noEmit`; grep that `createBackupSetupWizard` is
imported in both views; if the flow has pure logic worth testing, add a case
to a wizard test alongside existing `*.test.ts` files. `bun test` green.

---

## LAMA-211 — Web UI: schedule preset clobbers edit form (high)

**Problem:** `packages/web-ui/src/pages/Dotfiles.tsx:222-226` —
`updateSchedule(formUpdater, value)` spreads the **create** form state:

```ts
formUpdater({ ...form, schedulePreset: value, schedule: preset.cron });
```

It is called with both `setForm` (:311) and `setEditForm` (:391). From the
edit form, `...form` silently resets appName/paths/excludes to the create
form's values; saving corrupts the manifest.

**Repro:** Dotfiles → create manifest → Edit → change schedule preset →
other fields revert.

**Fix:** Use the updater-callback form so the spread targets the form being
updated, e.g. change the signature to take the React state setter and call
`formUpdater((current) => ({ ...current, schedulePreset: value, schedule: preset.cron }))`
(and the `else` branch likewise). Keep both call sites working.

**Verify:** `tsc --noEmit`; manually trace both call sites; `bun test`.

---

## LAMA-215 — Server: assign accepts non-existent hostId (medium)

**Problem:** `POST /api/v1/folders/:id/assign` in
`packages/server/src/routes/folders.ts` (~:601-724) validates the folder
exists (~:609) but never checks `b.hostId` — an arbitrary hostId returns 201
and inserts the row (insert at :612-641).

**Fix:** Before the insert, look up the host in the `hosts` table (mirror the
folder-not-found check's style and status code — 404 with the same error
shape). Unknown hostId → 404; do not insert.

**Verify:** Add a route test next to the existing server route tests
(`packages/server/src/**/*.test.ts`) covering: unknown hostId → 404, known
hostId → 201. `bun test` green.

---

## LAMA-214 — Web UI: Operations page + clickable Dashboard item (medium)

**Problem:** `packages/web-ui/src/pages/Dashboard.tsx:254` renders
`<AttentionItem title="Failed operations (24h)" …>` with **no `to` prop**
(the component supports `to?: string`, :109-115) because no fleet-wide
operations page exists. Routes in `packages/web-ui/src/App.tsx:47-56` have no
`/operations`.

**Fix:**

1. New `packages/web-ui/src/pages/Operations.tsx` — read-only, paginated,
   status-filterable table over `GET /api/v1/operations`
   (`api.listOperations` exists at `packages/web-ui/src/api.ts:181-182`;
   extend it if you need filter params — check the server route for the
   supported query params first). Model it on the Dashboard operations table
   (:400-405+) and HostDetail's (:283+).
2. Register `<Route path="/operations" element={<Operations />} />` in
   App.tsx and add a nav entry where the other nav links live.
3. Pass `to="/operations"` to the failed-operations `AttentionItem`.

**Verify:** `tsc --noEmit`; `bun run build:web-ui`; `bun test`.

---

## LAMA-213 — Web UI: confirm before conflict resolve (medium)

**Problem:** `packages/web-ui/src/pages/Conflicts.tsx:82-107` — the
Local/Remote/Both buttons call `onResolve(c.id, …)` on the first click. A
misclick is an immediate data decision. The TUI uses two-press confirm.

**Fix:** Add a confirmation step. Simplest consistent option: the Folders
page already has a delete-confirm pattern — reuse whatever it uses (check
`packages/web-ui/src/pages/Folders.tsx` for `confirm(` or an inline two-click
state). Prefer an inline two-click ("Local" → "Confirm local?") per row over
a blocking `confirm()` only if that matches the existing codebase idiom —
check first, then match it.

**Verify:** `tsc --noEmit`; `bun run build:web-ui`; `bun test`.

---

## LAMA-182 — TUI: process lingers after quit (medium)

**Problem:** Pressing `q` tears down the renderer but the process never
exits. Two causes:

1. `packages/tui/src/boot.ts:142` — `await new Promise<void>(() => undefined)`
   parks forever; nothing resolves it on quit.
2. `packages/tui/src/app/fleet-service.ts` — `FleetService.close()` exists
   (:126-129) but **nothing calls it**; the WebSocket keeps the event loop
   alive.

**Fix:** On shell quit, close the FleetService and unblock the park. Find
where the Shell handles quit (`packages/tui/src/app/shell.ts`) and hook
cleanup there or via renderer destroy: call `fleetService.close()`, then
either resolve the parked promise (hold its resolver in a variable) or call
`process.exit(0)` after `renderer.destroy()`. Verify the Ctrl+C path too
(renderer created with `exitOnCtrlC: true`, boot.ts:44).

**Verify:** `tsc --noEmit`; `bun test`. Manual check (state in your report
that you ran it): start the TUI against a dead server URL, press `q` —
process must exit; same for Ctrl+C.

---

## LAMA-217 — Web UI polish: dead icons, brittle 401 (low)

**Problem:**

1. `packages/web-ui/src/components/icons.tsx` — `IconBackup` (:57) and
   `IconUpdate` (:95) are exported but imported nowhere (grep-verified).
2. `packages/web-ui/src/components/Login.tsx:27` —
   `err instanceof Error && err.message.includes("401")`.

**Fix:**

1. Delete both unused icon components (no usage exists — safe).
2. Check how `ApiError` is defined/exported in `packages/web-ui/src/api.ts`
   and replace with `err instanceof ApiError && err.status === 401`
   (import `ApiError` if not already).

**Verify:** `tsc --noEmit`; `bun run build:web-ui`; `bun test`.

---

## Suggested order

LAMA-211 → LAMA-215 → LAMA-217 → LAMA-213 (small, isolated) → LAMA-216 →
LAMA-182 (TUI runtime behavior) → LAMA-214 (largest, new page).

## Explicitly out of scope

- LAMA-227 (agent skill) — theorycraft/design only, no implementation yet.
- LAMA-176 — `in_review`, awaiting human review.
- LAMA-174 / LAMA-175 — backlog refactors, deliberately deferred.
