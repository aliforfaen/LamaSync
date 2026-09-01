# LAMA-302 — Event-triggered sync for active local worktrees

## Progress (this pass — steps 1-4 implemented, soak outstanding)

Landed the core/server contract, the platform-neutral debounce/single-flight
controller, the Linux inotify adapter + daemon lifecycle reconciliation, the
Git-ignore filter snapshot (with safe `--resync` on change), the operation
`trigger` origin, and the CLI/web/TUI surface. Gates green:
`bun x tsc --noEmit`, `bun run build:web-ui`, `bun test` (1239 pass / 0 fail),
`bun scripts/check-skill-drift.ts --strict`.

**Outstanding / next:**
- Step 5 — real Linux daemon smoke/soak against a busy Git fixture (observe
  the bounded-run behavior and record it here).
- TUI full watch-editing editor — deferred (the TUI has no complete
  sync-assignment editor; edit via CLI `folders assign-update` or the web UI).

The watch config is **default-off**, so existing assignments keep their exact
schedule-only behavior after upgrade. See `docs/features.md` (LAMA-302) and
`docs/status.md` for the detailed change log.

## Outcome

Give an ordinary LamaSync `sync` assignment a fast local-change path without
turning it into an rclone mount or a new synchronization engine. A save in a
large active worktree (including Git repositories) should cause one
debounced, normal LamaSync `rclone bisync` run shortly after writing stops.

The configured LamaSync backend path is the shared parent copy. Hosts
reconcile their normal local worktrees with that parent through the existing
two-way `bisync` contract; there is no direct host-to-host replication. The
remote path is `bisync` Path 1 today, so it remains the initialization and
recovery source. Once initialized, ordinary runs retain the existing
two-way/conflict-strategy semantics.

## Owner decisions already made

- Applies **only** to effective `sync` assignments. It is never available to
  `backup`, `mount`, `dotfile`, or `git` folders.
- It is opt-in per assignment and disabled by default. Existing folders keep
  their exact schedule-only behavior after upgrade.
- Linux is the first supported platform, implemented with inotify.
- Design a platform-neutral watcher boundary so Windows, Android, and other
  host implementations can be added later without changing the assignment
  contract or daemon orchestration.
- Debouncing is intentionally aggressive. Default quiet period: **30 s**.
  Do not run once per event or per changed path.
- The existing cron schedule remains the periodic reconciliation and recovery
  layer. It covers remote/other-host changes, missed/overflowed local events,
  and watcher downtime. It is not replaced by the watcher. Recommend a
  **15-minute** reconciliation schedule when local-change sync is enabled;
  never silently alter an existing assignment's cron expression.
- Reuse the daemon's normal `runOnce` path: server destination locking,
  pause/slow mode, retries, rclone config generation, bisync state/recovery,
  conflicts, and operation reporting must be unchanged.

## Why this is a sync feature, not a mount feature

`rclone mount` is appropriate for remote-first data. It is a poor working
filesystem for high-churn Git trees, where Git performs many metadata checks,
renames, lockfile writes, and small-object operations. LAMA-302 keeps the
worktree local and only makes reconciliation prompt after local changes.

Rclone does not provide a local filesystem watcher for `bisync`; the common
operational pattern is an inotify/fswatch trigger, a quiet-period debounce, a
single-flight lock, and a slower periodic bisync. LamaSync can productize that
pattern because its daemon already owns the execution and fleet safety model.

## Proposed configuration and compatibility contract

Add nullable/optional fields to `FolderAssignment` and the assignment API:

```ts
watchEnabled?: boolean;       // default false
watchQuietSec?: number | null; // null => 30; validated range 10–300 seconds
ignoreGitMetadata?: boolean;   // default false; exclude .git/
respectGitignore?: boolean;    // default false; apply Git ignore semantics
```

`syncExpr` remains the existing periodic reconciliation schedule. A watch-only
assignment is allowed, but the UI should recommend retaining a **15-minute**
schedule. Do not silently assign or alter a cron expression.

Persist both columns in `SERVER_SCHEMA` and `MIGRATIONS`, map them through all
folder-assignment queries and host config, and document the API and CLI flags
before shipping (`scripts/check-skill-drift.ts --strict`).

Suggested user-facing terminology:

- Toggle: **Sync after local changes**
- Help text: “Waits for changes to settle, then syncs this local folder. Your
  regular schedule still checks for changes made elsewhere.”
- Advanced setting: **Wait after last change** (default 30 seconds)
- Folder options: **Ignore Git metadata** and **Respect `.gitignore`**, both
  disabled by default.

## Daemon design

Create a small platform-neutral module, for example
`packages/daemon/src/folder-watch.ts`:

```ts
interface FolderWatchHandle { close(): void }

interface FolderWatchFactory {
  start(options: {
    assignment: FolderAssignment;
    onDirty(): void;
    onError(error: Error): void;
  }): FolderWatchHandle;
}
```

The first implementation (`inotify` on Linux) must watch recursively and
handle directories created after start. Keep the factory/platform selection
separate from the debounce/coalescing state machine so future Windows/Android
implementations only emit `onDirty()`.

The daemon owns one watch controller per eligible assignment. Reconcile that
controller on initial configuration load, config refresh, assignment disable,
folder/host removal, effective-type change, and daemon shutdown. A missing
local path is a normal non-start condition: log it once through the existing
missing-path policy and retry watcher setup after the next config refresh.

### Coalescing state machine

Per assignment, retain only state equivalent to:

```text
idle → dirty/debouncing → running → (dirty-during-run ? debouncing : idle)
```

- An event marks the assignment dirty and resets one quiet timer.
- After `watchQuietSec` with no newer event, run the existing `runOnce`.
- Never queue paths or launch concurrent runs. A burst is one reconciliation.
- Events during a run set `dirtyDuringRun`; once the run ends, make at most one
  follow-up debounced run.
- Acquire/release and remote destination contention remain entirely in
  `runOnce`; a watch event must never bypass them.
- On an inotify overflow/error, mark dirty and request a normal debounced run;
  log that the event stream was incomplete. The periodic schedule remains the
  second recovery layer.
- A failed/deferred/paused run is reported exactly as today. The controller
  must not spin: it waits for a new event, the existing retry behavior, or the
  periodic schedule rather than retrying in a tight watcher loop.

Do not attempt per-file incremental rclone commands in v1. `bisync` remains
the sole reconciliation authority and its persistent workdir/state remains
unchanged.

### Event noise and Git worktrees

Watch events are only a signal to reconcile; they are not a transfer manifest.
Apply the assignment's effective sync ignore rules before treating an event as
meaningful where practical. Do not hard-code `.git` exclusion: Git metadata
may intentionally be part of a replicated worktree. When `ignoreGitMetadata`
is enabled, exclude the `.git/` tree from both watcher significance and the
rclone/bisync filter. The quiet period and single dirty bit are the primary
protection from checkout/rebase/package-build event storms.

`respectGitignore` means **Git's actual ignore semantics**, including nested
`.gitignore` files, negated patterns, `.git/info/exclude`, and the configured
global Git excludes file where available. Do not pass `.gitignore` directly to
rclone: rclone filters have different semantics. Build a deterministic
assignment filter snapshot from Git's own ignore evaluation (or an equivalent
fully-tested implementation), feed that snapshot into `bisync`, and retain it
alongside the assignment's persistent bisync state. Because changing a filter
changes the synchronization universe, detect snapshot changes and follow
rclone's safe resync/recovery path rather than using stale bisync listings.
If the local path is not a Git worktree, enabling this option is a clear
configuration error/warning and the watcher must not pretend it is active.

Rclone can itself cause local events while applying remote changes. Those may
cause one harmless follow-up reconciliation; the controller must coalesce them
and must be verified not to form a perpetual trigger loop. If an explicit
self-event suppression window proves necessary, it must never drop a genuine
user write—prefer a bounded extra no-op bisync over losing a change.

## Product/API surfaces

1. Server/core: schema, migrations, `FolderAssignment`, assignment create and
   update validation/mapping, host config revision bump.
2. Web UI: expose the toggle and quiet-period control only when the assignment
   has effective `sync` mode; show the periodic-schedule recommendation.
3. TUI: expose the same setting wherever assignments are edited, or clearly
   defer it only if the current assignment editor lacks those controls. Do not
   create a hidden server-only setting.
4. CLI: add assignment create/update flags and show the settings in assignment
   listings/JSON. Update `packages/agent-skill/reference/cli.md` and
   `reference/api.md` in the same change.
5. Observability: include trigger origin (`watch`, `schedule`, or `manual`)
   in operation details/status where additive and practical. Record every
   watch-triggered reconciliation, including successful no-op ones, in normal
   operation history. The local/TUI status should make “watching / waiting for
   changes / syncing” intelligible without flooding history with individual
   filesystem events.

## Test plan

- Core/schema migration and API round-trip: absent fields preserve defaults;
  invalid quiet periods reject cleanly.
- Pure controller tests with a fake watch source and fake clock:
  debounce reset, one run for a burst, no overlap, one post-run follow-up,
  disable/refresh/shutdown cleanup, and overflow/error behavior.
- Linux adapter tests with an injectable inotify boundary; a real inotify
  integration test may be Linux-gated.
- Daemon integration: only effective `sync` assignments start watchers;
  mount overrides, backups, disabled assignments, and missing paths do not.
- Git options: `.git/` is excluded only with the explicit checkbox;
  Git-ignore snapshots correctly handle nested/negated patterns and force the
  documented safe bisync filter-change recovery path.
- Verify watch-triggered execution reaches the existing lock/pause/retry/report
  path and does not alter `bisync` argv/state/recovery behavior.
- Regression/soak test against a busy Git repository fixture: a large write or
  checkout burst yields bounded runs, not an event-driven sync storm.
- Required gates: `bun x tsc --noEmit`, `bun run build:web-ui`, `bun test`,
  and `bun scripts/check-skill-drift.ts --strict` (or the repository's exact
  drift-check invocation).

## Explicit non-goals for v1

- No claim of real-time collaborative editing or sub-second propagation.
- No remote provider webhook/change-feed integration.
- No direct peer-to-peer replication or replacement synchronization engine.
- No mount behavior or VFS-cache changes.
- No per-file transfer queue or bespoke Git synchronization protocol.
- No Windows/Android watcher implementation in this issue; only the interface
  boundary to make those additions straightforward.

## Implementation order

1. Land core/server fields and documented CLI/API contract, default-off.
2. Implement and unit-test the platform-neutral debounce/single-flight
   controller.
3. Add Linux inotify adapter and daemon lifecycle reconciliation.
4. Wire web/TUI/CLI controls and operation-origin visibility.
5. Run a real Linux daemon smoke/soak against a busy Git fixture and capture
   the observed bounded-run behavior in the issue handoff.

## Decisions closed by the owner

- Recommend a 15-minute periodic reconciliation schedule for watch-enabled
  assignments; existing schedules are never changed.
- Expose **Ignore Git metadata** and **Respect `.gitignore`** as independent,
  unchecked-by-default folder settings.
- Record every watch-triggered reconciliation in operation history, including
  successful no-op runs; never record each individual filesystem event.
