# Production deploy — `lamasync` LXC

The production server runs in an LXC container named `lamasync` at
`100.113.52.108` (Tailscale only). This file is the canonical reference
for **how to interact with that container** — SSH, updates, health checks,
where things live. Historical context (how the current layout came to be)
lives in `docs/status.md`.

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
  `0 4 * * * /home/messasync/lamasync/update.sh` daily at 04:00 (local).
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
- Root SSH from `cachy` is reportedly denied (per
  `docs/status.md` 2026-08-10 entry) — the procedure above is from
  `cachytop`/this host. If you need root from a different machine,
  append its public key to `/root/.ssh/authorized_keys` on the LXC.

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
via `docker pull` history or `gh api repos/aliforaen/LamaSync/packages`
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
