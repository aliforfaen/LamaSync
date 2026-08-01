# Handoff — Command Center v1, Batch 1 (LAMA-199 + LAMA-201)

**Audience:** implementing agent. You do not need prior context on this project —
this document plus the files it references is everything you need.
**Epic:** LAMA-183 (LamaSync Expanded / Command Center v1). This doc covers only
Batch 1. Do not start Batch 2/3 work.

## The project in one paragraph

LamaSync is a personal sync-fleet system: one server (Elysia REST + WebSocket,
SQLite via `bun:sqlite`), a daemon per client (wraps rclone), a TUI, and an
embedded React web UI. Everything is TypeScript on Bun in a single monorepo.
`AGENTS.md` at the repo root documents layout and conventions — read it first.
`ARCHITECTURE.md` is the system design source of truth.

## Ground rules (violating these = failed review)

- **Imports use `.ts` extensions**: `import { foo } from "./bar.ts"`.
- **No `any`, no inline casts.** Use `unknown` + `typeof`/`in` narrowing.
- **DB columns go in BOTH `SERVER_SCHEMA` and the `MIGRATIONS` array**
  (`packages/core/src/db/schema.ts`). Schema-only changes break existing DBs.
- **Every new/changed route keeps its Swagger `detail` block.**
- **Shared wire/DB types live in `packages/core/src/types.ts`** — single source
  of truth. Server routes and the API client both reference these.
- Tests use `bun:test`, placed alongside source as `*.test.ts`.
- **Do not touch the TUI package** (`packages/tui`). Web UI and TUI are equal
  peers; this batch is web-UI/server/daemon only.
- If you change an endpoint's request/response shape, update the endpoint table
  in `packages/agent-skill/lamasync-server.md`.
- Keep changes minimal and scoped to the task. No drive-by refactors.

## Verify-before-done commands (all must pass)

```bash
bun install                # once
bun x tsc --noEmit         # type check — must be green
bun run build:web-ui       # required before tests (server embeds web UI dist)
bun test                   # all tests must pass
```

Manual smoke (optional but encouraged):

```bash
LAMASYNC_API_KEY=dev-key \
LAMASYNC_DATA_DIR=/tmp/lamasync-test \
LAMASYNC_BACKUP_DIR=/tmp/lamasync-test-backups \
  bun run dev:server
```

---

## Task A — LAMA-199: Version & update visibility

**Goal:** the daemon reports its version with each heartbeat; the server stores
it per host and derives "update available" server-side by comparing against the
latest GitHub release (already proxied at `GET /api/v1/release/latest`).

**Decided scope (from issue comments, 2026-08-01):**

- Daemon version only. **Do NOT implement TUI version reporting** — explicitly
  dropped from v1.
- Update-available is derived **server-side**. Clients never recompute it.
- The upstream GitHub release response must be **cached (TTL)** — no GitHub
  fan-out per API request.
- Do NOT add any "trigger update" action. Out of scope.

### Step-by-step

1. **`packages/core/src/types.ts`**
   - `HealthReport` (line ~219): add `version?: string`.
   - `Host` (line ~58): add `version?: string | null` and
     `updateAvailable?: boolean`.

2. **`packages/core/src/db/schema.ts`**
   - `hosts` table in `SERVER_SCHEMA`: add `version TEXT`.
   - `MIGRATIONS` array (line ~167): append
     `"ALTER TABLE hosts ADD COLUMN version TEXT"`.

3. **`packages/server/src/routes/hosts.ts`**
   - `HostRow` interface + `rowToHost()`: include `version`.
   - `POST /report/health` handler (line ~116): accept optional `version` from
     the body; update the `hosts` row. Follow the existing `lanIp` pattern —
     only overwrite the column when the heartbeat actually carries a value.
   - Elysia body schema: add `version: t.Optional(t.String())`.
   - The WS `broadcast({ kind: "host", ... })` already exists — the new field
     flows automatically through `rowToHost`.

4. **`packages/daemon/src/index.ts`**
   - Two `client.reportHealth({...})` call sites (~line 613 boot, ~line 651
     heartbeat interval): add `version: VERSION`.
   - `VERSION` is already imported from `@lamasync/core` and used in this file
     (startup update check, ~line 637) — reuse that import.

5. **`packages/core/src/api-client.ts`**
   - `reportHealth(body: HealthReport)` (line ~164) takes the whole type — no
     change needed once `HealthReport` is extended. Verify, don't assume.

6. **Version comparison helper — new file `packages/core/src/version-compare.ts`**
   - Export `isNewer(current: string, candidate: string): boolean` — semantic
     compare, tolerate a leading `v`, ignore pre-release suffixes beyond a
     simple split (keep it stupidly simple: numeric triple compare).
   - The daemon has a reference implementation in
     `packages/daemon/src/self-update.ts` (`isNewer`) — do NOT import daemon
     code into core/server; port the logic into core and add unit tests in
     `packages/core/src/version-compare.test.ts`.

7. **Server-side release cache + derivation**
   - `packages/server/src/routes/release.ts` already fetches
     `api.github.com/repos/aliforfaen/LamaSync/releases/latest`. Extract the
     fetch into a small cached helper (e.g.
     `packages/server/src/release-cache.ts`): in-memory cache, TTL ~1 hour,
     failures return the stale value or `null` — never throw into request
     handlers. `release.ts` should use it too (no behavior change to that
     endpoint's response shape).
   - Wherever hosts are serialized for API responses (`rowToHost` call sites
     in `hosts.ts`), set `updateAvailable = isNewer(host.version, cachedLatest)`
     when both are known, `false`/omitted otherwise. If making `rowToHost`
     async is invasive, resolve the cached latest version once per request and
     pass it in — your choice, keep it simple.

8. **Web UI badge — `packages/web-ui/src/pages/Dashboard.tsx`**
   - The hosts table already renders `Host[]` and live-merges WS host events
     (`mergeEvent`). Add a **Version** column showing `host.version ?? "—"`
     and an "update available" badge (text/ pill is fine) when
     `host.updateAvailable` is true. No new pages — LAMA-197 builds the real
     Command Center later.

9. **Tests**
   - `packages/core/src/test.test.ts`: extend schema/migration coverage for the
     new `hosts.version` column.
   - New `packages/core/src/version-compare.test.ts`: equal versions, older,
     newer, `v`-prefixed, missing segments.
   - There is no `hosts.test.ts` yet; route tests exist for other routes under
     `packages/server/src/routes/*.test.ts` — follow that pattern to cover:
     heartbeat with version stores it; heartbeat without version preserves the
     stored value.

10. **Docs**
    - Update the `POST /api/v1/report/health` row in
      `packages/agent-skill/lamasync-server.md` if the body shape is documented
      there.

### Acceptance criteria (from the issue)

- Per-host daemon version visible via API and UI.
- Update-available state derived server-side, not recomputed per client.

---

## Task B — LAMA-201: Theme & design-token pass (dark/light)

**Goal:** product feel for the web UI without a component-framework dependency.
All work is inside `packages/web-ui`.

**Decided defaults (from issue comments, 2026-08-01):** system-default
detection via `prefers-color-scheme`, dark fallback, choice persisted in
localStorage, switch applies without reload.

### Step-by-step

1. **Design tokens — `packages/web-ui/src/index.css`**
   - Define all theme values as CSS custom properties in two blocks:
     `:root, [data-theme="dark"] { ... }` and `[data-theme="light"] { ... }`.
   - Token groups: background, surface, border, text, text-dim; spacing scale;
     border-radius; typography (font-family, sizes).
   - Semantic accent palette (exact hue is your design call, keep both themes
     legible): `--accent-info` blue, `--accent-ok` green, `--accent-warn`
     yellow, `--accent-critical` red, `--accent-storage` purple,
     `--accent-sync` teal.
   - Replace the hard-coded hex values currently in `index.css` (e.g.
     `#0f1115`, `#161a22`, `#232838`, `#e6e8ec`, `#7cb6ff`) with `var(--…)`
     references. Dark theme values must reproduce today's look exactly — the
     current UI is dark-only, so dark is the regression baseline.

2. **Theme module — new `packages/web-ui/src/theme.ts`**
   - `type ThemeChoice = "dark" | "light" | "system"`.
   - Read/write localStorage key `lamasync-theme`; default `"system"`.
   - `applyTheme(choice)`: resolve system via
     `window.matchMedia("(prefers-color-scheme: light)")`, fall back to dark,
     set `document.documentElement.dataset.theme`.
   - When choice is `"system"`, subscribe to the matchMedia `change` event;
     unsubscribe otherwise.
   - Call `applyTheme(loadThemeChoice())` once at app boot
     (`packages/web-ui/src/main.tsx`) before/at render.

3. **Toggle — `packages/web-ui/src/components/Nav.tsx`**
   - Add a small button cycling dark → light → system (or a three-state
     select — keep it simple). Uses `theme.ts`; no reload; persists.

4. **Icons — new `packages/web-ui/src/components/icons.tsx`**
   - Inline SVG React components, `currentColor`, no icon-font dependency.
   - One icon per domain: host, folder, dotfile, backup/restic, S3/storage,
     conflict, update, notification.
   - Adopt incrementally: v1 uses them in `Nav.tsx` only. Pages adopt later.

5. **Regression check**
   - `bun run build:web-ui`, run the dev server, open the UI: every existing
     page (Dashboard, Folders, Dotfiles, Conflicts, Admin) renders correctly in
     BOTH themes. Toggle persists across reload.

### Acceptance criteria (from the issue)

- Theme switch applies without reload and persists.
- All existing pages render correctly in both themes.

---

## Explicitly out of scope for Batch 1

- Queued/remote actions of any kind (LAMA-198 spike is design-doc-only and not
  in this batch).
- Notifications, ntfy, LamaDB (LAMA-200).
- New pages: Command Center dashboard (LAMA-197), host detail (LAMA-198),
  Data Browser (LAMA-202).
- TUI changes. Remote update triggering.

## Suggested working agreement

- Implement Task A and Task B in separate sessions/PRs. They are independent
  and can run in parallel.
- Commit granularity is the user's call — do not commit unless asked.
- When done, report: files changed, test results (`bun x tsc --noEmit`,
  `bun test`), and any deviation from this document.
