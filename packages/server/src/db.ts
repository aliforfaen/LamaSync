import { mkdirSync } from "fs";
import { join } from "path";
import { initDb } from "@lamasync/core";

const dataDir = process.env.LAMASYNC_DATA_DIR || "/data";
mkdirSync(dataDir, { recursive: true });

export const db = initDb(join(dataDir, "lamasync.db"));
