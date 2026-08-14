# Handoff — LAMA-239: per-host mount/sync override

**Date:** 2026-08-14
**Source:** Multica LAMA-239 ("Mount OR Sync remote folder"; status `backlog`).
The issue body is the contract; this doc grounds it in the current tree and locks
the decisions so you don't re-decide. If anything here conflicts with the issue
body, the issue wins — flag the drift in your PR notes.

**Status check (2026-08-14, verified against the tree):** not started. `folders`
has a single global `type` (`sync | mount | backup | dotfile | git`); every host
assigned to a folder inherits that type. There is no per-host override.
`folder_assignments` already carries mount-specific per-host fields
(`cache_profile`, `cache_max_size`, `mount_ignore_path`) but no mode selector.

## Mission

Let one folder be **synced on most hosts but only mounted on resource-constrained
ones** — a per-host `sync` vs `mount` override that falls back to the folder-level
type when unset. This is the "one real feature" deferred out of the LAMA-238/235/
241/232 batch.

## Maintainer decisions (locked — follow, do not re-decide)

1. **Data model = per-assignment `mode` column.** New `folder_assignments.mode`
   ∈ `"inherit" | "sync" | "mount"`, `NOT NULL DEFAULT 'inherit'`. No new table,
   no reuse of `type`.
2. **Effective type.** `effectiveType = mode === "inherit" ? folder.type : mode`,
   but the override is only honored when `folder.type` is `sync` or `mount`
   (there is no mount equivalent for `backup`/`dotfile`/`git` — those keep their
   folder type regardless of `mode`).
3. **`switchToMount`/`switchToSync` become per-host mode setters.** They set
   *this host's* `mode` (via `PATCH /folders/:folderId/assign/:hostId { mode }`)
   instead of the global folder type. The local lifecycle (final sync → trash →
   mount; stop mount → initial sync) is unchanged.
4. **Auto-reconcile on config refresh.** This is a new behavior and is required
   for a web-UI-set override to do anything: on every config refresh (and boot),
   the daemon must reconcile each assignment's effective type — start mounts for
   effective-`mount` hosts, stop mounts and rely on the cron scheduler for
   effective-`sync` hosts. (Today mounts are only ever started by an explicit
   switch/`--mount`; there is no auto-start — see `adoptExistingMountUnits`.)
5. **UI:** a Mode dropdown (Inherit / Sync / Mount) in the assignment editor,
   **and** a per-host effective-mode badge in the Folders view assignment rows.
6. **Existing behavior preserved for `inherit`.** Defaulting every existing
   assignment to `inherit` must reproduce today's behavior exactly (a `mount`
   folder stays mounted everywhere; a `sync` folder stays synced everywhere).

## Repo orientation (the retroactive look the issue asked for)

### Types — `packages/core/src/types.ts`

- `FolderType = "sync" | "mount" | "backup" | "dotfile" | "git"` (line ~5).
- `Folder` (line ~158) has `type: FolderType`.
- `FolderAssignment` (line ~211) has per-host fields: `folderId`, `hostId`,
  `role` (`source|target|both`), `localPath`, `syncExpr`, `enabled`, plus the
  already-mount-specific `cacheProfile`, `cacheMaxSize`, `mountIgnorePath`.
- `FilterMode = "sync" | "mount"` (line ~113) is an unrelated UI filter type —
  do **not** reuse it for the override; add a new `AssignmentMode`.

### Schema — `packages/core/src/db/schema.ts`

- `SERVER_SCHEMA` defines `folders` (with `type TEXT`) and `folder_assignments`.
- `MIGRATIONS` is an ordered array of `ALTER TABLE ... ADD COLUMN` statements.
  **Convention (AGENTS.md): every new column goes in BOTH `SERVER_SCHEMA` and
  `MIGRATIONS`** so existing databases get it.

### Server

- `packages/server/src/routes/config.ts` — `GET /config/:hostId`. Selects
  assignments with an explicit column list (`AssignmentRow`, ~line 38; row→type
  mapping ~line 98; SELECT ~line 478) and folders (`type`), then builds
  `rcloneConfig` (uses `folder.type` only in description strings) and returns
  `HostConfig { host, assignments, folders, manifests, rcloneConfig, peers }`.
- `packages/server/src/routes/folders.ts` — `POST /folders/:id/assign` (~669),
  `PATCH /folders/:id/assign/:hostId` (~800), `DELETE` (~829), plus 405
  handlers (~975/992). `PATCH /folders/:id` (~472) updates the folder (incl.
  `type`) — leave it.

### Daemon

- `packages/daemon/src/index.ts`:
  - `runOnce(assignment)` (~544) → `executeAssignment` in `executor.ts`.
  - `SwitchContext` (~94) and `setSwitchContext` (~846) — note
    `updateFolderType: (folderId, type) => client.updateFolder(folderId, { type })`
    (the global switch). Replace with a per-host `updateAssignmentMode`.
  - `switchToMount` (~228) / `switchToSync` (~302) — socket commands; guard on
    `folder.type`, do the local lifecycle, then `ctx.updateFolderType(...)`.
  - `systemdAwareStartMount` (~359) — writes `lamasync-mount-<folderId>.service`
    via `writeMountUnit`, `startMountUnit`, then `adoptMount`. Falls back to
    in-process when systemd is absent. `systemdAwareStopMount` (~412) is the stop
    counterpart.
  - `adoptExistingMountUnits` (~438) — on boot/refresh, re-adopts mount units
    that are **already active** (it does not start new ones; skips
    `role === "source"`).
  - `refreshConfig` (~486) — pulls config, `scheduler.refresh()`, then
    `adoptExistingMountUnits()`.
- `packages/daemon/src/executor.ts` — branches on `folder.type` everywhere:
  `filterMode = folder.type === "mount" ? "mount" : "sync"` (~382), the main
  switch (~391), disk-space guards (~455 sync/backup, ~464 mount cache),
  bisync-corruption recovery (~519, sync only), conflict handling (~561), and
  the operation-log `operation: folder.type` (~631).
- `packages/daemon/src/scheduler.ts` — cron scheduler keyed on `assignment.syncExpr`;
  resolves dotfile schedules from manifests; does not distinguish sync vs mount.

### Web UI

- `packages/web-ui/src/components/AssignmentEditor.tsx` — the per-host assignment
  form (syncExpr, localPath, commands, thresholds). No mode field today.
- `packages/web-ui/src/pages/Folders.tsx` — folders view with per-host
  assignment rows (host filter landed in LAMA-235).
- `packages/web-ui/src/api.ts` — API helpers for create/update assignment.

## Work breakdown (do in this order)

### Phase 0 — Core types + helper

1. Add `export type AssignmentMode = "inherit" | "sync" | "mount";` to
   `packages/core/src/types.ts`.
2. Add `mode: AssignmentMode;` to `FolderAssignment`.
3. New `packages/core/src/effective-type.ts`:
   ```ts
   import type { Folder, FolderAssignment, FolderType } from "./types.ts";
   export function effectiveFolderType(folder: Folder, assignment: FolderAssignment): FolderType {
     if (folder.type !== "sync" && folder.type !== "mount") return folder.type;
     return assignment.mode === "inherit" ? folder.type : assignment.mode;
   }
   ```
   Re-export it from `packages/core/src/index.ts`.

### Phase 1 — Schema

Add `mode TEXT NOT NULL DEFAULT 'inherit'` to the `folder_assignments` CREATE in
`SERVER_SCHEMA`, and `ALTER TABLE folder_assignments ADD COLUMN mode TEXT NOT NULL
DEFAULT 'inherit'` to the end of `MIGRATIONS` (in that order, both places — see
convention above).

### Phase 2 — Server

1. `routes/config.ts`: add `mode` to the `AssignmentRow` SELECT column list and
   the row→`FolderAssignment` mapping (default `"inherit"` when null, for rows
   written before the migration — belt-and-braces).
2. `routes/folders.ts`: accept `mode` in the create (`POST .../assign`) and
   update (`PATCH .../assign/:hostId`) Elysia schemas
   (`t.Optional(t.Union([t.Literal("inherit"), t.Literal("sync"), t.Literal("mount")]))`),
   default `"inherit"` on INSERT, and persist it on UPDATE.
3. `rcloneConfig` generation in `config.ts` uses `folder.type` in description
   strings only — optionally switch to the effective type for accuracy; not
   required for correctness. Keep it minimal.

### Phase 3 — Daemon (the bulk)

1. **Plumb the effective type into the executor.** In `runOnce`, after resolving
   `folder`, compute `const effective = effectiveFolderType(folder, assignment)`
   and pass a shallow clone `{ ...folder, type: effective }` to
   `executeAssignment` (least-invasive — keeps every `folder.type` branch working
   and the operation log reporting the *effective* type). Do the same anywhere
   else that calls into the executor with a folder.
2. **Scheduler:** skip scheduling assignments whose effective type is `mount`
   (mounts are persistent, not cron). Either filter in `Scheduler.schedule`, or
   resolve effective type in `effectiveSchedule` and return null for mounts. Keep
   sync/backup/dotfile scheduling exactly as today.
3. **Reconcile on refresh/boot.** Add a reconcile pass called from
   `refreshConfig` (replacing/augmenting `adoptExistingMountUnits`):
   - effective `mount` and `role !== "source"` → if `isMountUnitActive` is false,
     start it via `systemdAwareStartMount` (write+start+adopt). If active, adopt
     it (existing path).
   - effective anything-else → if a mount unit is active for that folder, stop it
     (`systemdAwareStopMount`) so a host flipped back to sync doesn't keep a stale
     mount; the cron scheduler then drives syncs.
   - Keep the "skip when systemd unavailable → in-process" fallback behavior.
4. **`switchToMount` / `switchToSync` become per-host:**
   - Guard on the *effective* type instead of `folder.type`.
   - Replace the final `ctx.updateFolderType(folderId, "mount")` with
     `ctx.updateAssignmentMode(folderId, hostId, "mount")` (and `"sync"`).
   - In `SwitchContext`, replace `updateFolderType` with
     `updateAssignmentMode: (folderId, hostId, mode) => client.updateAssignment(folderId, hostId, { mode })`
     (that method already exists on the API client).
   - Update the switch-to-sync flow: after stopping the mount and doing the
     initial sync, set this host's mode to `"sync"` (not the global type).
   - The switch commands need the host id — it's already in scope (`hostId` in
     `main()`); thread it into `SwitchContext`.

### Phase 4 — Web UI

1. `AssignmentEditor.tsx`: add a Mode `<select>` (Inherit / Sync / Mount) bound
   to `assignment.mode` (default Inherit), include `mode` in the save payload.
   Only render it when the folder's `type` is `sync` or `mount`.
2. `Folders.tsx`: in each assignment row, show an effective-mode badge
   (`sync` / `mount` / `inherit`), computed with `effectiveFolderType`.
3. `web-ui/src/api.ts`: thread `mode` through create/update assignment calls.

### Phase 5 — Tests

- Core: `effectiveFolderType` unit tests (inherit, sync→mount override, mount→sync
  override, non-sync/mount types ignore the override).
- Server: config SELECT returns `mode`; assign create defaults to `inherit`;
  update persists `mode`. (Extend existing `config.test.ts` / folder route tests.)
- Daemon: scheduler skips effective-mount; reconcile starts/stops mounts (stub
  the systemd/mount helpers as the existing `socket.test.ts`/mount tests do).
- UI: keep it light (the web-ui tests are integration-y); manual check below.

## Done when

- `bun x tsc --noEmit` clean.
- `bun test` green (562 pass + your new tests; 1 pre-existing skip).
- Manual verification below passes.
- No behavior change for `inherit` (default) assignments.

## Manual verification

With a local dev server (`LAMASYNC_API_KEY=dev-key LAMASYNC_DATA_DIR=/tmp/... bun run dev:server`):

1. Create a `sync` folder, assign it to a host, set the host's override to
   `mount` in the editor → after the config refresh the daemon starts a
   `lamasync-mount-<folderId>` unit; the Folders view shows a `mount` badge.
2. Flip the same host back to `inherit` → daemon stops the mount unit and the
   scheduler resumes cron syncs.
3. TUI/socket `switch_to_mount` → sets that host's `mode=mount` (verify via
   `GET /folders/:id/assignments`) instead of changing `folder.type` globally.
4. A `backup`/`dotfile` folder shows no Mode dropdown and is unaffected by any
   `mode` value.

## Out of scope (do not do)

- No changes to `folder.type` semantics or the folder-level PATCH.
- No auto-mount for `role === "source"` assignments (unchanged).
- No new folder types; no per-host override for `backup`/`dotfile`/`git`.
- No WebSocket protocol changes.
