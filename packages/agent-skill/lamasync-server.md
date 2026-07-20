---
name: lamasync-server
description: Operate a LamaSync fleet server — register hosts, inspect health, manage folder assignments, list/upload/download dotfile tarballs, and review operation logs.
---

# lamasync-server

## What it is

`lamasync-server` is a single-process REST + Swagger API (Bun + Elysia) that
acts as the control plane for a small personal "sync fleet". It owns a SQLite
database of hosts, folders, folder-assignments, dotfile manifests/versions, and
an append-only `operation_log`. The server is typically deployed on TrueNAS
behind a tailnet, but it is self-contained: the binary, a data dir, and a
backup dir are the only runtime requirements.

The server also embeds a self-contained React Management UI at `GET /`. Auth
is the same pre-shared API key; the UI stores it in `sessionStorage` and
re-uses it for every `/api/v1/*` request.

Use this skill when an agent needs to:

- check whether any host in the fleet is online, degraded, or offline
- look at recent failed / completed sync runs
- create a new folder definition and assign it to a host
- upload a new dotfile tarball version, or list the ones on disk
- register a host, or update its heartbeat
- manage folders / dotfiles / conflicts / operation-log retention through a
  browser without typing any curl

## Base URL and auth

The server listens on a configurable port (default `8080`). On a tailnet-deployed
instance the canonical address is:

```
http://<lamasync-server-tailnet-ip>:8080
```

Every request must include a pre-shared API key (the same value as the
server's `LAMASYNC_API_KEY` env var):

```
Authorization: Bearer <LAMASYNC_API_KEY>
```

Missing or wrong key → `401 Unauthorized`.

## Endpoints

| Method | Path                                              | Purpose                                          |
|--------|---------------------------------------------------|--------------------------------------------------|
| GET    | `/api/v1/health`                                  | Fleet summary: host count, online count, hosts[] |
| POST   | `/api/v1/register`                                | Register or update a host                        |
| POST   | `/api/v1/report/health`                           | Host heartbeat (last_seen, status)               |
| GET    | `/api/v1/config/:hostId`                          | Bundled config (assignments, manifests, rclone)  |
| GET    | `/api/v1/release/latest`                          | Latest GitHub release info (proxy)               |
| GET    | `/api/v1/folders`                                 | List all folder definitions                      |
| POST   | `/api/v1/folders`                                 | Create a folder definition                       |
| GET    | `/api/v1/folders/:id`                             | Read a single folder                             |
| PUT    | `/api/v1/folders/:id`                             | Update folder name/type/backend/S3 credentials   |
| DELETE | `/api/v1/folders/:id`                             | Delete folder + cascade its assignments          |
| POST   | `/api/v1/folders/:id/assign`                      | Assign folder to a host                          |
| DELETE | `/api/v1/folders/:id/assign/:hostId`              | Unassign                                         |
| GET    | `/api/v1/folders/:id/assignments`                 | List a folder's host assignments                 |
| GET    | `/api/v1/dotfiles/manifests`                      | List effective manifests (global + host override)|
| POST   | `/api/v1/dotfiles/manifests`                      | Create a dotfile manifest                        |
| PUT    | `/api/v1/dotfiles/manifests/:id`                  | Update a manifest                                |
| DELETE | `/api/v1/dotfiles/manifests/:id`                  | Delete a manifest and its versions               |
| GET    | `/api/v1/dotfiles/:appName`                       | List versions of a dotfile app                   |
| POST   | `/api/v1/dotfiles/:appName`                       | Upload a new version (multipart `tarball` field) |
| GET    | `/api/v1/dotfiles/:appName/:version`              | Download a tarball                               |
| DELETE | `/api/v1/dotfiles/:appName/:version`              | Delete a version (DB row + file)                 |
| GET    | `/api/v1/shares`                                  | List configured NFS/SMB shares                   |
| POST   | `/api/v1/admin/prune`                             | Manually trim operation_log by age               |
| GET    | `/api/v1/operations`                              | Query the operation log                          |
| POST   | `/api/v1/report`                                  | Append an operation_log entry                    |
| GET    | `/api/v1/restic/snapshots`                        | List restic snapshot metadata                    |
| POST   | `/api/v1/restic/snapshots`                        | Daemon reports a new snapshot                    |
| GET    | `/api/v1/restic/restore`                          | List restic restore jobs                         |
| POST   | `/api/v1/restic/restore`                          | Create a restore job for a target host           |
| POST   | `/api/v1/restic/restore/:id/status`               | Update restore job status (daemon ack)           |
| GET    | `/api/v1/conflicts`                               | List manual sync conflicts                       |
| POST   | `/api/v1/conflicts`                               | Bulk-create conflicts from daemon                |
| POST   | `/api/v1/conflicts/:id/resolve`                   | Resolve a conflict (local/remote/both)           |
| GET    | `/api/v1/ws` (WebSocket)                          | Fleet event stream (subprotocol auth)            |
| GET    | `/swagger/json`                                   | Live OpenAPI 3 spec (use to resolve schemas)     |
| GET    | `/`                                                | Management Web UI (single-page React SPA)        |
| GET    | `/swagger`                                        | Swagger UI                                       |

### `GET /api/v1/operations` query params

| Param   | Type   | Default | Notes                                          |
|---------|--------|---------|------------------------------------------------|
| `hostId`| string | -       | Filter to a single host                        |
| `status`| string | -       | One of `started`, `success`, `failed`, `conflict`, `retry`, `recovery` |
| `limit` | int    | 50      | Max 500                                        |

Results are ordered by `timestamp DESC` (newest first).

## Example workflows

### Check fleet health

```bash
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  http://<lamasync-server-tailnet-ip>:8080/api/v1/health
```

Returns `{ status: "ok", hostCount, onlineCount, hosts: Host[] }`. Use this as
the first call when you need to find out who's online and what their IDs are.

### List recent failed or completed jobs

```bash
# failed
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  "http://<lamasync-server-tailnet-ip>:8080/api/v1/operations?status=failed&limit=20"

# successful
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  "http://<lamasync-server-tailnet-ip>:8080/api/v1/operations?status=success&limit=20"

# everything for a single host
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  "http://<lamasync-server-tailnet-ip>:8080/api/v1/operations?hostId=alpha&limit=20"
```

This is the primary "what's broken / what just finished" surface — the entry
point for any cleanup, follow-up, or summary task.

### Register a host or report health

```bash
# Register (creates if new, updates if existing)
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"alpha","hostname":"alpha-box","tailnetIp":"100.64.0.10"}' \
  http://<lamasync-server-tailnet-ip>:8080/api/v1/register

# Heartbeat (clients do this every 30s)
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"hostId":"alpha","timestamp":1718200000000,"status":"online"}' \
  http://<lamasync-server-tailnet-ip>:8080/api/v1/report/health
```

### Create or assign a folder

```bash
# 1. Create the folder definition
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"LamaFiles","type":"sync"}' \
  http://<lamasync-server-tailnet-ip>:8080/api/v1/folders
# → returns { id, name, type, createdAt }

# 2. Assign it to a host
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"hostId":"alpha","role":"both","localPath":"/home/user/LamaFiles","syncExpr":"*/15 * * * *","enabled":true}' \
  http://<lamasync-server-tailnet-ip>:8080/api/v1/folders/<id>/assign
```

`type` must be one of: `sync`, `mount`, `backup`, `dotfile`, `git`.

`backend` is optional and defaults to `sftp`. Set `backend: "s3"` to back the
folder with an S3-compatible object store (Exoscale SOS, AWS, MinIO, etc.).
When `backend: "s3"` is set, `s3Endpoint`, `s3Bucket`, `s3AccessKeyId`, and
`s3SecretAccessKey` are required. `s3Provider` is optional and defaults to
`other`; set it to `exoscale` to use the correct rclone AWS provider +
`other-v2-signature` region defaults. `s3Region` is optional and is auto-set
to `other-v2-signature` for Exoscale. Example Exoscale SOS payload:

```bash
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"exoscale-vault","type":"sync","backend":"s3","s3Provider":"exoscale","s3Endpoint":"sos-at-vie-1.exo.io","s3Bucket":"lamasync-vault","s3AccessKeyId":"EXO_KEY","s3SecretAccessKey":"EXO_SECRET"}' \
  http://<lamasync-server-tailnet-ip>:8080/api/v1/folders
```

Generic S3 example:

```bash
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"generic-s3","type":"backup","backend":"s3","s3Provider":"other","s3Endpoint":"s3.example.com","s3Bucket":"bucket","s3AccessKeyId":"KEY","s3SecretAccessKey":"SECRET","s3Region":"us-east-1"}' \
  http://<lamasync-server-tailnet-ip>:8080/api/v1/folders
```

List every assignment for a folder (used by the Web UI's Folders page):

```bash
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  http://<lamasync-server-tailnet-ip>:8080/api/v1/folders/<id>/assignments
```

### Define, upload, and restore app-specific dotfiles

```bash
# 1. Define the app (global definition, visible to all hosts)
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"appName":"opencode","paths":["~/.config/opencode"],"instructions":"Restart OpenCode after restore."}' \
  http://<lamasync-server-tailnet-ip>:8080/api/v1/dotfiles/manifests

# 2. Override a single host to back up only a subdirectory, with excludes
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"appName":"opencode","hostId":"alpha","paths":["~/.config/opencode"],"excludes":["*.log","cache/"]}' \
  http://<lamasync-server-tailnet-ip>:8080/api/v1/dotfiles/manifests

# 3. Upload a new version (multipart, field name = "tarball")
# Optional: "hostId" field to target a host-specific manifest (default is global).
# Optional: "uploaderHostId" field to record the host that produced the backup.
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  -F "tarball=@/path/to/opencode-2026-07-12.tar.gz" \
  -F "uploaderHostId=alpha" \
  http://<lamasync-server-tailnet-ip>:8080/api/v1/dotfiles/opencode

# 4. List versions
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  http://<lamasync-server-tailnet-ip>:8080/api/v1/dotfiles/opencode

# 5. Download a specific version (the {version} is the version id, e.g. UUID)
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  -o opencode.tar.gz \
  http://<lamasync-server-tailnet-ip>:8080/api/v1/dotfiles/opencode/<version-id>
```

### Open the WebSocket fleet stream

The WebSocket endpoint uses the `Sec-WebSocket-Protocol` header for auth. The
server accepts three encodings of the API key in the second subprotocol slot:
the raw key, base64, or unpadded base64url (RFC 6455 forbids `=` padding). The
browser UI ships this helper:

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

### Open the Management Web UI

```bash
# The web UI is bundled into the server binary; no extra setup is required.
# 1. Open the site
xdg-open http://<lamasync-server-tailnet-ip>:8080/   # or paste the URL into your browser

# 2. Paste the same $LAMASYNC_API_KEY value at the login screen.
# The session is scoped to the browser tab (sessionStorage); sign out to clear it.
```

The UI mirrors the JSON API. It covers the same flows as the `curl`s above —
register/dashboard, folder CRUD + assignment view, dotfile manifest CRUD,
pending-conflict resolution, and operation-log pruning — without typing
endpoints by hand.

## Schemas

The OpenAPI 3 spec is served live at `/swagger/json` — prefer fetching it when
you need exact request/response field names or want to verify a schema before
issuing a write. The high-level shapes are:

- `Host { id, hostname, tailnetIp?, lastSeen?, status }`
- `Folder { id, name, type: 'sync'|'mount'|'backup'|'dotfile'|'git', createdAt?, encrypted?, cryptPassword?, backend?: 'sftp'|'s3'|'local', s3Provider?: 'exoscale'|'aws'|'other', s3Endpoint?, s3Bucket?, s3AccessKeyId?, s3SecretAccessKey?, s3Region? }`
- `FolderAssignment { id, folderId, hostId, role, localPath, remoteName?, syncExpr?, enabled, conflictStrategy?, preSyncCmd?, postSyncCmd?, ignorePath?, mountIgnorePath?, timeoutSec?, bandwidthSchedule?, maxRetries?, availableSpaceThreshold?, cacheProfile?, cacheMaxSize?, resticRepository?, resticPassword? }`
- `OperationLog { id, timestamp, hostId, folderId?, operation, status, summary?, details? }` (`status` includes `retry`, `recovery`)
- `DotfileManifest { id, hostId, appName, paths[], excludes[]?, schedule?, instructions?, lastSyncAt?, lastSyncDirection?, originalUploaderHostId? }`
- `ResticSnapshot { id, folderId, hostId, snapshotId, timestamp, paths[], sizeBytes?, tags? }`
- `ResticRestoreJob { id, snapshotId, folderId, targetHostId, targetPath, include[]?, status, createdAt, resolvedAt?, error? }`
- `Conflict { id, hostId, folderId, path, localMtime?, remoteMtime?, status, resolution?, createdAt, resolvedAt? }`

All `?` fields are nullable. Timestamps are milliseconds since epoch
(`Date.now()`).

## Operational notes

- The DB file is `<LAMASYNC_DATA_DIR>/lamasync.db`. Don't move or rename it
  while the server is running.
- Tarballs live under `<LAMASYNC_BACKUP_DIR>/dotfiles/<appName>/<timestamp>.tar.gz`.
  Deleting a version removes both the DB row and the file.
- `operation_log` rows older than `LAMASYNC_LOG_RETENTION_DAYS` (default 90) are
  pruned on startup and then once every 24 hours. You can also force a prune
  with `POST /api/v1/admin/prune?olderThanMs=<ms>`.
- `schedule_state` is updated automatically when a `POST /report` includes a
  `folderId` that matches an existing assignment.
- The WebSocket protocol now broadcasts a `host` event from `POST /register`
  and `POST /report/health` so the Management UI updates live without
  re-fetching.

## See also

- `ARCHITECTURE.md` in the project root for the full system design.
- The Swagger UI at `/swagger` for an interactive view.
