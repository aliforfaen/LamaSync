# Work session — LAMA-315 stage 2 review surfaces

## Outcome

Implement and validate stage 2 of LAMA-315: make application backup and
protection review surfaces explain path classifications using the immutable
spec that owns each fact. This is a read-only presentation slice. It must not
change capture membership, exclusions, restore behavior, or daemon config.

## Board and repository context

- Multica issue: `LAMA-315 — Path classification for backup selection and recovery`
- Board status: `in_progress` (stage 1 is implemented; later stages remain).
- Source of truth: `docs/handoff-315-path-classification.md`, especially
  “Representative user journeys”, “Safety rules”, “Test plan”, and “Stage 2”.
- Current branch includes the recent LAMA-334 and LAMA-335 merges. Preserve all
  unrelated changes and inspect current code before relying on paths or line
  numbers in the older design handoff.
- Read `AGENTS.md`, `docs/agent-start.md`, `docs/status.md`, and the current
  Multica issue/comments before editing.

## Scope

1. In the application backup history/review UI, group each snapshot's captured
   paths by classification using that snapshot's own frozen `capturedSpec` /
   `captured_spec`; never derive historical classifications from the current
   template or protection.
2. Show useful per-path details where present: configured path, archive-path
   mapping, rationale, and classification provenance. Keep unknown values
   visibly unknown.
3. Make included cache paths a low-key “regenerable” hint, not an error.
4. Make included secrets conspicuous without implying that they should have
   been excluded.
5. Surface configured excludes and their available classification rationale.
   If the current contract cannot associate an exclude with a classification
   without a new behavioral/data model, render the truthful information that
   exists and document the gap rather than inventing an association.
6. In protection/template review surfaces, distinguish frozen enrollment data
   from the current editable template and show provenance where it is useful.
7. Add focused tests for historical-snapshot immutability and the important
   display/safety states. Update agent-skill reference only if the observable
   API, route, command, or flag surface changes; stage 2 should normally need
   no new route.

## Binding safety constraints

- Never silently exclude secrets or any user-selected path.
- Never turn a cache classification into an automatic exclusion.
- Unknown stays unknown.
- Historical snapshot summaries use the snapshot's frozen capture spec.
- Manual raw-path templates remain first-class.
- No automated restore/apply path, arbitrary command execution, cleanup,
  schema change, or daemon-wire change belongs in this session.
- No production deploy, tag, release, or fleet-state editing.

## Likely code areas

- `packages/web-ui/src/Dotfiles.tsx` (`AppBackups`)
- `packages/web-ui/src/Presets.tsx` (`AppTemplates`)
- Nearby web UI API/types and focused tests
- `packages/server/src/routes/apps.ts` only if a missing read contract is
  proven; prefer the additive stage-1 contract already present
- `packages/agent-skill/reference/` only when strict drift actually requires it

Search for the current symbols before editing; do not assume the design
handoff's old line numbers are still accurate.

## Acceptance checks

- A snapshot summary groups paths by class from its own frozen captured spec.
- Editing/current template data cannot reinterpret an older snapshot in tests.
- `secrets`, `cache`, `unknown`, rationale, provenance, and archive mapping have
  truthful and accessible display states.
- Excludes are shown without fabricating metadata the model does not contain.
- Existing narrow/mobile layouts remain usable and do not regain horizontal
  overflow.
- No capture/exclusion behavior changes.

Run at minimum:

```bash
bun x tsc --noEmit
bun run build:web-ui
bun test
bun run scripts/check-skill-drift.ts --strict
```

Run focused tests during development. Use `bun run build` only if packaging or
release-facing files unexpectedly change.

## Handoff on completion

Leave a focused commit or clearly reviewable diff. Update LAMA-315 with changed
files, behavior delivered, validation results, any unavailable visual/live
check, and any genuine contract gap. Keep the issue `in_progress` because
stages 3–4 remain unless the owner explicitly re-scopes it. Do not deploy or
publish.
