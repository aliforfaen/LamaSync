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
  fast instead. Three exemptions: `lamasync doctor` (diagnosing the
  missing-config state is its job), the `lamasync local *` subtree
  (talks to the daemon Unix socket, not the server), and `lamasync
  register` (LAMA-262 — writes the `client.toml` as its first
  side-effect, so refusing without one would be a chicken/egg).
- **Credential masking**: all output, including diagnostics, masks the
  credential to its first 8 + last 4 characters (for example
  `lmsk.ABCDEFG…xxxx`). The CLI's `--doctor` re-masks whatever it found in
  the chosen source.

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
  --s3-provider <p>       b2 | exoscale | aws | other (default: other)
  --s3-endpoint <url>     required when --backend=s3 (unless using backendId)
  --s3-access-key-id <k>  S3 access key id
  --s3-secret-access-key <s>  S3 secret (write-only; never echoed)
  --s3-region <r>         region (e.g. us-east-1); required for aws and b2
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
  --destination <path>   explicit remote prefix (optional; shared backup use)
  --enabled              mark the assignment enabled (default)
  --disabled             mark the assignment disabled
  --watch                sync after local changes (LAMA-302)
  --no-watch             disable event-triggered sync (default)
  --watch-quiet <sec>    debounce seconds (10-300, default 30)
  --ignore-git-metadata  exclude .git/ from watcher + bisync
  --respect-gitignore    apply Git ignore semantics
```

> **LAMA-302:** `--watch` opts the assignment into event-triggered sync
> (Linux-only, inotify). Only effective `sync` assignments honor it; it is
> disabled by default and never alters an existing cron expression. The 15-min
> `*/15 * * * *` schedule is the recommended periodic reconciliation backstop.

## `lamasync folders assign-update`

```
Usage: lamasync folders assign-update <folderId> --host <hostId> [flags]

  --host <hostId>        host id (required)
  --schedule <cron>      cron expression (optional)
  --watch                sync after local changes (LAMA-302)
  --no-watch             disable event-triggered sync
  --watch-quiet <sec>    debounce seconds (10-300, default 30)
  --ignore-git-metadata  exclude .git/ from watcher + bisync
  --respect-gitignore    apply Git ignore semantics
```

Updates an existing device assignment (watch settings, schedule) via
`PATCH /api/v1/folders/:folderId/assign/:hostId`.

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
  --s3-provider <p>        b2 | exoscale | aws | other (default: other)
  --s3-endpoint <url>      required (s3)
  --s3-region <r>          required for aws and b2
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

  --status <s>     filter by status (started|success|failed|conflict|recovery|retry|deferred)
  --host <id>      filter by host
  --folder <id>    filter by folder
  --limit <n>      max rows (default 50, max 500)
  --json           machine-readable output
```

Default columns: `WHEN`, `HOST`, `OP`, `STATUS`, `DUR`, `SUMMARY`, `ID`.

## `lamasync backup legacy`

```
Usage: lamasync backup legacy [--prune] [--yes] [--sizes] [--json]
```

Report (dry-run by default) or prune orphaned legacy shared backup data under
backup folder roots (LAMA-294). Before host-scoped destinations, ordinary
backups wrote directly to `<folder-name>/`; they now write to
`<folder-name>/<host-id>/`. The old shared contents that are **not** a known
host prefix are orphaned.

- Default (`--prune` omitted) is a **safe dry-run**: lists the legacy root,
  and flags each top-level child as `legacy (orphaned)`, `host-prefix (kept)`,
  or `explicit destination (kept)`. Sizes are **not** computed by default
  (shown as `—`); pass `--sizes` to include per-child byte/item counts and a
  total orphaned byte count (slow — full recursive listing per child). No
  remote mutation.
- `--prune --yes` deletes only the orphaned top-level children. Host-scoped
  prefixes and the legacy root itself are never touched (recomputed fresh at
  prune time).
- `--json` returns the raw `LegacyRootReport[]` (or `LegacyRootPruneResult[]`
  when pruning).

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

## `lamasync apps templates list`

```
Usage: lamasync apps templates list [--json]
```

Lists app templates (operator-owned recipes): name, origin, per-OS
candidate-path counts, revision, id. Templates are admin-only on the
server; device keys get 403.

## `lamasync apps templates get`

```
Usage: lamasync apps templates get <id> [--json]
```

Reads one app template, including its full `CaptureSpec` (per-OS paths,
excludes, notes) and install/restore instructions.

## `lamasync apps templates create`

```
Usage: lamasync apps templates create --name <name> [flags]

  --name <name>                  template name (required)
  --origin <built_in|custom>     template origin (default: custom)
  --description <text>           template description
  --emoji <emoji>                single emoji for the web UI card
  --color <color>                color for the web UI card
  --linux-paths <p1,p2>          comma-separated Linux candidate paths
  --macos-paths <p1,p2>          comma-separated macOS candidate paths
  --windows-paths <p1,p2>        comma-separated Windows candidate paths
  --install-url <url>            install instructions URL
  --install-instructions <text>  install steps
  --restore-instructions <text>  restore steps
  --json
```

Creates a reusable recipe. Path flags fill the template's capture spec;
the CLI stamps each path `classification: "unknown"` (LAMA-315 exposes the
taxonomy; no classifier exists yet).

Application capture is currently verified on Linux with GNU tar. macOS and
Windows path buckets can be authored for future devices, but should not be
treated as capture-ready until their archive tooling is qualified.

## `lamasync apps templates update`

```
Usage: lamasync apps templates update <id> [flags]

  --name <name>                  new template name
  --origin <built_in|custom>     template origin
  --description <text>           template description
  --emoji <emoji>                single emoji for the web UI card
  --color <color>                color for the web UI card
  --linux-paths <p1,p2>          comma-separated Linux candidate paths
  --macos-paths <p1,p2>          comma-separated macOS candidate paths
  --windows-paths <p1,p2>        comma-separated Windows candidate paths
  --install-url <url>            install instructions URL
  --install-instructions <text>  install steps
  --restore-instructions <text>  restore steps
  --json
```

PATCH-style: only the flags you set are sent. Editing a template bumps its
`revision` but never mutates the `captureSpec` of existing protections —
re-enroll to pick up the new recipe.

## `lamasync apps templates delete`

```
Usage: lamasync apps templates delete <id> [--yes]

  --yes, -y    skip the confirmation prompt (required non-interactively)
```

DESTRUCTIVE (safety rule 5). The server 409s while any protection uses the
template — delete those protections first.

## `lamasync apps protections list`

```
Usage: lamasync apps protections list [--host <id>] [--json]
```

Lists host-bound enrollments. Each row joins template identity (name /
emoji) and the latest snapshot. `--host` filters by device; admin keys may
omit it to see the whole fleet (device keys must pass their own host).

## `lamasync apps protections get`

```
Usage: lamasync apps protections get <id> [--json]
```

Reads one protection: template id + captured revision, host, enabled,
schedule, destination, and the enrollment-time copy of the capture spec.

## `lamasync apps protections enroll`

```
Usage: lamasync apps protections enroll --template <id> --host <hostId> [flags]

  --template <id>      app template id (required)
  --host <hostId>      host to enroll (required)
  --schedule '<cron>'  capture schedule
  --name <name>        protection name (default: template name)
  --json
```

Binds a template to exactly one host (admin). The template's capture spec
is copied at enrollment; later template edits never touch the protection.
409 if the host already has a protection for that template.

## `lamasync apps protections update`

```
Usage: lamasync apps protections update <id> [flags]

  --enabled <true|false>  enable or disable capture
  --schedule '<cron>'     new capture schedule
  --name <name>           new protection name
  --json
```

PATCH-style: only the flags you set are sent. Disabling a protection stops
scheduled capture; uploads against it 409 while disabled.

## `lamasync apps protections delete`

```
Usage: lamasync apps protections delete <id> [--yes]

  --yes, -y    skip the confirmation prompt (required non-interactively)
```

DESTRUCTIVE (safety rule 5). Only an empty protection can be deleted. The
server returns 409 when snapshot history exists; use `update <id> --enabled
false` to stop future capture while retaining recoverable history.

## `lamasync apps snapshots list`

```
Usage: lamasync apps snapshots list --protection <id> [--json]

  --protection <id>  protection id (required)
  --json
```

Lists immutable archive metadata under a protection: timestamp, size,
integrity status, checksum prefix, description, id.

## `lamasync apps snapshots upload`

```
Usage: lamasync apps snapshots upload --protection <id> --file <tarball> [flags]

  --protection <id>    protection id (required)
  --file <tarball>     tarball file path (required)
  --description <text> optional label
  --json
```

Uploads a tarball as a new snapshot (multipart `tarball` field). The
server computes size + sha256, records the protection's capture spec as
`capturedSpec`, and returns the stored row. There is no implicit
protection creation — an unknown protection 404s and a disabled one 409s.

## `lamasync apps snapshots download`

```
Usage: lamasync apps snapshots download --snapshot <id> [--out <path>]

  --snapshot <id>    snapshot id (required)
  --out <path>       output file path (required without --json)
  --json
```

Downloads the snapshot tarball to `--out`. `--json` reports the raw bytes
metadata only (`{ok: true, size, type}`); no file is written.

## `lamasync apps snapshots delete`

```
Usage: lamasync apps snapshots delete <id> [--yes]

  --yes, -y    skip the confirmation prompt (required non-interactively)
```

DESTRUCTIVE (safety rule 5). Deletes the snapshot row + its archive file.

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

## `lamasync notifications test`

```
Usage: lamasync notifications test [flags]

  --channel <id>   deliver through one channel only
  --json           machine-readable output
```

Sends a test notification. With `--channel` it delivers through a single
identified channel; otherwise it exercises every enabled channel.

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

The pairing exchange is intentionally **exempt from the LAMA-248
no-config refusal** (alongside `doctor` and `local.*`): the whole point
is to *write* the file, so refusing without one would be a chicken/egg.
The command itself refuses (exit 1) if a `client.toml` already exists at
the default path; pass `--force` to overwrite.

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
