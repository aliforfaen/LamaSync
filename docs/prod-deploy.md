# Production deploy — `lamasync` LXC

The production server runs in an LXC container named `lamasync` at
`100.113.52.108` (Tailscale only). This file is the canonical reference
for **how to interact with that container** — SSH, updates, health checks,
where things live. Historical context is archived under `docs/archive/`; this
file and the live environment are the operational source of truth.

If something on the LXC disagrees with this document, this document is
wrong — update it as part of the same commit/PR that changes the
production setup.

## Topology (TL;DR)

- **Server image**: `ghcr.io/aliforfaen/lamasync-server:latest` (CI
  rebuilds + pushes on every master push via the `docker` job in
  `.github/workflows/ci.yml`).
- **Compose project**: `lamasync` (single service, `lamasync-server`,
  pinned by `container_name`).
- **Data volumes** (named, **external** so the compose project can't
  recreate them):
  - `docker_lamasync-data`     → `/data`     (SQLite + uploads)
  - `docker_lamasync-backups`  → `/backups`  (small local backup mirror)
- **Deploy directory on the LXC**: `/home/messhias/lamasync/`
  (`docker-compose.yml`, `.env`, `update.sh`, `update.log`, `src/`).
  Owned by user `messhias`. **Not** under `/root/` — earlier status
  entries mentioned `/root/lamasync/` but that was the pre-Aug-3 layout.
- **Auto-update**: messhias's user crontab runs
  `0 4 * * * /home/messhias/lamasync/update.sh` daily at 04:00 (local).
  The script pulls the latest GHCR image, falls back to local build on
  pull failure, and recreates the container via `docker compose up -d`.

## SSH access

```bash
ssh -i ~/.ssh/lamasync_key root@lamasync
```

- Key file: `~/.ssh/lamasync_key` (present on this workstation).
- User: `root` (Tailscale-only network; this is the canonical login used
  by every status entry that touches the LXC).
- Hostname `lamasync` resolves to `lamasync.tail91ec23.ts.net`
  (`100.113.52.108`) via the workstation's `/etc/hosts` / Tailscale
  resolver. Direct IPs work too.
- If another machine needs root access, add its public key deliberately to
  `/root/.ssh/authorized_keys` on the LXC and record the operational change
  here.

## Update procedure

### Automated (daily)

The 04:00 cron is enough for routine pushes. Just merge to `master` and
the next 04:00 picks it up. Verify the morning after:

```bash
ssh -i ~/.ssh/lamasync_key root@lamasync \
  'docker inspect lamasync-server --format "{{.Config.Image}} created={{.Created}}"'
```

Expect a fresh `created=` timestamp from today's date.

### Manual (skip the cron wait)

```bash
ssh -i ~/.ssh/lamasync_key root@lamasync \
  '/home/messhias/lamasync/update.sh'
```

The script (`/home/messhias/lamasync/update.sh`):

1. `git pull --ff-only` inside `src/` (the local checkout).
2. `docker compose pull lamasync-server` — GHCR fast path. On success
   this prints `Image ghcr.io/.../lamasync-server:latest Pulled`.
3. On pull failure, `docker compose build lamasync-server` from local
   source (fallback).
4. `docker compose up -d lamasync-server` — recreates only if the image
   digest changed, otherwise no-op.

All output is appended to `/home/messhias/lamasync/update.log`. The whole
thing finishes in ~7 seconds for a no-change run and ~30s for a real
image pull (Bun binary, ~20 MB compressed).

### Version note

The server's `--version` and the `LamaSync server vX.Y.Z listening on …`
boot line both come from the root `package.json` `version` field (the
generated `packages/core/src/version.ts` constant). A push that doesn't
bump `package.json` won't change the displayed version — that's
expected for CI-only / docs-only fixes (LAMA-240's drift fix is one
such case).

## Health check

```bash
API_KEY=$(ssh -i ~/.ssh/lamasync_key root@lamasync \
  'grep ^LAMASYNC_API_KEY= /home/messhias/lamasync/.env | cut -d= -f2-')
curl -fsS -H "Authorization: Bearer $API_KEY" \
  http://100.113.52.108:8080/api/v1/health
```

The health endpoint returns `{status, hostCount, onlineCount, hosts[]}`
and the container's own healthcheck (defined in `docker-compose.yml`)
pings it every 30s.

To watch the boot log live:

```bash
ssh -i ~/.ssh/lamasync_key root@lamasync 'docker logs -f lamasync-server'
```

A clean boot shows `LamaSync server vX.Y.Z listening on …` then
`[retention] no operation_log entries older than 90 day(s)` (or the
actual count of pruned entries). Anything else — `lift`/`clean`
lifecycle messages from the legacy S3 drop, `gated DROP path fired`,
`Database has closed` — needs attention; cross-reference the message in
`docs/features.md` (LAMA-222, LAMA-226).

## Managed API keys (LAMA-234)

Production now supports managed `admin`/`device` keys alongside the master
`LAMASYNC_API_KEY`:

- Managed-key issuance (pairing, admin-key creation) needs a working
  server-side secret key: `LAMASYNC_SECRET_KEY` (>= 16 chars) in
  `/home/messhias/lamasync/.env`, or a writable `LAMASYNC_DATA_DIR` so the
  server can persist `secret.key` (0600) on first use. If neither exists,
  pairing / creation **fails closed** (no plaintext fallback for new keys).
- The master key is never stored in the DB and never returned by any
  route — rotation stays an env change + recreate (see Update procedure).
- Paired devices get a unique host-bound device key; revoke + re-pair via
  the Web Admin → Access keys when a device is replaced. Existing
  master-key clients keep working until re-paired — no forced cut-over.

## Deploy agent (LAMA-301)

The **Server deployment** card on the Admin page can request a deployment
of the configured production environment. It works through a small
**deploy agent** that runs on the LXC itself — NOT inside the
`lamasync-server` container:

- The server container never receives `/var/run/docker.sock`, host SSH
  credentials, privileged mode, or a shell-execution endpoint. The only
  thing the agent ever executes is the fixed script
  `/home/messhias/lamasync/update.sh` with **no arguments** and the fixed
  working directory `/home/messhias/lamasync`.
- The agent reports stage updates (`pulling`, `building`, `recreating`,
  `waiting for health`) and a sanitized, capped (final 16 KiB) output
  tail to the normal API. The server scrubs bearer tokens,
  `KEY=value` secrets, and env dumps before persisting.
- Only one active (`pending`/`running`) production job can exist; the
  daily 04:00 cron is unaffected (the one-active-job invariant is
  enforced server-side, and cron doesn't go through the API).

### Credential

The agent uses a dedicated `deploy` managed key — NOT the master key and
NOT a device/admin key:

1. Web Admin → Access keys, or `POST /api-keys` with
   `{ "name": "lxc deploy agent", "kind": "deploy" }`. The secret is
   shown once.
2. A `deploy` key can ONLY claim/progress/complete deploy jobs. It cannot
   request jobs, read history, or touch any other route.
3. **Rotation**: mint a new deploy key, update the env file (below),
   `systemctl restart lamasync-deploy-agent`, then revoke the old key via
   Access keys.

### Provisioning

```bash
# 1. Build + copy the agent binary (from a dev checkout):
bun run build   # → packages/deploy-agent/dist/lamasync-deploy-agent
scp packages/deploy-agent/dist/lamasync-deploy-agent lamasync:/usr/local/bin/
ssh lamasync 'chmod +x /usr/local/bin/lamasync-deploy-agent'

# 2. Install the systemd unit:
scp packaging/deploy-agent/lamasync-deploy-agent.service \
    lamasync:/etc/systemd/system/

# 3. Credential env file (root-owned 0600, read by the unit):
ssh lamasync 'umask 077; cat > /home/messhias/lamasync/deploy-agent.env <<EOF
LAMASYNC_SERVER_URL=http://127.0.0.1:8080
LAMASYNC_DEPLOY_API_KEY=lmsk.<keyId>.<secret>
EOF'

# 4. The agent user needs docker CLI access (SupplementaryGroups=docker in
#    the unit); ensure messhias is in the docker group:
ssh lamasync 'usermod -aG docker messhias'

# 5. Enable:
ssh lamasync 'systemctl daemon-reload && systemctl enable --now lamasync-deploy-agent'
```

Network reachability: the agent talks to the API over the published
compose port on localhost (`http://127.0.0.1:8080`) — no tailnet
requirements beyond what the server already has.

### Feature gate

Deploy jobs are only accepted when the server runs with
`LAMASYNC_DEPLOY_AGENT_ENABLED=true` (add to
`/home/messhias/lamasync/.env` and recreate). Without the flag the Admin
card renders **manual deploy only** with the documented SSH/update
command — there is no button creating jobs nobody can claim.

### Boot validation, timeouts, logs

At boot (and re-checked every minute) the agent validates that the fixed
script exists, is executable, the working directory exists, and `docker`
is on PATH. With an invalid environment it logs
`[deploy-agent] UNAVAILABLE — refusing to claim jobs until fixed: …` and
keeps polling without claiming (so a fixed environment self-recovers).

- Script timeout: **10 minutes** (killed automatically; the job records
  `failed: deploy script exceeded 600s…`).
- Health wait after the script exits: up to **4 minutes** of bounded
  exponential backoff on `GET /api/v1/health` — the deploy itself
  restarts the API, so the agent completes the same job after the API is
  back (the SQLite volume survives the container recreation).
- Agent crash / timeout: a `running` job older than **15 minutes** is
  reclaimed to `pending` by the server (mirroring daemon-action
  recovery).
- Logs: `journalctl -u lamasync-deploy-agent -f`. Script output is also
  appended to `/home/messhias/lamasync/update.log` by update.sh itself.
- No automatic rollback in v1: a failed deploy leaves the operator the
  existing rollback path above; the Admin failure state links there.

### Uninstall

```bash
ssh lamasync 'systemctl disable --now lamasync-deploy-agent && \
  rm /etc/systemd/system/lamasync-deploy-agent.service /usr/local/bin/lamasync-deploy-agent && \
  systemctl daemon-reload'
```

Revoke the deploy key in Web Admin → Access keys afterwards.

## Container introspection

```bash
# What image is currently running?
ssh -i ~/.ssh/lamasync_key root@lamasync \
  'docker inspect lamasync-server --format "image={{.Config.Image}} created={{.Created}}"'

# Env vars the container was started with (including the API key — don't
# paste this anywhere public):
ssh -i ~/.ssh/lamasync_key root@lamasync \
  'docker inspect lamasync-server --format "{{range .Config.Env}}{{println .}}{{end}}"'

# Last 50 log lines:
ssh -i ~/.ssh/lamasync_key root@lamasync 'docker logs --tail 50 lamasync-server'
```

## Rollback

The image is tagged `:latest` only — there is no automatic retention
of older tags on GHCR for this repo. To roll back:

1. Identify the last known-good commit on `master` (e.g. via
   `git log --oneline -10` on this host, picking the commit before the
   bad one).
2. Revert that commit locally, push to master. The 04:00 cron (or a
   manual `update.sh` run) will pull the new image built from the
   reverted tree.
3. Verify with the health check above.

If the bad image is actively bricking the container on every restart
(boot loop), you can pin a known-good image digest in `.env` on the LXC
as `LAMASYNC_IMAGE=ghcr.io/aliforfaen/lamasync-server@sha256:<digest>`
and rerun `update.sh`. The digest of any past GHCR image is reachable
via `docker pull` history or `gh api repos/aliforfaen/LamaSync/packages`
(requires `packages: read`).

The volumes (`docker_lamasync-data`, `docker_lamasync-backups`) are
**never** touched by `update.sh` — the DB and backups survive every
container recreation.

## Pre-migration backup

A one-off snapshot of `/data` from the 2026-08-03 deployment
consolidation lives at `/home/messhias/lamasync/pre-migration-backup-2026-08-03/`
on the LXC. Safe to delete once you're confident the current
deployment is stable.

## Things to NOT do

- **Don't bind-mount a binary into the container.** Pre-Aug-3, the old
  compose override bind-mounted `/tmp/lamasync-server` over the image's
  own binary, which silently overwrote the freshly-built image and broke
  every update. The current `docker-compose.yml` has no such override.
- **Don't change the volume names** (`docker_lamasync-data`,
  `docker_lamasync-backups`). They're marked `external: true` in
  `docker-compose.yml` — renaming them would orphan the live DB and
  force a re-init from scratch.
- **Don't run `update.sh` as messhias while the cron might also fire.**
  Two simultaneous pulls won't corrupt anything but the log will be
  interleaved. Either disable the cron for that window or just run it —
  the second one is a no-op if the digest didn't change.
