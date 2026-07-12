import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { LamaSyncApiClient, parseClientConfig } from "@lamasync/core";

const DEFAULT_URL = "http://localhost:8080";
const DEFAULT_KEY = "dev-key";
const CONFIG_PATH = join(homedir(), ".config", "lamasync", "client.toml");

export interface TuiClient {
  client: LamaSyncApiClient;
  hostname: string;
  fromConfigFile: boolean;
  error?: string;
}

export function buildClient(): TuiClient {
  const envUrl = process.env.LAMASYNC_SERVER_URL;
  const envKey = process.env.LAMASYNC_API_KEY;

  if (envUrl && envKey) {
    return {
      client: new LamaSyncApiClient(envUrl, envKey),
      hostname: "(env)",
      fromConfigFile: false,
    };
  }

  if (existsSync(CONFIG_PATH)) {
    try {
      const cfg = parseClientConfig(readFileSync(CONFIG_PATH, "utf8"));
      return {
        client: new LamaSyncApiClient(cfg.serverUrl, cfg.apiKey),
        hostname: cfg.hostname,
        fromConfigFile: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        client: new LamaSyncApiClient(DEFAULT_URL, DEFAULT_KEY),
        hostname: "(error)",
        fromConfigFile: true,
        error: `Failed to parse ${CONFIG_PATH}: ${message}`,
      };
    }
  }

  return {
    client: new LamaSyncApiClient(DEFAULT_URL, DEFAULT_KEY),
    hostname: "(defaults)",
    fromConfigFile: false,
  };
}
