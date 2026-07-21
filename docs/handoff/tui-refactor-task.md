# Task: Fix LamaSync TUI interactivity (OpenTUI VNode model refactor)

**Type:** mechanical refactor, no investigation needed
**Estimated effort:** 1–2 hours for a junior agent
**Priority:** high — the released TUI (v0.2.1) crashes at boot; master renders but is non-interactive
**Repo:** `/home/messhias/LamaFiles/projects/lamasync` (Bun workspace, TypeScript)

---

## 1. Problem statement

The LamaSync TUI (`packages/tui`, LAMA-173) renders its tabbed shell but is
completely static: no key re-renders, no view switching, no content updates.
The v0.2.1 release binary additionally crashed at boot with a silent
`TypeError: {} is not iterable` (that part is already fixed on master).

## 2. Root cause (verified, do not re-investigate)

OpenTUI (`@opentui/core`) `Box()`, `Text()`, `Select()` etc. return **VNode
blueprint proxies**, not live components. Calling methods on a proxy queues
the call in an internal `__pendingCalls` array, which is replayed **exactly
once** when the tree is instantiated (the moment it is added to
`renderer.root`). After that, the proxy is permanently dead:

- `proxy.add(...)`, `proxy.remove(...)` → silently queued, never rendered
- `proxy.getChildren()` → returns the proxy object itself, NOT an array
  (iterating it throws `TypeError: {} is not iterable`)
- `proxy.options = ...`, `proxy.visible = ...` → silently dead

**Verified in both 0.1.107 (pinned) and 0.4.5 — do NOT upgrade OpenTUI; the
model is the same.** Upgrading is wasted effort.

The views in `packages/tui/src/views/*` hold these proxies
(`ProxiedVNode<...>` fields: `bodyBox`, `statusBlock`, `selectRef`,
`container`) and mutate them after mount. Every post-mount mutation is dead.

## 3. The fix pattern (verified working in a pty harness)

```ts
import { createCliRenderer, Box, Text, instantiate, isRenderable } from "@opentui/core";

const renderer = await createCliRenderer({ exitOnCtrlC: true });

// WRONG — current code:
const body = Box({ flexDirection: "column" });
renderer.root.add(body);
body.add(Text({ content: "x" }));        // dead, never renders

// RIGHT — instantiate to a REAL renderable, then mutate it:
const body = instantiate(renderer, Box({ flexDirection: "column" }));
renderer.root.add(body);                  // isRenderable(body) === true
const t = instantiate(renderer, Text({ content: "x" }));
body.add(t);                              // renders live; body.getChildren() === [t]
```

Facts:

- `instantiate` is exported from `@opentui/core`.
- `CliRenderer implements RenderContext` — pass the renderer as the first arg.
- `instantiate(ctx, vnode)` recursively handles children; VNode children that
  are already real renderables (`isRenderable(child)`) are added as-is. So a
  static VNode container tree can embed real renderable boxes directly.
- Real renderables have a working `getChildren(): Renderable[]`, `add`,
  `remove(id: string)`, property setters (`visible`, `options`, ...).

## 4. Step-by-step implementation

The renderer is created in `packages/tui/src/boot.ts` **before** the views —
pass it down.

### 4.1 Plumbing

1. `packages/tui/src/app/view-manager.ts`: add `renderer: CliRenderer` to the
   `ViewContext` interface (import type from `@opentui/core`).
2. `packages/tui/src/boot.ts`: include `renderer` in the `ctx` object it
   already builds, and pass `renderer` (or the ctx) to every view constructor
   that currently takes no/limited args: `LocalView`, `FleetView`,
   `ConflictsView`, `LogsView`. (`DotfilesView`, `GhView` already take
   `{ ctx }` — they can read `ctx.renderer`.)

### 4.2 Per-view changes (same pattern in all six views)

For every field currently typed `ProxiedVNode<typeof BoxRenderable>` /
`ProxiedVNode<typeof SelectRenderable>` that is **mutated after mount**:

- Construct it as a real renderable instead:
  `this.bodyBox = instantiate(renderer, Box({ flexDirection: "column", flexGrow: 1 }))`
  typed `BoxRenderable`; selects as `SelectRenderable`.
- Static wrapper trees (`pageShell`, header/footer boxes that never change)
  may stay VNodes — put the real renderables inside them as children;
  `instantiate()` adds them as-is.
- The view's `container` field MUST be a real renderable too (see 4.3).
- Replace the `ChildTracker`/`replaceChildren` usage with direct real-instance
  mutation:
  ```ts
  for (const child of this.bodyBox.getChildren()) this.bodyBox.remove(child.id);
  for (const vnode of next) this.bodyBox.add(vnode); // add() instantiates VNodes
  ```
  (The tracker in `app/widgets.ts` may be deleted once unused.)
- Select widgets: set options on the real instance
  (`this.selectRef.options = rows` works once `selectRef` is a real
  `SelectRenderable`).

Views: `local.ts`, `fleet.ts`, `dotfiles.ts`, `conflicts.ts`, `logs.ts`,
`gh-selector.ts`. Note `logs.ts` also has a `scrollBox` — same treatment if
mutated. `conflicts.ts` `replaceRoot()` mutates `this.container` — container
must be real (4.3) and then `getChildren()` works on it.

### 4.3 View containers + view switching

`ViewManager.show()` toggles `container.visible` — dead on proxies, which is
why tab switching doesn't work.

- Each view: `this.container = instantiate(renderer, pageShell(...))` typed
  `Renderable`.
- `app/view-manager.ts` `setContainerVisible()` then works unchanged.

### 4.4 Shell

`packages/tui/src/app/shell.ts`:

- `tabBar`: if `setOptions`/`setSelectedIndex`/`setSelected` are called after
  mount, instantiate it as a real `TabSelectRenderable` the same way.
  (Calls made before `renderer.root.add(layout)` are fine either way.)
- Keep the current order: `renderer.root.add(layout)` **before**
  `manager.show(startView)` (already committed).

### 4.5 Wizard

`packages/tui/src/app/wizard.ts` already tracks children locally (correct).
Verify `scratchHost`/`bodyHost`/`modal`/`overlayHost` are real renderables or
only touched before mount; apply the same instantiate pattern where mutated
after mount.

### 4.6 Tests

- `bun x tsc --noEmit` and `bun test` must stay green (currently 188 pass).
- View factories in `dotfiles.ts` / `conflicts.ts` that construct views for
  tests need the new constructor arg; pass a stub (constructors should not
  require a live renderer unless they instantiate — if they do, gate or
  accept `renderer | null` and skip instantiate when null, matching the
  existing test style).
- If you add renderer-bound tests, gate them behind
  `process.env.LAMASYNC_TUI_TEST_VIEWS === "1"` (existing convention).

## 5. Verification

Automated smoke (pty harness that answers terminal queries — recreate from
this doc's appendix if /tmp was cleared):

```bash
python3 /tmp/pty_driver3.py bash -c 'cd ~/LamaFiles/projects/lamasync && bun packages/tui/src/index.ts'
# Expect: "TIMEOUT: still alive" (no crash), then in the capture:
# tab titles (Local/Fleet/Dotfiles/Conflicts/Logs/Gh) visible in the output.

python3 /tmp/pty_keys.py bash -c 'cd ~/LamaFiles/projects/lamasync && bun packages/tui/src/index.ts'
# Expect: output AFTER each injected key (frame updates on Tab/2/Right/r).
```

Manual acceptance on a real terminal:

```bash
cd ~/LamaFiles/projects/lamasync && bun install && bun run dev:tui
```

- [ ] Tab bar renders with all six views
- [ ] Left/right (or `[`/`]`) switches views; content changes
- [ ] Local view shows folder list or "(no folders configured)"
- [ ] Hotkeys (`1`, `2`, `3`) update the status line
- [ ] `q` quits; Ctrl+C quits
- [ ] Wizards open on `w` (local) and restore flow in dotfiles view

Then rebuild + release: bump `package.json` patch version, run
`scripts/gen-version.ts`, `bun run build`, commit, tag `vX.Y.Z`, push — CI
publishes release assets.

## 6. Do NOT

- Do not upgrade `@opentui/core` (model is identical in 0.4.5; verified).
- Do not iterate `getChildren()` on `ProxiedVNode` proxies (returns the
  proxy, throws).
- Do not chase the renderer for input bugs: keypress delivery works (proven);
  the failure was dead mutations, not input.
- Do not remove `LAMASYNC_NO_TUI=1` CLI fallback.

## 7. Appendix: debug tooling used (recreate if needed)

- `/tmp/pty_driver3.py` / `/tmp/pty_keys.py`: Python pty harnesses that answer
  OSC 4/10/11, DECRQM, CPR, pixel-size and kitty-keyboard queries like a real
  terminal, and (keys variant) inject keys on a timer. ~80 lines each; the
  important part is answering `ESC[6n`→`ESC[24;80R`,
  `ESC]4;0;?`→`ESC]4;0;rgb:3b3b/4242/5252\x07`, `ESC[?NNNN$p`→`ESC[?NNNN;2$y`.
- `LAMASYNC_DEBUG_KEYS=1` env var makes `app/shell.ts` write every keypress
  to stderr (already committed).
- OpenTUI installs its own `uncaughtException` handler that prints into the
  captured alt-screen console — fatal errors look "silent". To see them,
  preload `process.on("uncaughtException", e => writeSync(2, e.stack))`.

## 8. Current repo state (commit 7fd202f)

- Boot crash fixed; shell renders; mutations still dead (this task).
- `docs/handoff/tui-opentui-fix.md` — investigation log with the same
  conclusions plus pty-capture evidence.
- `docs/handoff/client-testing.md` + `scripts/e2e-sandbox/` — unrelated
  client e2e sandbox, passing.
