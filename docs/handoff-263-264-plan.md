# Handoff — LAMA-263 (presets gallery) + LAMA-264 (demo mode)

Work-order for `feature/product-finish`. Both are LAMA-249 "flourish" children
that were explicitly OUT of scope for the LAMA-275 design issue; this plan
implements them cleanly on top of the shipped web/TUI shell + glossary.

State: branch `feature/product-finish`, PR #1 open, ~622 tests green. Both
issues `backlog` on Multica. SSH to the LXC is available (`~/.ssh/lamasync_key`)
for live verification.

## Session contract (same as handoff-flourishes.md)

1. One issue per commit; gates after each:
   `bun x tsc --noEmit` → `bun run build:web-ui` → `bun test` → (API changes)
   `bun scripts/check-skill-drift.ts`.
2. **No renames** of API routes / DB columns / config keys / CLI commands /
   wire types. Additive columns + endpoints only. Schema changes go in BOTH
   `SERVER_SCHEMA` and the `MIGRATIONS` array.
3. Glossary per `docs/terminology.md` (devices, storage destinations, app
   settings backups). User-facing copy only.
4. After each feature: append `docs/whats-new-for-owner.md`,
   tick `docs/dogfood-2026-08-23.md`, flip the Multica issue to done.
5. Merge flow: separate PRs off `feature/product-finish`.

---

## LAMA-263 — App presets gallery (curated)

Decision locked 2026-08-22: **ship curated, not a registry**. V1 = 5–6
hand-picked apps with hard-coded paths to prove the pattern.

### Design

- **Pure web feature — no server changes.** The curated catalog is a static
  TS module (`packages/web-ui/src/presets.ts`); it is the source of truth for
  the gallery and the "one-click backup" payload. This keeps the change
  additive and avoids inventing a server-side catalog endpoint we'd later
  regret. (If a registry is wanted later, the catalog interface is the seam.)
- Catalog entry shape: `id`, `name`, `blurb`, `docsUrl`, `paths` (per-OS
  arrays of appdata paths), `suggestedFolderName`. V1 apps: VS Code, Neovim,
  Zsh, Firefox, Git config (+ a 6th, e.g. Starship or tmux). Paths are
  OS-specific; the UI picks the current OS (`navigator.platform`/userAgent)
  and lets the user adjust the path before creating.
- **"Backup this app"** reuses existing endpoints (no new verbs):
  `api.createFolder({ type: "dotfile", name: <app> settings })` then
  `api.createManifest({ hostId, appName: <app>, paths })`. This maps exactly
  to the existing "app settings backup" model (FolderType `dotfile` +
  DotfileManifest), so the daemon picks it up like any other app-settings
  backup. The existing App settings page handles restore/download.
- **"Which devices"**: call `api.listManifests()` and group by `appName`; the
  gallery shows a per-app device count + chips. "Manage" links to `/dotfiles`.
- **"Install"**: external `docsUrl` (opens new tab) — the app is installed by
  the user, LamaSync only backs up its settings.
- New page `packages/web-ui/src/pages/Presets.tsx` under the **Apps** nav
  group (`/presets`), reusing `PageHeader`, `Modal`/`ConfirmDialog`, and
  design tokens. A device picker (from `api.listHosts()`) is shown when
  backing up, since app-settings backups are per-device.
- Small pure unit test `presets.test.ts` (catalog shape + OS path selection).

### Acceptance

- Gallery lists the curated apps with docs + device counts.
- "Backup on <device>" creates a dotfile folder + manifest; the app then
  appears on `/dotfiles` for that device (verifiable live via SSH).
- No new API routes, no schema changes, no `any`.

---

## LAMA-264 — Demo mode + "Delete demo data"

Goal: "See a demo fleet" without adding real folders — 3 fake devices, a
timeline with realistic activity, and a browsable restic snapshot + file
viewer seed. Prominent "Delete demo data" wipes all seeded rows in one
confirmed click. **Demo data is flagged (`demo = 1`) and never triggers a
real rclone sync or touches a real backend.**

### Design

- **Additive `demo` flag** (`INTEGER NOT NULL DEFAULT 0`) on the tables that
  get seeded: `hosts`, `folders`, `folder_assignments`, `backends`,
  `operation_log`, `restic_snapshots`, `dotfile_manifests`. Add to BOTH
  `SERVER_SCHEMA` and `MIGRATIONS`.
- **New additive route** `packages/server/src/routes/demo.ts`
  (`prefix: "/api/v1"`, Swagger `detail`):
  - `GET /api/v1/demo` → `{ hasDemo, counts }` (counts of demo rows per
    table) so the web can show the entry CTA vs the active banner.
  - `POST /api/v1/demo/seed` → seeds, all rows `demo = 1`:
    - 3 fake hosts (ids `demo-<uuid>`, varied status/last_seen, no real
      daemon — a real daemon only pulls its own host id, so it never acts on
      these).
    - 1–2 `local` **demo backends** pointing at a server-side seed dir
      (`$LAMASYNC_BACKUP_DIR/demo/`), plus sample files written there, so the
      **Data Browser** (local) and a **restic_snapshot** row show realistic
      content. A dotfile folder + manifest for one app on a demo host.
    - ~12–20 `operation_log` rows across the demo hosts/folders with realistic
      summaries, status mix, and timestamps spread over the last few weeks.
    - Returns a summary `{ hosts, folders, operations, snapshots, backends }`.
  - `DELETE /api/v1/demo` → deletes all `demo = 1` rows across the flagged
    tables in FK-safe order (operations → assignments → conflicts →
    snapshots → manifests → folders → backends → hosts). Returns deleted
    counts. Idempotent (no-op when nothing flagged).
- **Safety**: nothing in seed schedules a sync, creates a queued action, or
  writes to a real backend. Demo backends are `local` seed dirs. Seeded hosts
  have no heartbeat, so the daemon never configures them. `config_revision`
  is **not** bumped by seeding (no real daemon needs to re-pull).
- **Web**: `api.getDemo() / api.seedDemo() / api.deleteDemo()`. On the
  Dashboard:
  - When the fleet has no real hosts **and** `hasDemo` is false, the empty
    Fleet `EmptyState` gets a secondary CTA "Or explore a demo fleet".
  - When `hasDemo` is true, a prominent banner "Demo data is active" with a
    "Delete demo data" button → `ConfirmDialog` → `DELETE /api/v1/demo`,
    then refetch. Demo hosts/folders/backends render through the existing
    pages (they are just normal rows), so the user "learns by poking".
- **core**: add `DemoState` type to `types.ts` and export.

### Acceptance

- "Explore a demo fleet" seeds 3 devices + timeline + browsable snapshot;
  the Dashboard/Devices/Activity/Data Browser show them.
- "Delete demo data" (confirmed) removes every seeded row; nothing real is
  touched; re-seeding works.
- No real rclone/backend is contacted during seed or delete.
- Unit test `demo.test.ts` covers seed (row counts + flags) and delete
  (idempotent, all demo rows gone, real rows intact).

---

## After both land

- Update Multica: each done + comment; LAMA-249 can move to done once PR #1
  merges (unchanged).
- Refresh `docs/whats-new-for-owner.md` + `docs/dogfood-2026-08-23.md`;
  capture before/after into `docs/lama275-artifacts/`.
