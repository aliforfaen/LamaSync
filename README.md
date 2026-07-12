# LamaSync

Personal sync-fleet controller. One server manages folder syncs, backups,
and dotfile versions across your machines — all orchestrated through **rclone**
over a tailnet.

```
 TrueNAS (Docker)          Laptop                 Desktop
 ┌──────────────┐         ┌──────────┐          ┌──────────┐
 │ lamasync-    │◄──REST──┤lamasyncd │          │lamasyncd │
 │ server       │         │lamasync- │          │lamasync- │
 │ SQLite       │         │   tui    │          │   tui    │
 └──────────────┘         └──────────┘          └──────────┘
```

## Quick start

```bash
# Install deps
bun install

# Start the server
LAMASYNC_API_KEY=dev-key bun run dev:server

# Run the daemon (needs ~/.config/lamasync/client.toml)
bun run dev:daemon

# Open the TUI
LAMASYNC_SERVER_URL=http://localhost:8080 LAMASYNC_API_KEY=dev-key bun run dev:tui
```

## Architecture

| Component | Purpose |
|-----------|---------|
| `lamasync-server` | REST API + SQLite on TrueNAS. Manages hosts, folders, schedules, and dotfile tarballs. |
| `lamasyncd` | Systemd user daemon. Heartbeats to the server, will spawn rclone mounts/syncs. |
| `lamasync-tui` | OpenTUI terminal UI. Local dashboard and fleet overview. |

Server endpoints are documented via Swagger at `/swagger` (browsable) and
`/swagger/json` (machine-readable). Full API documentation is in the
`lamasync-server` agent skill (`packages/agent-skill/lamasync-server.md`).

## Build standalone binaries

```bash
bun run build
# → packages/server/dist/lamasync-server
# → packages/daemon/dist/lamasyncd
# → packages/tui/dist/lamasync-tui
```

## Docker

```bash
cp docker/.env.example docker/.env   # set your API key
docker compose -f docker/docker-compose.yml up -d
```

## Project status

v0.1.0 — server API is fully functional (12 endpoints, Swagger), daemon and TUI
are skeletons. See `AGENTS.md` for the deferred roadmap and development guide.

## License

MIT
