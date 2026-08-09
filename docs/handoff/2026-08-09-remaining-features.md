# Workstream 4 handoff — Remaining features (server + web UI)

**Date:** 2026-08-09
**Audience:** executing model (DeepSeek). Self-contained: no prior conversation context required.
**Mission:** Ship the remaining feature gaps from the August UX audit — restic
restore UI, DataBrowser delete/download, per-folder sync history, Admin
server-info block, confirm-dialog unification, and a validation/error sweep.
Unlike workstreams 1–3, this one includes **server-side route work**, not just UI.

---

## Maintainer decisions (already made — do not re-decide)

1. **Per-folder sync history is UI-only.** `GET /api/v1/operations` already
   accepts a `folderId` query param (`packages/server/src/routes/operations.ts:85-88,123`).
   Do not add server filtering; wire the UI to it.
2. **Download mirrors upload's existing shape**: base64 JSON payload, same
   64 MiB cap the server already enforces on upload. Consistency beats
   elegance; streaming/multipart is explicitly deferred.
3. **Delete is job-based**, following the existing copy/move pattern
   (`/browse/copy`, `/browse/move` → `browse-jobs.ts` job model + JobsPanel).
   No synchronous delete endpoint.
4. **Server info goes into the existing `GET /api/v1/health` route** (add
   `serverVersion`, `dbSizeBytes`) — no new endpoint. Latest-release info is
   already proxied at `GET /api/v1/release/latest`
   (`packages/server/src/routes/release.ts:9`) and just needs a web-ui caller.
5. **Restic restore scope: whole-snapshot restore with optional `include`
   patterns.** No browsing inside a snapshot (no such server route exists;
   building one is out of scope).
6. **Extract one shared Modal/ConfirmDialog/PromptDialog component** in
   `packages/web-ui/src/components/`, derived from the inline modal markup
   already in `packages/web-ui/src/pages/DataBrowser.tsx:286-318`
   (`.modal-backdrop` / `.modal` / `.modal-actions` CSS exists). All
   `window.prompt` / `window.confirm` calls in the web UI get replaced with it.
7. **Daemon self-update action is DEFERRED** — it needs a new server
   `QueuedActionType` plus a daemon handler. It is its own future workstream,
   not part of this one.
8. **No DB schema changes are expected.** If one turns out to be genuinely
   required, the column goes in BOTH `SERVER_SCHEMA` and the `MIGRATIONS`
   array, and you stop and flag it in your summary.
9. **No TUI changes in this workstream.** TUI foundations shipped in WS3.

---

## Repo orientation

Bun workspace, TypeScript, `.ts` import extensions required.

- Server routes: `packages/server/src/routes/*.ts` — flat, one Elysia plugin
  per file, `prefix: "/api/v1"`, Swagger `detail` block on every route, tests
  alongside as `*.test.ts`.
- Browse routes: `packages/server/src/routes/browse.ts` — existing ops:
  `/browse/local`, `/browse/s3`, `/browse/restic`, `/browse/jobs` (GET) and
  `/browse/copy`, `/browse/move`, `/browse/rename`, `/browse/mkdir`,
  `/browse/upload` (POST). Job machinery lives in `browse-jobs.ts`.
- Restic routes: `packages/server/src/routes/restic.ts` — restore endpoints
  already exist and are fully functional: `GET /restic/restore` (list jobs,
  line 191), `POST /restic/restore` (create, line 231),
  `POST /restic/restore/:id/status` (daemon ack, line 282). The daemon already
  polls and executes restore jobs (`packages/daemon/src/index.ts:167-209`) and
  the server broadcasts a `restic_restore` WS event. **Zero UI callers exist.**
- Web UI: `packages/web-ui/src/` — `api.ts` (all server calls), `pages/`
  (Dashboard, Folders, HostDetail, Backends, DataBrowser, Operations, Admin,
  Dotfiles, Conflicts), `components/` (shared: Hint, GettingStarted,
  EditableHostname, AddHostGuide, icons…).
- Shared wire/DB types: `packages/core/src/types.ts` — single source of truth.
  `ResticRestoreJob` type already exists there (status:
  `pending|running|done|failed`).
- Server DB handle: `packages/server/src/db.ts` (find the DB file path here
  for the `dbSizeBytes` stat).

### Current tree state

Workstreams 1–2 are committed. Workstream 3 (TUI) changes may be **present
but uncommitted** in the working tree — they are maintainer-approved; build on
top of them and do not revert, reformat, or commit them. Leave your own
changes uncommitted too; the maintainer reviews and commits.

---

## Conventions (violations = rework)

- Imports use `.ts` extensions: `import { foo } from "./bar.ts"`.
- No `any`, no inline casts — `unknown` + `typeof`/`in` narrowing.
- No `console.log` in library code.
- New shared types go in `packages/core/src/types.ts`, re-exported from the
  package `src/index.ts` barrel.
- Every server route gets a Swagger `detail` block and a `*.test.ts` beside it
  (follow `browse.test.ts` / `restic.test.ts` style).
- Every async UI handler try/catches into the page's `setError`.
- Error envelopes: server errors return `{ error: string }`; UI must parse
  that field, not show raw `API error 500: {...}` blobs.
- Reuse existing CSS classes/patterns before inventing new ones.

---

## Verification (run before claiming done)

```bash
bun x tsc --noEmit          # must be clean
bun run build:web-ui        # bun test fails without this
bun test                    # baseline: 440 pass / 1 skip / 0 fail (+ WS3 tests)
```

Baseline is 440 passing, 1 pre-existing skip, 0 fail. Your new route tests add
to that count. Do not replace or weaken existing tests — additive only.

Manual smoke (recommended, not a substitute for tests):

```bash
LAMASYNC_API_KEY=dev-key \
LAMASYNC_DATA_DIR=/tmp/lamasync-test \
LAMASYNC_BACKUP_DIR=/tmp/lamasync-test-backups \
  bun run dev:server
```

---

## Execution protocol

- Work phase by phase, in order. Each phase has a "Done when" gate — do not
  start the next phase until the gate passes (including tsc + tests).
- Phases are independent by design; if you get stuck on one for more than a
  reasonable effort, skip it, finish the rest, and flag it clearly.
- When done: report per phase — what changed (files), test results, anything
  skipped or deviating from this doc and why.

## Lessons from previous reviews (learn from these)

- Never replace existing tests; extend them.
- Keep JSDoc comments attached to the function they describe when editing.
- Entity state keys on ids, never on display names.
- Reuse existing CSS patterns before adding new classes.
- Every async handler try/catches into the page's `setError`.
- Verify the exact fields a route accepts/returns while implementing — read
  the route file, don't assume from the type name.

---

## Phase 1 — Per-folder sync history (UI-only, quick win)

Server support exists (`operations.ts:85-88`). Wire it up:

1. `packages/web-ui/src/api.ts` — verify `listOperations` (around line 272)
   forwards a `folderId` param; add it if missing.
2. `pages/Operations.tsx` — add a folder filter dropdown next to the existing
   host filter (folders from `api.listFolders()`), and read `?folderId=` /
   `?hostId=` from the URL on mount to preselect filters (so links land
   pre-filtered).
3. `pages/Folders.tsx` — add a "History" link/button per folder row navigating
   to `/operations?folderId=<id>`. Same for the folder rows on
   `pages/HostDetail.tsx` if it lists folders.

**Done when:** clicking History on a folder row lands on Operations showing
only that folder's operations; the filter dropdown reflects it; tsc + tests
green.

## Phase 2 — Restic restore UI (web UI)

Backend is complete (see Repo orientation). Build the UI:

1. `api.ts` — add `listResticRestoreJobs()` → `GET /restic/restore`, and
   `createResticRestore(...)` → `POST /restic/restore`. Read
   `packages/server/src/routes/restic.ts:231-280` for the exact body fields
   (snapshot_id, folder_id, target_host_id, target_path, include) and use the
   existing `ResticRestoreJob` type from core.
2. `pages/DataBrowser.tsx`, restic tab — each snapshot row gets a
   **Restore…** button opening a modal (shared component from Phase 5 if
   done, inline `.modal` markup otherwise): target host (dropdown of online
   hosts from health), target path (text input), optional include patterns
   (textarea, one per line). Submit → create job → refresh job list.
3. Below the snapshot list, a **Restore jobs** panel listing jobs with
   status (`pending|running|done|failed`), target host/path, and error text
   when failed. Poll on mount and after creating; if the app already consumes
   WS events centrally, hook `restic_restore` — otherwise simple polling is
   fine.
4. Empty/error states: no snapshots → hint text; failed restore → error shown
   in the panel.

**Done when:** full create-and-watch flow renders correctly against the dev
server; failures surface the server error message; tsc + tests green.

## Phase 3 — DataBrowser delete (server + UI)

1. Server: add `POST /browse/delete` in `packages/server/src/routes/browse.ts`,
   job-based like copy/move. Body: `{ ref: BrowseRef, names: string[] }`.
   Read how `/browse/copy` constructs its rclone job in `browse.ts` +
   `browse-jobs.ts` and mirror it (rclone `deletefile` for files, `purge` for
   directories — verify what the copy/move ops use as their command template).
   Swagger detail block required.
2. Tests: extend `browse.test.ts` style — route validation, job creation,
   error paths.
3. UI: Delete button in DataBrowser (respects current selection), confirm via
   dialog listing the names to be deleted, then job appears in the existing
   JobsPanel.

**Done when:** new route tests pass; delete works on local refs via dev
server; confirmation is mandatory; tsc + full suite green.

## Phase 4 — DataBrowser download (server + UI)

1. Server: add `POST /browse/download` (body `{ ref, name }`) returning the
   file content base64-encoded, mirroring `/browse/upload`'s shape and
   enforcing the same 64 MiB cap — over the cap returns the standard
   `{ error }` envelope with the size in the message. Read `browse.ts:480+`
   (upload) first and match its approach (local refs read directly, s3 via
   rclone).
2. Tests alongside, including the over-cap path.
3. UI: per-file Download button (disabled for directories); decode base64 →
   Blob → trigger browser save.

**Done when:** upload→download round-trip preserves bytes on a local ref;
over-cap shows the friendly error; tsc + full suite green.

## Phase 5 — Confirm/prompt unification

1. Extract the inline modal from `DataBrowser.tsx:286-318` into
   `packages/web-ui/src/components/Modal.tsx` exporting `Modal`,
   `ConfirmDialog`, and `PromptDialog` (styled input + OK/Cancel). Reuse the
   existing `.modal-backdrop`/`.modal`/`.modal-actions` CSS.
2. Replace every `window.prompt` / `window.confirm` in the web UI. Known
   instances: DataBrowser rename (line ~420) and mkdir (~430), Admin channel
   delete (~223). Grep to catch the rest.
3. Add missing confirmations for destructive/unconfirmed actions:
   - Admin operations prune (`Admin.tsx:101-115` fires immediately) →
     ConfirmDialog stating how many days' worth of operations will be deleted.
   - DataBrowser move/upload when a same-named entry exists at destination →
     overwrite ConfirmDialog.

**Done when:** `grep -r "window.prompt\|window.confirm" packages/web-ui/src`
returns nothing; all listed actions confirm via the styled dialog; DataBrowser
uses the shared component; tsc + tests green.

## Phase 6 — Admin server-info block

1. Server: extend `GET /health` (`packages/server/src/routes/health.ts`) with
   `serverVersion` (from `@lamasync/core` version export) and `dbSizeBytes`
   (`fs.statSync` on the DB file — find its path in `packages/server/src/db.ts`).
   Update `health.test.ts`.
2. `api.ts` — add a caller for `GET /release/latest` (read
   `packages/server/src/routes/release.ts` for the response shape) and extend
   the health type.
3. `pages/Admin.tsx` — a "Server" block showing: server version, DB size
   (human-formatted), latest available release, and an "update available"
   badge when the latest is newer (reuse the `isNewer` comparison pattern
   from `health.ts:18-21` / hosts page).

**Done when:** block renders real data from the dev server; badge logic
matches the hosts page; health tests updated and green.

## Phase 7 — Validation & error-envelope sweep

1. **Cron validation on Folders assign form** (`Folders.tsx:530` "Schedule
   (cron, optional)") — Dotfiles already has presets + validation; port the
   same pattern (inline error on invalid cron, presets if Dotfiles has them
   there).
2. **Backends form** — add URL/bucket/path validation where missing (empty
   bucket, malformed URL, etc.).
3. **Error envelopes** — only Backends and EditableHostname currently parse
   `{error}` from failed responses; other pages show raw `API error 500:
   {...}`. Make envelope parsing consistent everywhere; if the same parse
   logic appears 3+ times, extract one helper in `api.ts`.

**Done when:** invalid cron on Folders shows an inline message (no server
round-trip); a forced server error (e.g. stop the daemon, try an action)
shows the clean server message on every page tried; tsc + tests green.

## Phase 8 — Small leftovers

1. **Dashboard storage-report failure is silently swallowed**
   (`Dashboard.tsx:~172`) — surface it as an inline error/hint.
2. **Login "remember me"** — API key currently lives in sessionStorage only
   (new tab = re-login). Add a checkbox on the Login component: checked →
   localStorage, unchecked → sessionStorage. Check both on load.
3. **Sync-note shows raw IDs** (cosmetic) — resolve host/folder ids to
   display names where the note renders. If this turns out to be more than a
   small change, skip it and flag.

**Done when:** each item verifiably works or is explicitly flagged as
skipped; tsc + full suite green.

---

## Pitfalls

- **`bun test` fails without `bun run build:web-ui` first** — always build
  the web UI before running the suite.
- The restic restore **server** flow already works end-to-end with the
  daemon; Phase 2 is purely a UI client. Do not modify the restore routes.
- `GET /operations?folderId=` already works — Phase 1 touches no server code.
- Keep the 64 MiB upload/download cap symmetric; the error must name the
  limit.
- The working tree may contain uncommitted WS3 TUI changes — leave them
  alone.
- Repo uses LAMA-### issue tags in comments/docs; this program isn't one —
  reference "UX workstream 4" instead.

## Out of scope (explicitly)

- Daemon self-update action (needs server `QueuedActionType` + daemon
  handler — future workstream).
- Browsing files inside a restic snapshot.
- Streaming/multipart upload or download.
- Any TUI changes (WS3 shipped).
- Visual redesign / theme work (WS5).
- `docs/status.md` / `docs/features.md` updates — the maintainer handles
  docs on review.

## Open design question (for maintainer, non-blocking)

`local`/`nfs` backends emit server-side paths into each client's rclone
config, so the path must exist at the same location on every assigned host.
If the maintainer has confirmed the intended deployment story, copy around
this may change in WS5 — proceed as-is for now.
