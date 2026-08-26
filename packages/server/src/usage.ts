// LAMA-242: --help / -h text for `lamasync-server`, plus the single source of
// truth for which argv tokens count as known flags (the entry point and the
// unknown-flag guard import `SERVER_KNOWN_FLAGS` so they stay in lockstep).
//
// Kept in its own module so it's importable from tests without booting the
// HTTP server (importing `index.ts` calls `app.listen` at module scope).

import { VERSION } from "@lamasync/core";

/**
 * Tokens that the entry point recognizes as flags. The server has no
 * operational flags today — only the global `--help` / `-h` and the existing
 * `--version` / `-V`.
 */
export const SERVER_KNOWN_FLAGS: ReadonlySet<string> = new Set([
  "--version",
  "-V",
  "--help",
  "-h",
]);

/**
 * Multi-line usage text for `lamasync-server --help` / `-h`. Pure: no I/O, no
 * side effects; safe to call from tests.
 */
export function serverUsage(): string {
  return [
    `lamasync-server ${VERSION}`,
    "",
    "LamaSync REST + WebSocket server: stores device registration, distributes",
    "per-device configuration, exposes the Swagger UI and React web UI, and",
    "proxies the GitHub release feed for daemon self-update.",
    "",
    "Usage:",
    "  lamasync-server           boot the server (foreground, blocks)",
    "",
    "Configuration: read from environment variables before the server starts.",
    "  LAMASYNC_API_KEY                pre-shared API key clients send in Authorization headers",
    "  PORT                            listen port (default 8080)",
    "  LAMASYNC_DATA_DIR               SQLite database directory",
    "  LAMASYNC_BACKUP_DIR             local-backup directory for backup operations",
    "  LAMASYNC_LOG_RETENTION_DAYS     operation_log retention (default 90)",
    "  LAMASYNC_GITHUB_TOKEN           GitHub token for the release proxy (avoids the 60 req/h unauthenticated limit)",
    "  LAMASYNC_LAMADB_WEBHOOK_URL     seed a LamaDB webhook channel on first boot",
    "",
    "Flags:",
    "  -h, --help        print this help and exit 0",
    "  -V, --version     print the version and exit 0",
    "",
    "Exit codes: 0 ok, 1 runtime error, 2 usage error.",
    "",
  ].join("\n");
}
