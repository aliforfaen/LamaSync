/**
 * TUI boot sequence — wires the `Shell` with every registered view and
 * hands control over to the renderer.
 *
 * Slice J (LAMA-173) integrates the six foundation views:
 *   - Local      (folder list + sync/cache/wizard hotkeys)
 *   - Fleet      (live hosts via FleetService WebSocket)
 *   - Dotfiles   (app-settings manifests + backup-folder visibility)
 *   - Conflicts  (pending-conflict resolution)
 *   - Logs       (paginated operation log)
 *   - Gh         (GitHub repo selector for `gh` CLI adoption)
 *
 * LAMA-276/D4 additions: a `more` tab is the entry point for tools /
 * integrations and the `gh` view is hidden from the tab bar, reachable
 * only via the More menu (`hiddenFromTabBar` + `homeTab`).
 *
 * `bootShell` resolves the API client, the FleetService, the OpenTUI
 * renderer, and the daemon socket path, then constructs the view instances
 * against a shared `ViewContext` and mounts them through the Shell.
 */
import { createCliRenderer } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { defaultSocketPath } from "@lamasync/core";
import { hostname as osHostname } from "os";

import { buildClient, writeClientConfig } from "./api.ts";
import type { TuiClient } from "./api.ts";
import { createFleetService } from "./app/fleet-service.ts";
import type { FleetService } from "./app/fleet-service.ts";
import { createPauseService } from "./app/pause-service.ts";
import type { PauseService } from "./app/pause-service.ts";
import { Shell } from "./app/shell.ts";
import type { View, ViewContext, ViewId, ViewSpec } from "./app/view-manager.ts";
import { openWizard } from "./app/wizard.ts";
import { runSetupFlow } from "./flows/setup.ts";
import { createPauseWizard } from "./flows/pause.ts";
import type { PauseDialogMode } from "./flows/pause.ts";

import { ConflictsView } from "./views/conflicts.ts";
import { DotfilesView } from "./views/dotfiles.ts";
import { FleetView } from "./views/fleet.ts";
import { GhView } from "./views/gh-selector.ts";
import { LocalView } from "./views/local.ts";
import { LogsView } from "./views/logs.ts";
import { MoreView } from "./views/more.ts";
import { AccessKeysView } from "./views/access-keys.ts";

/**
 * Compose the runtime, wire the six views through the Shell, and start the
 * OpenTUI renderer. Resolves when the renderer terminates; returns normally
 * on user-initiated quit.
 */
export async function bootShell(): Promise<void> {
  let tui: TuiClient = buildClient();
  // LAMA-182: a parked promise alone does not keep the event loop alive, but
  // it makes `bootShell` return cleanly once the renderer tears down. The
  // renderer's `onDestroy` fires on BOTH quit paths (`q` → Shell.destroy() →
  // renderer.destroy(), and Ctrl+C → renderer-initiated destroy), so it is
  // the single place to close the FleetService WebSocket and release this
  // promise; `main()` then returns and Bun exits once the loop drains.
  const { promise: runtimeHeld, resolve: releaseRuntime } =
    Promise.withResolvers<void>();
  // `specs` is populated later in boot (after the views are constructed);
  // it must be initialized here so the renderer's onDestroy can never hit a
  // temporal-dead-zone access on early-teardown paths (setup-wizard cancel
  // or a renderer failure before the views exist) — LAMA-254 audit finding.
  let specs: ViewSpec[] = [];
  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: true,
    autoFocus: true,
    onDestroy: () => {
      for (const spec of specs) spec.destroy?.();
      fleetService.close();
      // LAMA-273: stop the pause poller so a quit / Ctrl+C teardown doesn't
      // leak the interval (the boot promise holds the renderer alive until
      // the renderer itself fires onDestroy, so the loop never drains while
      // the interval keeps the event loop busy).
      pauseService?.stop();
      releaseRuntime();
    },
  });

  // WS3 (TUI foundations): first run with no env vars and no client.toml
  // boots into the setup flow instead of silently using localhost/dev-key.
  // "saved" rewrites the client from the fresh file; "skipped" keeps the
  // default client and surfaces a warning in the status bar.
  if (tui.needsSetup) {
    const outcome = await runSetupFlow({
      renderer,
      writeConfig: writeClientConfig,
      defaultHostname: osHostname(),
    });
    if (outcome === "saved") {
      tui = buildClient();
    }
  }

  const socketPath = defaultSocketPath();

  // The client already resolves env vars > client.toml > defaults — use its
  // baseUrl so the fleet socket and Fleet view dial the SAME server the
  // first-run setup flow just wrote (previously hardcoded env ?? localhost).
  const apiBaseUrl = tui.client.baseUrl;
  const apiKey = tui.client.apiKey;

  // Surface a config-parse error in the status bar without crashing the
  // boot sequence; the views will still load (they hit the API client
  // directly), but the operator can see what went wrong.
  const initialStatus: {
    message: string | null;
    kind: "info" | "error" | "success";
  } = tui.error
    ? { message: `config: ${tui.error}`, kind: "error" }
    : tui.needsSetup
      ? {
          message:
            "no credentials configured — point at a real server via LAMASYNC_SERVER_URL / LAMASYNC_API_KEY or ~/.config/lamasync/client.toml",
          kind: "info",
        }
      : { message: null, kind: "info" };

  const fleetService: FleetService = createFleetService(apiBaseUrl, apiKey);

  // LAMA-273: poll the pause snapshot so the status-bar indicator can
  // reflect "this device is paused" / "fleet is in slow mode" without
  // waiting for the user to open the dialog. The service is created here
  // (before the Shell so we can use `ctx.api`) and started once the shell
  // is ready (otherwise its first caption lands before the renderable
  // exists).
  let pauseService: PauseService | null = null;

  let pendingShell: Shell | null = null;
  let pendingStatus: { message: string | null; kind: "info" | "error" | "success" } =
    initialStatus;

  const ctx: ViewContext = {
    api: tui.client,
    hostname: tui.fromConfigFile ? tui.hostname : "localhost",
    socketPath,
    renderer,
    setStatus: (msg, kind = "info") => {
      pendingStatus = { message: msg, kind };
    },
    openWizard: (w) => {
      openWizard(w);
      // The Shell owns the layout — once it's mounted we hand the modal
      // renderable to the runner so the modal is rendered above the
      // view containers. The Wizard's container is the modal itself.
      const layout = pendingShell?.getLayout();
      if (layout && w.container) {
        layout.add(w.container);
      }
    },
  };


  // Override setStatus with the real Shell once we construct it.
  // Views that mutate OpenTUI nodes after mount receive the renderer so they
  // can instantiate real renderables instead of dead VNode proxies (LAMA-181).
  const views: ReadonlyArray<View> = [
    new LocalView({ renderer }),
    new FleetView({
      service: fleetService,
      serverUrl: apiBaseUrl,
      apiKey,
      renderer,
    }),
    new DotfilesView({ ctx }),
    new ConflictsView({ renderer }),
    new LogsView({ renderer }),
    new GhView({ ctx }),
    new MoreView({ ctx }),
    new AccessKeysView({ ctx }),
  ];

  specs = views.map((view) => ({
    id: view.id,
    title: view.title,
    container: view.container,
    hotkeys: view.hotkeys(),
    ctx,
    // LAMA-276/D4: GitHub is an integration, not a core destination — it
    // hides from the tab bar and is opened from the More menu. Esc returns
    // to More via the Shell's drill-in handling. LAMA-234: the Access keys
    // screen is the same drill-in pattern (hidden, home tab = More).
    hiddenFromTabBar:
      view.id === "gh" || view.id === "access-keys" ? true : undefined,
    homeTab:
      view.id === "gh" || view.id === "access-keys" ? "more" : undefined,
    // Relook (owner, 2026-08-23): tab bar uses the short label so six tabs
    // fit at 80 cols; the page heading + help keep the full approved name.
    tabLabel: view.id === "dotfiles" ? "Backups" : undefined,
    onShow: () => view.onShow(ctx),
    onHide: view.onHide?.bind(view),
    handleKey: view.handleKey?.bind(view),
    destroy: view.destroy?.bind(view),
  }));

  const shell = new Shell({
    renderer,
    ctxByView: ctx,
    views: () => specs,
    startView: "local",
    onPauseRequest: () => openPauseDialog(),
  });
  pendingShell = shell;

  (ctx as { setStatus: (m:string, k?:"info"|"error"|"success") => void }).setStatus = (msg, kind = "info") => {
    shell.setStatus(msg, kind);
  };

  // LAMA-276/D4: wire the drill-in navigation so the More menu can open the
  // hidden GitHub view (and Esc returns to More via the Shell).
  (ctx as { navigateTo?: (id: ViewId) => void }).navigateTo = (id: ViewId) => {
    shell.showView(id);
  };

  // LAMA-273: Ctrl+P opens the pause / resume dialog. The shell hands the
  // key here, which fetches the current snapshot, picks set-vs-resume, and
  // mounts the wizard. A best-effort failure (API 401/offline) surfaces
  // through the status bar and skips the wizard. Hoisted above its first
  // caller (the Shell ctor closure above) so the reference stays clean.
  function openPauseDialog(): void {
    void (async () => {
      try {
        const current = await tui.client.getPause();
        const localHostId = tui.hostname;
        const hostRow = current.hosts.find((row) => row.hostId === localHostId) ?? null;
        const hasActive = hostRow !== null || current.global !== null;
        const mode: PauseDialogMode = hasActive ? "resume" : "set";
        const wizard = createPauseWizard({
          ctx,
          mode,
          current,
        });
        openWizard(wizard);
        const layout = pendingShell?.getLayout();
        if (layout && wizard.container) {
          layout.add(wizard.container);
        }
      } catch (err) {
        ctx.setStatus(
          `pause dialog failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    })();
  }

  // LAMA-273: build the pause service now that we have a real shell to
  // notify. It owns no UI state of its own — just calls shell.setPauseIndicator
  // whenever the resolved caption changes.
  pauseService = createPauseService({
    api: tui.client,
    localHostId: tui.hostname,
    onCaption: (caption) => {
      shell.setPauseIndicator(caption);
    },
  });

  if (pendingStatus.message) {
    shell.setStatus(pendingStatus.message, pendingStatus.kind);
  }

  shell.start();
  renderer.start();
  // WS3 (TUI foundations): the Fleet view only goes live once the service
  // socket is opened. Start it right after the renderer so the header can
  // reflect "live" on the first paint (the view also refreshes via
  // getHealth on demand).
  fleetService.start();
  // LAMA-273: kick off the pause poller last so the very first caption
  // lands after the shell is mounted (otherwise setPauseIndicator writes
  // to a Text renderable that isn't yet attached).
  if (pauseService) pauseService.start();

  // Hold the runtime alive until the renderer is destroyed. The OpenTUI
  // renderer keeps the event loop busy on its own; this promise just parks
  // a microtask so the boot function doesn't return prematurely. The
  // renderer's onDestroy resolves it once the shell tears down.
  await runtimeHeld;
}
