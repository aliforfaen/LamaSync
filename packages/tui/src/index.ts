import { hostname as osHostname } from "os";
import {
  createCliRenderer,
  Box,
  Text,
  type KeyEvent,
} from "@opentui/core";
import { buildClient } from "./api.ts";

type View = "menu" | "local" | "fleet";

interface FleetEntry {
  id: string;
  hostname: string;
  status: string;
  lastSeen: number | null;
}

async function fetchFleet(): Promise<FleetEntry[]> {
  const { client } = buildClient();
  const h = await client.getHealth();
  return h.hosts.map((host) => ({
    id: host.id,
    hostname: host.hostname,
    status: host.status,
    lastSeen: host.lastSeen ?? null,
  }));
}

function formatLastSeen(ts: number | null): string {
  if (ts === null) return "never";
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

async function runTui(): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const root = renderer.root;
  const localHostname = osHostname();
  const { error: configError } = buildClient();

  let view: View = "menu";
  let selectedIdx = 0;
  let fleetData: FleetEntry[] = [];
  let fleetError: string | null = null;
  let fleetLoading = false;

  const menuItems: Array<{ label: string; key: string; view: View | "exit" }> = [
    { label: "Local view", key: "1", view: "local" },
    { label: "Fleet view", key: "2", view: "fleet" },
    { label: "Exit", key: "3", view: "exit" },
  ];

  const replaceChildren = (children: unknown[]) => {
    const existing = root.getChildren();
    for (const c of existing) {
      root.remove(c.id);
    }
    for (const c of children) {
      root.add(c as never);
    }
  };

  const redraw = () => {
    if (configError) {
      replaceChildren([
        Box(
          { flexDirection: "column", padding: 1, border: true },
          Text({ content: "LamaSync TUI" }),
          Text({ content: configError }),
          Text({ content: "Press Ctrl+C to exit." }),
        ),
      ]);
      return;
    }

    if (view === "menu") {
      const lines = menuItems.map((it, i) => {
        const marker = i === selectedIdx ? "▶ " : "  ";
        return Text({ content: `${marker}[${it.key}] ${it.label}` });
      });
      replaceChildren([
        Box(
          { flexDirection: "column", padding: 1, border: true },
          Text({ content: "LamaSync — Main Menu" }),
          Text({ content: `Local hostname: ${localHostname}` }),
          Text({ content: "" }),
          ...lines,
          Text({ content: "" }),
          Text({ content: "Use ↑/↓ to move, Enter to select, Ctrl+C to quit." }),
        ),
      ]);
    } else if (view === "local") {
      replaceChildren([
        Box(
          { flexDirection: "column", padding: 1, border: true },
          Text({ content: `LamaSync — ${localHostname}` }),
          Text({ content: "Status: (local daemon offline in this skeleton)" }),
          Text({ content: "Folders: (none configured)" }),
          Text({ content: "" }),
          Text({ content: "Press Esc to return to the menu." }),
        ),
      ]);
    } else if (view === "fleet") {
      const body =
        fleetError !== null
          ? Text({ content: `Error: ${fleetError}` })
          : fleetLoading
            ? Text({ content: "Loading fleet…" })
            : fleetData.length === 0
              ? Text({ content: "(no hosts registered)" })
              : Box(
                  { flexDirection: "column" },
                  Text({ content: "Host          Status      Last Seen" }),
                  ...fleetData.map((h) =>
                    Text({
                      content: `${h.hostname.padEnd(14)}${h.status.padEnd(12)}${formatLastSeen(h.lastSeen)}`,
                    }),
                  ),
                );
      replaceChildren([
        Box(
          { flexDirection: "column", padding: 1, border: true },
          Text({ content: "LamaSync — Fleet" }),
          body,
          Text({ content: "" }),
          Text({ content: "Press Esc to return, R to refresh." }),
        ),
      ]);
    }
  };

  const refreshFleet = async () => {
    fleetLoading = true;
    fleetError = null;
    redraw();
    try {
      fleetData = await fetchFleet();
    } catch (err) {
      fleetError = err instanceof Error ? err.message : String(err);
    } finally {
      fleetLoading = false;
      redraw();
    }
  };

  const selectCurrent = () => {
    const it = menuItems[selectedIdx];
    if (it.view === "exit") {
      renderer.destroy();
      process.exit(0);
    }
    view = it.view;
    if (view === "fleet") {
      void refreshFleet();
    } else {
      redraw();
    }
  };

  root.onKeyDown = (e: KeyEvent) => {
    const name = e.name?.toLowerCase?.() ?? "";
    const raw = typeof e.raw === "string" ? e.raw : typeof e.sequence === "string" ? e.sequence : "";
    const char = raw.length === 1 ? raw : "";
    if (view === "menu") {
      if (name === "up") {
        selectedIdx =
          (selectedIdx - 1 + menuItems.length) % menuItems.length;
        redraw();
        return;
      }
      if (name === "down") {
        selectedIdx = (selectedIdx + 1) % menuItems.length;
        redraw();
        return;
      }
      if (name === "return" || name === "enter") {
        selectCurrent();
        return;
      }
      if (char === "1" || char === "2" || char === "3") {
        const idx = menuItems.findIndex((m) => m.key === char);
        if (idx >= 0) {
          selectedIdx = idx;
          selectCurrent();
        }
        return;
      }
    } else {
      if (name === "escape") {
        view = "menu";
        redraw();
        return;
      }
      if (view === "fleet" && (char === "r" || char === "R")) {
        void refreshFleet();
        return;
      }
    }
  };

  redraw();
  renderer.start();

  // Keep the event loop alive. Shutdown comes via exitOnCtrlC (SIGINT → process.exit)
  // or the Exit menu option (renderer.destroy() → process.exit(0)).
  await new Promise(() => {});
}

async function runCliFallback(): Promise<void> {
  const local = osHostname();
  console.log("LamaSync TUI (CLI fallback — LAMASYNC_NO_TUI=1)");
  console.log(`Local: ${local}`);
  const { client } = buildClient();
  try {
    const fleet = await client.getHealth();
    console.log(`Fleet: ${fleet.hostCount} host(s), ${fleet.onlineCount} online`);
    for (const h of fleet.hosts) {
      console.log(`  - ${h.hostname} (${h.id}): ${h.status}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Fleet query failed: ${message}`);
  }
}

async function main(): Promise<void> {
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

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`TUI fatal: ${message}`);
  process.exit(1);
});
