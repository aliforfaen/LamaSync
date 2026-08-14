// LAMA-242: --help / -h text for `lamasyncd`, plus the single source of truth
// for which argv tokens count as known flags (the entry point and the unknown-flag
// guard import `DAEMON_KNOWN_FLAGS` so they stay in lockstep).
//
// Kept in its own module so it's importable from tests without booting the
// daemon (importing `index.ts` starts the main loop).

import { VERSION } from "@lamasync/core";

/**
 * Tokens that the entry point recognizes as flags. A `--mount=<id>` token is
 * accepted by the entry point directly; the unknown-flag guard in `index.ts`
 * lets those through with a special-case prefix match instead of listing every
 * possible suffix here. Bare positionals (the `skill` after `--update`, the
 * `<folderId>` after `--mount`) are never in this set — they don't start with
 * `-`.
 */
export const DAEMON_KNOWN_FLAGS: ReadonlySet<string> = new Set([
  "--version",
  "-V",
  "--help",
  "-h",
  "--check-update",
  "--update",
  "--mount",
]);

/**
 * Multi-line usage text for `lamasyncd --help` / `-h`. Pure: no I/O, no
 * side effects; safe to call from tests.
 */
export function daemonUsage(): string {
  return [
    `lamasyncd ${VERSION}`,
    "",
    "Sync daemon: registers this host with the configured LamaSync server and",
    "runs the scheduled-sync loop, the Unix-socket control surface for the TUI,",
    "and rclone mounts. Configuration lives in client.toml (see the agent skill",
    "for the schema); the daemon refreshes it on every config-revision bump.",
    "",
    "Usage:",
    "  lamasyncd                       boot the sync daemon in the foreground",
    "  lamasyncd --mount <folderId>    mount a folder in the foreground",
    "  lamasyncd --mount=<folderId>    same as above, alternate syntax",
    "  lamasyncd --check-update        print current vs latest release, then exit",
    "  lamasyncd --update              self-update the binary via the release proxy",
    "  lamasyncd --update skill        refresh the agent-skill bundle (lockstep with the binary version)",
    "",
    "Flags:",
    "  -h, --help        print this help and exit 0",
    "  -V, --version     print the version and exit 0",
    "",
    "Exit codes: 0 ok, 1 runtime error, 2 usage error.",
    "",
  ].join("\n");
}
