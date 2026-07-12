import { Box, Select, Text } from "@opentui/core";
import type { VNode } from "@opentui/core";

export type LocalAction =
  | "sync-all"
  | "sync-one"
  | "refresh"
  | "fleet"
  | "logs"
  | "dotfiles"
  | "quit";

export interface LocalFolder {
  id: string;
  name: string;
  lastStatus?: string;
  lastRun?: number | null;
}

export interface LocalState {
  folders: LocalFolder[];
  hostname: string;
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
  { key: "q", label: "quit", action: "quit" },
];

function describeFolder(folder: LocalFolder): string {
  const status = folder.lastStatus ?? "unknown";
  return status;
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

function hotkeyFooter(): VNode {
  const cells: VNode[] = [];
  for (const hk of HOTKEYS) {
    cells.push(Text({ content: `[${hk.key}] ${hk.label}` }));
  }
  return Box({ flexDirection: "row", gap: 1 }, ...cells);
}
