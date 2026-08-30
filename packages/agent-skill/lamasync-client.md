---
name: lamasync-client
description: Install and operate LamaSync as a client on this host — prereqs, daemon/TUI install, registration verification, and day-2 usage against the fleet server.
---

# lamasync-client

## What it is

LamaSync is a personal sync-fleet system: one central `lamasync-server`
(REST + WebSocket + SQLite, tailnet-only) and a lightweight `lamasyncd`
daemon per client host that runs `rclone` for folder syncs, backups, and
dotfile versions on server-pushed schedules. All control (folders,
assignments, schedules) lives on the server; the daemon just heartbeats,
pulls its config bundle, and executes.

Use this skill when your task is to **set this host up as a LamaSync
client** or operate the local daemon. For direct server API operations
(folders, assignments, dotfiles, operation log), see the `lamasync` skill
(CLI-first; `reference/api.md` is the REST/WS escape hatch).

## Fleet facts (current production)

- Server base URL: `http://100.113.52.108:8080` (tailnet-only — plain
  HTTP, the tailnet provides encryption).
- Server runs in Docker on an LXC container; it auto-updates from GHCR
  daily at 04:00.
- Auth supports the break-glass master key plus managed admin/device keys;
  paired clients should use their host-bound device key. The Web UI normally
  uses a master or managed admin key.
- **Getting the API key**: never guess or generate one — it must match the
  server's `LAMASYNC_API_KEY`. Ask the user, or read it from an existing
  client's `~/.config/lamasync/client.toml` (`apiKey = "..."`) if you have
  access to one. Never commit it anywhere.

## Prereqs — check before installing

1. **On the tailnet**: `tailscale status` works and
   `curl -s -o /dev/null -w '%{http_code}' http://100.113.52.108:8080/api/v1/health`
   returns `401` (reachable, needs auth). If unreachable, stop and fix
   tailnet connectivity first.
2. **rclone installed system-wide**: `command -v rclone`. The daemon's
   systemd unit sets `PATH=$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin`,
   so rclone must live in one of those — a package-manager install
   (`/usr/bin/rclone`) is safest. Never build/install rclone inside the
   repo worktree.
3. **systemd user session**: `systemctl --user status` works. The
   installer enables lingering so the daemon survives logout.
4. `curl` present (installer downloads release binaries).

## Install

Preferred, from a clone of the repo (builds binaries locally, no GitHub
release dependency):

```bash
bun install && bun run build   # produces packages/daemon/dist/lamasyncd etc.

./packaging/install/install.sh \
  --server-url http://100.113.52.108:8080 \
  --api-key "$LAMASYNC_API_KEY" \
  --with-tui
```

Or the one-liner, which downloads binaries from the latest GitHub Release
(falls back to `./packages/*/dist/` when run inside a clone):

```bash
curl -sSL https://raw.githubusercontent.com/aliforfaen/LamaSync/master/packaging/install/install.sh | bash -s -- \
  --server-url http://100.113.52.108:8080 \
  --api-key "$LAMASYNC_API_KEY" \
  --with-tui
```

The installer:

- installs `lamasyncd` (and `lamasync-tui` with `--with-tui`) into `~/.local/bin`
- writes `~/.config/lamasync/client.toml` (mode 600) with serverUrl/apiKey/hostname
- installs + enables + starts the systemd **user** unit `lamasyncd.service`
- enables lingering

The `hostname` in client.toml (default: `hostname`) becomes the **host id**
in the fleet — it is how folders get assigned to this machine. Keep it
stable; override at install time with `--hostname <name>` if the machine's
hostname isn't the id you want.

## Verify the install

```bash
systemctl --user status lamasyncd          # active (running)
journalctl --user -u lamasyncd -n 50       # registration + heartbeat lines

# The host is registered and heartbeating:
curl -s -H "Authorization: Bearer $LAMASYNC_API_KEY" \
  http://100.113.52.108:8080/api/v1/hosts | python3 -m json.tool
# → your hostname with status "online", a recent lastSeen, and a version
```

The daemon self-updates (`ExecStartPre=--check-update`, or `lamasyncd
--update` manually) from GitHub Releases.

## Day-2 usage

- **Everything is configured server-side.** Folders, host assignments,
  schedules, dotfile manifests: use the Web UI (`http://100.113.52.108:8080/`,
  log in with the API key) or the REST API (`lamasync` skill →
  `reference/api.md`). There is no local config of jobs on the client.
- The daemon re-pulls its config on heartbeat when the server's
  `config_revision` changes, plus a 5-minute poll. To apply a new
  assignment immediately, enqueue an action:

  ```bash
  curl -X POST -H "Authorization: Bearer $LAMASYNC_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"type":"refresh_config"}' \
    http://100.113.52.108:8080/api/v1/hosts/<hostId>/actions
  # also: {"type":"trigger_sync"} / {"type":"trigger_backup"} (optional payload {"folderId":"..."})
  ```

- **TUI**: `lamasync-tui` talks to the local daemon over its Unix socket.
  For agents / no-TTY contexts use the CLI fallback: `LAMASYNC_NO_TUI=1 lamasync-tui`.
- **Local state**: `~/.local/share/lamasync` (config cache),
  socket at `$XDG_RUNTIME_DIR/lamasync.sock`.

## Gotchas (all hit in production at least once)

- **Socket path**: the daemon socket defaults to
  `$XDG_RUNTIME_DIR/lamasync.sock` (`~/.lamasync/lamasync.sock` fallback);
  override with `LAMASYNC_SOCKET_PATH` (env) or `socketPath` in
  `~/.config/lamasync/client.toml` (`defaultSocketPath` in `@lamasync/core`
  is the single source of truth).

- **"rclone binary not found in PATH"** in operation results: rclone is
  installed somewhere outside the unit's PATH (see Prereqs). Move/symlink
  it into `/usr/local/bin` or adjust `Environment=PATH=` in
  `~/.config/systemd/user/lamasyncd.service`, then
  `systemctl --user daemon-reload && systemctl --user restart lamasyncd`.
- The unit runs with `ProtectHome=read-only`; writes under `$HOME` are
  limited to `ReadWritePaths` (lamasync dirs, `~/projects`,
  `/run/user/<uid>`). `backup`-type folders (read local → write remote)
  work anywhere; `sync`-type folders that must **write** outside those
  paths need the unit's `ReadWritePaths` extended.
- Dotfile manifests **hard-fail the whole run if any listed path is
  missing** on the host — keep host-specific manifests host-specific
  (create them with `hostId` set), or use `backup`-type folders instead.
  (Former "backup summaries show 0 transfers" gotcha is fixed in LAMA-247:
  the JSON-log accumulator now reads both rclone stdout and stderr.)
- Don't run a bare `lamasyncd` to "test" it — the systemd service owns the
  daemon; a second instance just fights over the socket.

## See also

- `lamasync` skill (sibling) — CLI-first with `reference/api.md` as the REST
  escape hatch.
- `README.md` in the repo root — architecture, server deployment, TUI.
- `ARCHITECTURE.md` — system design and DB schema.
