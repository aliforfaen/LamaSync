// LAMA-273: pause / slow mode — shared overview hook. Polls GET /api/v1/pause
// at most every 60s while the tab is visible, and exposes a `refresh` that the
// control/banner call after any mutation so the banner reflects the change
// immediately. Failures are best-effort: the last known state is kept so a
// transient fetch error never blanks the countdown.

import { useCallback, useEffect, useState } from "react";
import type { PauseState } from "@lamasync/core";
import { api, type PauseOverview } from "../api.ts";

export interface UsePauseResult {
  /** Latest overview, or null before the first fetch resolves. */
  overview: PauseOverview | null;
  /** Re-fetch now (call after any set/clear). */
  refresh: () => Promise<void>;
  /** The active pause for a device context: the device's own row when
   *  present, else the global row. `undefined` when no context/overview. */
  effectiveFor: (hostId?: string) => PauseState | null | undefined;
}

const POLL_MS = 60_000;

export function usePause(): UsePauseResult {
  const [overview, setOverview] = useState<PauseOverview | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setOverview(await api.getPause());
    } catch {
      // Best-effort — keep the last known overview.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      // Only poll while the tab is visible; skip background tabs.
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const effectiveFor = useCallback(
    (hostId?: string): PauseState | null | undefined => {
      if (!overview) return undefined;
      if (hostId) {
        const hostRow = overview.hosts.find((h) => h.hostId === hostId);
        if (hostRow) return hostRow;
      }
      return overview.global;
    },
    [overview],
  );

  return { overview, refresh, effectiveFor };
}
