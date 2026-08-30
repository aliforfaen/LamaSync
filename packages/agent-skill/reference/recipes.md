# Recipes

Common workflows, written as decision-tree recipes. Each recipe assumes the
operator typed a high-level intent ("set up a backup", "the sync failed",
"how do I add a folder?") and the agent chose the right CLI/API path.

Conventions used below:
- `<server-url>` and `<api-key>` are placeholders. The CLI's auth discovery
  (`--server` / `--api-key` flags → `LAMASYNC_*` env → `client.toml`) means
  you usually don't have to spell them out.
- `<your-api-key>` is the credential. In any echo, mask it:
  first 8 + last 4 characters (for example `lmsk.ABCDEFG…xxxx`).
- `exit=0` means the command succeeded; `exit=3` is auth failure or missing
  server config;
  `exit=4` is unreachable. The CLI's `--json` output lets you branch on
  these in scripts.

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
follow-ups (e.g. only proceed with `lamasync sync …` when
`checks[name='server: reachability'].ok === true`).

## Recipe 2 — Set up a scheduled backup to S3

The handoff use case for LAMA-229: an agent needs to register a folder,
assign it to a host with a cron, trigger a sync, and verify the run — all
from one tool.

```bash
# 1. (one time) Create a reusable backend with the S3 credentials. The
#    CLI's folders-create step would do this for you, but exposing it
#    lets you reuse the backend across many folders.
lamasync backends create \
  --name "sos-prod" \
  --kind s3 \
  --s3-provider exoscale \
  --s3-endpoint sos-at-vie-1.exo.io \
  --s3-access-key-id "$EXO_KEY" \
  --s3-secret-access-key "$EXO_SECRET"

# 2. Create the folder pointing at the backend.
lamasync folders create \
  --name "laptop-backup" \
  --type backup \
  --backend s3 \
  --s3-backend-id <id from step 1> \
  --s3-bucket my-backup-bucket

# 3. Assign the folder to a host with a daily schedule at 02:00.
lamasync folders assign <folderId> \
  --host my-laptop \
  --path /home/user \
  --role source \
  --schedule "0 2 * * *"

# 4. Trigger an out-of-band sync (the next 02:00 will still run on schedule).
lamasync sync <folderId> --host my-laptop

# 5. Verify the operation appeared in the log with "success" status.
lamasync ops list --host my-laptop --limit 5 --json
```

## Recipe 3 — Add a sync folder (server-side cron, daemon-side rclone)

```bash
# 1. Create the folder (default backend is sftp; the daemon fills in
#    host credentials via the rclone bundle pushed with the assignment).
lamasync folders create --name "LamaFiles" --type sync

# 2. Assign it.
lamasync folders assign <folderId> \
  --host my-laptop \
  --path /home/user/LamaFiles \
  --role both \
  --schedule "*/15 * * * *"    # every 15 minutes

# 3. (optional) Pull fresh config immediately instead of waiting for the
#    next heartbeat.
lamasync sync --host my-laptop --all

# 4. Inspect last hour of operations.
lamasync ops list --host my-laptop --status failed --limit 20
```

## Recipe 4 — Fix a 401 (auth failure)

```bash
# 1. Confirm what the daemon thinks its config is.
lamasync doctor

# Step 1's `auth: source` row will say:
#   "default (localhost/dev-key) — needsSetup"   → no client.toml, the
#                                                  daemon isn't installed
#                                                  on this host (use
#                                                  lamasync-client.md)
#   "config (myhost)"                            → client.toml exists,
#                                                  daemon can't auth
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
  | bash -s -- --server-url <server-url> --api-key <current-server-key> --with-tui

# 4. Re-run `lamasync doctor` to confirm exit 0.
lamasync doctor
```

## Recipe 5 — Trigger a sync and verify it ran

```bash
# 1. Trigger.
lamasync sync <folderId> --host my-laptop

# 2. The daemon polls every 5 seconds. Wait a few seconds, then check.
sleep 6
lamasync ops list --host my-laptop --folder <folderId> --limit 3 --json

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
lamasync api curl -X GET "/api/v1/restic/snapshots?folderId=<folderId>"
# (Or use the Web UI's DataBrowser → Restic tab once it lands a CLI hook.
# When the full CLI CRUD lands in LAMA-231, `lamasync snapshots list …`
# is the documented path. Until then, fetch the JSON via the API client.)

# 2. Request a restore job.
curl -X POST \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "snapshotId": "<snapshot-id>",
    "folderId": "<folderId>",
    "targetHostId": "my-laptop",
    "targetPath": "/tmp/restore",
    "include": ["important/"]
  }' \
  "<server-url>/api/v1/restic/restore"

# 3. The job is async. Watch it via the WebSocket or the API.
# (LAMA-231 brings the full CRUD to the CLI; the skill's drift-check will
# verify the route is documented.)
```

## Recipe 7 — Resolve a conflict

```bash
# 1. Find pending conflicts for a folder.
curl -H "Authorization: Bearer <api-key>" \
  "<server-url>/api/v1/conflicts?folderId=<folderId>&status=pending"

# 2. Resolve one of them.
curl -X POST \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"resolution": "local"}' \
  "<server-url>/api/v1/conflicts/<conflictId>/resolve"
# `resolution` is one of "local" | "remote" | "both"
```

## Recipe 8 — Check for / install a daemon update

```bash
# 1. Ask the daemon.
lamasyncd --check-update
# (Bare `lamasyncd --check-update` is the existing LAMA-151 entry point;
# Phase B adds `lamasyncd --update skill` for the skill side of the
# release.)

# 2. Apply.
lamasyncd --update

# 3. Refresh this skill too (separate code path).
lamasyncd --update skill
```

## Recipe 9 — Run the Web UI

The CLI is the agent surface, but the Web UI is friendlier for humans:

```
open http://<server-url>/
```

Login with the same `<api-key>`. The session is `sessionStorage`-scoped.

## Recipe 10 — Clean up orphaned legacy backup data (after the LAMA-294 migration)

After backups became host-scoped (`<folder-name>/<host-id>`), the old shared
backup contents under the legacy `<folder-name>` root are left **orphaned**
(not re-homed). **This is a required post-upgrade step you're likely to
forget.** Once the per-host prefixes are confirmed populated, clear the
orphaned data:

```bash
lamasync backup legacy              # dry-run: review what is orphaned
lamasync backup legacy --prune --yes # delete it (admin key required)
```

- The dry-run (no `--prune`) is safe: it lists top-level children of each
  backup folder root, flagging each as `legacy (orphaned)` or
  `host-prefix (kept)`, with size + item count.
- `--prune --yes` deletes **only** the orphaned children. Host prefixes and
  the legacy root are never touched (the orphan set is recomputed fresh at
  prune time), so new per-host backups are always protected.
- Restic and sftp folders are skipped; only S3 / local / nfs `backup` folders
  are scanned.

## See also

- `reference/troubleshooting.md` — what to do when something fails.
- `reference/safety.md` — the six rules; especially rule 5 (confirm
  destructive intent before running delete / restore / rotate / prune).
