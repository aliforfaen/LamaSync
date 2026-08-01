# Handoff — Command Center v1, Batch 4 (LAMA-200)

**Audience:** implementing agent. Read `AGENTS.md` first (conventions), then
`docs/handoff/command-center-batch1.md` §"Ground rules" (same rules apply).
**Epic:** LAMA-183. Batches 1–3 merged (LAMA-199/201/197/198). You build on:
the `operation_log` audit trail, `Host.version`/`updateAvailable` (LAMA-199),
the Admin page (web UI), and the theme tokens.

## Decisions already made (do not revisit)

- **Config via env vars** (the server is env-driven; it does not load a TOML
  file at runtime): `LAMASYNC_NTFY_URL` (ntfy endpoint, e.g.
  `https://ntfy.sh/lamasync` or a self-hosted topic) and
  `LAMASYNC_LAMADB_WEBHOOK_URL` (optional; off by default). The core TOML
  parser already has `ntfyUrl` in `ServerConfig` — leave it; document the env
  vars in `config-examples/server.toml` as the runtime source.
- **LamaDB integration is a configurable webhook target** (POST all events as
  JSON), NOT a new LamaDB module — LamaDB is a separate project; wiring it to
  the webhook is a config change. Follow the "uptime-webhook pattern"
  (POST → events table → dashboard ticker) with a simple `{type, severity,
  message, hostId, folderId, createdAt}` JSON body.
- **Durable event log in LamaSync's own SQLite** (`notification_events`
  table) — the server-side history the UI and future LamaDB sync use.
- **Host-staleness sweep** (60s interval): hosts whose `last_seen` is older
  than 90s get marked `offline` in the `hosts` table. This is required for
  the "unexpected host offline" event AND fixes a real gap — today hosts stay
  "online" forever if a daemon dies silently, so the Command Center's
  offline triage never sees them.
- **Cooldowns are in-memory** (Map keyed by `type|hostId|folderId`);
  restart resets them (acceptable, document it). The durable table records
  every fired event; cooldown only suppresses delivery.
- **Never throw into request handlers.** Delivery (ntfy/webhook) is
  fire-and-forget with logging on failure.

## Task — notification foundation

### 1. Core (`packages/core/src/types.ts` + `db/schema.ts`)

```ts
export type NotificationSeverity = "critical" | "default" | "info";
export type NotificationType =
  | "operation_failed" | "operation_success"
  | "conflict_pending" | "host_offline" | "host_online"
  | "update_available" | "restore_failed" | "restore_done"
  | "test";
export interface NotificationEvent {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  message: string;
  hostId?: string | null;
  folderId?: string | null;
  payload: Record<string, unknown> | null;
  createdAt: number;
  ntfyDelivered: boolean;
  webhookDelivered: boolean;
}
```

- `SERVER_SCHEMA`: `notification_events` table — `id TEXT PRIMARY KEY, type
  TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL, host_id TEXT,
  folder_id TEXT, payload TEXT, created_at INTEGER NOT NULL,
  ntfy_delivered INTEGER DEFAULT 0, webhook_delivered INTEGER DEFAULT 0`.
- `MIGRATIONS`: `CREATE TABLE IF NOT EXISTS notification_events (...)` (same
  DDL). No column additions to existing tables.

### 2. Server event router — new `packages/server/src/notifications.ts`

- `severityForType(type)` → critical/default/info (see severity map below).
- `emitNotification(input: {type, message, hostId?, folderId?, payload?})`:
  1. Dedup/cooldown check (in-memory Map; see rules below) — returns early if
     suppressed (the sweep/operation hooks that call this get a boolean).
  2. Insert `notification_events` row.
  3. If severity is `critical` or `default` AND `LAMASYNC_NTFY_URL` set →
     `POST` ntfy JSON `{topic: <from url path>, title, message, tags}` —
     tags by severity: critical → `rotating_light`, default → `warning`,
     info → `information_source`. Fire-and-forget; set `ntfy_delivered`.
  4. If `LAMASYNC_LAMADB_WEBHOOK_URL` set → `POST` the flat JSON body to it
     (all severities); set `webhook_delivered`. Fire-and-forget.
  5. Never throws.
- **Severity map** (from the issue): `restore_failed` → critical;
  `host_offline` → critical; repeated backup failure (2nd+ failure for the
  same folder within 15 min) → critical; `operation_failed` (1st failure) →
  default; `conflict_pending` → default; `update_available` → default;
  `restore_done` → info; `operation_success` → info; `host_online` → info;
  `test` → default.
- **Cooldown rules**: `operation_failed` — 15 min per `folderId`
  (consecutive-failure counter tracked in the same map; counter resets on
  success); `host_offline`/`host_online`/`update_available` —
  edge-only, fire once per state change, no timer needed (sweep drives them);
  `conflict_pending` — 15 min per `folderId`; `operation_success` — max one
  per host per 30 min (a digest, not per-op); `restore_failed`/`restore_done`/
  `test` — always fire.
- **Host sweep** — `startNotificationSweep()` (or fold into an existing
  interval): every 60s,
  - for each host with `last_seen !== null` and `status !== 'offline'` and
    `last_seen < now - 90_000`: set `status = 'offline'` in `hosts`,
    broadcast `{kind:"host", host}` (reuse the rowToHost pattern), and
    `emitNotification({type:'host_offline', ...})`.
  - for each host that transitions back (heartbeat handler in `hosts.ts`
    already updates status; hook the online edge there — see §3): when a
    heartbeat sets a previously-offline host to online, emit
    `host_online` (info).
  - update-available edge: track per-host last-known `updateAvailable`
    (derive via the cached release, same as hosts.ts rowToHost); when it
    flips false→true, emit `update_available` (default). (Hosts whose
    version is unknown never fire this.)
- Exports a `__resetNotificationStateForTests()` test seam.

### 3. Hooks (keep them one-liners)

- `packages/server/src/routes/report.ts` (POST /report, after the
  operation_log insert + broadcast):
  - status `failed` → `emitNotification({type:'operation_failed',
    hostId, folderId, message: <folder/op summary>})`.
  - status `success` → `emitNotification({type:'operation_success', ...})`
    (info; digest-cooldowned).
- `packages/server/src/routes/conflicts.ts` (at the `INSERT INTO conflicts`
  site, when the new row is `pending`) →
  `emitNotification({type:'conflict_pending', hostId, folderId, payload:
  {path}})`. Also emit when a conflict transitions back to pending? No — only
  on new pending rows.
- `packages/server/src/routes/restic.ts` — wherever restore jobs complete
  (`done`) or fail (`failed`): `restore_done` / `restore_failed` with the
  job's folderId + target host.
- `packages/server/src/routes/hosts.ts` — heartbeat handler: when the
  previous status was `offline`/`unknown` and the new report sets it online,
  emit `host_online` (info).
- These hooks must not change the response shape of any existing endpoint.

### 4. Routes — new `packages/server/src/routes/notifications.ts`

- `GET /api/v1/notifications?limit=…` → newest-first `NotificationEvent[]`
  (default limit 50, clamp 200). Detail block, tags `["Notifications"]`.
- `POST /api/v1/notifications/test` → emits a `test` event
  (`severity default`, message "Test notification from Admin UI") and returns
  the created event (201). Works without ntfyUrl configured (still records
  the row) — the Admin button is how a user verifies delivery.
- Route tests `notifications.test.ts` (pattern: `__setDb` seam, in-memory
  DB): emit writes a row + honors cooldown; test endpoint records + returns;
  GET lists newest-first; sweep flips a stale host to offline + fires
  `host_offline` once (and NOT again on the next sweep tick while offline).

### 5. Server wiring

- `packages/server/src/index.ts` — `.use(notificationsRoutes)` and start the
  sweep on boot (only when not under test — check how other intervals are
  gated, e.g. `process.env.LAMASYNC_TEST` or similar; follow existing
  patterns).
- `config-examples/server.toml` — document `LAMASYNC_NTFY_URL` and
  `LAMASYNC_LAMADB_WEBHOOK_URL` (env) next to the existing `ntfyUrl` line.

### 6. Web UI (Admin page — `packages/web-ui/src/pages/Admin.tsx` + `api.ts`)

- `api.ts`: `listNotifications(limit?)`, `sendTestNotification()`.
- Admin: a "Notifications" section — "Send test notification" button
  (calls sendTestNotification, shows the response event or error) + the last
  ~20 notifications as a table (time, type, severity badge, message,
  delivery flags). Use existing `.badge` classes / tokens; no new colors.
- Small CSS addition only if needed (use existing classes first).

### 7. Docs

- `packages/agent-skill/lamasync-server.md`: add the two notification routes
  to the endpoint table + a short "Notifications" note (env vars, severity).

## Scope (out)

- Per-user preferences, email/generic webhook targets beyond the LamaDB
  webhook, ntfy topic-per-event-type config, delivery retries/backoff,
  persisted cooldowns.

## Acceptance criteria (from the issue)

- ntfy push for critical/default, LamaDB webhook for all events, durable
  local history.
- State-transition-only firing (no per-poll repeats) + dedup/cooldown.
- "Send test notification" action in Admin UI.
- Bonus (also fixes a real gap): stale hosts now flip to offline and the
  Command Center's offline triage reflects it.

## Verify before done

`bun x tsc --noEmit`, `bun run build:web-ui`, `bun test` (expect the
existing 259 pass / 1 skip / 0 fail + your new tests). Do NOT commit.

## Report when done

Files changed by package, verify results, deviations from this doc.
