import { join } from "path";
import { hostname as osHostname, homedir } from "os";
import {
  Box,
  Text,
  createCliRenderer,
} from "@opentui/core";
import type { CliRenderer, KeyEvent, VNode } from "@opentui/core";
import { VERSION } from "@lamasync/core";
import type { Folder, Host as ServerHost } from "@lamasync/core";

import { buildClient } from "./api.ts";
import type { TuiClient } from "./api.ts";
import { runCliFallback } from "./cli-fallback.ts";
import {
  requestSwitchMount,
  requestSwitchSync,
  requestSyncOne,
  requestSyncAll,
} from "./socket-client.ts";
import { renderMenu } from "./views/menu.ts";
import type { MenuItem } from "./views/menu.ts";
import { buildFstabLine, renderLocal } from "./views/local.ts";
import type { LocalAction, LocalFolder } from "./views/local.ts";
import type { FleetAction, FleetHost, FleetSubscription } from "./views/fleet.ts";
import { openFleetSubscription, renderFleet } from "./views/fleet.ts";
import { renderDotfiles } from "./views/dotfiles.ts";
import type { DotfilesAction, DotfilesController } from "./views/dotfiles.ts";
import { renderLogs } from "./views/logs.ts";
import type { LogsAction, LogsState } from "./views/logs.ts";
import { fetchLogPage, nextStatusFilter } from "./views/logs.ts";
import { renderConflicts } from "./views/conflicts.ts";
import type { ConflictsAction, ConflictsController } from "./views/conflicts.ts";
import { handleGhKey, renderGhSelector } from "./views/gh-selector.ts";
import type { GhRepo } from "./views/gh-selector.ts";

type ViewName =
  | "menu"
  | "local"
  | "fleet"
  | "dotfiles"
  | "logs"
  | "conflicts"
  | "gh";

interface GhControllerState {
  repos: GhRepo[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  busyMessage: string | null;
}

interface GhController {
  state: GhControllerState;
  view: VNode;
  handleKey: (e: KeyEvent) => boolean;
}
interface AppState {
  view: ViewName;
  renderer: CliRenderer | null;
  hostname: string;
  client: TuiClient;
  localFolders: LocalFolder[];
  selectedFolderId: string | null;
  fleetHosts: FleetHost[];
  fleetError: string | null;
  fleetLoading: boolean;
  logs: LogsState;
  dotfiles: DotfilesController | null;
  conflicts: ConflictsController | null;
  gh: GhController | null;
  fleetSubscription: FleetSubscription | null;
  apiBaseUrl: string;
  apiKey: string;
  status: string | null;
  statusKind: "info" | "error" | "success";
}

function setStatus(state: AppState, text: string, kind: "info" | "error" | "success" = "info"): void {
  state.status = text;
  state.statusKind = kind;
  redraw(state);
}
export async function main(): Promise<void> {
  if (process.argv.includes("--version") || process.argv.includes("-V")) {
    console.log(`lamasync-tui ${VERSION}`);
    process.exit(0);
  }

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
  const renderer = await createCliRenderer({ exitOnCtrlC: true, autoFocus: true });
  const localHostname = osHostname();

  const state: AppState = {
    view: "menu",
    renderer,
    hostname: tuiClient.fromConfigFile ? hostname : localHostname,
    client: tuiClient,
    localFolders: [],
    selectedFolderId: null,
    fleetHosts: [],
    fleetError: null,
    fleetLoading: false,
    logs: { entries: [], status: "all", hostId: null, page: 0 },
    dotfiles: null,
    conflicts: null,
    gh: null,
    fleetSubscription: null,
    apiBaseUrl: serverBaseUrl(),
    apiKey: client.apiKey,
    status: null,
    statusKind: "info",
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
  // Use the renderer's global keyInput emitter so keys arrive regardless of
  // which widget is focused.  root.onKeyDown only fires when no focusable
  // widget is active or when a focused widget lets the event bubble up.
  renderer.keyInput.on("keypress", (e: KeyEvent) => {
    const name = (e.name ?? "").toLowerCase();
    const raw = typeof e.raw === "string" ? e.raw : "";
    const char = raw.length === 1 ? raw.toLowerCase() : "";

    // ESC or q: navigate back to menu (or quit from menu).
    // Dotfiles and gh views have internal sub-steps; let them handle ESC first.
    if (name === "escape" || char === "q") {
      if (state.view === "dotfiles") {
        // At app-select step, ESC/q exits to menu.  Deeper steps are handled
        // by dotfiles' internal handleKey below.
        if (state.dotfiles && state.dotfiles.state.step !== "app") {
          state.dotfiles.handleKey(e);
          redraw(state);
          return;
        }
        navigate(state, "menu", renderer);
        return;
      }
      if (state.view === "gh") {
        if (state.gh && state.gh.handleKey(e)) {
          redraw(state);
          return;
        }
        navigate(state, "menu", renderer);
        return;
      }
      if (state.view === "conflicts") {
        state.conflicts?.handleKey(e);
        redraw(state);
        return;
      }
      if (state.view === "menu") {
        // q from menu exits the app.
        destroyRenderer(renderer);
        return;
      }
      // Local, fleet, logs: ESC or q goes back to menu.
      navigate(state, "menu", renderer);
      return;
    }

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
    if (state.view === "conflicts") {
      state.conflicts?.handleKey(e);
      redraw(state);
      return;
    }
    if (state.view === "gh") {
      // gh internal keys (r = refresh) not handled by ESC/q block above
      if (state.gh?.handleKey(e)) {
        redraw(state);
      }
      return;
    }
    if (state.view === "dotfiles") {
      state.dotfiles?.handleKey(e);
      redraw(state);
      return;
    }
  });
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
    c: "conflicts",
    p: "cache-profile",
    s: "switch-type",
    n: "network-shares",
    g: "gh",
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
      void runSyncAll(state);
      break;
    case "sync-one":
      void runSyncOne(state);
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
    case "conflicts":
      navigate(state, "conflicts", renderer);
      return;
    case "quit":
      destroyRenderer(renderer);
      return;
    case "cache-profile":
      void runCacheProfile(state);
      return;
    case "switch-type":
      void runSwitchType(state);
      return;
    case "network-shares":
      void runNetworkShares(state);
      return;
    case "gh":
      navigate(state, "gh", renderer);
      void runGhRepoSelector(state);
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
      () => state.fleetHosts,
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
  if (view === "conflicts" && !state.conflicts) {
    state.conflicts = renderConflicts({
      api: state.client.client,
      currentHostId: state.client.hostname,
      onAction: (a: ConflictsAction) => {
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
        state: {
          folders: state.localFolders,
          hostname: state.hostname,
          selectedFolderId: state.selectedFolderId,
          status: state.status,
          statusKind: state.statusKind,
        },
        onAction: (a: LocalAction) => applyLocalAction(a, state),
        onSelectFolder: (folderId: string) => {
          state.selectedFolderId = folderId;
          redraw(state);
        },
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
    case "conflicts":
      return state.conflicts?.view ?? Text({ content: "Loading conflicts…" });
    case "gh":
      return (
        state.gh?.view ??
        Text({ content: "Loading GitHub repos…" })
      );
  }
}

async function refreshLocalFolders(state: AppState): Promise<void> {
  try {
    const [folders, config] = await Promise.all([
      state.client.client.listFolders(),
      state.client.client.getConfig(state.hostname).catch(() => null),
    ]);
    const byId = new Map(
      (config?.assignments ?? []).map((a) => [a.folderId, a]),
    );
    state.localFolders = folders.map((f) => {
      const a = byId.get(f.id);
      return {
        id: f.id,
        hostId: a?.hostId ?? state.hostname,
        name: f.name,
        type: f.type,
        lastStatus: undefined,
        lastRun: null,
        cacheProfile: a?.cacheProfile ?? null,
        cacheMaxSize: a?.cacheMaxSize ?? null,
        gitProvider: f.gitProvider ?? null,
        gitRemote: f.gitRemote ?? null,
        backend: f.backend ?? null,
      };
    });
  } catch {
    state.localFolders = [];
  }
}
function selectedLocalFolder(state: AppState): LocalFolder | null {
  if (state.selectedFolderId) {
    const found = state.localFolders.find((f) => f.id === state.selectedFolderId);
    if (found) return found;
  }
  return state.localFolders[0] ?? null;
}

async function runSyncAll(state: AppState): Promise<void> {
  setStatus(state, "Queueing sync for every assigned folder…", "info");
  try {
    const res = (await requestSyncAll()) as { started: boolean; all: boolean };
    setStatus(
      state,
      res?.started
        ? "Sync queued for all assigned folders."
        : "Daemon accepted sync-all but returned no started flag.",
      "success",
    );
  } catch (err) {
    setStatus(
      state,
      `sync-all failed: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }
}

async function runSyncOne(state: AppState): Promise<void> {
  const folder = selectedLocalFolder(state);
  if (!folder) {
    setStatus(state, "sync-one: no folder selected.", "error");
    return;
  }
  setStatus(state, `Queueing sync for ${folder.name}…`, "info");
  try {
    const res = (await requestSyncOne(folder.id)) as { started: boolean; folderId: string };
    setStatus(
      state,
      res?.started
        ? `Sync queued for ${folder.name}.`
        : `Daemon accepted sync but returned no started flag for ${folder.name}.`,
      "success",
    );
  } catch (err) {
    setStatus(
      state,
      `sync-one failed: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }
}

async function runCacheProfile(state: AppState): Promise<void> {
  const folder = selectedLocalFolder(state);
  if (!folder) {
    setStatus(state, "cache-profile: no folder selected.", "error");
    return;
  }
  if (folder.type !== "mount") {
    setStatus(
      state,
      `cache-profile only applies to mount folders; ${folder.name} is ${folder.type ?? "sync"}.`,
      "error",
    );
    return;
  }
  const order: Array<"normal" | "media" | "minimal"> = ["normal", "media", "minimal"];
  const current = folder.cacheProfile ?? "normal";
  const next = order[(order.indexOf(current) + 1) % order.length];
  setStatus(
    state,
    `cache-profile: ${folder.name} ${current} -> ${next} (writing through server)…`,
    "info",
  );
  try {
    await state.client.client.updateAssignment(folder.id, folder.hostId, {
      cacheProfile: next,
    });
    setStatus(state, `cache-profile updated: ${folder.name} -> ${next}.`, "success");
    await refreshLocalFolders(state);
  } catch (err) {
    setStatus(
      state,
      `cache-profile failed: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }
}

async function runSwitchType(state: AppState): Promise<void> {
  const folder = selectedLocalFolder(state);
  if (!folder) {
    setStatus(state, "switch-type: no folder selected.", "error");
    return;
  }
  const folderType = folder.type ?? "sync";
  const target: "sync" | "mount" = folderType === "mount" ? "sync" : "mount";
  setStatus(
    state,
    `switch-type: ${folder.name} ${folderType} -> ${target}; awaiting daemon…`,
    "info",
  );
  try {
    const data =
      target === "mount"
        ? await requestSwitchMount(folder.id)
        : await requestSwitchSync(folder.id);
    setStatus(
      state,
      `switch-type ok: ${folder.name} -> ${target} (${JSON.stringify(data)})`,
      "success",
    );
  } catch (err) {
    setStatus(
      state,
      `switch-type failed: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }
}

async function runNetworkShares(state: AppState): Promise<void> {
  try {
    const shares = await state.client.client.listShares();
    if (shares.length === 0) {
      setStatus(
        state,
        "network-shares: no shares configured (set LAMASYNC_SHARES or shares.json).",
        "error",
      );
      return;
    }
    const lines: string[] = [];
    for (const share of shares) {
      const mountPoint = `/mnt/lamasync/${share.id}`;
      const line = buildFstabLine(share, mountPoint);
      lines.push(line);
    }
    // The TUI never writes to /etc/fstab itself. Surface the fstab lines plus
    // the exact `sudo mount -a` (or per-share `sudo mount <spec> <mountPoint>`)
    // command for the operator to run.
    setStatus(
      state,
      `network-shares: copy these lines into /etc/fstab, then run \`sudo mount -a\`:\n  ${lines.join("\n  ")}`,
      "info",
    );
  } catch (err) {
    setStatus(
      state,
      `network-shares failed: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }
}

async function refreshGhRepos(state: AppState): Promise<void> {
  const gh = state.gh;
  if (!gh) return;
  gh.state.loading = true;
  gh.state.error = null;
  gh.view = renderGhSelector({
    repos: gh.state.repos,
    loading: true,
    onSelect: () => undefined,
    onCancel: () => {
      navigate(state, "local", state.renderer!);
    },
    onRefresh: () => {
      void refreshGhRepos(state);
    },
  });
  redraw(state);
  if (!Bun.which("gh")) {
    gh.state.loading = false;
    gh.state.error = "gh CLI not found in PATH";
    gh.view = renderGhSelector({
      repos: [],
      error: gh.state.error,
      onSelect: () => undefined,
      onCancel: () => {
        navigate(state, "local", state.renderer!);
      },
      onRefresh: () => {
        void refreshGhRepos(state);
      },
    });
    redraw(state);
    return;
  }
  const proc = Bun.spawnSync({
    cmd: ["gh", "repo", "list", "--json", "name,nameWithOwner,url", "-L", "100"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    gh.state.loading = false;
    const errTail = new TextDecoder().decode(proc.stderr).slice(-500);
    gh.state.error = `gh repo list failed (exit ${proc.exitCode}): ${errTail}`;
    gh.view = renderGhSelector({
      repos: [],
      error: gh.state.error,
      onSelect: () => undefined,
      onCancel: () => {
        navigate(state, "local", state.renderer!);
      },
      onRefresh: () => {
        void refreshGhRepos(state);
      },
    });
    redraw(state);
    return;
  }
  try {
    const stdout = new TextDecoder().decode(proc.stdout);
    const parsed: unknown = JSON.parse(stdout);
    const repos: GhRepo[] = Array.isArray(parsed)
      ? parsed
          .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
          .map((r) => ({
            name: typeof r.name === "string" ? r.name : "",
            nameWithOwner:
              typeof r.nameWithOwner === "string" ? r.nameWithOwner : "",
            url: typeof r.url === "string" ? r.url : "",
          }))
          .filter((r) => r.name !== "" && r.nameWithOwner !== "")
      : [];
    gh.state.repos = repos;
    gh.state.error = null;
  } catch (err) {
    gh.state.error =
      err instanceof Error ? err.message : `failed to parse gh output: ${String(err)}`;
    gh.state.repos = [];
  } finally {
    gh.state.loading = false;
  }
  gh.view = renderGhSelector({
    repos: gh.state.repos,
    error: gh.state.error,
    loading: gh.state.loading,
    onSelect: (repo) => {
      void adoptGhRepo(state, repo);
    },
    onCancel: () => {
      navigate(state, "local", state.renderer!);
    },
    onRefresh: () => {
      void refreshGhRepos(state);
    },
  });
  redraw(state);
}

async function adoptGhRepo(state: AppState, repo: GhRepo): Promise<void> {
  const renderer = state.renderer;
  if (!renderer) return;
  const gh = state.gh;
  if (!gh) return;
  if (gh.state.busy) return;
  gh.state.busy = true;
  gh.state.busyMessage = `Creating folder for ${repo.nameWithOwner}…`;
  gh.view = renderGhSelector({
    repos: gh.state.repos,
    error: gh.state.error,
    loading: gh.state.loading,
    onSelect: () => undefined,
    onCancel: () => undefined,
  });
  redraw(state);
  try {
    const folder = await state.client.client.createFolder({
      name: repo.name,
      type: "git",
      gitProvider: "gh",
      gitRemote: repo.nameWithOwner,
      encrypted: false,
      cryptPassword: null,
    });
    gh.state.busyMessage = `Assigning folder to ${state.hostname}…`;
    redraw(state);
    await state.client.client.assignFolder(folder.id, {
      folderId: folder.id,
      hostId: state.hostname,
      role: "both",
      localPath: join(homedir(), "projects", repo.name),
      enabled: true,
    });
    gh.state.busyMessage = "Triggering initial sync…";
    redraw(state);
    await requestSyncOne(folder.id);
  } catch (err) {
    gh.state.error =
      err instanceof Error ? err.message : `failed to adopt repo: ${String(err)}`;
    gh.state.busy = false;
    gh.state.busyMessage = null;
    gh.view = renderGhSelector({
      repos: gh.state.repos,
      error: gh.state.error,
      loading: gh.state.loading,
      onSelect: (r) => {
        void adoptGhRepo(state, r);
      },
      onCancel: () => {
        navigate(state, "local", renderer);
      },
    });
    redraw(state);
    return;
  }
  gh.state.busy = false;
  gh.state.busyMessage = null;
  navigate(state, "local", renderer);
  void refreshLocalFolders(state);
  redraw(state);
}

function runGhRepoSelector(state: AppState): void {
  const renderer = state.renderer;
  if (!renderer) return;
  const view: VNode = renderGhSelector({
    repos: [],
    loading: true,
    onSelect: () => undefined,
    onCancel: () => {
      navigate(state, "local", renderer);
    },
    onRefresh: () => {
      void refreshGhRepos(state);
    },
  });
  state.gh = {
    state: {
      repos: [],
      loading: true,
      error: null,
      busy: false,
      busyMessage: null,
    },
    view,
    handleKey: (e: KeyEvent) => {
      if (!state.gh) return false;
      return handleGhKey(e, {
        repos: state.gh.state.repos,
        error: state.gh.state.error,
        loading: state.gh.state.loading,
        onSelect: () => undefined,
        onCancel: () => {
          navigate(state, "local", renderer);
        },
        onRefresh: () => {
          void refreshGhRepos(state);
        },
      });
    },
  };
  redraw(state);
  void refreshGhRepos(state);
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
