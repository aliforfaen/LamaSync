# Handoff — Command Center v1, Batch 3 (LAMA-198)

**Audience:** implementing agent. Read `AGENTS.md` at the repo root first
(conventions), then `docs/handoff/command-center-batch1.md` §"Ground rules"
(the same rules apply). This batch spans **core + server + daemon + web-ui**.
The design was agreed on LAMA-198 (Multica comment 2026-08-01) — implement it
as written there; this document is the same design with file-level detail.

**Epic:** LAMA-183. Batches 1–2 (LAMA-199 version visibility, LAMA-201 themes,
LAMA-197 Command Center) are merged. You build on: `Host.version` +
`Host.updateAvailable` (LAMA-199), the theme tokens + icons (LAMA-201), the
Command Center landing page (LAMA-197).

## Ground rules (violating these = failed review)

- Imports use `.ts` extensions: `import { foo } from "./bar.ts"`.
- No `any`, no inline casts. `unknown` + `typeof`/`in` narrowing.
- **DB columns/tables go in BOTH `SERVER_SCHEMA` and the `MIGRATIONS` array**
  (`packages/core/src/db/schema.ts`).
- Every new/changed route keeps its Swagger `detail` block (summary, tags,
  responses).
- Shared wire/DB types live in `packages/core/src/types.ts` — server routes,
  the core API client, and the web UI all reference them.
- Tests: `bun:test`, `*.test.ts` alongside source.
- **Do NOT touch `packages/tui`.**
- If an endpoint's request/response shape changes, update the endpoint table
  in `packages/agent-skill/lamasync-server.md`.
- Keep changes minimal and scoped; no drive-by refactors.
- **Do NOT commit. Do NOT run git commands that mutate state.**

## Verify-before-done (all must pass)

```bash
bun x tsc --noEmit
bun run build:web-ui
bun test
```

## Part 1 — Core: types + schema + API client

1. **`packages/core/src/types.ts`**
   - `export type QueuedActionType = "trigger_sync" | "trigger_backup" |
     "check_update" | "refresh_config";`
   - `export type QueuedActionStatus = "pending" | "taken" | "done" | "failed";`
   - `export interface QueuedAction { id: string; hostId: string; type:
     QueuedActionType; payload: Record<string, unknown> | null; status:
     QueuedActionStatus; createdAt: number; takenAt?: number | null;
     completedAt?: number | null; result?: string | null; }`
   - `Host`: add `configRevision?: number | null;`
   - `WSEvent`: add `| { kind: "action"; action: QueuedAction }`
2. **`packages/core/src/db/schema.ts`**
   - `SERVER_SCHEMA`: add `queued_actions` table (see design; `payload TEXT`,
     status default `'pending'`, `created_at INTEGER NOT NULL`) + index on
     `(host_id, status)`; add `config_revision INTEGER DEFAULT 0` to `hosts`.
   - `MIGRATIONS`: append `CREATE TABLE IF NOT EXISTS queued_actions (...)`
     (same DDL) + `ALTER TABLE hosts ADD COLUMN config_revision INTEGER
     DEFAULT 0`.
3. **`packages/core/src/api-client.ts`** — add methods (daemon + tests use
   these):
   - `listHosts(): Promise<Host[]>`
   - `getHost(hostId): Promise<Host>`
   - `listPendingActions(hostId, limit?): Promise<QueuedAction[]>` → GET
     `/api/v1/actions/pending?hostId=…`
   - `completeAction(id, body: {status: "done"|"failed"; result?: string}):
     Promise<void>` → POST `/api/v1/actions/:id/complete`
   - `enqueueAction(hostId, body: {type: QueuedActionType; payload?}):
     Promise<QueuedAction>` → POST `/api/v1/hosts/:hostId/actions`
   - `listHostActions(hostId, status?): Promise<QueuedAction[]>` → GET
     `/api/v1/hosts/:hostId/actions`

## Part 2 — Server

4. **`packages/server/src/routes/hosts.ts`**
   - Add `GET /hosts` → `Host[]` (all hosts; reuse the existing rowToHost
     pattern incl. `latestVersion` once per request for `updateAvailable`).
   - Add `GET /hosts/:hostId` → `Host` (single row; 404 when unknown).
   - `HostRow`/`rowToHost`/`HOST_SELECT`: add `config_revision` →
     `configRevision` on the wire `Host`.
   - Keep the `__setDb` seam; extend `hosts.test.ts` for the new endpoints
     (list, get, 404).
5. **New `packages/server/src/routes/actions.ts`** — one Elysia plugin
   `actionsRoutes`, `prefix: "/api/v1"`:
   - `POST /hosts/:hostId/actions` — validate `type` is one of the four;
     `payload` optional object; insert row (id via `crypto.randomUUID()`,
     `created_at` now, status `pending`); 404 if host unknown; broadcast
     `{kind:"action", action}`; return 201 + action.
   - `GET /actions/pending?hostId=…&limit=…` — atomically take: `UPDATE …
     SET status='taken', taken_at=? WHERE host_id=? AND status='pending'
     ORDER BY created_at LIMIT ?` (Bun SQLite: use a transaction — select
     ids then update then re-select by ids), return up to 10 taken actions.
   - `POST /actions/:id/complete` — body `{status: "done"|"failed", result?}`;
     update row (completed_at, result); **also insert an `operation_log` row**
     (audit trail: host_id from the action, operation = action type,
     status = action status, summary = result) — reuse the same insert the
     report route uses; broadcast `{kind:"action", action}`; 404 when unknown.
   - `GET /hosts/:hostId/actions?status=…&limit=…` — history, newest first.
   - Every route has a `detail` block with tags `["Actions"]`.
   - Route tests in `packages/server/src/routes/actions.test.ts` following
     the `hosts.test.ts` pattern (`__setDb` seam): enqueue validates type /
     unknown host; pending-take marks taken + returns; complete writes row +
     operation_log entry; unknown action 404.
6. **`packages/server/src/index.ts`** — `.use(actionsRoutes)`.
7. **Config revision bumps** — helper `bumpConfigRevision(hostIds)` (or
   "all") in a small module (e.g. `packages/server/src/config-revision.ts`,
   increments `config_revision` for the given hosts). Call it from:
   - `folders.ts`: create/update/delete folder
   - `folders.ts`: assign/unassign/update assignment
   - `dotfiles.ts`: create/update/delete manifest
   - `hosts.ts` `/register` (peers may change)
   Keep it a single UPDATE statement; don't over-engineer (bump-all is fine
   where the affected hosts aren't obvious).
8. **`packages/server/src/ws.ts`** — nothing new needed if the broadcast is
   called from the routes; verify the `WSEvent` union handles `"action"`.

## Part 3 — Daemon

9. **`packages/daemon/src/index.ts`** (the daemon's `main()` holds the
   closures you need — `client`, `hostId`, `hostConfig`, `refreshConfig`,
   `runOnce`, `reportOperation`, `scheduler`):
   - **Action poller**: a `setInterval` aligned with `HEARTBEAT_INTERVAL_MS`
     (30s) that calls `client.listPendingActions(hostId, 10)`; for each
     action, execute and complete:
     - `trigger_sync` with `payload.folderId` → find the assignment, call
       `runOnce(assignment)` (log + complete with result/summary; a skip due
       to lock is a successful completion with a "skipped: …" result, not a
       failure)
     - `trigger_sync` without `folderId` → `runOnce` for every assignment
     - `trigger_backup` → same as trigger_sync but filter assignments to
       folder type `"backup"` when no `folderId` given
     - `check_update` → `fetchLatestRelease()` (from `./self-update.ts`) and
       complete with `result` like `"up to date (v0.2.3)"` /
       `"update available: v0.3.0"`
     - `refresh_config` → `refreshConfig()`; complete with the assignment
       count or an error string
     - Errors: catch per action, complete with `status: "failed"` + error
       message — never let one action take down the poll loop
   - **Config-revision check**: on each heartbeat (in the existing 30s
     heartbeat handler, after `reportHealth`), call `client.getHost(hostId)`
     and compare `configRevision` with the revision of the cached
     `hostConfig` (store the last-seen revision in a `let` next to
     `hostConfig`); when the server revision is higher → `refreshConfig()`.
     (The 5-min `refreshTimer` stays as a backstop.)
   - Update the boot path if needed so an initial revision is recorded after
     the first `refreshConfig()`.
10. **Tests** — `packages/daemon/src/actions.test.ts` for the pure parts
    (payload parsing → which assignments get run; completion body building).
    Keep daemon tests free of network/server deps (the route logic is covered
    server-side).

## Part 4 — Web UI

11. **`packages/web-ui/src/api.ts`** — add: `listHosts()`, `getHost(hostId)`,
    `getConfig(hostId)` (HostConfig — endpoint `/config/:hostId` already
    exists), `enqueueAction(hostId, body)`, `listHostActions(hostId)`.
12. **New `packages/web-ui/src/pages/Hosts.tsx`** — host list page
    (`/hosts`): fleet inventory table/cards (hostname, status badge, last
    seen, version + update pill, config revision); row click → host detail.
    Empty state. Uses theme tokens.
13. **New `packages/web-ui/src/pages/HostDetail.tsx`** (`/hosts/:hostId`,
    useParams): identity (hostname, status, last seen, tailnet/LAN IP),
    versions (daemon + update pill), config revision; **assigned folders**
    (with type + local path + sync schedule), **dotfile manifests**,
    **last operations** (reuse `/operations?hostId=`), **generated config
    view** (collapsible `<details>`/`<pre>` of `rcloneConfig` from
    `/config/:hostId`), **action buttons** (Refresh config, Check update,
    Trigger sync, Trigger backup — POST via enqueueAction; disable while a
    pending/taken action of that type exists, or keep simple and always
    allow enqueue with a confirmation), **action history** table (type,
    status, created/taken/completed, result). Errors shown via the `.error`
    pattern; no `any`.
14. **`packages/web-ui/src/App.tsx`** — routes `/hosts` and `/hosts/:hostId`;
    `Nav.tsx` — add a "Hosts" nav item (IconHost). **Do not** change the
    Command Center's `/` route.
15. **Command Center (`pages/Dashboard.tsx`)** — fleet cards become
    react-router `Link`s to `/hosts/${h.id}` (HashRouter — no plain
    `<a href>`).
16. **CSS (`index.css`)** — new classes for host list/detail/actions using
    only `var(--…)` tokens; both themes legible. No new icons needed beyond
    the existing set (IconHost etc.).

## Scope (out)

- Triggering daemon self-update (LAMA-151 mechanism unchanged).
- Reclaim/TTL for taken-but-died actions (documented limitation).
- WebSocket UI subscriptions for actions beyond the existing events (poll
  the history endpoint when the detail page mounts / on WS `action` event
  if trivial — otherwise a manual refresh button is fine).
- TUI changes. Remote arbitrary config editing.

## Acceptance criteria (from the issue)

- Host detail reachable from host list AND Command Center.
- Config view matches the actual daemon config payload (`/config/:hostId`).
- Queued-action design agreed in comments before code (done — the LAMA-198
  comment; do not deviate from it without flagging in your report).

## Report when done

Files changed (by package), verify-command results, and any deviations from
this document or the LAMA-198 design comment.
