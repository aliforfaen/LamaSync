# LAMA-173 — TUI Unification Plan (handoff document)

**Multica issue:** LAMA-173 "TUI: Unify the experience" (backlog, medium)
**Goal:** Unify the TUI into a single persistent interface built on `@opentui/core`, keeping the current visual style, eliminating the focus/key-handling bugs class fixed in LAMA-167, and adding guided wizard flows for common tasks.

**User decisions (2026-07-19):**
- Stay on `@opentui/core` VNode factory proxies + a thin internal app framework. **No `@opentui/react`, no new dependencies.**
- Persistent **tab shell**: one screen with a `TabSelect` bar, content pane, status bar, hotkey footer. Views mount **once**, switch via `Renderable.visible`.
- Include **guided wizards** for key tasks (new backup folder + assignment, dotfile manifest create/restore), giving the TUI create/write actions it currently lacks.

**Handoff note:** this plan is written to be executed by an agent with zero prior context. Step 0 copies this document into the repo at `docs/plans/LAMA-173-tui-unification.md` so it survives the session.

---

## 1. Current state (what exists today)

Environment facts:
- `@opentui/core@0.1.107` installed (`packages/tui/package.json:16`). No React layer.
- Widget inventory available but **unused**: `TabSelect`, `ScrollBox`, `Textarea`, `Slider`, `Code`, `Diff`, `TextTable`, `ScrollBar`, `ASCIIFont`. Used today: `Box`, `Text`, `Select`, `Input`, `MarkdownRenderable`.
- OpenTUI ships a testing module (`@opentui/core` → `testing.d.ts`): `createTestRenderer`, `mock-keys` — use it for smoke tests.
- `Renderable` has `visible: boolean` get/set (`Renderable.d.ts`) — this is the mechanism that replaces destroy/rebuild.

### Architecture today
- `packages/tui/src/index.ts` (983 lines) is a god-object: router + global key dispatcher + per-view key maps + data fetchers + controllers. Key parts:
  - Global key handler: `renderer.keyInput.on("keypress")` (index.ts:160-240) — installed because `root.onKeyDown` doesn't fire when a focusable widget exists (LAMA-167).
  - `redraw()` (index.ts:460-474) **destroys the whole tree** on every navigation, re-adds a fresh VNode, then `process.nextTick(() => focusFirstSelect(root))`.
  - `focusFirstSelect()` (index.ts:476-486) — recursive `any`-typed walker; needed because `autoFocus: true` only covers startup.
  - Enter-crash fix (commit f94cb8f): global handler must not handle Enter — `Select.itemSelected` + global Enter handler both fired and crashed the renderer.
  - Two view paradigms coexist: stateless render fns rebuilt per redraw (menu/local/fleet/logs) vs controller objects `{view, handleKey, state}` (dotfiles/conflicts/gh). Controller async updates don't trigger `redraw` → stale paints.
- Views (`packages/tui/src/views/`): menu.ts, local.ts, fleet.ts, dotfiles.ts (530-line 7-step wizard), conflicts.ts, logs.ts, gh-selector.ts.
- Data: `src/api.ts` (env → client.toml → defaults), `src/socket-client.ts` (Unix socket, local daemon actions), `src/cli-fallback.ts` (non-interactive summary, `LAMASYNC_NO_TUI=1`).

### Pain points to eliminate (with references)
1. Full-tree destroy/rebuild + focus hack (index.ts:460-486).
2. Three key-handling layers with overlapping ESC/q duties (index.ts:160-240 + per-view char maps + controller `handleKey`s).
3. Hotkey tables duplicated between view files and index.ts (local.ts:58-71 vs index.ts:276-294; fleet.ts:33-39 vs index.ts:337-348; logs.ts:26-32 vs index.ts:372-383).
4. Boilerplate triplicated+: `hotkeyFooter()` copy-pasted (local.ts:140-146, fleet.ts:96-102, logs.ts:81-87); same `Row`/`toRows` mapper in 6 files; same bordered shell in 7 places.
5. **Conflicts resolves the wrong row** — `conflicts.ts:86` resolves the first non-resolving conflict, ignoring the Select cursor.
6. **Logs not scrollable** — flat `Text` column (logs.ts:75-79), no `ScrollBox`; pagination comment stale (logs.ts:40-44; `fetchLogPage` already passes offset at logs.ts:99-102).
7. Menu reachable-set inconsistent: conflicts missing from menu (menu.ts:16-22); number keys 1-5 hardcoded in index.ts:253-259.
8. GH view: 5 near-identical `renderGhSelector` call sites in index.ts:730-931.
9. Menu view becomes redundant once tabs exist.

---

## 2. Target design

### 2.1 Screen layout (persistent, one screen)

```
┌ LamaSync ────────────────────────────────────────────────┐
│  Local | Fleet | Dotfiles | Conflicts | Logs              │  ← TabSelect bar (header)
├───────────────────────────────────────────────────────────┤
│                                                           │
│                 active view content pane                  │  ← one container per view,
│                                                           │    visible=true/false toggled
├───────────────────────────────────────────────────────────┤
│ ● server 100.113.52.108 · fleet live · host: <hostname>   │  ← status bar (1 line)
│ q quit · 1-5/[/] tabs · <active view hotkeys>             │  ← hotkey footer (1-2 lines)
└───────────────────────────────────────────────────────────┘
```

Wizards render as a **modal container centered over the content pane** (absolute-positioned bordered Box), not a separate screen.

### 2.2 New module structure

```
packages/tui/src/
  index.ts                 # slim entry: flags, CLI fallback, config-error screen, boot Shell
  app/
    theme.ts               # style constants (border style, colors, titles) — "keep its style"
    widgets.ts             # shared: pageShell(), hotkeyFooter(), toRows(), statusBox() (loading/error/empty)
    keymap.ts              # Hotkey type + dispatch; pure, unit-testable
    view-manager.ts        # View interface + ViewManager (register/show/visible toggling/key delegation)
    shell.ts               # root layout + global keypress dispatch + status bar API
    wizard.ts              # generic modal step-wizard (ESC back / Enter next / confirm)
    fleet-service.ts       # WS subscription moved out of views/fleet.ts, owned by app lifecycle
  views/
    local.ts  fleet.ts  dotfiles.ts  conflicts.ts  logs.ts  gh-selector.ts   # refactored to View
  flows/
    backup-setup.ts        # wizard: create folder + assign hosts
    dotfile-manifest.ts    # wizard: create/edit dotfile manifest (schedule presets incl @reboot/@login)
  api.ts  socket-client.ts  cli-fallback.ts   # unchanged (minor touch-ups only)
```

### 2.3 Core interfaces

```ts
// app/keymap.ts
export interface Hotkey { key: string; label: string; run: () => void | Promise<void>; }
export function matchHotkey(hotkeys: Hotkey[], keyName: string): Hotkey | undefined;

// app/view-manager.ts
export type ViewId = "local" | "fleet" | "dotfiles" | "conflicts" | "logs";
export interface ViewContext {
  api: LamaSyncApiClient;        // from api.ts buildClient()
  hostname: string;
  socketPath: string;
  setStatus: (msg: string) => void;
  openWizard: (wizard: Wizard) => void;
}
export interface View {
  readonly id: ViewId;
  readonly title: string;              // tab label
  readonly container: Renderable;      // built once in constructor/mount
  hotkeys(): Hotkey[];                 // drives footer + dispatch
  onShow(ctx: ViewContext): void;      // refresh data + focus primary widget
  onHide?(): void;
  handleKey?(keyName: string): boolean; // true = consumed
  destroy?(): void;
}
export class ViewManager {
  register(view: View): void;
  show(id: ViewId): void;              // hides others via container.visible=false, calls onHide/onShow
  activeId(): ViewId;
  active(): View;
}
```

```ts
// app/wizard.ts
export interface WizardStep {
  title: string;
  render: (state: Record<string, unknown>) => Renderable;  // Select or Input based
  validate?: (state) => string | null;                     // error msg or null
  onKey?: (keyName: string, state) => boolean;
}
export interface Wizard {
  title: string;
  steps: WizardStep[];
  onFinish: (state) => Promise<string>;   // returns status-bar message
  onCancel?: () => void;
}
```

### 2.4 Shell & global key dispatch (the invariants — DO NOT regress LAMA-167)

`app/shell.ts` owns the one global handler `renderer.keyInput.on("keypress")`. Dispatch order:

1. **Active wizard** (if any) gets the key first. ESC = step back (or cancel on first step). Enter only via the wizard's own Select/Input handlers.
2. **Active view's `handleKey`** for view-internal keys.
3. **Active view's `hotkeys()`** via `matchHotkey`.
4. **Global keys**: `1..5` and `[` / `]` switch tabs; `?` toggles a help overlay; `q` quits **only when no Input/Textarea is focused**; ESC from any view with no wizard does nothing (tabs are top-level — no "back to menu" anymore).

Hard invariants to encode + document in code comments:
- **Never** handle Enter in the global dispatcher. Enter belongs to the focused widget (`Select.itemSelected`, `Input.onSubmit`).
- **Never** destroy/rebuild the tree on navigation. Views build their container once; `ViewManager.show` only toggles `container.visible` and calls lifecycle hooks.
- Each view **explicitly focuses its primary widget in `onShow()`** (typed reference held by the view — no `any` walker, no `process.nextTick` hack; delete `focusFirstSelect`).
- Keep `createCliRenderer({ exitOnCtrlC: true, autoFocus: true })`.
- **No `console.log` anywhere in TUI runtime code** (stdout is the terminal) — user feedback goes to the status bar via `ctx.setStatus()`.
- TabSelect bar: when the user presses left/right **while the tab bar itself is focused**, it cycles tabs; global `1..5`/`[`/`]` work regardless of focus.

### 2.5 View-by-view refactor

- **menu.ts → deleted.** Tabs replace it. `q` quits from the shell.
- **local.ts → `LocalView`.** Keep socket actions (sync-all, sync-one, cache-profile, switch-type, network-shares) and pure helpers (`describeFolder`, `nextCacheProfile`, `buildFstabLine` — keep their unit tests passing). Hotkeys declared once in the view (footer + dispatch read the same array). Add `n` = open backup-setup wizard.
- **fleet.ts → `FleetView` + `app/fleet-service.ts`.** WS subscription (currently `openFleetSubscription`, fleet.ts:109-159) moves to app level, started once at boot, feeding a hosts `Map`; FleetView renders from it and shows live/offline in the status bar. Hosts list in a `ScrollBox` or keep `Select` if simple.
- **logs.ts → `LogsView`.** Render into a **`ScrollBox`**; make `n`/`p` pagination real (offset already supported by `fetchLogPage`, logs.ts:99-102); remove stale comment at logs.ts:40-44.
- **conflicts.ts → `ConflictsView`.** Fix the selected-row bug (conflicts.ts:86): `l`/`r`/`b` resolve the **highlighted** conflict via `Select.getSelectedOption()`/index; add a confirm step; add Conflicts to the tab bar.
- **dotfiles.ts → `DotfilesView`.** Keep the restore state machine (`Step` union, dotfiles.ts:31) but render into a persistent container; eliminate throwaway partial controllers (dotfiles.ts:343-348, 353-357, 394-398, 458-462, 493-497); add `n` = open dotfile-manifest wizard.
- **gh-selector.ts → `GhView`.** Collapse the 5 duplicated render sites (index.ts:730-931) into one render path driven by controller state.

### 2.6 Guided flows (wizards)

**Backup setup** (`flows/backup-setup.ts`), entry: `n` in Local view:
1. Folder name (Input) → 2. type: `sync` | `backup` (Select) → 3. local path (Input) → 4. role: `source` | `target` | `both` (Select) → 5. schedule preset (Select: custom cron / hourly / 6h / daily / weekly / monthly / `@reboot` / `@login` — mirror the web-UI preset table in `packages/web-ui/src/pages/Dotfiles.tsx:27-36`; custom → extra Input step) → 6. confirm summary →
`client.createFolder(...)` (api-client.ts:187) then `client.assignFolder(...)` (api-client.ts:219) for the current host → status bar "created + assigned". Errors surface in the wizard (validate) or status bar, never crash.

**Dotfile manifest** (`flows/dotfile-manifest.ts`), entry: `n` in Dotfiles view:
1. app name → 2. host: global vs specific host (Select from `getHealth().hosts`) → 3. paths (comma-separated Input) → 4. excludes (Input, optional) → 5. schedule preset (same preset list incl `@reboot`/`@login`) → 6. instructions (Input, optional) → 7. confirm →
`client.createDotfileManifest(...)` (api-client.ts:257).

API surface needed already exists — verified: `createFolder`, `assignFolder`, `createDotfileManifest`, `updateDotfileManifest`, `resolveConflict`, `getHealth` (`packages/core/src/api-client.ts`).

### 2.7 Testing strategy

- **Unit (pure):** `matchHotkey` dispatch; wizard state machine (step forward/back/validate/finish); schedule-preset mapping helper (share one preset table between both wizards); `ViewManager` show/hide/visible logic with mock views.
- **Renderer smoke tests** via `@opentui/core` testing module (`createTestRenderer` + `mock-keys`): shell boots and renders tab bar + footer; pressing `2` switches to Fleet (assert `visible` flags); focus works after tab switch without simulated click; wizard opens, ESC closes.
- Keep all existing TUI tests green (`packages/tui/src/index.test.ts` — `describeFolder` cases).
- Note: smoke tests need the OpenTUI native renderer for linux-x64 — it is installed (`@opentui/core-linux-x64@0.1.107`); if `createTestRenderer` proves flaky in CI, gate these tests behind an env flag and keep pure unit tests mandatory.

### 2.8 Constraints / conventions (repo rules the agent must follow)

- Imports use `.ts` extensions; no `any`/inline casts — type focusables properly.
- No new runtime dependencies. Everything from `@opentui/core` + `@lamasync/core` only.
- Keep `--version`/`-V`, `LAMASYNC_NO_TUI=1` CLI fallback, and renderer-init-failure fallback to CLI exactly as today (index.ts:85-106).
- `bun build --compile` must still produce `dist/lamasync-tui`.
- After changes: `bun x tsc --noEmit` clean, `bun test` green, then update `AGENTS.md` (TUI section in "Repository layout", test counts, implemented-features table, and the "TUI" gaps subsection — the unification closes several listed gaps) and comment on LAMA-173 in Multica.

---

## 3. Execution steps (ordered)

0. **Copy this plan** to `docs/plans/LAMA-173-tui-unification.md` in the repo (new dir).
1. `app/theme.ts` + `app/widgets.ts` — extract shell/footer/rows/tri-state from the 7 view files (pure dedupe, no behavior change).
2. `app/keymap.ts` + `app/view-manager.ts` + unit tests.
3. `app/shell.ts` — layout, TabSelect, status bar, global dispatch with §2.4 invariants.
4. Refactor **Local** + **Logs** onto the framework (Logs gets `ScrollBox` + real pagination).
5. **fleet-service.ts** + refactor **Fleet**.
6. Refactor **Conflicts** (selected-row fix, confirm step, add tab).
7. Refactor **Dotfiles** restore flow (persistent container, no throwaway controllers).
8. Refactor **GH selector** (single render path).
9. `app/wizard.ts` + shared schedule-preset table + **backup-setup** and **dotfile-manifest** flows.
10. Rewrite `index.ts` as slim entry (boot Shell; keep CLI fallback + config-error screen).
11. Renderer smoke tests; `bun x tsc --noEmit`; `bun test`; manual run of the real TUI (`bun run dev:tui`) and CLI fallback.
12. Update `AGENTS.md`; Multica: comment on LAMA-173 and move it to review/done.

## 4. Acceptance criteria

- All five views reachable from one screen via the tab bar; consistent ESC/q semantics; footer always shows the active view's hotkeys.
- No destroy/rebuild on navigation; arrow keys work immediately after every tab switch (no click, no nextTick hack).
- Logs view scrolls; pagination works.
- Conflicts `l`/`r`/`b` resolve the highlighted row.
- `n` in Local creates a backup folder + assignment end-to-end; `n` in Dotfiles creates a manifest; both validate input and report via the status bar.
- `bun x tsc --noEmit` clean; `bun test` green (incl. new unit + smoke tests); `bun run build` produces `lamasync-tui`.

## 5. Risks / watch-outs

- **TabSelect focus interplay** with global keys — covered by invariant "never handle Enter globally" + smoke tests.
- **ScrollBox inside the bordered shell** — verify `flexGrow` layout so the footer stays pinned; check the ScrollBox `d.ts` for required height constraints.
- **Wizard overlay + key dispatch** — wizard must swallow keys while open (dispatch order §2.4), otherwise the underlying view's hotkeys leak through.
- Don't regress the LAMA-167 fixes; keep the explanatory comments where the invariants live.
