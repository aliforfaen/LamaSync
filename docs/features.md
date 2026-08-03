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
