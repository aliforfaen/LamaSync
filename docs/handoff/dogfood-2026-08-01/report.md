# Dogfood Report: LamaSync Command Center v1 (LAMA-183)

| Field | Value |
|-------|-------|
| **Date** | 2026-08-01 |
| **App URL** | http://localhost:8080/ |
| **Session** | lamasync-command-center-2026-08-01 |
| **Scope** | Full LAMA-183 epic (LAMA-199/201/197/198/200/202/203) + H regression, against a freshly-started local dev server (`bun run dev:server`) with a fabricated fleet via curl. |
| **Spec** | `docs/handoff/command-center-testing.md` |
| **Server** | LamaSync v0.2.3, data dir `/tmp/lamasync-test`, backup dir `/tmp/lamasync-test-backups` |
| **Skipped (by user choice)** | D4 (trigger_sync end-to-end — needs real daemon), D5 (config-revision auto-refresh — needs real daemon), E1 (Admin test button ntfy push), E3 (failed-op → ntfy), E10 (LamaDB webhook — no URL), F3 (live S3 — no creds) |

## Test matrix result

| Section | Coverage | Result |
|---------|----------|--------|
| **A. LAMA-199** version & update visibility | A1–A6 | **6/6 PASS** (heartbeat stores version, `v—` for never-reported, updateAvailable derivation correct against release cache, blank heartbeat preserves version, /release/latest works, /health includes version/updateAvailable on first load) |
| **B. LAMA-201** themes | B1–B5 | **B1–B4 PASS**, **B5 spec unsatisfiable** (raw hex in `:root` token blocks is required to define the tokens; the 34 hits are all token definitions, not consumer CSS) |
| **C. LAMA-197** Command Center | C1–C8 | **C1–C6, C8 PASS**, **C7 FAIL** (quick-action links don't navigate on mouse click — recorded as ISSUE-003) |
| **D. LAMA-198** host pages + queued actions | D1, D2, D3, D6, D7 | **PASS where testable** (host list, host detail, action enqueue + history, audit trail via operation_log); D4/D5 skipped (need real daemon) |
| **E. LAMA-200** notifications | E2, E4–E9, E11 | **8/8 PASS** (event log, cooldown + escalation, success digest, host offline sweep, host recovery, conflict_pending events, no spam) |
| **F. LAMA-202** Data Browser | F1, F2, F4, F5, F6 | **F1, F4, F5, F6 PASS**, **F2 partial** (path safety works for traversal, but 400 returned for non-existent paths and 500 with leaked ENOTDIR for file paths — recorded as ISSUE-005 + ISSUE-006); F3 skipped (real S3) |
| **G. LAMA-203** since-last-visit | G1–G4 | **4/4 PASS** (no markers on first load, NEW chips on new entries, markers clear on second reload, live WS ops marked) |
| **H. Regression** | H1–H4 | **H1–H4 PASS** (CRUD intact, API shapes additive, TUI untouched in git log, tsc clean, 300/301 bun tests pass with 1 skip) |

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 2 |
| Medium | 3 |
| Low | 1 |
| **Total** | **6** |

## Issues

<!-- ISSUE blocks appended below as found. -->

### ISSUE-001: Top nav is clipped on the right at default viewport (~1280px) — transient after WS updates

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | visual |
| **URL** | `http://localhost:8080/#/` (all pages) |
| **Repro Video** | N/A |

**Description**

On every page at the default browser viewport (1280×720), the top nav row **sometimes** clips on the right edge. The "Sign out" button renders as "gn out", the theme toggle shows just "ark" (Dark) or "ght" (Light), and the "Data" / "Admin" link labels are partially cut off. The "LamaSync" brand on the left is fine, but everything after "Conflicts" is squeezed.

The clipping is **transient** — it appears for a few seconds right after a WebSocket event (host state change, operation report, etc.) causes the dashboard to re-render. On a freshly-loaded page with no recent WS activity, the nav renders cleanly with all labels visible. The clipping seems to correlate with the page re-rendering with a slightly wider content area than the previous render, while the nav layout lags behind.

**Repro Steps**

1. Open `http://localhost:8080/`, sign in with `dev-key`.
2. Land on Command Center.
3. Post an operation via curl (e.g. `curl -X POST -H "Authorization: Bearer dev-key" -H "Content-Type: application/json" http://localhost:8080/api/v1/report -d '{...}'`).
4. **Observe** within a few seconds: the nav clips on the right (clipped-state screenshot captured right after registering a new host).
5. Wait ~5s without further WS activity and the nav re-lays-out cleanly (settled-state screenshot is the same page after settling).
6. **Compare:** the post-WS screenshot has "gn out" and "ark" (clipped); the settled screenshot has "Sign out" and "System" (full).

---

### ISSUE-002: Primary action buttons render with low-contrast text in dark theme (transient on re-render)

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | visual / accessibility |
| **URL** | `http://localhost:8080/#/hosts/host-c` (host detail Actions row, plus Dotfiles "New manifest") |
| **Repro Video** | N/A |

**Description**

Primary buttons ("Trigger sync", "Trigger backup", "Check update", "Refresh config" on the host detail Actions row) sometimes render with very dim text on a dark-blue background in **dark mode**. The text is barely legible.

The contrast is **transient** — it appears in dark mode for a short period (similar to ISSUE-001), then corrects itself after a few seconds. In light mode the buttons always render correctly with white text on a clear blue background. A freshly-reloaded page in dark mode typically renders the buttons correctly too. The bug correlates with re-renders triggered by WebSocket events.

This is a different issue from ISSUE-001 (which is the nav clipping) but probably the same root cause: a renderable proxy that doesn't pick up theme tokens correctly on a WS-driven re-render.

**Repro Steps**

1. Open `http://localhost:8080/`, sign in, navigate to **Hosts → nas-unraid** (or any host).
2. Toggle theme to Dark via the nav toggle.
3. **Observe:** the action buttons render with dim text on dark blue (captured immediately after a WS update; buttons hard to read).
4. Wait ~3-5s without further WS activity and the buttons re-render with proper contrast (same page after settling; white text on clear blue).
5. Compare with light mode (in Light): buttons always render with proper contrast.

---

### ISSUE-003: "Manage folders →" and "Resolve conflicts →" quick-action links don't navigate on mouse click

| Field | Value |
|-------|-------|
| **Severity** | high |
| **Category** | functional |
| **URL** | `http://localhost:8080/#/` (Command Center → Quick actions) |
| **Repro Video** | N/A |

**Description**

The "Quick actions" section at the bottom of the Command Center has two links: "Manage folders →" (`href="#/folders"`) and "Resolve conflicts →" (`href="#/conflicts"`). Both are real `<a>` elements with the correct HashRouter hrefs, but clicking them with the mouse (in a real browser session) does **not** navigate. The page stays on Command Center and the URL hash does not change.

- A programmatic `link.click()` *does* navigate (URL becomes `#/folders`).
- Pressing Enter on the focused link *does* navigate.
- The `agent-browser click` action (a real synthesized mouse click) does **not** navigate.

The likely cause: the link lives inside a parent element with an `onClick` handler. Something in the click pipeline is stopping React Router from picking up the navigation, or the page-level click handler is calling `e.preventDefault()` / `e.stopPropagation()`.

This is exactly the class of bug the LAMA-197 / LAMA-202 review caught in code review for plain `<a href>` links — but here the hrefs are correct, so the failure is downstream (event handling, not link shape).

**Repro Steps**

1. Open `http://localhost:8080/`, sign in with `dev-key`.
2. Land on Command Center. Scroll to the "Quick actions" section.
   *(Step 1 — dashboard, dark mode, showing all sections. Screenshots have been removed per cleanup; the visual context is: dashboard with the full fleet grid visible, WS status "open", all nav links rendering.)*
3. Click the "Manage folders →" link with the mouse.
4. **Observe:** the URL stays at `http://localhost:8080/#/` and the heading is still "Command Center". The folders page never loads.
5. Repeat with "Resolve conflicts →" — same behavior.
6. **Workaround:** Tab to focus the link, then press Enter — this navigates correctly.

---

### ISSUE-004: Stale `/login` URL doesn't redirect when sessionStorage still has a valid API key

| Field | Value |
|-------|-------|
| **Severity** | low |
| **Category** | ux |
| **URL** | `http://localhost:8080/#/login` |
| **Repro Video** | N/A |

**Description**

If a 401 / unauthorized event fires while the SPA is running (`notifyUnauthorized()` in `packages/web-ui/src/api.ts` clears the key and dispatches the `lamasync:unauthorized` event), the user is redirected to `/login`. If the user then reloads the tab BEFORE signing in again, the `App` component's `useState(() => getApiKey() !== null)` initializer runs, reads the (now-cleared) key, and renders the Login screen. This part is correct.

However, the inverse case is broken: if a user is *already authenticated* (sessionStorage has a valid key) and the URL hash happens to be `#/login` (e.g. stale URL from a previous visit, a bookmark, or being redirected to `/login` from a 401 *without* the key being cleared), the Login screen is shown even though the stored key is still valid. The user is forced to re-type the API key. There is no auto-redirect from `/login` to `/` when `authenticated === true`.

The `App.tsx` routing should add a guard: if `authenticated` is true and the route is `/login`, navigate to `/`.

**Repro Steps**

1. Sign in via the form (sessionStorage gets the key, URL becomes `#/`).
2. Open DevTools and run `sessionStorage.setItem('lamasync_api_key', 'dev-key'); location.hash = '/login'` (this simulates landing on `/login` while the key is still in storage).
3. Reload the page.
4. **Observe:** the page shows the Login form. The sessionStorage still has `"lamasync_api_key": "dev-key"`, but the user is treated as not signed in. They have to type the key and submit to get to the dashboard.

---

### ISSUE-005: Local browse returns 400 "invalid path" for non-existent paths instead of 404

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | functional / ux |
| **URL** | `GET /api/v1/browse/local?path=…` |
| **Repro Video** | N/A |

**Description**

`GET /api/v1/browse/local?path=<name>` returns HTTP 400 with `{"error":"invalid path"}` for paths that don't exist on disk (e.g. `?path=foo` when no `foo/` directory exists under the backup root). The "invalid path" wording implies a security/path-traversal rejection, but the actual cause is a missing directory. This is misleading to API clients and the UI (which uses the same status to drive error messages).

A non-existent path should be reported as **404 Not Found** (or **400** with a more specific message like "directory not found") so callers can distinguish "rejected for safety" from "this directory doesn't exist".

**Repro Steps**

1. `curl -H "Authorization: Bearer dev-key" 'http://localhost:8080/api/v1/browse/local?path=foo'`
2. **Observe:** HTTP 400, body `{"error":"invalid path"}` — but `foo` doesn't exist on disk; the path is well-formed and doesn't traverse out of the backup root.
3. Compare to `?path=test-folder` (which exists) → HTTP 200 with directory contents.
4. Also `?path=../../etc` → HTTP 400 `{"error":"invalid path"}` — this *is* a real path-traversal rejection. Both 400 responses are identical, so callers can't tell safety rejection from "not found".

---

### ISSUE-006: Local browse leaks raw `ENOTDIR` error body for file paths (500)

| Field | Value |
|-------|-------|
| **Severity** | high |
| **Category** | console / security / ux |
| **URL** | `GET /api/v1/browse/local?path=…/somefile` |
| **Repro Video** | N/A |

**Description**

`GET /api/v1/browse/local?path=test-folder/hello.txt` (where `hello.txt` is a file, not a directory) returns HTTP **500** with a leaked Node.js error body: `ENOTDIR: not a directory, scandir '/tmp/lamasync-test-backups/test-folder/hello.txt'`. The error message reveals the server's filesystem path (`/tmp/lamasync-test-backups/…`) to the client, which is a minor information disclosure, and the 500 status misleads clients into thinking the server errored rather than the user requesting an invalid resource.

The correct response is **400** with a sanitized message like `{"error":"path is not a directory"}`. This is the same class of error-leak the F4 spec explicitly calls out for the S3 backend.

**Repro Steps**

1. Create a file under the backup dir: `echo hello > /tmp/lamasync-test-backups/test-folder/hello.txt`
2. `curl -H "Authorization: Bearer dev-key" 'http://localhost:8080/api/v1/browse/local?path=test-folder/hello.txt'`
3. **Observe:** HTTP 500, raw body `ENOTDIR: not a directory, scandir '/tmp/lamasync-test-backups/test-folder/hello.txt'`.
4. The Data Browser UI's Local tab will show this in its error state with the leaked filesystem path.

---
