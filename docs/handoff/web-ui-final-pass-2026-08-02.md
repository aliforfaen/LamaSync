# Web UI final pass — testing guide (2026-08-02)

Covers everything changed or found in the final-pass review of the web UI.
For the full LAMA-183 test matrix (sections A–H) and the dev-stack runbook,
see `docs/handoff/command-center-testing.md` — this guide only adds what is
new since then.

## Runbook (quick)

```bash
# Terminal 1 — server (serves the web UI at http://localhost:8080)
LAMASYNC_API_KEY=dev-key \
LAMASYNC_DATA_DIR=/tmp/lamasync-test \
LAMASYNC_BACKUP_DIR=/tmp/lamasync-test-backups \
  bun run dev:server

# Rebuild the embedded web UI after any packages/web-ui change, then restart the server:
bun run build:web-ui
```

Log in at `http://localhost:8080` with `dev-key`.

Fake a host without a real daemon (registers + heartbeats):

```bash
curl -s -X POST http://localhost:8080/api/v1/register \
  -H "Authorization: Bearer dev-key" -H "Content-Type: application/json" \
  -d '{"hostname":"fake-laptop","tailnetIp":"100.64.0.10"}'

curl -s -X POST http://localhost:8080/api/v1/report/health \
  -H "Authorization: Bearer dev-key" -H "Content-Type: application/json" \
  -d '{"hostId":"<id-from-register>","status":"online","version":"0.2.3"}'
```

## I. Dogfood-fix regressions (LAMA-205..210, commits 41c7cad + f6af765)

| # | Check | Steps | Expected |
|---|-------|-------|----------|
| I1 | Nav wrap (LAMA-205) | Resize browser to ~1280px wide with all 7 nav items visible | Nav wraps to two lines, nothing clipped |
| I2 | Primary-button contrast (LAMA-206) | Cycle theme (nav toggle) dark → light; look at "New folder", "Add host", "Send test notification" buttons | Readable label contrast in both themes; colors come from `--accent-primary-rgb` token |
| I3 | Stale /login redirect (LAMA-208) | While logged in, open `http://localhost:8080/#/login` directly | Redirected to `#/` (dashboard), login form not shown |
| I4 | Browse 404 (LAMA-209) | Data Browser → Local tab → navigate to a path that does not exist via URL manipulation, or `curl -s -H "Authorization: Bearer dev-key" "http://localhost:8080/api/v1/browse/local?path=/definitely/not/here"` | 404 with clean error message, not 500 |
| I5 | ENOTDIR sanitization (LAMA-210) | `curl -s -H "Authorization: Bearer dev-key" "http://localhost:8080/api/v1/browse/local?path=/etc/hostname"` (a file, not a dir) | 400 "path is not a directory" — no raw fs error leaked |

## J. Add-host onboarding (new, this pass)

The Hosts page now has an **Add host** button (toolbar) and shows the guide
automatically when no hosts are registered.

| # | Check | Steps | Expected |
|---|-------|-------|----------|
| J1 | Guide renders | Hosts → Add host | Panel with 3 numbered steps, copy buttons, manual-setup `<details>` section |
| J2 | Server URL prefilled | Inspect the install command | `--server-url` matches the origin you're browsing (e.g. `http://localhost:8080`) |
| J3 | Key masked by default | Inspect the install command | `--api-key <API_KEY>` placeholder, real key NOT visible |
| J4 | Key reveal | Click "Show command with my API key" | Real key inline; button flips to "Hide API key" |
| J5 | Copy buttons | Click Copy on each block | Button reads "Copied" for ~1.5s; clipboard contains exactly the displayed text |
| J6 | Empty state | Fresh DATA_DIR, no hosts | Guide visible without clicking; "No hosts registered yet" below it |
| J7 | End-to-end | Run the copied install command on a test machine (or `scripts/e2e-sandbox`) | Host appears in the list within ~60s |

## K. Folder assign / unassign (new, this pass)

The Folders page closes the parity gap with the TUI wizard and the
`POST/DELETE /folders/:id/assign[/:hostId]` endpoints.

| # | Check | Steps | Expected |
|---|-------|-------|----------|
| K1 | Assign form | Folders → Assign (any row) | Inline form: host select (only unassigned hosts), role (source/target/both), local path, optional cron |
| K2 | Assign submit | Pick host, role `both`, path `~/test-sync`, submit | Assignment appears in the row's assignment list; 201 from API |
| K3 | Host filtering | Assign the same folder to a second host | First host no longer in the dropdown |
| K4 | All assigned | Assign to every host, click Assign again | "Every registered host already has this folder assigned." |
| K5 | No hosts | Fresh DATA_DIR, create folder, click Assign | "No hosts registered yet — add one from the Hosts page first." |
| K6 | Unassign | Click × next to an assignment, confirm | Assignment removed; config revision bumped (host re-pulls config) |
| K7 | Daemon pickup | With a real daemon running: assign, wait ≤5min (or enqueue Refresh config from HostDetail) | Daemon syncs the new folder; operation visible on Dashboard/HostDetail |

## Known issues found in this pass (reported, NOT fixed)

Fix these later; reproduction steps included so you can confirm.

1. **Dotfiles edit-form clobber (bug).** `packages/web-ui/src/pages/Dotfiles.tsx:156-163` —
   `updateSchedule` spreads the *create* form state even when called from the
   edit form. Repro: Dotfiles → create a manifest → Edit it → change the
   schedule preset dropdown → appName/paths/excludes are silently reset to the
   create form's values. Saving then corrupts the manifest.
2. **Dead hotkey hints.** `packages/web-ui/src/pages/HostDetail.tsx:187` renders
   `[S] [B] [U] [R]` hints but no keydown handler exists in the web UI. Either
   wire the keys or remove the hints.
3. **No conflict-resolve confirmation.** `pages/Conflicts.tsx` resolves on
   single click; the TUI has a two-press confirm. One misclick = data decision.
4. **Dead code.** `components/icons.tsx` `IconBackup` (:57) and `IconUpdate` (:95)
   are never imported.
5. **Brittle 401 detection.** `components/Login.tsx:27` matches
   `err.message.includes("401")` instead of checking `ApiError.status`.
6. **"Failed operations" not clickable.** Dashboard attention item
   (`Dashboard.tsx:193`) has no link target — there is no operations page in
   the web UI (TUI has a Logs view; web UI only shows 20 rows on the dashboard
   and per-host on HostDetail).

## Remaining parity gaps (web UI vs TUI/daemon) — informational

Web UI still cannot: trigger sync-all/sync-one directly (only via queued
actions), cycle cache profiles, switch sync↔mount, preview dotfile tarballs,
restore dotfiles, adopt GitHub repos, or view a fleet-wide operations log.
TUI still cannot: enqueue queued actions, manage assignments (beyond the
unwired backup wizard), edit/delete manifests, browse data, send test
notifications, or prune the operation log. The two UIs are complementary, not
redundant.
