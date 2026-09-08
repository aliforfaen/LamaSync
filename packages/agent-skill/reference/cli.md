# `lamasync` CLI reference (LAMA-229, trimmed LAMA-326)

The subcommand reference for the `lamasync` binary. The CLI is
**local-first**: it talks to the local daemon (Unix socket), reports host
health, and pairs the device. Fleet management is NOT a CLI surface — use
the web UI (human) or the REST API (see `reference/api.md`; that is the
documented agent escape hatch).

This reference is **sourced from** `lamasync <command> --help` — the drift
checker (`scripts/check-skill-drift.ts`) verifies every command and flag
mentioned here exists in the CLI's help output and runs in CI. If you add
or rename a command/flag, update the relevant section below AND the help
block in `packages/cli/src/cli/dispatch.ts`, then run
`bun scripts/check-skill-drift.ts` locally (no generator script exists —
this file stays curated prose on top of the help texts).

## Conventions

- **Output**: every command prints a human-readable table by default. Add
  `--json` (or `-j`) to get a machine-readable JSON object on stdout.
- **Exit codes** (stable contract):
  - `0` ok
  - `1` runtime error
  - `2` usage error (bad flag / missing argument)
  - `3` auth failure (HTTP 401/403 — wrong key)
  - `4` server unreachable (network / DNS / TLS)
- **Auth discovery** order (LAMA-229):
  1. `--server URL` / `--api-key KEY` on the command line
  2. `LAMASYNC_SERVER_URL` / `LAMASYNC_API_KEY` env vars
  3. `~/.config/lamasync/client.toml` (written by the installer or
     `lamasync register` — on a daemon host this is always present, so an
     agent needs no setup)
- **No interactive mode (LAMA-323)**: the binary is purely non-interactive.
  Bare `lamasync` prints concise top-level help and exits 0.
- **Credential masking**: all output, including diagnostics, masks the
  credential to its first 8 + last 4 characters (for example
  `lmsk.ABCDEFG…xxxx`). The CLI's `--doctor` re-masks whatever it found in
  the chosen source.

## Top-level usage

```
lamasync — local control for the LamaSync daemon on this device. Bare `lamasync` prints this help; any subcommand exits non-interactively.

Usage: lamasync <command> [args] [--json] [--server URL] [--api-key KEY]

Commands:
  doctor                  Structured health report (env, server, socket, version) — runs even without client.toml
  local status            Local daemon status (Unix socket)
  local folders           List local folder assignments
  local ops               List local activity (operation log)
  local sync [folderId]   Trigger sync for one folder via the socket
  local sync-all          Trigger sync for every folder
  local mount <id>        Switch folder to mount mode
  local unmount <id>      Switch folder back to sync mode
  register                Pair this device with the fleet via a web UI code (LAMA-262)

Fleet management (folders, schedules, backends, app backups, conflicts,
notifications, browsing, admin) lives in the web UI and the REST API —
see packages/agent-skill/reference/api.md.

Common flags:
  --json, -j              Machine-readable JSON output
  --server URL            Override the server URL (doctor / register)
  --api-key KEY           Override the API key (also MASKED in any output)
  --help, -h              Show help for lamasync <command>

Exit codes (stable contract for the skill's drift check, LAMA-230):
  0 ok, 1 runtime error, 2 usage error,
  3 auth failure (401/403), 4 server unreachable

Run 'lamasync <command> --help' for command-specific help.
```

## Fleet management moved to the REST API (LAMA-326)

The former server-facing commands (`status`, `folders`, `backends`,
`sync`, `ops`, `backup legacy`, `apps`, `conflicts`, `snapshots`,
`restore`, `browse`, `notifications`, `hosts`, `shares`, `admin prune`)
are removed from the CLI. Their API equivalents (all documented in
`reference/api.md`):

| Former command | API replacement |
|---|---|
| `status` | `GET /health` |
| `folders list/create/assign/...` | `GET/POST/PATCH/DELETE /folders` (+ `/folders/:id/assignments`) |
| `backends list/create/test` | `GET/POST /backends`, `POST /backends/:id/test` |
| `sync [folderId]` | `POST /hosts/:id/actions` `{"type":"trigger_sync"}` |
| `ops list` | `GET /operations` |
| `backup legacy` | `GET/POST /backup/legacy-root` |
| `apps templates/protections/snapshots` | `/apps/templates`, `/apps/protections`, `/apps/protections/:id/snapshots` |
| `conflicts list/resolve` | `GET /conflicts`, `POST /conflicts/:id/resolve` |
| `snapshots list` / `restore` | `GET /restic/snapshots`, restore job endpoint |
| `browse local/s3/restic/jobs` | `/browse` endpoints |
| `notifications list/channels/test` | `/notifications` endpoints |
| `hosts list/rename` | `GET /hosts`, `PATCH /hosts/:id` |
| `shares list` | `GET /shares` |
| `admin prune` | admin prune endpoint (see api.md) |

For raw daemon-socket access without the CLI (LAMA-326 debug affordance):
the socket speaks one line of JSON per connection — `{"cmd":"status"}` →
`{"ok":true,"data":...}` — and can be driven with socat:

```
printf '%s\n' '{"cmd":"status"}' | socat - UNIX-CONNECT:$XDG_RUNTIME_DIR/lamasync.sock
```

## `lamasync doctor`

```
Usage: lamasync doctor [--json]
```

Structured health report. Checks (in order):

1. env vars (`LAMASYNC_SERVER_URL` / `LAMASYNC_API_KEY` presence)
2. auth source + **masked** credential (first 8 + last 4 characters)
3. server reachability (`GET /api/v1/health`) and round-trip latency
4. daemon Unix socket probe (`defaultSocketPath`)
5. binary vs latest release version drift (GitHub Releases)

Exits non-zero when **any** check has `ok: false`. Always safe to run.

Doctor runs without a `client.toml` — diagnosing that exact state is
part of its job. When `auth: source` resolves to the localhost/dev-key
default, the advice row points at `lamasync register` or re-running the
install script.

## `lamasync local status`

```
Usage: lamasync local status [--json]
```

Calls the daemon Unix socket (`status` command). Prints hostname,
assignment count, operation count.

## `lamasync local folders`

```
Usage: lamasync local folders [--json]
```

Lists folder assignments on this host (`folderName`, `folderType`, `localPath`,
`lastRun` summary).

## `lamasync local ops`

```
Usage: lamasync local ops [--json]
```

Lists recent local operations (`whenLabel`, `folderLabel`, `operation`,
`status`, `summary`).

## `lamasync local sync <folderId>`

```
Usage: lamasync local sync <folderId> [--json]
```

Sends `{"cmd":"sync","folderId":"<id>"}` to the daemon socket. The daemon
runs the sync immediately (no 5s poll delay). Follow with
`lamasync local ops` to verify.

## `lamasync local sync-all`

```
Usage: lamasync local sync-all [--json]
```

Sends `{"cmd":"sync-all"}` — triggers every folder assignment on this host.

## `lamasync local mount <folderId>`

```
Usage: lamasync local mount <folderId> [--json]
```

Switches the folder to mount mode. Maps to `{"cmd":"switch-to-mount"}` on
the socket.

## `lamasync local unmount <folderId>`

```
Usage: lamasync local unmount <folderId> [--json]
```

Switches the folder back from mount to sync mode. Maps to
`{"cmd":"switch-to-sync"}` on the socket.

## `lamasync register`

```
Usage: lamasync register --code <lama-XXXX-XXXX> --server URL [--hostname <name>] [--force] [--json]

  --code <lama-XXXX-XXXX>   pairing code from the web UI (case-insensitive)
  --server URL              server URL (also: LAMASYNC_SERVER_URL env)
  --hostname <name>         client.toml hostname (defaults to os.hostname())
  --force                   overwrite an existing client.toml
  --json                    machine-readable JSON output
```

Pair this device with the fleet by exchanging a short code from the web
UI for a `client.toml` so the daemon can talk to the server. Replaces
the previous "agent fallback for the install script" flow (LAMA-262).

The command refuses (exit 1) if a `client.toml` already exists at the
default path; pass `--force` to overwrite.

Failure modes (exit codes):

- `1` runtime / API error (code already used, expired, server misconfig, etc.)
- `2` usage error (missing `--code` non-interactively, missing `--server`,
  malformed code shape)
- `4` server unreachable (network / DNS / TLS)

Wire contract (mirrors `reference/api.md`): the exchange endpoint is
auth-exempt by design — the code itself proves intent. The body sends
`{ hostId, hostname }` (hostId = the hostname that lands in
`client.toml`); LAMA-234 binds the minted device key to exactly that
host, so a `--hostname` mismatch later means the daemon gets 403/401
until the operator re-pairs. Single-use; the
second exchange returns 409 and the operator must mint a new code. The
returned `apiKey` is the server's pre-shared `LAMASYNC_API_KEY` (the
`--api-key` mask in any echo is `real-key…7890`-style).

## See also

- `reference/api.md` — REST + WebSocket escape hatch.
- `reference/recipes.md` — common workflows built from these commands.
- `reference/troubleshooting.md` — what to do when something fails.
