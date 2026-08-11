/**
 * Auth discovery for the `lamasync` CLI. Reuses `buildClient()` so the TUI
 * and the CLI agree on every precedence rule (LAMA-229):
 *
 *   1. --server / --api-key flags on the command line win.
 *   2. LAMASYNC_SERVER_URL + LAMASYNC_API_KEY env vars.
 *   3. ~/.config/lamasync/client.toml (written by the daemon installer).
 *   4. Built-in defaults (localhost + dev-key) — needsSetup = true so the
 *      operator can choose to bail out with a clear error instead of
 *      running against the wrong server.
 *
 * The `client` returned here is safe to use by every command module; the
 * caller decides whether a `needsSetup` situation is fatal (mutations)
 * or merely informational (status / doctor).
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  LamaSyncApiClient,
  type LamaSyncApiError,
  parseClientConfig,
} from "@lamasync/core";

export interface CliClientSources {
  flagServer?: string | undefined;
  flagKey?: string | undefined;
}

export interface CliClient {
  client: LamaSyncApiClient;
  source: "flag" | "env" | "config" | "default";
  serverUrl: string;
  /** Masked display value, never the raw key. */
  maskedKey: string;
  /** Hostname (or "(none)") the client config supplied. */
  hostname: string;
  needsSetup: boolean;
  /** True when env vars were the source. Useful for doctor + status. */
  fromEnv: boolean;
}

export function defaultConfigPath(): string {
  // Read HOME directly: `os.homedir()` reads HOME once at module-load in
  // some runtimes, which makes the helper untestable when tests override
  // HOME per case (the daemon-side `defaultSocketPath` hits the same trap;
  // see `packages/core/src/socket-path.ts`).
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return join(home, ".config", "lamasync", "client.toml");
}

function mask(value: string): string {
  if (value.length <= 12) return "…";
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function buildCliClient(sources: CliClientSources): CliClient {
  if (sources.flagServer && sources.flagKey) {
    return {
      client: new LamaSyncApiClient(sources.flagServer, sources.flagKey),
      source: "flag",
      serverUrl: sources.flagServer,
      maskedKey: mask(sources.flagKey),
      hostname: "(flag)",
      needsSetup: false,
      fromEnv: false,
    };
  }

  const envUrl = process.env.LAMASYNC_SERVER_URL;
  const envKey = process.env.LAMASYNC_API_KEY;
  if (envUrl && envKey) {
    return {
      client: new LamaSyncApiClient(envUrl, envKey),
      source: "env",
      serverUrl: envUrl,
      maskedKey: mask(envKey),
      hostname: "(env)",
      needsSetup: false,
      fromEnv: true,
    };
  }

  const path = defaultConfigPath();
  if (existsSync(path)) {
    try {
      const cfg = parseClientConfig(readFileSync(path, "utf8"));
      return {
        client: new LamaSyncApiClient(cfg.serverUrl, cfg.apiKey),
        source: "config",
        serverUrl: cfg.serverUrl,
        maskedKey: mask(cfg.apiKey),
        hostname: cfg.hostname,
        needsSetup: false,
        fromEnv: false,
      };
    } catch {
      // fall through — caller treats this as needsSetup.
    }
  }

  return {
    client: new LamaSyncApiClient("http://localhost:8080", "dev-key"),
    source: "default",
    serverUrl: "(none)",
    maskedKey: "…",
    hostname: "(none)",
    needsSetup: true,
    fromEnv: false,
  };
}

/** Map a thrown error to the right exit code per LAMA-229 conventions. */
export function exitCodeForError(err: unknown): number {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: unknown }).status;
    if (status === 401 || status === 403) return 3;
    if (typeof status === "number" && status >= 500) return 4;
  }
  if (err instanceof TypeError) return 4;
  if (err instanceof Error) {
    // Bun's fetch wrapper raises TypeError "fetch failed" with a `cause`
    // whose `.code` is one of these. Also map plain "Unable to connect"
    // and TLS / DNS failure strings to code 4 (server unreachable).
    const msg = err.message;
    if (/Unable to connect|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo|invalid URL|network/i.test(msg)) {
      return 4;
    }
    // Bun surfaces property `code` on fetch errors as well.
    const anyErr = err as Error & { code?: string };
    if (anyErr.code && /ECONN|ENOTFOUND|EAI_AGAIN|EPIPE|TLS|fetch/i.test(anyErr.code)) {
      return 4;
    }
  }
  return 1;
}

/** Narrow helper for the `LamaSyncApiError` shape — avoids `as`-casts in
 *  every callsite. Returns the error if it is one; null otherwise. */
export function asApiError(err: unknown): (LamaSyncApiError & Error) | null {
  if (err instanceof Error && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return err as LamaSyncApiError & Error;
  }
  return null;
}

/**
 * Shared error wrapper for every server-facing command. Prefixes the API
 * error's message with the command context AND copies the HTTP `status`
 * onto the new Error, so `exitCodeForError` still maps 401/403 → 3 and
 * 5xx → 4 after wrapping. Non-API errors pass through unchanged.
 */
export function wrapApiError(err: unknown, prefix: string): Error {
  const apiErr = asApiError(err);
  if (apiErr) {
    return Object.assign(new Error(`${prefix}: ${apiErr.message}`), {
      status: apiErr.status,
    });
  }
  return err instanceof Error ? err : new Error(String(err));
}
