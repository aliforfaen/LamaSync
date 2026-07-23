import { useEffect, useRef, useState } from "react";
import type { WSEvent } from "@lamasync/core";
import { getApiKey, notifyUnauthorized } from "../api.ts";

export type WsState = "connecting" | "open" | "closed";

interface UseWebSocketResult {
  event: WSEvent | null;
  state: WsState;
}

const MAX_BACKOFF_MS = 30_000;
function encodeApiKeyForProtocol(key: string): string {
  return btoa(key).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}


const EVENT_KINDS = new Set<string>([
  "operation",
  "host",
  "conflict",
  "restic_snapshot",
  "restic_restore",
  "mount",
  "lock",
]);

function isWSEvent(value: unknown): value is WSEvent {
  if (value === null || typeof value !== "object" || !("kind" in value)) {
    return false;
  }
  return typeof value.kind === "string" && EVENT_KINDS.has(value.kind);
}

/** The server sends `{kind:"error", error:"unauthorized"}` before closing a
 * connection whose API key it rejects (see server/src/ws.ts). */
function isUnauthorizedMessage(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (!("kind" in value) || !("error" in value)) return false;
  return value.kind === "error" && value.error === "unauthorized";
}

export function useWebSocket(): UseWebSocketResult {
  const [state, setState] = useState<WsState>("closed");
  const [event, setEvent] = useState<WSEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const attemptsRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    attemptsRef.current = 0;

    function connect() {
      const key = getApiKey();
      if (!key) {
        setState("closed");
        return;
      }
      const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/v1/ws`;
      setState("connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, ["lamasync-auth", encodeApiKeyForProtocol(key)]);
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        attemptsRef.current = 0;
        setState("open");
      };
      ws.onmessage = (e) => {
        try {
          const parsed: unknown = JSON.parse(String(e.data));
          if (isWSEvent(parsed)) {
            setEvent(parsed);
          } else if (isUnauthorizedMessage(parsed)) {
            // The server rejected our key: stop reconnecting and let the
            // app drop back to the login screen.
            cancelledRef.current = true;
            if (timerRef.current !== null) clearTimeout(timerRef.current);
            notifyUnauthorized();
          }
        } catch {
          // Ignore malformed frames.
        }
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          // ignore
        }
      };
      ws.onclose = () => {
        if (cancelledRef.current) return;
        setState("closed");
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      const attempts = attemptsRef.current++;
      const delay = Math.min(1000 * 2 ** attempts, MAX_BACKOFF_MS);
      timerRef.current = setTimeout(connect, delay);
    }

    connect();
    return () => {
      cancelledRef.current = true;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      const ws = wsRef.current;
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  return { event, state };
}
