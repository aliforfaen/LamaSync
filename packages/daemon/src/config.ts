import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { parseClientConfig, type ClientConfig } from "@lamasync/core";

const CONFIG_PATH = join(homedir(), ".config", "lamasync", "client.toml");
const CONFIG_DIR = dirname(CONFIG_PATH);

export function loadConfig(): ClientConfig {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Client config not found at ${CONFIG_PATH}. ` +
        `Create it with:\n` +
        `  serverUrl = "http://<lamasync-server>:8080"\n` +
        `  apiKey = "<LAMASYNC_API_KEY>"\n` +
        `  hostname = "$(hostname)"\n`,
    );
  }
  const buf = readFileSync(CONFIG_PATH, "utf8");
  return parseClientConfig(buf);
}
