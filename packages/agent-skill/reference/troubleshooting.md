# Troubleshooting

What to do when something fails. Format: **symptom → cause → fix**.

## Symptom: `lamasync doctor` reports `FAIL` on `server: reachability`

**Cause.** Server is unreachable, the API key is wrong, or the tailnet is
down. `lamasync doctor --json` distinguishes:

- `"Unable to connect"` → the URL is unreachable (tailnet down, wrong
  port, server crashed, firewall blocked).
- `HTTP 401` / `403` → the API key doesn't match.
- `HTTP 5xx` → the server is up but errored (check its logs).

**Fix.** Run the install script with the *current* server key, confirm
`tailscale status` is healthy on both ends, then re-check:

```bash
lamasync doctor
```

If it persists: try the API directly:

```bash
curl -sS -H "Authorization: Bearer <api-key>" \
  <server-url>/api/v1/health | head
# 200 → API works; the CLI is misconfigured.
# 401 → wrong key.
# ECONNREFUSED → wrong port / server down.
```

## Symptom: `lamasync doctor` reports `FAIL` on `auth: source`

**Cause.** No `--server`/`--api-key` flag, no `LAMASYNC_SERVER_URL`/
`LAMASYNC_API_KEY` env, and no `~/.config/lamasync/client.toml`. The CLI
falls back to `http://localhost:8080/dev-key`, which doesn't talk to
anything real.

**Fix.** Run the installer (or hand-write `client.toml`); see
`lamasync-client.md`. On a daemon host, the installer already populated
the file — you should never see this.

## Symptom: `lamasync doctor` reports `FAIL` on `socket: daemon`

**Cause.** The daemon's Unix socket is missing (`/run/user/<uid>/lamasync.sock`
or `~/.lamasync/lamasync.sock`). Either the daemon isn't running, or
`LAMASYNC_SOCKET_PATH` is pointing somewhere wrong.

**Fix.**
```bash
systemctl --user status lamasyncd
systemctl --user restart lamasyncd
lamasync doctor    # confirm
```

## Symptom: `lamasync doctor` reports `FAIL` on `release: drift`

**Cause.** The binary's version is older than the latest GitHub Release.
This is informational; the daemon doesn't auto-upgrade unless you ask.

**Fix.** Manual:
```bash
lamasyncd --update
```
Or re-run the installer; it downloads the latest matching binaries.

## Symptom: `lamasync local status` → `local daemon socket not reachable`

**Cause.** Same as the `socket: daemon` row in `doctor` — `lamasyncd` is not
running, or the socket is at an unexpected path.

**Fix.**
```bash
systemctl --user status lamasyncd
ls -l "${XDG_RUNTIME_DIR:-~/.lamasync}/lamasync.sock" 2>/dev/null \
  || echo "no socket at expected path"
journalctl --user -u lamasyncd -n 50
```

## Symptom: sync triggered, but no row appears in `lamasync ops list`

**Cause.** The action was enqueued, but the daemon hasn't polled it yet
(5s default); or the daemon is offline and the action sits in the queue.

**Fix.**
```bash
# Check the queue.
curl -H "Authorization: Bearer <api-key>" \
  "<server-url>/api/v1/actions/pending?hostId=<host-id>&limit=5"
# An undelivered `trigger_sync` is here when the daemon is offline.

# Force the daemon to refresh immediately.
lamasync sync --all --host <host-id>     # CLI re-enqueues, daemon
                                          # will pick it up on the next
                                          # poll regardless of the
                                          # queue age.
```

## Symptom: a sync run reports `status: "failed"` with details about `rclone`

**Cause.** rclone errored; the most common causes are:
- `Local file doesn't exist` — `localPath` is wrong / not yet mounted.
- `Permission denied` — the daemon's `ReadWritePaths=` (systemd user
  unit) doesn't cover the path; fix the unit or move the path.
- `Backend not found` — bucket/endpoint/repo went missing.
- `rclone: command not found` — rclone is installed outside `PATH`. The
  unit sets
  `Environment=PATH=$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin`
  on purpose; install or symlink rclone under one of those.

**Fix.** Always start with the raw error:
```bash
lamasync ops list --host <host-id> --status failed --limit 1 --json
```
The `details` column carries the rclone exit code + last lines. Match the
fix to the error. After applying, trigger a fresh run:
```bash
lamasync sync <folderId> --host <host-id>
```

## Symptom: a mount is stuck (status `mounting` or `dead`)

**Cause.** rclone VFS crashed, or the systemd mount unit failed to start.
Check via:
```bash
systemctl --user status "lamasync-mount-<folder-id>" 2>/dev/null
journalctl --user -u lamasyncd -n 100
```

**Fix.** Restart the daemon (which re-evaluates mount startup health and
either restarts or fails loudly in the operation log):
```bash
systemctl --user restart lamasyncd
lamasync local mount <folderId>     # re-arm the mount
lamasync local ops                   # confirm "success" / "failed"
```

## Symptom: stale lock (folder sync blocked, but no host is actively running it)

**Cause.** A previous daemon crashed mid-op without releasing the lock.
The TTL is 20 minutes (LAMA default), so the lock usually self-heals.

**Fix.** If you're impatient (and you've verified nothing is running):
```bash
curl -X POST -H "Authorization: Bearer <api-key>" \
  "<server-url>/api/v1/operations/release" \
  -H "Content-Type: application/json" \
  -d '{"folderId":"<id>","hostId":"<id>","status":"failed","summary":"manual stale-lock release"}'
```

## Symptom: `lamasync --update skill` says "no release found"

**Cause.** The skill was never published as part of a release yet, or
`LAMASYNC_GITHUB_API` is pointing to a private fork.

**Fix.** Check the latest GitHub release's assets:
```bash
curl -sSL https://api.github.com/repos/aliforfaen/LamaSync/releases/latest \
  | grep -oE '"name": "[^"]+"' | head -20
```
Expect an asset named `lamasync-skill-<version>.tar.gz` (added by
`.github/workflows/ci.yml`'s `release` job).

## Symptom: `lamasync folders create --backend s3` returns 400

The server validates `s3Endpoint`, `s3Bucket`, `s3AccessKeyId`,
`s3SecretAccessKey`. Common causes:
- Missing `--s3-bucket` (required when `--backend=s3`).
- Missing `--s3-access-key-id` or `--s3-secret-access-key`.
- Wrong `--s3-region` for `--s3-provider=aws` (region required for AWS;
  Exoscale auto-sets `other-v2-signature`).

**Fix.** Re-run with `--s3-region us-east-1` (or the right region) for AWS,
or omit `--s3-region` for Exoscale.

## Symptom: 404 when posting to a path that exists in this reference

The skill's `reference/api.md` mirrors the routes at write-time. If a
path was removed or renamed, the CI drift-check fails; fix the reference
in the same PR that changed the route.

**Fix.** Update `reference/api.md` and run `bun run scripts/check-skill-drift.ts`
locally — it must exit 0 before the PR is mergeable.

## See also

- `reference/cli.md` — every command's flags and exit codes.
- `reference/recipes.md` — end-to-end workflows.
- `reference/safety.md` — the six rules (especially rules 4 and 5).
