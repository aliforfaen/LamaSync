# lamasync agent skill (LAMA-230)

A two-tier agent skill designed in LAMA-227 — the primary agent surface
for operating a LamaSync fleet is the `lamasync` CLI (LAMA-229); the REST/
WS API is the documented escape hatch (LAMA-230 / LAMA-231).

## Bundle

```
SKILL.md                  frontmatter trigger + decision tree + safety summary
reference/
  cli.md                  full `lamasync` subcommand reference
  api.md                  REST + WebSocket reference; defers to /swagger/json
  recipes.md              set up a backup, add a sync folder, fix 401s, …
  troubleshooting.md      symptom → cause → fix
  safety.md               the six rules, verbatim
lamasync-client.md        separate onboarding skill (install a daemon on this host)
```

## Install

A consumer agent (Pi / Kimi / Claude Code / Codex / …) discovers the skill
under the name `lamasync`. The skill ships in the GitHub Release as
`lamasync-skill-<version>.tar.gz` and is auto-installed by
`packaging/install/install.sh` (the daemon installer) at:
- `~/.agents/skills/lamasync/SKILL.md`
- `~/.agents/skills/lamasync/reference/`

The installer prompts once ("Install the LamaSync agent skill to `~/.agents`?
[Y/n]"); the choice is persisted to `~/.lamasync/install-state.json` and
honoured by `packaging/install/update.sh` and `lamasyncd --update skill`.

To install manually from a release tarball:

```bash
mkdir -p ~/.agents/skills
tar -xzf lamasync-skill-<version>.tar.gz -C ~/.agents/skills
mv ~/.agents/skills/lamasync-skill-<version> ~/.agents/skills/lamasync
```

## Drift check

Every route in `reference/api.md` and every command/flag in
`reference/cli.md` must exist in the source code. CI runs
`scripts/check-skill-drift.ts` to enforce this — the skill fails the
build when it references a dead surface.

## Updating

When the server's endpoint list or the install flow changes, edit the files
under `packages/agent-skill/` and run `bash packaging/build-skill-tarball.sh
./dist` to produce the new tarball. The CI release job publishes it
automatically; end users receive the update via:
- `lamasyncd --update skill` (binary-aligned version) on existing installs
- `packaging/install/update.sh` on update-flow installs
- A fresh `packaging/install/install.sh` run for new installs.

## See also

- `../docs/handoff/2026-08-11-agent-surface-cli-skill.md` for the original
  design rationale and the umbrella issue (LAMA-227).
- `docs/features.md` rows for LAMA-227, LAMA-229, LAMA-230, LAMA-231.
