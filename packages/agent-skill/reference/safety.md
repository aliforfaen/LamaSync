# Safety rules (verbatim, LAMA-230 contract)

These are the rules every agent operating a LamaSync fleet must obey. The
SKILL.md summarises them; this file is the canonical contract. Violating any
rule is a handoff-worthy bug — stop, ask the operator, and surface the
gap instead of working around it.

## 1. API trust, no user accounts

There are no user accounts or OAuth sessions. The trust boundary is the
credential model: a break-glass pre-shared master key plus managed `admin` and
host-bound `device` keys; pairing sessions are short-lived bootstrap state.
If a task seems to need per-user authz, escalate to a human instead of
inventing user accounts or roles.

Concretely:
- never suggest OAuth flows, user accounts, or row-level security policies
- when asked to "restrict this to user X", explain that there are no user
  accounts; the credential model is the trust boundary and the right path is
  a separate deployment or a human-mediated workflow

## 2. Never invoke `rclone` directly

All transfers go through the daemon executor, which owns locks and writes
the operation report. Agents must not:

- spawn `rclone` to copy, sync, or mount
- hand-write an rclone config file
- bypass the daemon by talking to the destination backend directly

When in doubt, use `lamasync sync <folderId> --host <hostId>` (and follow
`lamasync ops list --host <hostId>` to verify).

## 3. Prefer the WebSocket for live state; don't poll `GET /api/v1/operations` in a tight loop

The server broadcasts `operation`, `host`, `lock`, `mount`, `conflict`,
`restic_snapshot`, `restic_restore`, `action`, `browse_job`, and
`host_renamed` events on `GET /api/v1/ws` (subprotocol auth). Polling
`/api/v1/operations` is fine for "show me the last hour"; using it as a
stream is not. Use the WebSocket — or `lamasync local ops` against the
daemon — for live state.

## 4. Mask credentials

No credential ever appears in plain text anywhere an agent writes. In all
output, examples, and diagnostics use the masked form:

```
lmsk.ABCDEFG…xxxx
```

where the masked form shows the **first 8 + last 4** characters of the
actual credential. A master key may begin `lamasync_`; managed keys begin
`lmsk.`. The
`lamasync` CLI already masks automatically (exit-code 3 still tells you
auth failed or config is missing; the body never echoes the credential). When
typing examples into a chat, use `<your-api-key>` or a placeholder — never a
literal value.

The same rule applies to any other credentials: `s3SecretAccessKey`,
`resticPassword`, `cryptPassword`. They are write-only at the API surface;
neither the CLI nor the JSON response echoes them back.

## 5. Mutations need intent

Reads (`GET`) are free. Writes (`POST`/`PATCH`/`PUT`/`DELETE` and CLI
equivalents) need explicit user intent. Confirm before:

- deleting a folder (cascades to assignments and snapshots)
- force-restoring a snapshot over a target path
- rotating an API key
- stopping mounts / killing the systemd unit
- pruning the operation log (irreversible)
- unregistering a host (cascades to app protections/snapshots, allocations)

The CLI enforces this: destructive commands prompt for confirmation on a
TTY and require `--yes` in non-interactive contexts. The agent's job is to
confirm with the operator BEFORE running the command, not after.

## 6. Never invent local state

If the CLI can't express the operation, stop and ask. Do not:

- hand-edit `~/.config/lamasync/client.toml`
- mutate the SQLite DB (`~/.local/share/lamasync/lamasync.db`)
- edit rclone configs directly
- write to `LAMASYNC_BACKUP_DIR` directly

These paths are owned by the daemon. The right path when the CLI is silent
is to file a gap (or escalate) — never a hand-rolled workaround.
