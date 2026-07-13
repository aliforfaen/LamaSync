// Network share registry (NFS / SMB). The list is purely a server-side
// declaration read from `LAMASYNC_SHARES` (JSON string) or
// `${LAMASYNC_DATA_DIR}/shares.json`. The TUI renders this list to help
// users pick a share and generate an `/etc/fstab` line — but it never
// writes `/etc/fstab` itself; root operations are out of scope here.

import { existsSync, readFileSync } from "fs";
import { Elysia } from "elysia";
import { join } from "path";

export interface Share {
  id: string;
  name: string;
  server: string;
  path: string;
  type: "nfs" | "smb";
  options: string;
}

function isShare(value: unknown): value is Share {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.length === 0) return false;
  if (typeof v.name !== "string" || v.name.length === 0) return false;
  if (typeof v.server !== "string" || v.server.length === 0) return false;
  if (typeof v.path !== "string") return false;
  if (v.type !== "nfs" && v.type !== "smb") return false;
  if (typeof v.options !== "string") return false;
  return true;
}

function readSharesFromFile(path: string): Share[] {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isShare);
  } catch {
    return [];
  }
}

export function loadShares(): Share[] {
  const envRaw = process.env.LAMASYNC_SHARES;
  if (typeof envRaw === "string" && envRaw.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(envRaw);
      if (Array.isArray(parsed)) {
        return parsed.filter(isShare);
      }
    } catch {
      // fall through to file lookup
    }
  }
  const dataDir = process.env.LAMASYNC_DATA_DIR ?? "/data";
  const filePath = join(dataDir, "shares.json");
  if (!existsSync(filePath)) return [];
  return readSharesFromFile(filePath);
}

export const sharesRoutes = new Elysia({ prefix: "/api/v1" }).get(
  "/shares",
  () => loadShares(),
  {
    detail: {
      summary: "List configured network shares (NFS/SMB)",
      tags: ["Shares"],
      responses: {
        200: { description: "Share list (may be empty)" },
        401: { description: "Unauthorized" },
      },
    },
  },
);