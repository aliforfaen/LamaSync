import { hostname as osHostname } from "os";

import { buildClient } from "./api.ts";

/**
 * Non-interactive CLI mode used when OpenTUI cannot render (for example,
 * when `LAMASYNC_NO_TUI=1` is set or when the native renderer fails to
 * initialize). Prints fleet status and exits.
 */
export async function runCliFallback(): Promise<void> {
  const local = osHostname();
  console.log("LamaSync TUI (CLI fallback — LAMASYNC_NO_TUI=1)");
  console.log(`Local: ${local}`);
  const { client } = buildClient();
  try {
    const fleet = await client.getHealth();
    console.log(
      `Fleet: ${fleet.hostCount} host(s), ${fleet.onlineCount} online`,
    );
    for (const h of fleet.hosts) {
      console.log(`  - ${h.hostname} (${h.id}): ${h.status}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Fleet query failed: ${message}`);
  }
}
