# `trigger_backup` ignores dotfile folders + daemon has no PATH under systemd

## Summary

Two related daemon-bootstrap bugs surfaced while doing the first end-to-end
dotfile backup (LAMA-109 + LAMA-168) on this host:

1. `trigger_backup` (and the **Trigger backup [B]** button on HostDetail)
   only fires assignments whose folder `type === "backup"`. A dotfile folder
   (which produces a versioned tarball backup on the server's `/data`
   volume) is silently skipped → action completes as `done` with summary
   "no backup assignments configured" even when a dotfile folder is assigned.
2. systemd user services start with a minimal `PATH=/usr/local/bin:/usr/bin`
   regardless of what `systemctl --user show-environment` shows. The daemon
   uses `Bun.which("rclone")` for every folder-type pre-flight, so any
   user-installed binary (rclone at `~/.local/bin`, bun at `~/.bun/bin`,
   etc.) is invisible to the executor and every operation fails with
   `rclone binary not found in PATH` — even `type: dotfile` operations
   that never actually use rclone.

## Reproduction (bug 1: trigger_backup filter)

1. Create a dotfile folder + manifest + assignment for host `cachy` (any
   dotfile backup setup that works via `trigger_sync { folderId: ... }`).
2. From the web UI click **Trigger backup [B]** on `#/hosts/cachy`, OR:
   ```bash
   curl -X POST -H "Authorization: Bearer $KEY" \
     -H "Content-Type: application/json" \
     -d '{"type":"trigger_backup"}' \
     http://100.113.52.108:8080/api/v1/hosts/cachy/actions
   ```
3. Wait one heartbeat interval (30s).
4. Result:
   ```
   operation_log: trigger_backup status=done summary="no backup assignments configured"
   ```
   Even though the host has 1 dotfile assignment. The daemon's
   `selectAssignmentsForSyncAction` filters to `type === "backup"` only.

## Reproduction (bug 2: PATH)

1. `lamasyncd` v0.2.3 running under a default systemd user unit (no
   `Environment=PATH=` set).
2. `rclone` (or `bun`, `restic`, etc.) installed at `~/.local/bin/rclone`
   (the standard `curl | bash` install location for rclone).
3. Trigger any operation. Daemon log:
   ```
   [run] folder=<x> type=<y> status=failed summary=rclone binary not found in PATH
   ```
4. `cat /proc/<daemon-pid>/environ | tr '\0' '\n' | grep ^PATH=` → only
   `/usr/local/bin:/usr/bin`. The user manager's longer PATH is not
   inherited.

This second bug has nothing to do with rclone specifically — it would
break `bun`, `restic`, `gh`, `cargo`, etc. for any user who installs to
`~/.local/bin` (the XDG default) or `~/.bun/bin`.

## Root cause

**Bug 1** — `packages/daemon/src/actions.ts`:

```ts
// Old:
return assignments.filter((a) =>
  lookup ? lookup.get(a.folderId) === "backup" : false,
);
```

The filter hard-codes `type === "backup"`. The LAMA-198 spec that
introduced this filter assumed "backup = rclone copy to a remote", but
LAMA-109 + LAMA-168 added dotfile backups that produce versioned tarballs
on the server itself — those are also backups from the user's POV, so the
**Trigger backup** button should fire them.

**Bug 2** — `packages/daemon/src/systemd.ts` (`daemonServiceTemplate`):

The unit template didn't set `Environment=PATH=...`. Per systemd.exec(5),
user services inherit a minimal `PATH=/usr/local/bin:/usr/bin` even when
the user manager has a richer environment. The executor's
`Bun.which("rclone")` check at the top of `executeAssignment` is the
first thing that fails.

(Side note: the executor also fires this rclone pre-flight for `type: dotfile`,
which actually only uses `tar`. That's a separate conservatism — fixing
it would require restructuring `executeAssignment` to short-circuit dotfile
before the rclone check. Out of scope here.)

## Fix (already applied + verified live on cachy)

### `packages/daemon/src/actions.ts`

Introduce `BACKUP_FOLDER_TYPES = new Set(["backup", "dotfile"])` and
update both filter branches of `selectAssignmentsForSyncAction`:

```ts
// with no folderId (filter by type):
return assignments.filter((a) => {
  const t = lookup?.get(a.folderId);
  return t !== undefined && BACKUP_FOLDER_TYPES.has(t);
});

// with explicit folderId (user asked for a specific folder):
return matches.filter((a) => {
  const t = lookup?.get(a.folderId);
  return t === undefined || BACKUP_FOLDER_TYPES.has(t);
});
```

The explicit-folderId branch is intentionally permissive when the lookup
is missing (e.g., during the first heartbeat before the daemon has
refreshed its config cache) — refusing a user-requested folder because we
don't know its type would be a worse UX than firing it.

### `packages/daemon/src/actions.test.ts`

Updated the `backupOnly` test to assert that `dotfile` folders are also
included, and added a new test for the no-lookup explicit-folderId case.

### `packages/daemon/src/systemd.ts` (`daemonServiceTemplate`)

```ini
# systemd user services start with a minimal PATH (/usr/local/bin:/usr/bin)
# even when the user manager has a richer one. Set PATH explicitly so
# user-installed binaries (rclone at ~/.local/bin, bun at ~/.bun/bin, etc.)
# are visible to the daemon. Bun.which() in the executor relies on PATH.
Environment=PATH=/home/%u/.local/bin:/home/%u/.bun/bin:/home/%u/.cargo/bin:/usr/local/bin:/usr/bin
```

The `%u` specifier expands to the invoking UID, matching `$HOME=/home/<uid>`.

### `packaging/install/install.sh`

Same `Environment=PATH=...` line written into the generated unit, with
`${HOME}` substituted at install time.

### `packages/daemon/src/systemd.test.ts`

Asserts the new `Environment=PATH=/home/%u/.local/bin` line.

## Verification (this host: cachy)

- `bun x tsc --noEmit` — clean
- `bun test` — **309 pass / 1 skip / 0 fail** (added 1 test for the dotfile
  backup case)
- Rebuilt `dist/lamasyncd`, deployed to `~/.local/bin/lamasyncd`
- New systemd unit (with `Environment=PATH=...`)
- `cat /proc/<daemon-pid>/environ | grep ^PATH=` →
  `/home/messhias/.local/bin:/home/messhias/.bun/bin:/home/messhias/.cargo/bin:/usr/local/bin:/usr/bin`
- `POST /hosts/cachy/actions { type: "trigger_backup" }` → action completes
  with `summary="backed up 1 folder(s): dotfile ok: 9 paths, 11.2 KiB uploaded"`,
  new dotfile version `6c82a0b1-…` created on the server
- `GET /dotfiles/pi` shows the new version alongside the original
  `78cf91b9-…` (created earlier via the workaround)

## Severity

**Medium** — high for users who installed rclone/bun/restic to `~/.local/bin`
or `~/.bun/bin` (basically all of them, given the install scripts target
those paths), since every operation silently fails with "binary not found in
PATH". The trigger_backup filter is a UX bug — the button is there but
doesn't do what it says for dotfile folders.

## Related

- **LAMA-218** — same theme (daemon + systemd hardening). Different fix
  surface but discovered together.
- LAMA-109 (dotfile system), LAMA-168 (manifest cron presets + deployment
  tracking), LAMA-198 (queued-action model + config-revision auto-refresh).

## Files touched

- `packages/daemon/src/actions.ts`
- `packages/daemon/src/actions.test.ts`
- `packages/daemon/src/systemd.ts` (PATH env)
- `packages/daemon/src/systemd.test.ts` (PATH env assertion)
- `packaging/install/install.sh` (PATH env in generated unit)

## Suggested labels

`bug`, `daemon`, `systemd`, `dotfile`, `actions`