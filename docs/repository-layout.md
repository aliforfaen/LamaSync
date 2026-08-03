# Repository layout — LamaSync

```
lamasync/                     # Bun workspace root
  package.json                # workspaces: ["packages/*"]
  tsconfig.json               # strict, bundler resolution, paths → @lamasync/*
  bun.lock
  ARCHITECTURE.md             # full system design & DB schema (source of truth)
  AGENTS.md                   # agent onboarding (lean essentials)
  docker/
    Dockerfile.server         # multi-stage: bun compile → debian-slim + rclone
    docker-compose.yml        # volumes for /data, /backups; tailnet-bound port
    .env.example
  config-examples/            # reference TOML configs (server.toml, client.toml)
  packages/
    core/                     # @lamasync/core — shared types, DB, config, API client
      src/
        types.ts              # Host, Folder, FolderAssignment, DotfileVersion, …
        config.ts             # TOML parsers for server & client config
        api-client.ts         # LamaSyncApiClient (all endpoint methods)
        version.ts            # generated version constant (from root package.json)
        db/
          schema.ts           # SERVER_SCHEMA + MIGRATIONS
          client.ts           # initDb(path) : opens SQLite + applies schema
        index.ts              # barrel re-exports
        test.test.ts          # core unit tests
    server/                   # @lamasync/server — Elysia REST API + Swagger + WS
      src/
        index.ts              # swagger → routes → listen(:8080); --version flag
        auth.ts               # lazy Bearer token middleware (skips Upgrade: websocket)
        db.ts                 # singleton SQLite handle (lazy + test-safe)
        ws.ts                 # WebSocket event stream (subprotocol auth)
        crypto.ts             # LAMA-222: AES-256-GCM at-rest encryption (LAMASYNC_SECRET_KEY)
        backends.ts           # LAMA-222: backend row helpers + legacy s3_* lift migration
        browse-jobs.ts        # LAMA-226: browse write-op engine (rclone jobs, busy guard)
        stats.ts              # LAMA-224: storage report + folder-size caching
        routes/
          health.ts           # GET /api/v1/health
          hosts.ts            # POST /register, POST /report/health
          config.ts           # GET /config/:hostId (assignments + rclone + peers)
          folders.ts          # CRUD + assign/unassign + templates
          dotfiles.ts         # manifest CRUD, upload (multipart), list, download, delete
          operations.ts       # GET /operations (filterable, newest-first)
          report.ts           # POST /report (log + schedule_state update)
          shares.ts           # GET /api/v1/shares (NFS shares)
          admin.ts            # operation-log pruning, retention helpers
          restic.ts           # restic config for backup/dotfile types
          conflicts.ts        # conflict resolution API
          release.ts          # GET /api/v1/release/latest
          backends.ts         # LAMA-222: reusable S3 backends CRUD + connection test
          stats.ts            # LAMA-224: storage report + folder-size endpoints
          browse.ts           # LAMA-226: Data Browser write ops (copy/move/rename/mkdir/upload)
    daemon/                   # @lamasync/daemon — client sync daemon
      src/
        index.ts              # heartbeat + Unix socket server + --version/--check-update/--update
        config.ts             # reads ~/.config/lamasync/client.toml
        server.ts             # LamaSyncApiClient singleton
        socket.ts             # Unix socket server (commands + status)
        socket.test.ts        # socket command tests
        executor.ts           # rclone spawn, dry-run, bandwidth, disk-space pre-flight
        scheduler.ts          # cron expression sync engine
        mounts.ts             # mount lifecycle: start/stop/health/backoff
        rclone.ts             # rclone config generation helpers
        ignore.ts             # .lamasyncignore / .lamasyncmountignore parsing
        hooks.ts              # pre/post sync shell hooks (with timeout)
        lan-peer.ts           # LAN IP detection + peer SFTP discovery
        lock.ts               # server-side lock coordination (contention vs unreachable, same-host overlap guard, abort on lock loss)
        config-cache.ts       # cached server config for offline operation
        report-queue.ts       # disk-backed queue for failed operation reports
        self-update.ts        # GitHub release check + binary replacement
        self-update.test.ts   # self-update unit tests
        systemd.ts            # systemd unit generation helpers
        systemd.test.ts       # systemd unit template tests
    tui/                      # @lamasync/tui — OpenTUI frontend, tabbed shell (LAMA-173)
      src/
        index.ts              # slim entry: flags, CLI fallback, bootShell()
        boot.ts               # wires Shell with Local/Fleet/Dotfiles/Conflicts/Logs/Gh views
        api.ts                # client builder (env → config file → defaults)
        socket-client.ts      # Unix socket client for local mode
        cli-fallback.ts       # LAMASYNC_NO_TUI=1 CLI mode
        app/
          theme.ts            # status prefixes + title strings
          widgets.ts          # pageShell, hotkeyFooter, statusBox, loading/error/emptyBox
          keymap.ts           # Hotkey type + matchHotkey() (char / name dispatch)
          keymap.test.ts      # keymap dispatch unit tests
          view-manager.ts     # View interface, ViewSpec, ViewManager (visible-toggle)
          view-manager.test.ts # view-manager unit tests (fake + gated real renderer)
          shell.ts            # Shell class — TabSelect bar + global dispatch + status
          wizard.ts           # WizardRunner + Wizard/WizardStep + registry
          wizard.test.ts      # wizard state-machine tests (pure)
          fleet-service.ts    # createFleetService() — WS subscription lifted out
          schedule-presets.ts # preset table (mirror web-ui/Dotfiles.tsx:27-36)
        views/
          local.ts            # LocalView (folder list + sync/cache/wizard hotkeys)
          fleet.ts            # FleetView (uses FleetService for live WS hosts)
          dotfiles.ts         # DotfilesView (manifest browser + restore state machine)
          conflicts.ts        # ConflictsView (highlighted-row resolution + confirm)
          logs.ts             # LogsView (ScrollBox + paginated operations)
          gh-selector.ts      # GhView (GitHub repo adoption via `gh` CLI)
        flows/
          backup-setup.ts     # Wizard factory: create folder + assign host
          dotfile-manifest.ts # Wizard factory: create dotfile manifest
    agent-skill/              # @lamasync/agent-skill — OMP managed skill
      lamasync-server.md      # skill body: endpoint table, auth, example workflows
      README.md               # install instructions for OMP managed-skills dir
    web-ui/                   # @lamasync/web-ui — embedded React SPA (Vite build)
      index.html              # Vite entry HTML
      vite.config.ts          # single-file inlined build (see scripts/inline-web-ui.ts)
      tsconfig.json           # extends root, adds jsx support
      src/
        main.tsx              # React 18 root + StrictMode
        App.tsx               # HashRouter + auth gate
        api.ts                # browser fetch client (sessionStorage bearer)
        index.css             # hand-rolled dashboard styles
        components/
          Login.tsx           # API-key sign-in form
          Nav.tsx             # top navigation bar (Dashboard, Folders, Dotfiles, Conflicts, Admin)
        hooks/
          useWebSocket.ts     # /api/v1/ws client with exponential-backoff reconnect
        pages/
          Dashboard.tsx       # summary cards, hosts table, recent operations
          Folders.tsx         # list + create + delete (admin)
          Dotfiles.tsx        # manifest list + create + delete (admin)
          Conflicts.tsx       # pending conflicts + resolve (local/remote/both)
          Admin.tsx           # operation-log prune (days)
  scripts/
    gen-version.ts            # writes packages/core/src/version.ts from root package.json
    inline-web-ui.ts          # post-vite inliner: embeds JS/CSS into dist/index.html (single-file SPA)
    e2e-harness.sh            # isolated server + daemon end-to-end test harness
    test-install.sh           # Docker smoke test for curl | bash install path
    test-update.sh            # Docker smoke test for curl | bash update path
    e2e-sandbox/              # full client end-to-end sandbox (Docker Compose: server + client)
      docker-compose.yml      # server (ghcr image) + client (Ubuntu, runs install.sh)
      client.Dockerfile       # client test image
      client-test.sh          # install → register → backup → dotfile → log verification
      socket-send.py          # sends JSON commands to the lamasyncd Unix socket
  packaging/                  # curl | bash installer + systemd template
    install/
      install.sh              # install lamasyncd (+ optional TUI) and systemd unit
      update.sh               # standalone self-update script
    systemd/
      lamasyncd.service       # systemd user-unit template
  .github/
    workflows/
      ci.yml                  # type-check, test, build, release, docker push
  docs/
    development.md            # full dev guide (quick start, tests, recipes, Docker, release)
    repository-layout.md      # this file
    features.md               # implemented features by LAMA issue + known limitations
    status.md                 # current status log + next-session work queue
    handoff/                  # testing & dogfood handoffs
    plans/                    # execution plans (LAMA-XXX-*.md)
```
