import { Box, Select, Text } from "@opentui/core";
import type { VNode } from "@opentui/core";

export type LocalAction =
  | "sync-all"
  | "sync-one"
  | "refresh"
  | "fleet"
  | "logs"
  | "dotfiles"
  | "conflicts"
  | "cache-profile"
  | "switch-type"
  | "network-shares"
  | "gh"
  | "quit";

export type LocalFolderType = "sync" | "mount" | "backup" | "dotfile" | "git";

export type GitProvider = "git" | "gh";
export type CacheProfileKind = "normal" | "media" | "minimal";

export interface LocalFolder {
  id: string;
  hostId: string;
  name: string;
  type?: LocalFolderType;
  lastStatus?: string;
  lastRun?: number | null;
  cacheProfile?: CacheProfileKind | null;
  cacheMaxSize?: string | null;
  gitProvider?: GitProvider | null;
  gitRemote?: string | null;
}
export interface LocalState {
  folders: LocalFolder[];
  hostname: string;
  status: string | null;
  statusKind: "info" | "error" | "success";
}

export interface RenderLocalOpts {
  state: LocalState;
  onAction: (action: LocalAction) => void;
}

interface FolderRow {
  name: string;
  description: string;
  value: string;
}

const HOTKEYS: Array<{ key: string; label: string; action: LocalAction }> = [
  { key: "1", label: "sync-all", action: "sync-all" },
  { key: "2", label: "sync-one", action: "sync-one" },
  { key: "3", label: "refresh", action: "refresh" },
  { key: "4", label: "fleet", action: "fleet" },
  { key: "5", label: "logs", action: "logs" },
  { key: "6", label: "dotfiles", action: "dotfiles" },
  { key: "c", label: "conflicts", action: "conflicts" },
  { key: "p", label: "cache-profile", action: "cache-profile" },
  { key: "s", label: "switch-type", action: "switch-type" },
  { key: "n", label: "network-shares", action: "network-shares" },
  { key: "g", label: "github repos", action: "gh" },
  { key: "q", label: "quit", action: "quit" },
];

export function describeFolder(folder: LocalFolder): string {
  const status = folder.lastStatus ?? "unknown";
  const type = folder.type ?? "sync";
  let displayType: string = type;
  if (type === "git" && folder.gitProvider === "gh") {
    const remote = folder.gitRemote ? `:${folder.gitRemote}` : "";
    displayType = `gh${remote}`;
  }
  const cache =
    type === "mount" && folder.cacheProfile
      ? ` (cache: ${folder.cacheProfile}${folder.cacheMaxSize ? `/${folder.cacheMaxSize}` : ""})`
      : "";
  return `${displayType}${cache} — ${status}`;
}

function toRows(folders: LocalFolder[]): FolderRow[] {
  return folders.map((folder) => ({
    name: folder.name,
    description: describeFolder(folder),
    value: folder.id,
  }));
}

/**
 * Builds the Local view: a folder list with hotkey-driven sync actions.
 * `onAction` is called when the user picks a folder or presses a hotkey.
 */
export function renderLocal(opts: RenderLocalOpts): VNode {
  const rows = toRows(opts.state.folders);

  const select = Select({ options: rows, flexGrow: 1 });
  select.on("itemSelected", (_index: number, option: FolderRow) => {
    if (option.value) opts.onAction("sync-one");
  });

  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    Text({ content: `Local — ${opts.state.hostname}` }),
    Text({ content: "" }),
    foldersBody(opts.state, select),
    Text({ content: "" }),
    statusLine(opts.state),
    hotkeyFooter(),
  );
}

function foldersBody(state: LocalState, select: VNode): VNode {
  if (state.folders.length === 0) {
    return Box(
      { flexDirection: "column" },
      Text({ content: "(no folders configured)" }),
      Text({ content: "Press 3 to refresh, 4 to view the fleet, q to quit." }),
    );
  }
  return Box(
    { flexDirection: "column", flexGrow: 1 },
    select,
  );
}

function statusLine(state: LocalState): VNode | null {
  if (!state.status) return null;
  const prefix =
    state.statusKind === "error" ? "[!] " : state.statusKind === "success" ? "[ok] " : "[i] ";
  return Text({ content: prefix + state.status });
}

function hotkeyFooter(): VNode {
  const cells: VNode[] = [];
  for (const hk of HOTKEYS) {
    cells.push(Text({ content: `[${hk.key}] ${hk.label}` }));
  }
  return Box({ flexDirection: "row", gap: 1 }, ...cells);
}

/**
 * Cycle through cache profiles in the order the daemon applies them. The TUI
 * does not persist this selection; the daemon's mount flow is the source of
 * truth. The view fires `cache-profile` and the index layer is responsible
 * for sending the updated assignment to the server.
 */
export const CACHE_PROFILE_ORDER: readonly CacheProfileKind[] = [
  "normal",
  "media",
  "minimal",
];

export function nextCacheProfile(
  current: CacheProfileKind | null | undefined,
): CacheProfileKind {
  const idx = CACHE_PROFILE_ORDER.indexOf(current ?? "normal");
  const safeIdx = idx === -1 ? 0 : idx;
  const next = CACHE_PROFILE_ORDER[(safeIdx + 1) % CACHE_PROFILE_ORDER.length];
  // Safe: index is within the readonly tuple.
  return next as CacheProfileKind;
}

export interface FstabShareInput {
  id: string;
  server: string;
  path: string;
  type: "nfs" | "smb";
  options: string;
}

/**
 * Build the `/etc/fstab` line for a network share. The TUI only displays
 * the line — it never writes to /etc/fstab itself. Root operations belong
 * to the operator or to a privileged helper.
 */
export function buildFstabLine(
  share: FstabShareInput,
  mountPoint: string,
): string {
  const fsType = share.type === "nfs" ? "nfs" : "cifs";
  const options = share.options && share.options.length > 0 ? share.options : "defaults";
  return `${share.server}:${share.path} ${mountPoint} ${fsType} ${options} 0 0 # lamasync:${share.id}`;
}
