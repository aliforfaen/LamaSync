# `lamasync` CLI reference (LAMA-229)

The full subcommand reference for the `lamasync` binary. The CLI is the
primary agent surface; the REST/WS API (see `reference/api.md`) is the
documented escape hatch when the CLI doesn't express what you need.

This reference is **sourced from** `lamasync <command> --help` — the drift
checker (`scripts/check-skill-drift.ts`) verifies every command and flag
mentioned here exists in the CLI's help output and runs in CI. If you add
or rename a command/flag, update the relevant section below AND the help
block in `packages/tui/src/cli/dispatch.ts`, then run
`bun scripts/check-skill-drift.ts` locally (no generator script exists —
this file stays curated prose on top of the help texts).

## Conventions

- **Output**: every command prints a human-readable table by default. Add
  `--json` (or `-j`) to get a machine-readable JSON object on stdout.
- **Exit codes** (stable contract):
  - `0` ok
  - `1` runtime error
  - `2` usage error (bad flag / missing argument)
  - `3` auth failure (HTTP 401/403 — wrong key) **OR** no `client.toml`
    found (LAMA-248 / endgame — explicit subcommands refuse before any
    network attempt when the file is missing). Distinguish the two with
    `--json`: `{reason:"auth-failure"}` vs `{reason:"no-config"}`.
  - `4` server unreachable (network / DNS / TLS)
- **Auth discovery** order (LAMA-229):
  1. `--server URL` / `--api-key KEY` on the command line
  2. `LAMASYNC_SERVER_URL` / `LAMASYNC_API_KEY` env vars
  3. `~/.config/lamasync/client.toml` (written by the installer — on a
     daemon host this is always present, so an agent needs no setup)
- **Split-by-surface fallback (LAMA-248 / endgame)**: bare `lamasync`
  (interactive TUI or `LAMASYNC_NO_TUI=1`) keeps the friendly
  `localhost/dev-key` default + the LAMA-254 loud warning when no
  `client.toml` exists — that's a local-dev affordance. Any explicit
  subcommand (`lamasync folders list`, `lamasync doctor`, …) refuses
  fast instead. Two exemptions: `lamasync doctor` (diagnosing the
  missing-config state is its job) and the `lamasync local *` subtree
  (talks to the daemon Unix socket, not the server).
- **API key masking**: all output, including diagnostics, masks the key as
  `lamasync_…xxxx` (first 8 + last 4). The CLI's `--doctor` re-masks
  whatever it found in the chosen source.

## Top-level usage

```
Usage: lamasync <command> [args] [--json] [--server URL] [--api-key KEY]

Commands:
  status                  Fleet health + per-host status
  folders list            List folders
  folders create          Create a folder (--name, --type, ...)
  folders assign          Assign a folder to a host (--host, --path)
  backends list           List reusable backends
  backends create         Create a backend (--name, --kind, ...)
  backends test           Test a backend by id
  sync [folderId]         Trigger a sync (--host, optional --folder)
  ops list                List operations (--status, --host, --folder, --limit)
  doctor                  Structured health report (env, server, socket, version)
  local status            Local daemon status (Unix socket)
  local folders           List local folder assignments
  local ops               List local operation log
  local sync [folderId]   Trigger sync for one folder via the socket
  local sync-all          Trigger sync for every folder
  local mount <id>        Switch folder to mount mode
  local unmount <id>      Switch folder back to sync mode

Common flags:
  --json, -j              Machine-readable JSON output
  --server URL            Override the server URL
  --api-key KEY           Override the API key (also MASKED in any output)
  --help, -h              Show help for lamasync <command>
```

## `lamasync status`

```
Usage: lamasync status [--json]
```

Calls `GET /api/v1/health` and prints fleet status. Default output is a
brief summary line + per-host table (`HOSTNAME`, `ID`, `STATUS`, `LAST SEEN`,
`VERSION`). `--json` emits the raw `HealthResponse` from the API
(`serverVersion`, `dbSizeBytes`, `hosts[]`).

## `lamasync folders list`

```
Usage: lamasync folders list [--json]
```

Lists folder definitions (`id`, `name`, `type`, `backend`, `s3Bucket`,
`backendId`).

## `lamasync folders create`

```
Usage: lamasync folders create [flags]

  --name <name>           folder name (required)
  --type <type>           sync | mount | backup | dotfile | git (required)
  --backend <kind>        sftp | s3 | local | nfs | restic (default: sftp)
  --s3-backend-id <id>    reuse a stored S3 backend (LAMA-222)
  --s3-bucket <bucket>    required when --backend=s3
  --s3-provider <p>       exoscale | aws | other (default: other)
  --s3-endpoint <url>     required when --backend=s3 (unless using backendId)
  --s3-access-key-id <k>  S3 access key id
  --s3-secret-access-key <s>  S3 secret (write-only; never echoed)
  --s3-region <r>         region (e.g. us-east-1); required for aws
  --backend-id <id>       reference a local/nfs/restic backend row
```

Inline S3 creds (`--s3-endpoint` + `--s3-access-key-id` +
`--s3-secret-access-key` + `--s3-region` for AWS) auto-create a backend
row and reuse it; the new backend's id is printed for follow-up commands.
Use `--s3-backend-id <id>` to reference an existing backend instead.

## `lamasync folders assign`

```
Usage: lamasync folders assign <folderId> [flags]

  --host <hostId>        host id (required)
  --path <localPath>     absolute local path (required)
  --role <role>          source | target | both (default: both)
  --schedule <cron>      cron expression (optional)
  --enabled              mark the assignment enabled (default)
  --disabled             mark the assignment disabled
```

## `lamasync backends list`

```
Usage: lamasync backends list [--json]
```

Lists reusable backends (`s3`/`local`/`nfs`/`restic`). Secrets are never
echoed; `hasSecret` is a boolean signal that one is stored.

## `lamasync backends create`

```
Usage: lamasync backends create [flags]

  --name <name>            backend name (required)
  --kind <kind>            s3 | local | nfs | restic (required)
  --s3-provider <p>        exoscale | aws | other (default: other)
  --s3-endpoint <url>      required (s3)
  --s3-region <r>          required for aws
  --s3-access-key-id <k>   required (s3)
  --s3-secret-access-key <s>  required (s3); write-only
  --local-path <dir>       absolute server-side directory (local/nfs)
  --restic-repository <u>  restic repository (restic)
  --restic-password <pw>   restic password (restic)
```

## `lamasync backends test`

```
Usage: lamasync backends test <backendId> [--json]
```

Wraps `POST /api/v1/backends/:id/test`. Prints `OK` or `FAIL`; exits
non-zero on FAIL.

## `lamasync sync`

```
Usage: lamasync sync [folderId] --host <hostId> [--json]
       lamasync sync --all --host <hostId>     # sync every assignment

  --host <hostId>    host id (required)
  --all              sync every assignment on the host (default when no folderId)
  --dry-run          request a dry-run ack from the daemon
```

Triggers a `trigger_sync` queued action. The daemon polls every 5 seconds;
verify the run with `lamasync ops list --host <hostId>`.

## `lamasync ops list`

```
Usage: lamasync ops list [flags]

  --status <s>     filter by status (started|success|failed|conflict|recovery|retry)
  --host <id>      filter by host
  --folder <id>    filter by folder
  --limit <n>      max rows (default 50, max 500)
  --json           machine-readable output
```

Default columns: `WHEN`, `HOST`, `OP`, `STATUS`, `DUR`, `SUMMARY`, `ID`.

## `lamasync doctor`

```
Usage: lamasync doctor [--json]
```

Structured health report. Checks (in order):

1. env vars (`LAMASYNC_SERVER_URL` / `LAMASYNC_API_KEY` presence)
2. auth source + **masked** API key (`lamasync_…xxxx`)
3. server reachability (`GET /api/v1/health`) and round-trip latency
4. daemon Unix socket probe (`defaultSocketPath`)
5. binary vs latest release version drift (GitHub Releases)

Exits non-zero when **any** check has `ok: false`. Always safe to run.

Doctor is **exempt from the no-config refusal** (LAMA-248 / endgame
split-by-surface): it can run with no `client.toml` because diagnosing
that exact state is part of its job. When `auth: source` resolves to the
localhost/dev-key default the advice row now reads "only used for
bare-TTY (subcommands refuse exit 3 without client.toml)" — that's the
operator-facing summary of the split-by-surface contract.

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

## `lamasync folders update`

```
Usage: lamasync folders update <folderId> [flags]

  --name <name>           new name
  --type <type>           sync | mount | backup | dotfile | git
  --backend <kind>        sftp | s3 | local | nfs | restic
  --backend-id <id>       reference an existing Backend row
  --s3-bucket <bucket>    per-folder S3 bucket
  --s3-backend-id <id>    alias of --backend-id for S3 folders
  --git-provider <p>      git | gh
  --git-remote <remote>   <user>/<repo>
  --encrypted             enable at-rest encryption (LAMA-124)
```

## `lamasync folders delete`

```
Usage: lamasync folders delete <folderId> [--yes]

  --yes, -y           skip the confirmation prompt (required non-interactively)
```

DESTRUCTIVE (safety rule 5). Cascades to assignments and snapshots.

## `lamasync folders unassign`

```
Usage: lamasync folders unassign <folderId> --host <hostId> [--yes]

  --host <hostId>    host id (required)
  --yes, -y          skip the confirmation prompt (required non-interactively)
```

DESTRUCTIVE (safety rule 5).

## `lamasync folders assignments`

```
Usage: lamasync folders assignments <folderId> [--json]
```

Lists every host assignment for a folder (hostId, role, path, schedule,
enabled).

## `lamasync dotfiles list`

```
Usage: lamasync dotfiles list [--host <id>] [--json]
```

Lists dotfile manifests. `--host _global` is the global default; an actual
host id is host-specific.

## `lamasync dotfiles manifests list`

```
Usage: lamasync dotfiles manifests list [flags]

  --host <id>    filter by host (omit for _global)
  --json         machine-readable JSON output
```

## `lamasync dotfiles manifests create`

```
Usage: lamasync dotfiles manifests create --app-name NAME --paths p1,p2 [flags]

  --app-name <name>        app name (required)
  --paths <p1,p2>          comma-separated paths (required)
  --host <id|_global>      target host (default: _global)
  --excludes <e1,e2>       comma-separated exclude globs
  --schedule '<cron>'      sync schedule
  --instructions '<text>'  operator notes
  --json
```

## `lamasync dotfiles manifests delete`

```
Usage: lamasync dotfiles manifests delete <id> [--yes]

  --yes, -y    skip the confirmation prompt (required non-interactively)
```

DESTRUCTIVE (safety rule 5) — cascades to all versions of the manifest.

## `lamasync dotfiles upload`

```
Usage: lamasync dotfiles upload --app <name> --file <tarball> [flags]

  --app <name>          app name (required)
  --file <tarball>      tarball file path (required)
  --description <text>  optional label
  --host <id>           target host (omit for _global)
```

## `lamasync dotfiles download`

```
Usage: lamasync dotfiles download --app <name> --version <id> --out <path>
```

`--out` is required; the downloaded tarball is written there. The plain
JSON output only reports size + MIME.

## `lamasync conflicts list`

```
Usage: lamasync conflicts list [--host <id>] [--folder <id>] [--status pending|resolved] [--json]
```

## `lamasync conflicts resolve`

```
Usage: lamasync conflicts resolve <id> --keep local|remote|both
```

## `lamasync snapshots list`

```
Usage: lamasync snapshots list [--folder <id>] [--host <id>] [--json]
```

Lists restic snapshots. `restore` enqueues a restore job (asynchronous).

## `lamasync restore`

```
Usage: lamasync restore <snapshotId> --to <hostId> --path <targetPath> [--yes] [--include p1,p2]

  --snapshot <id>   restic snapshot id (positional <snapshotId> also accepted)
  --to <hostId>     target host (required)
  --path <path>     destination path on the target host (required)
  --folder <id>     folder id (defaults to the snapshot's folder)
  --include <list>  comma-separated path filter
  --yes, -y         skip the confirmation prompt (required non-interactively)
```

DESTRUCTIVE (safety rule 5). The path on the target host is overwritten
with the snapshot contents.

## `lamasync browse`

```
Usage: lamasync browse local|s3|restic|jobs [flags]

  local    --path <rel> [--json]   browse the server backup dir
  s3       --folder <id> [--path <prefix>] [--json]
  restic   [--json]                list restic snapshots (read-only)
  jobs     [--json]                recent browse write jobs
```

Reads only — write ops (copy/move/rename/mkdir/upload/delete) stay in the
REST API surface for now; see `reference/api.md`.

## `lamasync notifications list`

```
Usage: lamasync notifications list [--json]
```

Lists the durable notification history (newest first).

## `lamasync notifications channels`

```
Usage: lamasync notifications channels [--json]
```

Lists configured delivery channels (ntfy / webhook).

## `lamasync hosts list`

```
Usage: lamasync hosts list [--json]
```

Lists every registered host with id, status, version, tailnet ip, last
seen.

## `lamasync hosts rename`

```
Usage: lamasync hosts rename <hostId> --hostname <new> [--yes]
```

DESTRUCTIVE (safety rule 5). Renames a host (label-only; id stays stable;
the daemon re-keys on its next registration under the new name).

## `lamasync register`

```
Usage: lamasync register --hostname <name> [--tailnet-ip <ip>]
```

The agent fallback for the install script's web UI flow. Idempotent;
existing rows are updated in place.

## `lamasync shares list`

```
Usage: lamasync shares list [--json]
```

Lists NFS / SMB shares configured on the server.

## `lamasync admin prune`

```
Usage: lamasync admin prune --older-than <ms|d|h> [--yes]
```

DESTRUCTIVE (safety rule 5). Manually trims the operation log by age.
`<older-than>` accepts `1d | 7d | 30d` shorthand or a raw millisecond count.

## See also

- `reference/api.md` — REST + WebSocket escape hatch.
- `reference/recipes.md` — common workflows built from these commands.
- `reference/troubleshooting.md` — what to do when something fails.
