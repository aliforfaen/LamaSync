// LAMA-329 phase 7: honest connectivity state.
//
// The point of this module is what it refuses to say. `navigator.onLine` means
// "an interface is up", not "the server is reachable" — on a tailnet a phone
// can be online with no route to the fleet, and the WebSocket can be down while
// plain requests still work. So the banner distinguishes three states and never
// claims data is current when it cannot know that.

export type ConnectivityLevel = "online" | "reconnecting" | "offline";

export interface ConnectivityFacts {
  /** `navigator.onLine` — a hint about the device, not about the server. */
  browserOnline: boolean;
  /** WebSocket state from `useWebSocket`. */
  socket: "connecting" | "open" | "closed";
  /** True once a request has failed since the last success. */
  requestFailed: boolean;
}

export interface Connectivity {
  level: ConnectivityLevel;
  label: string;
  detail: string;
  /**
   * Whether the UI must warn that what is on screen may no longer be true.
   * Only set when we actually know a read or write failed.
   */
  dataMayBeStale: boolean;
}

export function connectivityFrom(facts: ConnectivityFacts): Connectivity {
  if (facts.socket === "open") {
    return {
      level: "online",
      label: "Connected",
      detail: "Live updates are arriving.",
      dataMayBeStale: false,
    };
  }

  // A device with no interface at all is the only case we can state flatly.
  if (!facts.browserOnline) {
    return {
      level: "offline",
      label: "Offline",
      detail:
        "This device has no network connection. The app opened from its local copy, but fleet data cannot be read or changed until the connection returns.",
      dataMayBeStale: true,
    };
  }

  if (facts.requestFailed) {
    return {
      level: "offline",
      label: "Server unreachable",
      detail:
        "This device is online but the server is not answering. Anything on screen was loaded earlier and may be out of date; changes will not be saved.",
      dataMayBeStale: true,
    };
  }

  // Online, socket not open, nothing has failed: only live updates are down.
  // Saying "offline" here would be a lie, and saying nothing would hide that
  // the page stopped updating.
  return {
    level: "reconnecting",
    label: "Live updates paused",
    detail:
      "Reconnecting to the event stream. The data shown was fetched successfully; use reload if you need it re-read.",
    dataMayBeStale: false,
  };
}

/** Whether the banner should be visible at all. */
export function shouldShowConnectivityBanner(connectivity: Connectivity): boolean {
  return connectivity.level !== "online";
}
