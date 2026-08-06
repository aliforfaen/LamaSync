# lamasync agent skills

This directory contains two skills for agents:

- `lamasync-server.md` — teaches an agent how to talk to a running
  `lamasync-server`: registering hosts, querying fleet health, managing
  folder assignments, pushing/pulling dotfile tarballs, and reviewing the
  operation log.
- `lamasync-client.md` — teaches an agent how to set up **its own host**
  as a LamaSync client: prereqs (tailnet, rclone), the install script,
  registration verification, and day-2 daemon usage.

## Install (as managed skills)

To make a skill available to your agent, copy the file into your agent's
managed-skills directory, e.g. for OMP:

```bash
mkdir -p ~/.omp/agent/managed-skills
cp packages/agent-skill/lamasync-server.md \
   ~/.omp/agent/managed-skills/lamasync-server.md
cp packages/agent-skill/lamasync-client.md \
   ~/.omp/agent/managed-skills/lamasync-client.md
```

Once copied, restart (or refresh) your agent session and the skills will be
discoverable under the names `lamasync-server` / `lamasync-client`. Each
skill is self-contained — no install step, no build, no extra metadata
beyond the frontmatter already inside the file.

## Updating

If the server's endpoint list or the install flow changes, edit the skill
files in this directory and re-copy them to the managed-skills path (the
in-tree files are the source of truth). The server skill intentionally
references `/swagger/json` as a live fallback so an agent can verify
schemas even if the bundled list drifts.
