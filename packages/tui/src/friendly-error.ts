// WS3 (TUI foundations): translate common failure modes into actionable
// one-line advice for the status bar. Pure string → string, unit-tested.

export interface FriendlyErrorContext {
  /** Server URL shown in unreachable messages (omit when unknown). */
  serverUrl?: string;
  /** Human action for context (e.g. "refresh", "sync") — currently unused
   *  in the copy but reserved so callers pass intent. */
  action?: string;
}

export function friendlyError(
  err: unknown,
  context: FriendlyErrorContext = {},
): string {
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.trim().split("\n")[0] ?? raw;

  if (/api error 401|unauthorized/i.test(message)) {
    return "API key rejected — check LAMASYNC_API_KEY or ~/.config/lamasync/client.toml";
  }

  if (
    /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|timed out|socket hang up/i.test(
      message,
    )
  ) {
    const suffix = context.serverUrl ? ` at ${context.serverUrl}` : "";
    return `server unreachable${suffix} — is it running? tailnet up?`;
  }

  // Daemon socket: node's `connect ENOENT <sockpath>` (and any message that
  // names the socket file). Must run before the generic rclone/ENOENT rule.
  // A bare "socket" match would wrongly claim "daemon not running" for
  // server-side failures like WebSocket errors — require socket-FILE context.
  if (/connect ENOENT|ENOENT.*\.sock|lamasync\.sock|\.sock\b/i.test(message)) {
    return "daemon not running — start lamasyncd (systemctl --user start lamasyncd)";
  }

  if (/rclone|spawn ENOENT/i.test(message)) {
    return "rclone not installed or not on PATH";
  }

  return message;
}
