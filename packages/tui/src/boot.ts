/**
 * TUI boot sequence — wires the `Shell` with every registered view and
 * hands control over to the renderer.
 *
 * Slice J (LAMA-173) integrates the six foundation views:
 *   - Local      (folder list + sync/cache/wizard hotkeys)
 *   - Fleet      (live hosts via FleetService WebSocket)
 *   - Dotfiles   (manifest browser + restore wizard)
 *   - Conflicts  (pending-conflict resolution)
 *   - Logs       (paginated operation log)
 *   - Gh         (GitHub repo selector for `gh` CLI adoption)
 *
 * `bootShell` resolves the API client, the FleetService, the OpenTUI
 * renderer, and the daemon socket path, then constructs the view instances
 * against a shared `ViewContext` and mounts them through the Shell.
 */
import { homedir } from "os";
import { join } from "path";

import { createCliRenderer } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";

import { buildClient } from "./api.ts";
import type { TuiClient } from "./api.ts";
import { createFleetService } from "./app/fleet-service.ts";
import type { FleetService } from "./app/fleet-service.ts";
import { Shell } from "./app/shell.ts";
import type { View, ViewContext, ViewSpec } from "./app/view-manager.ts";
import { openWizard } from "./app/wizard.ts";

import { ConflictsView } from "./views/conflicts.ts";
import { DotfilesView } from "./views/dotfiles.ts";
import { FleetView } from "./views/fleet.ts";
import { GhView } from "./views/gh-selector.ts";
import { LocalView } from "./views/local.ts";
import { LogsView } from "./views/logs.ts";

/**
 * Compose the runtime, wire the six views through the Shell, and start the
 * OpenTUI renderer. Resolves when the renderer terminates; returns normally
 * on user-initiated quit.
 */
export async function bootShell(): Promise<void> {
  const tui: TuiClient = buildClient();
  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: true,
    autoFocus: true,
  });

  const socketPath =
    process.env.LAMASYNC_SOCKET_PATH ?? join(homedir(), "lamasync.sock");

  const apiBaseUrl =
    process.env.LAMASYNC_SERVER_URL ?? "http://localhost:8080";
  const apiKey = tui.client.apiKey;

  // Surface a config-parse error in the status bar without crashing the
  // boot sequence; the views will still load (they hit the API client
  // directly), but the operator can see what went wrong.
  const initialStatus: {
    message: string | null;
    kind: "info" | "error" | "success";
  } = tui.error
    ? { message: `config: ${tui.error}`, kind: "error" }
    : { message: null, kind: "info" };

  const fleetService: FleetService = createFleetService(apiBaseUrl, apiKey);

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
  ];

  const specs: ViewSpec[] = views.map((view) => ({
    id: view.id,
    title: view.title,
    container: view.container,
    hotkeys: view.hotkeys(),
    ctx,
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
  });
  pendingShell = shell;

  (ctx as { setStatus: (m:string, k?:"info"|"error"|"success") => void }).setStatus = (msg, kind = "info") => {
    shell.setStatus(msg, kind);
  };

  if (pendingStatus.message) {
    shell.setStatus(pendingStatus.message, pendingStatus.kind);
  }

  shell.start();
  renderer.start();

  // Hold the runtime alive until the renderer is destroyed. The OpenTUI
  // renderer keeps the event loop busy on its own; this promise just parks
  // a microtask so the boot function doesn't return prematurely.
  await new Promise<void>(() => undefined);
}
