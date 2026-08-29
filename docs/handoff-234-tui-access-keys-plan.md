# LAMA-234 — Deferred TUI access-key management

Implementation handoff, 2026-08-29.

## Goal

Finish the deferred terminal UI portion of LAMA-234 without weakening its
credential boundary, then leave the repository genuinely ready to push:

- a master or managed `admin` credential can manage managed keys and pair a
  device from the TUI;
- a `device` credential can identify itself but cannot enumerate, reveal,
  create, revoke, or pair credentials;
- no raw key is retained by the persistent TUI view, placed in status text,
  or written to a config file; and
- all required checks, including the currently known CLI-fallback test, pass
  with zero failures.

This is a TUI/client completion of the already shipped server, pairing, and
Web Admin work. It does not add a new server route or alter the managed-key
data model.

## Preflight and integration base

1. Start from current `master` and first integrate the completed security
   boundary commit:

   ```bash
   git cherry-pick ea3fc6d
   ```

   That commit restricts device assignment updates to mode-only, blocks device
   action enqueue/history, and closes cross-host dotfile metadata disclosure.
   Do not recreate its changes by hand.
2. Confirm the worktree is clean and record the baseline test result. The
   current known failure is `packages/tui/src/cli-fallback.test.ts`; it must be
   resolved, not accepted as a release exception. Reproduce it in a clean Bun
   process before touching the test, and determine whether the fault is test
   environment leakage or a real fallback-contract regression.
3. Keep this work in `packages/core` and `packages/tui` except for tests and
   documentation. No schema migration, auth-policy relaxation, daemon change,
   or Web UI rewrite belongs in this handoff.

## Product and security contract

### Entry point and navigation

Add **Access keys** to the existing `More` menu. It opens a hidden drill-in
view (`access-keys`) and Esc returns to `More`, matching the GitHub view
pattern. Do not add a seventh top-level tab: the task-oriented six-tab layout
must still fit at 80 columns.

The screen must preserve the established keyboard model:

- `Tab` can always move focus to/from the tab bar.
- When the tab bar is focused, Left/Right select tabs and Enter opens the
  selected tab.
- Inside the access-key view, Up/Down select rows; action hotkeys are handled
  by the view or its wizard. Directional keys must never be globally stolen
  while a list or input owns focus.

### Principal-aware screen states

Call `GET /auth/me` before loading the screen.

| Current principal | Screen behavior |
|---|---|
| `master` | Show the managed-key table and all actions. Label it clearly as the break-glass credential; it is not a list row and can never be revealed or revoked here. |
| managed `admin` | Show the managed-key table and all actions. |
| host-bound `device` | Show only credential kind, name, and bound host ID. Explain that device keys cannot manage fleet access and that an administrator must re-pair/revoke them. Do not request `/api-keys` after this result. |

An authorization failure at any admin-only action must be rendered with
`friendlyError`/the existing status mechanism, then return the view to its
safe non-secret state. Do not treat a 401/403 as an empty key list.

### Table and actions for master/admin

Render masked metadata only: label, kind, bound host (or `—`), created,
last-used, status, and fingerprint. The selected row exposes these actions:

- `c` — **Create admin key**. Prompt for a non-empty label, show a summary,
  and require an explicit confirmation before `POST /api-keys`.
- `p` — **Pair device**. Create a normal 10-minute pairing session and show
  the code, expiry countdown, and the exact next-device command:
  `lamasync register --server <server-url> --code <code>`. Poll the existing
  status endpoint every 10 seconds while visible; show used/expired state and
  offer a fresh code after expiry. An ASCII QR code is deliberately out of
  scope: the human-readable code is the supported terminal interaction.
- `r` — **Reveal selected key**. Only active managed keys may be revealed.
  First require a confirmation that the secret will be visible in terminal
  scrollback or recordings. Fetch only after confirmation.
- `x` — **Revoke selected key**. Prompt for an optional reason, then require a
  destructive confirmation naming the key and, for device keys, its bound
  host. Refresh the list after success.
- `R` — refresh the masked table.

The footer should advertise only actions valid for the selected row (for
example, no Reveal/Revoke on an already revoked key). Empty and loading states
must be usable at 80×24.

### Secret handling

Creation and reveal use one shared ephemeral secret panel/wizard:

- plainly say “save this now” and warn that terminals may retain scrollback;
- keep the secret in a private field owned only by the open panel;
- never put it in `setStatus`, a row, a log/error object, a TUI config write,
  or a thrown error message;
- clear the field before panel close, Escape/cancel, view hide, destroy, and
  any failed refresh; and
- require an acknowledgement (`Enter` / “I saved it”) to close. Do not attempt
  terminal clipboard integration or add a dependency for it.

Pairing codes are short-lived capabilities but are not managed API secrets;
still clear them and stop their poller on close/hide/destroy.

## Implementation sequence

1. **Shared client support**
   - Add typed `LamaSyncApiClient` methods for `getAuthMe`, `listApiKeys`,
     `createApiKey`, `revealApiKey`, and `revokeApiKey`, using the existing
     LAMA-234 core request/response types.
   - Add focused client tests for method/path/body correctness. Preserve the
     server's `Cache-Control: no-store` behavior; the client must not add a
     cache or logging layer.

2. **Pure TUI presentation helpers**
   - Add a small `packages/tui/src/access-keys.ts` module for principal
     classification, masked-row formatting, action availability, and safe
     countdown/status formatting. Keep secrets out of this module's returned
     display models.
   - Cover it with ordinary renderer-free unit tests, including revoked rows,
     device principal restrictions, and date/countdown boundaries.

3. **New hidden `AccessKeysView`**
   - Add `access-keys` to `ViewId`; implement
     `packages/tui/src/views/access-keys.ts` using the LAMA-173 view contract:
     construct the container once, use `realize()` for all post-mount-mutated
     nodes, and use `swapChildren()` for refreshes.
   - Register it in `boot.ts` as `hiddenFromTabBar: true` with `homeTab:
     "more"`; add an Access keys row and a non-conflicting hotkey in
     `views/more.ts`.
   - Use request-generation/active guards so a late response after hide or
     destroy cannot repaint the view or restore cleared sensitive state.

4. **Wizards and lifecycle safety**
   - Build create, reveal, revoke, and pair interactions with the existing
     `WizardRunner`/`openWizard` conventions. Enter is owned by the focused
     wizard control; `app/shell.ts` must not gain an Enter handler.
   - Store the pairing polling timer in the view/pair wizard and stop it on
     all close, hide, cancellation, expiry, and destruction paths.
   - Test no action is sent before confirmation and that Escape cancels without
     mutation.

5. **Regression and render verification**
   - Add renderer-gated tests (`LAMASYNC_TUI_TEST_VIEWS=1`) for More → Access
     keys → Esc back to More, row navigation, Tab/tab-bar focus behavior, and
     device-principal read-only behavior.
   - Add mock-client view tests proving: no `/api-keys` request for a device
     principal; create/reveal secret clears on close/hide; revoked keys lack
     secret actions; and pairing polling stops on close.
   - Run a real PTY check in the owner-reported environment (Alacritty over
     SSH, comfortably sized terminal) plus 80×24 and 60×20 captures. Verify
     that the Access keys row, wizards, and focus bar remain selectable with
     Tab and arrows.

6. **Documentation and release closeout**
   - Update `docs/features.md`, `docs/status.md`, and this handoff's final
     status with the exact TUI surface and security behavior. Update
     `docs/dogfood-2026-08-23.md` (or its successor checklist) with the PTY
     results.
   - No agent-skill API route entry is required unless a route changes. If one
     does, document it before running strict skill drift.

## Tests and release gate

Run these after the implementation and after resolving the fallback test:

```bash
bun x tsc --noEmit
bun run build:web-ui
bun test packages/core/src/api-client.test.ts packages/tui/src/access-keys.test.ts packages/tui/src/views/access-keys.test.ts
LAMASYNC_TUI_TEST_VIEWS=1 bun test packages/tui/src/app/shell.test.ts packages/tui/src/views/access-keys.test.ts
bun scripts/check-skill-drift.ts --strict
bun test --reporter=dot
bun run build
```

Also boot-smoke the server with disposable data and a non-production master
key after the web build. The final full test command must report zero failures;
do not ship with the old `cli-fallback.test.ts` failure marked as known.

Before push, verify:

```bash
git status --short
git diff --check master...HEAD
git log --oneline master..HEAD
```

The branch should contain focused commits (security-boundary cherry-pick,
shared-client/TUI implementation, fallback-test fix if separate, and docs), a
clean worktree, all gates green, and no production deployment. Update LAMA-234
to done only after these conditions are true.

## Acceptance criteria

- Master/admin credentials can list masked managed-key metadata, create an
  admin key, explicitly reveal an active key, revoke an active key, and create
  a pairing code from the TUI.
- Device credentials never call or receive the managed-key list and cannot
  reach any management action; they see only their own identity/bound-host
  explanation.
- Create/reveal secrets appear only in an explicit, acknowledged transient
  panel and are cleared on every exit path.
- Pairing never displays or distributes the master key; a used code visibly
  reaches its terminal state and an expired one can be regenerated.
- Access keys remains reachable through `More`, preserves six top-level tabs,
  and passes the Tab/arrow PTY checks.
- `bun test --reporter=dot` has zero failures, and all typecheck, build,
  strict-drift, server-smoke, and clean-diff gates pass before push.

---

## Final status — implemented 2026-08-29

Branch `lama-234-tui-access-keys` implements everything above, then split
into focused commits and left ready to push (not deployed to production):

- `7a3b9ac` — cherry-pick of the security-boundary commit `ea3fc6d`
  (device assignment updates are mode-only; device action enqueue/history
  blocked; cross-host dotfile metadata closed).
- `04774ed` — `cli-fallback.test.ts` root cause: **test-environment
  leakage, not a fallback regression**. `api.ts` froze `CONFIG_PATH =
  join(homedir(), …)` at module load and Bun caches `os.homedir()`
  process-wide, so a real `~/.config/lamasync/client.toml` leaked into the
  HOME-isolated test. `getConfigPath()` now resolves `$HOME` per call
  (homedir() fallback); the test is machine-independent and green.
- `a7e15f9` — `packages/tui/src/access-keys.ts` pure presentation
  helpers + unit tests (principal classification, masked rows, action
  availability, UTC timestamps, countdown/date boundaries; no secrets in
  display models).
- `9fd6eea` — hidden `AccessKeysView` under More (`a` hotkey, `homeTab:
  more`, hiddenFromTabBar, six tabs intact at 80 cols). Master/admin table
  + actions; device identity-only screen that never calls `/api-keys`;
  401/403 → error phase, never an empty key list; case-sensitive
  `c/p/r/x/R` (r=reveal vs R=refresh); contextual footer; LAMA-173
  contract (realize(), swapChildren(), request-generation guards).
- `392ef1e` — tests: renderer-free wizard state machines (no action
  before confirmation, Escape cancels without mutation, secrets clear on
  every exit path, revoked rows have no secret actions, pairing poller
  stops on cancel/hide via fake timers) + renderer-gated navigation/device
  frame tests (`LAMASYNC_TUI_TEST_VIEWS=1`).
- `95c3e99` — wizard lifecycle fixes found in the PTY walkthrough: an
  optional `Wizard.mount(host)` hook (boot mounts via
  `setOverlayHost` so the first step renders — also repairs the existing
  blank-first-paint pause dialog) and `onClosed` callbacks so a
  self-closed wizard can't leave a stale panel handle blocking later
  actions.

Gates (all green on this branch): `bun x tsc --noEmit`; `bun run
build:web-ui`; targeted client/helpers/view suites (plain + renderer);
`bun scripts/check-skill-drift.ts --strict` (no route changed);
`bun test --reporter=dot` → **1136 pass / 0 fail** (the old
cli-fallback failure is resolved, not waived); `bun run build`; live
server boot-smoke with disposable data + non-production master key
(health, `/auth/me`, create/reveal/revoke with `Cache-Control: no-store`,
clean teardown).

Real-PTY verification via tmux (Alacritty-compatible, 80×24 and 60×20):
More → Access keys; masked table with master break-glass label; create
wizard (label → confirm → "SAVE THIS NOW" secret panel → ack closes, table
refreshes); reveal wizard (scrollback warning → confirm → secret panel);
pair screen (code `LAMA-…`, live countdown, `lamasync register` command,
10s poll flipped the screen to USED after a server-side exchange);
Tab→arrows→Enter tab-bar navigation; device-principal read-only screen
with a freshly minted device key (bound host shown, no management
surface). Findings appended to `docs/dogfood-2026-08-23.md`; status log
and features updated in this commit.

Remaining before merge (owner/CI): final `git status --short`, `git diff
--check master...HEAD`, `git log --oneline master..HEAD` review, PR/CI,
then flipping LAMA-234 to done.
