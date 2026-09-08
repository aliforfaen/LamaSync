# Recipes

Common workflows, written as decision-tree recipes. Each recipe assumes the
operator typed a high-level intent ("set up a backup", "the sync failed",
"how do I add a folder?") and the agent chose the right CLI/API path.

After LAMA-326 the CLI is local-first: `lamasync doctor`, `lamasync local *`,
and `lamasync register`. Fleet management is REST API + web UI; the recipes
below use `curl` against the documented endpoints in `reference/api.md`.

Conventions used below:
- `<server-url>` and `<api-key>` are placeholders. For CLI commands the auth
  discovery (`--server` / `--api-key` flags → `LAMASYNC_*` env →
  `client.toml`) means you usually don't have to spell them out; for `curl`
  use the same env vars.
- `<your-api-key>` is the credential. In any echo, mask it:
  first 8 + last 4 characters (for example `lmsk.ABCDEFG…xxxx`).
- `exit=0` means the command succeeded; `exit=3` is auth failure (401/403);
  `exit=4` is unreachable. The CLI's `--json` output lets you branch on
  these in scripts. For `curl`, branch on HTTP status codes.

```bash
# Shared curl preamble for the recipes below.
AUTH=(-H "Authorization: Bearer $LAMASYNC_API_KEY" -H "Content-Type: application/json")
BASE="${LAMASYNC_SERVER_URL:-http://<server-url>:8080}/api/v1"
```

## Recipe 1 — Doctor a fresh host

When an operator says "this host just installed the daemon, is everything
OK?" or before any non-trivial operation, run:

```bash
lamasync doctor
```

Expected output (abridged): `OK` rows for env vars, masked key, server
reachability, socket probe, and version drift. Exit `0` means all clear.
Anything else → see `reference/troubleshooting.md`.

The `--json` form:

```bash
lamasync doctor --json
```

returns `{ ok: boolean, checks: [...] }`. Branch on `ok` for scripted
follow-ups (e.g. only proceed with fleet operations when
`checks[name='server: reachability'].ok === true`).

## Recipe 2 — Set up a scheduled backup to S3

The classic agent use case: register a folder, assign it to a host with a
cron, trigger a sync, and verify the run — all over the REST API.

```bash
# 1. (one time) Create a reusable backend with the S3 credentials.
#    Reuse the backend across many folders.
curl "${AUTH[@]}" -X POST "$BASE/backends" -d '{
  "name": "sos-prod",
  "kind": "s3",
  "s3Provider": "exoscale",
  "s3Endpoint": "sos-at-vie-1.exo.io",
  "s3AccessKeyId": "'"$EXO_KEY"'",
  "s3SecretAccessKey": "'"$EXO_SECRET"'"
}'

# 2. Create the folder pointing at the backend.
curl "${AUTH[@]}" -X POST "$BASE/folders" -d '{
  "name": "laptop-backup",
  "type": "backup",
  "backendId": <id from step 1>,
  "s3Bucket": "my-backup-bucket"
}'

# 3. Assign the folder to a host with a daily schedule at 02:00.
curl "${AUTH[@]}" -X POST "$BASE/folders/<folderId>/assign" -d '{
  "hostId": "my-laptop",
  "localPath": "/home/user",
  "role": "source",
  "schedule": "0 2 * * *"
}'

# 4. Trigger an out-of-band sync (the next 02:00 will still run on schedule).
curl "${AUTH[@]}" -X POST "$BASE/hosts/my-laptop/actions" \
  -d '{"type":"trigger_sync","payload":{"folderId":"<folderId>"}}'

# 5. Verify the operation appeared in the log with "success" status.
curl "${AUTH[@]}" "$BASE/operations?hostId=my-laptop&limit=5"
```

(Field names above follow the wire shapes in `reference/api.md` — check the
Schemas section when a 400 complains about a field.)

### Backblaze B2

Choose **Backblaze B2** in the web UI, or create the same S3-compatible
backend via the API. Use a B2 application key ID and application key (not
the master application key), and copy the region and endpoint from the B2
bucket page.

```bash
curl "${AUTH[@]}" -X POST "$BASE/backends" -d '{
  "name": "b2-archive",
  "kind": "s3",
  "s3Provider": "b2",
  "s3Endpoint": "https://s3.us-east-005.backblazeb2.com",
  "s3Region": "us-east-005",
  "s3AccessKeyId": "'"$B2_KEY_ID"'",
  "s3SecretAccessKey": "'"$B2_APPLICATION_KEY"'"
}'
```

## Recipe 3 — Add a sync folder (server-side cron, daemon-side rclone)

```bash
# 1. Create the folder (the daemon fills in host credentials via the
#    rclone bundle pushed with the assignment).
curl "${AUTH[@]}" -X POST "$BASE/folders" \
  -d '{"name":"LamaFiles","type":"sync"}'

# 2. Assign it.
curl "${AUTH[@]}" -X POST "$BASE/folders/<folderId>/assign" -d '{
  "hostId": "my-laptop",
  "localPath": "/home/user/LamaFiles",
  "role": "both",
  "schedule": "*/15 * * * *"
}'

# 3. (optional) Pull fresh config immediately instead of waiting for the
#    next heartbeat.
curl "${AUTH[@]}" -X POST "$BASE/hosts/my-laptop/actions" \
  -d '{"type":"refresh_config"}'

# 4. Inspect recent operations.
curl "${AUTH[@]}" "$BASE/operations?hostId=my-laptop&status=failed&limit=20"
```

## Recipe 4 — Fix a 401 (auth failure)

```bash
# 1. Confirm what the daemon side thinks its config is.
lamasync doctor

# Step 1's `auth: source` row will say:
#   "default (localhost/dev-key) — … lamasync register …" → no client.toml;
#     the daemon isn't installed/paired on this host (use lamasync-client.md)
#   "config (myhost)"                                     → client.toml
#     exists, but the key doesn't match the server
# 2. Check whether the API key still matches the server's. The server's
#    key is whatever was set in `LAMASYNC_API_KEY` on the host running
#    lamasync-server. If your client.toml was created against an old
#    key, regenerate it.
ls -la ~/.config/lamasync/client.toml
cat ~/.config/lamasync/client.toml

# 3. Re-run the install script with the current key — it rewrites
#    client.toml and restarts the daemon.
LAMASYNC_API_KEY=<current-server-key> \
  curl -sSL https://raw.githubusercontent.com/aliforfaen/LamaSync/master/packaging/install/install.sh \
  | bash -s -- --server-url <server-url> --api-key <current-server-key> --with-cli

# 4. Re-run `lamasync doctor` to confirm exit 0.
lamasync doctor
```

## Recipe 5 — Trigger a sync and verify it ran

```bash
# 1. Trigger via the server (daemon picks it up on its next 5s poll).
curl "${AUTH[@]}" -X POST "$BASE/hosts/my-laptop/actions" \
  -d '{"type":"trigger_sync","payload":{"folderId":"<folderId>"}}'

# 2. Wait a few seconds, then check.
sleep 6
curl "${AUTH[@]}" "$BASE/operations?hostId=my-laptop&folderId=<folderId>&limit=3"

# Expect one row with `operation: "sync"`, `status: "success"` or
# `status: "failed"`. If `failed`, grab the `details` field for the
# rclone error and see `reference/troubleshooting.md`.
```

For an immediate local trigger (skips the 5s poll):
```bash
lamasync local sync <folderId>
sleep 6
lamasync local ops
```

## Recipe 6 — Restore a restic snapshot

```bash
# 1. Find snapshots for a folder.
curl "${AUTH[@]}" "$BASE/restic/snapshots?folderId=<folderId>"

# 2. Request a restore job.
curl "${AUTH[@]}" -X POST "$BASE/restic/restore" -d '{
  "snapshotId": "<snapshot-id>",
  "folderId": "<folderId>",
  "targetHostId": "my-laptop",
  "targetPath": "/tmp/restore",
  "include": ["important/"]
}'

# 3. The job is async. Watch it via the WebSocket or the operations log.
```

(Exact route shapes: `reference/api.md`, restic section. App-settings
snapshot inspection/download uses `/apps/protections/:id/snapshots`.)

## Recipe 7 — Resolve a conflict

```bash
# 1. Find pending conflicts for a folder.
curl "${AUTH[@]}" "$BASE/conflicts?folderId=<folderId>&status=pending"

# 2. Resolve one of them.
curl "${AUTH[@]}" -X POST "$BASE/conflicts/<conflictId>/resolve" \
  -d '{"resolution": "local"}'
# `resolution` is one of "local" | "remote" | "both"
```

## Recipe 8 — Check for / install a daemon update

```bash
# 1. Ask the daemon.
lamasyncd --check-update
# (Bare `lamasyncd --check-update` is the existing LAMA-151 entry point;
# `lamasyncd --update skill` refreshes the skill side of the release.)

# 2. Apply.
lamasyncd --update

# 3. Refresh this skill too (separate code path).
lamasyncd --update skill
```

## Recipe 9 — Run the Web UI

The CLI is the local/agent surface, but the Web UI is friendlier for
fleet management:

```
open http://<server-url>/
```

Login with the same `<api-key>`. The session is `sessionStorage`-scoped.

## Recipe 10 — Clean up orphaned legacy backup data (after the LAMA-294 migration)

After backups became host-scoped (`<folder-name>/<host-id>`), the old shared
backup contents under the legacy `<folder-name>` root are left **orphaned**
(not re-homed). **This is a required post-upgrade step you're likely to
forget.** Once the per-host prefixes are confirmed populated, clear the
orphaned data via the REST API:

```bash
# Dry-run: review what is orphaned (safe; add ?sizes=true for counts — slow).
curl "${AUTH[@]}" "$BASE/backups/legacy-root"

# Delete it (admin key required; confirm:true is mandatory).
curl "${AUTH[@]}" -X POST "$BASE/backups/legacy-root/prune" \
  -d '{"confirm": true}'
```

- The dry-run lists top-level children of each backup folder root, flagging
  each as `legacy (orphaned)`, `host-prefix (kept)`, or
  `explicit destination (kept)`, with size + item count.
- The prune deletes **only** the orphaned children. Host prefixes and the
  legacy root are never touched (the orphan set is recomputed fresh at
  prune time), so new per-host backups are always protected.
- Restic and sftp folders are skipped; only S3 / local / nfs `backup`
  folders are scanned.

## See also

- `reference/troubleshooting.md` — what to do when something fails.
- `reference/safety.md` — the six rules; especially rule 5 (confirm
  destructive intent before running delete / restore / rotate / prune).
