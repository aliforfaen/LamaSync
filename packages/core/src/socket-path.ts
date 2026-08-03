// LAMA-218: shared daemon/TUI Unix-socket path resolution. Lives in
// `@lamasync/core` so neither side can drift.
//
// Resolution order (highest priority first):
//   1. `override` argument (caller already consulted env / client.toml)
//   2. `LAMASYNC_SOCKET_PATH` environment variable (set by the systemd
//      unit for the daemon and by users for the TUI)
//   3. `$XDG_RUNTIME_DIR/lamasync.sock` — the systemd-friendly default
//      (always writable under systemd --user, no ReadWritePaths exception
//      required)
//   4. `~/.lamasync/lamasync.sock` — fallback when XDG_RUNTIME_DIR is
//      unset (root containers, old shells, CI); lives in a dedicated
//      subdirectory of $HOME rather than polluting $HOME itself.
//
// The single helper is the canonical source of truth. Tests cover every
// branch (env override, XDG set/unset, override argument).

import { join } from "node:path";

const ENV_VAR = "LAMASYNC_SOCKET_PATH";
const FILENAME = "lamasync.sock";

/** Resolve $HOME directly from process.env — `os.homedir()` caches the
 *  value at module load, which makes the helper untestable in environments
 *  that override $HOME per test. */
function envHome(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return home;
}

export function defaultSocketPath(override?: string | null): string {
  if (override !== undefined && override !== null && override !== "") {
    return override;
  }
  const envValue = process.env[ENV_VAR];
  if (envValue !== undefined && envValue !== "" && envValue !== null) {
    return envValue;
  }
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (typeof xdg === "string" && xdg !== "") {
    return join(xdg, FILENAME);
  }
  return join(envHome(), ".lamasync", FILENAME);
}

/** The directory the socket lives in by default (XDG fallback). */
export function defaultSocketDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (typeof xdg === "string" && xdg !== "") {
    return xdg;
  }
  return join(envHome(), ".lamasync");
}