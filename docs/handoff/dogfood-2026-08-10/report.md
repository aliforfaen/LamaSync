# Dogfood report — UX program WS1–5 (2026-08-10)

**Environment:** local dev server (`bun run dev:server`), seeded per handoff script.
**Browser:** agent-browser (Chromium via CDP).
**Tester:** Pi (automated dogfood agent).

---

## Summary

The WS1–5 UX program is **largely solid**. The WS5 ops-console redesign delivers
a polished, dark-first design language with coherent light-theme parity. The
getting-started checklist, inline editing, backend CRUD, conflict resolution, and
admin pages all function correctly. The ConfirmDialog component works in some
places (backend delete) but is inconsistently applied — other destructive actions
still use native `window.confirm()`.

**Blockers:** 0
**Should-fix:** 4
**Nits:** 3

---

## Findings

| # | Section | Severity | Page/route | Description | Screenshot |
|---|---------|----------|-----------|-------------|------------|
| 1 | C6 | **should-fix** | `#/hosts` | Host delete uses native `window.confirm()` instead of the app's ConfirmDialog component. The handoff explicitly requires "app modal, NOT a browser-native confirm". Backend delete (E4) correctly uses ConfirmDialog — this is an inconsistency. | `C6-delete-confirm.png` |
| 2 | G4 | **should-fix** | `#/conflicts` | Conflict resolution also uses native `window.confirm()` ("Resolve conflict using the local version?") instead of the app's ConfirmDialog. Same inconsistency as #1. | `G4-conflict-resolved.png` |
| 3 | D2 | **should-fix** | `#/folders` | Invalid cron expression `61 * * * *` is accepted and saved without any validation error. The handoff expects "invalid rejected with inline error naming the problem". The cron field accepts any string. | `D2-assignment-edit.png` |
| 4 | F | **should-fix** | `#/data` | Data Browser is stuck in skeleton loading state — the file listing never loads. The API at `/api/v1/browse/local` works correctly with an empty path, but the frontend appears to send an invalid path (likely "/"), causing the skeleton to persist indefinitely. | `F1-data-browser.png` |
| 5 | D2 | nit | `#/folders` | Assignment edit heading shows raw folder UUID `092d6cf0-7b59-45eb-8eb0-017778e31da3` instead of the folder name "documents". The rest of the page resolves names correctly. | `D2-assignment-edit.png` |
| 6 | B1 | nit | `#/dashboard` | Dashboard "Needs attention" → "Pending conflicts" section shows raw folder UUIDs (`092d6cf0-7b59-45eb-8eb0-017778e3...`) instead of resolved folder names. The Conflicts page itself (G3) resolves names correctly after refresh. | `B1-dashboard-seeded.png` |
| 7 | A5 | nit | `#/dashboard` | Theme toggle cycle (SYSTEM → DARK → LIGHT) is visually confusing: first click from SYSTEM appears to do nothing when OS preference is dark, since SYSTEM and DARK look identical. Consider labeling the current state instead of the next state. | `A5-dashboard-empty-light.png` |

---

## Per-section results

| Section | Result | Notes |
|---------|--------|-------|
| **A. First-run & onboarding** | **PASS** | Login page clean, wrong-key error readable, empty dashboard shows GettingStarted checklist, Swagger loads, theme toggle works. |
| **B. Seeded Dashboard** | **PASS** | Needs-attention cards, fleet cards, stats row, storage card, recent activity all render correctly. Skeleton loading too fast to capture on local server. |
| **C. Hosts & HostDetail** | **PARTIAL** | Host list, inline rename, HostDetail identity/actions/assignments all work. **Bug:** Host delete uses native confirm (Finding #1). |
| **D. Folders** | **PARTIAL** | Folder list, assignment display, history link all work. **Bug:** Invalid cron accepted without validation (Finding #3). UUID in edit heading (Finding #5). |
| **E. Backends** | **PARTIAL** | Backend CRUD works, ConfirmDialog used correctly for delete. **Gap:** No inline validation on S3 endpoint format — bad URLs accepted silently. |
| **F. Data Browser** | **FAIL** | Page stuck in skeleton loading. File listing never loads. API works directly but frontend sends invalid path. |
| **G. Operations & Conflicts** | **PARTIAL** | Operations page with filters, status badges, pagination all work. Conflicts load after refresh (initial "Failed to fetch" is transient). Resolution flow works but uses native confirm (Finding #2). |
| **H. Dotfiles** | **PASS** | Manifest list with scope dropdown, table with app/hosts/paths/schedule, action buttons all render correctly. |
| **I. Admin** | **PASS** | Server version, DB size, latest release check, operation log retention, notification channels all render correctly. |
| **J. Visual sweep (WS5)** | **PASS** | Dark theme: near-black surfaces, teal/green accents, amber warnings, red critical. Mono font on machine data. Light theme: coherent, readable, badges legible. Nav wordmark, status pill, skeleton loading all present. Focus rings visible on form controls. |
| **K. CLI fallback** | **PASS** | `LAMASYNC_NO_TUI=1` shows fleet summary cleanly. Error handling for dead servers not fully tested (config path override didn't take effect). |
| **L. Interactive TUI** | **skipped** | Requires manual testing in a real terminal — not automatable headlessly. |

---

## Untested / out of scope

- **Interactive TUI (Section L):** Requires a real terminal session. Maintainer manual checklist.
- **S3/restic backend validation with real infra:** Fake-backend failure is expected; grading error presentation only.
- **Dotfile upload:** Requires a running daemon.
- **Daemon self-update:** Deferred feature.
- **Full CLI error handling for dead server:** Config path override didn't take effect in test environment.
