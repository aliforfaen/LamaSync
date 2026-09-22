# LAMA-346 — initial large-folder seeding and progress-aware sync timeouts

Status: **first vertical slice implemented and locally validated, after an
independent review correction pass.** Execution is deliberately
**unavailable** — the plan, space calculation, staging rules, persistent job
state machine, archive primitives and progress-aware deadline are implemented
and tested, and the API/UI say exactly that.

The timeout change is stated precisely, because "ordinary sync is unchanged"
was too broad:

- a sync against an **existing, ready baseline keeps its exact fixed
  wall-clock timeout** — steady-state sync is untouched;
- a **first run with no usable baseline** (the dev-vm shape), an explicit
  `initialize`/`seed` intervention, or a caller-flagged seed stage is
  supervised by the progress-aware stall budget plus the 6-hour ceiling.

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

Read-only inspection of `/home/messhias/lamasync/projects` also found **28
symlinks**, chiefly nested `node_modules` under `worktrees/`. That fact is
load-bearing rather than incidental: a seed cannot represent a symlink, so a
seed that walked the *raw* tree could never publish a complete one. It is only
seedable through the folder's **effective filter universe** — the same set of
paths the following bisync baseline syncs (see §2.4).

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

### 2.2 The source authority is explicit, never inferred

`POST /folders/:id/seed-plans` requires **both**:

| Field | Meaning |
|---|---|
| `hostId` | the **target** device the seed is staged on |
| `sourceHostId` | the device that **holds the data** — named by the operator |
| `confirm: true` | the operator approved preparing a plan |

`sourceHostId` is validated and persisted as its own column
(`folder_seed_plans.source_authority_host_id`, plus a `source_authority` JSON
verdict). It must be:

1. **assigned to this folder** — otherwise 404 "that device is not assigned to
   this folder, so it cannot be the source of this seed";
2. **not the target** — otherwise 400/409 "the source device must be a
   different device from the target — a device cannot seed itself";
3. **holding a fresh, usable measurement** — within
   `SEED_SOURCE_MEASUREMENT_MAX_AGE_MS` (26 h: one deep-measurement cadence
   plus slack) and non-empty. Otherwise the plan is created but explicitly
   **not runnable**, naming the device, the age, and what to do next.

The planner never picks "the largest other assignment". Choosing an authority
from a number would silently seed the wrong tree, and a seed of the wrong tree
is worse than no seed. The plan's `sourceAuthority` block records the choice,
`selectedBy: "operator"`, and the evidence that it was usable; the panel shows
the sentence verbatim.

### 2.3 Staging: a true sibling, on a proven filesystem

```
target parent (same filesystem, and the SAME directory for both paths)
├── <target dir>                        ← final destination
└── .lamasync-seed-staging-<base>-<id>  ← archive unpacked + verified here
```

`validateStagingLocation` refuses, in order:

1. **inside the target** — it would be managed content *and* make publication
   a copy instead of a rename;
2. **a different direct parent** — staging must sit in exactly the directory
   that holds the target (`/data/elsewhere` is not a sibling of
   `/data/projects`, and `/data/elsewhere/x` is not either);
3. **not a derived staging directory** — the name must start with
   `SEED_STAGING_DIR_PREFIX`. Publication renames the staging directory *over*
   the target, so an unrelated pre-existing directory must never qualify;
4. **a different filesystem** — publication would be a copy, reintroducing the
   timeout this feature exists to remove;
5. **an UNKNOWN filesystem verdict** — fail closed. The server cannot stat the
   target's filesystem, so the fact comes from the **target device's own
   report**: `facts.seedStaging` proves that the staging sibling's parent *is*
   the target's parent and that the directory was readable. `null` (never
   reported, malformed, or unreadable) is not runnable, and the server
   normalizer only accepts a literal `true` — a truthy value is unproven.

Publication is **one atomic rename**. A non-empty target is refused rather
than merged: merging a partial tree with a seed would force the following
bisync to guess.

The archive lives in a **dedicated, temporary object namespace**
(`lamasync/seed/<jobId>/payload.tar.zst`), never the existing Shared
managed-folder namespace. A seed archive is transport, not data, and must
never be mistaken for a synced file.

### 2.4 The effective filter universe — Stage 1a, IMPLEMENTED

A seed archives **exactly the universe the following bisync baseline syncs**:
`lamasyncignore` patterns, `ignoreGitMetadata`, and `respectGitignore`. It
never archives the raw tree while sync filters a different one. Two concrete
reasons:

- a target published from a *different* universe cannot validate to zero
  content changes, which is the seed's entire contract;
- the raw tree contains members a seed cannot represent — the 28 nested
  `node_modules` symlinks found in the real Projects tree. Excluding
  `node_modules` removes them from the universe **before they are walked**, so
  the same folder becomes seedable.

The universe is an explicit, fingerprinted input:

```ts
interface SeedSourceFilterUniverse {
  fingerprint: string;        // must equal the source assignment's fingerprint
  patterns: readonly string[];
  includes(relativePath, isDirectory): boolean;   // false prunes the subtree
}
```

`buildSeedManifest(root, { filter })` **requires** it — there is no default —
and `seedPreflight` requires it too. The manifest records the fingerprint,
pattern count, and a bounded sample of what was excluded, so a manifest can be
checked against the plan's own `filterUniverse` block.

#### How the universe is derived (no second notion of "ignored")

The universe is not a re-implementation of the ignore rules. It is compiled
from **the same `--filter-from` rule lines the executor writes for the run**:
`loadFilterPatterns(resolveFilterPath(...))` →
`effectiveSyncFilterPatterns(patterns, folderType, ignoreGitMetadata)` (which
prepends `- .git/**`), and, when `respectGitignore` is on,
`buildRcloneFilterSnapshot(root).rules` **prepended** to those patterns — the
exact order `materialiseGitignoreFilter` writes into the file rclone reads.
Order matters, because rclone's **first** matching rule wins.

`packages/daemon/src/seed-filter-universe.ts` compiles those lines with
rclone's own semantics and exposes the result as the predicate. The fingerprint
comes from `effectiveFilterFingerprint(gitignoreRules, patterns)` — the *same*
function the executor uses — so a seed's universe is directly comparable with
the assignment's acknowledged baseline fingerprint.

`buildSeedSourceManifest(assignment, folderType)` is the single entry point:
assignment → universe → manifest, failing closed on an unusable rule set, an
unbuildable Git-ignore snapshot, an unrepresentable member, or an unreadable
source. Stage 1b's job will call it; nothing calls it from a running job yet,
because the transport is still missing.

#### rclone semantics that are easy to get wrong

Verified against rclone v1.68.2 and pinned by a cross-check test that runs the
host's real `rclone lsf --filter-from` over a table of rule sets (skipped when
rclone is absent):

| Behaviour | Consequence for a seed |
|---|---|
| **First matching rule wins**; an unmatched path is included | Rule order must match the executor's file exactly — an appended `+` cannot re-include an earlier `-` |
| A rule needs a sign **and exactly one space**; `-a.txt` is malformed | rclone aborts the run on one, so the universe is unusable and the seed fails closed |
| **Only a trailing-slash rule matches a directory** | `- node_modules` excludes a *file* of that name and leaves the **directory** in the universe; `- node_modules/` prunes the subtree |
| A pattern containing `/` (or starting with `/`) is root-relative; otherwise it matches the basename at any depth | `sub/a.txt` is root-relative, `a.txt` matches `sub/a.txt` too |
| `{{...}}` is compiled as `^(?:.*/)?<regex>$` | Prefix-anchored, allowed at any depth, must consume the whole path: `{{sub/inner}}` does **not** exclude `sub/inner/g.bin` |
| `**` crosses `/`; `*` and `?` do not; matching is case-sensitive | `**/*.log` excludes `sub/b.log` but not root `b.log` |
| rclone's local backend **skips symlinks and special files** without `--links`/`-L` (which this fleet never passes) | Recorded as a deliberate, conservative refusal — see §2.6 |

#### Directories that the universe includes but that hold nothing

rclone transfers no empty directories by default (the fleet never passes
`--create-empty-src-dirs`), so a directory the universe includes but that
contains no included file is **not** a manifest member. It is recorded in
`manifest.emptyDirsPruned` instead. This is what removes the empty `.git/`
directory that `- .git/**` leaves behind: the rule is not a trailing-slash rule,
so it excludes everything *inside* `.git` rather than the directory itself.

#### Status

`SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED` is **`true`** (Stage 1a). The one
remaining Stage 1 prerequisite is the **transport**. A plan is still refused
when the target's *established* baseline used a different filter set than the
source's (`filterUniverse.match` is false), because that seed would be
re-synced afterwards, and execution remains unavailable (§7).

### 2.5 Archive format

- `tar.zstd` when `zstd` is on PATH; `tar.gz` is the documented compatibility
  fallback (GNU tar + gzip are already hard dependencies of the app-capture
  path, LAMA-336). `selectSeedArchiveFormat` returns the reason with the
  choice, and the plan stores it.
- The archive preserves **mtimes**. This is load-bearing: rclone bisync
  compares size + modtime, so an archive that reset mtimes would make the
  mandatory zero-change baseline validation fail and re-copy the whole tree.
- Extraction uses `--no-same-owner --no-same-permissions --no-overwrite-dir`,
  so no ownership or setuid bit from an untrusted archive is ever applied.

### 2.6 The pipeline and the manifest↔archive contract

```
effective filter universe of the source tree
  → manifest (path, kind, size, mtime, SHA-256) + stats fingerprint + filter identity
  → [refuse if any included member is not representable]   ← BEFORE tar
  → tar + zstd|gzip (verbose output = measurable progress)
  → [refuse unless the archive's member set EQUALS the manifest's]   ← AFTER tar
  → member validation (safe relative path AND regular file/directory)
  → [transport: NOT IMPLEMENTED]
  → extract into sibling staging dir
  → verify extracted tree against the manifest byte-for-byte
  → atomic rename into the final target
  → fresh zero-content-change bisync baseline validation
```

The earlier draft of this design had a real defect, caught in review: the
manifest called symlinks "excluded / not archived" while `tar` archived the
whole tree, so create-then-validate could never succeed. The correction is
that the manifest is the **authority** for what may be archived, and three
independent guards enforce it:

1. **before tar** — `seedManifestBlockingReason` refuses when the universe
   contains a member the seed cannot represent. The runner is never invoked
   and no archive file is produced (asserted by test);
2. **tar's input is the manifest** — Stage 1a: tar is invoked as
   `tar --create --directory <root> --no-recursion --files-from <member list>`,
   where the member list is exactly `manifest.entries`. The old
   `--directory root .` form archived the whole raw tree, so a *filtered*
   folder could never produce a matching archive at all. `--no-recursion` is
   what makes the list authoritative;
3. **after tar** — the produced archive's member set must equal the manifest's
   (normalizing tar's `./` prefix and directory trailing slashes, ignoring the
   archive root). A mismatch in either direction deletes the archive and fails
   with "content the manifest does not describe" / "content the manifest
   requires but the archive lacks". Both directions are tested by rewriting the
   member list under a real tar.

Source churn is measured **within the same universe** (`buildStatsFingerprint`
takes the filter), so a change to excluded content can neither fail the run nor
mask a change to included content.

#### Why a filter-included symlink is refused rather than skipped

rclone's local backend does not transfer symlinks or special files without
`--links`/`-L`, and this fleet passes neither — it logs "Can't follow symlink
without -L/--copy-links" and skips them. So sync would *ignore* such a member.
The seed still refuses (fail closed) rather than dropping it, deliberately:
the seed's value is a **provable** identity between the published tree and the
source universe, and a member that silently disappears between the manifest and
the archive is exactly the divergence this feature exists to prevent. The
refusal names the member and its reason, and the remedy is the folder's own
ignore rules — which is why the Projects shape becomes seedable once its
excludes are configured (fixture-tested with nested `node_modules` symlinks).

Everything up to and including the atomic rename is implemented in
`packages/daemon/src/seed-archive.ts` and driven end-to-end against a fixture
with the host's real GNU tar, for both `tar.zstd` and `tar.gz`.

### 2.7 Progress-aware timeout (the actual dev-vm fix)

`shouldExtendSeedDeadline` (core, pure) is the single decision:

- **continue** while measurable progress keeps arriving;
- **fail** when no measurable progress for `stallMs`
  (`SEED_STALL_TIMEOUT_FALLBACK_SEC` = 600 s — the old wall-clock timeout,
  reinterpreted as a *stall* budget; an assignment's own `timeoutSec` replaces
  it);
- **fail** at the absolute ceiling `SEED_STAGE_HARD_CAP_MS` = 6 h, so a stage
  that reports progress forever still ends.

`syncRunIsProgressAware` (daemon, pure, unit-tested) is the single expression
of **which runs** get it:

| Run | Deadline |
|---|---|
| sync with a ready baseline | **fixed wall-clock timeout, unchanged** |
| planned resync on a ready baseline | fixed wall-clock timeout, unchanged |
| first run with **no usable baseline** (dev-vm shape) | progress-aware stall budget + hard cap |
| explicit `initialize` / `seed` intervention | progress-aware stall budget + hard cap |
| caller-flagged `seedStage` | progress-aware stall budget + hard cap |

Only a parsed rclone **phase or stats** line counts as measurable progress, so
unrelated chatter cannot keep a dead stage alive.

### 2.8 Persistent job state machine

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

### 2.9 Prerequisites are listed, not collapsed into one boolean

`seedPlanPrerequisites(plan)` returns every gate in order —
`source_authority`, `filter_universe`, `staging_same_filesystem`,
`target_tooling`, `target_space`, `transport` — each with its own message.
The UI lists the unmet ones ("Before this seed can run: …"), so an operator
sees *all* blockers instead of the first one. `transport` is the one open
Stage 1 prerequisite; `filter_universe` still fails whenever the target's
established baseline used a different filter set.

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
| The universe includes a symlink / device / FIFO / socket | `seedManifestBlockingReason` **blocks the seed before tar runs** and names the offender plus "exclude them with the folder's ignore rules". Never archived, never silently dropped. |
| The archive does not represent exactly the manifest | the archive is deleted and the run fails, naming the undescribed/ missing content. |
| Archive member is absolute, `..`, drive/UNC, backslash, NUL/control, or over-long | `validateArchiveMembers` rejects the whole archive and reports a bounded offender sample. Fail closed — never skip a member silently. |
| Archive member is a symlink, hardlink, device, FIFO or socket | `validateSeedArchive` rejects it (`tar -tvf` type char must be `-` or `d`). |
| Archive is unreadable / wrong format | listing failure is a hard failure, never a trusted empty list. |
| Extracted tree differs (missing, size, checksum, unexpected extra) | `verifyExtractedTree` fails before publication. |
| Target already has files | publication refused; nothing merged or overwritten. |
| Target free space short or unknown | plan is not runnable with the exact shortfall. |
| Staging inside the target / not the same direct parent / not a derived staging name / different filesystem / unproven filesystem | refused by `validateStagingLocation`, and again by `publishStagedTree`. |
| `sourceHostId` is the target | 400 (request grammar) and 409 (plan builder, for direct callers). |
| `sourceHostId` is not assigned to the folder | 404, naming the reason. |
| Source measurement missing, stale (>26 h) or empty | plan created, **not runnable**, message names the device and the age. |
| Source and target established filter sets differ | plan not runnable; both fingerprints are recorded. |
| Filter-aware archive construction not wired | plan not runnable; `SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED` is false. |
| Seed stage stalls | killed after the stall budget with `seed-stage stalled: …`; the job is failed with that reason. |
| Seed stage keeps progressing for six hours | killed at the hard cap with `seed-stage hard_cap: …`. |
| Daemon stops reporting | lease expires → reaper fails the job ("the device stopped reporting progress and its lease expired"). |
| Operator cancels | `POST /seed-jobs/:id/cancel` writes a terminal `cancelled`; the device observes it and stops. A job already terminal is returned unchanged. |
| Plan goes stale | dies on expiry (30 min), config-revision bump, filter change, baseline change, unusable source authority, unwired filter-aware archiving, a filter mismatch, missing tooling, insufficient space, or a staging policy violation. |
| Post-seed baseline validation reports content changes | the seed is treated as **failed** — the whole point of the seed is that the following bisync has nothing to do. |
| Resume | the phase machine allows a same-phase retry, and the persisted job/lease model is designed for resumption. The transport implementation must re-verify the archive checksum before resuming extraction. |

## 5. Threat / safety rules

1. **No caller-supplied argv.** There is no field anywhere for an rclone flag,
   config path, command or URL. The daemon derives every argv element itself,
   and the plan/job/progress grammars reject unknown fields.
2. **An archive is untrusted input.** Members are validated by name *and*
   type before extraction; extraction runs with no ownership/setuid restore and
   no overwrite of the staging directory's own permissions.
3. **No silent authority choice — of either kind.** The *source device* is
   named by the operator and never inferred from a size; and the seed never
   decides which side wins a content conflict, which remains the reviewed
   `authority` of the LAMA-345 intervention. The seed only ever publishes into
   an **empty** target.
4. **Fail closed everywhere.** Unknown free space, a missing/stale
   measurement, an unrepresentable member, an archive that does not match the
   manifest, a changed source, an unsafe member, a non-empty target, an
   unreadable archive, an unproven filesystem, a mismatched tree — all refuse
   rather than proceed.
5. **Staging is never managed content.** It is a sibling directory with the
   `SEED_STAGING_DIR_PREFIX` name, in the target's own parent, and it is
   consumed by the atomic rename.
6. **The seed namespace is separate.** Archives go to `lamasync/seed/<jobId>/…`,
   never the Shared managed-folder namespace, so transport data cannot be
   mistaken for synced data or picked up by bisync.
7. **One universe, one tree.** The archive is built from the folder's
   effective filter universe, so what is published is exactly what sync will
   compare. Archiving raw source while sync filters a different set is
   structurally impossible here.
8. **Normal limits are not weakened.** A sync with a ready baseline keeps its
   fixed wall-clock timeout, its `--max-delete` threshold, and its plan review.
   The progress-aware deadline applies only to the explicitly identified
   first-run/initialize/seed cases.
9. **Nothing runs yet.** Execution is gated by explicit capability constants
   (`SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` **and**
   `SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED`); the API refuses with a reason and
   the UI disables the control.

## 6. Rollout plan

**Stage 0 — done, reviewed, corrected.**
Contract, schema + migration, server API, plan/preflight surface, explicit
source authority, job state machine + lease + progress, archive primitives
with fixture tests, progress-aware deadline wired into the daemon, UI panel +
help text, docs and skill reference. `POST /seed-jobs` returns 503; the UI's
Run control is disabled with the server's reason.

**Stage 1a — filter-aware archive construction (done).**
`packages/daemon/src/seed-filter-universe.ts` compiles the exact
`--filter-from` rule lines the executor writes into a `SeedSourceFilterUniverse`
with rclone's own semantics, and `buildSeedSourceManifest(assignment, type)` is
the single assignment → universe → manifest entry point. `buildSeedManifest`,
`createSeedArchive` and `seedPreflight` all require that universe; tar is given
the manifest's member list and nothing else; churn is measured inside the same
universe. Fixture-tested against the real Projects shape (nested `node_modules`
symlinks + ignored content) and cross-checked against the host's real rclone.
`SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED` is `true`; **execution is still
unavailable**, because the transport is not.

**Stage 1b — the transport (the one open prerequisite).**

Implement the S3 relay (upload to
   `lamasync/seed/<jobId>/…`, download on the target) behind the existing
   `SeedJob` state machine, with an integration test against a local
   object-store fixture. Keep `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` false until
   the *whole* pipeline (including the post-seed baseline validation) is
   proven end-to-end.

**Stage 2 — end-to-end fixture acceptance.**
A two-host fixture run through the real daemon: source archive → transport →
target staging → verify → atomic rename → bisync baseline validation reporting
zero content changes. Only then flip `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED`.

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
| Explicit source authority (request grammar, assignment check, freshness, persistence) | **implemented + tested** |
| `folder_seed_plans` / `folder_seed_jobs` schema + migration | **implemented** |
| Seed plan preflight API (read-only) | **implemented + tested** |
| Prerequisite list (6 gates, each with its own message) | **implemented + tested** |
| Seed job state machine, lease, progress, cancel, complete | **implemented + tested** |
| Archive create / validate / extract / verify / atomic publish, with the manifest↔archive equality guard | **implemented + fixture-tested end-to-end** |
| Filter-aware archive construction: rclone-equivalent rule compiler, universe builder, assignment → manifest entry point, tar fed the manifest's member list, churn measured inside the universe | **implemented + fixture-tested, cross-checked against the host's real rclone** |
| Progress-aware seed-stage deadline in the executor, scoped by `syncRunIsProgressAware` | **implemented + tested with real processes** |
| Web UI plan panel, source-device picker, prerequisites, phases, help text, disabled execution | **implemented + tested** |
| Upload/download of the archive to temporary seed space | **NOT implemented (Stage 1b — the one open prerequisite)** |
| Remote orchestration (which host runs which phase) | **NOT implemented** |
| Post-seed zero-change bisync validation as an automated gate | **designed, not implemented** |

Because the transport is not implemented, `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED`
is `false` (while `SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED` is now `true`),
`POST /seed-jobs` returns `503 { executionAvailable: false, reason }`, and the
UI shows a disabled control. **No folder can be seeded today**, and no live
archive transfer is claimed anywhere: Stage 1a made the *local* half of a seed
correct and provable, it did not make a seed runnable.

## 8. Changed files

Core
- `packages/core/src/folder-seed.ts` (new) — contract, source authority,
  filter universe, space math, staging policy, archive safety, prerequisites,
  phase machine, deadline decision, wire grammar.
- `packages/core/src/folder-seed.test.ts` (new).
- `packages/core/src/folder-health.ts` — `facts.archive` tooling block,
  `facts.seedStaging` staging proof, and `facts.filter.patternCount`.
- `packages/core/src/types.ts` — `seed_plan` / `seed_job` WS events.
- `packages/core/src/db/schema.ts` — `folder_seed_plans` (incl.
  `source_authority_host_id`, `source_authority`, `filter_universe`),
  `folder_seed_jobs` in `SERVER_SCHEMA` and `MIGRATIONS`.
- `packages/core/src/index.ts`, `packages/core/package.json` — export the new
  module (`@lamasync/core/folder-seed`).

Daemon
- `packages/daemon/src/seed-archive.ts` (new) — tooling detection,
  filter-aware manifest, create/list/validate/extract, manifest↔archive
  equality, verify, atomic publish, preflight. Stage 1a: tar is fed the
  manifest's member list (`--no-recursion --files-from`), empty directories are
  pruned, and churn is measured inside the universe.
- `packages/daemon/src/seed-archive.test.ts` (new).
- `packages/daemon/src/seed-filter-universe.ts` (new, Stage 1a) — the rclone
  `--filter-from` rule compiler, the universe builder, and the
  assignment → manifest entry point.
- `packages/daemon/src/seed-filter-universe.test.ts` (new, Stage 1a) — incl.
  the fidelity cross-check against the host's real rclone.
- `packages/daemon/src/seed-deadline.test.ts` (new) — plus
  `syncRunIsProgressAware` scope tests.
- `packages/daemon/src/executor.ts` — `ProcessWatchdog` /
  `superviseProcess` / `seedStageWatchdog` / `syncRunIsProgressAware`.
- `packages/daemon/src/folder-health.ts` — report archive tooling,
  `seedStagingProofFor`, and the countable `filter.patternCount`.

Server
- `packages/server/src/seed-jobs.ts` (new) — persistence + plan preflight with
  the explicit source authority.
- `packages/server/src/routes/folder-seed.ts` (new) — the REST surface.
- `packages/server/src/routes/folder-seed.test.ts` (new).
- `packages/server/src/seed-staging-facts.test.ts` (new) — fail-closed
  normalization of the device's staging proof.
- `packages/server/src/routes/folder-health.ts` — normalize `facts.archive`,
  `facts.seedStaging` and `facts.filter.patternCount`.
- `packages/server/src/routes/folders.ts` — delete seed artifacts with an
  assignment.
- `packages/server/src/auth.ts` — device allowlist for its own seed routes.
- `packages/server/src/app.ts`, `packages/server/src/index.ts` — compose the
  routes, declare the tag, sweep plans and stale jobs.

Web UI
- `packages/web-ui/src/folder-seed.ts` (new), `folder-seed.test.ts` (new).
- `packages/web-ui/src/components/FolderSeedPlanCard.tsx` (new),
  `FolderSeedPlanCard.test.tsx` (new) — includes the explicit source-device
  picker and the unmet-prerequisite list.
- `packages/web-ui/src/pages/Folders.tsx` — mount the panel with sibling
  records.
- `packages/web-ui/src/api.ts` — seed plan/job client methods
  (`createSeedPlan` now sends `sourceHostId`).
- `packages/web-ui/src/index.css` — panel styles.

Docs / skill
- `packages/agent-skill/reference/api.md` — every new route + the contract.
- `packages/agent-skill/reference/recipes.md` — the seed-plan recipe.
- `docs/handoff-346-initial-folder-seeding.md` (this file).
- `docs/status.md`, `docs/agent-start.md`, `docs/features.md`, `docs/README.md`.

## 9. Validation

```bash
bun x tsc --noEmit                      # clean
bun run build:web-ui                    # clean (one self-contained index.html)
bun test                                # 2426 pass / 0 fail, 166 files
bun run scripts/check-skill-drift.ts --strict   # OK (180 API rows, 181 routes)
```

Focused suites:

- `packages/core/src/folder-seed.test.ts` — **42 tests**: recommendation is
  never automatic, the source authority is required in the request grammar,
  space fails closed, the sibling + proven-filesystem staging policy, the phase
  machine, deadline continue/stall/hard-cap, plan validity (incl. unusable
  authority, unwired filter-aware archiving, filter mismatch, unknown
  filesystem), the prerequisite list, and the execution capability.
- `packages/daemon/src/seed-filter-universe.test.ts` — **25 tests**: the rule
  parser (comments, the mandatory single space, a trailing `;` staying in the
  pattern, a malformed regex refused), the glob translation, the semantics
  table in §2.4, the exact rule lines an assignment produces
  (`ignoreGitMetadata` and `respectGitignore` ordering), the Projects-shaped
  fixture (pruned subtree ⇒ no symlink in the manifest; a filter-**included**
  symlink ⇒ fail closed; the archive's member set equals the manifest's), the
  single entry point's four fail-closed paths, and **a fidelity cross-check
  against the host's real `rclone lsf --filter-from` over 22 rule sets**
  (skipped when rclone is not on PATH).
- `packages/daemon/src/seed-archive.test.ts` — **33 tests**: real GNU tar for
  both `tar.zstd` and `tar.gz` — create → validate → extract → verify
  byte-for-byte → atomic rename, mtime preservation, traversal/symlink/churn/
  corruption refusals, non-empty target refusal, preflight, and the fail-closed
  set: **create refuses a symlink in the universe before tar runs** (runner spy
  asserts tar was never invoked and no archive exists), **the archive never
  contains content the universe excludes** (`node_modules` with a symlink
  inside it), **the member list is removed on success and failure**, **create
  refuses an archive missing a manifest member** and **one carrying content the
  manifest does not describe** (both by rewriting the member list under real
  tar, and both delete the archive), **churn OUTSIDE the universe does not fail
  the archive**, plus the `/data/elsewhere` rejection.
- `packages/daemon/src/seed-deadline.test.ts` — **11 tests** against real child
  processes: fixed timeout still kills an ordinary run, a progressing stage
  survives past the nominal timeout, a stall is killed, progress resets the
  budget, the hard cap bounds a chatty stage, and the scope rule (ready
  baseline ⇒ fixed; first run ⇒ progress-aware).
- `packages/daemon/src/folder-health.test.ts` — **24 tests**, incl. the
  target's own staging proof (proved / unreadable ⇒ unknown / relative path ⇒
  no proof), the heartbeat carrying both new fact blocks, and the countable
  `filter.patternCount` floor.
- `packages/server/src/routes/folder-seed.test.ts` — **17 tests**: admin-only
  plan creation, mandatory `confirm`, mandatory `sourceHostId`, self-seed and
  unassigned-source refusals, stale measurement not usable, plan built from
  reported facts, unproven filesystem not runnable, filter mismatch refused,
  gzip fallback, list/read validity, explicit 503 execution refusal with no
  job row, legal/illegal phase transitions, host scoping, idempotent
  completion, admin-only cancel, stale-lease reaping.
- `packages/server/src/seed-staging-facts.test.ts` — **4 tests**: the device's
  staging proof normalizes fail-closed (absent/malformed ⇒ null; a
  truthy-but-not-`true` verdict ⇒ unproven; unparsable numbers dropped).
- `packages/web-ui/src/folder-seed.test.ts` +
  `components/FolderSeedPlanCard.test.tsx` — **35 tests**: recommendation
  wording, source-authority wording, source-device candidates (the target is
  never offered; unmeasured/stale/empty are refused with reasons), unmet
  prerequisites, space/archive/staging wording, no invented tooling claims,
  disabled execution, plain-language phases, progress with only known totals,
  and the precise timeout-scope copy.

## 10. Remaining live validation (owner / later stage)

1. **Stage 1b:** implement and fixture-test the archive transport before any
   live run — the one open prerequisite.
2. Two-host end-to-end fixture acceptance with a zero-change baseline
   validation (stage 2).
3. A live dev-vm-shape run on a **copy** of a large tree, confirming no
   timeout kill while progressing and a correct resume after a deliberate
   stall (stage 3).
4. Confirm the target's archive tooling *and* staging proof are reported before
   the Run control is enabled for that device.
5. Decide the retention/cleanup policy for `lamasync/seed/…` objects after a
   successful or abandoned job.

Stage 1a is done: the local half of a seed is correct and provable, and the
plan's remaining gate is the transport alone.
