import { Box, Select, Text } from "@opentui/core";
import type { VNode } from "@opentui/core";

export type MenuItem = "local" | "fleet" | "dotfiles" | "logs" | "quit";

export interface RenderMenuOpts {
  onPick: (item: MenuItem) => void;
}

interface MenuRow {
  name: string;
  description: string;
  value: MenuItem;
}

const MENU_ROWS: MenuRow[] = [
  { name: "Local", description: "Folders and sync status on this host", value: "local" },
  { name: "Fleet", description: "Remote hosts and live state", value: "fleet" },
  { name: "Dotfiles", description: "Browse and restore dotfile snapshots", value: "dotfiles" },
  { name: "Logs", description: "Recent operation log entries", value: "logs" },
  { name: "Quit", description: "Exit the TUI", value: "quit" },
];

/**
 * Builds the main-menu view: a `Select` populated with each top-level
 * navigation item. The caller wires `onPick` to the application router.
 */
export function renderMenu(opts: RenderMenuOpts): VNode {
  const select = Select({
    options: MENU_ROWS,
    flexGrow: 1,
  });
  attachSelectHandler(select, opts.onPick);

  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    Text({ content: "LamaSync" }),
    Text({ content: "Use ↑/↓ to move, Enter to select, or press a number key." }),
    Text({ content: "" }),
    select,
  );
}

function attachSelectHandler(
  select: ReturnType<typeof Select>,
  onPick: (item: MenuItem) => void,
): void {
  // ProxiedVNode forwards `on` from the underlying EventEmitter-based renderable.
  select.on("itemSelected", (_index: number, option: MenuRow) => {
    onPick(option.value);
  });
}
