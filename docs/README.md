# LamaSync documentation

This directory is split between living operational guidance and preserved
project history. Start with the smallest document that answers the question;
do not treat old handoffs as current requirements.

## Living documents

- [Agent start](agent-start.md) — current work routing and validation.
- [Status and work queue](status.md) — current shipped state, follow-ups, and
  limitations.
- [Architecture](../ARCHITECTURE.md) — system and data-contract source of
  truth.
- [Development](development.md) — local development, testing, and release
  recipes.
- [Repository layout](repository-layout.md) — annotated source-tree map.
- [Features and limitations](features.md) — capability index by LAMA issue.
- [Terminology](terminology.md) — user-facing naming rules.
- [Production deploy](prod-deploy.md) — private LXC operations.
- [Android + mobile web UX plan](android-mobile-ux-plan.md) — the live design
  record for the companion shell and the phone-width web layout, including the
  decisions taken during implementation.
- [Backup viewer component decision](browse-viewer-decisions.md) — what the
  in-app file browser and previewers are made of, the licences and weights of
  the alternatives, and the trust boundary the choice keeps.

`handoff-302-event-triggered-sync.md` is retained as completed implementation
and soak evidence. `handoff-315-path-classification.md` remains here because the
path-classification implementation it proposes has not started.
[Initial large-folder seeding](handoff-346-initial-folder-seeding.md) is the
live design record for LAMA-346: its first vertical slice (contract, explicit
source authority, plan, space calculation, staging proof, job state machine,
progress-aware deadline, archive primitives), Stage 1a (filter-aware archive
construction from the effective filter universe), Stage 1b's relay contract
(per-job namespace, key containment, immutable metadata, verified
upload/download, cleanup/retention), Stage 2a's disposable two-host harness
(archive → relay → publish → real bisync zero-change acceptance), Stage 2b's
test-only lifecycle proof, Stage 2c's real network path (a real S3-compatible
store and the manifest handoff through a disposable MinIO), Stage 2d's
shipped-daemon path (per-role device authorization, the `seed_job` queued action
and a two-real-daemon E2E) and Stage 2e's per-stage lease supervision (renewal
alongside a long stage, abort-and-stop on cancellation or lease loss, and an
authority check before publishing) are implemented and locally validated, while the
production resync peer, the production relay-space configuration and the live
host acceptance remain open — so it stays here rather than in the archive. The dashboard
design reference and image artifacts remain here because the web UI assets
link to them directly.

[Android implementation handoff](handoff-296-android.md) defines LAMA-296’s QR-first Android companion scope, owner decisions, and acceptance checks.
[Android releases through Obtainium](android-release.md) defines the signed APK release and update procedure.

[Android phase 1 spec](spec-296-phase-1-android-foundation.md) is the bounded next coding assignment: native scaffolding and QR/session authentication, before uploads.

[Stage-2 automatic protection spec](spec-296-stage-2-auto-protection.md) records the stage-2 data/permission/scheduling design decision; the implementation evidence is [report-296-stage-2-auto-protection.md](report-296-stage-2-auto-protection.md).

## Archive

Completed August plans, audits, owner briefs, and historical status entries
live in [archive/](archive/README.md). They are evidence, not a work queue.

## Maintenance rule

When a feature ships, update `status.md`, `features.md`, and the relevant
operator or agent-skill reference. Move completed time-bound plans to the
archive instead of extending active entry points indefinitely.
