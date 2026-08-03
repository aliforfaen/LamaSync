# Handoff — Pre-push review fixes for the LAMA-218..226 batch

**Audience:** implementing agent. Read `AGENTS.md` first (conventions), then
this document top to bottom before touching code.
**Context:** 13 unpushed commits on `master` (b1ae672..4f07f9d, the
LAMA-218/220/221/222/223/224/225/226 batch) went through a full code review
on 2026-08-03. Local `tsc --noEmit` is clean and 366/366 tests pass, but the
review found 4 push-blockers plus a set of small real bugs. **The push is
held until P0 and P1 below are fixed and verified.** P2 is follow-up; file
Multica issues for it rather than fixing in this pass (unless trivial).

**Ground rules:**
- Follow repo conventions: `.ts` import extensions, no `any`/inline casts
  (`unknown` + narrowing), DB columns in BOTH `SERVER_SCHEMA` and
  `MIGRATIONS`, route files are Elysia plugins with a Swagger `detail` block.
- Add/adjust tests for every behavioral fix. Server tests use in-memory DBs
  via `app.handle(...)`; see `packages/server/src/routes/hosts.test.ts` and
  `stats.test.ts` for the established patterns.
- Commit per fix group (one commit per numbered item is fine; do not lump
  everything into one). Reference the LAMA issue in the message.
- Do NOT push. The operator pushes after re-review.

---

## P0 — push blockers

### P0-1. LAMA-226: S3 write ops never use the folder's bucket

`packages/server/src/browse-jobs.ts` loads `s3_bucket` (`loadFolder`, lines
~196/209) but nothing reads it. `buildConfig`'s `addS3` writes a bucketless
s3 remote and `remotePath` (~line 214) returns just `ref.path`/`name`. rclone
s3 paths are `remote:bucket/key`; the web UI sends `path` as the prefix
*within* the bucket (same value the read route passes as `prefix` to
`listS3Objects`, which uses `s3.bucket` separately — compare
`packages/web-ui/src/pages/DataBrowser.tsx` ~lines 622/649 with
`packages/server/src/routes/browse.ts` ~line 215). Result: every S3
copy/move/rename/mkdir/upload targets a bucket named by the first path
segment; `rclone mkdir src:foo` creates a bucket named `foo`, and move's
`rclone delete src:path --rmdirs` can delete keys in a colliding bucket.

**Fix:** thread the bucket through: `remotePath` for `kind === "s3"` must
produce `remote:bucket/path` (bucket from the resolved folder/backend config,
empty path → `remote:bucket`). Do the same for every spawn site (copy, move,
rename, mkdir, upload, deleteSource). Keep the string-level path validation
(`validateBrowseInput`) applied to the prefix part only — the bucket comes
from the DB, not the wire.

**Test:** add an S3 test that asserts the generated rclone config + argv
contain `remote:bucket/prefix`. Mock `Bun.spawn` (or factor config/argv
building into a pure function and test that) — see P0-2, tests must not
require a real rclone binary.

### P0-2. LAMA-226: browse-ops tests require rclone; CI has none

`packages/server/src/routes/browse-ops.test.ts` spawns real `rclone` and
asserts `status === "done"`. `.github/workflows/ci.yml` (~line 33) runs
`bun test` on `ubuntu-latest` with no rclone install step → red CI on push.
This also breaks the documented invariant "`bun test` — always works, no
external deps needed" (AGENTS.md).

**Fix (pick one, recommend a):**
a. Factor job config/argv construction into pure functions and unit-test
   those; keep at most one end-to-end rclone test behind
   `test.skipIf(!Bun.which("rclone"))` (or an env gate like the TUI's
   `LAMASYNC_TUI_TEST_VIEWS` pattern).
b. Install rclone in CI — rejected: slows CI and violates the invariant.

**Test:** `bun test` green on a machine PATH-stripped of rclone
(`env PATH=/usr/bin:/bin bun test` is a quick approximation if rclone lives
elsewhere).

### P0-3. LAMA-222: failed legacy s3_* lift still drops the credential columns

`packages/server/src/backends.ts` `migrateLegacyS3FoldersToBackends`
(~lines 155-186) swallows all errors into `console.error`;
`applyLegacyLift` (`packages/server/src/db.ts` ~lines 36-41) swallows again;
then `initDb` unconditionally applies the five
`ALTER TABLE folders DROP COLUMN s3_*` migrations
(`packages/core/src/db/schema.ts` ~lines 289-293). Any lift failure (disk
full, I/O error, schema variance) permanently destroys the only copy of the
S3 secrets. The lift is also not transactional and its re-scan filter
(`WHERE s3_endpoint IS NOT NULL AND s3_endpoint != ''`, backends.ts ~line
139) doesn't exclude already-lifted folders → a crash mid-lift plus restart
creates duplicate backend rows and orphans the first set.

**Fix:**
- Wrap the whole lift (INSERT backends + UPDATE folders) in one transaction.
- Make the lift report success/failure up to `initDb`; the DROP COLUMN
  migrations must only run after a successful (or vacuous — no legacy rows)
  lift. If the lift fails on a DB that still has legacy rows, abort startup
  loudly rather than dropping. Implementation note: the DROPs currently live
  in the generic `MIGRATIONS` array; move them out (or gate them behind a
  flag the runner checks) so they are conditional. Keep them idempotent —
  SQLite <3.35 can't `DROP COLUMN IF EXISTS`, so preserve the existing
  error-swallow for "no such column".
- Belt-and-braces: make the re-scan skip folders that already have
  `backend_id` set (filter `backend_id IS NULL` alongside the s3_endpoint
  check), so even a partial pre-transaction legacy state converges.

**Test:** (1) lift with two legacy folders → one transaction, both rows
migrated, columns dropped on next boot, re-run is a no-op. (2) Forced
failure mid-lift (e.g. temporarily break an INSERT in a test seam) →
columns NOT dropped, startup aborts or clearly errors, secrets intact.

### P0-4. LAMA-218: TUI default socket path not updated; test-install.sh broken

The daemon now binds `$XDG_RUNTIME_DIR/lamasync.sock` (fallback
`~/.lamasync/lamasync.sock`) — `packages/daemon/src/index.ts` ~lines 69-76.
But `packages/tui/src/socket-client.ts:16` and `packages/tui/src/boot.ts`
~lines 50-51 still default to `join(homedir(), "lamasync.sock")`. The
systemd unit pins `LAMASYNC_SOCKET_PATH` for the daemon process only; the
TUI runs in the user's shell without it → the default-installed TUI Local
view never connects. There is no `socketPath` in client.toml as an escape
hatch either.

**Fix:** mirror the daemon's `defaultSocketPath()` logic (XDG_RUNTIME_DIR →
`~/.lamasync` fallback) in the TUI. The logic should live ONCE — put a
shared helper in `packages/core` (e.g. `socket-path.ts`) and use it from
both daemon and TUI. Bonus: honor an optional `socketPath` key in
client.toml (daemon already reads that file) so users can override without
env vars; document it in `config-examples/client.toml`.

Also in scope:
- `scripts/test-install.sh:82` greps for the old
  `LAMASYNC_SOCKET_PATH=/root/lamasync.sock`; update it to assert the new
  fallback path (root container has no XDG_RUNTIME_DIR →
  `/root/.lamasync/lamasync.sock`).
- The daemon's `~/.lamasync` fallback dir is never created —
  `startSocketServer` binds directly (`packages/daemon/src/socket.ts` ~line
  155) and `install.sh` doesn't mkdir it → ENOENT, daemon runs with no
  control socket. `mkdirSync(dir, { recursive: true })` before bind.
- `packages/daemon/src/systemd.ts` ~line 208 hardcodes
  `Environment=PATH=/home/%u/...` — use `%h` (works for `/root` and
  non-`/home` homes).
- `packaging/systemd/lamasyncd.service` ~lines 34-37 still ships the old
  `%h/lamasync.sock` default and old `ReadWritePaths` — align with the
  generated unit.
- Unquoted heredocs in `packaging/install/install.sh` (~lines 78, 116)
  expand `$XDG_RUNTIME_DIR` inside comments/usage text — quote the heredoc
  delimiters where the body is meant to be literal, or escape the `$`.
- Stale docs still saying `~/lamasync.sock` is the default: `ARCHITECTURE.md`
  ~line 509, `docs/development.md` env table (LAMASYNC_SOCKET_PATH row),
  `config-examples/client.toml` ~lines 28-29.
- Commit-message hygiene for the record: the dotfile-backup filter change
  in b1ae672 is LAMA-219 in code/tests but the message says LAMA-220. No
  rebase — just note it in `docs/features.md` if you touch that table.

**Test:** socket.test.ts gains a case for the shared helper (XDG set/unset,
client.toml override). Re-run `scripts/test-install.sh` (Docker required).

---

## P1 — fix in the same pass (small, real bugs)

### P1-1. LAMA-221: web UI sends PUT, server only accepts PATCH

`packages/web-ui/src/api.ts:261` `updateNotificationChannel` uses `apiPut`;
the server registers only `.patch("/notifications/channels/:channelId")`
(`packages/server/src/routes/notifications.ts` ~line 208). Edit/Save,
severity toggle, and enable toggle on the Admin page all 404. Fix: `apiPut`
→ `apiPatch` (it exists at api.ts:123). Test: none exists for the UI client
— at minimum grep the route table vs client methods for method mismatches
while you're in there (folders/dotfiles use PUT elsewhere, don't "fix"
those blindly).

### P1-2. LAMA-226: local self-move deletes data

`startBrowseCopyMove` (`browse-jobs.ts` ~line 333) only rejects same-folder
s3 pairs. Local move with `src.path === dst.path` (or dst nested under
`src.path/name`) passes: rclone no-ops, then `deleteSource` `rmSync`s the
source (~line 291). Fix: for same-kind local refs, reject when the resolved
dst equals or is contained in the source entry's path. Conversely, relax
the s3 same-folder blanket rejection to allow intra-folder moves into a
different prefix (dst prefix not equal to / not containing the source
prefix). Tests for both sides.

### P1-3. LAMA-226: busy guard's DB half is dead code

Stored `destination` is `refLabel(dst)` plus `/name` for single-entry jobs,
but the pending/running probe queries `destination =
"${kind}:${folderId ?? ""}:${path}"` (`browse-jobs.ts` ~lines 339-343) —
never matches. Fix: store and probe the same canonical string. While there:
- Reconcile jobs stuck `running` after a crash at startup (mark `error`,
  "server restarted") — otherwise they'd block destinations forever once
  the key actually matches.
- Extend the guard (or document why not) to rename/mkdir/upload and to two
  moves sharing a *source*.
Also remove the `null as never` casts (~lines 338/344) and the
`row.operation as BrowseJobOperation` cast (~line 62) — narrow properly
(repo convention).

### P1-4. LAMA-223: CGNAT false positive + ineffective LAN fallback

Two parts in `packages/daemon/src/lan-peer.ts`:
a. `detectTailnetIp` (~lines 232-241, 294-311) matches any `100.*` address
   on the *default-route* interface. ISP CGNAT (100.64.0.0/10) on eth0 →
   bogus "tailnet IP" in every UI and in peer rclone configs. Fix: match
   the /10 (`100.64`–`100.127`), and prefer scanning all interfaces (or
   `tailscale0` by name) over the default-route shortcut; keep
   `tailscale status --json` as authoritative when available. Add a parser
   test for "eth0 has 100.100.x.y CGNAT → not detected".
b. The `usePeer` "tailnet first, LAN fallback" probe (~lines 84-92) changes
   only the log line — the returned remote's `host` is fixed server-side at
   config-generation time (`packages/server/src/routes/config.ts` ~lines
   352-356, `host = peerTailnetIp ?? peerLanIp`). Fix: emit two rclone
   sections per peer when both IPs exist (`lamasync-peer-X` tailnet,
   `lamasync-peer-X-lan`) and have `usePeer` select by probe result.
   Server-side: also bump config revision when `tailnet_ip` changes via
   `/report/health` (hosts.ts ~lines 381-425 currently doesn't), so peers
   pick up the new sections.
c. Guard `parseTailscaleStatusJson` (~lines 248-265) to prefer the IPv4
   entry in `Self.TailscaleIPs` (skip `fd7a:`…).
Note (no code): stale `tailnet_ip` never clearing is accepted behavior per
the code comment — but with tailnet preferred in peer configs it's riskier;
mention it in `docs/features.md` limitations.

### P1-5. LAMA-225: cascade misses a column; WS event half-wired

In `packages/server/src/routes/hosts.ts`:
- `cascadeHostId` (~line 76) misses
  `dotfile_manifests.original_uploader_host_id` (schema.ts ~line 64) — the
  Dotfiles UI renders that id via `hostLabel`. One-line fix + extend the
  cascade test to seed every host-keyed table (conflicts, restic_*,
  notification_events, locks too — `hosts.test.ts` `seedDependentRows`
  covers only 3 of 9).
- The register re-key path (~lines 275-284) broadcasts only `{kind:"host"}`;
  the PATCH path emits `host_renamed` with `oldId === newId` (~lines
  218-223). Broadcast `host_renamed` with the real old/new ids after the
  re-key so `/hosts/<oldId>` detail pages and the Hosts list refresh.
- Add a comment on `cascadeHostId` that it relies on
  `PRAGMA foreign_keys` being OFF.
Doc note (no code): the rename→re-register hijack window (any machine
claiming the renamed label absorbs the host identity) is an accepted risk
under the single-API-key model — write it down in `docs/features.md`
limitations.

### P1-6. Plaintext secrets in world-readable /tmp configs (3 sites)

`/test` (`packages/server/src/routes/backends.ts` ~lines 368-383),
browse-jobs (`browse-jobs.ts` ~line 188), stats (`stats.ts` ~lines 65-67):
`Bun.write` of an rclone config containing `secret_access_key` with default
0644 perms, predictable name (`/tmp/lamasync-backend-test-${id}.conf`
clobbers under concurrency), cleanup only on the happy path. Fix all three
with one shared helper (e.g. `withTempRcloneConfig(configText, fn)` in
`packages/server/src/`): `mkdtemp`-style unique dir, file mode 0600,
`try/finally` removal. `stats.ts rcloneSize` already has the `finally` —
align it on the helper too.

### P1-7. LAMA-224: `/folders/:id/size` measures daemon paths on the server

`packages/server/src/routes/folders.ts` ~lines 365-370 +
`packages/server/src/stats.ts` ~lines 249-255: for non-S3 folders it runs
`du` on `folder_assignments.local_path`, which exists on the *daemon host*,
not the server — in real deployments every sync/mount/local folder returns
`error: "path does not exist"` and the Folders Size column shows "—".
Decision (operator pre-approved the cut): **remove the non-S3 branch** —
the endpoint serves S3 folder sizes only; return a clear
`{ size: null, error: "not measurable server-side" }`-style response (or
409 with a typed reason) for local/mount folders, and have the Folders page
render "n/a" instead of the error dash. Update the type + comment in
`packages/core/src/types.ts` accordingly.
Also fix in the same file set:
- `stats.test.ts:79` `afterEach` removes a literal prefix path that never
  exists → leaked temp dirs; keep and `rmSync(base)`.
- `stats.ts` ~lines 128-131 comment promises bucket-level reporting for
  folderless backends that the code doesn't implement — remove the comment
  and return a neutral state (not a green "ok / 0 B").
- `stats.ts` ~lines 242-248 `backend!` non-null assertion → use
  `getBackend()` + narrow.
- `Folders.tsx` ~lines 142-161 fires N parallel size requests (N concurrent
  rclone processes, duplicate bucket measurements); make it sequential or
  add a bulk endpoint — sequential is fine.
- Add a comment that S3 folder size is bucket-level, not prefix-level.

### P1-8. Dotfiles scope `<select>` value mismatch

`packages/web-ui/src/pages/Dotfiles.tsx` ~lines 49-53 vs ~237: `scopeKey()`
returns `host:<id>` but options use bare `value={h.id}` → after selecting a
host the control snaps back to "All hosts" while the table shows host data.
Fix by aligning the two (bare id everywhere is simplest). While there: add
a stale-response guard on `refresh()` (~lines 112-115) — ignore a resolve
that isn't for the current scope (a simple request-counter token is
enough).

### P1-9. LAMA-226: wire-schema + error-leak tightening

- All five write-op route schemas take `kind` as `t.String()` — invalid
  kinds silently fall into the local branch. Make it
  `t.Union([t.Literal("local"), t.Literal("s3")])`
  (`packages/server/src/routes/browse.ts`).
- Write ops return raw rclone stderr last-line to the client while the read
  s3 route deliberately scrubs upstream errors (browse.ts ~lines 230-233).
  Scrub the same way (log full stderr server-side, return a generic
  message + job id).
- Replace `body as {…}` casts in the five routes with narrowing from the
  Elysia-validated body.

---

## P2 — follow-up (file Multica issues, do NOT fix in this pass)

- LAMA-221: env seeding resurrects deleted channels on restart (seed only
  once, or document env-vars-win-on-empty-table). Test endpoint delivers
  through disabled channels (undocumented). Swagger `detail.responses`
  missing the 200 for targeted test. Channel URLs (with ntfy topic) returned
  in cleartext — accepted behind API key, note it. SSRF surface is now
  runtime-configurable — accepted, note it.
- LAMA-222: silent plaintext fallback when no secret key can be persisted
  (`crypto.ts` ~lines 64-76) — `isEncryptedSecret` exists but is never
  called; expose `secretEncrypted` on the wire or drop the function. Env
  key taking precedence over persisted key bricks existing secrets when
  `LAMASYNC_SECRET_KEY` is introduced later — needs a re-encrypt helper or
  a loud ops note. Inline casts in backends routes.
- LAMA-225: `previous` fetched by incoming id before re-key → `host_online`
  notification can't fire for a re-keyed host (hosts.ts ~lines 254-258).
- LAMA-226: symlink-escape defense gap — read path uses
  `resolveBrowsePath`/`realpathSync` containment (`browse-paths.ts` ~lines
  23-39), write path only string-checks. Port the containment check to
  write ops.
- LAMA-224: cache invalidation over-fires on `started`/`failed` reports;
  backend create/delete doesn't invalidate the report cache; `duBytes` has
  no timeout; `__folderCacheSize()` dead export; `formatBytes` duplicated
  in Dashboard/Folders.
- b1ae672 leftovers: `socket.ts` ~line 150 `err as NodeJS.ErrnoException`
  cast; commit message says LAMA-220 where code says LAMA-219.

---

## Verify before done

1. `bun x tsc --noEmit` clean.
2. `bun test` green — including with rclone off PATH (P0-2).
3. Targeted new tests: S3 bucket in browse-op argv (P0-1), lift failure
   keeps columns (P0-3), shared socket-path helper (P0-4), self-move
   rejection (P1-2), busy-guard key match (P1-3), CGNAT rejection (P1-4),
   full cascade (P1-5).
4. `cd scripts/e2e-sandbox && docker compose up --build
   --abort-on-container-exit` if Docker is available (covers the socket
   path end-to-end); `./scripts/test-install.sh` for the installer grep.
5. Update `docs/status.md` (new section: review fixes landed) and
   `docs/features.md` limitations where noted above.
6. Report back with a commit list; the operator re-reviews and pushes.
