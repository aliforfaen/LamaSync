# Features & limitations — LamaSync

## What's implemented

|Component|Status|
|---|---|
|`@lamasync/core` — shared types, DB schema, TOML config, API client|done|
|`@lamasync/server` — REST + WebSocket + Swagger + auth|done|
|`@lamasync/daemon` — heartbeat, rclone execution, mounts, scheduler, socket server|done|
|`@lamasync/tui` — Single tabbed shell with 6 views + guided wizards + CLI fallback (LAMA-173)|done|
|`@lamasync/web-ui` — React SPA embedded in the server binary (Dashboard, Folders, Dotfiles, Conflicts, Admin)|done|
|Agent skill (`lamasync-server.md`)|done (+ installed)|
|Docker: `Dockerfile.server`, `docker-compose.yml`|done|
|`bun run build` → standalone binaries|working|
|Unit tests (core + server + daemon + self-update + TUI + executor + offset + web-ui + wizard)|passing|
|End-to-end smoke verification (health, register, folders, dotfiles, daemon, TUI, web UI)|done|

## Implemented features by issue

| Issue | Feature | Location |
|-------|---------|----------|
| LAMA-114 | Bandwidth scheduling (`--bwlimit`) | `daemon/src/executor.ts`, `folders.ts` |
| LAMA-116 | Disk-space pre-flight | `daemon/src/executor.ts` |
| LAMA-117 | Operation-log retention | `server/src/routes/admin.ts`, `server/src/index.ts` |
| LAMA-118 | WebSocket auth via subprotocol | `server/src/ws.ts`, `server/src/auth.ts`, `tui/src/views/fleet.ts` |
| LAMA-119 | Dry-run mode | `daemon/src/executor.ts` |
| LAMA-120 | `"git"` folder type | `daemon/src/executor.ts` |
| LAMA-104 | Error handling (core hardening) | `server/src/routes/report.ts`, `core/src/api-client.ts`, `server/src/index.ts`, `daemon/src/lock.ts`, `daemon/src/report-queue.ts`, `daemon/src/hooks.ts` |
| LAMA-162 | Automatic conflict strategies (`newer_wins`, `source_wins`, `keep_both`) | `core/src/types.ts`, `daemon/src/executor.ts` |
| LAMA-109 | App-specific "backup" dotfile system | `core/src/types.ts`, `core/src/db/schema.ts`, `server/src/routes/dotfiles.ts`, `server/src/routes/config.ts`, `daemon/src/executor.ts`, `tui/src/views/dotfiles.ts` |
| LAMA-123 | LAN peer sync | `daemon/src/lan-peer.ts`, `server/src/routes/config.ts` |
| LAMA-124 | Encryption-at-rest | `server/src/routes/folders.ts`, `server/src/routes/config.ts` |
| LAMA-125 | `ARCHITECTURE.md` rewrite | `ARCHITECTURE.md` |
| LAMA-151 | Self-update (daemon + server release proxy) | `daemon/src/self-update.ts`, `server/src/routes/release.ts`, `packaging/install/update.sh` |
| LAMA-147 | Management Web UI (dashboard + admin CRUD) | `packages/web-ui/`, `packages/server/src/routes/web-ui.ts`, `scripts/inline-web-ui.ts` |
| LAMA-173 | TUI unification: tabbed shell, 6 views, guided wizards | `packages/tui/src/{boot.ts,index.ts,app/*,views/*,flows/*}` |
| LAMA-168 | Dotfile manifest improvements: excludes, host selector, cron presets + `@reboot`/`@login`, deployment tracking (last sync, direction, original uploader) | `core/src/{types.ts,db/schema.ts}`, `server/src/routes/{dotfiles.ts,config.ts,report.ts}`, `daemon/src/{executor.ts,scheduler.ts}`, `web-ui/src/pages/Dotfiles.tsx`, `tui/src/{flows/dotfile-manifest.ts,views/dotfiles.ts,app/schedule-presets.ts}` |
| LAMA-199 | Version & update visibility: daemon version in heartbeat, server-side `updateAvailable` vs cached GitHub release | `core/src/{types.ts,db/schema.ts,version-compare.ts}`, `server/src/{release-cache.ts,routes/{hosts.ts,health.ts,release.ts}}`, `daemon/src/index.ts`, `web-ui/src/pages/Dashboard.tsx` |
| LAMA-201 | Theme & design-token pass (dark/light) + inline SVG domain icons | `web-ui/src/{index.css,theme.ts,main.tsx,components/{Nav.tsx,icons.tsx}}` |
| LAMA-197 | Command Center dashboard v1 (landing page): needs-attention triage, fleet cards, live activity feed, quick actions | `web-ui/src/pages/Dashboard.tsx`, `web-ui/src/index.css` |
| LAMA-198 | Host list + detail pages; queued-action model (trigger_sync/backup, check_update, refresh_config) + config-revision auto-refresh | `core/src/{types.ts,db/schema.ts,api-client.ts}`, `server/src/{config-revision.ts,routes/{actions.ts,hosts.ts,config.ts,folders.ts,dotfiles.ts}}`, `daemon/src/{index.ts,actions.ts}`, `web-ui/src/pages/{Hosts.tsx,HostDetail.tsx}` |
| LAMA-200 | Notification foundation: ntfy + LamaDB webhook + durable event log + host-staleness sweep | `server/src/{notifications.ts,routes/notifications.ts}`, `web-ui/src/pages/Admin.tsx` |
| LAMA-202 | Read-only Data Browser (local dir, SigV4 S3 listing, restic metadata) | `server/src/{browse-paths.ts,s3-list.ts,routes/browse.ts}`, `web-ui/src/pages/DataBrowser.tsx` |
| LAMA-203 | "Since last visit" highlighting on Command Center | `web-ui/src/pages/Dashboard.tsx` |
| LAMA-221 | Notification channels config UI (ntfy + webhook, severity filters, test button, env seeding) | `server/src/{notifications.ts,routes/notifications.ts}`, `core/src/db/schema.ts`, `web-ui/src/pages/Admin.tsx` |
| LAMA-222 | Reusable S3 backends: credentials stored once (encrypted at rest), folders reference by backendId; legacy s3_* columns lifted+dropped | `core/src/{types.ts,db/schema.ts,api-client.ts}`, `server/src/{crypto.ts,backends.ts,routes/backends.ts,routes/{config,folders,browse}.ts}`, `web-ui/src/pages/{Backends,Folders}.tsx` |
| LAMA-223 | Tailnet IP surfacing: daemon detection + heartbeat, tailnet-first peer rclone config, UI columns/copy | `daemon/src/{lan-peer.ts,index.ts}`, `server/src/routes/{hosts,config}.ts`, `web-ui/src/pages/{Hosts,HostDetail,Dashboard}.tsx`, `tui/src/views/fleet.ts` |
| LAMA-224 | Storage stats: per-backend report + folder sizes (cached), Dashboard Storage card, Folders Size column | `core/src/types.ts`, `server/src/{stats.ts,routes/stats.ts,routes/folders.ts,routes/report.ts}`, `web-ui/src/pages/{Dashboard,Folders}.tsx` |
| LAMA-225 | Host rename: PATCH /hosts/:id (label-first, id stable), re-key cascade on re-registration, host_renamed WS + banner, inline edit | `server/src/routes/hosts.ts`, `core/src/api-client.ts`, `web-ui/src/{components/EditableHostname.tsx,pages/{Hosts,HostDetail}.tsx}`, `daemon/src/index.ts` |
| LAMA-226 | Data Browser write ops: copy/move/rename/mkdir/upload with jobs + progress + busy guard | `core/src/{types.ts,db/schema.ts}`, `server/src/{browse-jobs.ts,routes/browse.ts}`, `web-ui/src/pages/DataBrowser.tsx` |
| hidden-api-power | Per-folder "Sync now" + dry-run: daemon `runOnce` dryRun option, `trigger_sync` dryRun payload with `dry-run:` ack prefix, Folders/HostDetail enqueue buttons | `daemon/src/{index.ts,actions.ts}`, `web-ui/src/{pages/{Folders,HostDetail}.tsx,api.ts}` |
| hidden-api-power | Assignment editing: inline AssignmentEditor (path/role/schedule/conflict strategy + advanced), pause/resume toggle, PATCH route extended with role/localPath/bandwidthSchedule | `web-ui/src/{components/AssignmentEditor.tsx,pages/{HostDetail,Folders}.tsx}`, `server/src/routes/folders.ts` |
| hidden-api-power | Host delete/decommission UI (cascade confirm, navigate on success) | `web-ui/src/pages/{Hosts,HostDetail}.tsx`, `api.ts` |
| hidden-api-power | Dotfile versions on web: expandable per-app versions, download (auth-header blob fetch) + delete | `web-ui/src/{pages/Dotfiles.tsx,api.ts}` |
| hidden-api-power | Backend kinds `local`/`nfs`/`restic`: server-side path targets + centralized restic repo/password defaults, per-kind validation + all-kind test endpoint, rclone config gen, folder picker | `core/src/{types.ts,db/schema.ts}`, `server/src/{backends.ts,routes/{backends,config,folders}.ts}`, `web-ui/src/pages/{Backends,Folders}.tsx` |
| hidden-api-power | Conflicts history (Pending/Resolved/All tabs, name resolution, resolution record) + Operations active-locks panel + host filter | `web-ui/src/pages/{Conflicts,Operations}.tsx`, `index.css` |
| onboarding-pass | Concept glossary + hint components, first-run checklist on Dashboard, login hint, form/empty-state coaching, Swagger link | `web-ui/src/{concepts.ts,components/{Hint,GettingStarted,Login,Nav}.tsx,pages/{Dashboard,Folders,Dotfiles,Conflicts,Operations,HostDetail,Backends}.tsx,index.css}` |
| tui-foundations | TUI first-run setup flow (client.toml writer, no silent localhost/dev-key defaults), `?` help overlay + global key hints + per-view hotkey footers, friendlyError() at catch sites, Fleet live status (fleetService.start + socket error listeners), `q`-quit fix on Conflicts, Logs footer single-source, wizard validation (absolute localPath, cron sanity) + emoji cleanup | `tui/src/{api.ts,boot.ts,friendly-error.ts,flows/{setup,backup-setup}.ts,app/{shell,cron,fleet-service}.ts,views/{conflicts,logs,local,fleet,dotfiles}.ts}` |
| remaining-features | Per-folder sync history: Operations page folder filter + `?folderId=`/`?hostId=` deep links from Folders/HostDetail History buttons | `web-ui/src/pages/{Operations,Folders,HostDetail}.tsx`, `web-ui/src/api.ts` |
| remaining-features | Restic restore UI: restore modal + jobs panel (2s polling) on the DataBrowser restic tab | `web-ui/src/pages/DataBrowser.tsx`, `web-ui/src/api.ts` |
| remaining-features | Data Browser delete + download: job-based `POST /browse/delete` (deletefile/purge), base64 `POST /browse/download` (64 MiB cap, realpath containment) | `server/src/{browse-jobs.ts,routes/browse.ts}`, `web-ui/src/pages/DataBrowser.tsx` |
| LAMA-227 | Agent surface umbrella: CLI-first `lamasync` is the primary agent surface; the REST/WS API is the escape hatch. No MCP server, no per-user auth, six safety rules as the contract. | `docs/handoff/2026-08-11-agent-surface-cli-skill.md` |
| LAMA-229 | CLI v1: workflow subcommands in the `lamasync` binary (`status`, `folders list|create|assign`, `backends list|create|test`, `sync`, `ops list`, `doctor`, `local status|folders|ops|sync|sync-all|mount|unmount`); `--json` everywhere; exit codes 0/1/2/3/4; auth discovery flags > env > client.toml; key masking `lamasync_…xxxx` | `packages/tui/src/cli/`, `packages/tui/src/index.ts`, `packages/core/src/api-client.ts` |
| LAMA-230 | Agent skill: two-tier bundle (`SKILL.md` + `reference/{cli,api,recipes,troubleshooting,safety}.md`), install pipeline (`~/.lamasync/install-state.json` persisted; default-on, opt-out), `lamasyncd --update skill` refresh, `packaging/build-skill-tarball.sh` ships `lamasync-skill-<version>.tar.gz` as a release asset, `scripts/check-skill-drift.ts` runs in CI | `packages/agent-skill/`, `packaging/{build-skill-tarball.sh,install/}`, `packages/daemon/src/{index.ts,skill-update.ts}`, `scripts/check-skill-drift.ts`, `.github/workflows/ci.yml` |
| LAMA-231 | CLI full CRUD coverage: `folders update|delete|unassign|assignments`, `dotfiles list|upload|download|manifests`, `conflicts list|resolve`, `snapshots list`, `restore`, `browse local|s3|restic|jobs`, `notifications list|channels`, `hosts list|rename`, `register`, `shares list`, `admin prune`. Destructive commands prompt on a TTY, require `--yes` non-interactively (safety rule 5). | `packages/tui/src/cli/{folders-ext,dotfiles,conflicts,snapshots,browse,notifications,hosts,admin,safety}.ts`, `packages/tui/src/cli/dispatch.ts`, `packages/core/src/api-client.ts` |
| remaining-features | Shared `Modal`/`ConfirmDialog`/`PromptDialog` replacing all window.prompt/confirm; prune + overwrite confirmations | `web-ui/src/components/Modal.tsx`, `web-ui/src/pages/{Admin,DataBrowser}.tsx` |
| remaining-features | Admin Server block: `GET /health` extended with serverVersion + dbSizeBytes, latest-release check with update badge | `server/src/routes/health.ts`, `server/src/db.ts`, `web-ui/src/pages/Admin.tsx` |
| remaining-features | Validation sweep: shared cron validator on Folders, backend endpoint/bucket/path checks, centralized ApiError envelope parsing; Dashboard storage error surfaced, Login remember-me, sync-note name resolution | `web-ui/src/{cron.ts,api.ts,pages/*}` |
| LAMA-238 | In-form backend connection test: `POST /backends/test` validates an unsaved backend config (write-only fields fall back to the stored secret via `backendId`), shared helpers with the per-id test, "Test connection" button + inline result in the Add/Edit backend form | `server/src/{backend-test.ts,routes/backends.ts}`, `core/src/api-client.ts`, `web-ui/src/{api.ts,pages/Backends.tsx}` |
| LAMA-235 | Host filter in the Folders view (Dotfiles-style scope selector: All hosts + each host; filters rows to folders with an assignment on the selected host) | `web-ui/src/pages/Folders.tsx` |
| LAMA-241 | Client-onboarding rough edges: socket `sync` accepts `folder` alias + returns `folder not found: X` instead of silent `started:true`; `POST /folders` defaults to the first existing backend (400 only when none exist) with the UI preselecting it; daemon warns "local path missing, waiting for first use" per assignment; `PUT/PATCH/DELETE /assignments/:id` return 405 pointing at `/folders/:folderId/assign/:hostId` | `daemon/src/{socket.ts,config.ts,index.ts}`, `server/src/routes/{folders.ts,actions.ts}`, `web-ui/src/pages/Folders.tsx` |
| LAMA-232 | Action reclaim: stale 'taken' actions reaped back to 'pending' inside `GET /actions/pending` (10 min threshold); `GET /actions/taken` returns a host's taken actions for daemon boot-time reclaim; daemon re-executes orphaned actions at boot + polls immediately | `server/src/routes/actions.ts`, `core/src/api-client.ts`, `daemon/src/index.ts` |
| LAMA-243 | Update-check throttle + server proxy: daemon routes release checks through the cached `GET /api/v1/release/latest` proxy instead of api.github.com directly (`LamaSyncApiClient.getLatestRelease()`); persisted 15-min cooldown (`~/.config/lamasync/update-state.json`) bounds crash-loop re-checks; generated systemd unit sets `StartLimitIntervalSec=300`/`StartLimitBurst=8`; optional `LAMASYNC_GITHUB_TOKEN` env var adds auth to the server's release fetch | `core/src/api-client.ts`, `daemon/src/{index.ts,update-check.ts,systemd.ts}`, `server/src/release-cache.ts` |

## Known limitations

### Server
- **User management / OAuth** — the API key is the only auth mechanism. Multi-user setups would need a `tokens` table, roles, and key rotation.
- **Ntfy notifications** — server config has `ntfyUrl` but it's unused.
- **Operation log retention beyond daily pruning** — retention is configurable; long-term archival is not.

### TUI
- **Dotfile diff preview** — restore does not yet show a diff against current disk files before extraction.

### LAN peer tailnet preference (LAMA-223)
- **Stale `tailnet_ip` never clears** — when a daemon's tailscale interface goes down, the field stays at its last value until the next successful detection. With tailnet preferred in peer rclone configs (P1-4), a stale address can strand peers — the daemons probe both tailnet and LAN sections before declaring the peer unreachable, so the worst case is a 5s sync delay, not a failure.

### Host rename hijack window (LAMA-225)
- The PATCH-then-reregister rename model (label-only PATCH, id re-key on re-registration) has a brief window where any machine claiming the new hostname absorbs the host identity (history, folders, dotfiles). The single-API-key trust model accepts this; the alternative would be a signed re-registration handshake. Acceptable for a personal sync fleet; document it for any multi-tenant rollout.

### Infrastructure
- **Windows/WSL support** — paths hardcoded to Unix conventions. rclone works on Windows but the daemon does not.
- **Server-side in-place self-update** — Docker/CI/CD is the path for the server; a live binary replacement path for the server is not built (the daemon/TUI self-update exists, LAMA-151).

## Future ideas (not planned)
- Health dashboard with predictive transfer-throughput alerts.
- Preset manifest packs (`dev-node`, `dev-python`, `omp`).
- `nix` folder type that triggers `home-manager switch` after sync.
- Git-folder sync with ahead/behind and dirty-worktree reporting.
