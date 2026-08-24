# What's new for the owner — rolling brief

User-facing summary of what changed on `feature/product-finish`, what to look
for when you review or dogfood, and which decisions were made by agents vs.
approved by you. Appended to at every milestone; the current branch work is
tracked in Multica (LAMA-249 parent, LAMA-275/276/247 children).

**Legend:** ✅ you approved it · 🤖 agent decided (safe/mechanical) · ⚠️ agent
decided but you may want a relook

---

## 2026-08-23 — LAMA-276 (TUI pass 2) + LAMA-247 fix batch · PR #1 open, not merged

### TUI shell — what changed / what to look for

- **Tabs are now: This device · All devices · Backups & apps · Conflicts ·
  Activity · More** ✅ (your D3 verdict). The third tab shows fleet-wide
  *backup folders* (name + storage destination, read-only) above the app
  settings picker 🤖 — look: it's a visibility list only; no actions on
  those folder rows yet (fine for now, revisit later).
- **GitHub lives under More** ✅ (your D4 verdict). More is a small tools
  menu; Enter or `g` opens GitHub, Esc returns. Look: the tab bar stays on
  "More" while you're inside GitHub — intended drill-in behavior.
- **Less chrome**: per-view borders removed, the key-hint row merged into
  the bottom status bar, "Activity" heading fixed. Look: the shell is
  intentionally flatter now — confirm you like the look vs. the bordered
  pages from the before-captures.
- **Contextual actions**: when you select a folder on This device, the
  footer names that folder's actions (`[2] sync`, `[p] cache`, `[s] type`,
  `[n] shares`) above the global row. 🤖
- **Adaptive help**: `?` now sizes to your terminal (verified at 60×20). 🤖
- ⚠️ **Relook candidate**: six task-oriented tabs **truncate at 80 columns**
  (`This device / All devices / Backups & apps / Conflicts` then `›`).
  Shortening the tab labels (e.g. "Backups") fixes it; we kept names as
  approved and accepted the truncation — your call.

### Fixes — what changed / what to look for

- **Backup summary counts are real again.** Root cause: rclone ≥1.63 writes
  its JSON log to *stderr*, the daemon only read stdout → "0 transfers, 0 B"
  even when data copied. Now both streams are parsed. Look: run a backup on
  a real folder and check the operation summary shows transfers/bytes.
- **S3 Data Browser**: a missing object now returns **404** (was 400), and
  downloads over 64 MiB are rejected *while streaming* instead of buffering
  the whole object (no more OOM risk). 🤖
- **Admin page**: a dead `/health` now shows a caption under the Server
  block instead of silent "—" placeholders. 🤖
- **Schedule editor**: `@midnight` / `@noon` in a custom cron are now
  rejected with an error — the daemon could never schedule them (silent
  never-running before). ⚠️ **Relook candidate**: alternative was teaching
  the daemon to map `@midnight`/`@noon`; we chose the honest-reject route.
- **Rename a device to its own name** now returns 400 "unchanged" instead of
  faking a successful rename. 🤖
- **tailnet IP staleness**: when Tailscale is down for >5 min the daemon now
  clears the stored IP (sends `""` as an explicit clear; server bumps
  `config_revision` so peers re-pull). ⚠️ **Relook candidate**: `""` is a
  new wire sentinel — backwards-compatible (old daemons never send it), but
  it's a semantic addition agents chose.
- **CLI automation**: `lamasync <cmd> --json` failing with 401/403 now also
  prints `{ok:false, reason:"auth-failure", exitCode:3}` on stdout (in
  addition to the human stderr line) — grep/jq-able. 🤖

### Platform decisions made by agents (no owner input yet)

1. `""` empty-string = explicit tailnet-clear on the health wire.
2. Cron validators reject `@midnight`/`@noon` rather than daemon mapping.
3. CLI `--json` failure envelope shape `{ok, reason, error, exitCode}`.
4. S3 download cap enforced mid-stream via process kill + bounded reader.
5. Rename-no-op → 400 (vs. explicit no-op success).
6. Tab truncation accepted at 80 cols for now.

### Suggested relooks (flag if any bother you)

- 80-col tab truncation (shorten labels or accept).
- Borderless pages look (compare before/after captures).
- `@midnight`/`@noon` — reject vs. teach the daemon.
- Whether GitHub-under-More (approval) should also hide release-check
  tooling or keep it reachable in More.

## 2026-08-23 follow-up — owner relooks + LAMA-228 + LAMA-253 (same PR #1)

### Relook outcomes (your selections)

- **Tabs now fit at 80 columns**: `This device | All devices | Backups |
  Conflicts | Activity | More` — no more `›` truncation. `Backups` is the
  tab label; the page heading keeps the full approved "Backups & apps".
- **Bordered page shells restored** — the LAMA-275 look is back; the
  status/hint merge, adaptive help, and contextual footer stay.
- Behavioral agent decisions (tailnet `""` sentinel, cron `@midnight`/`@noon`
  reject, JSON envelope, rename 400, streaming cap) **accepted** per your
  selection.
- **CLI fake-key warning now loud** (your decision): when no credentials
  resolve, `lamasync` prints a clear "using fake localhost/dev-key" warning
  on stderr and the legacy fallback does too. Look: try `lamasync status`
  outside a configured fleet and you should see it.

### Verified + shipped

- **LAMA-228 — TUI clean exit pty-verified**: `q` and Ctrl+C both exit
  code 0 against dead AND live servers (no lingering processes).
- **LAMA-253 — CLI/TUI help copy pass shipped (Phase 4 done)**: prose in
  CLI help, wizard steps (Custom schedule, Role on this device, Device
  select), and daemon/server usage blocks use the glossary; commands,
  flags, exit codes, JSON keys untouched; skill-drift stays OK.

### Phase 5 + 6 (2026-08-23)

- **LAMA-252 README rewrite (Phase 5 done)**: sync-first headline, 15-min
  setup, architecture last; private LXC/SSH details removed (now only in
  docs/prod-deploy.md); glossary applied; embeds final-wording captures.
- **LAMA-254 repo polish (Phase 6, mostly done)**: CONTRIBUTING.md + issue
  forms + PR template; README screenshot embeds; **stranger-flow audit
  passed** — fresh-HOME install → device registration → folder + "set up on
  device" → daemon picked up the assignment via config_revision → CLI sync
  trigger → real `backup ok: 1 transfers, 22 B` in Activity (live proof the
  LAMA-247 transfer-count fix works). The audit caught and fixed a real bug:
  `boot.ts` onDestroy TDZ crash on early teardown.

### Next for this branch

- **LAMA-254 remainder**: fuller screenshot/GIF set + a GIF convention;
  file the audit findings as Multica follow-ups.
- **Merge PR #1** when ready — all six phases are effectively done; review
  the What's new doc first.

## 2026-08-23 — UX flourish batch (LAMA-267/271/272/270)

### LAMA-267 — Schedules as human sentences

- The raw cron box is gone from every schedule picker: folder "set up on
  device", the assignment editor, and app settings manifests now show the
  friendly presets (Custom / Every hour / Every 6 hours / Daily / Weekly /
  Monthly / On boot / On login) with **"Advanced: custom cron" collapsed**
  behind a reveal toggle. 🤖
- A **"Next: …" sentence** now previews the next run wherever a schedule is
  set — "Next: tonight at 02:00", "Next: in 27m", "Next: on boot" — computed
  with the *same* `cron-parser` the daemon uses, so the preview matches what
  will actually run. Invalid or never-firing crons show nothing. 🤖
- Web preset labels now come from one shared module (`schedule-presets.ts`);
  they already matched the TUI, so **zero TUI changes**. ⚠️ **Relook
  candidate**: the TUI wizard's preset *description* still shows the raw cron
  string — pre-existing copy, out of scope; flag if you want it humanized.
- "When on WiFi" preset is **not** included (no wifi-trigger backend exists);
  noted on LAMA-267.

### LAMA-271 — Empty states that teach

- Every empty web view now shows a mini-wizard instead of a bare table: a
  CSS-drawn glyph (no emoji/images), a one-sentence "how", and a single
  primary CTA. Covered: Folders, Devices, Storage destinations, Activity,
  Data browser, and the Dashboard empty-fleet ("Pair your first device").
- Each CTA opens an **existing** flow (new-folder form, add-device guide,
  add-storage form, upload, or a route) — no new endpoints. 🤖
- TUI empty text in This device / Backups & apps / Activity was reworded to
  match the glossary + web ("No folders set up on this device yet.", etc.);
  TUI state-machine untouched. 🤖
- ⚠️ **Relook candidate**: the glyph is a simple CSS "orbit" drawing — a
  deliberately conservative choice (no assets); flag if you'd like a richer
  illustration later.

### LAMA-272 — Device cards, not host table

- The Devices page is now a **responsive card grid** (4-up at 1440, single
  column at 360) instead of a host table: device glyph, name, a pulsing
  online dot **plus** the word "Online/Offline" (never color alone), and a
  "Last backup …ago" line derived from the operations feed. Clicking a card
  opens the device detail page. 🤖
- The "Pair your first device" empty state (LAMA-271) is preserved in the
  new layout. 🤖
- ⚠️ **Noted gaps (no wire change, per issue)**: there is **no OS field** on
  the wire (so the card uses a generic CSS device glyph, not a real OS icon),
  and **no per-host storage-used field** in `/health` (so "storage used" is
  omitted). Both would need an *additive* endpoint/field in a future issue.
- User-facing "host" copy in Device detail + rename + TUI Activity filter was
  swept to "device"; wire fields untouched. 🤖

### LAMA-270 — Command palette (cmd+k)

- **⌘/Ctrl+K** opens a fuzzy command palette over navigation + actions:
  "Add synced folder", "Pair device", "Resolve conflicts", "Go to Storage",
  etc. Typo'd input still matches ("syncd flder" → "Add synced folder").
  Arrow keys + Enter navigate (router push — deep links preserved), Esc
  closes, click works. 🤖
- The palette derives its navigation commands from the same nav model as the
  left rail (single source of truth — can't drift), and its CTAs just
  navigate to the page that owns each flow. 🤖
- Fixed overlay → **no layout shift**, usable at 360px, **reduced-motion
  safe** (fade only, disabled under `prefers-reduced-motion`). Fuzzy match is
  a dependency-free ~30-line scorer (no new deps). 🤖

### Platform decisions (agents, no owner input yet)

- Next-run sentence computed client-side via the shared `cron-parser`
  dependency (added to web-ui); no new server endpoint.
- Empty-state illustration is pure CSS (no emoji/image assets) per the
  issue's "icon/emoji-free" constraint.
- Device cards omit OS icon + storage-used (no wire fields); "last backup"
  derived from the operations feed, not a new endpoint.
- Command palette is dependency-free (custom fuzzy scorer); CTAs navigate
  rather than cross-component form-opening.

---

*(Future sessions: append a new dated section here instead of editing old
ones. The technical mirror of this is `docs/dogfood-2026-08-23.md`.)*
### LAMA-263 — App presets gallery (curated)

- New **App presets** page (under the Apps nav group, `/presets`): a gallery
  of 6 hand-picked apps — VS Code, Neovim, Zsh, Firefox, Git config, tmux —
  each with an Install (docs) link, a one-click **Backup** on a chosen
  device, and a **Manage** link to App settings. 🤖
- "Backup" creates an **app-settings backup** (dotfile manifest) for the
  app's OS-specific appdata paths on the selected device — reusing the
  existing manifest model, **no new server endpoints**. The gallery shows
  which devices already back each app up (count + hostnames), derived from
  the manifest list. Restore is handled on the App settings page. 🤖
- Catalog is a static curated module (`packages/web-ui/src/presets.ts`) —
  decision locked 2026-08-22 (ship curated, not a registry). The module
  interface is the seam if a community registry is wanted later. 🤖
- Pure web feature: zero API/schema/CLI changes, zero `any`. Verified via
  `tsc --noEmit`, `build:web-ui`, `bun test` (626 pass / 1 skip). 🤖

### LAMA-264 — Demo mode + "Delete demo data"

- New **demo mode**: "Explore a demo fleet" (Dashboard empty state, when no
  real devices) seeds 3 fake devices, a realistic timeline of activity, a
  browsable restic snapshot, and a local file-viewer seed — so a new user
  learns by poking empty states without adding real folders. 🤖
- All demo rows are **flagged `demo = 1`** (additive column on hosts, folders,
  folder_assignments, backends, operation_log, restic_snapshots,
  dotfile_manifests, restic_restore_jobs — both `SERVER_SCHEMA` and
  `MIGRATIONS`). A single confirmed **Delete demo data** wipes every flagged
  row in FK-safe order; real data is never touched, and a real daemon never
  acts on demo hosts (they have no heartbeat). 🤖
- Additive server route `packages/server/src/routes/demo.ts`:
  `GET /api/v1/demo` (state), `POST /api/v1/demo/seed`, `DELETE /api/v1/demo`.
  Seeding does **not** bump `config_revision` and triggers no rclone sync —
  demo data is strictly visual/learn-by-poking. 🤖
- Web: Dashboard banner when demo is active + confirm dialog for delete;
  empty-fleet secondary CTA to seed. Verified via `tsc`, `build:web-ui`,
  `bun test` (630 pass / 1 skip) including `demo.test.ts` (seed counts +
  idempotent, real-data-safe delete). 🤖

## 2026-08-24 — coding-agent batch (LAMA-283/258/269/282) · PR #1 open

Quick-wins batch from `docs/handoff-agent-batch-2026-08-24.md`, one commit
per issue. Gates after each: `tsc --noEmit` → `build:web-ui` → `bun test`
→ `check-skill-drift.ts --strict` (all green; 661 pass / 1 skip / 0 fail,
87 server routes drift-clean). Live-LXC items (LAMA-273/266/262) and the
257/268/153 slice are NOT in this batch.

### LAMA-283 — skill-drift check is now strict

- CI runs `scripts/check-skill-drift.ts --strict`: any new route/command
  must be documented under `packages/agent-skill/reference/` or the build
  fails. Policy line added to AGENTS.md. 🤖 (mechanical)

### LAMA-258 — Human-sentence activity feed

- Operations page + Dashboard timeline now read as sentences instead of raw
  server summaries: "Backed up **Dev configs** from **cachy** to **Exoscale**
  · 2h ago · ok". Status word is always text ("ok / failed / conflict /
  retrying / recovered / started") — never colour alone. 🤖
- The raw server `summary` is kept on the row's hover tooltip (nothing
  deleted). 🤖
- Shared, unit-tested helpers extracted while at it: `relative-time.ts`
  (the previously-duplicated "…ago" logic) and `format-bytes.ts` (the
  5×-duplicated byte formatter) now live in one place. 🤖

### LAMA-269 — Storage as a picture: donut + growth sparkline

- **Storage destinations page**: each destination row now shows a **donut**
  (its folders as slices, centre = total) and a **growth sparkline** (its
  size over time). Folders/Dashboard storage summary also gets a fleet
  donut. Pure inline-SVG components, no chart dependency. 🤖
- **"Not measured yet"** state instead of a fake zero: non-S3 backends and
  folders the server can't size render the explicit state. 🤖
- Real data behind it (your "full additive" call): a new `size_history`
  table records each measured folder size + a per-destination aggregate,
  and two additive endpoints serve it: `GET /folders/sizes` (bulk) and
  `GET /stats/storage/history`. Both documented in `reference/api.md`.
  ⚠️ **Relook candidates**:
  - Folders sharing one S3 bucket each report the *full bucket* size, so the
    donut slices are equal — the centre total uses the storage-report value
    instead to avoid n× inflation. Honest, but worth a look with real data.
  - The sparkline only grows as size measurements accumulate (every 15-min
    cache expiry) — it starts empty on a fresh install. That's by design.

### LAMA-282 — Device OS + storage used on the wire

- Device cards (Devices page) now show the device's **OS** (e.g.
  "Linux 6.8.0") and **storage used** ("123.5 GiB used"). The daemon reports
  both on every heartbeat; fields are additive/optional so older daemons
  and existing databases are unaffected (SCHEMA + MIGRATION included). 🤖
