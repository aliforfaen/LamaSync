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
  const { client, needsSetup } = buildClient();
  // Owner decision (2026-08-23, LAMA-247 #13): keep the fake default but
  // make it loud — this fallback silently used localhost/dev-key before.
  if (needsSetup) {
    console.error(
      "[!] no credentials found — using fake http://localhost:8080 / dev-key. " +
        "Set LAMASYNC_SERVER_URL/LAMASYNC_API_KEY or create " +
        "~/.config/lamasync/client.toml before trusting this output. " +
        "(Ignore if you really are running the local dev server.)",
    );
  }
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
