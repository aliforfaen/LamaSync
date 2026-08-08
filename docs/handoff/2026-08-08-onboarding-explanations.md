# Handoff — Workstream 2: Onboarding & explanations (web UI)

**Date:** 2026-08-08
**Source:** UX audit at `.memsearch/memory/2026-08-08-webui-tui-ux-audit.md`
**Prerequisite state:** workstream 1 ("wire up hidden API power") is already
implemented in the working tree (uncommitted). Gate is green: `bun x tsc
--noEmit` clean, `bun run build:web-ui && bun test` → 440 pass / 0 fail.
Build on top of it — do not undo any of it.

## Mission

Make LamaSync's web UI explain itself: a new user should be able to understand
the mental model (hosts, folders, backends, assignments, dotfile manifests,
conflict strategies) from the UI alone, and a first-time user should see a
guided path from empty install to first successful sync.

Design principle: **one glossary source, one inline-hint component, one
checklist.** No modal framework, no guided-tour library (shepherd.js etc. —
deliberately rejected), no new dependencies. Match existing house style:
`.muted` text lines, native controls, design tokens (`var(--...)`) in
`index.css`.

## Repo orientation

Bun workspace, TypeScript. You only touch `packages/web-ui` (plus docs):

- `packages/web-ui/src/pages/*.tsx` — pages: Dashboard, Hosts, HostDetail,
  Folders, Backends, Dotfiles, Conflicts, Operations, DataBrowser, Admin
- `packages/web-ui/src/components/` — shared components (Login, Nav,
  AddHostGuide, EditableHostname, AssignmentEditor, icons)
- `packages/web-ui/src/index.css` — one global stylesheet, design tokens
- `packages/web-ui/src/api.ts` — typed browser API client

### Conventions you must obey

- Imports use `.ts` extensions (`import { x } from "./y.ts"`).
- No `any` or inline casts — `unknown` + `typeof`/`in` narrowing.
- React 18: never name a prop `ref` (React strips it); key all list items.
- Minimal diffs. No reformatting, no renaming, no drive-by refactors.
- Tests: `bun:test`, `*.test.ts` beside source (web-ui currently has few;
  don't add a test framework).

### Verification commands

```bash
bun x tsc --noEmit                  # type check — must stay green
bun run build:web-ui && bun test    # tests FAIL without the web dist first
```

## Execution protocol

1. Implement phases 1 → 5 in order. Each phase ends with a **"Done when"** —
   check it before moving on.
2. Run `bun x tsc --noEmit` after each phase; the full gate after phase 4.
3. No git mutations (no commit/push/reset). Leave the tree dirty for review.
4. When done: update `docs/features.md` and append a dated "done" note to
   `.memsearch/memory/2026-08-08-webui-tui-ux-audit.md`.

## Lessons from the workstream 1 review (don't repeat these mistakes)

- **Never replace an existing test** — add alongside; deleted coverage is a
  regression even if the new test is related.
- **Keep JSDoc blocks attached to their function** — don't insert new code
  between a doc comment and the function it documents.
- **State that identifies an entity must key on the entity id**, not a
  human-readable name (two entities can share a name).
- **Reuse existing UI patterns before inventing classes**: the reveal toggle
  uses `.copy-btn` inside `.tailnet-ip`; hint text uses `.muted`; transient
  notes use the existing notice pattern. New CSS classes are a last resort.
- Every `async` handler must try/catch into the page's `setError` — no
  unhandled rejections, no raw `API error 500: {...}` strings shown to users.

---

## Phase 1 — Concept glossary foundation

1. Create `packages/web-ui/src/concepts.ts` — the single source of truth for
   plain-language explanations, exported as typed records (as const, typed
   against the core union types where they exist):
   - `FOLDER_TYPE_HINTS` (keyed by core `FolderType`):
     - sync: "Two-way sync between hosts — edits anywhere propagate (rclone
       bisync)."
     - mount: "Remote files mounted as a local directory — nothing stored on
       this host."
     - backup: "One-way versioned backup to the server (restic)."
     - dotfile: "App config files backed up as versioned tarballs."
     - git: "A git working copy kept in sync between hosts."
   - `BACKEND_KIND_HINTS` (keyed by `Backend["kind"]`):
     - s3: "S3-compatible object storage (Exoscale, AWS, other)."
     - local: "A directory path — must exist at the same location on every
       assigned host."
     - nfs: "An NFS export mounted locally — same path on every assigned
       host."
     - restic: "Central backup repository — folders use it as the default
       backup target."
   - `ROLE_HINTS` and `CONFLICT_STRATEGY_HINTS`: **MOVE** the existing records
     out of `packages/web-ui/src/components/AssignmentEditor.tsx:11-52` (they
     are the best copy in the app — don't paraphrase, don't duplicate) and
     re-import them in AssignmentEditor. Keep their `{ value, label, hint }`
     shape.
   - `MISC_HINTS`:
     - configRevision: "Bumps whenever server-side config changes — daemons
       re-pull their config within ~5 minutes."
     - queuedAction: "Actions are queued and run on the daemon within ~30
       seconds — nothing happens instantly."
     - dotfileManifest: "Decides which paths of an app's config get backed
       up, on which hosts, on what schedule."
     - dotfileOverride: "A host-scoped manifest overrides the global one with
       the same app name."
     - cacheProfile: "rclone VFS cache: normal = balanced, media = aggressive
       read-ahead for streaming, minimal = lowest disk use."
2. Create `packages/web-ui/src/components/Hint.tsx` — one tiny module with:
   - `<Hint text={...} />` — an inline `?` badge with a `title` tooltip (add a
     single `.hint-badge` rule to `index.css`: circular border,
     `var(--text-muted)`, `cursor: help`).
   - `<HintText>{...}</HintText>` — a `<span className="muted">` wrapper for a
     hint line under a form label (this exists implicitly today as bare
     `.muted` spans; the component just standardizes it).

**Done when:** tsc green; AssignmentEditor renders exactly as before but
imports its hint records from `concepts.ts`.

## Phase 2 — First-run checklist on Dashboard

3. Create `packages/web-ui/src/components/GettingStarted.tsx`. Derive 5 steps
   from data Dashboard already fetches (hosts, backends, folders; extend the
   page's fetches to include assignments if not already loaded — check
   `api.listFolders()` / `api.listAssignments()` shapes first):
   1. **Register a host** — done when `hosts.length > 0`; link to `/hosts`
      (the AddHostGuide lives there).
   2. **Create a backend** — done when `backends.length > 0`; link to
      `/backends`.
   3. **Create a folder** — done when `folders.length > 0`; link to
      `/folders`.
   4. **Assign it to a host** — done when any assignment exists; link to
      `/folders`.
   5. **Trigger your first sync** — done when any operation exists in the
      recent-activity data the Dashboard already loads; link to `/hosts`.
   Behavior: steps auto-check as conditions become true; the whole component
   hides when all five are done; a dismiss button persists to localStorage
   key `lamasync_getting_started_dismissed` (read on mount, set on dismiss).
   Style: reuse existing `.section` / card classes; a simple ordered list with
   ✓ marks is enough — no new visual language.
4. Render `<GettingStarted />` in `pages/Dashboard.tsx` above the fleet grid.
   When `hosts.length === 0`, it **replaces** the bare "No hosts registered
   yet" line (`Dashboard.tsx:301`); otherwise it renders as a dismissible
   card until complete/dismissed.

**Done when:** against an empty dev DB (`LAMASYNC_DATA_DIR=/tmp/fresh
LAMASYNC_API_KEY=dev-key bun run dev:server`), the checklist renders with
step 1 pending; steps check off as entities are created; dismiss survives
reload.

## Phase 3 — Login + entry points

5. `components/Login.tsx` — under the API-key input add a `.muted` hint:
   "Set on the server via `LAMASYNC_API_KEY` (docker `.env` or the server
   config). One key for the whole fleet — the same key works on every
   client."
6. `components/Nav.tsx` — add an "API docs ↗" link to `/swagger` (the server
   ships Swagger UI — see the log line at
   `packages/server/src/index.ts:136`), `target="_blank"
   rel="noopener noreferrer"`. Place it at the end of the nav. While there,
   fix the duplicate-icon nit from the audit: Dashboard reuses `IconHost` and
   Data Browser reuses `IconStorage` (`Nav.tsx:41,62`) — give each its own
   icon from `components/icons.tsx` if a suitable one exists, otherwise leave
   it (don't draw new SVGs).

**Done when:** login shows the hint; the nav link opens the Swagger UI on a
dev server.

## Phase 4 — Form & empty-state coaching

7. `pages/Folders.tsx`:
   - `HintText` under the **Type** select showing the current type's line
     from `FOLDER_TYPE_HINTS` (same pattern AssignmentEditor uses for role
     hints — a `.muted` span that updates with the selection).
   - `HintText` under the **Backend** selects from `BACKEND_KIND_HINTS`.
   - Under the assign-form **Role** select, reuse `ROLE_HINTS` from
     concepts.ts.
   - The cron/schedule field gets a hint: "Cron expression, e.g. `0 * * * *`
     = every hour. Leave empty to sync on the daemon's default schedule."
8. Empty states — replace bare one-liners with a coaching line (keep it one
   sentence + a pointer):
   - Folders: "No folders yet — create one, then assign it to a host to start
     syncing."
   - Dotfiles: "No manifests yet — a manifest decides which app configs get
     backed up. Restoring runs from the TUI."
   - Conflicts (pending tab): "No pending conflicts — they appear when both
     sides changed the same file under the manual strategy."
   - Operations: "No operations yet — every sync and backup the daemons run
     is logged here."
   - Leave Backends and Hosts alone — they already coach (Backends empty
     state, AddHostGuide).
9. `pages/HostDetail.tsx`:
   - Near the action buttons, show the shared `MISC_HINTS.queuedAction` line
     (replace any per-button ad-hoc note text with it — keep the transient
     "queued" confirmation on click, just use the glossary string for the
     static explanation).
   - Add `<Hint text={MISC_HINTS.configRevision} />` next to the config
     revision label in the identity block.
10. `pages/Dotfiles.tsx` — one `HintText` above the table combining
    `MISC_HINTS.dotfileManifest` and `MISC_HINTS.dotfileOverride`.
11. `pages/Backends.tsx` — fill any per-kind explanation gaps from
    `BACKEND_KIND_HINTS` (workstream 1 added some already — dedupe, don't
    double up); ensure the local/nfs hint includes the "same path on every
    assigned host" caveat.

**Done when:** every page's key select and empty state carries a
plain-language line sourced from `concepts.ts`; full gate green.

## Phase 5 — Docs & memory

12. `docs/features.md` — add a row: onboarding & explanations pass
    (concepts glossary + hint components, GettingStarted checklist, login
    hint, form/empty-state coaching, Swagger link).
13. Append a dated note to
    `.memsearch/memory/2026-08-08-webui-tui-ux-audit.md` listing the
    workstream-2 items as shipped and what remains (TUI foundations,
    restic restore UI, DataBrowser download/delete, validation sweep,
    visual redesign).

**Done when:** gate green, both docs updated.

---

## Known pitfalls

- `bun test` fails without `bun run build:web-ui` first.
- Don't paraphrase the AssignmentEditor hint copy when moving it — move it
  verbatim.
- The checklist must not crash when backends/assignments fail to load —
  treat load failure as "step not done", and surface errors via the page's
  existing error handling, not a new one.
- localStorage access must be guarded (the app renders without SSR, but keep
  reads in `useState` initializers or effects, not module scope).
- Keep every hint to one sentence. If an explanation needs two, the glossary
  entry is wrong, not the layout.

## Out of scope (do not drift)

- Visual redesign / new design tokens or color work
- TUI anything (that's workstream 3)
- Validation hardening (cron/URL/bucket format checks — separate sweep)
- Interactive guided tours, popover libraries, new dependencies
- Server/daemon/core changes — this is web-ui-only
