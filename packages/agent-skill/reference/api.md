# REST + WebSocket API reference (escape hatch)

The CLI in `reference/cli.md` is the primary agent surface. This file is
the escape hatch when (a) the CLI doesn't express a one-off operation
that is allowed by the API, or (b) you are debugging the CLI itself.

**Always prefer fetching the live OpenAPI 3 spec** at
`GET /swagger/json` for exact request/response field names when writing
write calls. The CLI / web UI / Swagger UI all consume the same source of
truth, so what `/swagger/json` says is what the server actually enforces.

> "Don't trust this document for schema details — trust /swagger/json."
> If this file disagrees with the live spec, the live spec wins, and the
> drift-check should be reporting the gap. File it.

## Auth

Single header on every request:

```
Authorization: Bearer <LAMASYNC_API_KEY>
```

`401 Unauthorized` when missing or wrong. `403 Forbidden` is reserved for
per-resource revocation (none today; do not invent it — safety rule 1).

## Base URL

The server listens on a configurable port (default `8080`). On the
tailnet-deployed production instance:

```
http://<lamasync-server-tailnet-ip>:8080
```

For local dev: `http://127.0.0.1:8080`.

## Endpoints (read this list as "what exists", not "what's right")

All paths are under `/api/v1/` unless noted.

| Method   | Path                                       | Purpose                                          |
|----------|--------------------------------------------|--------------------------------------------------|
| GET      | `/health`                                  | Fleet summary + per-host status + `serverVersion`, `dbSizeBytes` |
| POST     | `/register`                                | Register or update a host                        |
| GET      | `/hosts`                                   | List every registered host                       |
| GET      | `/hosts/:hostId`                           | Get one host by id                               |
| PATCH    | `/hosts/:hostId`                           | Rename host's display label (id stays stable)    |
| DELETE   | `/hosts/:hostId`                           | Delete host + cascade                            |
| POST     | `/report/health`                           | Host heartbeat                                   |
| GET      | `/config/:hostId`                          | Bundled config (assignments + rclone section)    |
| POST     | `/hosts/:hostId/actions`                   | Enqueue a control-plane action                   |
| GET      | `/hosts/:hostId/actions`                   | Action history for the host                      |
| GET      | `/actions/pending`                         | Daemon poll: claim pending actions               |
| GET      | `/actions/taken?hostId=...`                | Daemon boot-time reclaim: a host's taken actions |
| POST     | `/actions/:id/complete`                    | Daemon ack: mark action done/failed              |
| GET      | `/release/latest`                          | Latest GitHub release info (proxy)               |
| GET      | `/folders`                                 | List folders                                     |
| POST     | `/folders`                                 | Create folder                                    |
| GET      | `/folders/:id`                             | Read one folder                                  |
| PUT      | `/folders/:id`                             | Update folder (PATCH-style partial also OK)      |
| DELETE   | `/folders/:id`                             | Delete folder + cascade assignments              |
| POST     | `/folders/:id/assign`                      | Assign folder to a host                         |
| GET      | `/folders/:id/assignments`                 | List assignments for a folder                    |
| PATCH    | `/folders/:id/assign/:hostId`              | Update one assignment (role, schedule, ...)      |
| DELETE   | `/folders/:id/assign/:hostId`              | Unassign                                         |
| PUT      | `/assignments/:id`                         | Intentional 405 — assignments are addressed by folder+host; use `/folders/:folderId/assign/:hostId` |
| PATCH    | `/assignments/:id`                         | Intentional 405 — use `/folders/:folderId/assign/:hostId` |
| DELETE   | `/assignments/:id`                         | Intentional 405 — use `/folders/:folderId/assign/:hostId` |
| GET      | `/folders/:id/size`                        | Last-known working-set size (S3 only; 15-min cache) |
| GET      | `/folders/sizes`                           | Bulk last-known working-set sizes for all folders (S3 only; 15-min cache) |
| GET      | `/backends`                                | List reusable backends                           |
| POST     | `/backends`                                | Create backend (secrets encrypted at rest)        |
| GET      | `/backends/:backendId`                     | Read one backend                                 |
| PATCH    | `/backends/:backendId`                     | Update/rotate backend credentials                |
| DELETE   | `/backends/:backendId`                     | Delete backend (409 while folders use it)        |
| POST     | `/backends/:backendId/test`                | Test connection (rclone lsd, 5s timeout)         |
| POST     | `/backends/test`                           | Test a backend DRAFT without persisting (write-only secret fields may fall back to the stored value via `backendId`) |
| GET      | `/dotfiles/manifests`                      | List dotfile manifests                           |
| POST     | `/dotfiles/manifests`                      | Create a manifest                                |
| PUT      | `/dotfiles/manifests/:id`                  | Update a manifest                                |
| DELETE   | `/dotfiles/manifests/:id`                  | Delete a manifest + cascade                      |
| GET      | `/dotfiles?hostId=...`                     | List dotfile versions for a host                 |
| GET      | `/dotfiles/:appName`                       | List versions of a dotfile app                   |
| POST     | `/dotfiles/:appName`                       | Upload a new version (multipart `tarball`)       |
| GET      | `/dotfiles/:appName/:version`              | Download a tarball                               |
| DELETE   | `/dotfiles/:appName/:version`              | Delete a version (DB row + file)                 |
| POST     | `/report`                                  | Append an `operation_log` row                    |
| GET      | `/operations`                              | Query the operation log                          |
| GET      | `/operations/locks`                        | List active per-folder locks                     |
| POST     | `/operations/acquire`                      | Acquire folder lock (daemon executor)            |
| POST     | `/operations/heartbeat`                    | Heartbeat an existing lock                       |
| POST     | `/operations/release`                      | Release folder lock                              |
| GET      | `/shares`                                  | List NFS / SMB shares                            |
| POST     | `/admin/prune?olderThanMs=<ms>`            | Manually trim operation_log                      |
| GET      | `/demo`                                   | Demo-mode state (whether demo data is present)  |
| POST     | `/demo/seed`                              | Seed a demo fleet (fake devices, timeline, snapshot) |
| DELETE   | `/demo`                                   | Delete all demo data (confirmed by caller)      |
| GET      | `/notifications`                           | Durable notification history                      |
| GET      | `/notifications/channels`                  | List delivery channels                           |
| POST     | `/notifications/channels`                  | Create channel                                   |
| PATCH    | `/notifications/channels/:channelId`       | Update channel                                   |
| DELETE   | `/notifications/channels/:channelId`       | Delete channel                                   |
| POST     | `/notifications/test`                      | Record + deliver a test event                    |
| GET      | `/browse/local`                            | Browse server backup dir                         |
| GET      | `/browse/s3`                               | S3 prefix listing (LAMA-202)                      |
| GET      | `/browse/restic`                           | Restic snapshot listing                          |
| POST     | `/browse/copy`                             | Copy entries (job)                               |
| POST     | `/browse/move`                             | Move entries (job)                               |
| POST     | `/browse/rename`                           | Rename entry (job)                               |
| POST     | `/browse/mkdir`                            | Create directory (job)                           |
| POST     | `/browse/upload`                           | Upload base64 file (≤ 64 MiB) (job)               |
| POST     | `/browse/download`                         | Download a file to base64 (LAMA-226)              |
| POST     | `/browse/delete`                           | Delete entries (job)                              |
| GET      | `/browse/jobs`                             | Recent browse write jobs                         |
| GET      | `/stats/storage`                           | Storage report (5-min cache)                     |
| GET      | `/stats/storage/history`                   | Per-backend size time series for the growth sparkline (LAMA-269) |
| GET      | `/restic/snapshots`                        | List restic snapshots                            |
| POST     | `/restic/snapshots`                        | Daemon reports a new snapshot                    |
| GET      | `/restic/restore`                          | List restore jobs                                |
| POST     | `/restic/restore`                          | Create restore job                               |
| POST     | `/restic/restore/:id/status`               | Update restore job status                        |
| GET      | `/conflicts`                               | List manual sync conflicts                       |
| POST     | `/conflicts`                               | Bulk-create conflicts                            |
| POST     | `/conflicts/:id/resolve`                   | Resolve conflict (local/remote/both)             |
| WS       | `/ws`                                      | Fleet event stream (subprotocol auth, LAMA-118)   |
| GET      | `/swagger/json`                            | Live OpenAPI 3 spec                              |
| GET      | `/swagger`                                 | Swagger UI                                       |
| GET      | `/`                                        | Management Web UI (React SPA)                    |

## WebSocket auth (LAMA-118)

The `Sec-WebSocket-Protocol` header carries auth. The server accepts three
encodings of the API key in the second subprotocol slot:

1. the raw key
2. base64
3. unpadded base64url (RFC 6455 forbids `=` padding in a subprotocol token)

```js
const token = btoa(LAMASYNC_API_KEY)
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
const ws = new WebSocket(
  "ws://<lamasync-server-tailnet-ip>:8080/api/v1/ws",
  ["lamasync-auth", token],
);
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

Events: `operation`, `host`, `host_renamed`, `lock`, `mount`, `conflict`,
`restic_snapshot`, `restic_restore`, `action`, `browse_job`. Their shapes
live in the OpenAPI 3 spec at `/swagger/json` under `WSEvent`.

## Schemas

For exact request/response shapes and field nullability, prefer the live
spec. The high-level shapes (verbose commentary):

- `Host { id, hostname, tailnetIp?, lanIp?, lastSeen?, status, version?, updateAvailable?, configRevision? }`
- `Folder { id, name, type, createdAt?, encrypted?, cryptPassword?, backend?, backendId?, s3Bucket?, gitProvider?, gitRemote? }`
- `FolderAssignment { id, folderId, hostId, role, localPath, remoteName?, syncExpr?, enabled, conflictStrategy?, preSyncCmd?, postSyncCmd?, ignorePath?, mountIgnorePath?, timeoutSec?, bandwidthSchedule?, maxRetries?, availableSpaceThreshold?, cacheProfile?, cacheMaxSize?, resticRepository?, resticPassword? }`
- `Backend { id, name, kind, s3Provider?, s3Endpoint?, s3Region?, s3AccessKeyId?, hasSecret?, s3SecretAccessKey? (write-only), localPath?, resticRepository?, hasResticPassword?, resticPassword? (write-only), createdAt }`
- `OperationLog { id, timestamp, hostId, folderId?, operation, status, summary?, details?, durationMs? }`
- `DotfileManifest { id, hostId, appName, paths[], excludes[]?, schedule?, instructions?, lastSyncAt?, lastSyncDirection?, originalUploaderHostId? }`
- `DotfileVersion { id, manifestId, timestamp, tarballPath, sizeBytes?, checksum?, description? }`
- `ResticSnapshot { id, snapshotId, folderId, hostId, timestamp, paths[], sizeBytes?, tags? }`
- `ResticRestoreJob { id, snapshotId, folderId, targetHostId, targetPath, include[]?, status, createdAt, resolvedAt?, error? }`
- `Conflict { id, hostId, folderId, path, localMtime?, remoteMtime?, status, resolution?, createdAt, resolvedAt? }`
- `QueuedAction { id, hostId, type, payload?, status, createdAt, takenAt?, completedAt?, result? }`
- `LockInfo { folderId, lockedBy, lockedAt, lockTtl }`

`?`-marked fields are nullable. Timestamps are milliseconds since epoch.

## Operational notes

- The DB file is `<LAMASYNC_DATA_DIR>/lamasync.db`. Don't move or rename
  it while the server is running.
- Tarballs live under `<LAMASYNC_BACKUP_DIR>/dotfiles/<appName>/<timestamp>.tar.gz`.
- `operation_log` retention is `LAMASYNC_LOG_RETENTION_DAYS` (default 90).
  Prune manually via `POST /api/v1/admin/prune?olderThanMs=<ms>` (safety
  rule 5: explicit intent for any destructive API call).
- The `/api/v1/browse/*` write endpoints (copy/move/rename/mkdir/upload/
  delete) all run as async jobs; track via `/api/v1/browse/jobs`.

## See also

- `reference/recipes.md` — common workflows built from both the CLI and
  the API.
- `reference/troubleshooting.md` — what to do when something fails.
- Live OpenAPI spec: `GET /swagger/json`.
