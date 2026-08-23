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

### Platform decisions (agents, no owner input yet)

- Next-run sentence computed client-side via the shared `cron-parser`
  dependency (added to web-ui); no new server endpoint.

---

*(Future sessions: append a new dated section here instead of editing old
ones. The technical mirror of this is `docs/dogfood-2026-08-23.md`.)*