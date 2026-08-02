# Handoff — human testing of the new web UI (2026-08-02)

Audience: in-browser agent assisting Aleksander with manual testing of the
LamaSync web UI shipped in commit `32e983f` (feat: add-host onboarding guide,
folder assign/unassign UI). Read this whole file before driving the browser.

## Where to test

| Environment | URL | API key |
|---|---|---|
| **Production (deployed 2026-08-02)** | `http://100.113.52.108:8080` (tailnet only) | In the container env on the LXC: `ssh -i ~/.ssh/lamasync_key root@lamasync 'docker inspect lamasync-server --format "{{range .Config.Env}}{{println .}}{{end}}" \| grep LAMASYNC_API_KEY'` |
| Local dev | `http://localhost:8080` | whatever `LAMASYNC_API_KEY` the dev server was started with (e.g. `dev-key`) |

Local dev runbook (rebuild after any web-ui change, then restart the server):

```bash
LAMASYNC_API_KEY=dev-key \
LAMASYNC_DATA_DIR=/tmp/lamasync-test \
LAMASYNC_BACKUP_DIR=/tmp/lamasync-test-backups \
  bun run dev:server
# after web-ui edits:
bun run build:web-ui
```

**Production caveat:** the production DB currently has **zero registered
hosts** (`hostCount: 0`) and uses a test-looking API key. Don't treat empty
states as bugs; bootstrap test data with the curl snippets below.

## Auth model (drives all agent behavior)

- Single pre-shared API key. Login page posts it to `GET /api/v1/health`; on
  success it's stored in `sessionStorage["lamasync_api_key"]`.
- **sessionStorage, not localStorage** — login does not survive a new tab or
  browser restart. Re-login is expected behavior, not a bug.
- Any 401 (HTTP or WebSocket) clears the key and bounces to `#/login`.
- Router is **HashRouter** — all URLs look like `http://host:8080/#/folders`.
- Live updates on the dashboard come from `WS /api/v1/ws` with subprotocol
  auth (`lamasync-auth, base64(apiKey)`).

## Page map (routes ↔ APIs in use)

| Route | Page | APIs consumed |
|---|---|---|
| `#/` | Dashboard ("Command Center") | `GET /health`, `GET /folders`, `GET /conflicts?status=pending`, `GET /shares`, `GET /restic/snapshots`, `GET /operations?limit=100`, WS `/ws` |
| `#/hosts` | Hosts list | `GET /hosts` |
| `#/hosts/:id` | Host detail | `GET /hosts/:id`, `GET /config/:id`, `GET /dotfiles/manifests?hostId=`, `GET /operations?hostId=`, `GET|POST /hosts/:id/actions` |
| `#/folders` | Folders | `GET /folders`, `GET /folders/:id/assignments`, `GET /hosts`, `POST /folders`, `PUT /folders/:id`, `DELETE /folders/:id`, **`POST /folders/:id/assign` (new)**, **`DELETE /folders/:id/assign/:hostId` (new)** |
| `#/dotfiles` | Dotfile manifests | `GET|POST /dotfiles/manifests`, `PUT|DELETE /dotfiles/manifests/:id`, `GET /health` |
| `#/conflicts` | Conflicts | `GET /conflicts?status=pending`, `POST /conflicts/:id/resolve` |
| `#/data` | Data Browser (read-only) | `GET /browse/local`, `GET /browse/s3`, `GET /browse/restic`, `GET /folders` |
| `#/admin` | Admin | `GET /notifications`, `POST /notifications/test`, `POST /admin/prune` |

Full REST surface (for API-level testing): Swagger UI at `/swagger` — no auth
needed to browse it.

## What's NEW in this deploy — focus testing here

### 1. Add-host onboarding (`#/hosts`, component `AddHostGuide.tsx`)

- **"Add host" button** in the Hosts toolbar toggles the guide; it also
  auto-opens when zero hosts are registered.
- Guide contents: 3 numbered steps — (1) `curl | bash` install command with
  `--server-url` prefilled from the page origin and `--api-key` masked as
  `<API_KEY>`, (2) `systemctl --user status lamasyncd`, (3) "host appears
  within a minute". Plus a collapsed "Manual setup" section with a
  `client.toml` snippet.
- **"Show command with my API key"** toggle reveals the real key inline.
- Every command block has a **Copy** button → button flips to "Copied" for
  ~1.5s; clipboard must contain exactly the displayed text.

### 2. Folder assign / unassign (`#/folders`)

- **"Assign" button** per folder row → inline form: host dropdown (only hosts
  not already assigned), role (`source`/`target`/`both`), local path,
  optional cron schedule.
- **"×" button** next to each assignment → confirm dialog → unassign.
- Edge cases to hit: no hosts registered (helpful empty message), all hosts
  already assigned ("Every registered host already has this folder
  assigned."), duplicate-assign prevention via dropdown filtering.

### 3. Regression checks on dogfood fixes (LAMA-205..210)

Nav wrap at ~1280px, primary-button contrast in dark+light, `#/login`
redirect when already authed, browse 404 vs 400/ENOTDIR. Detailed steps in
`docs/handoff/web-ui-final-pass-2026-08-02.md` section I.

## Test-data bootstrap (no real daemon needed)

```bash
KEY=<api-key>; BASE=http://100.113.52.108:8080/api/v1   # or localhost

# Register a fake host (id is client-supplied!)
curl -s -X POST $BASE/register -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"test-host-1","hostname":"fake-laptop","tailnetIp":"100.64.0.10"}'

# Heartbeat it (status shows online; add "version":"0.2.3" to test version display)
curl -s -X POST $BASE/report/health -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"hostId":"test-host-1","status":"online","version":"0.2.3"}'

# Create a folder to exercise assign/unassign
curl -s -X POST $BASE/folders -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"test-sync","type":"sync","backend":"sftp"}'
```

## Known issues — do NOT re-report (filed 2026-08-02, unassigned)

| Issue | Symptom |
|---|---|
| LAMA-211 (high) | Dotfiles: changing schedule preset while *editing* a manifest wipes appName/paths/excludes |
| LAMA-212 | HostDetail shows `[S][B][U][R]` hotkey hints; no keyboard handler exists |
| LAMA-213 | Conflicts resolve on single click, no confirm |
| LAMA-214 | Dashboard "Failed operations (24h)" item not clickable (no operations page) |
| LAMA-215 | `POST /folders/:id/assign` accepts non-existent hostId server-side |
| LAMA-216 (high) | TUI backup wizard coded but unwired (not web UI, but may come up) |
| LAMA-217 | Dead icons, brittle 401 string-match in Login |

Anything else odd → file a new Multica issue in the LamaSync project
(`--project f430dbc3`), unassigned.

## Browser-agent tooling notes

- From the LAMA-207 post-mortem: clicks on **below-fold elements** can
  silently miss in agent-browser; scroll the element into view first and
  re-locate the element after any DOM change before clicking.
- Theme toggle is in the nav (dark/light/system cycle) — screenshots for
  contrast issues should name the active theme.
- The full pre-existing test matrix for older features (dashboard, themes,
  notifications, data browser) is `docs/handoff/command-center-testing.md`;
  the new-feature matrices are sections J/K of
  `docs/handoff/web-ui-final-pass-2026-08-02.md`.
