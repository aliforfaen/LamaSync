# LamaSync terminology

Use this guide for user-facing web, TUI, CLI-help, README, and operator copy.
It is a language guide, not a request to rename identifiers.

## Rule

Change words, never protocol names. API routes, CLI commands and flags, JSON
keys, database columns, config keys, and wire types remain exact. Technical
references such as Swagger, logs, and agent-skill API documentation may use
their exact names.

## Preferred language

| Internal term | User-facing term | Note |
|---|---|---|
| host | Device | Show the real hostname when useful. |
| backend | Storage destination | “Destination” is fine after first use. |
| folder assignment | Set up on this device | Explain the outcome, not plumbing. |
| `sync` / `mount` folder | Synced folder | Mount is “read-only on this device.” |
| `backup` folder | Backup | Keep this familiar word. |
| `dotfile` legacy folder | App settings backup | Never expose “dotfile” in new user copy. |
| manifest / profile | Template or protection | LAMA-316 replaces these concepts. |
| cron expression | Schedule | Use friendly presets; put raw cron under Custom. |
| conflict strategy | When both sides changed | Use Keep newest / Prefer this device / Keep both / Ask me. |
| operation log | Activity | “Operations” is acceptable as a technical page title. |

## Application backup wording

Use **app template** for a reusable recipe, **protection** for that recipe
enabled on one device, and **snapshot** for an immutable capture. Say
**inspect** or **download** for current snapshot recovery. Do not imply that
application snapshots can yet be directly restored onto a target: that awaits
the setup-plan wizard.

## Copy checklist

- Prefer a concrete outcome: “Set up on laptop” over “Create assignment.”
- Explain risk before a destructive action; name the device and data affected.
- Keep developer terms in diagnostics when precision matters, then add a
  human explanation nearby.
- Check new UI copy against this table before screenshots or release notes.
