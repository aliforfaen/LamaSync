# Workstream 5 handoff — Visual redesign (web UI, ops-console)

**Date:** 2026-08-10
**Audience:** executing model (DeepSeek). Self-contained: no prior conversation context required.
**Mission:** Give the LamaSync web UI a distinctive, profiled visual identity —
**ops-console / terminal-inspired** — by evolving the existing design-token
system, not replacing it. This is the final workstream of the August UX
program; workstreams 1–4 (features, onboarding, TUI) are committed. After this
lands, the maintainer runs a dogfood session on the result, so the bar is
"every page looks deliberately designed", not "a new coat of paint on the
Dashboard".

---

## Maintainer decisions (already made — do not re-decide)

1. **Extend the existing design tokens.** No Tailwind, no component library,
   no new npm dependencies, no CSS preprocessor. The LAMA-201 token system in
   `packages/web-ui/src/index.css` (`:root, [data-theme="dark"]` +
   `[data-theme="light"]`) is the foundation you build on.
2. **Character: ops-console / terminal-inspired.** Dark-first, dense data,
   monospace accents, status colors that mean something. Think "a well-designed
   fleet console", not "SaaS marketing dashboard". The product wraps rclone and
   runs on a tailnet — the UI should feel like it.
3. **Dark is the primary theme; light keeps parity.** Every token you add or
   change gets a light-theme value in the same edit. Light need not be
   "terminal green on white" — it should be a clean light rendition of the
   same design language.
4. **CSS-first.** The overwhelming majority of this workstream is `index.css`
   + token usage. TSX edits are allowed where structure is genuinely needed
   (e.g. adding a skeleton placeholder, a wordmark element, a `className`),
   but no page re-architecture, no new routes, no behavior changes.
5. **Class names stay stable.** Existing classes (`.badge-*`, `.section`,
   `.data`, `.hint-*`, `.gs-*`, `.modal*`, `.empty-row`, `.copy-btn`,
   `.tailnet-ip`, …) are restyled in place, not renamed — WS2/WS4 components
   and any external references depend on them. New classes only for genuinely
   new constructs (skeletons, wordmark, status pill).
6. **Absorb the leftover presentation nits** from the WS4 review (listed in
   Phase 5) — they are presentation-level and belong in this pass.
7. **local/nfs backend copy may state the deployment story plainly**: paths
   are server-side and must exist at the same mountpoint on every assigned
   host (e.g. fleet-wide NFS mount). Confirmed as the intended story. Only
   touch this if a phase already has you editing that copy — do not make a
   special trip.
8. **No TUI changes, no server changes, no daemon changes.** Web UI only.

---

## Repo orientation

Bun workspace, TypeScript. The web UI is a React SPA that gets inlined into the
server binary (`scripts/inline-web-ui.ts`); `bun run build:web-ui` produces
`packages/web-ui/dist/` and `bun test` fails without it.

- **Design tokens + all styles:** `packages/web-ui/src/index.css` (~1080
  lines, single stylesheet). Token blocks at the top:
  `:root, [data-theme="dark"]` (line 3) and `[data-theme="light"]` (line 78).
  Existing token groups: surfaces (`--bg/--surface/--surface-elevated`),
  borders, text ramp (`--text/--text-dim/--text-muted/--text-strong`),
  accents (`--accent-info/--accent-ok/--accent-warn/--accent-critical` plus
  `-rgb` and `-bg` variants, `--accent-storage`, `--accent-sync`),
  `--color-error`, spacing (`--space-*`), radius (`--radius-*`), font sizes
  (`--font-size-*`), `--font-family` (system sans, line 64), `--muted-bg`.
  Component classes follow: nav, login, badges (`.badge-*`, line 394+),
  forms, tables (`.data`), toolbar, host cards, modals, hints (`.hint-*`),
  getting-started (`.gs-*`), etc.
- **Theme machinery:** `packages/web-ui/src/theme.ts` — `dark | light |
  system`, persisted to localStorage (`lamasync-theme`), applied as
  `data-theme` on `<html>`. Nothing to change here unless a phase says so.
- **Pages (10):** `packages/web-ui/src/pages/` — Dashboard (Command Center),
  Hosts, HostDetail, Folders, Backends, DataBrowser, Dotfiles, Conflicts,
  Operations, Admin. Plus `components/Login.tsx`.
- **Shared components:** `packages/web-ui/src/components/` — Nav (sidebar +
  theme toggle + SVG domain icons in `icons.tsx`), Hint/GettingStarted (WS2
  onboarding), Modal/ConfirmDialog/PromptDialog (WS4), AddHostGuide,
  AssignmentEditor, EditableHostname.
- **WS connection status** is rendered as raw text in the Dashboard toolbar
  (`WS: {wsState}`) and possibly elsewhere — grep for `wsState`.
- All server calls go through `packages/web-ui/src/api.ts`; you should not
  need to touch it.

---

## Conventions (violations = rework)

- **No hardcoded colors outside the token blocks.** Every color used by a
  component class must reference a `var(--token)`. If you need a color that
  has no token, add the token (both themes) — never inline a hex.
- Reuse existing classes/patterns before inventing new ones; new classes
  follow the existing naming style (`kebab-case`, scoped prefixes like
  `.skel-*` for skeletons).
- No `any`, no inline casts in TSX; `.ts` import extensions.
- Every async handler try/catches into the page's `setError` (should already
  be true post-WS4 — don't regress it while editing TSX).
- Keep JSDoc/comments attached to what they describe when editing TSX.
- Do not touch `packages/server`, `packages/daemon`, `packages/tui`,
  `packages/core` (no reason to).
- No emojis in UI copy; the SVG icon set in `icons.tsx` is the icon system.

---

## Verification (run before claiming done)

```bash
bun x tsc --noEmit          # must be clean
bun run build:web-ui        # bun test fails without this
bun test                    # baseline: 475 pass / 1 skip / 0 fail
```

Baseline is **475 passing, 1 pre-existing skip, 0 fail**. This workstream adds
no tests (CSS doesn't need them); the count must not drop and no existing test
may be edited.

Manual smoke (recommended):

```bash
LAMASYNC_API_KEY=dev-key \
LAMASYNC_DATA_DIR=/tmp/lamasync-test \
LAMASYNC_BACKUP_DIR=/tmp/lamasync-test-backups \
  bun run dev:server   # then open the UI, toggle dark/light in the nav
```

You cannot see pixels, so verify structurally: after each phase, grep for
hardcoded hex/`rgb(` outside the two token blocks (`grep -nE
'#[0-9a-fA-F]{3,8}|rgba?\(' packages/web-ui/src/index.css` — only the token
blocks may match), and confirm every `var(--…)` you reference is defined in
BOTH theme blocks. The maintainer does the visual review afterwards; make
their life easy by keeping the design coherent within one phase at a time.

---

## Execution protocol

- Work phase by phase, in order. Each phase has a "Done when" gate — do not
  start the next phase until the gate passes (including tsc + tests).
- Phases are ordered foundations-first: tokens → typography → components →
  states → chrome → QA. Later phases assume earlier ones.
- If you get stuck on a phase, skip it, finish the rest, flag it clearly.
- When done: report per phase — what changed (files), verification results,
  anything skipped or deviating from this doc and why.
- Leave changes uncommitted; the maintainer reviews and commits.

## Lessons from previous reviews (learn from these)

- Reuse existing CSS classes/patterns before adding new ones.
- Never replace existing tests; additive only.
- Entity state keys on ids, never display names (if you touch TSX).
- Quote/read the actual file when a doc references it — specs can drift.
- WS2 added `.hint-*` and `.gs-*` classes and WS4 added `.modal*` — these are
  load-bearing; restyle them, don't break their markup contract.
- Small, coherent diffs per phase beat one giant stylesheet rewrite — the
  maintainer reviews visually per page.

---

## Phase 1 — Token system v2 (the foundation)

Evolve the token blocks in `index.css`:

- **Monospace accent font:** add `--font-mono` (e.g. `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`) and a `--font-size-mono-*` companion if useful. Both themes (same value).
- **Dark palette refinement** toward ops-console: deepen/neutralize `--bg`/`--surface` (near-black with a cool bias), make `--accent-ok`/`--accent-sync` read as "terminal green/teal", keep `--accent-warn` amber and `--accent-critical` a clear red. Maintain WCAG AA contrast for `--text` on `--bg` and for badge text on its `-bg` tint. You choose exact values — that's the design work — but stay within the existing token names; add new tokens only where the system has a gap (e.g. `--accent-primary` exists only as `-rgb`; a matching solid token may be warranted).
- **Focus ring:** add a `--focus-ring` token and a shared `:focus-visible` style for interactive elements (buttons, inputs, links, `.copy-btn`). Currently focus styling is inconsistent/absent.
- **Density tokens** if the current `--space-*` set can't express the denser table/card rhythm you want — add, don't repurpose.
- **Light theme parity:** same structure, light-appropriate values, in the same edit.

**Done when:** token blocks compile (build passes), every new token exists in
both themes, no component classes changed yet (visual diff limited to colors
flowing through existing tokens + focus rings), gate green.

## Phase 2 — Typography & data treatment

- Apply `--font-mono` to data that is machine-shaped: paths, IPs
  (`.tailnet-ip` already exists), host/folder IDs where shown raw,
  timestamps, byte counts, cron expressions, rclone output/log lines. Add a
  utility class (e.g. `.mono`) and apply it in TSX where no semantic class
  exists. Do not mono-ify prose, labels, or buttons.
- Establish a clear heading hierarchy: page titles (`<h1>` in `.toolbar`),
  section titles (`.section h2`), card titles — consistent sizes/weights via
  tokens, no ad-hoc `font-size` inline styles (grep TSX for `style={{` and
  replace presentational one-offs with classes where they exist).
- Table density: `.data` tables get the ops-console rhythm — slightly tighter
  row padding, mono for data columns where Phase 2's rule applies, header row
  styling that reads as a column header, not bold body text.
- Numeric columns (sizes, object counts) right-aligned or consistently
  formatted; if a page shows raw unformatted byte numbers, route them through
  the existing `formatBytes` helper (grep `packages/web-ui/src` for it) —
  known offender: the JobsPanel in DataBrowser.

**Done when:** mono treatment applied consistently across at least Dashboard,
HostDetail, Folders, DataBrowser, Operations; no inline `style` font rules
left; gate green.

## Phase 3 — Component restyle (buttons, inputs, badges, cards, modal)

Restyle in place, via the existing classes:

- **Buttons:** `.action`, `.copy-btn`, pagination buttons — consistent
  heights, hover/active/disabled/busy states. Busy states (e.g. "Measuring…",
  "Syncing…") should look disabled-but-working, not just change text.
- **Inputs/forms:** `.form` rows, selects, textareas — terminal-flavored
  focus treatment using Phase 1's focus ring; consistent control heights.
- **Badges:** `.badge-*` — sharpen into a status system: consistent shape
  (pill or chamfered — pick one), mono uppercase micro-labels if that suits
  the design, colors strictly from status tokens. This is the signature
  element of an ops console; make it deliberate.
- **Cards/sections:** `.section`, `.fleet-card`, `.summary-card`,
  `.attention-item`, `.host-card` — consistent border/radius/elevation
  language; the attention/needs-attention states (`.attention-active`) should
  read at a glance.
- **Modal:** `.modal-backdrop`/`.modal` — proper elevation, border, and
  backdrop dim; ConfirmDialog destructive actions visually distinct
  (danger styling on the confirm button).

**Done when:** all the above restyled via CSS (TSX className additions only
where a state can't be expressed), both themes, gate green.

## Phase 4 — Loading & empty states

- **Loading:** add a skeleton system (`.skel-*` — shimmer or pulse via CSS
  animation on token-colored blocks; respect `prefers-reduced-motion`).
  Apply where pages currently show "Loading…" text or render nothing while
  fetching: Dashboard cards, DataBrowser listing, Operations table, Hosts
  list. Keep it simple — skeleton rows/cards, not per-widget choreography.
- **Empty states:** `.empty-row` exists; make empty tables/lists consistent
  (icon or mono glyph + one-line coaching; WS2's Hint components already
  carry the copy — don't duplicate it).
- **Error blocks:** `.error` styling consistent page-to-page (some pages
  render errors inline, some in banners — unify the look, not the placement).

**Done when:** no page shows a bare "Loading…" string; skeletons on the four
pages listed; reduced-motion respected; gate green.

## Phase 5 — Chrome, identity & leftover nits

- **Nav identity:** the sidebar gets a wordmark/brand block (text wordmark is
  fine — "LAMASYNC" in the mono accent, or a minimal SVG mark added to
  `icons.tsx`), and the theme toggle styled as part of the console chrome.
- **WS connection status:** replace raw `WS: {wsState}` text with a status
  pill/dot treatment (connected/connecting/disconnected, token colors).
  Grep for `wsState` to find all render sites.
- **JobsPanel bytes:** DataBrowser's jobs panel shows unformatted byte
  numbers — route through `formatBytes`.
- **Page headers:** every page's `.toolbar`/`<h1>` consistent — title, muted
  subtitle/status slot, actions right-aligned.
- **Scrollbars:** thin, token-colored scrollbars (webkit + `scrollbar-width`)
  fitting the console look.
- **Rename no-op feedback:** in DataBrowser, submitting a rename with an
  unchanged name silently no-ops and leaves the dialog open — close the
  dialog (or show a hint). One-line TSX fix.

**Done when:** all five items done, both themes, gate green.

## Phase 6 — Light-theme parity & full QA sweep

- Walk all 10 pages + Login + every Modal/ConfirmDialog/PromptDialog state in
  BOTH themes. Structural check: no token referenced that isn't defined in
  both blocks; no hardcoded colors outside token blocks (run the grep from
  Verification).
- Contrast spot-check: body text, muted text, badge text on tint, focus rings
  — AA or better on both themes.
- `prefers-reduced-motion`: any animation you added (skeleton pulse,
  transitions) gated behind it.
- Final gate: `bun x tsc --noEmit && bun run build:web-ui && bun test`.

**Done when:** the sweep checklist is in your final report, page by page,
with anything you could not verify flagged for the maintainer's visual pass.

---

## Pitfalls

- **Don't touch the token NAMES components rely on.** Add/refine values;
  removing or renaming a token breaks every `var()` reference silently (no
  build error — visual only). If you must rename, grep every usage first.
- **`rgba(var(--x-rgb), α)` pattern:** several tokens exist as `-rgb`
  triplets for alpha compositing. Keep that pattern when adding accent
  colors; don't mix hex and triplet for the same color.
- **Light theme is not an afterthought.** The most likely review rejection:
  a beautiful dark theme with light-theme tokens left stale.
- **Don't restyle by editing TSX markup structure.** If you find yourself
  rewriting a page's JSX to achieve a look, stop — the phase is telling you
  to do it in CSS. TSX edits are for classNames, skeleton placeholders, the
  wordmark, the WS-status pill, and the two named one-line fixes only.
- **The TUI is a separate surface.** It has its own look via OpenTUI; nothing
  here applies to it.
- Keep diffs reviewable: phase-by-phase, no wholesale reformatting of
  `index.css` (the maintainer diffs against HEAD).

---

## Out of scope (explicitly)

- New dependencies, Tailwind, CSS-in-JS, component libraries.
- Server/daemon/TUI/core changes of any kind.
- New features, routes, or behavior changes (beyond the two named one-line
  fixes in Phase 2/5).
- Responsive/mobile redesign (the UI is desktop-first; don't regress small
  widths, but don't design for them either).
- Accessibility overhaul beyond contrast + focus rings + reduced-motion
  (a full a11y pass is its own future workstream).
- The WS4 non-visual nits (S3 download buffering, S3 400-vs-404, Admin
  `/health` failure placeholder, cron `@noon` acceptance) — recorded for a
  future cleanup pass, not this one.

---

## Note for the maintainer's review

The executor can't see pixels. Plan the visual review per phase using the dev
server smoke command above; the structural greps (hardcoded colors, token
parity) catch the common failure modes before you open the browser. The
dogfood session on the web-ui happens after this workstream lands.
