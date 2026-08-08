# Handoff — Wire up hidden API power (web first)

**Date:** 2026-08-08
**Source:** UX audit at `.memsearch/memory/2026-08-08-webui-tui-ux-audit.md`
(read it first if you need the "why"; this document is sufficient on its own).

## Mission

LamaSync's server API exposes far more power than its UIs let users reach.
This task wires the most valuable of those hidden capabilities into the web UI
(`packages/web-ui`, a React SPA embedded in the server binary), with one small
daemon change to enable dry-run syncs. Everything except Phase F is UI-only or
thin plumbing — the server routes already exist.

## Maintainer decisions (follow these, do not re-decide)

- **Web UI first.** The TUI is explicitly out of scope for this task.
- **Dry-run gets wired up** as a real feature (executor plumbing already exists
  in `packages/daemon/src/executor.ts`).
- **Backend kinds `local` / `nfs` / `restic` get implemented** (not hidden) with
  these semantics — they are named connection targets the server can rclone
  against, reusable across folders (mirroring how S3 backends work today):
  - `local` — a server-side directory path (rclone `type = local`), e.g. an
    attached disk; usable as a folder target and Data Browser root.
  - `nfs` — an NFS export already mounted on the server; store the mount path
    (rclone also sees it as `local`, but the kind documents provenance).
    Fields: path (+ optional server/export label for display).
  - `restic` — a restic repository: `repository` string (local path or
    `s3:endpoint/bucket`) + `password` (encrypted at rest via the existing
    `packages/server/src/crypto.ts`, like the S3 secret). Centralizes the
    per-assignment `resticRepository`/`resticPassword` pair; per-assignment
    overrides keep working, the backend is the default.

## Repo orientation

Bun workspace, TypeScript everywhere:

- `packages/core` — shared types (`src/types.ts`, the single source of truth),
  DB schema (`src/db/schema.ts`), API client
- `packages/server` — Elysia REST + WebSocket, routes in `src/routes/*.ts`
- `packages/daemon` — client sync daemon (heartbeat, rclone executor,
  queued-action dispatcher)
- `packages/web-ui` — React SPA; pages in `src/pages/*.tsx`, browser API client
  in `src/api.ts`, shared components in `src/components/`
- `packages/tui` — terminal UI (out of scope here)

### Conventions you must obey

- **Imports use `.ts` extensions** — `import { foo } from "./bar.ts"`.
- **Shared types live in `packages/core/src/types.ts`.** Add new wire/DB shapes
  there, not locally.
- **No `any` or inline casts** — use `unknown` with `in`/`typeof` narrowing and
  real type guards.
- **DB columns go in BOTH `SERVER_SCHEMA` and the `MIGRATIONS` array** in
  `packages/core/src/db/schema.ts` — required for existing databases.
- **Secrets never cross the API boundary.** Follow the existing pattern:
  ciphertext stays server-side, the wire shape carries `hasSecret: boolean`
  (add `hasResticPassword` the same way).
- Tests use `bun:test` as `*.test.ts` alongside source.
- No `console.log` in library code.
- Make minimal changes. Do not refactor, rename, or reformat surrounding code.

### Verification commands

```bash
bun install                      # if needed
bun run build:web-ui && bun test # tests FAIL without the web UI dist first
bun x tsc --noEmit               # type check
```

## Execution protocol

1. Implement the phases in order A → H. Each phase ends with a **"Done when"**
   condition — check it before moving on.
2. After EACH phase (not just at the end), run `bun x tsc --noEmit` and the
   relevant tests. Keep the tree green.
3. Do NOT run any git mutations (no commit/push/reset). Leave the working tree
   dirty for the maintainer to review.
4. When all phases are done: update `docs/features.md` with new rows and append
   a short "done" note (date + what shipped) to the bottom of
   `.memsearch/memory/2026-08-08-webui-tui-ux-audit.md`.

---

## Phase A — Web API client additions (`packages/web-ui/src/api.ts`)

Add typed helpers to the `api` object (mirror the existing style):

- `deleteHost(hostId)` → `DELETE /hosts/:hostId` (route exists,
  `packages/server/src/routes/hosts.ts:361`, cascades assignments/manifests)
- `updateAssignment(folderId, hostId, body)` →
  `PATCH /folders/:id/assign/:hostId` (route exists,
  `packages/server/src/routes/folders.ts:736`; accepts `enabled`, `role`,
  `localPath`, `syncExpr`, `conflictStrategy`, `timeoutSec`, `maxRetries`,
  `availableSpaceThreshold`, `preSyncCmd`, `postSyncCmd`, `bandwidthSchedule`,
  `cacheProfile`)
- `listDotfileVersions(appName)` → `GET /dotfiles/:appName`
  (`routes/dotfiles.ts:366`)
- `deleteDotfileVersion(appName, version)` →
  `DELETE /dotfiles/:appName/:version` (`routes/dotfiles.ts:507`)
- `downloadDotfileVersion(appName, version)` →
  `GET /dotfiles/:appName/:version` (`routes/dotfiles.ts:471`) — returns a
  tarball, so this needs a blob fetch with the auth header (extend `apiFetch`
  or write a dedicated helper), then object-URL + `<a download>` click. A plain
  `<a href>` will NOT send the `Authorization` header.
- `listLocks()` → `GET /operations/locks` (`routes/operations.ts:300`); read
  the route first, and add a row type to `packages/core/src/types.ts` if none
  exists.
- `enqueueAction` already accepts an arbitrary `payload` record — no change
  needed for per-folder sync / dry-run.

**Done when:** `bun x tsc --noEmit` passes with the new helpers unused-but-typed.

## Phase B — Per-folder "Sync now" + dry-run

Daemon plumbing (dry-run only; per-folder sync already works via
`payload.folderId`):

1. `packages/daemon/src/index.ts:535` — extend
   `runOnce(assignment)` to `runOnce(assignment, opts?: { dryRun?: boolean })`
   and pass `dryRun: opts?.dryRun` into the `executeAssignment({...})` call
   (`:582`).
2. `packages/daemon/src/index.ts:676-709` — in the `trigger_sync` action case,
   read `const dryRun = payload["dryRun"] === true;` and pass it to `runOnce`;
   prefix the ack summary with `dry-run: ` when set so the Operations log shows
   it.
3. `packages/daemon/src/actions.ts` — extend the comment block documenting
   `payload.folderId` to also document `payload.dryRun`.
   (`selectAssignmentsForSyncAction` itself needs no change.)
4. Add a unit test (existing `actions.test.ts` style, alongside source) that
   the dry-run flag reaches the executor invocation.

Web UI:

5. `packages/web-ui/src/pages/Folders.tsx` — in the assignments cell, add a
   small "Sync now" button per assignment →
   `api.enqueueAction(hostId, { type: "trigger_sync", payload: { folderId } })`;
   show a transient note "queued — runs on the daemon within ~30 s".
6. `packages/web-ui/src/pages/HostDetail.tsx` — add per-assignment-row
   "Sync now" and "Dry run" buttons in the assigned-folders table (payloads
   `{ folderId }` and `{ folderId, dryRun: true }`), and **remove the fake
   `[S] [B] [U] [R]` hotkey hints** (`HostDetail.tsx:26-31`) — no keyboard
   handler exists.

**Done when:** typecheck green; dry-run unit test passes; both pages compile
and the buttons enqueue actions (verify by reading the network call shapes).

## Phase C — Assignment editing (pause/resume, schedule, conflict strategy)

7. Create `packages/web-ui/src/components/AssignmentEditor.tsx`: an inline
   panel/modal editing one assignment — `localPath`, `role`
   (source/target/both with one-line explanations), `syncExpr` (cron text +
   reuse the schedule-preset pattern from the Dotfiles page), `conflictStrategy`
   (newer_wins/source_wins/keep_both/manual with a one-line consequence each —
   this is the first user-facing explanation of the concept), plus a collapsed
   "Advanced" section (`timeoutSec`, `maxRetries`, `availableSpaceThreshold`,
   `preSyncCmd`, `postSyncCmd`, `bandwidthSchedule`). Saves via
   `api.updateAssignment`.
8. `packages/web-ui/src/pages/HostDetail.tsx` — the `enabled` badge becomes a
   toggle button ("Pause" / "Resume") calling
   `api.updateAssignment(folderId, hostId, { enabled: !a.enabled })`; add an
   "Edit" button per assignment row opening `AssignmentEditor`.
9. `packages/web-ui/src/pages/Folders.tsx` — same edit entry point from the
   assignments column, reusing `AssignmentEditor`.

**While implementing, verify** which fields `PATCH /folders/:id/assign/:hostId`
actually accepts (`packages/server/src/routes/folders.ts:736`) and drop any
rejected field from the form — do not add server fields unless one is missing
that the audit lists as accepted.

**Done when:** pause/resume round-trips (badge flips after save), the editor
saves each field group, typecheck green.

## Phase D — Host delete / decommission

10. `packages/web-ui/src/pages/Hosts.tsx` and `HostDetail.tsx` — "Delete host"
    button with `confirm()` spelling out the cascade ("removes assignments,
    manifests, and history — stop/uninstall the daemon on that machine too").
    On success navigate to the hosts list.

**Done when:** delete calls `DELETE /hosts/:hostId`, handles 404/error text,
and the list no longer shows the host.

## Phase E — Dotfile versions on web

11. Read `GET /dotfiles/:appName` in `routes/dotfiles.ts:366` for the response
    shape; add a `DotfileVersion` type to `packages/core/src/types.ts` if none
    exists.
12. `packages/web-ui/src/pages/Dotfiles.tsx` — expandable row per manifest app
    listing versions (version id, createdAt, uploader); per-version "Download"
    (blob helper from Phase A) and "Delete" (confirm). Add one hint line that
    selective restore lives in the TUI (`lamasync tui → Dotfiles`).

**Done when:** versions list, download produces a non-empty tarball file,
delete removes the row after confirm; typecheck green.

## Phase F — Implement backend kinds `local` / `nfs` / `restic`

The only schema/rclone-heavy phase. Semantics per "Maintainer decisions" above.

13. Schema: add `local_path TEXT`, `restic_repository TEXT`,
    `restic_password_enc TEXT` to `backends` — in **both** `SERVER_SCHEMA` and
    `MIGRATIONS` (`packages/core/src/db/schema.ts`).
14. Core types (`packages/core/src/types.ts`): extend `Backend` with
    `localPath?: string | null`, `resticRepository?: string | null`,
    `hasResticPassword?: boolean` (secret never crosses the API — same pattern
    as `hasSecret`).
15. `packages/server/src/backends.ts` — extend `BackendRow`, `BACKEND_SELECT`,
    `rowToBackend`; add resolve helpers analogous to `resolveFolderS3Config`
    as consumers need them.
16. `packages/server/src/routes/backends.ts` — per-kind validation on
    create/PATCH: `local`/`nfs` require a non-empty absolute path (starts with
    `/`); `restic` requires repository + password on create. Store the new
    fields (encrypt the restic password via `crypto.ts`). Extend `POST
    /backends/:id/test` to all kinds: `local`/`nfs` → `rclone lsd` against the
    path (or a readability check); `restic` → `restic snapshots --json` with
    the password passed via env (`RESTIC_PASSWORD`), never on the command line.
17. `packages/server/src/routes/config.ts` — rclone config generation: folders
    referencing a `local`/`nfs` backend get a `type = local` remote rooted at
    the backend path (folder sub-path as today for buckets); restic backends
    wire into the existing restic execution path as the default
    `resticRepository`/`resticPassword` when the assignment doesn't override.
    The existing config-revision bump on backend PATCH carries changes to
    daemons — don't add a new mechanism.
18. `packages/web-ui/src/pages/Backends.tsx` — replace the dead "reserved for
    future use" branch (`:282-285`) with real per-kind fields (path for
    local/nfs; repository + password with mask/reveal for restic), a one-line
    explanation per kind, and enable the Test button for all kinds.
19. `packages/web-ui/src/pages/Folders.tsx` — backend picker: allow choosing
    local/nfs backends for sync/backup folders (sub-path field where the S3
    bucket field is today).
20. Optional (only if small): make local/nfs backends selectable roots in the
    Data Browser (`packages/server/src/browse-paths.ts`). Otherwise skip and
    note it in the completion note.

**Done when:** new columns exist in a fresh AND migrated DB (both
`SERVER_SCHEMA` and `MIGRATIONS`), create/edit/test round-trips work per kind
from the UI, typecheck + `bun test` green, and a unit test covers the per-kind
validation (existing `*.test.ts` style).

## Phase G — Conflicts history + locks panel

21. `packages/web-ui/src/pages/Conflicts.tsx` — status tabs
    (Pending / Resolved / All) using the existing `listConflicts(status)` param
    (currently hardcoded `"pending"` at `:20`); render host/folder IDs as names
    with links to HostDetail/Folders (resolve from already-fetched hosts and
    folders lists).
22. `packages/web-ui/src/pages/Operations.tsx` — a small "Active locks" panel
    at the top via `api.listLocks()` (folder, host, acquired-at), read-only;
    while on the page, also add the `hostId` filter dropdown (the API already
    supports it).

**Done when:** resolved conflicts are visible with a resolution record; locks
panel renders (empty state fine); host filter narrows the log; typecheck green.

## Phase H — Verification & docs

23. Full gate: `bun run build:web-ui && bun test` and `bun x tsc --noEmit` —
    both green.
24. Update `docs/features.md`: new rows for per-folder sync/dry-run UI,
    assignment editing, host delete UI, dotfile versions on web, backend kinds
    local/nfs/restic, conflicts history + locks panel.
25. Append a short dated "done" note to
    `.memsearch/memory/2026-08-08-webui-tui-ux-audit.md` listing what shipped.

**Done when:** the gate is green and both docs are updated.

---

## Known pitfalls

- `bun test` fails without `bun run build:web-ui` first (web dist is embedded).
- The assignment PATCH route's accepted fields must be verified while
  implementing Phase C; drop rejected fields from the form.
- Dotfile version download needs an auth-header blob fetch, not a plain link.
- Per-folder sync from Folders.tsx: the server 404s if the folder isn't
  assigned to that host — surface the error text; don't pre-filter in the UI.
- Dry-run reports land in operation_log as normal successes; the `dry-run: `
  ack prefix is the only marker (deliberately minimal).
- Native `confirm()`/`prompt()` is the current house style on most pages —
  match it; don't introduce a modal framework.
- Don't restyle pages or touch `index.css` beyond what a control needs — the
  visual redesign is a separate later workstream.

## Out of scope (do not drift into these)

- Onboarding/glossary/empty-states pass, login hint, first-run checklist
- All TUI work (first-run setup, `?` overlay, `friendlyError`,
  `fleetService.start()` fix)
- Restic restore UI, DataBrowser download/delete/multipart upload
- Per-folder sync history (needs a server-side Operations `folderId` filter)
- Daemon self-update action, server info/release block on Admin
- Visual redesign of the web UI
