# LamaSync documentation

This directory is split between living operational guidance and preserved
project history. Start with the smallest document that answers the question;
do not treat old handoffs as current requirements.

## Living documents

- [Agent start](agent-start.md) — current work routing and validation.
- [Status and work queue](status.md) — current shipped state, follow-ups, and
  limitations.
- [Architecture](../ARCHITECTURE.md) — system and data-contract source of
  truth.
- [Development](development.md) — local development, testing, and release
  recipes.
- [Repository layout](repository-layout.md) — annotated source-tree map.
- [Features and limitations](features.md) — capability index by LAMA issue.
- [Terminology](terminology.md) — user-facing naming rules.
- [Production deploy](prod-deploy.md) — private LXC operations.

`handoff-302-event-triggered-sync.md` remains here because its live soak work
is still open. The dashboard design reference and image artifacts remain here
because the web UI assets link to them directly.

## Archive

Completed August plans, audits, owner briefs, and historical status entries
live in [archive/](archive/README.md). They are evidence, not a work queue.

## Maintenance rule

When a feature ships, update `status.md`, `features.md`, and the relevant
operator or agent-skill reference. Move completed time-bound plans to the
archive instead of extending active entry points indefinitely.
