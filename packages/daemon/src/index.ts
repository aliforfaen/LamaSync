import { loadConfig } from "./config.ts";
import { client } from "./server.ts";

const HEARTBEAT_INTERVAL_MS = 30_000;
const RETRY_DELAY_MS = 5_000;

const config = loadConfig();
const hostId = config.hostname;

async function heartbeat(): Promise<void> {
  try {
    await client.registerHost({
      id: hostId,
      hostname: config.hostname,
      tailnetIp: null,
    });
    await client.reportHealth({
      hostId,
      timestamp: Date.now(),
      status: "online",
    });
    const ts = new Date().toISOString();
    console.log(`[${ts}] heartbeat ok host=${hostId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[heartbeat] failed: ${message}`);
  }
}

async function main(): Promise<void> {
  console.log(`lamasyncd starting host=${hostId} url=${config.serverUrl}`);

  // First registration + health immediately so the user sees something fast.
  await heartbeat();

  // Then loop. setTimeout instead of setInterval to avoid overlapping calls.
  const loop = async () => {
    await heartbeat();
    setTimeout(loop, HEARTBEAT_INTERVAL_MS).unref();
  };
  setTimeout(loop, HEARTBEAT_INTERVAL_MS).unref();
  // Run until SIGINT/SIGTERM.
  const shutdown = () => {
    console.log("lamasyncd shutting down");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`lamasyncd fatal: ${message}`);
  setTimeout(() => process.exit(1), RETRY_DELAY_MS).unref();
});
