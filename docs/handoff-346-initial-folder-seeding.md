# LAMA-346 — initial large-folder seeding and progress-aware sync timeouts

Status: **first vertical slice implemented and locally validated.** Execution of
the archive transport is deliberately **unavailable** — the plan, the space
calculation, the staging rules, the persistent job state machine and the
progress-aware deadline are implemented and tested, and the API/UI say exactly
that. Ordinary sync is unchanged.

Branch: `aliforfaen/lama346-initial-folder-seed` (worktree
`lama346-initial-folder-seed`). No deploy, no live host touched, rclone never
invoked by the agent.

## 1. Why this exists — the live evidence

Measured on 2026-09-19 (recorded in the issue):

| Tree | Files/entries | Bytes |
|---|---|---|
| `master` `/home/messhias/lamasync/projects` | 91,660 | 14,864,173,809 (13.84 GiB) |
| `dev-vm` (after recovery) | 850 | 17,715,220 (16.9 MiB) |

On **2026-09-17** the original `dev-vm` initial bisync repeatedly hit the
fixed **600-second wall-clock timeout with exit 143** *before any completed
transfer or check was recorded*. Each top-level retry cycle lasted about
**43.5 minutes**. The subsequent recovery transferred **850 items / 16.9 MiB**,
and a later resync reported **zero changes**.

The conclusion is not "rclone is slow". It is that a first full transfer is
not a sync, and that **a timeout that measures elapsed time instead of
progress kills healthy work**. Two independent fixes follow: an explicit seed
path for the first transfer, and a progress-aware deadline for the stages that
do the heavy lifting.

## 2. Finalized design

### 2.1 A seed transfer, not an automatic switch

- The planner **recommends** a seed transfer when a folder's measured entry
  count is at or above `SEED_RECOMMENDATION_FILE_THRESHOLD` (3,000).
  91,660 is far above it; the 850-entry recovery is far below.
- A recommendation is *never* a trigger. A plan exists only because an admin
  called `POST /folders/:id/seed-plans` with `confirm: true`
  (`SEED_PLAN_REQUIRES_OPERATOR = true`). Ordinary sync remains the default and
  remains available for every folder, including a recommended one.
- The recommendation is derived from a measurement the daemon already reports
  on its slow cadence — preparing a plan is cheap and cannot itself time out.

### 2.2 Staging, never inside the target

```
target parent (same filesystem)
├── <target dir>                        ← final destination
└── .lamasync-seed-staging-<base>-<id>  ← archive unpacked + verified here
```

- Staging is a **sibling** of the final target, on the **same filesystem**.
  `validateStagingLocation` refuses staging inside the target (it would be
  managed content *and* make publication a copy) and refuses a different
  filesystem (publication would be a copy, reintroducing the timeout).
- Publication is **one atomic rename**. A non-empty target is refused rather
  than merged: merging a partial tree with a seed would force the following
  bisync to guess.
- The archive lives in a **dedicated, temporary object namespace**
  (`lamasync/seed/<jobId>/payload.tar.zst`), never the existing Shared
  managed-folder namespace. A seed archive is transport, not data, and must
  never be mistaken for a synced file.

### 2.3 Archive format

- `tar.zstd` when `zstd` is on PATH; `tar.gz` is the documented compatibility
  fallback (GNU tar + gzip are already hard dependencies of the app-capture
  path, LAMA-336). `selectSeedArchiveFormat` returns the reason with the
  choice, and the plan stores it.
- The archive preserves **mtimes**. This is load-bearing: rclone bisync
  compares size + modtime, so an archive that reset mtimes would make the
  mandatory zero-change baseline validation fail and re-copy the whole tree.
- Extraction uses `--no-same-owner --no-same-permissions --no-overwrite-dir`,
  so no ownership or setuid bit from an untrusted archive is ever applied.

### 2.4 The pipeline (local half implemented and fixture-tested)

```
source tree
  → manifest (path, kind, size, mtime, SHA-256) + stats fingerprint
  → tar + zstd|gzip (verbose output = measurable progress)
  → member validation (safe relative path AND regular file/directory)
  → [transport: NOT IMPLEMENTED]
  → extract into sibling staging dir
  → verify extracted tree against the manifest byte-for-byte
  → atomic rename into the final target
  → fresh zero-content-change bisync baseline validation
```

Everything up to and including the atomic rename is implemented in
`packages/daemon/src/seed-archive.ts` and driven end-to-end against a fixture
with the host's real GNU tar, for both `tar.zstd` and `tar.gz`.

### 2.5 Progress-aware timeout (the actual dev-vm fix)

`shouldExtendSeedDeadline` (core, pure) is the single decision:

- **continue** while measurable progress keeps arriving;
- **fail** when no measurable progress for `stallMs`
  (`SEED_STALL_TIMEOUT_FALLBACK_SEC` = 600 s — the old wall-clock timeout,
  reinterpreted as a *stall* budget; an assignment's own `timeoutSec` replaces
  it);
- **fail** at the absolute ceiling `SEED_STAGE_HARD_CAP_MS` = 6 h, so a stage
  that reports progress forever still ends.

The daemon applies it to exactly the stages that are initial seed stages: a
first run with **no usable baseline** (the dev-vm shape), an explicit
`initialize`/`seed` intervention, or a caller-flagged `seedStage`. Every other
run keeps its exact fixed wall-clock timeout — no normal safety limit is
weakened. Only a parsed rclone **phase or stats** line counts as measurable
progress, so unrelated chatter cannot keep a dead stage alive.

### 2.6 Persistent job state machine

Phases, strictly forward one step at a time (or to a terminal phase):

```
preflight → measuring_source → archiving_source → uploading_archive
  → downloading_archive → verifying_archive → extracting_target
  → verifying_target → publishing → baseline_validation
  → completed | failed | cancelled
```

- Stored in `folder_seed_jobs` with a bounded JSON `progress` blob.
- A running job holds a **renewable lease** (`SEED_JOB_LEASE_MS` = 10 min,
  renewed through `POST /seed-jobs/:id/progress` or `/lease`). A live daemon
  renews every minute, so an expired lease means "the owner is gone", never
  "the owner is slow"; the reaper fails it rather than silently keeping it.
- Completion is **idempotent**: a duplicate ack returns the stored outcome and
  cannot rewrite a terminal state. A late progress report on a finished job is
  a 409.
- Progress and errors are broadcast on the `seed_job` WebSocket event and read
  back through `GET /seed-jobs/:id` / `GET /folders/:id/seed-jobs`.

## 3. Space calculation

The peak staging footprint is `archive + extracted tree`, because the archive
is verified before extraction and deleted after publication — so both exist at
once:

```
archiveBytesEstimate = ceil(sourceBytes × archiveRatio)   # ratio default 1.0
extractedBytes       = sourceBytes                        # exact from manifest
peakBytes            = archiveBytesEstimate + extractedBytes
requiredFreeBytes    = ceil(peakBytes × 1.25) + 64 MiB
ok                   = targetFreeBytes is known AND targetFreeBytes ≥ requiredFreeBytes
```

- `archiveRatio` defaults to **1.0**, deliberately conservative: an
  incompressible tree produces an archive as large as its input. A measured
  ratio replaces it once an archive exists.
- `SEED_SPACE_SAFETY_FACTOR` = 1.25 and `SEED_SPACE_FIXED_OVERHEAD_BYTES` =
  64 MiB cover manifest/checksum/journal overhead and filesystem slack.
- **Unknown free space is not `ok`.** The plan is created but explicitly not
  runnable with the exact reason ("measure the target device first"), because a
  half-extracted tree is worse than a refused seed.
- Worked example (dev-vm as target): source 14,864,173,809 B → archive
  14,864,173,809 B + extracted 14,864,173,809 B = peak 29,728,347,618 B →
  reservation ≈ 37.2 GB (34.67 GiB). `master` as target would need the same
  reservation; the planner uses the **target's** own reported free space.

## 4. Failure and recovery cases

| Case | Behaviour |
|---|---|
| Source tree changes while archiving | stats fingerprint taken before and after; a difference **fails the archive** (`churned`). Nothing is uploaded or extracted. |
| Archive member is absolute, `..`, drive/UNC, backslash, NUL/control, or over-long | `validateArchiveMembers` rejects the whole archive and reports a bounded offender sample. Fail closed — never skip a member silently. |
| Archive member is a symlink, hardlink, device, FIFO or socket | `validateSeedArchive` rejects it (`tar -tvf` type char must be `-` or `d`). |
| Archive is unreadable / wrong format | listing failure is a hard failure, never a trusted empty list. |
| Source contains symlinks or special files | recorded as `excluded` in the manifest and reported as a preflight error; the mandatory baseline validation is where a genuinely incomplete tree surfaces. |
| Extracted tree differs (missing, size, checksum, unexpected extra) | `verifyExtractedTree` fails before publication. |
| Target already has files | publication refused; nothing merged or overwritten. |
| Target free space short or unknown | plan is not runnable with the exact shortfall. |
| Staging inside the target / different filesystem | refused by `validateStagingLocation`, and again by `publishStagedTree`. |
| Seed stage stalls | killed after the stall budget with `seed-stage stalled: …`; the job is failed with that reason. |
| Seed stage keeps progressing for six hours | killed at the hard cap with `seed-stage hard_cap: …`. |
| Daemon stops reporting | lease expires → reaper fails the job ("the device stopped reporting progress and its lease expired"). |
| Operator cancels | `POST /seed-jobs/:id/cancel` writes a terminal `cancelled`; the device observes it and stops. A job already terminal is returned unchanged. |
| Plan goes stale | dies on expiry (30 min), config-revision bump, filter change, baseline change, missing tooling, insufficient space, or a staging policy violation. |
| Post-seed baseline validation reports content changes | the seed is treated as **failed** — the whole point of the seed is that the following bisync has nothing to do. |
| Resume | the phase machine allows a same-phase retry, and the persisted job/lease model is designed for resumption. The transport implementation must re-verify the archive checksum before resuming extraction. |

## 5. Threat / safety rules

1. **No caller-supplied argv.** There is no field anywhere for an rclone flag,
   config path, command or URL. The daemon derives every argv element itself,
   and the plan/job/progress grammars reject unknown fields.
2. **An archive is untrusted input.** Members are validated by name *and*
   type before extraction; extraction runs with no ownership/setuid restore and
   no overwrite of the staging directory's own permissions.
3. **No silent authority choice.** The seed never decides which side wins a
   content conflict; that remains the reviewed `authority` of the LAMA-345
   intervention, and the seed only ever publishes into an **empty** target.
4. **Fail closed everywhere.** Unknown free space, a missing measurement, a
   changed source, an unsafe member, a non-empty target, an unreadable
   archive, a mismatched tree — all refuse rather than proceed.
5. **Staging is never managed content.** It is a sibling directory, created
   with a `SEED_STAGING_DIR_PREFIX` name, and removed by the atomic rename.
6. **The seed namespace is separate.** Archives go to `lamasync/seed/<jobId>/…`,
   never the Shared managed-folder namespace, so transport data cannot be
   mistaken for synced data or picked up by bisync.
7. **No weakening of normal limits.** Ordinary sync keeps its fixed
   wall-clock timeout, its `--max-delete` threshold, and its plan review. The
   progress-aware deadline applies only to explicitly identified seed stages.
8. **Nothing runs yet.** Execution is gated by a single explicit capability
   constant; the API refuses with a reason and the UI disables the control.

## 6. Rollout plan

**Stage 0 — this slice (done, awaiting review).**
Contract, schema + migration, server API, plan/preflight surface, job
state machine + lease + progress, archive primitives with fixture tests,
progress-aware deadline wired into the daemon, UI panel + help text, docs and
skill reference. `POST /seed-jobs` returns 503; the UI's Run control is
disabled with the server's reason.

**Stage 1 — transport, still no execution.**
Implement the S3 relay (upload to `lamasync/seed/<jobId>/…`, download on the
target) behind the existing `SeedJob` state machine, with an integration test
against a local object-store fixture. Keep `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED`
false until the *whole* pipeline (including the post-seed baseline validation)
is proven end-to-end.

**Stage 2 — end-to-end fixture acceptance.**
A two-host fixture run through the real daemon: source archive → transport →
target staging → verify → atomic rename → bisync baseline validation reporting
zero content changes. Only then flip the capability constant.

**Stage 3 — live acceptance on the real pair.**
Re-run the dev-vm shape with a copy of a large tree (never the live
authoritative tree) and confirm: no timeout kill while progressing, one
resume after a deliberate stall, correct space refusal when the target is
squeezed, and a zero-change baseline afterwards.

**Stage 4 — operator rollout.**
Release, deploy the server, update daemons, and only then expose the Run
control. The seed remains opt-in per folder.

## 7. What is implemented vs. explicitly not

| Area | State |
|---|---|
| Shared contract, thresholds, space math, staging policy, archive member safety | **implemented + tested** |
| `folder_seed_plans` / `folder_seed_jobs` schema + migration | **implemented** |
| Seed plan preflight API (read-only) | **implemented + tested** |
| Seed job state machine, lease, progress, cancel, complete | **implemented + tested** |
| Archive create / validate / extract / verify / atomic publish | **implemented + fixture-tested end-to-end** |
| Progress-aware seed-stage deadline in the executor | **implemented + tested with real processes** |
| Web UI plan panel, phases, help text, disabled execution | **implemented + tested** |
| Upload/download of the archive to temporary seed space | **NOT implemented** |
| Remote orchestration (which host runs which phase) | **NOT implemented** |
| Post-seed zero-change bisync validation as an automated gate | **designed, not implemented** |

Because the transport and remote orchestration are not implemented,
`SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` is `false`, `POST /seed-jobs` returns
`503 { executionAvailable: false, reason }`, and the UI shows a disabled
control. No live archive transfer is claimed anywhere.

## 8. Changed files

Core
- `packages/core/src/folder-seed.ts` (new) — contract, space math, staging
  policy, archive safety, phase machine, deadline decision, wire grammar.
- `packages/core/src/folder-seed.test.ts` (new).
- `packages/core/src/folder-health.ts` — `facts.archive` tooling block.
- `packages/core/src/types.ts` — `seed_plan` / `seed_job` WS events.
- `packages/core/src/db/schema.ts` — `folder_seed_plans`, `folder_seed_jobs`
  in `SERVER_SCHEMA` and `MIGRATIONS`.
- `packages/core/src/index.ts`, `packages/core/package.json` — export the new
  module (`@lamasync/core/folder-seed`).

Daemon
- `packages/daemon/src/seed-archive.ts` (new) — tooling detection, manifest,
  create/list/validate/extract, verify, atomic publish, preflight.
- `packages/daemon/src/seed-archive.test.ts` (new).
- `packages/daemon/src/seed-deadline.test.ts` (new).
- `packages/daemon/src/executor.ts` — `ProcessWatchdog` / `superviseProcess` /
  `seedStageWatchdog`, wired to first-run and initialize/seed runs.
- `packages/daemon/src/folder-health.ts` — report archive tooling.

Server
- `packages/server/src/seed-jobs.ts` (new) — persistence + plan preflight.
- `packages/server/src/routes/folder-seed.ts` (new) — the REST surface.
- `packages/server/src/routes/folder-seed.test.ts` (new).
- `packages/server/src/routes/folder-health.ts` — normalize `facts.archive`.
- `packages/server/src/routes/folders.ts` — delete seed artifacts with an
  assignment.
- `packages/server/src/auth.ts` — device allowlist for its own seed routes.
- `packages/server/src/app.ts`, `packages/server/src/index.ts` — compose the
  routes, declare the tag, sweep plans and stale jobs.

Web UI
- `packages/web-ui/src/folder-seed.ts` (new), `folder-seed.test.ts` (new).
- `packages/web-ui/src/components/FolderSeedPlanCard.tsx` (new),
  `FolderSeedPlanCard.test.tsx` (new).
- `packages/web-ui/src/pages/Folders.tsx` — mount the panel.
- `packages/web-ui/src/api.ts` — seed plan/job client methods.
- `packages/web-ui/src/index.css` — panel styles.

Docs / skill
- `packages/agent-skill/reference/api.md` — every new route + the contract.
- `docs/handoff-346-initial-folder-seeding.md` (this file).
- `docs/status.md`, `docs/agent-start.md`.

## 9. Validation

```bash
bun x tsc --noEmit                      # clean
bun run build:web-ui                    # clean (one self-contained index.html)
bun test                                # see the worktree report
bun run scripts/check-skill-drift.ts --strict   # OK (180 API rows, 181 routes)
```

Focused suites added:

- `packages/core/src/folder-seed.test.ts` — 34 tests: recommendation is never
  automatic, space fails closed, staging policy, phase machine, deadline
  continue/stall/hard-cap, wire grammar, plan validity, execution capability.
- `packages/daemon/src/seed-archive.test.ts` — 20 tests: real GNU tar for both
  `tar.zstd` and `tar.gz` — create → validate → extract → verify byte-for-byte
  → atomic rename, mtime preservation, traversal/symlink/churn/corruption
  refusals, non-empty target refusal, preflight.
- `packages/daemon/src/seed-deadline.test.ts` — 8 tests against real child
  processes: fixed timeout still kills an ordinary run, a progressing stage
  survives past the nominal timeout, a stall is killed, progress resets the
  budget, the hard cap bounds a chatty stage.
- `packages/server/src/routes/folder-seed.test.ts` — 13 tests: admin-only plan
  creation, mandatory `confirm`, plan built from reported facts, not-runnable
  when unmeasured, gzip fallback, list/read validity, explicit 503 execution
  refusal with no job row, legal/illegal phase transitions, host scoping,
  idempotent completion, admin-only cancel, stale-lease reaping.
- `packages/web-ui/src/folder-seed.test.ts` +
  `components/FolderSeedPlanCard.test.tsx` — 22 tests: recommendation wording,
  space/archive/staging wording, no invented tooling claims, disabled execution,
  plain-language phases, progress with only known totals.

## 10. Remaining live validation (owner / later stage)

1. Implement and fixture-test the archive transport (stage 1) before any live
   run.
2. Two-host end-to-end fixture acceptance with a zero-change baseline
   validation (stage 2).
3. A live dev-vm-shape run on a **copy** of a large tree, confirming no
   timeout kill while progressing and a correct resume after a deliberate
   stall (stage 3).
4. Confirm the target's archive tooling is reported before the Run control is
   enabled for that device.
5. Decide the retention/cleanup policy for `lamasync/seed/…` objects after a
   successful or abandoned job.
