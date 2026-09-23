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
- The archive preserves **mtimes**. This is load-bearing, and measured rather
  than assumed (Stage 2a): bisync compares size + modtime, so an archive that
  reset mtimes makes it report every file as `File changed: time` instead of a
  clean "no changes" baseline. With a whole tree of changed mtimes bisync's own
  safety check aborts the run ("Safety abort: all files were changed on
  Path2"). Note what it does *not* necessarily do: re-transfer the bytes — it
  re-checks content and can report "nothing to transfer" — which is exactly why
  the acceptance assertion is "no file is reported as changed", not merely "no
  bytes moved".
- Extraction uses `--no-same-owner --no-same-permissions --no-overwrite-dir`,
  so no ownership or setuid bit from an untrusted archive is ever applied.

### 2.6 The pipeline and the manifest↔archive contract

```
effective filter universe of the source tree
  → manifest (path, kind, size, mtime, SHA-256) + stats fingerprint + filter identity
  → [refuse if any included member is not representable, or its name is one tar
     escapes in a listing]                                    ← BEFORE tar
  → tar + zstd|gzip over a NUL-separated member-name list
    (--no-recursion --verbatim-files-from --null --files-from;
     verbose output = measurable progress)
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
   `tar --create --directory <root> --no-recursion --verbatim-files-from
   --null --files-from <member list>`, where the member list is exactly
   `manifest.entries`, NUL-separated. The old `--directory root .` form
   archived the whole raw tree, so a *filtered* folder could never produce a
   matching archive at all. `--no-recursion` is what makes the list
   authoritative, and the two list-reading flags are what make a list line a
   NAME rather than an option (see §2.6.1);
3. **after tar** — the produced archive's member set must equal the manifest's
   (normalizing tar's `./` prefix and directory trailing slashes, ignoring the
   archive root). A mismatch in either direction deletes the archive and fails
   with "content the manifest does not describe" / "content the manifest
   requires but the archive lacks". Both directions are tested by rewriting the
   member list under a real tar.

Source churn is measured **within the same universe** (`buildStatsFingerprint`
takes the filter), so a change to excluded content can neither fail the run nor
mask a change to included content.

#### 2.6.1 The member list is names, never options

A file name may legally begin with `-`. GNU tar parses a `--files-from` line
beginning with `-` as an **option** unless it is told otherwise, and the set of
options it honours from a list is version- and build-dependent. Measured on GNU
tar 1.35, a file named `--directory=sub` really did change tar's working
directory mid-archive, which would silently archive the wrong tree; the review
flagged the `--checkpoint-action` class, which other builds may honour.

Two independent defences, both tested against the real tar on the host:

1. **The list is read as names.** `--verbatim-files-from` and `--null` are
   passed **before** `--files-from` (they only affect *subsequent* list
   options — order is load-bearing, and verified: putting
   `--verbatim-files-from` after `--files-from` does not help), and the list is
   **NUL-separated**. NUL is the one byte a path cannot contain, so this is the
   only encoding that can represent every legal name, and no name can be
   truncated or split.
2. **A name tar would escape in its listing is refused before tar.**
   `seedSourcePathUnsafeReason` rejects a control character (`0x00`–`0x1F`,
   `0x7F`) or a backslash, because tar writes `\n`, `\001` and `\\` in its
   `--verbose` listing: the archive would hold the real name while the listing
   reports an escaped one, so the manifest↔archive equality guard could never
   match. The refusal names the member and says what to do. A directory whose
   *own* name is unsafe is refused as a whole and not even walked.

Everything else a legal POSIX name can contain is **supported**: spaces,
quotes, a trailing space, and a leading dash. The round trip is tested
end-to-end for `--checkpoint=1`, `--checkpoint-action=exec=touch PWNED`,
`--directory=sub`, `-Csub`, `--null`, `--verbatim-files-from` and
`--file=EVIL.tar` as *file names*: the archive's member set equals the
manifest's, nothing is executed anywhere, and extract → verify → publish
preserves them byte for byte.

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

### 2.10 The temporary object-storage relay — Stage 1b foundation

A seed archive is **transport, not data**. It lives in a dedicated, temporary
namespace, it is deletable at any time, and deleting the namespace can never
touch a user's files.

```
lamasync/seed/<jobId>/payload.tar.zst      ← one object, one job
lamasync/seed/<jobId>/payload.tar.gz
```

The contract is `@lamasync/core/seed-relay` (dependency-free, no credentials),
implemented by `packages/daemon/src/seed-relay-local.ts` and driven by
`packages/daemon/src/seed-transport.ts`.

#### Key validation and prefix containment — lexical AND actual

Every key is validated with `validateSeedRelayObjectKey` **before any store
call** — including the keys being *deleted*, because "delete the key the job
reports" must never be a way to delete something else:

| Rule | Why |
|---|---|
| no absolute path, Windows drive, backslash or control character | one shape, one namespace |
| no empty segment, no `.`/`..` segment | traversal is refused, never normalised |
| must be inside `lamasync/seed/` and exactly `lamasync/seed/<jobId>/<name>` | prefix containment |
| the `<jobId>` segment must be a single safe segment | a job id cannot become a second path component |
| the key must belong to the job being operated on | a job cannot read or delete another job's object |
| the resolved path must still be inside the store root | belt and braces behind the key check |

List prefixes have their own validator (`validateSeedRelayPrefix`): a prefix may
be a namespace but must still be inside `lamasync/seed/`, so a sweep cannot walk
out of it.

**A lexically valid key is not containment.** `resolve()` never touches the
filesystem, so `root/lamasync/seed/<jobId>` can itself BE a symlink to an
outside directory while the key looks perfect — and before this correction
`put` created, `head` stat'd, `get` read and `delete` **removed** a file outside
the relay root through exactly that link (reproduced, then fixed).

`checkSeedRelayObjectContainment` therefore adds an **actual-filesystem** check
that every store call runs first: each EXISTING path component below the root is
`lstat`-ed and must be a real directory (or, for the final component, a real
regular file). A symlink anywhere in the chain is refused and never followed.
The digest sidecar is checked the same way, because it is written, read and
unlinked like the object; the relay's working directory is checked too, since a
symlinked staging area would move the write outside as well.

`list` never follows a link either: a symlink is not an object, so it is not
returned as a key and is **not descended into**. Anything it refused to follow
is reported in `skippedSymlinks` rather than dropped silently, so a sweep can
surface a planted link as a finding instead of walking past it — and
`seedRelayOrphanKeys` never treats one as an orphan.

#### Race limits, stated rather than hidden

The containment check is not atomic with the operation it guards: an attacker
who can write to the relay root could swap a verified directory for a symlink in
the window between the two. Closing that completely needs directory-fd APIs
(`openat`/`O_NOFOLLOW`/`openat2(RESOLVE_NO_SYMLINKS)`) that neither Node nor Bun
exposes, so the exposure is bounded by ownership and by each operation's shape:

* the relay root is a daemon-owned directory — never a user's synced tree and
  never inside one;
* one writer per job (the job lease), and object keys are per-job;
* `put` publishes with an atomic rename, which REPLACES a symlink at the final
  component instead of writing through it;
* `delete` unlinks the final component itself, so a symlink there is removed
  rather than followed.

What the check removes is the class that matters: a planted symlink silently
redirecting a seed's read, write or delete outside the relay root.

#### Immutable archive metadata

`SeedArchiveMetadata` is produced **once**, by the source, from the archive it
just wrote, and every later step *compares* against it:

```
{ jobId, objectKey, format, bytes, sha256, manifestFingerprint, memberCount, createdAt }
```

It is carried on the job as `SeedJobArchiveFacts` — a field of the existing
`folder_seed_jobs.archive` JSON column, **not** a parallel table — together with
`uploadedAt`, `verifiedAt` and the cleanup state. A malformed or partial row
normalizes fail-closed (`normalizeSeedJobArchiveFacts`): missing fields become
`null`, and the transport then refuses to download rather than trusting a shape
it cannot verify against.

#### Upload, download, verification

```
source:  archive on disk → hash locally → put (store verifies while streaming)
           → head read-back must match → metadata recorded
target:  metadata from the job → get into a target path
           → RE-HASH the bytes on disk → compare → only then may anything extract
```

Both hops verify against a digest this code computed from bytes it actually
moved. A store's own report is never evidence: `get` re-hashes the downloaded
file, and `head` is only used to confirm the store kept what was sent. A failure
deletes what it created — a failed upload leaves no object, a failed download
leaves no file — so nothing partial can be mistaken for an archive.

#### Cleanup and retention (the policy decision)

| Situation | Policy |
|---|---|
| job reached a terminal phase | its objects are deleted — a seed archive has no value once the tree is published |
| a cleanup pass fails | recorded as `failed` with a bounded reason and an attempt count; the next pass retries and finishes it |
| the object is already gone | **success**, which is what makes cleanup idempotent and re-runnable |
| a job row is gone (or unknown) | objects are reaped after `SEED_RELAY_ABANDONED_RETENTION_MS` (24 h) measured from `storedAt` |
| the object's age is unknown | left alone — never delete on a guess |
| a key is outside the seed namespace | reported, never deleted |

Cleanup never throws: it runs on the failure path too, where an exception would
mask the original error, and a store that throws is recorded as a failed attempt
rather than propagated.

#### What is deliberately NOT here

* **No configured S3 backend, no rclone remote, no live host.** The store
  interface has no endpoint, bucket, key or secret parameter; the only
  implementation is a local directory, which is also the integration-test
  fixture. Nothing in this slice reads a backend configuration.
* **No credentials in any API, log line or stored value.** `describeSeedRelayFailure`
  names the store *type* (`local-fs`) and never its location; the archive facts
  have a fixed field set, pinned by test.
* **No phase invention.** The transport names the phase each step belongs to and
  defers to the job state machine's own `canTransitionSeedPhase`
  (`seedTransportPhaseAllowed`), so a step cannot skip a phase or run on a job
  that already ended.
* **No live seed.** `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` stays `false`,
  `POST /seed-jobs` still returns 503, the UI control is still disabled, and
  `seed-transport-bounded.test.ts` reads the module graph to assert that no
  production module imports the transport yet.

### 2.11 Stage 2a — the disposable two-host end-to-end proof harness

`packages/daemon/src/seed-e2e.test.ts` is the automated acceptance proof that a
seed produces a tree a real bisync accepts as a valid baseline. It is **not a
deployment**: it runs entirely inside one `mkdtemp` sandbox, with two
daemon-shaped identities (their own roots, their own ignore rules, their own
bisync state dirs), a test-only local object store, and **no configured
backend, credential, rclone config, dev-vm, production service or real folder**.

The pipeline it drives, in order:

| Step | What runs | What it proves |
|---|---|---|
| 1. source | `buildSeedFilterUniverse` → `buildSeedSourceManifest` → `createSeedArchive` (real GNU tar) | the archive is built from the folder's effective filter universe, and its member set equals the manifest's |
| 2. relay | `uploadSeedArchive` → `downloadSeedArchive` through a local object store | the upload is hash-verified and read back; the download is **re-hashed on disk** before anything may extract |
| 3. target | `extractSeedArchive` → `verifyExtractedTree` → `publishStagedTree` into an **empty** sibling target | the published tree is exactly the source universe, mtimes included, via one atomic rename |
| 4. acceptance | real `rclone bisync --resync` over the SAME `--filter-from` rules | **zero files reported as changed** — the seed, not a sync, established the baseline — then normal edits flow both ways and ignored content never moves |

The fixture is the real Projects shape: 180 source files across nested modules,
a 64 KiB and a 32 KiB binary blob, an ignored `node_modules` **holding symlinks**
(plus a nested `worktrees/feature-x/node_modules` symlink, as in the real tree),
`.git` metadata, an ignored `*.log` and an ignored `tmp/` directory, and a pinned
`mtime`.

#### The acceptance assertion is "no file changed", not "no bytes moved"

Measured, not assumed: bisync compares size + modtime, so a seed that reset
mtimes makes it print `File changed: time` for every file and then re-check
content — reporting "nothing to transfer" while still not being a clean
baseline. With a whole tree of changed mtimes its own safety check aborts the
run outright ("Safety abort: all files were changed on Path2"). The harness
therefore asserts on the **change report**, and a paired sensitivity test proves
that assertion is load-bearing: with content byte-identical and only one
target-side mtime drifted, bisync *does* report `File changed: time`.

#### Anti-vacuity

A second, separate pair of roots proves the zero-transfer result is not an
artefact of bisync ignoring everything: an ignored subtree that exists only on
the source is invisible **with** the seed's filters and visible **without** them.
That is precisely the difference a mismatched universe would produce after every
seed, and it is why the seed and the sync must compile the same rule lines.

#### Failure cases the harness drives

| Case | Assertion |
|---|---|
| insufficient **target** space | the space plan is not `ok`, and the `target_space` prerequisite is unmet through the real gate — nothing is staged |
| unknown free space | fails closed rather than assuming |
| insufficient **source** space | an unwritable archive destination returns a **failed result** (not a thrown `EACCES`) and leaves no archive or member list behind |
| hash mismatch, stored object tampered | the download is refused with the SHA-256 reason and the file is deleted |
| hash mismatch, store **lies** about what it downloaded | caught by this module's own re-hash on disk — a store's report is never evidence |
| stalled progress | the upload's own progress ticks keep a slow stage alive past the nominal timeout, while a stall fails with `stalled` and a chatty stage is bounded by `hard_cap` |
| non-empty target | `publishStagedTree` refuses, the operator's file is untouched and the staging tree is **not** merged in |
| filter-included symlink | blocks before tar, with no archive produced |
| the plan gate | a fully-consistent plan is still **not runnable** while the transport is unwired |

#### Gating, and the host proof that is still required

The seed-pipeline half always runs. The bisync acceptance needs a real rclone, so
it is gated on `Bun.which("rclone")` and force-skipped by `LAMASYNC_TEST_RCLONE=1`
(the repo's existing hermetic-CI convention). A dedicated test named *"the
bisync gate is explicit, not silent"* runs either way, so a skipped acceptance is
visible in the output rather than implied.

**What the harness does NOT prove, and what a host must still show:**

1. **A real two-machine hop.** The relay here is a local object store. A host
   proof must run the same pipeline with a real temporary object space between
   two machines, including the network failure modes (partial upload, retry,
   resume) that a local store cannot produce.
2. **Real disk-full behaviour.** Insufficient space is proven at the plan gate
   and by an unwritable destination. A true ENOSPC mid-archive needs a small
   filesystem or a quota on the source, and a target squeezed below the
   reservation needs a real target volume.
3. **The real daemon orchestration.** Nothing here drives `POST /seed-jobs`, the
   job lease, the phase reports or the WebSocket events end to end; that wiring
   is exactly what Stage 1b still owes, and it must not be flipped on until it
   exists.
4. **A live dev-vm-shape run** on a **copy** of a large tree: no timeout kill
   while progressing, one correct resume after a deliberate stall, and a
   zero-change baseline afterwards (stage 3).
5. **Concurrency and retention under load:** two jobs at once, a job abandoned
   mid-transfer, and the abandoned-object sweep running against a real store.

### 2.12 Stage 2b — test-only job orchestration (the lifecycle proof)

`packages/server/src/seed-coordinator.ts` drives ONE seed job through the
**existing** job state machine. It invents no parallel state: the phases, the
progress records, the renewable lease, the terminal outcomes and the archive
facts are the ones `seed-jobs.ts` and `folder-seed.ts` already define, and the
`folder_seed_jobs` schema is untouched (a test asserts the exact column set).

It exists to close the orchestration gap Stage 2a left open. Stage 2a proved the
daemon-side primitives compose; this proves the **lifecycle** around them is
legal and safe.

#### What it drives

| Step | Contract it uses | What it guarantees |
|---|---|---|
| claim | report `preflight` progress as this owner | the lease is set and the job flips to `running` exactly as the device route does |
| source | injected side: measure → archive → upload | each phase is entered through `canTransitionSeedPhase`; the returned archive facts are persisted with `updateSeedJobArchive` **before** the target may run |
| target | injected side: download → verify → extract → verify → publish → baseline | the target verifies against the recorded digest, and the published tree is checked against the source manifest |
| terminal | `finishSeedJob` (idempotent) | `completed` **only** with a passing baseline verdict; otherwise `failed` with a bounded reason |
| cleanup | the injected idempotent cleanup step | the relay object is removed and the cleanup state recorded on the job, in every terminal case |

#### The safety properties, each with a test

* **One phase at a time.** A side that asks for an illegal transition is
  refused, and the refusal is *latched*: a buggy side that ignores it and
  reports success still cannot walk the job to `completed`.
* **The lease is renewed while work runs.** Every phase entry and progress
  report renews it, so a long phase is never reclaimed from a live owner; it is
  released when the job ends. A monotonic fake clock makes the renewal
  observable in the test.
* **Progress is bounded and never invents a total.** Byte and entry counts are
  non-negative integers; a total is present only when the phase knew one.
* **A cancellation is the operator's.** When the cancel route lands mid-run the
  job stays `cancelled` with the operator's own summary, and the coordinator
  does not overwrite it.
* **A lost lease stops the work.** A job another owner already ended is left
  alone: the coordinator only reports `completed`/`failed`/`cancelled` for
  outcomes IT produced, and reports `lease_lost` otherwise. No terminal state is
  written by an owner that no longer holds the job.
* **Cleanup is idempotent and never masks the outcome.** A store that fails once
  is recorded as a retryable `failed` cleanup state while the job still
  completes; a retry finishes it.
* **A source or target failure publishes nothing.** No archive facts, an empty
  target tree, and the object cleaned up.
* **A seed is not "done" without the zero-change verdict.** A target that
  reports success without a passing baseline fails the job — the publish may
  have happened, and the job still fails.

#### Test-only, asserted from the module graph

`seed-coordinator-bounded.test.ts` reads the source to assert that **no
production module imports the coordinator**, that its code carries no
credential, endpoint, bucket or rclone surface (comments stripped, so prose
cannot satisfy or break the check), that execution is still unavailable, and
that it invents no phase. `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` stays `false` and
`POST /seed-jobs` still returns 503.

#### 2.12.1 Review correction — the claim was last-writer-wins (fixed)

Review found a real defect in the first Stage 2b cut, and it was the worst kind:
the coordinator could **steal a job from a live owner**.

`updateSeedJobProgress` (the device route's helper) updates any `planned`/`running`
row with **no lease-owner predicate**, and it returns `getSeedJob(...)`
unconditionally — so it returns a job even when the `UPDATE` changed **zero
rows**. The coordinator's claim used it, so:

* owner B's claim silently overwrote owner A's live lease (`lease_owner` → B);
* `owned()` then answered `true` for B, because it only compared the owner string;
* B walked the job to a terminal state and wrote **its own** error over A's run;
* the `claimed === null` guard was unreachable, so the "another owner holds it"
  branch could never fire;
* `owned()` also treated a null owner as claimable and never consulted
  `lease_expires_at`, so an expired lease blocked every later owner until the
  reaper happened to run.

Reproduced before fixing (SQL level, then coordinator level): after A claimed, a
claim by B returned a job with `lease_owner = host-B`; B's `finishSeedJob` wrote
`completed / stolen`; and a contender's run recorded *its* error where A's
outcome belonged.

**The fix — atomic conditional writes, not a check-then-write.**

`packages/server/src/seed-jobs.ts` gains an ownership-conditional family, and
`packages/core/src/folder-seed.ts` gains the pure rules they encode
(`seedLeaseIsLive`, `seedJobClaimableBy`, `seedCleanupAllowed`):

| Helper | Guard |
|---|---|
| `claimSeedJobProgress` | claimable per `seedJobClaimableBy`: unowned, ours-and-live, or a lease that has demonstrably lapsed |
| `reportOwnedSeedJobProgress` | `status='running'` AND `lease_owner = me` AND `lease_expires_at > now` |
| `finishOwnedSeedJob` | the same live-lease requirement — a coordinator that lost the job cannot write its outcome |

Each decides **in the `WHERE` clause**, so the check and the write are one atomic
statement, and each returns `null` when the statement changed **zero rows**,
reading the row back only after success. A refusal is therefore impossible to
mistake for a success.

Consequences that are now enforced:

* a live owner's job cannot be claimed by a contender (it is told so);
* an **expired** lease *is* claimable, and a recorded owner with **no** expiry is
  not (we cannot tell whether that owner is alive, so we fail closed and leave it
  to the reaper);
* a coordinator whose own lease lapsed stops reporting and reports `lease_lost`
  rather than the outcome it intended — including on the failure path, where
  "failed" would be a claim it can no longer make;
* `owned()` requires a **live** lease of ours, not merely a matching string.

**Cleanup is gated too.** `cleanupJobObjects` now takes the asking `owner` and
refuses via `seedCleanupAllowed`: a terminal job is nobody's and its objects are
done with, but while a job is in flight only a live owner may delete. A
contender that merely lost a race leaves the relay untouched and records **no**
cleanup state, because nothing was cleaned.

**Two completion gates.** A passing baseline is a claim; the coordinator now
requires the evidence:

1. **every** phase in `SEED_COORDINATOR_PHASES` must have been entered and
   persisted — a target that returns a passing verdict without entering a single
   phase fails the job;
2. archive facts must have been **persisted** (a non-null stored digest), not
   merely returned in memory — and a source that reports success with no archive
   facts fails *before* the target starts, so no target work happens on an
   archive nothing recorded.

**Route behavior is unchanged, deliberately.** The device routes keep using the
last-writer-wins helpers; `seed-jobs.ts` is purely additive (0 deletions) and
`routes/folder-seed.ts` is untouched. Making the shared helpers conditional would
have silently changed a live contract — a device whose lease lapsed could no
longer re-report — so the coordinator got its own family instead. The cost is two
families of writers, which is why `seed-coordinator-bounded.test.ts` now asserts
the coordinator imports **only** the conditional one and never calls
`updateSeedJobProgress(`, `finishSeedJob(` or `renewSeedJobLease(`.

**Load-bearing, verified by reverting:** removing the ownership predicates fails
12 coordinator tests; removing the completion gates fails 3; removing the cleanup
gate fails the in-flight-object test. New coverage: 6 adversarial tests in
`seed-coordinator.test.ts` (an active delayed owner vs a contender, a crashed
owner's expired lease vs a live one, a self-expiring owner, the three conditional
helpers against a wrong owner, a lapsed-lease finish, and the in-flight object),
3 evidence tests, and 4 pure-rule tests in `packages/core/src/folder-seed.test.ts`.

#### 2.12.2 Second review — two remaining ownership gaps (fixed)

The §2.12.1 correction made the **outcome** write conditional. Two paths were
still unguarded, and both were reproduced before being fixed.

**(1) The in-flight archive write was unguarded.** `updateSeedJobArchive` is
deliberately status-blind (the cleanup state is written after the job ends), and
the coordinator used it for the transport facts too — *after* an awaited
source/target side returned. So a run whose lease lapsed during a long phase
could overwrite the facts of the owner that had taken the job over. Reproduced:
A stalled inside its source side, A's lease lapsed, B claimed and recorded
`bbbb…/999 bytes`, then A returned and the row read **`aaaa…/111 bytes` with
`lease_owner = host-B`** — A had corrupted the new owner's verification
authority, the one thing the target extracts against.

*Fix:* `updateOwnedSeedJobArchive` — the same live-lease predicate as the outcome
write, `null` on a zero-row write. A refusal means the lease is gone, so the
coordinator sets `leaseLost`, does not run the target, and does not let a
baseline verdict complete the job. The **unguarded** write survives for exactly
one caller, `cleanupJobObjects`, which records the cleanup state after the job
has ended — and which now re-reads the row and only ever sets the `cleanup`
field, so a caller's in-memory facts can never be written back. That closes the
same leak on the cleanup path by construction rather than by care.
`seed-coordinator-bounded.test.ts` asserts `updateSeedJobArchive(` appears
**exactly once** in the coordinator, in cleanup.

**(2) A live lease could be claimed by the same owner.** `seedJobClaimableBy`
allowed `lease_owner = me` while the lease was live, reading as a renewal — but
`owner` is a **host id**, not a run id, and `runSeedJob` always rewinds to
`preflight`. Reproduced: a second invocation with the **same owner string**
claimed a live job, saw itself as owner, reset the phase to `preflight`, ran
concurrent work, and wrote its own error over the first run's outcome.

*Fix:* a **live lease is never claimable — not even the caller's own.** Renewal
is `reportOwnedSeedJobProgress`, which needs no claim; a new run claims exactly
once. The residual risk is the lease's whole premise and is documented rather
than hidden: a run that is merely *slow* past its lease can be taken over, which
is what makes the window a crash detector. The recovery path is kept working and
tested: the same host **may** take over once the lease has demonstrably lapsed
(and the reaper's contract is unchanged).

Two gaps that remain by design, and are recorded so nobody assumes otherwise: the
cleanup write stays unguarded (post-terminal by definition), and a takeover is
still possible after a lapse — the lease, not the owner string, is the boundary.

New coverage: a **stalled source A returning late** after B took the job (B's
facts, progress, owner and outcome all survive; A's in-flight object is not
deleted), a **late write against an already-ended job**, a **second run from the
same host** refused with nothing run, and a **same-host takeover after a lapse**
that still works. Load-bearing by reverting: restoring the unguarded write fails
the late-A test; restoring the same-owner claim fails the concurrent-same-host
test and the core rule test.

#### What Stage 2b does NOT do, and what is still owed

1. **No resume.** A failed job is not restarted from its persisted phase; the
   phase is recorded so a later slice can.
2. **No scheduling, no WebSocket broadcast, no route.** The server routes remain
   the only production surface, and they are unchanged.
3. **The manifest does not travel.** In the proof the two sides share the
   manifest inside one test process, because today nothing sends it to the
   target. A production target verifies the *archive* (member set + digest) and
   the extracted tree against that; making the source manifest available to the
   target is a real design gap this slice surfaces rather than hides.
4. **No real store, no second machine, no live folder.** The relay store is
   injected and local; the host proofs in §2.11 still apply.

### 2.13 Stage 2c — the real network vertical path (first slice, done)

Stage 2b left two things undone that this slice closes, and the work order
named them: a **real temporary object space** (not two directories on one host)
and the **manifest handoff** (the target must independently know the source
universe). Both are now implemented and proven by an automated, repeatable,
fully isolated run.

#### The real store

`packages/daemon/src/seed-relay-s3.ts` is a real S3-compatible relay store: the
same `SeedRelayStore` the local fixture implements, backed by an HTTP object
space (MinIO in the harness). It is dependency-free (SigV4 implemented locally
over `fetch`; no SDK), and it keeps every contract point the transport depends
on:

| Contract point | How the S3 store keeps it |
|---|---|
| immutability | `put` heads the key first; a differing object is refused, a byte-identical re-put is an idempotent success |
| digest as object metadata | the SHA-256 is written as `x-amz-meta-sha256` and read back by `head`, because S3's ETag is MD5 and the transport needs a real digest |
| streaming verification | `put` hashes the source before sending; `get` hashes while it writes and deletes a partial or wrong download |
| abort safety | the caller's `AbortSignal` reaches the request, and a failed/cancelled PUT best-effort deletes the key so nothing is left to find |
| idempotent delete | a HEAD first makes `alreadyAbsent` truthful (S3 answers 204 either way) |
| namespace containment | every key/prefix is validated before a request is built; a key outside `lamasync/seed/` never reaches the endpoint |

It is **test-only**: `seed-relay-s3-bounded.test.ts` reads the module graph and
asserts that no production module imports it and that only this file combines
the seed transport with credential-shaped fields. `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED`
stays `false`.

#### The manifest handoff

The gap §2.12 recorded is closed at the contract and transport level:

* `@lamasync/core/seed-relay` gains the manifest object key
  (`lamasync/seed/<jobId>/manifest.json`), a canonical `SeedManifestDocument`,
  the **shared digest-input description**
  (`seedManifestContentDigestInput`: `path\0kind\0size\0sha256-or-dash\n`),
  fail-closed document parsing/validation, and `SeedManifestMetadata`.
* `SeedJobArchiveFacts` gains `manifestObjectKey`, `manifestBytes` and
  `manifestSha256` — additive fields in the existing JSON column, no table and
  no migration, normalized fail-closed to `null` for older rows.
* `seed-transport.ts` gains `uploadSeedManifest` (validate, serialize, digest,
  put, read back) and `downloadSeedManifest`, which performs three independent
  checks and refuses on any failure: the bytes on disk must hash to the
  recorded digest, the document must validate, and the fingerprint
  **re-derived from the received entries** must equal both the document's own
  fingerprint and the recorded `manifestFingerprint`.

A dedicated test pins the re-derivation against a real `buildSeedManifest`
result, so the two descriptions of the algorithm cannot drift.

#### The two-process end-to-end run

`scripts/lama346-seed-e2e.ts` is the acceptance proof, and it is not a
deployment. It runs entirely inside one `mkdtemp` sandbox:

| Piece | What it is |
|---|---|
| server | a real isolated server on a random loopback port, its own SQLite file and `HOME`, started with the doubly-gated `LAMASYNC_SEED_E2E=1` **and** `LAMASYNC_TEST=1` seam |
| object space | a disposable MinIO container on a random loopback port; the bucket is created by the harness |
| workers | **two independent OS processes** (`scripts/lama346-seed-worker.ts`, one SOURCE, one TARGET) that communicate only through the real HTTP job API and the object space |
| sync engine | a real `rclone bisync --resync` over the same `--filter-from` rules the seed used |

What it asserts (32 checks pass, 0 fail on this host):

* the source plan and job are created through the real admin API; the source
  builds the effective-filter manifest, archives with real GNU tar, uploads the
  archive **and the manifest** through the S3 store, and records the immutable
  facts through `POST /seed-jobs/:jobId/archive`;
* the target independently downloads, re-hashes and re-derives the manifest
  fingerprint, extracts into a sibling staging directory, verifies the tree
  against the transported manifest, publishes with one atomic rename, and
  reports `completed`;
* the published target holds **exactly** the source universe, ignored content
  never arrives, and the harness re-verifies the tree against a manifest it
  rebuilds itself;
* `bisync --resync` reports **zero changed files** (`totalTransfers=0`,
  `bytes=0`, no `File changed`, no `Safety abort`), a second run is a no-op, a
  source edit and a target edit each propagate, and ignored content still never
  moves;
* the terminal job's relay objects are gone, an abandoned object is detected as
  an orphan and swept, and the namespace is empty afterwards;
* a **manifest-fingerprint mismatch** fails the job with the manifest reason and
  still cleans up; a **non-empty target** refuses publication and fails the job;
  an **operator cancellation** is terminal and not overwritten; an **aborted
  upload** fails and leaves no object behind.

Run it with:

```bash
bun run scripts/lama346-seed-e2e.ts --json /tmp/lama346-e2e.json
```

#### The test-only seam, stated exactly

`SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` is still `false`. The harness opens job
creation and archive-fact recording only when **both** `LAMASYNC_SEED_E2E=1`
and `LAMASYNC_TEST=1` are set; either variable alone changes nothing, and
`seed-e2e-seam.test.ts` pins that. Opening the seam does not wire a store or an
executor into the server: no production module imports the coordinator, the S3
store or the seed sides, and no daemon polls for seed work. Without the seam
`POST /seed-jobs` still answers 503, unchanged.

#### What this slice does NOT prove

Reported as GATED by the harness, never as a pass:

1. **A real two-MACHINE hop.** The two workers are two processes on one host
   with one object space. Network partition, retry/resume and a genuinely
   remote store remain host proofs.
2. **Real ENOSPC on a bounded disposable volume.** No bounded volume is
   available without root/mount privileges here; the space plan gate and an
   unwritable destination are still the only disk-full evidence.
3. **The live dev-vm-shape run** on a copy of a large tree (stage 3).

Two design gaps this slice surfaces rather than hides, both required before the
gate may flip:

* **One job, two hosts, one lease.** The seed job's `hostId` is the TARGET, and
  the device routes authorize only that host; the source worker therefore used
  the harness's master key. Production remote orchestration needs the source
  host to be authorized (or an explicit delegation), and the single
  last-writer-wins lease cannot distinguish the two roles. The E2E uses the
  existing unguarded device helpers deliberately; the coordinator's
  ownership-conditional family is unchanged and still the server-side contract.
* **The production daemon action loop does not dispatch seed work.** The workers
  are daemon-shaped test processes, not `lamasyncd`. Wiring a seed action into
  the shipped daemon is a separate, reviewable change.

Only when both are resolved, and the §2.11 host proofs (two machines, real
ENOSPC, a live large-tree run) are on record, may
`SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` flip.

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

**Stage 1b — the transport (foundation done, wiring open).**

Done: the relay CONTRACT (`@lamasync/core/seed-relay`), the local object store
that is also the integration fixture (`seed-relay-local.ts`), and the
upload/download/cleanup orchestration with verification at both hops
(`seed-transport.ts`), all tested end to end against each other. The
retention/cleanup policy is decided (see §2.10).

Still open, and the reason `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` stays `false`:
wiring a real store and the job/daemon orchestration that calls it. Implement
the S3 relay (upload to
   `lamasync/seed/<jobId>/…`, download on the target) behind the existing
   `SeedJob` state machine, with an integration test against a local
   object-store fixture. Keep `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` false until
   the *whole* pipeline (including the post-seed baseline validation) is
   proven end-to-end.

**Stage 2a — the disposable two-host proof (done).**
`packages/daemon/src/seed-e2e.test.ts` drives source archive → local-store relay
→ target staging → verify → atomic rename → a **real** `rclone bisync --resync`
that reports zero files changed, then bidirectional edits and ignored-content
checks, with the failure cases in §2.11. It is gated on rclone and explicitly
skipped without it.

**Stage 2b — test-only job orchestration (done).**
`packages/server/src/seed-coordinator.ts` drives a job through the existing
state machine with injected sides and an injected local store, and
`seed-coordinator.test.ts` proves the lifecycle: completion, source and target
failures, cancellation, lease expiry, cleanup idempotency, illegal-transition
refusal and lease renewal. See §2.12.

**Stage 2c — the same chain through a real daemon and a real temporary object
space (first slice done).** The real S3-compatible store, the manifest handoff
and a two-process isolated E2E run through the real server job API with a
disposable MinIO object space and a real zero-change bisync baseline are
implemented and pass on this host (see §2.13). Still open before the constant
may flip: a real two-MACHINE hop, real ENOSPC on a bounded volume, the
production daemon action loop, and the one-job-two-hosts authz/lease gap §2.13
records.

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
| Relay contract: namespace + key validation with prefix containment, immutable archive metadata, cleanup/retention state | **implemented + tested** |
| Local object store (the integration fixture, and a legitimate local store) | **implemented + tested** |
| Upload / download orchestration with hash verification at both hops, and failure cleanup | **implemented + tested against the fixture** |
| Disposable two-host end-to-end proof harness (archive → relay → publish → real bisync zero-change acceptance, plus the failure cases) | **implemented + tested** (rclone-gated) |
| Test-only job orchestration across the existing state machine: phases, lease renewal, archive-facts persistence, failure/cancel/lease-loss handling, idempotent cleanup | **implemented + tested** |
| Real S3-compatible relay store (SigV4, digest metadata, immutability, abort safety), test-only | **implemented + tested against a real MinIO** (env-gated) |
| Manifest handoff: source uploads the canonical manifest, target re-derives the content fingerprint and refuses a mismatch | **implemented + tested** (local store + real MinIO) |
| Two-process isolated E2E through the real server job API, disposable MinIO, real tar and a real zero-change bisync baseline, plus failure cases | **implemented + passing on this host**; two-machine hop, real ENOSPC and the live large-tree run are GATED |
| **Wiring a real store and the job/daemon orchestration that calls it** | **partially implemented** — the store and the two-sided worker exist and pass; the shipped daemon action loop still does not dispatch seed work |
| Remote orchestration (which host runs which phase) | **NOT implemented** — the E2E uses the master key; the job authorizes only its target host and has one lease |
| Post-seed zero-change bisync validation as an automated gate | **designed, not implemented** |

Because no store is wired to a running job, `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED`
is `false` (while `SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED` is `true`),
`POST /seed-jobs` returns `503 { executionAvailable: false, reason }`, and the
UI shows a disabled control. **No folder can be seeded today**, and no live
archive transfer is claimed anywhere: Stage 1a made the *local* half of a seed
correct and provable, Stage 1b's foundation made the transport contract
testable, and Stage 2c proved the whole vertical path through a real object
space and two independent processes — but that proof is test-only (a
doubly-gated seam), the production daemon does not dispatch seed work yet, and
the two-machine and disk-full host proofs are still GATED. The gate therefore
stays `false`.

## 8. Changed files

Core
- `packages/core/src/folder-seed.ts` (new) — contract, source authority,
  filter universe, space math, staging policy, archive safety, prerequisites,
  phase machine, deadline decision, wire grammar.
- `packages/core/src/folder-seed.test.ts` (new).
- `packages/core/src/seed-relay.ts` (new, Stage 1b) — the relay contract:
  namespace + key/prefix validation, immutable archive metadata, the store
  interface, cleanup/retention state.
- `packages/core/src/seed-relay.test.ts` (new, Stage 1b).
- `packages/core/src/folder-health.ts` — `facts.archive` tooling block,
  `facts.seedStaging` staging proof, and `facts.filter.patternCount`.
- `packages/core/src/types.ts` — `seed_plan` / `seed_job` WS events.
- `packages/core/src/db/schema.ts` — `folder_seed_plans` (incl.
  `source_authority_host_id`, `source_authority`, `filter_universe`),
  `folder_seed_jobs` in `SERVER_SCHEMA` and `MIGRATIONS`.
- `packages/core/src/index.ts`, `packages/core/package.json` — export the new
  modules (`@lamasync/core/folder-seed`, `@lamasync/core/seed-relay`).

Daemon
- `packages/daemon/src/seed-archive.ts` (new) — tooling detection,
  filter-aware manifest, create/list/validate/extract, manifest↔archive
  equality, verify, atomic publish, preflight. Stage 1a: tar is fed the
  manifest's member list as NUL-separated names (`--no-recursion
  --verbatim-files-from --null --files-from`), a name tar escapes in its
  listing is refused before tar runs, empty directories are pruned, and churn is
  measured inside the universe.
- `packages/daemon/src/seed-archive.test.ts` (new).
- `packages/daemon/src/seed-filter-universe.ts` (new, Stage 1a) — the rclone
  `--filter-from` rule compiler, the universe builder, and the
  assignment → manifest entry point.
- `packages/daemon/src/seed-filter-universe.test.ts` (new, Stage 1a) — incl.
  the fidelity cross-check against the host's real rclone.
- `packages/daemon/src/seed-relay-local.ts` (new, Stage 1b) — the local object
  store: key containment, immutable put, streaming verification, atomic
  publication, idempotent delete. Also the integration fixture.
- `packages/daemon/src/seed-relay-local.test.ts` (new, Stage 1b).
- `packages/daemon/src/seed-transport.ts` (new, Stage 1b) — upload, download
  with re-hash-before-extraction, cleanup, and the phase guard that reuses
  `canTransitionSeedPhase`.
- `packages/daemon/src/seed-transport-bounded.test.ts` (new, Stage 1b) — reads
  the module graph to assert no production module imports the transport while
  the capability flag is `false`.
- `packages/daemon/src/seed-e2e.test.ts` (new, Stage 2a) — the disposable
  two-host proof harness, rclone-gated.
- `packages/daemon/src/seed-relay-s3.ts` (new, Stage 2c) — the real
  S3-compatible relay store (SigV4 over `fetch`, digest as object metadata,
  immutability, abort safety, idempotent delete, namespace containment).
  TEST-ONLY; no production module imports it.
- `packages/daemon/src/seed-relay-s3.test.ts` (new, Stage 2c) — the gated real
  MinIO integration (`LAMASYNC_TEST_S3_*`), including immutability, a wrong
  expected digest, a bytes source and namespace refusal.
- `packages/daemon/src/seed-transport.ts` — Stage 2c adds
  `seedManifestContentFingerprint`, `seedManifestToDocument`,
  `serializeSeedManifestDocument`, `uploadSeedManifest` and
  `downloadSeedManifest` (three independent fail-closed checks).
- `packages/daemon/src/seed-transport-manifest.test.ts` (new, Stage 2c) — the
  manifest handoff through the local store, plus the algorithm-equality pin
  against `buildSeedManifest`.
- `packages/core/src/seed-relay.ts` — Stage 2c adds the manifest key, the
  canonical `SeedManifestDocument`, the shared digest-input description, the
  fail-closed parser/validator and `SeedManifestMetadata`.
- `packages/core/src/folder-seed.ts` — Stage 2c adds the manifest fields to
  `SeedJobArchiveFacts` (additive, no migration) and the `transportImplemented`
  override on `seedPlanExecution` / `checkSeedPlanValidity` /
  `seedPlanPrerequisites`.
- `packages/server/src/seed-jobs.ts` — Stage 2c adds the doubly-gated
  `seedTransportE2eEnabled()` seam and threads the override through plan
  validity and the plan's execution verdict.
- `packages/server/src/routes/folder-seed.ts` — Stage 2c adds the seam-gated
  `POST /seed-jobs/:jobId/archive` route and passes the seam to
  `seedPlanExecution`.
- `packages/server/src/seed-e2e-seam.test.ts` (new, Stage 2c) — pins that the
  constant stays `false` and that one environment variable alone opens nothing.
- `scripts/lama346-seed-worker.ts` (new, Stage 2c) — one side of a seed, in its
  own process (source or target), test-only.
- `scripts/lama346-seed-e2e.ts` (new, Stage 2c) — the disposable two-process,
  real-MinIO, real-rclone vertical-path acceptance run, with GATED host proofs.
- `packages/server/src/seed-coordinator.ts` (new, Stage 2b) — the test-only job
  coordinator: it drives the existing state machine with injected sides and an
  injected cleanup step, and adds no state of its own.
- `packages/server/src/seed-coordinator.test.ts` (new, Stage 2b) — the lifecycle
  proof (29 tests, including the concurrent-ownership, late-writer and
  evidence suites).
- `packages/server/src/seed-coordinator-bounded.test.ts` (new, Stage 2b) — reads
  the module graph to assert the coordinator stays test-only.
- `packages/daemon/src/seed-archive.ts` — `createSeedArchive` now returns a
  failed result (instead of throwing) when the member list cannot be written,
  which the Stage 2a space failure case found.
- `packages/server/src/seed-transport-state.test.ts` (new, Stage 1b) — the
  transport state lives on the existing job row; no new column.
- `packages/daemon/src/seed-deadline.test.ts` (new) — plus
  `syncRunIsProgressAware` scope tests.
- `packages/daemon/src/executor.ts` — `ProcessWatchdog` /
  `superviseProcess` / `seedStageWatchdog` / `syncRunIsProgressAware`.
- `packages/daemon/src/folder-health.ts` — report archive tooling,
  `seedStagingProofFor`, and the countable `filter.patternCount`.

Server
- `packages/server/src/seed-jobs.ts` (new) — persistence + plan preflight with
  the explicit source authority, plus `updateSeedJobArchive` and fail-closed
  archive-facts normalization.
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
bun test                                # 2572 pass / 0 fail, 173 files
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
- `packages/daemon/src/seed-archive.test.ts` — **41 tests**: real GNU tar for
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
  the archive**, plus the `/data/elsewhere` rejection. Hostile names get their
  own suites: the argv contract (both flags present **before** `--files-from`),
  the NUL encoding, an end-to-end run over seven option-shaped file names
  proving **no option executes** and every name is archived literally
  (extract → verify → publish round trip included), two characterization tests
  pinning what the unsafe newline invocation does to tar, and the
  before-tar refusal of control-character/backslash names (runner spy asserts
  tar was never invoked). Removing either flag or the NUL encoding makes four
  of these fail — verified by reverting the fix locally.
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
- `packages/core/src/seed-relay.test.ts` — **19 tests**: the namespace and key
  shape, every refusal reason (absolute, drive, backslash, control character,
  empty segment, traversal, wrong depth, outside the namespace, bad job id,
  another job's key), list-prefix containment, metadata problems, observation
  comparison (a missing digest is never a pass), cleanup/retention decisions,
  orphan detection that only names seed-namespace keys, bounded failure
  sentences, and fail-closed archive-facts normalization.
- `packages/daemon/src/seed-relay-local.test.ts` — **47 tests**: the store and
  the transport driven against each other — put/head/get/delete, immutability
  (a byte-identical re-put is idempotent, different content is refused), a
  digest or size mismatch on either hop (with the partial file removed), an
  aborted upload and download, a store that misreports or throws, keys that
  cannot escape the namespace or the root, cleanup that resumes after a partial
  failure and then no-ops, and the phase guard reusing the job state machine.
  Nine of them are the symlink-containment regression against a **real outside
  directory**: `put`, `head`, `get`, `delete` and `cleanup` each prove nothing
  outside is created, read, modified or removed; `list` proves it never recurses
  through the link and reports it in `skippedSymlinks`; and symlinked
  intermediate, final, digest-sidecar and working-directory components are each
  refused. Reverting the check makes exactly those nine fail.
- `packages/daemon/src/seed-transport-bounded.test.ts` — **4 tests**: the
  bounded-foundation invariant, asserted from the module graph — no production
  module imports the transport, nothing reaches a configured S3 or rclone,
  execution is still unavailable, and the seed namespace stays separate.
- `packages/daemon/src/seed-e2e.test.ts` — **25 tests** (3 skipped without
  rclone): the disposable two-host harness. Sandbox/identity/namespace shape;
  the effective universe (including the trailing-slash rule vs pruning
  distinction); the manifest; the archive's member set; the upload/download
  metadata; the published tree and its mtimes; the real bisync zero-change
  acceptance with bidirectional edits, ignored content, an anti-vacuity pair of
  roots and a modtime sensitivity test; and the failure cases in §2.11. The
  gate test names the skip explicitly.
- `packages/server/src/seed-coordinator.test.ts` — **29 tests**: the Stage 2b
  lifecycle proof — a completed run through every phase with its archive facts,
  bounded progress and cleanup; a source failure (unrepresentable universe) and
  a throwing source; a target failure (tampered object) and a missing baseline
  verdict; operator cancellation, a lost lease and the existing reaper; cleanup
  idempotency and a retryable cleanup failure; an illegal phase transition that
  a side cannot ignore; lease renewal observed on a fake clock; and the schema
  check proving no column was added. Then §2.12.1's correction: an active delayed
  owner versus a contender (with an in-flight object that must survive), a
  crashed owner's expired lease versus a live one, a self-expiring owner that
  stops instead of racing the reaper, the three conditional helpers against a
  wrong owner, a lapsed-lease finish, a source with no archive facts, a passing
  baseline over phases that were never entered, and the cleanup gate. Then
  §2.12.2: a stalled source returning after the job was taken over (the new
  owner's facts, progress, owner and outcome all survive), a late write against
  an ended job, a second run from the same host refused, and a same-host takeover
  after a lapse that still works.
- `packages/core/src/folder-seed.test.ts` — **4 tests**: the pure ownership rules
  (`seedLeaseIsLive`, `seedJobClaimableBy`, `seedCleanupAllowed`).
- `packages/server/src/seed-coordinator-bounded.test.ts` — **5 tests**: the
  test-only invariant and the conditional-writes-only boundary, read from the
  module graph.
- `packages/server/src/seed-transport-state.test.ts` — **5 tests**: the
  transport state lives on the existing job row (round trip, cleanup recordable
  after the job ended, fail-closed read of a malformed row, and a schema check
  proving no column was added).
- `packages/web-ui/src/folder-seed.test.ts` +
  `components/FolderSeedPlanCard.test.tsx` — **35 tests**: recommendation
  wording, source-authority wording, source-device candidates (the target is
  never offered; unmeasured/stale/empty are refused with reasons), unmet
  prerequisites, space/archive/staging wording, no invented tooling claims,
  disabled execution, plain-language phases, progress with only known totals,
  and the precise timeout-scope copy.

## 10. Remaining live validation (owner / later stage)

1. **Stage 1b (wiring):** wire a real store and the job/daemon orchestration
   that calls `uploadSeedArchive` / `downloadSeedArchive` /
   `cleanupSeedRelayObjects`, then flip `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` —
   the one open prerequisite. The contract, the local store and the
   verification logic are already implemented and tested.
2. **Stage 2c:** the same chain through a real daemon with a real temporary
   object space between two machines, plus the host proofs listed in §2.11
   (real ENOSPC, the network hop, concurrency, retention under load) and the
   manifest-handoff gap §2.12 records.
3. A live dev-vm-shape run on a **copy** of a large tree, confirming no
   timeout kill while progressing and a correct resume after a deliberate
   stall (stage 3).
4. Confirm the target's archive tooling *and* staging proof are reported before
   the Run control is enabled for that device.
5. ~~Decide the retention/cleanup policy~~ — decided in §2.10: delete on the
   terminal phase, a 24 h window for abandoned objects, idempotent retries,
   namespace-confined sweeps, never delete on an unknown age.

Stage 1a is done and Stage 1b's foundation is done: the local half of a seed and
the transport CONTRACT are correct and provable, and the plan's remaining gate is
wiring a real store to a running job.
