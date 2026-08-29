import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { LamaSyncApiClient, parseClientConfig } from "@lamasync/core";

export const DEFAULT_URL = "http://localhost:8080";
const DEFAULT_KEY = "dev-key";

/**
 * Resolve the client config path at call time. Bun caches `os.homedir()`
 * process-wide at first call, so a module-level `join(homedir(), ...)`
 * would freeze the path against the home directory of whichever context
 * imported this module first — leaking a real `~/.config/lamasync/`
 * config into HOME-isolated callers (and tests). Reading `$HOME` first
 * keeps every call (bare-TTY fallback, boot, setup flow) faithful to its
 * own environment while `homedir()` remains the fallback for HOME-less
 * shells.
 */
export function getConfigPath(): string {
  const home = process.env.HOME ?? homedir();
  return join(home, ".config", "lamasync", "client.toml");
}

export interface TuiClient {
  client: LamaSyncApiClient;
  hostname: string;
  fromConfigFile: boolean;
  /**
   * WS3 (TUI foundations): true when neither env vars nor a parseable
   * config file provided credentials — the boot sequence must run the
   * first-run setup flow before showing the shell. A config file that
   * exists but fails to parse is ALSO a setup situation.
   */
  needsSetup: boolean;
  error?: string;
}

export interface ClientConfigValues {
  serverUrl: string;
  apiKey: string;
  hostname: string;
}

/**
 * Pure detection helper (unit-testable without touching the home dir):
 * setup is needed unless BOTH env vars or a parseable config file supplied
 * credentials. A config file that exists but failed to parse counts as
 * needing setup (the flow will overwrite it).
 */
export function clientNeedsSetup(opts: {
  envUrl?: string;
  envKey?: string;
  hasConfigFile: boolean;
  configError?: string;
}): boolean {
  if (opts.envUrl && opts.envKey) return false;
  if (opts.hasConfigFile && !opts.configError) return false;
  return true;
}

/**
 * Serialize a client config as a minimal TOML document. Field names match
 * `config-examples/client.toml` and are exactly what `parseClientConfig`
 * requires. Values are escaped for TOML basic strings (backslash + double
 * quote).
 */
export function clientConfigToml(config: ClientConfigValues): string {
  const escape = (value: string): string =>
    value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    `serverUrl = "${escape(config.serverUrl)}"`,
    `apiKey = "${escape(config.apiKey)}"`,
    `hostname = "${escape(config.hostname)}"`,
    "",
  ].join("\n");
}

/** Write the client config file, creating the config directory if needed. */
export function writeClientConfig(
  config: ClientConfigValues,
  path: string = getConfigPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, clientConfigToml(config), "utf8");
}

export function buildClient(): TuiClient {
  const envUrl = process.env.LAMASYNC_SERVER_URL;
  const envKey = process.env.LAMASYNC_API_KEY;

  if (envUrl && envKey) {
    return {
      client: new LamaSyncApiClient(envUrl, envKey),
      hostname: "(env)",
      fromConfigFile: false,
      needsSetup: false,
    };
  }

  const hasConfigFile = existsSync(getConfigPath());
  let configError: string | undefined;
  if (hasConfigFile) {
    try {
      const cfg = parseClientConfig(readFileSync(getConfigPath(), "utf8"));
      return {
        client: new LamaSyncApiClient(cfg.serverUrl, cfg.apiKey),
        hostname: cfg.hostname,
        fromConfigFile: true,
        needsSetup: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      configError = `Failed to parse ${getConfigPath()}: ${message}`;
    }
  }

  // Fall through to the default client. needsSetup comes from the tested
  // helper rather than a re-implementation so the two can't drift.
  return {
    client: new LamaSyncApiClient(DEFAULT_URL, DEFAULT_KEY),
    hostname: configError ? "(error)" : "(defaults)",
    fromConfigFile: hasConfigFile,
    needsSetup: clientNeedsSetup({ envUrl, envKey, hasConfigFile, configError }),
    error: configError,
  };
}
