# LAMA-315 — First-class path classification for application data (design handoff)

## Status

Design handoff only. This document defines how LamaSync should grow a
first-class path-classification system that helps people understand, select,
exclude, back up, and later migrate application data safely. It is grounded in
the **actual** LAMA-316 application contract as it exists at HEAD `ba74b15`
(app templates → protections → snapshots); every type, table, route, and helper
named below was audited in the tree. No code changes accompany this document.

The LAMA-316 landing already planted a minimal hook: a stable
`PathClassification` union and a `classification` field on each capture path,
with every path today stamped `"unknown"` and **no** logic that consumes the
value (no recommendation, no exclusion). This document is the plan for turning
that inert field into a real, safe, reversible classification layer. Each
stage in the delivery proposal is independently shippable.

---

## Audit: how paths are declared, selected, excluded, captured, and restored today

### Contract types — `packages/core/src/types.ts`

The LAMA-316 "apps" contract (the section that supersedes the older
dotfile-manifest/profile/version model) declares:

- `PathClassification` (line 361) — the already-landed union:
  `"portable_config" | "machine_state" | "cache" | "secrets" | "custom" |
  "unknown"`. Its doc comment is explicit that this delivery only stamps every
  path `"unknown"` and exposes the field.
- `CaptureSpecPath` (line 370) — one path inside a capture spec with:
  `path`, `classification: PathClassification`, `rationale?: string | null`
  (operator/why note), and `archivePath?: string | null` (the deterministic
  snapshot archive member root; never client-supplied).
- `CaptureSpec` (line 380) — `paths: { linux?; macos?; windows? }` (arrays of
  `CaptureSpecPath`), plus `excludes: string[]` and `notes: string | null`.
  `notes` carries operator instructions about the recipe.
- `ApplicationTemplate` (line 391) — operator-owned reusable recipe with
  `origin: "built_in" | "custom"`, `paths: CaptureSpec`, `revision`, and
  `installUrl` / `installInstructions` / `restoreInstructions`. Never a fleet
  rollout policy.
- `ApplicationProtection` (line 409) — the object that makes a template active
  on one machine: `templateId`, `templateRevision`, `hostId`, `enabled`,
  `schedule`, `destination` (only `"server_archive"`), and a **`captureSpec`
  that is copied at enrollment and never mutated by later template edits**.
- `ApplicationSnapshot` (line 426) — immutable archive metadata: `archivePath`,
  `archiveFormat: "tar.gz"`, `sizeBytes`, `checksumSha256`, and a
  `capturedSpec: CaptureSpec` that is the **server-side exact capture record**
  frozen at capture time.
- `AppCaptureAssignment` (line 445) — the daemon wire entry inside `HostConfig`:
  `paths: string[]` (logical configured paths, index-paired with
  `resolvedPaths?: string[]`), `excludes?`, `schedule?`, `instructions?`.
  **Classification is not present on the wire.**
- `ApplicationProtectionListItem` (line 460) — protection row JOINed with
  template identity and latest-snapshot metadata for list UIs.

### Storage — `packages/core/src/db/schema.ts`

The three app tables each store a `CaptureSpec` as a **JSON `TEXT` column**
(in `SERVER_SCHEMA` lines 118–176, and mirrored as idempotent
`CREATE TABLE IF NOT EXISTS` entries in `MIGRATIONS` lines 644–650 — see the
"new DB data goes in both" convention note below):

- `application_templates.paths` — the editable catalog spec.
- `application_protections.capture_spec` — frozen at enrollment.
- `application_snapshots.captured_spec` — frozen per snapshot at upload.

All three carry per-path `classification` today. The JSON-embedded nature of
these specs means **path-level annotations are transportable inside the blob**
and are already captured-with-snapshot by the existing `captured_spec`.

### Path flow through the system

1. **Authoring.** Templates are CRUD'd over the API
   (`packages/server/src/routes/apps.ts`: `GET|POST /apps/templates`,
   `GET|PUT|DELETE /apps/templates/:id`) and the CLI
   (`packages/cli/src/cli/apps.ts`). `normalizeCaptureSpec` (apps.ts:128)
   accepts either a full `CaptureSpec` or a legacy `string[]` of raw paths; a
   legacy string entry is promoted to
   `{ path, classification: "unknown", rationale: null }`. It validates every
   path is a supported, host-independent base via `isSupportedCapturePath` /
   `archivePathForConfiguredPath` (apps.ts:100) and validates that any supplied
   `classification` is in the known union, rejecting unknown classes. The web
   UI template editor (`Presets.tsx`, `AppTemplates` route) currently renders
   paths as per-OS textarea line lists and stamps every path `"unknown"`
   (`specFromDraft`, `toEntries`) — there is **no classification or rationale
   editor** and no per-path selection UI today. `excludes` is a separate
   newline-delimited textarea.
2. **Enrollment.** `POST /apps/protections` (apps.ts:558) copies the
   template's `paths` CaptureSpec into the new protection's `capture_spec`
   (enrollment stores the full spec; host OS bucket must be non-empty).
   Duplicate host+template is 409. Template edits bump `revision` but do **not**
   mutate an existing protection's frozen `capture_spec`.
3. **Protection lifecycle.** `PUT /apps/protections/:id` (apps.ts:654) only
   accepts `name` / `enabled` / `schedule` / `destination` — **`capture_spec`
   (and therefore path membership and its `classification`) is immutable on a
   protection**; changing the path set requires delete + re-enroll (or a future
   explicit edit surface). Schedules are cron, `@reboot`, or `@login`
   (`ScheduleKind`, `packages/daemon/src/scheduler.ts:25`); the scheduler fires
   per-protection ticks (`nextRunForApp`, `onAppTick`).
4. **Config to daemon.** `GET /api/v1/hosts/:hostId/config`
   (`packages/server/src/routes/config.ts:608`) builds `apps: AppCaptureAssignment[]`
   from **enabled** protections only: `paths = bucket.map(x => x.path)`
   (strings only — classification, rationale, and archivePath are **stripped
   before the wire**), plus `excludes` and `notes → instructions`. The daemon's
   `expandConfigPaths` (`packages/daemon/src/config.ts:46`) adds daemon-local
   `resolvedPaths` while keeping logical `paths` for archive/recovery mapping.
5. **Capture.** `captureAppSnapshot` (`packages/daemon/src/executor.ts:1193`)
   refuses empty path sets; requires every resolved path to exist; builds one
   `tar czf` over the resolved absolute paths with boundary-aware
   `--transform` rules per path (`appArchiveTransforms`, executor.ts:1174)
   so each logical path lands at its portable `home/…` / `absolute/…` /
   `windows/…` archive member; applies `excludes` as literal
   `tar --exclude` args (`executor.ts:1234`). A restic-backed dotfile
   variant (`runResticDotfileUpload`, executor.ts:1344) applies the same
   excludes via `restic backup --exclude … --files-from`.
6. **Upload / snapshot freeze.** The daemon uploads the tarball to
   `POST /apps/protections/:id/snapshots` (apps.ts:763). The server rejects
   disabled protections, then computes `captureSpecForSnapshot(protection)`
   (apps.ts:229) — which freezes **only the host's single OS bucket**, maps each
   path to its `archivePath`, and carries `classification` / `rationale`
   through — and stores that as the snapshot's `captured_spec`. The archive
   lands under `${LAMASYNC_BACKUP_DIR}/apps/<protectionId>/<ts>-<uuid>.tar.gz`
   (`BACKUP_DIR`, apps.ts:18; size cap `LAMASYNC_APPS_MAX_BYTES`, default 512 MiB).
7. **Restore.** There is **no automated app restore route**. App data is
   recovered by `GET /apps/snapshots/:id/download` (returns the tarball) and
   following the template's `installInstructions` / `restoreInstructions`
   manually. (Automated restic restore exists only for restic-backend dotfile
   folders — `executeResticRestore`, executor.ts:273 — not for the
   `server_archive` app destination.)

### Where classification would attach today

- **Authoring** — `application_templates.paths[*].classification` per path
  (with rationale / provenance / confidence as siblings).
- **Selection** — per-path class drives what backup-selection review surfaces
  and whether a path is suggested (never silently) for exclusion.
- **Exclusion** — two distinct mechanisms today, both **outside** `paths[]`:
  `CaptureSpec.excludes` (string[]), applied verbatim by tar/restic. Exclusion
  has no class today and is a raw pattern, not a path entry.
- **Snapshot state** — `application_snapshots.captured_spec` already freezes
  each captured path's class at capture time; that is the "classification
  captured with the snapshot" home.

---

## Taxonomy

Keep the **already-landed** class names (stable, referenced by the union in
`types.ts`) — do not rename to avoid churn. `custom` and `unknown` are distinct:
`custom` is operator-assigned ("this is app-specific data"), `unknown` is
"not yet classified" and must stay visibly unknown.

| Class | Definition | Typical examples | Suggested default treatment |
|---|---|---|---|
| `portable_config` | Settings that reproduce behavior and are portable across machines. Safe to back up and to migrate to a fresh host. | `~/.config/nvim/`, `~/.config/Code/User/settings.json`, `~/.gitconfig`, `~/.zshrc`, `~/.config/fish/` | Always eligible; capture by default. |
| `machine_state` | Machine-specific state bound to this install/identity; migrate only with care (may embed host/uuid/cached creds to services). | `~/.config/Code/state.vscdb`, `~/.config/SomeApp/Local State`, `~/.local/state/*`, licence/activation files, `~/.ssh/known_hosts` | Eligible for backup; **reviewed** on restore/migration (not blindly copied). |
| `cache` | Derived/regenerable data. Losing it costs rebuild time, never correctness. | `~/.cache/*`, editor thumbnail caches, package-manager caches, `node_modules` under a captured app root | Eligible to be **suggested for exclusion** — never auto-discarded. |
| `secrets` | Credentials / session / identity material. Must remain backup-eligible and **conspicuous** in review, never silently excluded. | `~/.ssh/`, `~/.config/gh/hosts.yml`, session cookies/tokens, keyrings contents, `~/.netrc`, `.env` under an app root | Backup-eligible; flagged conspicuous; never silently excluded. |
| `custom` | Operator-assigned app-specific data that does not fit the fixed buckets. | A tool's nonstandard `~/foo/state` that the operator chooses to back up | Operator's explicit choice; captured as configured. |
| `unknown` | No confident classification available. | A path the recommender could not confidently place and the operator has not yet resolved | Rendered as **unknown**, never guessed; full review surface. |

---

## Data model

### Where annotations live

Path-level annotations belong on `CaptureSpecPath` (`types.ts:370`) and ride
inside the existing JSON `CaptureSpec` blobs. Because a spec is copied three
times across the lifecycle, each copy plays a distinct role:

| Copy | Table/column | Role for classification |
|---|---|---|
| Authoring spec | `application_templates.paths` | Operator-authored catalog classes + rationale + override provenance. Editable; template `revision` bumps. |
| Enrollment spec | `application_protections.capture_spec` | **Frozen** classes for one host at enroll time; immutable by design today. |
| Snapshot spec | `application_snapshots.captured_spec` | **Frozen per snapshot** at upload (`captureSpecForSnapshot`) — the historical record. Later template or protection edits never reinterpret past snapshots. |

`excludes` stays a raw `string[]` outside `paths[]`. A classified **cache**
suggestion is realized by moving a path out of the captured bucket / adding an
exclude at authoring/review time — never by daemon-side logic, and never
silently.

### Proposed fields on `CaptureSpecPath`

```ts
interface CaptureSpecPath {
  path: string;

  classification: PathClassification;        // existing
  rationale?: string | null;                  // existing — why this class (user text or recommendation explanation)

  // NEW — provenance of the current classification value.
  classificationSource?: "default" | "suggested" | "manual" | null;
  //   "default"    untouched initial state (always "unknown" until LAMA-316
  //                grows real values — see migration).
  //   "suggested"  placed by the recommender, not yet operator-confirmed.
  //   "manual"     operator override / confirmation (editable override). The
  //                only source that "locks" a recommendation in.

  // NEW — confidence for a non-manual value, 0..1. Present only when
  // classificationSource === "suggested". Dropped/ignored for "manual".
  confidence?: number | null;

  archivePath?: string | null;                // existing; snapshot-only
}
```

Provenance makes the "editable override" legible and reversible: the UI can
always show *what set the class* and let the operator flip `"manual"` back to a
re-suggestion or another class. Confidence is deliberately **not persisted**
for operator-confirmed values — a manual override is authoritative by choice.

### Captured-with-snapshot guarantee

The existing `captured_spec` freeze already records each captured path's
`classification`. When the new fields land, `captureSpecForSnapshot`
(`apps.ts:229`) must also carry `classificationSource`/`confidence`/`rationale`
through so a snapshot is self-describing: *what class each captured path had
when this archive was made, and why.* Because the snapshot row is immutable and
stores its own spec JSON, later template edits cannot reinterpret history.

### Schema note (SERVER_SCHEMA + MIGRATIONS convention)

The annotations above are JSON-embedded in existing `TEXT` columns, so **stage 1
requires no `ALTER TABLE`** — the change is type + validation + round-trip code,
plus re-stamping defaults. The codebase convention (this repo puts *any* new
relational data in **both** `SERVER_SCHEMA` for fresh DBs and `MIGRATIONS` for
existing DBs — see `schema.ts:3` and the `MIGRATIONS` array at `schema.ts:485`)
therefore only binds if a later stage introduces a **column or table**:

- If we ever add a queryable column (e.g. a summary of classes per snapshot),
  add it to the fresh `CREATE TABLE` in `SERVER_SCHEMA` **and** append an
  idempotent `ALTER TABLE … ADD COLUMN` to `MIGRATIONS`, following the existing
  pattern (duplicate-column errors ignored; e.g. `MIGRATIONS` entries such as
  `ALTER TABLE conflicts ADD COLUMN demo …`).
- The three app tables already follow the safety-net pattern in `MIGRATIONS`
  (idempotent `CREATE TABLE IF NOT EXISTS` at lines 644–650) precisely so an
  existing database picks them up; keep any new table in the same style and
  keep the `demo INTEGER NOT NULL DEFAULT 0` flag convention so demo-delete
  (`DELETE … WHERE demo = 1`) covers it.

Recommended direction for later stages: keep annotations in the JSON blob (single
source of truth, already portable and frozen by snapshots) and only denormalize
into relational columns/tables when a query needs to aggregate across rows
(e.g. fleet-wide "how much of our stored data is `cache` / `secrets`"). Do not
duplicate the blob into a second table before a concrete query demands it.

### Validation contract

`normalizeCaptureSpec` (apps.ts:128) and the web/CLI writers are the single
gate. New rules:

- `classificationSource` must be one of `default | suggested | manual | null`.
- `confidence` must be `0..1` or null, and must be **null** unless source is
  `suggested`.
- `rationale` stays free text (operator explanation or the recommendation's
  explanation text).
- Round-tripping a legacy entry (no new fields) must keep producing
  `classification: "unknown", classificationSource: "default", confidence: null`
  so the wire/DB never fabricates a false class. Older daemons/UIs simply never
  see the new optional fields.

---

## Confidence and explanation design

Recommendations are produced by a small, deterministic, **server-side**
classifier (a pattern catalog, not an opaque model) so every suggestion is
reproducible and auditable. Do not add a live "app discovery" promise (non-goal);
recommendations only act on paths the operator has already chosen for a
template.

- **Confidence** is coarse and human-readable (`high` / `medium` / `low`
  internally → a 0..1 number), derived from how specific and well-anchored the
  matched pattern is:
  - `high` (≈0.9): exact, well-known path — `~/.cache`, `~/.ssh`,
    `~/.config/gh/hosts.yml`.
  - `medium` (≈0.6): a common app-root subpath or recognizable stem, e.g. a
    `*.log`/`*.vscdb` under a chosen root.
  - `low` (≈0.3): a weak heuristic (e.g. `.env` anywhere) — always shown for
    confirmation, defaults to `unknown` if not confirmed.
- **Explanation is mandatory and attached** — every suggestion carries a
  human sentence (`rationale`) plus the matched pattern reference, e.g.
  "Detected as cache: matches well-known cache path `~/.cache`." The operator
  can edit the rationale when overriding.
- **Confidence is never authority.** A `high`-confidence `cache` still only
  produces a *suggestion*; nothing is excluded or dropped without explicit
  operator action. `low`-confidence and `unknown` are always surfaced.
- Classifier output is **stateless** (pure function of a path + a read-only
  catalog). The only persisted artifacts are the annotations an operator keeps
  (or a `suggested` value still awaiting confirmation). This keeps the safety
  property "reversible" — clearing a suggestion is deleting an annotation.

### Rule of thumb that drives UX wording

"Suggest, show, let the operator decide; explain the why; record only what the
operator keeps." Every default the classifier would *like* to apply is rendered
as a reviewable recommendation, never as an automatic change to what is
captured or excluded.

---

## Representative journeys

### 1. Template creation (`/apps/templates`, `AppTemplates` in `Presets.tsx`)

An operator starts a new template and adds per-OS paths as today (text lines).
Each resolved path is stamped `default`/`unknown` and, when the path matches the
recommendation catalog, the UI shows an inline chip: suggested class +
confidence + one-line explanation + **Apply / Ignore**. Applying a `cache`
suggestion (or manually classifying a path `cache`) surfaces a second, explicit
action: "Move out of capture and add to excludes" — always a separate,
confirmed step, never a side effect of tagging. `secrets` paths are tagged
clearly with a conspicuous badge. The template is saved with
`classificationSource` per path (`manual` for confirmed, `suggested` for ones
the operator left pending, `default` for untouched). Nothing is silently
excluded.

### 2. Backup selection review (`/apps/backups`, `AppBackups` in `Dotfiles.tsx`)

When reviewing a protection before/after capture, the snapshot summary groups
captured paths by class. Cache-classed paths that were *included* (operator
chose to back them up) show a low-key "regenerable" hint — never a blocking
warning. Secrets-classed paths show a conspicuous entry in the review pane.
Excludes are listed with their class rationale where one exists. The UI clearly
marks which entries came from the frozen enrollment spec vs the template.

### 3. Snapshot summary (`GET /apps/snapshots/:id`, `AppBackups` history)

The snapshot's own `captured_spec` (already frozen per snapshot) is used to
render the summary — **never** the current template/protection spec — so a
summary from a year ago reflects that snapshot's classifications, satisfying
"later template edits do not reinterpret history." Show per-class counts, the
`archivePath` mapping, and each entry's `rationale`/`classificationSource`.

### 4. Setup / restore change plan (future restore surface)

Because app restore is today manual (download + `restoreInstructions`), the
classification system's near-term win is a **reviewable change plan** shown
alongside a downloaded snapshot or a template's `installInstructions`: partition
entries into "portable config — safe to place on a fresh host", "machine state —
review before copying", "secrets — copy deliberately and re-scope", "cache —
skip, it regenerates", "unknown — operator decides". This is a *plan to review*,
never an automated apply. A real automated restore route is a later, separate
feature.

### 5. Folder-management suggestions

Reuse the same class vocabulary in later work for the Data Browser history view
(`DataBrowser.tsx`) and folder-management hints: mark restic/archive members
whose stored path is classed `cache` or `secrets` so an operator can see storage
composition and decide about retention/migration. Keep this additive and
read-only for v1.

---

## Safety rules (verbatim and binding)

1. **Never silently exclude secrets.** A `secrets` path is backup-eligible by
   default and is made conspicuous in every review surface. Only an explicit
   operator action may exclude it, and that action is recorded with its
   rationale.
2. **Cache exclusion is suggestion-only.** `cache` may be *suggested* for
   exclusion; it is never automatically discarded or dropped from capture.
   Reversing a cache exclusion (re-including the path) is always possible and
   shown as such.
3. **Unknown stays unknown.** Paths with no confident class render as
   `unknown`; they are never silently assigned a false class by any default.
4. **Snapshots capture classification at capture time.** Each snapshot's
   `captured_spec` freezes the classes (and new annotation fields) as of that
   upload; later template or protection edits never reinterpret past snapshots.
5. **Manual raw-path templates remain first-class.** A template that the
   operator authors from raw paths (no recommendations accepted) still captures
   exactly those paths; classifications never block an uncommon but valid
   layout, and nothing is added or removed behind the operator's back.

---

## Migration strategy from the current model

Current state: every path is `classification: "unknown"`, no source/confidence,
daemon wire strips classification, web/CLI author always `unknown`, excludes are
raw patterns, snapshot `captured_spec` freezes `unknown` per snapshot.

Target is additive and backward-compatible:

1. **No column adds** — annotations extend the JSON `CaptureSpecPath` blob;
   existing rows parse as `unknown` + `default` because the new fields are
   optional and parse with the current lenient defaults (`parseCaptureSpec`
   in apps.ts:84 and the daemon's spec readers already ignore unknown/extra
   keys, and older readers ignore new keys).
2. **Legacy path strings** (legacy `string[]`, or object entries without the
   new fields) normalize to `{ classification: "unknown",
   classificationSource: "default", confidence: null }` — identical semantics
   to today, so no history is reinterpreted.
3. **Snapshots are already safe.** Old snapshots keep `unknown` frozen; new
   snapshots freeze whatever the protection's frozen `capture_spec` carried at
   upload. A recommender that improves a template's classes only affects *new*
   enrollments (which copy the template at enroll time) and *new* snapshots —
   never existing protections' frozen specs or existing snapshots.
4. **Wire remains unchanged for daemons.** `AppCaptureAssignment` continues to
   carry plain `paths` + `excludes`; classification is a planning/review concern
   and is deliberately not sent to the daemon in stage 1. Exclusions are still
   realized only through the existing `excludes` mechanism or path membership,
   so no daemon-side behavior changes and older daemons are unaffected.
5. **Backfill.** If desired, one server-side pass can classify existing
   template specs' paths as `suggested` (never `manual`, never `unknown`-guessed)
   so operators see recommendations on their current templates; this is
   optional and reversible and must not touch frozen protection/snapshot specs.

---

## API / CLI / TUI / Web impact per package

> Any new route, CLI flag, or config key **must** update
> `packages/agent-skill/reference/{api,cli}.md` in the same change (the repo's
> strict drift check enforces this).

- **packages/core** (`types.ts`, `db/schema.ts`, `index.ts`)
  - Extend `CaptureSpecPath` with `classificationSource` / `confidence`.
  - Extend `normalizeCaptureSpec`-equivalent validation and the daemon-side
    spec parsers to tolerate the new optional fields (they already ignore
    unknown keys).
  - No `SERVER_SCHEMA`/`MIGRATIONS` change in stage 1; any later denormalized
    column/table goes in both per convention.
- **packages/server** (`routes/apps.ts`, `routes/config.ts`, `routes/demo.ts`)
  - `normalizeCaptureSpec` (apps.ts:128): accept + validate the new fields;
    keep rejecting unknown classes.
  - `captureSpecForSnapshot` (apps.ts:229): carry the new annotation fields into
    `captured_spec`.
  - Add a **read-only recommendation endpoint** (e.g.
    `GET /apps/classify?path=…`, or a batch `POST /apps/classify`) returning
    class + confidence + explanation for one or more paths, backed by the
    deterministic catalog. This is the only new route in stage 1.
  - Template create/update round-trips the new fields (no new route shape).
  - Demo seed (demo.ts:167) and the legacy dotfile migration
    (`packages/core/src/db/app-config-migration.ts`, which today stamps
    `classification: "unknown"`) stay as `default`/`unknown`.
- **packages/daemon** — no behavioral change in stage 1: the wire
  (`AppCaptureAssignment`) is unchanged; capture/exclude logic is untouched.
  Only confirm the spec readers ignore the new JSON keys.
- **packages/cli** (`cli/apps.ts`, `dispatch.ts:405–570`) — extend
  `apps templates create|update` with per-path classification flags (or a small
  `--classify` review helper) and show classes in `apps protections get` /
  `apps templates get` JSON output. Keep output `--json` additive.
- **packages/web-ui** (`Presets.tsx` = `AppTemplates`, `Dotfiles.tsx` =
  `AppBackups`, `api.ts` LAMA-316 block, `App.tsx` routes `/apps/templates` &
  `/apps/backups`) — add a per-path classification row with suggestion chips,
  confidence + explanation, an Apply/Ignore affordance, a conspicuous
  `secrets` badge, and grouped-by-class snapshot summaries rendered from the
  snapshot's own `captured_spec`.
- **packages/agent-skill/reference** — document the new classify endpoint and
  any new CLI flags in `api.md` / `cli.md` in the same change.

---

## Test plan

- **Validation:** `normalizeCaptureSpec` accepts valid new fields; rejects out
  of range `confidence`, `suggested`+`confidence:null` mismatch, and unknown
  `classificationSource`/`classification`; legacy `string[]` still yields
  `unknown`/`default`.
- **Round-trip:** template create → get → update preserves annotations;
  enrollment freeze (`capture_spec`) and snapshot freeze (`captured_spec`)
  carry them; editing a template after enrollment does **not** change an
  existing protection's or snapshot's classes.
- **Snapshot immutability:** two snapshots of one protection captured before
  and after a class change keep their own historical `captured_spec` classes.
- **Safety invariants (must hold):** a `secrets` path is never auto-excluded; a
  `cache` suggestion never removes a path from capture without an explicit
  action; `unknown` paths are never assigned a false class; a raw-path template
  with no recommendations captures exactly its paths.
- **Recommender:** deterministic output for the catalog; low-confidence and
  `unknown` paths always surface; explanation text present for every
  suggestion.
- **Wire compatibility:** `HostConfig.apps` and capture/restic exclude behavior
  unchanged; daemon spec readers tolerate the new JSON keys.
- **Web/TUI/CLI:** per-path class editor renders and round-trips; snapshot
  summaries group by class from the snapshot's own spec; CLI `--json` output is
  additive.
- **Gates (run by orchestrator after all slices land):** `bun x tsc --noEmit`,
  `bun run build:web-ui`, `bun test`,
  `bun scripts/check-skill-drift.ts --strict`.

---

## Staged delivery proposal

Each stage is independently shippable and leaves the system correct.

**Stage 1 — Field + read-only classifier (small, shippable first).**
Extend `CaptureSpecPath` with `classificationSource`/`confidence`; extend
`normalizeCaptureSpec` validation and `captureSpecForSnapshot` passthrough; add
the deterministic catalog + read-only classify endpoint; web template editor
shows suggestion chips + explanation + Apply/Ignore and a conspicuous `secrets`
badge; update `agent-skill/reference`. **Safety guarantees are all enforced by
"nothing consumes classification to change capture/exclusion yet."** No schema
migration, no daemon change. Closes the correctness of capturing annotations.

**Stage 2 — Review surfaces.** Group snapshot summaries by class in
`AppBackups` (from each snapshot's frozen `captured_spec`); surface excludes
with class rationale; show provenance in protection/template views. Pure
read/UX; no behavior change.

**Stage 3 — Suggestion-driven authoring workflows.** "Suggest exclusions"
wizard during template creation that turns a `cache` suggestion into an
explicit, confirmed exclude (never silent); `secrets` conspicuity pass across
review; backfill existing template specs as `suggested` (reversible).

**Stage 4 — Restore/change-plan & folder-management hints.** Reviewable
setup/restore change plan surfaced with downloaded snapshots / restore
instructions; additive read-only classification hints in Data Browser history
and folder management. (An automated app restore route, if ever built, is a
separate feature beyond this issue's scope.)

**Stage 5 (optional) — Denormalization.** Only when a concrete cross-row query
demands it, add relational columns/table following the SERVER_SCHEMA +
MIGRATIONS convention (idempotent ALTER + `demo` flag coverage).

---

## Explicit non-goals

- No automatic application-discovery promise — recommendations act only on
  paths the operator already put in a template.
- No arbitrary command execution.
- No destructive cleanup — nothing is deleted, pruned, or dropped automatically.
- No live two-way sync of classifications with the daemon; classification is a
  server/operator planning layer whose only mechanical effect on capture is via
  the existing `excludes` / path-membership mechanisms, applied by explicit
  operator action.
- No change to the raw-path manual template contract; manual templates remain
  first-class.

## Open questions for the owner

1. Should `secrets` be backup-**on** or backup-**opt-in** by default at
   template authoring? (Recommendation here: backup-eligible by default,
   conspicuous, in line with the issue's "secrets remain eligible for backup.")
2. Catalog ownership: ship a built-in read-only catalog in code, or a
   server-editable catalog table later? (Recommend built-in code catalog first;
   a table is a later denormalization candidate.)
3. Whether stage-3 backfill should mark existing template paths `suggested` for
   all operators at once, or only as templates are next edited.
