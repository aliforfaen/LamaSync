import type { Host } from "@lamasync/core";

/**
 * View-level host shape. Same fields the existing `views/fleet.ts` exported —
 * moved here so the service is independent of any VNode layer.
 */
export interface FleetHost {
  readonly id: string;
  readonly hostname: string;
  readonly status: string;
  readonly lastSeen?: number | null;
  readonly tailnetIp?: string;
}

/**
 * Streaming fleet host subscription. The service is responsible only for the
 * WebSocket lifecycle and host-list mutation; the Shell still calls
 * `getHealth()` on demand for ad-hoc refreshes.
 */
export interface FleetService {
  readonly hosts: ReadonlyArray<FleetHost>;
  readonly status: "live" | "offline";
  start(): void;
  close(): void;
}

interface MessageShape {
  readonly kind?: unknown;
  readonly host?: unknown;
}

function isHost(value: unknown): value is Host {
  if (value === null || typeof value !== "object") return false;
  const h = value as Record<string, unknown>;
  return (
    typeof h.id === "string" &&
    typeof h.hostname === "string" &&
    typeof h.status === "string"
  );
}

function toFleetHost(host: Host): FleetHost {
  return {
    id: host.id,
    hostname: host.hostname,
    status: host.status,
    lastSeen: host.lastSeen ?? null,
    tailnetIp: host.tailnetIp ?? undefined,
  };
}

function parseMessageData(data: unknown): MessageShape | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed !== null && typeof parsed === "object") {
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

/**
 * Construct a fleet service bound to the supplied server URL and API key.
 * The WebSocket URL is computed eagerly so the service can report `offline`
 * synchronously when the runtime lacks a WebSocket implementation.
 */
export function createFleetService(
  serverUrl: string,
  apiKey: string,
): FleetService {
  const WS = resolveWebSocket();
  const base = serverUrl.replace(/^http/, "ws");
  const url = `${base}/api/v1/ws`;

  // Bun's WebSocket constructor only accepts RFC 6455 token characters in
  // subprotocol names; base64url avoids the `+`/`/`/`=` characters that
  // standard base64 produces. The server reads
  // `sec-websocket-protocol: lamasync-auth, <token>` and decodes it.
  const token = (typeof btoa === "function"
    ? btoa(apiKey)
    : Buffer.from(apiKey).toString("base64")
  )
    .replace(/=+$/, "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  const protocols = ["lamasync-auth", token];

  const hosts = new Map<string, FleetHost>();
  let socket: WebSocket | null = null;
  let closed = false;

  return {
    get hosts(): ReadonlyArray<FleetHost> {
      return [...hosts.values()];
    },
    get status(): "live" | "offline" {
      return socket === null ? "offline" : "live";
    },
    start(): void {
      if (closed || socket !== null || WS === null) return;
      try {
        socket = new WS(url, protocols) as WebSocket;
      } catch {
        socket = null;
        return;
      }
      socket.addEventListener("message", (event: MessageEvent) => {
        const data = parseMessageData(event.data);
        if (data === null) return;
        if (data.kind === "host" && isHost(data.host)) {
          const host = toFleetHost(data.host);
          hosts.set(host.id, host);
        }
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      socket?.close();
      socket = null;
    },
  };
}
