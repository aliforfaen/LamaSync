---
name: Pull request
about: Submit changes to LamaSync
---

## What does this PR do?

<!-- One or two sentences. Link the issue/Multica key when one exists (LAMA-xxx). -->

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Docs
- [ ] Refactor / polish
- [ ] Packaging / CI

## Validation

- [ ] `bun x tsc --noEmit` clean
- [ ] `bun run build:web-ui` passes (before `bun test`)
- [ ] `bun test` passes
- [ ] `bun scripts/check-skill-drift.ts` OK (if CLI/help/API surface changed)
- [ ] `bun run build` passes (if packaging/release-affecting)
- [ ] UI changes include before/after captures (web PNG or TUI tmux capture)

## Notes for the reviewer

<!--
- Any behavior changes users should know about (rename, new flag, exit code)?
- Glossary impact: does this touch user-facing copy? (devices / storage
  destinations / app settings backups — see docs/terminology.md)
- Public-safe check: no SSH/IP/fleet specifics in README-affecting changes
  (those go to docs/prod-deploy.md).
-->