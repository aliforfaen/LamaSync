# Handoff — Workstream 3: TUI foundations

**Date:** 2026-08-08
**Source:** UX audit at `.memsearch/memory/2026-08-08-webui-tui-ux-audit.md`
("TUI — key findings / prioritized gaps"); its claims about the TUI were
re-verified against the current tree for this document — see the
**Corrections** note below.
**Prerequisite state:** workstreams 1–2 are implemented, reviewed, and
**committed** (`5094bbb`). Working tree is clean except local memory files.
Gate green: `bun x tsc --noEmit` clean, `bun test` → 440 pass / 0 fail.

## Mission

Make the TUI (`packages/tui`, an OpenTUI tabbed shell) usable by a brand-new
user without reading source code:

1. A configured first run — no silent fallback to `localhost:8080`/`dev-key`.
2. Discoverable controls — a `?` help overlay for global keys plus per-view
   hotkey footers everywhere.
3. Friendly errors — common failures translate to actionable advice.
4. Fix the known bugs: Fleet never goes live, `q` swallowed on the Conflicts
   tab, stale Logs footer, raw JSON dumped in the status bar.

Everything is TUI-only. Server/daemon/core/web-ui are out of scope.

## Corrections to the audit (verified this session — follow THIS document)

- **Logs DOES render a footer** (`views/logs.ts:209`), but from a **stale
  module-level `HOTKEYS` constant** (`logs.ts:47-53`) that includes a `[q]
  quit` entry while the actual dispatch uses `hotkeys()` (`logs.ts:219-226`),
  which has no `q`. The footer and the dispatch disagree — that's the bug,
  not a missing footer.
- **Conflicts has NO footer** and is the only view without one (its container
  is built at `views/conflicts.ts:112-120`; the body inlines key hints).
- **`q` swallowed on Conflicts**: `views/conflicts.ts:151-154` — the view's
  `handleKey` returns `true` for `q`, so the Shell's quit step
  (`app/shell.ts:187`) never runs while the Conflicts tab is active. The
  comment says it mirrors a pre-unification "return to menu" that no longer
  exists. This is a real bug — you cannot quit with `q` from that tab.
- **`fleetService.start()` is never called** (`boot.ts:77` creates the
  service; `boot.ts:56` closes it; nowhere does anything call `start()`), so
  the Fleet view always shows "polling" and never goes live.
- The audit's "no `?` help, no first-run setup, raw error strings" claims are
  all still accurate.

## Repo orientation (packages/tui)

- `boot.ts` — boot sequence: `buildClient()` → renderer → view instances →
  `Shell` mount. Views are `LocalView`, `FleetView`, `DotfilesView`,
  `ConflictsView`, `LogsView`, `GhView`.
- `app/shell.ts` — Shell owns the layout (tab bar, content pane, status bar)
  and the global key dispatcher `dispatchKey` (steps: cycle `[`/`]` →
  wizard → `q` quit → view-local → numeric tabs). `setStatus(msg, kind)`
  writes the status bar with `[!]`/`[ok]`/`[i]` prefixes. `getLayout()` adds
  overlay UI (used for wizard modals).
- `app/wizard.ts` — `WizardRunner`; wizards already render their own footer
  (`[Esc back] [Enter next] [q cancel]`).
- `app/widgets.ts` — `hotkeyFooter(items)` renders `[k] label` rows; used by
  Local, Fleet, Dotfiles, Gh.
- `app/fleet-service.ts` — `createFleetService(url, key)` returns a service
  with `start()` / `close()` / `hosts` / `status`; `status` is `"live"` only
  after `start()` opens the socket.
- `api.ts` — `buildClient()`: env vars → `~/.config/lamasync/client.toml` →
  silent defaults `http://localhost:8080` / `dev-key`. `CONFIG_PATH` constant
  here.
- `views/*.ts` — each view implements the `View` contract (see
  `app/view-manager.ts`): `container`, `hotkeys()`, `onShow`, `handleKey`.
- `socket-client.ts` — daemon socket calls used by Local view (sync,
  switch-to-mount, etc.).

### Conventions you must obey

- Imports use `.ts` extensions.
- No `any` or inline casts — `unknown` + narrowing + type guards (the codebase
  already has guards like `isHost` in fleet-service.ts — copy that idiom).
- No `console.log` in library code.
- Tests: `bun:test`, `*.test.ts` beside source. TUI has existing tests
  (wizard, shell) — **add, never replace** (workstream-1 review lesson).
- Minimal diffs. Match surrounding comment density and structure idioms
  (each view is self-contained; don't introduce new abstractions).
- Keep copy one sentence per hint; no emoji (fix the one existing emoji —
  see Phase 5).

### Verification commands

```bash
bun x tsc --noEmit                  # type check — must stay green
bun test                            # full suite (no web dist needed for TUI-only changes, but harmless)
# Manual smoke (headless-safe):
LAMASYNC_NO_TUI=1 bun run --filter @lamasync/tui build   # CLI fallback still compiles
bun run dev:server 2>/dev/null &     # plus a second terminal for the real TUI if possible
```

## Execution protocol

1. Phases 1 → 6 in order; check each **"Done when"** before moving on.
2. Run `bun x tsc --noEmit` after every phase; the full `bun test` gate after
   phase 6.
3. No git mutations (no commit/push/reset). Leave the tree dirty.
4. When done: append a dated "done" note to
   `.memsearch/memory/2026-08-08-webui-tui-ux-audit.md` and update
   `docs/features.md`.

## Lessons from earlier reviews (don't repeat)

- Never replace an existing test — add alongside.
- Keep JSDoc blocks attached to their function.
- State keyed on entity ids, not names.
- Single source of truth for hotkeys: a view's `hotkeys()` must be the ONLY
  list that both renders the footer and drives dispatch (that's exactly what
  Local/Fleet/Dotfiles/Gh do; Logs violates it with the `HOTKEYS` constant).
- Every async handler catches into a friendly status/error — no raw
  `API error 500: {...}` or `TypeError: fetch failed` strings in the UI.

---

## Phase 1 — First-run setup flow (no more silent defaults)

1. `api.ts` — `buildClient()` should distinguish "configured" from "defaults
   fallback". Extend `TuiClient` with `needsSetup: boolean` (`true` when
   neither env vars nor a parseable config file provided credentials — i.e.
   the current lines 48-52 branch, and the parse-error branch at 37-45 which
   is ALSO a setup situation). Keep the existing fallback client so the rest
   of the boot path still type-checks; the setup screen replaces the shell,
   not the client.
2. New `setup.ts` (or `flows/setup.ts`) — a small interactive flow using the
   existing `WizardRunner` (see `flows/backup-setup.ts` for the pattern —
   steps with `title`/`description`/`input`/`confirm`):
   - Step 1: server URL (prefill `http://localhost:8080`).
   - Step 2: API key (input, echo off if the wizard supports it, else note it
     in the description — do NOT print the key in the confirm step).
   - Step 3: hostname (prefill `hostname -s` semantics — `os.hostname()`).
   - Step 4: confirm → write `~/.config/lamasync/client.toml` (the
     `CONFIG_PATH` constant in `api.ts`) as a minimal TOML with exactly
     `serverUrl`, `apiKey`, `hostname` (match `config-examples/client.toml`
     field names; escape double quotes/backslashes in values). Create the
     `~/.config/lamasync/` directory. On success, rebuild the client from the
     written file and continue boot.
   - A "skip / use defaults" escape hatch with a warning ("you'll point at
     http://localhost:8080 with key dev-key — configure a real server URL
     soon").
3. `boot.ts` — after `buildClient()`, if `tui.needsSetup` is true, run the
   setup flow BEFORE constructing the views/shell; on success re-build the
   client and continue; on skip, proceed with the default client but set an
   initial status message pointing at `client.toml` / env vars.
4. Unit tests: the pure parts — TOML writing (round-trips through
   `parseClientConfig`), `needsSetup` detection (env present / file present /
   neither). Keep I/O in small injectable functions so tests don't touch the
   home dir.

**Done when:** with no env vars and no config file, the TUI boots into the
setup flow; completing it writes a valid `client.toml`; skipping boots with a
visible warning status. Tests cover the pure parts. `tsc` green.

## Phase 2 — `?` help overlay + global key hints

5. `app/shell.ts` — add a `?` key to `dispatchKey` (handle it BEFORE the
   wizard step? No — wizards own input while mounted; put it after the wizard
   step and before the `q` quit step, i.e. right after the
   wizard/escape block): toggling a help overlay. The overlay is a Box added
   to `this.layout` (same mechanism as wizard modals via `getLayout().add`),
   showing:
   - Global keys: `[`/`]` cycle views, `1`-`6` jump to tab, `?` help, `q`
     quit, `Esc` cancel wizard/close help.
   - The ACTIVE view's hotkeys from `this.manager.active().hotkeys` (render
     labels only; don't dispatch).
   - `?` or `Esc` closes it. When open, all other keys are ignored
     (`return true`).
6. While you're in the Shell: add a persistent one-line hint under the tab
   bar (or into the status bar's idle state): `[?] help  [ ]/[ ] views  [q]
   quit` — use the actual key chars, no emoji. Keep it subtle (muted text).
7. `views/conflicts.ts` — give the live view a footer: include
   `hotkeyFooter(this.hotkeys().map(...))` in its container (copy the exact
   pattern from `views/local.ts:263-271` or `views/fleet.ts:257-266`).

**Done when:** pressing `?` on any tab shows the overlay with global + current
view keys; `?`/`Esc` close it; every view now has a footer (Local/Fleet/
Dotfiles/Gh/Conflicts, and Logs after Phase 3's single-source fix). `tsc`
green.

## Phase 3 — `friendlyError()` + Logs footer single-source + `q` fix

8. New `friendly-error.ts` (TUI package) — one pure function
   `friendlyError(err: unknown, context?: { serverUrl?: string; action?: string }): string`
   mapping the common cases:
   - API 401 (`API error 401` in the message) → "API key rejected — check
     LAMASYNC_API_KEY or ~/.config/lamasync/client.toml".
   - `fetch failed` / `ECONNREFUSED` / `ENOTFOUND` / network-y messages →
     `server unreachable at <serverUrl> — is it running? tailnet up?` (omit
     the URL when unknown).
   - daemon-socket failures (`ENOENT` / `connect` on the socket path) →
     "daemon not running — start lamasyncd (systemctl --user start lamasyncd)".
   - `rclone` not found / spawn `ENOENT` rclone → "rclone not installed or
     not on PATH".
   - anything else → the original message (trimmed to one line).
   Unit-test the mappings (pure string in → string out).
9. Apply it at the TUI's catch sites instead of raw `err.message`:
   `views/local.ts` (~:351, :372-375), `views/fleet.ts` (~:311-313),
   `views/dotfiles.ts` (~:292-298), `views/conflicts.ts` (~:198-202),
   `views/logs.ts` (~:273-278), and the Shell's hotkey error handler
   (`app/shell.ts:201-204`). Each site passes its context (server URL /
   action) where available. Do NOT touch web-ui or the core API client.
10. `views/logs.ts` — delete the module-level `HOTKEYS` constant
    (`logs.ts:47-53`) and the footer function's dependency on it
    (`logs.ts:105-111`): render the footer from `this.hotkeys()` exactly like
    Local/Fleet do (`this.hotkeys().map((h) => ({ key: h.key, label:
    h.label }))`).
11. `views/conflicts.ts` — remove the `if (char === "q") { ... return true;
    }` block (`:151-154`) so `q` falls through to the Shell's quit. The `x`
    cancel hotkey stays. Also update the "Press Esc or q to return to menu."
    placeholder text (now just "Press x to cancel the current selection." —
    check what the state actually does first).
12. `views/local.ts` — the switch-type success path (~:460-462) dumps raw
    `JSON.stringify(data)` into the status bar; replace with a friendly
    summary (e.g. `switched <folder> to mount` / `to sync`).

**Done when:** `?` overlay and all footers render; `q` quits from the
Conflicts tab; a stopped daemon / dead server shows an actionable message;
unit tests cover `friendlyError`. `tsc` green.

## Phase 4 — Fleet goes live

13. `boot.ts` — call `fleetService.start()` once the renderer is running
    (after `renderer.start()` at `boot.ts:150`, or right before `shell.start()`
    — pick the spot where the status header can reflect `live` on first
    paint). Verify `views/fleet.ts` reflects `service.status` ("live" vs
    "polling") in its header; if it only ever shows the polling label, wire
    it to `service.status` (read it on each render cycle — Fleet already
    polls/refreshes periodically).
14. `app/fleet-service.ts` — the socket's error/close path currently swallows
    failures silently (`start()` catches construction, but no `error`/
    `close` handlers). Add a minimal `error` listener that flips the status
    to `offline` (no UI text needed here — the Fleet view already shows the
    status).

**Done when:** with a live server, the Fleet header shows "live" after boot;
with no server, it stays/becomes "offline" without crashing. `tsc` green.

## Phase 5 — Wizard & copy polish (small)

15. `flows/backup-setup.ts` — validation messages are bare
    (`name required`, `localPath required`, `cron expression required`,
    ~:61-65, :173-177). Improve: "name is required", "localPath must be an
    absolute path (starts with /)" — add an absolute-path check — and for
    cron show the format hint ("5-field cron, e.g. 0 * * * * = hourly").
    Add a cron format sanity check (5 fields, numeric ranges per field) in
    the wizard step validation — plain function, unit-testable.
16. `views/dotfiles.ts` — the "Setup (restore all apps)" row label uses an
    emoji (`~:530`); drop the emoji to match the rest of the UI.

**Done when:** wizard rejects a relative localPath with a clear message; cron
format is validated; no emoji in TUI strings. Tests cover the validators.
`tsc` green.

## Phase 6 — Docs & memory

17. `docs/features.md` — row: TUI foundations (first-run setup, help overlay,
    friendly errors, fleet live status, footer/q fixes).
18. Append a dated "done" note to
    `.memsearch/memory/2026-08-08-webui-tui-ux-audit.md` listing shipped
    items + what remains (workstreams 4-5).

**Done when:** gate green (`bun x tsc --noEmit` + `bun test`), both docs
updated.

---

## Known pitfalls

- The Shell `dispatchKey` order matters: `?` must not be swallowed by a
  view's own hotkeys (views only handle keys in their own `hotkeys()`, so
  `?` is safe if handled in the Shell before the quit step; double-check the
  order in `app/shell.ts:156-220`).
- `fleetService` is referenced in `onDestroy` before its `const` declaration
  (`boot.ts:56` vs `:77`) — a closure, fine at runtime. Don't "fix" it by
  moving the declaration (would reorder the createRenderer dependency); if
  you move it, keep the closure timing identical.
- Wizard input steps echo input; do not add a password-mask feature — just
  don't echo the key in confirm/description text (Phase 1 note).
- TUI tests run headless — the ViewManager real-renderer test is skipped
  (`1 skip`); don't write tests that need a real terminal. Keep new tests to
  pure functions (friendlyError, validators, TOML writing).
- Do not touch `packages/core`'s `parseClientConfig` unless strictly needed —
  the setup writer must produce output it can parse, not change it.

## Out of scope (do not drift)

- Web UI / server / daemon / core changes (workstreams 1-2 already shipped)
- TUI↔web parity features (backends management in TUI, notifications, etc.)
- Visual redesign of the TUI beyond the small copy fixes here
- Validation hardening on the web side
- Dotfile diff preview (listed in the audit as a TUI limitation — separate
  feature, not this pass)
