# Agent start — LamaSync

Read this after `AGENTS.md` when entering a coding worktree.

## Current work

LAMA-346's first vertical slice (initial large-folder seeding and
progress-aware sync timeouts) is implemented in this worktree and awaits
review, after an independent-review correction pass. Several things are
load-bearing and easy to break.

The **progress-aware deadline** lives in `shouldExtendSeedDeadline`
(`@lamasync/core/folder-seed`), and *which runs get it* is the single pure
`syncRunIsProgressAware({ seedStage?, bisyncMode?, baselineReady })` in
`packages/daemon/src/executor.ts`: a sync against an **existing, ready
baseline must keep its exact fixed wall-clock timeout**, while a first run
with no usable baseline (the dev-vm shape), an explicit `initialize`/`seed`
intervention, or `seedStage: true` is supervised progress-aware. Do not widen
that scope.

**Stage 1a (filter-aware archive construction) is implemented**:
`packages/daemon/src/seed-filter-universe.ts` compiles the exact
`--filter-from` rule lines the executor writes into a `SeedSourceFilterUniverse`
with rclone's own semantics (pinned by a cross-check test against the host's
real rclone), and `buildSeedSourceManifest(assignment, type)` is the single
assignment → universe → manifest entry point. tar is given the manifest's
member list, churn is measured inside the universe, and a filter-included
symlink or special file still fails closed before tar runs.

**Stage 1b's foundation is implemented, but nothing is wired to a running job.**
`@lamasync/core/seed-relay` is the relay contract (dedicated
`lamasync/seed/<jobId>/` namespace, key validation with prefix containment,
immutable archive metadata, cleanup/retention state);
`packages/daemon/src/seed-relay-local.ts` is a local object store that is also
the integration fixture; `packages/daemon/src/seed-transport.ts` uploads with a
locally computed digest, verifies the store's read-back, and **re-hashes the
downloaded bytes on disk before anything may extract**. There is no credential,
endpoint or bucket in that interface, and no configured S3, rclone remote or
live host is touched. `seed-transport-bounded.test.ts` asserts from the module
graph that no production module imports the transport yet — keep it that way
while the flag is `false`.

**Stage 2a is implemented**: `packages/daemon/src/seed-e2e.test.ts` is a
disposable two-host harness (one temp sandbox, two daemon-shaped identities,
test-only local object store) that drives source archive → relay → target
extract/verify/atomic-publish → a **real `rclone bisync --resync` reporting zero
files changed**, then bidirectional edits and ignored-content checks, with the
failure cases. It is gated on rclone and force-skipped by
`LAMASYNC_TEST_RCLONE=1`; the gate is a named test, and handoff §2.11 lists the
host proofs still required (real network hop, real ENOSPC, the daemon
orchestration, a live copy run). Never make it touch a configured backend, a
credential, a real folder or dev-vm.

**Stage 2b is implemented, and it is TEST-ONLY.**
`packages/server/src/seed-coordinator.ts` drives one seed job through the
existing state machine (phases one at a time, lease renewal, archive-facts
persistence, idempotent cleanup) with injected source/target sides and an
injected local object store, with **ownership-conditional** claim/report/finish
writes (`claimSeedJobProgress`, `reportOwnedSeedJobProgress`,
`finishOwnedSeedJob`) so a live owner's job cannot be stolen, a contender cannot
write its outcome or delete its in-flight objects, and a lapsed lease reports
`lease_lost` instead of an unrecordable result. Completion requires every phase
entered and archive facts persisted, in-flight archive facts are conditional too
(so a lapsed run cannot overwrite the new owner's digest), cleanup only ever sets
the `cleanup` field on a freshly read row, and a **live lease is never claimable
even by the same owner** — `owner` is a host id, not a run id. Never swap those for the device routes'
last-writer-wins helpers. No production module may import it —
`seed-coordinator-bounded.test.ts` asserts that from the module graph, and
`SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` must stay `false` while it is test-only.
Never give it a configured backend, a credential or a live folder.

**Stage 2c's first slice is implemented, and it is TEST-ONLY.**
`packages/daemon/src/seed-relay-s3.ts` is a real S3-compatible relay store
(SigV4 over `fetch`, digest written as `x-amz-meta-sha256`, immutability, abort
safety); `seed-transport.ts` gained the **manifest handoff**
(`uploadSeedManifest` / `downloadSeedManifest`: the target re-derives the content
fingerprint from the received entries and refuses a mismatch, so it
independently knows the source universe); `SeedJobArchiveFacts` carries the
manifest object key/bytes/digest (additive, no migration); and
`scripts/lama346-seed-e2e.ts` runs the whole vertical path in one disposable
sandbox — a real isolated server, a disposable MinIO container, TWO INDEPENDENT
WORKER PROCESSES (`scripts/lama346-seed-worker.ts`) driving the real job API,
real GNU tar and a real `rclone bisync --resync` that reports zero changed
files, plus manifest-mismatch, non-empty-target, cancellation, aborted-upload
and orphan-cleanup cases. `POST /seed-jobs` and `POST /seed-jobs/:jobId/archive`
open only under the doubly-gated seam (`LAMASYNC_SEED_E2E=1` **and**
`LAMASYNC_TEST=1`); `seed-e2e-seam.test.ts` pins that. The GATED host proofs (a real two-machine
hop, real ENOSPC on a bounded volume, the live large-tree run) remain. Never
give the store, the worker or the seam a production credential, endpoint,
rclone config or live folder. Stage 2d demoted those workers to a **lower-level
diagnostic** and fixed the two gaps this paragraph used to list — see the next
paragraph.

**Stage 2d is implemented: the shipped daemon runs a seed side, and each side has
its own identity.** The seed job now carries `sourceHostId`
(`folder_seed_jobs.source_host_id`), so a device key is authorized for its OWN
half without a plan join and without a master key. `@lamasync/core/folder-seed`
states the rules once (`seedJobRoleFor`, `seedJobPhaseRole`,
`seedJobRoleMayEnterPhase`, `seedJobRoleMayReportArchive`,
`seedJobRoleMayComplete`, `seedArchiveFactsComplete`, `seedArchiveFactsEqual`)
and the routes enforce them: the source owns
`preflight → uploading_archive` and the target the other six; only the source
authors the immutable archive facts and ONLY ONCE (a compare-and-set whose
predicate also clears the lease, which is the single source→target HANDOVER);
only the target may report `completed`; either party may report its own half
`failed`; a stranger is refused everywhere; and the lease owner is always the
AUTHENTICATED host, so a device cannot forge another host's lease. Every
device-facing write is ONE atomic statement with a compare-and-set on the phase
the route read, so a stale writer or a lost race is a 409. A source report after
the handover is refused — otherwise it would re-claim the lease it just gave
away and strand the target (a footgun the E2E found, not inspection).

`lamasyncd`'s dispatcher handles a `seed_job` queued action (`{ jobId, role }`,
enqueued automatically by `POST /seed-jobs`, one per party — it is NOT accepted
on `POST /hosts/:hostId/actions`), re-derives its role from the job, refuses a
disagreeing payload, and loads `packages/daemon/src/seed-runner.ts` by DYNAMIC
`import()` only after the seam check. The runner reuses the existing primitives
and the real S3 store, and its `baseline_validation` phase runs a real
`rclone bisync --resync` whose zero-change verdict (`seedBaselineVerdict`) is
REQUIRED before `completed`: with no peer configured the phase FAILS. The seam
is now two-sided — `seedDaemonE2eEnabled()` (daemon) and
`seedTransportE2eEnabled()` (server), each requiring BOTH
`LAMASYNC_SEED_E2E=1` and `LAMASYNC_TEST=1` — and
`seed-transport-bounded.test.ts` now asserts the restated invariant: the
transport and the store have exactly ONE production importer (`seed-runner.ts`),
the daemon reaches it only through that seam-guarded dynamic import, there is
exactly one daemon seam module, and the flags stay `false`. Do not add a static
import, a second importer, or a seam that accepts one variable. Also: never let
the runner resolve a production remote or read a credential outside the seam.

**Stage 2e made a long stage safe, and a cancelled one harmless.** A seed stage
is routinely longer than the 10-minute job lease (the incident was 43.5
minutes), so `packages/daemon/src/seed-lease-supervisor.ts` renews the JOB lease
from a TIMER that runs ALONGSIDE each stage — never merely between stages — with
the interval clamped to at most half the lease, and a grace window
(`SEED_JOB_LEASE_STOP_GRACE_MS`) bounded strictly INSIDE the lease, so a side
that can no longer reach the server stops on its own rather than discovering the
loss from a refused write. A 4xx latches a stop (and the job is re-read to report
the real reason); a 5xx is tolerated inside the grace. The stop is an
`AbortSignal` threaded into tar, extraction, the manifest/extracted-tree
verification, both object transfers and the `rclone bisync` child (which has no
graceful cancel, so it is killed — its workdir lives in this run's work
directory and `--resync` is restartable). `verifyAuthority()` — a real GET —
runs immediately BEFORE `publishStagedTree` and immediately BEFORE the completion
report, so a cancellation that lands during a long stage can never publish or
complete, and a stage that throws while aborted is a STOP rather than a job
failure. The staging sibling is recorded before the first byte lands in it and
removed on failure only while nothing was published.

Two traps worth remembering: the TARGET must NOT renew while the SOURCE owns the
job (during its wait for the facts the lease route correctly refuses, and reading
that refusal as "the job is lost" would abandon a healthy wait) — it reads the
job instead and starts the supervisor when its own half begins; and the reaper
must not treat the handover window (facts recorded, lease cleared, still
`running`) as stale, so a no-lease running job is only reaped after
`SEED_JOB_HANDOVER_GRACE_MS`. The ACTION lease (`ACTION_LEASE_MS`, renewed by the
daemon's action timer) is a DIFFERENT lease and neither implies the other.

Two inputs are deliberately still SEAM-SUPPLIED, and both are required before
the constant may flip: the target's resync PEER (in production the assignment's
resolved remote + the daemon's rclone config) and the relay SPACE
(`LAMASYNC_SEED_S3_*`). The relay contract carries no credential by design, and
where the fleet's temporary seed space lives is an owner decision. A daemon-run
job deletes its relay objects but does not yet persist the `cleanup` block
server-side (no device route for it); the objects are gone, the bookkeeping
field stays `not_started`. A STOPPED side deletes nothing at all and leaves its
objects to the retention sweep, which the E2E asserts.

**Execution is deliberately unavailable by default**:
`SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` is `false` (while
`SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED` is `true`), `POST /seed-jobs` returns
`503 { executionAvailable: false, reason }`, and the Folders page shows a
disabled control. The path IS reachable behind the doubly-gated seam, and the
disposable E2E proves it with two real daemons — do not flip the transport
constant without the §2.11/§2.14.6 host proofs (a real two-machine hop, real
ENOSPC, the live large-tree run) on record and reviewed, and do not add a
credential to the relay contract: the store is constructed by whoever owns the
configuration.

The archive primitives (create/validate/extract/verify/atomic-publish) are
implemented and fixture-tested end-to-end with the host's real GNU tar, and
mtimes must survive the archive, or the following bisync reports every file as
changed (`File changed: time`) instead of a clean zero-change baseline — and
with a whole tree of changed mtimes its safety check aborts the run. The Stage
2a harness asserts "no file is reported as changed", not merely "no bytes
moved". The **manifest is the authority for what may be archived**: it is built
from the folder's effective filter universe, a member a seed cannot represent
blocks the run before tar starts, and the produced archive's member set must
equal the manifest's. The **source device is named by the operator**
(`sourceHostId`), never inferred from a size, and the staging verdict must be a
true sibling with a same-filesystem proof reported by the target device —
unknown fails closed. Design, space math, failure/recovery table, threat rules
and the rollout plan are in
[`handoff-346-initial-folder-seeding.md`](handoff-346-initial-folder-seeding.md).

LAMA-345's follow-up (Dashboard fleet-health summary with the evidence-based
update verdict, one derived health read path, the far-future-cron scheduler fix,
and the in-page scroll + Folders deep-link corrections) is implemented in this
worktree too, with a reusable isolated integration harness in
`scripts/lama345-integration.ts`. Two UI entry points are now load-bearing and
easy to break: the Dashboard urgent row is a plain button (never a fragment
Link, which HashRouter corrupts) and `/folders?folder=&host=` is consumed by
`folder-deep-link.ts`. dev-vm still runs the released
v0.3.11 daemon, so its Projects folder keeps resyncing on every run (the
`bisync.state` sentinel has never existed there — the paired
`*.path1.lst`/`*.path2.lst` files are on disk). Deployment gate and the
evidence are in the LAMA-345 comments.

LAMA-345 (managed-folder health diagnostics and guided bisync intervention) is
implemented in this worktree across all four planned stages — the shared health
contract, the lightweight daemon probe and server persistence, the read-only
diagnose/plan actions, the guarded initialize/seed/resync/resume/cancel
interventions with the paired-`*.path1.lst`/`*.path2.lst` baseline fix, and the
Web UI health card, four-step guided wizard and advanced typed settings. It
awaits review and release; see the status entry in [status.md](status.md). The
two-file listing pair replaces the old `bisync.state` sentinel, filter changes
are acknowledged only by a resync that actually established a baseline, and
execution is bound to the reviewed plan's semantics (intervention, winning side
and `--max-delete` percentage) rather than to the request that follows it.
Live v0.3.12 fleet validation then found a **release-blocking plan/execution
safety regression**, fixed in this worktree too: the dry-run accumulator never
matched modern rclone's `"skipped"` field, so a plan could report 0 changes and
then execute hundreds of transfers (cachy: plan 0 → 349 transfers / 803 MB).
Plans are now truthful, and the invariant is **no unreviewed content
mutation** rather than "never rebuild a baseline": a zero-content review is a
legitimate baseline-only recovery, but the daemon re-runs a fresh dry run with
the plan's own reviewed control before executing and refuses the run if
anything would transfer (the enqueue boundary no longer rejects it, since only
the daemon can run rclone). A claimed action holds a renewable lease
(`POST /api/v1/actions/:id/lease`)
so a long plan/intervention cannot be reclaimed and re-executed while it is
still running. The LAMA-345 comments carry the evidence and the deployment
gate; do not retry the cachy intervention from a pre-fix build.

LAMA-316's app-backup data contract, LAMA-324 storage destinations, LAMA-325
retention, and the LAMA-302 real-worktree soak are complete. LAMA-327 live
sync progress and LAMA-328 persisted stale-while-revalidate folder/storage
statistics are integrated with the current application-update baseline.
LAMA-336 (the
live-tree tar fix plus the whole file-operation/app-destination audit batch)
is merged and awaits release and a `dev-vm`
update — see follow-up 2 in [status.md](status.md). LAMA-337 (reconnect QR for
an existing Android registration: an admin-created one-time QR whose exchange
rotates that device's credentials in place, so its host id, inboxes and upload
history survive) is merged and awaits release plus
one owner call on the Android paired-state QR entry — see follow-up 1. The
next product work is LAMA-315 path classification (design handoff ready in
`docs/handoff-315-path-classification.md`; stages 1–2 are implemented), the
separate safe application setup/restore executor, and the LAMA-321
trash-retention follow-up. LAMA-311's two dev-vm fixes are implemented in the
worktree — the queued `trigger_sync`/`trigger_backup` dispatcher now refreshes
and re-selects before failing a folder absent from the cache, and
`lamasyncd --update` / `update_daemon` reconcile a stale systemd user unit even
when the binary is current. Both await a client rollout that restarts
`lamasyncd.service` (see follow-up 6 in [status.md](status.md)).
See [status.md](status.md) and the assigned Multica issue for scope; do not use
archived handoffs as a current specification.

## First five minutes

1. Run `git status --short --branch`; preserve unrelated work in a dirty tree.
2. Read the assigned Multica issue and its current comments.
3. Read the smallest relevant source-of-truth document: `ARCHITECTURE.md` for
   contracts, `development.md` for implementation recipes, or `prod-deploy.md`
   for production work.
4. Find the existing behavior and tests before changing types, routes, or UI.
5. Keep one writer per worktree and report an owner decision rather than
   inventing it.

## Guardrails

- Preserve wire/API/CLI compatibility unless the issue explicitly authorizes a
  break; document intentional breaks in the skill reference.
- New DB data belongs in both `SERVER_SCHEMA` and `MIGRATIONS`.
- New routes, commands, and flags must pass the strict skill-drift check.
- Application restore must not gain a direct write path before its setup-plan
  safety contract is implemented.

## Handoff baseline

Run the checks proportional to the change. For a normal cross-package change:

```bash
bun x tsc --noEmit
bun run build:web-ui
bun test
bun run scripts/check-skill-drift.ts --strict
```

Report changed files, validation results, any unavailable live check, and any
unresolved owner decision in the Multica update.
