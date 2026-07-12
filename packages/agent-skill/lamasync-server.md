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

Use this skill when an agent needs to:

- check whether any host in the fleet is online, degraded, or offline
- look at recent failed / completed sync runs
- create a new folder definition and assign it to a host
- upload a new dotfile tarball version, or list the ones on disk
- register a host, or update its heartbeat

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
| GET    | `/api/v1/folders`                                 | List all folder definitions                      |
| POST   | `/api/v1/folders`                                 | Create a folder definition                       |
| GET    | `/api/v1/folders/:id`                             | Read a single folder                             |
| PUT    | `/api/v1/folders/:id`                             | Update folder name/type                          |
| DELETE | `/api/v1/folders/:id`                             | Delete folder + cascade its assignments          |
| POST   | `/api/v1/folders/:id/assign`                      | Assign folder to a host                          |
| DELETE | `/api/v1/folders/:id/assign/:hostId`              | Unassign                                         |
| GET    | `/api/v1/dotfiles/:appName`                       | List versions of a dotfile app                   |
| POST   | `/api/v1/dotfiles/:appName`                       | Upload a new version (multipart `tarball` field) |
| GET    | `/api/v1/dotfiles/:appName/:version`              | Download a tarball                               |
| DELETE | `/api/v1/dotfiles/:appName/:version`              | Delete a version (DB row + file)                 |
| GET    | `/api/v1/operations`                              | Query the operation log                          |
| POST   | `/api/v1/report`                                  | Append an operation_log entry                    |
| GET    | `/swagger/json`                                   | Live OpenAPI 3 spec (use to resolve schemas)     |
| GET    | `/swagger`                                        | Swagger UI                                       |

### `GET /api/v1/operations` query params

| Param   | Type   | Default | Notes                                          |
|---------|--------|---------|------------------------------------------------|
| `hostId`| string | -       | Filter to a single host                        |
| `status`| string | -       | One of `started`, `success`, `failed`, `conflict` |
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

`type` must be one of: `sync`, `mount`, `backup`, `dotfile`.

### Upload / list / download a dotfile version

```bash
# Upload (multipart, field name = "tarball")
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  -F "tarball=@/path/to/nvim-2026-07-12.tar.gz" \
  http://<lamasync-server-tailnet-ip>:8080/api/v1/dotfiles/nvim

# List versions
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  http://<lamasync-server-tailnet-ip>:8080/api/v1/dotfiles/nvim

# Download a specific version (the {version} is the version id, e.g. UUID)
curl -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  -o nvim.tar.gz \
  http://<lamasync-server-tailnet-ip>:8080/api/v1/dotfiles/nvim/<version-id>
```

## Schemas

The OpenAPI 3 spec is served live at `/swagger/json` — prefer fetching it when
you need exact request/response field names or want to verify a schema before
issuing a write. The high-level shapes are:

- `Host { id, hostname, tailnetIp?, lastSeen?, status }`
- `Folder { id, name, type: 'sync'|'mount'|'backup'|'dotfile', createdAt? }`
- `FolderAssignment { id, folderId, hostId, role, localPath, remoteName?, syncExpr?, enabled }`
- `OperationLog { id, timestamp, hostId, folderId?, operation, status, summary?, details? }`
- `DotfileVersion { id, manifestId, timestamp, tarballPath, sizeBytes?, checksum? }`

All `?` fields are nullable. Timestamps are milliseconds since epoch
(`Date.now()`).

## Operational notes

- The DB file is `<LAMASYNC_DATA_DIR>/lamasync.db`. Don't move or rename it
  while the server is running.
- Tarballs live under `<LAMASYNC_BACKUP_DIR>/dotfiles/<appName>/<timestamp>.tar.gz`.
  Deleting a version removes both the DB row and the file.
- `operation_log` is append-only; the server never trims it. Build a separate
  prune job if retention becomes a concern.
- `schedule_state` is updated automatically when a `POST /report` includes a
  `folderId` that matches an existing assignment.

## See also

- `ARCHITECTURE.md` in the project root for the full system design.
- The Swagger UI at `/swagger` for an interactive view.
