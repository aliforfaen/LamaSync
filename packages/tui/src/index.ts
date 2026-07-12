import { hostname as osHostname } from "os";
import {
  Box,
  Text,
  createCliRenderer,
} from "@opentui/core";
import type { CliRenderer, KeyEvent } from "@opentui/core";

import type { Host as ServerHost } from "@lamasync/core";

import { buildClient } from "./api.ts";
import type { TuiClient } from "./api.ts";
import { runCliFallback } from "./cli-fallback.ts";
import { renderMenu } from "./views/menu.ts";
import type { MenuItem } from "./views/menu.ts";
import { renderLocal } from "./views/local.ts";
import type { LocalAction, LocalFolder } from "./views/local.ts";
import { renderFleet } from "./views/fleet.ts";
import type { FleetAction, FleetHost, FleetSubscription } from "./views/fleet.ts";
import { openFleetSubscription } from "./views/fleet.ts";
import { renderDotfiles } from "./views/dotfiles.ts";
import type { DotfilesAction, DotfilesController } from "./views/dotfiles.ts";
import { renderLogs } from "./views/logs.ts";
import type { LogsAction, LogsState } from "./views/logs.ts";
import { fetchLogPage, nextStatusFilter } from "./views/logs.ts";

type ViewName = "menu" | "local" | "fleet" | "dotfiles" | "logs";

interface AppState {
  view: ViewName;
  renderer: CliRenderer | null;
  hostname: string;
  client: TuiClient;
  localFolders: LocalFolder[];
  fleetHosts: FleetHost[];
  fleetError: string | null;
  fleetLoading: boolean;
  logs: LogsState;
  dotfiles: DotfilesController | null;
  fleetSubscription: FleetSubscription | null;
  apiBaseUrl: string;
  apiKey: string;
}

export async function main(): Promise<void> {
  if (process.env.LAMASYNC_NO_TUI === "1") {
    await runCliFallback();
    return;
  }
  try {
    await runTui();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("renderer") || message.includes("native")) {
      console.error(`OpenTUI failed (${message}); falling back to CLI mode.`);
      await runCliFallback();
      return;
    }
    throw err;
  }
}

async function runTui(): Promise<void> {
  const tuiClient = buildClient();
  const { client, hostname, error: configError } = tuiClient;
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const localHostname = osHostname();

  const state: AppState = {
    view: "menu",
    renderer,
    hostname: tuiClient.fromConfigFile ? hostname : localHostname,
    client: tuiClient,
    localFolders: [],
    fleetHosts: [],
    fleetError: null,
    fleetLoading: false,
    logs: { entries: [], status: "all", hostId: null, page: 0 },
    dotfiles: null,
    fleetSubscription: null,
    apiBaseUrl: serverBaseUrl(),
    apiKey: process.env.LAMASYNC_API_KEY ?? "dev-key",
  };

  if (configError) {
    renderConfigError(renderer, configError);
    renderer.start();
    await new Promise(() => undefined);
    return;
  }

  installKeyHandler(renderer, state);
  redraw(state);
  renderer.start();
  await new Promise(() => undefined);
}

function renderConfigError(renderer: CliRenderer, message: string): void {
  const root = renderer.root;
  root.add(
    Box(
      { flexDirection: "column", padding: 1, border: true },
      Text({ content: "LamaSync TUI" }),
      Text({ content: message }),
      Text({ content: "Press Ctrl+C to exit." }),
    ),
  );
}

function installKeyHandler(renderer: CliRenderer, state: AppState): void {
  const root = renderer.root;
  root.onKeyDown = (e: KeyEvent) => {
    const name = (e.name ?? "").toLowerCase();
    const raw = typeof e.raw === "string" ? e.raw : "";
    const char = raw.length === 1 ? raw.toLowerCase() : "";

    if (state.view === "menu") {
      handleMenuKey(e, name, char, state, renderer);
      return;
    }
    if (state.view === "local") {
      handleLocalKey(char, state);
      return;
    }
    if (state.view === "fleet") {
      handleFleetKey(char, state);
      return;
    }
    if (state.view === "logs") {
      handleLogsKey(char, state);
      return;
    }
    if (state.view === "dotfiles") {
      if (name === "escape" || char === "q") {
        if (state.dotfiles && state.dotfiles.state.step === "app") {
          navigate(state, "menu", renderer);
        }
        return;
      }
      state.dotfiles?.handleKey(e);
      redraw(state);
      return;
    }
  };
}

function handleMenuKey(
  e: KeyEvent,
  name: string,
  char: string,
  state: AppState,
  renderer: CliRenderer,
): void {
  if (name === "escape" || char === "q") {
    destroyRenderer(renderer);
    return;
  }
  if (char >= "1" && char <= "5") {
    const idx = Number(char) - 1;
    const items: MenuItem[] = ["local", "fleet", "dotfiles", "logs", "quit"];
    const item = items[idx];
    if (!item) return;
    applyMenuPick(item, state, renderer);
    return;
  }
  if (name === "return" || name === "enter") {
    applyMenuPick("quit", state, renderer);
  }
}

function applyMenuPick(
  item: MenuItem,
  state: AppState,
  renderer: CliRenderer,
): void {
  if (item === "quit") {
    destroyRenderer(renderer);
    return;
  }
  navigate(state, item === "local" ? "local" : item, renderer);
}

function handleLocalKey(char: string, state: AppState): void {
  const map: Record<string, LocalAction> = {
    "1": "sync-all",
    "2": "sync-one",
    "3": "refresh",
    "4": "fleet",
    "5": "logs",
    "6": "dotfiles",
    q: "quit",
  };
  const action = map[char];
  if (!action || !state.renderer) return;
  applyLocalAction(action, state);
}

function applyLocalAction(action: LocalAction, state: AppState): void {
  const renderer = state.renderer;
  if (!renderer) return;
  switch (action) {
    case "sync-all":
      console.log("(local) sync-all invoked");
      break;
    case "sync-one":
      console.log("(local) sync-one invoked");
      break;
    case "refresh":
      void refreshLocalFolders(state);
      break;
    case "fleet":
      navigate(state, "fleet", renderer);
      return;
    case "logs":
      navigate(state, "logs", renderer);
      return;
    case "dotfiles":
      navigate(state, "dotfiles", renderer);
      return;
    case "quit":
      destroyRenderer(renderer);
      return;
  }
  redraw(state);
}

function handleFleetKey(char: string, state: AppState): void {
  const map: Record<string, FleetAction> = {
    r: "refresh",
    l: "logs",
    d: "dotfiles",
    b: "local",
    q: "quit",
  };
  const action = map[char];
  if (!action || !state.renderer) return;
  applyFleetAction(action, state);
}

function applyFleetAction(action: FleetAction, state: AppState): void {
  const renderer = state.renderer;
  if (!renderer) return;
  switch (action) {
    case "refresh":
      void refreshFleet(state);
      return;
    case "logs":
      navigate(state, "logs", renderer);
      return;
    case "dotfiles":
      navigate(state, "dotfiles", renderer);
      return;
    case "local":
      navigate(state, "local", renderer);
      return;
    case "quit":
      destroyRenderer(renderer);
      return;
  }
}

function handleLogsKey(char: string, state: AppState): void {
  const map: Record<string, LogsAction> = {
    r: "refresh",
    n: "next",
    p: "prev",
    f: "filter",
    q: "quit",
  };
  const action = map[char];
  if (!action || !state.renderer) return;
  applyLogsAction(action, state);
}

function applyLogsAction(action: LogsAction, state: AppState): void {
  const renderer = state.renderer;
  if (!renderer) return;
  switch (action) {
    case "refresh":
      void refreshLogs(state);
      return;
    case "filter":
      state.logs.status = nextStatusFilter(state.logs.status);
      state.logs.page = 0;
      void refreshLogs(state);
      return;
    case "next":
      state.logs.page += 1;
      redraw(state);
      return;
    case "prev":
      state.logs.page = Math.max(0, state.logs.page - 1);
      redraw(state);
      return;
    case "quit":
      destroyRenderer(renderer);
      return;
  }
}

function navigate(
  state: AppState,
  view: ViewName,
  renderer: CliRenderer,
): void {
  if (view === "fleet" && !state.fleetSubscription) {
    state.fleetSubscription = openFleetSubscription(
      state.apiBaseUrl,
      state.apiKey,
      (hosts: FleetHost[]) => {
        state.fleetHosts = hosts;
        redraw(state);
      },
    );
  }
  if (view === "dotfiles" && !state.dotfiles) {
    state.dotfiles = renderDotfiles({
      api: state.client.client,
      currentHostId: state.client.hostname,
      ctx: renderer,
      onAction: (a: DotfilesAction) => {
        if (a === "menu") navigate(state, "menu", renderer);
        else if (a === "quit") destroyRenderer(renderer);
      },
    });
  }
  state.view = view;
  if (view === "fleet") {
    void refreshFleet(state);
    return;
  }
  if (view === "logs") {
    void refreshLogs(state);
    return;
  }
  redraw(state);
}

function redraw(state: AppState): void {
  const renderer = state.renderer;
  if (!renderer) return;
  const root = renderer.root;
  for (const child of root.getChildren()) {
    root.remove(child.id);
  }
  root.add(renderCurrent(state));
}

function renderCurrent(state: AppState) {
  switch (state.view) {
    case "menu":
      return renderMenu({
        onPick: (item: MenuItem) => {
          if (!state.renderer) return;
          if (item === "quit") {
            destroyRenderer(state.renderer);
            return;
          }
          navigate(state, item, state.renderer);
        },
      });
    case "local":
      return renderLocal({
        state: { folders: state.localFolders, hostname: state.hostname },
        onAction: (a: LocalAction) => applyLocalAction(a, state),
      });
    case "fleet":
      return renderFleet({
        state: { hosts: state.fleetHosts },
        serverUrl: state.apiBaseUrl,
        apiKey: state.apiKey,
        onAction: (a: FleetAction) => applyFleetAction(a, state),
        onHosts: (hosts: FleetHost[]) => {
          state.fleetHosts = hosts;
          redraw(state);
        },
      });
    case "dotfiles":
      return state.dotfiles?.view ?? Text({ content: "Loading dotfiles…" });
    case "logs":
      return renderLogs({
        api: state.client.client,
        state: state.logs,
        onAction: (a: LogsAction) => applyLogsAction(a, state),
      });
  }
}

async function refreshLocalFolders(state: AppState): Promise<void> {
  try {
    const folders = await state.client.client.listFolders();
    state.localFolders = folders.map((f) => ({
      id: f.id,
      name: f.name,
      lastStatus: undefined,
    }));
  } catch {
    state.localFolders = [];
  }
  redraw(state);
}

async function refreshFleet(state: AppState): Promise<void> {
  state.fleetLoading = true;
  state.fleetError = null;
  redraw(state);
  try {
    const health = await state.client.client.getHealth();
    state.fleetHosts = health.hosts.map(toFleetHost);
  } catch (err) {
    state.fleetError = err instanceof Error ? err.message : String(err);
  } finally {
    state.fleetLoading = false;
    redraw(state);
  }
}

function toFleetHost(host: ServerHost): FleetHost {
  return {
    id: host.id,
    hostname: host.hostname,
    status: host.status,
    lastSeen: host.lastSeen ?? null,
    tailnetIp: host.tailnetIp ?? undefined,
  };
}

async function refreshLogs(state: AppState): Promise<void> {
  try {
    state.logs.entries = await fetchLogPage(state.client.client, state.logs);
  } catch {
    state.logs.entries = [];
  }
  redraw(state);
}

function destroyRenderer(renderer: CliRenderer): void {
  renderer.destroy();
  process.exit(0);
}

function serverBaseUrl(): string {
  return (
    process.env.LAMASYNC_SERVER_URL ??
    "http://localhost:8080"
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`TUI fatal: ${message}`);
  process.exit(1);
});
