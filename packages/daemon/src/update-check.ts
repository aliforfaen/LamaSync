// Update-check throttle (LAMA-243). Bounds how often the daemon asks for the
// latest release — via the server's cached proxy, never api.github.com
// directly — so a crash loop can't re-fire a network call every restart.
//
// The state is persisted to disk (not in-memory) because the thing we're
// guarding against is the process dying and being restarted by systemd on a
// 10s cadence: an in-memory flag would reset each cycle and do nothing. The
// cooldown is deliberately far longer than the restart interval, so even a
// hard loop fires at most a handful of checks per hour.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const UPDATE_STATE_PATH = join(
  homedir(),
  ".config",
  "lamasync",
  "update-state.json",
);

// 15 min. One check per start plus occasional manual checks stays well under
// the server's ~1h proxy cache and GitHub's 60 req/hr unauthenticated limit.
export const UPDATE_CHECK_COOLDOWN_MS = 15 * 60 * 1000;

interface UpdateState {
  lastCheckAt: number;
}

export function loadUpdateState(
  statePath: string = UPDATE_STATE_PATH,
): UpdateState | null {
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(
      readFileSync(statePath, "utf8"),
    ) as Partial<UpdateState>;
    if (typeof parsed.lastCheckAt === "number") {
      return { lastCheckAt: parsed.lastCheckAt };
    }
    return null;
  } catch {
    // Corrupt state file: treat as "never checked" rather than blocking.
    return null;
  }
}

export function saveUpdateState(
  state: UpdateState,
  statePath: string = UPDATE_STATE_PATH,
): void {
  const dir = dirname(statePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state));
}

/** True when the last check was recent enough to skip another. */
export function withinUpdateCooldown(
  now: number,
  statePath: string = UPDATE_STATE_PATH,
): boolean {
  const state = loadUpdateState(statePath);
  if (!state) return false;
  return now - state.lastCheckAt < UPDATE_CHECK_COOLDOWN_MS;
}

/** Record that a check is being attempted now. Persisted BEFORE the network
 *  call so a crash mid-check still leaves the cooldown in place. */
export function markUpdateCheckAttempted(
  now: number,
  statePath: string = UPDATE_STATE_PATH,
): void {
  saveUpdateState({ lastCheckAt: now }, statePath);
}
