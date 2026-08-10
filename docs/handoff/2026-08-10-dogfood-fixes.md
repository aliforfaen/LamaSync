# Workstream 6 handoff — Dogfood fixes (web UI)

**Date:** 2026-08-10
**Audience:** executing model (DeepSeek). Self-contained: no prior conversation context required.
**Mission:** Fix the findings from the 2026-08-10 dogfood session on the
August UX program (WS1–5). Four should-fix items, three nits. Every finding
below has been **verified in code by the maintainer** — the locations and root
causes quoted here are real; implement against them. Web UI only: no server,
daemon, TUI, or core changes.

Report: `docs/handoff/dogfood-2026-08-10/report.md` (screenshots alongside).

---

## Maintainer decisions (already made — do not re-decide)

1. **Phase 1 (DataBrowser stuck skeleton) is the only functional bug** and
   the highest priority. The root cause is an effect-identity loop; the
   prescribed fix is two-sided (parent + child) — see the phase text.
2. **Native `confirm()` sweep is total.** Nine bare `confirm()` call sites
   remain (WS4 only replaced `window.confirm`/`window.prompt` spellings and
   the review grep made the same mistake). All of them move to the shared
   ConfirmDialog. After this phase, `grep -rn "[^.]confirm("
   packages/web-ui/src` must only hit comments and the Modal component.
3. **Cron validation reuses `packages/web-ui/src/cron.ts`** — do not write a
   second validator.
4. **Name-resolution nits are fixed by passing/resolving names, never by
   new API calls.** The data is already on the page in both cases.
5. **The report's section-E "gap" (S3 endpoint format validation) is NOT a
   bug.** Bare hostnames (`sos-zone.exo.io`) are an accepted endpoint format
   by design — see the input placeholder and `validateForm` in
   `packages/web-ui/src/pages/Backends.tsx:65-80`. Do not tighten it.
6. **Out of scope:** the CLI-fallback silent-default question
   (`runCliFallback` uses localhost/dev-key when no client.toml exists) —
   parked for a maintainer decision, do not touch it. The interactive TUI is
   not part of this workstream at all.

---

## Conventions (violations = rework)

- Imports use `.ts` extensions; no `any`, no inline casts.
- Reuse existing components/classes before inventing: ConfirmDialog usage
  pattern lives in `packages/web-ui/src/pages/Admin.tsx` (prune confirm) and
  `packages/web-ui/src/pages/DataBrowser.tsx` (overwrite confirms).
- Every async handler try/catches into the page's `setError`.
- Do not rename classes or restructure markup beyond what a phase requires.
- Leave changes uncommitted; the maintainer reviews and commits.

## Verification (run before claiming done)

```bash
bun x tsc --noEmit          # must be clean
bun run build:web-ui        # bun test fails without this
bun test                    # baseline: 475 pass / 1 skip / 0 fail — must not drop
```

Manual smoke for Phase 1 (this is the acceptance test for the whole
workstream):

```bash
rm -rf /tmp/lamasync-fix /tmp/lamasync-fix-backups
mkdir -p /tmp/lamasync-fix-backups/docs && echo hi > /tmp/lamasync-fix-backups/docs/notes.txt
LAMASYNC_API_KEY=dev-key LAMASYNC_DATA_DIR=/tmp/lamasync-fix \
LAMASYNC_BACKUP_DIR=/tmp/lamasync-fix-backups bun run dev:server
# Browser → http://localhost:8080 → login dev-key → Data page → local tab
# MUST list docs/ + notes.txt within a second. Skeleton may flash, never stick.
```

## Lessons from previous reviews (learn from these)

- Grep for **bare** `confirm(`/`prompt(` as well as `window.`-prefixed
  spellings — both exist in this codebase.
- Verify widget/API behavior against shipped code, not assumptions.
- React effect loops: an inline object prop (`ref={{...}}`) + an inline
  callback that sets state in an effect = new identities every render =
  effect re-fires forever. Key effects on primitives or stabilize identities.
- Quote the actual file when a doc references a line — specs drift.

---

## Phase 1 — DataBrowser stuck skeleton (dogfood F, should-fix)

**Symptom:** Data page → local tab shows skeleton rows forever; the listing
never renders. The API itself is fine.

**Root cause (verified):** `packages/web-ui/src/pages/DataBrowser.tsx`

- Line 722-730: the parent renders
  `<RefBrowser browseRef={{ kind: "local", path: "" }} onContext={(ctx) => setContext((prev) => ({ ...prev, local: ctx }))} .../>`.
  Both props get **new identities on every parent render**, and
  `setContext` always produces a new state object → parent re-renders.
- `RefBrowser` (lines 234-257): the fetch effect depends on `[ref, bump]`
  (object identity) and the context effect on `[ref, onContext]`. Every
  parent re-render therefore: cancels the in-flight fetch (`cancelled = true`
  in cleanup → `setLoading(false)` never runs), sets `loading = true`, and
  calls `onContext` again → `setContext` → re-render → loop. `loading` is
  stuck `true` → skeleton forever. The skeleton state (WS5) merely made the
  pre-existing identity loop visible.

**Fix (two-sided, both required):**

1. **Child (`RefBrowser`)** — make the effects immune to caller identity:
   - Fetch effect deps: `ref.kind`, `ref.path`, `ref.folderId`, `bump`
     (primitives), not `ref`.
   - Context effect: only call `onContext` when the context actually changed
     (compare kind/path/folderId against a ref of the last reported value),
     or fold the context report into the same primitive-keyed effect.
   - Same treatment in `S3Browser` (it has the same pattern; check its
     effects at ~lines 840-890).
2. **Parent** — stop feeding the loop: wrap the refs and callbacks in
   `useMemo`/`useCallback` at the `tab === "local"` and `tab === "s3"`
   render sites (lines 722-732).

**Done when:** manual smoke above lists files; no fetch spam in the network
tab (one request per navigation, not a continuous stream); gate green.

## Phase 2 — Native confirm() sweep (dogfood C6/G4, should-fix)

Replace all nine bare `confirm()` sites with the shared `ConfirmDialog`
from `packages/web-ui/src/components/Modal.tsx`:

| File:line (approx) | Action guarded |
|---|---|
| `pages/Hosts.tsx:111` | delete host |
| `pages/HostDetail.tsx:174` | delete host |
| `pages/Conflicts.tsx:161,174,187` | resolve conflict (3 strategies) |
| `pages/Folders.tsx:278` | delete folder + assignments |
| `pages/Folders.tsx:334` | unassign folder from host |
| `pages/Dotfiles.tsx:234` | delete manifest + versions |
| `pages/Dotfiles.tsx:278` | delete dotfile version |

Follow the existing state pattern (`const [confirmX, setConfirmX] =
useState<...>(null)` + one `<ConfirmDialog>` render). Destructive actions get
the danger-styled confirm button. Keep the exact guard copy (it carries
useful specifics like the version id).

**Done when:** `grep -rn "[^.]confirm(" packages/web-ui/src --include=*.tsx`
hits only comments/Modal; each flow still works (delete/resolve executes on
confirm, no-ops on cancel); gate green.

## Phase 3 — Cron validation in AssignmentEditor (dogfood D2, should-fix)

`packages/web-ui/src/components/AssignmentEditor.tsx` (custom cron input,
~lines 199-204) accepts any string — `61 * * * *` saves silently.

- Import the validator from `packages/web-ui/src/cron.ts` (WS4; already used
  by the Folders assign form — copy that form's UX: inline error text,
  save blocked while invalid).
- Validate on save (and ideally live on change). Empty = invalid unless the
  field is genuinely optional there — check how the Folders form treats it
  and match.
- `@reboot`/`@login` presets must stay valid.

**Done when:** `61 * * * *` and `banana` are rejected with an inline message;
`*/15 * * * *` and presets save; gate green.

## Phase 4 — Name resolution nits (dogfood D2-heading + B1, nits)

1. `AssignmentEditor.tsx:159`: heading renders the raw `assignment.folderId`
   UUID. Add a `folderName?: string` prop and render it when present (fall
   back to the id). Callers: `pages/HostDetail.tsx` and `pages/Folders.tsx`
   both already know the folder name — pass it.
2. `Dashboard.tsx:296`: needs-attention conflict entries render raw
   `{c.folderId}`. Resolve against the folders already loaded into `data`
   (`data.folders`); fall back to the id for unknown references.

**Done when:** no raw folder UUIDs in either place with seeded data; unknown
ids degrade gracefully; gate green.

## Phase 5 — Theme toggle label (dogfood A5, nit, optional)

`packages/web-ui/src/components/Nav.tsx`: the theme toggle labels the NEXT
state, so SYSTEM→DARK looks like a no-op when the OS prefers dark. Show the
CURRENT choice (e.g. "Theme: System") instead, cycling on click. Skip this
phase if it turns into a redesign of the toggle; flag it instead.

**Done when:** the toggle communicates current state; both themes unchanged;
gate green.

---

## Pitfalls

- Phase 1: do NOT "fix" the symptom by deleting the skeleton or the loading
  state — the loop is the bug. After your fix, navigation to a subdirectory
  must still show the skeleton briefly and refetch exactly once.
- Phase 2: don't change any guarded behavior (what delete/resolve actually
  does) — only the confirmation UX.
- Phase 3: the daemon only supports `@reboot`/`@login` specials — keep the
  validator's accepted-specials aligned with `cron.ts` as-is; don't extend it.
- Keep diffs minimal and phase-scoped; no drive-by reformatting.

## Out of scope (explicitly)

- Server/daemon/TUI/core changes.
- The CLI-fallback silent default (parked for maintainer).
- S3 endpoint validation tightening (not a bug — bare hostnames allowed).
- Interactive TUI testing/fixes.
- Anything not listed in a phase above.

## Report format

Per phase: files changed, verification output, manual-smoke result for
Phase 1, anything skipped or deviating and why.
