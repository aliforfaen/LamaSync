# TUI fix handoff — OpenTUI VNode model mismatch (LAMA-173)

Status: **root cause proven, fix pattern proven, refactor NOT yet applied.**
Date: 2026-07-21

## TL;DR

OpenTUI `Box()`/`Text()`/`Select()` return **one-shot blueprint VNodes**, not
live refs. Method calls on them are queued in `__pendingCalls` and replayed
**exactly once** when the tree is instantiated (on `renderer.root.add(...)`).
After that the proxy is dead: `add`/`remove`/`getChildren`/`options=`/`visible=`
mutations silently do nothing. This is true in **both 0.1.107 and 0.4.5** —
upgrading OpenTUI does NOT fix it.

LAMA-173's views hold `ProxiedVNode` refs and mutate them after mount, so:

1. `LocalView` constructor called `renderBody()` → `getChildren()` returns the
   proxy wrapper object → `for...of` throws `TypeError: {} is not iterable`
   → **crash at boot** (v0.2.1 release binary dies instantly in every terminal;
   the fatal message is swallowed because OpenTUI registers its own
   `uncaughtException` handler that prints into the captured alt-screen
   console, and query responses like `4;0;rgb:3b3b/4242/5252` echo on screen
   after the process dies).
2. After the crash fix, the UI renders the initial tree but is **static**:
   every post-mount mutation (re-renders, view switching via `visible`,
   select `options=`) goes to dead proxies.

## What's already committed in this state (the crash fix, keep it)

- `views/local.ts`, `views/fleet.ts`, `views/logs.ts`: first render moved from
  constructor to `onShow()` (dotfiles/gh-selector already had this).
- `app/widgets.ts`: `createChildTracker()` / `replaceChildren()` helper that
  tracks children locally instead of iterating `getChildren()`.
- All six views use the tracker instead of `getChildren()` loops.
- `app/shell.ts`: `renderer.root.add(layout)` before `manager.show(startView)`.

These stop the boot crash (verified in pty harness: process stays alive,
`bun run dev:tui` renders the tab bar on a real terminal — confirmed by user).

## The proven fix pattern (verified in scratch pty harness)

```ts
import { createCliRenderer, Box, Text, instantiate, isRenderable } from "@opentui/core";
const renderer = await createCliRenderer({ exitOnCtrlC: true });

// WRONG (current code): mutating the VNode proxy after mount — dead
const body = Box({ flexDirection: "column" });
renderer.root.add(body);
body.add(Text({ content: "x" }));        // never renders

// RIGHT: instantiate to a REAL renderable, then mutate — works
const body = instantiate(renderer, Box({ flexDirection: "column" }));
renderer.root.add(body);                  // isRenderable(body) === true
const t = instantiate(renderer, Text({ content: "x" }));
body.add(t);                              // renders; body.getChildren() === [t]
```

`CliRenderer implements RenderContext`, so `instantiate(renderer, vnode)` is
the call. `instantiate()` is exported from `@opentui/core` in both versions.

## Refactor plan (mechanical, ~6 views + shell + view-manager)

The renderer exists in `boot.ts` before views are constructed — pass it down.

1. **`ViewContext`**: add `renderer: CliRenderer`; `boot.ts` already has it.
2. **Each view constructor**: create mutable boxes as REAL renderables:
   `this.bodyBox = instantiate(renderer, Box({...}))`. Views taking no args
   today (`LocalView`, `FleetView`, `ConflictsView`, `LogsView`) need a
   renderer arg (or read it from the ctx object passed at construction).
   Static container trees can stay VNodes — `instantiate()` handles
   `isRenderable(child)` children natively.
3. **View containers**: must be real renderables too, because
   `ViewManager.setContainerVisible()` flips `container.visible` — dead on
   proxies → **view switching is broken** as well. Instantiate the pageShell
   container in the constructor.
4. **`replaceChildren` helper**: simplify back — real renderables have a real
   `getChildren()` (returns an array), so the tracker can go away, or keep it
   tracking real `Renderable`s. Children added via `realBox.add(vnode)` are
   auto-instantiated by `add`.
5. **Select widgets**: `selectRef.options = rows` — needs the real
   `SelectRenderable` (same instantiate pattern).
6. **`app/shell.ts` tabBar**: `setOptions`/`setSelectedIndex` after mount need
   a real `TabSelectRenderable`, or move calls before `renderer.root.add`.
7. **`app/wizard.ts`**: check `scratchHost`/`bodyHost` — same proxy hazard;
   it already tracks children locally (that part is correct).
8. **Tests**: `bun test` must pass; view factories in dotfiles/conflicts that
   construct views need the renderer arg. Renderer-bound tests stay gated
   behind `LAMASYNC_TUI_TEST_VIEWS=1`.

## Verification harness (already built, in /tmp — recreate if needed)

- `/tmp/pty_driver3.py` — pty that answers OSC/DECRQM/CPR queries like a real
  terminal; reports child exit vs alive.
- `/tmp/pty_keys.py` — same + injects keys (Tab, "2", Right, "r") on a timer.
- Proof scripts pattern: see "The proven fix pattern" above.
- Run: `python3 /tmp/pty_driver3.py bash -c 'cd <repo> && bun packages/tui/src/index.ts'`
  then grep the capture for expected tab/status text.

## Env notes

- `LAMASYNC_NO_TUI=1` → CLI fallback (always works, unaffected).
- `LAMASYNC_DEBUG_KEYS=1` → shell.ts logs every keypress to stderr (added
  during debugging; keep or remove).
- OpenTUI's renderer installs its own `uncaughtException` handler
  (`handleError`) that prints into the captured console — invisible in
  alt-screen. For debugging, preload `process.on("uncaughtException")` with
  `writeSync(2, ...)` (that captures what the default swallows).

## Also in this debugging session (unrelated fixes already released in v0.2.1)

- Install script self-contained + `update.sh` aligned with CI assets.
- v0.2.1 release published with `lamasyncd`, `lamasync-tui`,
  `lamasync-server`, `update.sh`.
- Docker sandbox: `scripts/e2e-sandbox/` passes end-to-end.
