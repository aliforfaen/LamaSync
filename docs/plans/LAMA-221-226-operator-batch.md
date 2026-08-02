# LAMA-221..226 — operator/UX batch: notifications, backends, tailnet, stats, rename, browse writes

Status: **implemented** (2026-08-03, local commits, not pushed)
Branch: master (ahead of origin, pending operator go)

## Design decisions (agreed with operator)

| Issue | Decision |
|---|---|
| LAMA-221 | Channels live in a `notification_channels` table; env vars seed rows on first boot (idempotent). ntfy default severities `["critical","default"]` (preserves legacy info-suppression); webhook gets all three. Per-channel test button, severity toggles, masked URL with reveal. |
| LAMA-222 | New `backends` table + `Backend` entity. `folders.backend_id` references it; per-folder `s3_*` columns **lifted then dropped** (operator-approved). Secrets **encrypted at rest** (AES-256-GCM) under `LAMASYNC_SECRET_KEY` or a persisted `dataDir/secret.key`; legacy plaintext decodes via a `legacy:` prefix. Provider/endpoint/region validation moved to the Backend. |
| LAMA-223 | **Label-first** surfacing: daemon detects tailnet IP (`/proc/net/route` + `ip` + `tailscale status --json` fallback), heartbeats it, `/report/health` persists, config generator emits peer SFTP with `tailnetIp ?? lanIp`, UI columns/copy. Schema migration for `hosts.tailnet_ip` was missing and is now added. `usePeer` probes tailnet first, LAN fallback. |
| LAMA-224 | `GET /api/v1/stats/storage` (local via `du`, S3 via `rclone size`, restic from DB) with 5-min cache + `?refresh=1`; `GET /folders/:id/size` (15-min cache). Report invalidation on sync/backup/dotfile reports. Dashboard Storage card + totals; Folders Size column. Unreachable backends → per-entry `error`, never a failed report. |
| LAMA-225 | **Label-first rename**: PATCH changes `hosts.hostname` only — `hosts.id` stays the stable registration key so running daemons keep working (a PK change would 404 every heartbeat until restart). The PK cascade happens at **re-registration**: when the operator updates client.toml and the daemon restarts under the new name, `POST /register` re-keys the renamed row across ALL `host_id` tables (assignments, manifests, actions, conflicts, op log, restic, notifications, locks) preserving history. `host.renamed` WS event + banner; daemon logs `host renamed: a → b` on next config refresh. |
| LAMA-226 | Browse write ops run as `browse_jobs` (per-entry progress, WS events, 2s UI polling) + terminal `operation_log` rows (`browse_*`). Per-entry `rclone copyto` against a temp config built from the ref; move deletes source after success (local `rm -rf`, s3 `delete --rmdirs`). Destination-busy guard → 409. Upload is base64 JSON (≤ 64 MiB). UI: multi-select, Copy/Move picker modal (local/S3 breadcrumbs), New folder, Upload, inline Rename, jobs panel. |

## Scope notes

- The `Dashboard` "Failed operations (24h)" card was also compacted (time-ago labels + single-line ellipsis) as a UX fix requested during planning.
- `backends` delete is guarded while folders reference it (409).
- `LAMASYNC_SECRET_KEY` (≥ 16 chars) pins the encryption key; otherwise a random key is persisted at `<LAMASYNC_DATA_DIR>/secret.key` (0600).

## Verification

- `bun x tsc --noEmit` clean; `bun test` **366 pass / 1 skip / 0 fail** (39 files); `bun run build` produces all three binaries; `scripts/e2e-harness.sh` smoke passes.
- Live API verification against the built server binary: backends CRUD + secret masking, folder creation with `backendId`+bucket (400 without), stats report, env-seeded channels, host rename PATCH + `host_rename` op log, browse mkdir/copy with real files, browse jobs listing.
- New test files: `routes/backends.test.ts` (13), `routes/stats.test.ts` (5), `routes/browse-ops.test.ts` (8, real rclone against temp root), `daemon/src/lan-peer.test.ts` (10, tailnet parsers), plus updates to folders/config/browse/hosts/s3-list/notifications suites.

## Deferred / known limits

- Browse upload is base64-JSON only (≤ 64 MiB) — real multipart streaming is a future improvement.
- Storage stats for NFS mounts are not measured (no server-side mount paths today).
- `restic stats --json` is not spawned; snapshot sizes come from the DB (recorded at backup time).
- Dashboard "Since last visit" and WS-driven browse-job refresh are wired; byte-level rclone progress is not parsed (jobs show entry-count progress).
