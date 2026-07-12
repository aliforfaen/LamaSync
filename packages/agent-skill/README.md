# lamasync agent skill

This directory contains the `lamasync-server` skill for OMP-style agents.
The skill teaches an agent how to talk to a running `lamasync-server` —
registering hosts, querying fleet health, managing folder assignments,
pushing/pulling dotfile tarballs, and reviewing the operation log.

## Install (as an OMP managed skill)

To make this skill available to your OMP agent, copy the skill file into the
managed-skills directory and name it `lamasync-server.md`:

```bash
mkdir -p ~/.omp/agent/managed-skills
cp packages/agent-skill/lamasync-server.md \
   ~/.omp/agent/managed-skills/lamasync-server.md
```

Once copied, restart (or refresh) your OMP session and the skill will be
discoverable to the agent under the name `lamasync-server`. The skill is
self-contained — no install step, no build, no extra metadata beyond the
frontmatter already inside the file.

## Updating

If the server's endpoint list changes, edit `lamasync-server.md` in this
directory and re-copy it to the managed-skills path (the in-tree file is the
source of truth). The skill intentionally references `/swagger/json` as a live
fallback so an agent can verify schemas even if the bundled list drifts.
