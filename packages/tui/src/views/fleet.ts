import { Box, Select, Text } from "@opentui/core";
import type { VNode } from "@opentui/core";

export type FleetAction = "refresh" | "logs" | "dotfiles" | "local" | "quit";

export interface FleetHost {
  id: string;
  hostname: string;
  status: string;
  lastSeen?: number | null;
  tailnetIp?: string;
}

export interface FleetState {
  hosts: FleetHost[];
}

export interface RenderFleetOpts {
  state: FleetState;
  serverUrl: string;
  apiKey: string;
  onAction: (action: FleetAction) => void;
  onHosts: (hosts: FleetHost[]) => void;
}

interface HostRow {
  name: string;
  description: string;
  value: string;
}

const HOTKEYS: Array<{ key: string; label: string; action: FleetAction }> = [
  { key: "r", label: "refresh", action: "refresh" },
  { key: "l", label: "logs", action: "logs" },
  { key: "d", label: "dotfiles", action: "dotfiles" },
  { key: "b", label: "local", action: "local" },
  { key: "q", label: "quit", action: "quit" },
];

function describeHost(host: FleetHost, now: number): string {
  const status = host.status || "unknown";
  if (host.lastSeen === null || host.lastSeen === undefined) {
    return `${status} · never`;
  }
  return `${status} · ${formatLastSeen(host.lastSeen, now)}`;
}

function formatLastSeen(ts: number, now: number): string {
  const seconds = Math.floor((now - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function toRows(hosts: FleetHost[], now: number): HostRow[] {
  return hosts.map((host) => ({
    name: host.hostname,
    description: describeHost(host, now),
    value: host.id,
  }));
}

/**
 * Builds the Fleet view: a host list plus an optional WebSocket subscription
 * that pushes live updates back via `onHosts`.
 */
export function renderFleet(opts: RenderFleetOpts): VNode {
  const now = Date.now();
  const rows = toRows(opts.state.hosts, now);

  const select = Select({ options: rows, flexGrow: 1 });

  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    Text({ content: "Fleet" }),
    Text({ content: `${opts.state.hosts.length} host(s) known` }),
    Text({ content: "" }),
    hostsBody(opts.state.hosts, select),
    Text({ content: "" }),
    hotkeyFooter(),
  );
}

function hostsBody(hosts: FleetHost[], select: VNode): VNode {
  if (hosts.length === 0) {
    return Box(
      { flexDirection: "column" },
      Text({ content: "(no hosts registered yet — press r to refresh)" }),
    );
  }
  return Box({ flexDirection: "column", flexGrow: 1 }, select);
}

function hotkeyFooter(): VNode {
  const cells: VNode[] = [];
  for (const hk of HOTKEYS) {
    cells.push(Text({ content: `[${hk.key}] ${hk.label}` }));
  }
  return Box({ flexDirection: "row", gap: 1 }, ...cells);
}

/**
 * Attempts to open a live WebSocket subscription against the configured
 * server. Returns a handle that the caller can use to stop receiving
 * updates; if WebSockets are unavailable, returns null.
 */
export function openFleetSubscription(
  serverUrl: string,
  apiKey: string,
  onHosts: (hosts: FleetHost[]) => void,
): FleetSubscription | null {
  const WS = resolveWebSocket();
  if (WS === null) return null;

  const base = serverUrl.replace(/^http/, "ws");
  const url = `${base}/api/v1/ws?apiKey=${encodeURIComponent(apiKey)}`;
  let socket: WebSocket | null = null;
  let closed = false;

  try {
    socket = new WS(url) as WebSocket;
  } catch {
    return null;
  }

  socket.addEventListener("message", (event: MessageEvent) => {
    const data = parseMessageData(event.data);
    if (data === null) return;
    if (Array.isArray(data.hosts)) {
      onHosts(data.hosts as FleetHost[]);
    }
  });

  return {
    close(): void {
      if (closed) return;
      closed = true;
      socket?.close();
      socket = null;
    },
  };
}

export interface FleetSubscription {
  close(): void;
}

interface MessageShape {
  hosts?: unknown;
}

function parseMessageData(data: unknown): MessageShape | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as MessageShape;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveWebSocket(): typeof WebSocket | null {
  if (typeof globalThis.WebSocket === "function") {
    return globalThis.WebSocket as typeof WebSocket;
  }
  return null;
}
