# Repository layout — LamaSync

```
lamasync/                     # Bun workspace root
  package.json                # workspaces: ["packages/*"]; version lives here
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
        types.ts              # Host, Folder, FolderAssignment, ApplicationTemplate/Protection/Snapshot, … (wire/DB shapes)
        config.ts             # TOML parsers for server & client config
        api-client.ts         # LamaSyncApiClient (all endpoint methods, incl. LAMA-243 release proxy)
        version.ts            # generated version constant (from root package.json)
        effective-type.ts     # LAMA-239: effectiveFolderType() — assignment.mode resolution
        socket-path.ts        # LAMA-218: shared defaultSocketPath (XDG → ~/.lamasync)
        version-compare.ts    # LAMA-199: semver comparator for update-available detection
        remote-update.ts      # LAMA-299: REMOTE_DAEMON_UPDATE_MIN_VERSION + daemonSupportsRemoteUpdate()
        scrub.ts              # LAMA-301: shared deploy-output scrubber + 16 KiB tail cap
        db/
          schema.ts           # SERVER_SCHEMA + MIGRATIONS (includes LAMA-239 mode column)
          client.ts           # initDb(path) : opens SQLite + applies schema
        index.ts              # barrel re-exports
        test.test.ts          # core unit tests
    server/                   # @lamasync/server — Elysia REST API + Swagger + WS
      src/
        index.ts              # swagger → routes → listen(:8080); --version / --help (LAMA-242)
        auth.ts               # lazy Bearer token middleware (skips Upgrade: websocket)
        db.ts                 # singleton SQLite handle (lazy + test-safe)
        ws.ts                 # WebSocket event stream (subprotocol auth)
        crypto.ts             # LAMA-222: AES-256-GCM at-rest encryption (LAMASYNC_SECRET_KEY)
        backends.ts           # LAMA-222: backend row helpers + legacy s3_* lift migration
        backend-test.ts       # LAMA-238: shared helpers for POST /backends/test (used by /backends and /backends/:id/test)
        browse-jobs.ts        # LAMA-226: browse write-op engine (rclone jobs, busy guard)
        browse-paths.ts       # LAMA-226: resolveBrowsePath() realpath containment
        browse-rclone.ts      # LAMA-226: pure config/argv builders (unit-tested without rclone)
        config-revision.ts    # LAMA-198: per-host config revision counter
        notifications.ts      # LAMA-200/221: event log + channel delivery (ntfy, webhook)
        release-cache.ts      # LAMA-199/243: 1h cache for GitHub releases (server proxy)
        stats.ts              # LAMA-224: storage report + folder-size caching
        temp-rclone-config.ts # shared withTempRcloneConfig() helper (P1-6)
        usage.ts              # LAMA-242: serverUsage() + SERVER_KNOWN_FLAGS
        routes/
          health.ts           # GET /api/v1/health (incl. serverVersion, dbSizeBytes)
          hosts.ts            # POST /register, POST /report/health, PATCH rename, DELETE
          config.ts           # GET /config/:hostId (assignments + rclone + peers)
          folders.ts          # CRUD + assign/unassign + per-host mode (LAMA-239)
          apps.ts             # /api/v1/apps: template/protection CRUD + enroll, snapshot upload/list/download/delete
          operations.ts       # GET /operations (filterable, newest-first)
          report.ts           # POST /report (log + schedule_state update)
          shares.ts           # GET /api/v1/shares (NFS shares)
          admin.ts            # operation-log pruning, retention helpers
          restic.ts           # restic config for backup/dotfile types
          conflicts.ts        # conflict resolution API
          release.ts          # GET /api/v1/release/latest (LAMA-243 server proxy)
          server-deploys.ts   # LAMA-301: deploy-job request/history/claim/progress/complete (deploy-principal gated)
          backends.ts         # LAMA-222: reusable S3 backends CRUD + connection test
          stats.ts            # LAMA-224: storage report + folder-size endpoints
          browse.ts           # LAMA-226: Data Browser write ops (copy/move/rename/mkdir/upload)
          actions.ts          # LAMA-198: queued actions + claim/complete (LAMA-232 reclaim)
          notifications.ts    # LAMA-200/221: channels CRUD + test event
    daemon/                   # @lamasync/daemon — client sync daemon
      src/
        index.ts              # heartbeat + Unix socket + --version/--help/--check-update/--update (LAMA-242)
        config.ts             # reads ~/.config/lamasync/client.toml
        server.ts             # LamaSyncApiClient singleton
        socket.ts             # Unix socket server (commands + status) — error handler pre-listen (LAMA-218)
        socket.test.ts        # socket command tests
        executor.ts           # rclone spawn, dry-run, bandwidth, disk-space pre-flight
        scheduler.ts          # cron expression sync engine (skips effective-mount assignments)
        mounts.ts             # mount lifecycle: start/stop/health/backoff
        mounts-reconcile.ts   # LAMA-239: reconcileMountsOnRefresh() on boot + config refresh
        rclone.ts             # rclone config generation helpers
        ignore.ts             # .lamasyncignore / .lamasyncmountignore parsing
        hooks.ts              # pre/post sync shell hooks (with timeout)
        hooks-bun-proc.ts     # Bun.spawn wiring for hooks
        hooks-fail.ts         # hook-side helpers
        hooks-timeout.ts      # per-hook timeout enforcement
        hooks.test.ts         # hook behaviour tests
        lan-peer.ts           # LAN + tailnet IP detection + peer SFTP discovery (LAMA-223)
        lock.ts               # server-side lock coordination (contention vs unreachable, same-host overlap guard, abort on lock loss)
        lock.test.ts          # lock behaviour tests
        config-cache.ts       # cached server config for offline operation
        config.test.ts        # config-cache + per-assignment missing-path warning (LAMA-241)
        report-queue.ts       # disk-backed queue for failed operation reports
        report-queue.test.ts  # report-queue tests
        executor.test.ts      # executor tests
        scheduler.test.ts     # scheduler tests
        self-update.ts        # GitHub release check + binary replacement
        self-update.test.ts   # self-update unit tests
        update-check.ts       # LAMA-243: 15-min persisted cooldown for crash-loop guard
        update-check.test.ts  # update-check tests
        skill-update.ts       # LAMA-230: --update skill refreshes the agent-skill bundle
        systemd.ts            # systemd unit generation helpers (PATH, ReadWritePaths, StartLimit)
        systemd.test.ts       # systemd unit template tests
        usage.ts              # LAMA-242: daemonUsage() + DAEMON_KNOWN_FLAGS
        usage.test.ts         # usage tests
        actions.ts            # LAMA-198: trigger_sync / trigger_backup / refresh_config (LAMA-241 host-resolve)
        actions.test.ts       # action handlers + LAMA-220 backup folder filter
        daemon-update.ts      # LAMA-299: injected update helper (preflight → release → asset → replace), shared by --update + the remote update_daemon action
        daemon-update.test.ts # helper tests (no secret leaks asserted per outcome)
    tui/                      # @lamasync/tui — OpenTUI frontend + CLI subcommands (LAMA-227)
      src/
        index.ts              # slim entry: flags, CLI fallback, bootShell() — CLI dispatch FIRST
        boot.ts               # wires Shell with Local/Fleet/Dotfiles/Conflicts/Logs/Gh views
        api.ts                # client builder (env → config file → defaults)
        socket-client.ts      # Unix socket client for local mode
        cli-fallback.ts       # LAMASYNC_NO_TUI=1 CLI mode
        cli/                  # LAMA-229 + LAMA-231: non-interactive subcommand CLI
          index.ts            #   dispatch entry
          dispatch.ts         #   greedy walker over the command tree
          args.ts             #   flag parsing + --json / --server / --api-key / --yes
          args.test.ts
          output.ts           #   table/JSON output, key masking
          output.test.ts
          client.ts           #   per-command API client builder
          client.test.ts
          commands.test.ts
          safety.ts           #   confirmDestructive() — TTY prompt or --yes
          status.ts           #   `lamasync status`
          folders.ts          #   `lamasync folders list|create|assign`
          folders-ext.ts      #   `lamasync folders update|delete|unassign|assignments`
          backends.ts         #   `lamasync backends list|create|test`
          sync.ts             #   `lamasync sync [folderId]`
          ops.ts              #   `lamasync ops list`
          doctor.ts           #   `lamasync doctor`
          local.ts            #   `lamasync local status|folders|ops|sync|sync-all|mount|unmount`
          hosts.ts            #   `lamasync hosts list|rename`
          apps.ts             #   `lamasync apps templates|protections|snapshots` (LAMA-316; replaces `dotfiles`)
          conflicts.ts        #   `lamasync conflicts list|resolve`
          snapshots.ts        #   `lamasync snapshots list`
          browse.ts           #   `lamasync browse local|s3|restic|jobs`
          notifications.ts    #   `lamasync notifications list|channels`
          admin.ts            #   `lamasync admin prune`
        app/
          theme.ts            # status prefixes + title strings
          widgets.ts          # pageShell, hotkeyFooter, statusBox, loading/error/emptyBox, realize()
          keymap.ts           # Hotkey type + matchHotkey() (char / name dispatch)
          keymap.test.ts      # keymap dispatch unit tests
          view-manager.ts     # View interface, ViewSpec, ViewManager (visible-toggle)
          view-manager.test.ts # view-manager unit tests (fake + gated real renderer)
          shell.ts            # Shell class — TabSelect bar + global dispatch + status
          wizard.ts           # WizardRunner + Wizard/WizardStep + registry
          wizard.test.ts      # wizard state-machine tests (pure)
          fleet-service.ts    # createFleetService() — WS subscription lifted out
          schedule-presets.ts # preset table (mirror web-ui/Dotfiles.tsx)
        views/
          local.ts            # LocalView (folder list + sync/cache/wizard hotkeys)
          fleet.ts            # FleetView (uses FleetService for live WS hosts)
          dotfiles.ts         # app protections/snapshots browser + restore state machine (view id kept internal)
          conflicts.ts        # ConflictsView (highlighted-row resolution + confirm)
          logs.ts             # LogsView (ScrollBox + paginated operations)
          gh-selector.ts      # GhView (GitHub repo adoption via `gh` CLI)
        flows/
          backup-setup.ts     # Wizard factory: create folder + assign host
    agent-skill/              # CLI-first agent skill (LAMA-230); two-tier bundle
      SKILL.md                # frontmatter trigger + decision tree + safety summary
      lamasync-client.md      # separate client-install onboarding skill
      README.md               # bundle overview + install instructions
      reference/
        cli.md                # `lamasync <command> --help` reference (drift-checked)
        api.md                # REST + WebSocket reference (defers to /swagger/json)
        recipes.md            # common workflows (set up backup, fix 401s, etc.)
        troubleshooting.md    # symptom → cause → fix
        safety.md             # the six rules, verbatim
        package.json
    web-ui/                   # @lamasync/web-ui — embedded React SPA (Vite build)
      index.html              # Vite entry HTML
      vite.config.ts          # single-file inlined build (see scripts/inline-web-ui.ts)
      tsconfig.json           # extends root, adds jsx support
      src/
        main.tsx              # React 18 root + StrictMode
        App.tsx               # HashRouter + auth gate
        api.ts                # browser fetch client (sessionStorage bearer)
        concepts.ts           # WS2: inline glossary tokens
        cron.ts               # WS4: shared cron validator
        theme.ts              # LAMA-201: design tokens
        index.css             # hand-rolled dashboard styles
        components/
          Login.tsx           # API-key sign-in form (remember-me, LAMA-WS4)
          Nav.tsx             # top navigation
          Hint.tsx            # WS2: inline explanation pop
          GettingStarted.tsx  # WS2: Dashboard empty-state checklist
          AddHostGuide.tsx    # LAMA-WS4: copy-pasteable install commands
          EditableHostname.tsx# LAMA-225: inline rename
          AssignmentEditor.tsx# LAMA-WS4 + LAMA-239: edit role/path/schedule/mode
          Modal.tsx           # WS4: shared Modal/ConfirmDialog/PromptDialog
          icons.tsx           # inline SVG domain icons
        hooks/
          useWebSocket.ts     # /api/v1/ws client with exponential-backoff reconnect
        pages/
          Dashboard.tsx       # summary cards, hosts table, recent operations, since-last-visit
          Hosts.tsx           # host list + inline rename
          HostDetail.tsx      # per-host detail (sync now, history, assignments)
          Folders.tsx         # list + create + assign + per-host mode + host filter
          Backends.tsx        # LAMA-222 + LAMA-238: reusable backends + test connection
          Dotfiles.tsx        # app backups: host protections + snapshot history, upload/download/delete
          Conflicts.tsx       # pending conflicts + resolve (Pending/Resolved/All)
          Operations.tsx      # operation log + active locks panel + folder/host filter
          DataBrowser.tsx     # LAMA-202/226: local/S3/restic, jobs, write ops
          Admin.tsx           # operation-log prune + notification channels + server info + LAMA-301 Server deployment card
        daemon-update.ts       # LAMA-299: pure Software-section capability/follow-up state (+test)
        server-deploy-ui.ts    # LAMA-301: pure Admin deploy-card view-model (+test)
  scripts/
    gen-version.ts            # writes packages/core/src/version.ts from root package.json
    inline-web-ui.ts          # post-vite inliner: embeds JS/CSS into dist/index.html (single-file SPA)
    check-skill-drift.ts      # LAMA-230: every route in reference/api.md + every flag in reference/cli.md exists
    e2e-harness.sh            # isolated server + daemon end-to-end test harness
    e2e-exoscale.sh           # Exoscale S3 end-to-end check (LAMA-105)
    smoke.sh                  # cheap boot test
    test-install.sh           # Docker smoke test for curl | bash install path
    test-update.sh            # Docker smoke test for curl | bash update path
    e2e-sandbox/              # full client end-to-end sandbox (Docker Compose: server + client)
      docker-compose.yml      # server (ghcr image) + client (Ubuntu, runs install.sh)
      client.Dockerfile       # client test image
      client-test.sh          # install → register → backup → app snapshot → log verification
      socket-send.py          # sends JSON commands to the lamasyncd Unix socket
    deploy-agent/             # @lamasync/deploy-agent — LAMA-301 LXC-resident deploy runner (production only)
      src/
        index.ts              # poll/claim/complete loop + boot validation (fixed script, workdir, docker)
        runner.ts             # injected execution core: fixed-script spawn, stage detection, health backoff
        runner.test.ts        # injected spawner/probe tests (success, failure, health timeout, scrub, cap)
  packaging/                  # curl | bash installer + skill tarball + systemd template
    install/
      install.sh              # install lamasyncd (+ optional TUI) and systemd unit
      update.sh               # standalone self-update script
    systemd/
      lamasyncd.service       # systemd user-unit template
    deploy-agent/
      lamasync-deploy-agent.service # LAMA-301: LXC-resident deploy agent unit (production)
    build-skill-tarball.sh    # LAMA-230: bundles SKILL.md + reference/ into lamasync-skill-<version>.tar.gz
  .github/
    workflows/
      ci.yml                  # type-check, test, build, release, docker push, drift-check
  docs/
    README.md                 # living-document map + archive policy
    development.md            # full dev guide (quick start, tests, recipes, Docker, release)
    repository-layout.md      # this file
    features.md               # implemented features by LAMA issue + known limitations
    status.md                 # current status, active work queue, limitations
    agent-start.md            # short current work-order guide for coding agents
    prod-deploy.md            # production LXC ops (SSH, update, rollback)
    archive/                  # completed handoffs/audits + prior status log
```
