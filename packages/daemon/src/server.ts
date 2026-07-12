import { LamaSyncApiClient } from "@lamasync/core";
import { loadConfig } from "./config.ts";

const cfg = loadConfig();
export const client = new LamaSyncApiClient(cfg.serverUrl, cfg.apiKey);
