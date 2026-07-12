import { parse as parseToml } from "smol-toml";

export interface ServerConfig {
  apiKey: string;
  port: number;
  dataDir: string;
  backupDir: string;
  ntfyUrl?: string;
}

export interface ClientConfig {
  serverUrl: string;
  apiKey: string;
  hostname: string;
  dataDir: string;
}

const DEFAULT_SERVER: Omit<ServerConfig, "apiKey"> = {
  port: 8080,
  dataDir: "/data",
  backupDir: "/backups",
};

const DEFAULT_CLIENT: Omit<ClientConfig, "serverUrl" | "apiKey" | "hostname"> = {
  dataDir: "~/.local/share/lamasync",
};

export function parseServerConfig(buf: string): ServerConfig {
  const raw = parseToml(buf) as Partial<ServerConfig>;
  if (!raw.apiKey || typeof raw.apiKey !== "string") {
    throw new Error("server config: 'apiKey' is required");
  }
  return {
    apiKey: raw.apiKey,
    port: typeof raw.port === "number" ? raw.port : DEFAULT_SERVER.port,
    dataDir:
      typeof raw.dataDir === "string" ? raw.dataDir : DEFAULT_SERVER.dataDir,
    backupDir:
      typeof raw.backupDir === "string"
        ? raw.backupDir
        : DEFAULT_SERVER.backupDir,
    ntfyUrl:
      typeof raw.ntfyUrl === "string" && raw.ntfyUrl.length > 0
        ? raw.ntfyUrl
        : undefined,
  };
}

export function parseClientConfig(buf: string): ClientConfig {
  const raw = parseToml(buf) as Partial<ClientConfig>;
  if (!raw.serverUrl || typeof raw.serverUrl !== "string") {
    throw new Error("client config: 'serverUrl' is required");
  }
  if (!raw.apiKey || typeof raw.apiKey !== "string") {
    throw new Error("client config: 'apiKey' is required");
  }
  if (!raw.hostname || typeof raw.hostname !== "string") {
    throw new Error("client config: 'hostname' is required");
  }
  return {
    serverUrl: raw.serverUrl,
    apiKey: raw.apiKey,
    hostname: raw.hostname,
    dataDir:
      typeof raw.dataDir === "string" ? raw.dataDir : DEFAULT_CLIENT.dataDir,
  };
}
