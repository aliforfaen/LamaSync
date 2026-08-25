/**
 * Pause polling service (LAMA-273).
 *
 * Reads `GET /api/v1/pause` on a short interval, resolves the effective
 * pause for the local host (mirroring the server's host-row-wins-over-global
 * rule), and reports a status-bar caption through the supplied callback.
 *
 * Pure helpers live in `./pause.ts`; this module is the I/O shell that
 * fetches data, throttles errors, and tickles the shell on every change.
 *
 * The service is intentionally tiny: one poll loop, one callback, no
 * concurrency knobs. The renderer is also passed in so `setInterval` can
 * be cleared in `stop()` without reaching into module-level state.
 */
import type { LamaSyncApiClient, PauseState } from "@lamasync/core";

import {
  formatEffectivePauseCaption,
  isPauseActive,
  resolveEffectivePause,
} from "../pause.ts";

/** Polling cadence — 30s is the same window the Fleet view uses for
 *  `getHealth()`, so a user tabbing into Fleet sees consistent freshness. */
export const PAUSE_POLL_INTERVAL_MS = 30_000;

export interface PauseServiceOptions {
  readonly api: LamaSyncApiClient;
  readonly localHostId: string;
  /** Called with the new caption (`null` when no pause applies). The shell
   *  passes through to its status-bar renderable. */
  readonly onCaption: (caption: string | null) => void;
}

export interface PauseService {
  /** Run a single poll immediately (no-throw). */
  poll: () => Promise<void>;
  /** Start the interval; returns the underlying timer handle for tests. */
  start: () => ReturnType<typeof setInterval>;
  /** Stop the interval and clear any pending work. */
  stop: () => void;
}

export function createPauseService(opts: PauseServiceOptions): PauseService {
  let timer: ReturnType<typeof setInterval> | null = null;
  // `lastCaption` uses a sentinel ("UNSET") distinct from `null` so the
  // first successful poll always fires the callback — without this the
  // initial "nothing paused" state would silently skip notification and
  // leave the indicator off-by-default.
  let lastCaption: string | null | "UNSET" = "UNSET";
  let inflight = false;

  async function poll(): Promise<void> {
    if (inflight) return;
    inflight = true;
    try {
      const snapshot = await opts.api.getPause();
      const caption = formatEffectivePauseCaption(snapshot, opts.localHostId);
      // Only poke the shell when the caption actually changes so the
      // status-bar renderable doesn't churn every 30s. The first poll
      // always fires (sentinel ensures the initial state is reported).
      if (caption !== lastCaption) {
        lastCaption = caption;
        opts.onCaption(caption);
      }
    } catch {
      // Pause polling is best-effort: a transient API failure must not
      // bury a still-valid indicator. Keep the previous caption.
    } finally {
      inflight = false;
    }
  }

  return {
    poll,
    start() {
      if (timer !== null) return timer;
      // Fire one immediate poll so the first paint already carries the
      // indicator (otherwise it lags by up to 30s on a fresh boot).
      void poll();
      timer = setInterval(() => {
        void poll();
      }, PAUSE_POLL_INTERVAL_MS);
      return timer;
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/** Re-export the pure helpers for callers that want to compose the
 *  resolution / formatting themselves (e.g. CLI command trees). */
export {
  formatEffectivePauseCaption,
  isPauseActive,
  resolveEffectivePause,
} from "../pause.ts";
export type { PauseState };