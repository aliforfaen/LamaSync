---
name: lamasync
description: Operate a LamaSync fleet — manage folders, hosts, backends, sync triggers, app templates/protections/snapshots, and operation history. Use when the task touches `lamasync`, `lamasyncd`, sync fleet, rclone fleet, backup host, `register host`, `add folder`, `set up backup`, `check for update`, `snapshot`, `app template`, `app protection`, `enroll app`, `app backup`, `lamasync 401`, or `lamasync auth failed`. The local `lamasync` CLI is the agent surface for daemon control, diagnostics, and registration; fleet management is the REST API + web UI (see `reference/api.md`).
---

# lamasync

## What it is

LamaSync is a personal sync-fleet system: one `lamasync-server` (the control
plane, REST + WebSocket + Swagger + SQLite) and a lightweight `lamasyncd`
daemon per host that runs `rclone` for syncs, backups, and mounts. Auth has no
user accounts or OAuth: the break-glass master key plus managed admin/device
keys are the trust boundary. The tailnet provides transport encryption.

## Decision tree

The `lamasync` CLI (LAMA-326) is **local-first**: it drives the local daemon
(`local *`), reports host health (`doctor`), and pairs the device
(`register`). Fleet management — folders, hosts, backends, schedules, app
backups, conflicts, notifications, browsing, and admin — is **not** a CLI
surface; use the web UI (human) or the REST API (agent).

1. **Need daemon control / host diagnostics / registration on this host?**
   Use the CLI. **Always run `lamasync doctor` first** on a fresh host to
   check auth discovery, server reachability, and version drift; the full
   local-command reference lives in `reference/cli.md`.
2. **Need a fleet-management operation (folders, hosts, backends, schedules,
   app backups, conflicts, notifications, browsing, admin)?** Use the REST
   API (`reference/api.md`) or the web UI — the CLI no longer expresses
   these (LAMA-326). If the API doesn't express it either, do *not*
   hand-roll curl against undocumented endpoints or the Unix-socket
   protocol; stop and ask a human — that gap is a bug.
3. **Need to install this host as a client?** The skill `lamasync-client.md`
   covers prereqs, the install script, and day-2 daemon usage.
4. **Need to do something destructive (delete folder, force restore, prune
   ops, rotate key, stop mounts)?** That is safety rule 5 below: confirm
   intent with the operator first, then pass `--yes` if the command asks.
5. **Need to set up or operate an app backup?** The model is templates →
   protections → snapshots, managed over the REST API (see
   `reference/api.md`): `POST /apps/templates` defines what to capture,
   `POST /apps/protections` binds a template to one host, and the snapshots
   endpoints move archives (templates, enrollment, and destructive ops are
   admin-only; a device key reaches only its own host's protections +
   snapshots).

All commands take `--json` for machine output and obey a stable exit code
contract (see `reference/cli.md`): `0` ok, `1` runtime, `2` usage error,
`3` auth failure (401/403), `4` server unreachable.

## Auth discovery order

The CLI and the daemon use the same precedence chain. `--server` and
`--api-key` flags on the command line win, then `LAMASYNC_SERVER_URL` and
`LAMASYNC_API_KEY` env vars, then `~/.config/lamasync/client.toml` (written
by `packaging/install/install.sh`). On a daemon host that already runs
`lamasyncd`, the config file is always present — an agent needs zero setup.

Credentials are **always masked** in output as their first 8 + last 4
characters, e.g. `lmsk.ABCDEFG…xxxx` (master keys may begin `lamasync_`).

## Credentials (LAMA-234)

The server accepts three kinds of bearer credential:

- **master** — `LAMASYNC_API_KEY` env value; super-admin, never stored or
  shown.
- **admin** — managed key created in the Web Admin → **Access keys** (or
  `POST /api/v1/api-keys`); full management surface, may manage other keys.
- **device** — minted by pairing (`lamasync register --code …`); bound to
  one host, confined to that host's own daemon calls.

Diagnose auth failures with the wire contract: `401` = missing / wrong /
revoked key; `403` = valid key without authority for that route (device key
on an admin route, or touching another host's rows). `GET /api/v1/auth/me`
identifies the active credential.

## Safety — the six rules (summary)

The full, verbatim contract lives in `reference/safety.md`. The rules are:

1. **API trust, no user accounts.** Master/admin/device credentials are the
   trust boundary; there are no user accounts or OAuth sessions. If a task
   seems to need per-user authz, escalate to a human.
2. **Never invoke `rclone` directly.** All transfers go through the daemon
   executor, which owns locks and writes the operation report.
3. **Prefer the WebSocket** for live state; don't poll `GET /operations` in
   a tight loop.
4. **Mask credentials** — never log, print, or commit them; always show only
   the first 8 + last 4 characters (for example `lmsk.ABCDEFG…xxxx`) in
   examples, diagnostics, and step descriptions.
5. **Mutations need intent.** Reads are free. Writes (and destructive
   commands) need explicit user intent — confirm before delete folder,
   force restore, rotate key, stop mounts, prune logs.
6. **Never invent local state.** If the CLI can't express it, stop and
   ask; do not hand-edit `config.toml`, the SQLite DB, or rclone configs.

## Layout

```
packages/agent-skill/
  SKILL.md                  this file (trigger + decision tree + safety summary)
  reference/
    cli.md                  full `lamasync` subcommand reference (Phase A)
    api.md                  REST + WebSocket reference; defers to /swagger/json
    recipes.md              set up a backup, add a sync folder, fix 401s,
                            trigger + verify a sync, restore a snapshot,
                            resolve a conflict
    troubleshooting.md      heartbeat missing, mount stuck, stale lock,
                            update failures
    safety.md               the six safety rules, verbatim
  lamasync-client.md        unchanged; stays a separate onboarding skill
```

Installed to `~/.agents/skills/lamasync/` (SKILL.md + reference/). Global
user scope — never committed to a consuming repo.

## Trigger phrases

This skill should match the language an operator naturally types when
working with the fleet:

- `lamasync`, `lamasyncd`
- `sync fleet`, `rclone fleet`, `backup host`
- `register host`, `add folder`, `set up backup`
- `check for update`, `snapshot`, `app template`, `app protection`,
  `enroll app`, `app backup`, `app snapshot`
- `lamasync 401`, `lamasync auth failed`

If the user is asking something about the Web UI / Management pages rather
than the CLI / API, the doc URLs in the Web UI itself are usually enough —
prefer them unless the user is in a headless / scripted context.

## See also

- `lamasync-client.md` — install and operate this host as a LamaSync
  client (prereqs, install script, registration).
- `README.md` in the repo root, `ARCHITECTURE.md` for system design and
  DB schema (if you can read the repo).
