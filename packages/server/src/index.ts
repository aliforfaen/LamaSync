import { pruneOperationLog } from "./routes/admin.ts";
import { reapExpiredFolderLocks } from "./routes/operations.ts";
import { sweepExpiredPairingSessions } from "./routes/pairing.ts";
import { setPeerServerForRateLimit } from "./mobile-store.ts";
import { reconcileAbandonedMobileUploads } from "./mobile-uploads.ts";
import { startNotificationSweep, seedChannelsFromEnv } from "./notifications.ts";
import { db } from "./db.ts";
import {
  DEFAULT_DRILL_CHECK_INTERVAL_MS,
  DEFAULT_DRILL_INTERVAL_MS,
  parseDrillIntervalMs,
  runDrillScheduler,
} from "./health-drill.ts";
import { VERSION } from "@lamasync/core";
import { SERVER_KNOWN_FLAGS, serverUsage } from "./usage.ts";
import { createServerApp } from "./app.ts";

export type { App } from "./app.ts";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);

const retentionDays = (() => {
  const raw = process.env.LAMASYNC_LOG_RETENTION_DAYS;
  if (!raw) return 90;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90;
})();
const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

// --version flag
if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(`lamasync-server ${VERSION}`);
  process.exit(0);
}

// LAMA-242: --help / -h print and unknown-flag guard. Comes right after the
// --version check so a typo never silently boots a long-running HTTP server.
{
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(serverUsage());
    process.exit(0);
  }

  if (
    args.some((a) => a.startsWith("-") && !SERVER_KNOWN_FLAGS.has(a))
  ) {
    console.error(serverUsage());
    process.exit(2);
  }
}


// LAMA-221 + P-B cleanup #7: first boot with the legacy
// `LAMASYNC_LAMADB_WEBHOOK_URL` env var seeds the webhook channel once;
// later config is managed from the Admin page and survives restarts.
// (The legacy `LAMASYNC_NTFY_URL` env var hookup was removed — ntfy
// channels are configured at runtime from the Admin UI instead.)
seedChannelsFromEnv(db);

const app = createServerApp().listen({ port, hostname: "0.0.0.0" });

console.log(`LamaSync server v${VERSION} listening on http://${app.server!.hostname}:${app.server!.port}`);
console.log(`Swagger UI: http://${app.server!.hostname}:${app.server!.port}/swagger`);
console.log(`WebSocket:  ws://${app.server!.hostname}:${app.server!.port}/api/v1/ws (subprotocol: lamasync-auth, <base64(apiKey)>)`);
// The mobile exchange throttler keys on the TCP peer address; point it at
// the live server once listening.
setPeerServerForRateLimit(app.server);

// Unit tests compose route plugins directly rather than importing this entry
// point. The explicit env gates also keep the background timer out of any
// integration test that does import the full server.
if (
  process.env.LAMASYNC_TEST !== "1" &&
  process.env.NODE_ENV !== "test"
) {
  startNotificationSweep();
}

// Run one prune on startup, then a daily interval (with unref so the timer
// never keeps the process alive on its own).
try {
  const initial = pruneOperationLog(retentionMs);
  if (initial.deleted > 0) {
    console.log(
      `[retention] pruned ${initial.deleted} operation_log entries ` +
        `older than ${retentionDays} day(s)`,
    );
  } else {
    console.log(`[retention] no operation_log entries older than ${retentionDays} day(s)`);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[retention] startup prune failed: ${msg}`);
}

const pruneTimer = setInterval(() => {
  try {
    const out = pruneOperationLog(retentionMs);
    if (out.deleted > 0) {
      console.log(`[retention] pruned ${out.deleted} operation_log entries`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[retention] prune failed: ${msg}`);
  }
}, 24 * 60 * 60 * 1000);
pruneTimer.unref?.();

// LAMA-244: reaper for `folder_locks` rows whose TTL has elapsed. Without
// this, locks orphaned by a crashed daemon sit in the table forever and
// `acquire` from other hosts gets `409 folder_locked` until something
// overwrites the row. The reaper is opt-out (LAMASYNC_LOCK_REAPER_MS=0)
// and gated by the same test env checks as the rest of the boot-time
// timers so unit tests don't pick up a stray interval.
const LOCK_REAPER_DEFAULT_MS = 5 * 60_000;
const lockReaperMs = (() => {
  const raw = process.env.LAMASYNC_LOCK_REAPER_MS;
  if (raw === undefined) return LOCK_REAPER_DEFAULT_MS;
  if (raw === "0") return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : LOCK_REAPER_DEFAULT_MS;
})();

if (
  process.env.LAMASYNC_TEST !== "1" &&
  process.env.NODE_ENV !== "test" &&
  lockReaperMs > 0
) {
  try {
    const out = reapExpiredFolderLocks();
    if (out.deleted > 0) {
      console.log(
        `[reaper] cleared ${out.deleted} expired folder lock(s) at startup`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[reaper] startup pass failed: ${msg}`);
  }

  const lockReaperTimer = setInterval(() => {
    try {
      const out = reapExpiredFolderLocks();
      if (out.deleted > 0) {
        console.log(`[reaper] cleared ${out.deleted} expired folder lock(s)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[reaper] pass failed: ${msg}`);
    }
  }, lockReaperMs);
  lockReaperTimer.unref?.();
}

// LAMA-266: server-side monthly backup fire drills. The interval is the
// per-backend cadence (default 30 days); the check interval is how often
// the server looks for due backends (default 1 hour — every newly-due
// backend could be up to 1h late, which is fine for a monthly cadence).
// A boot pass also runs immediately, but the scheduler itself skips
// backends whose last 'drill' row is newer than the cadence window so a
// fresh restart never re-fires everything at once.
const drillIntervalMs = parseDrillIntervalMs(
  process.env.LAMASYNC_DRILL_INTERVAL_MS,
  DEFAULT_DRILL_INTERVAL_MS,
);
const drillCheckIntervalMs = parseDrillIntervalMs(
  process.env.LAMASYNC_DRILL_CHECK_INTERVAL_MS,
  DEFAULT_DRILL_CHECK_INTERVAL_MS,
);

if (
  process.env.LAMASYNC_TEST !== "1" &&
  process.env.NODE_ENV !== "test" &&
  drillIntervalMs > 0 &&
  drillCheckIntervalMs > 0
) {
  const runDrillPass = (): void => {
    // Fire-and-forget: the scheduler reports nothing into the request
    // path, and the drill engine writes its own audit row + notification
    // so a failure here never silently disappears.
    runDrillScheduler({ intervalMs: drillIntervalMs, now: Date.now() })
      .then((result) => {
        if (result.ran > 0) {
          console.log(
            `[drill] pass: inspected ${result.inspected}, due ${result.due}, ran ${result.ran}, failed ${result.failed}`,
          );
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[drill] pass crashed: ${msg}`);
      });
  };
  // Boot pass: the scheduler's own due-check skips recent drills, so
  // a restart never re-fires immediately. The setInterval handles every
  // subsequent pass.
  runDrillPass();
  const drillTimer = setInterval(runDrillPass, drillCheckIntervalMs);
  drillTimer.unref?.();
}

// LAMA-262: light periodic sweep for expired pairing sessions. Belt-
// and-braces — every read also projects expiry onto the wire and flips
// the row, so this only matters for keeping the table bounded over time.
// Default 5 minutes is enough to amortize a DELETE pass across a fleet
// of devices without holding the DB long. Opt out with
// `LAMASYNC_PAIRING_SWEEP_MS=0` (matches the lock-reaper opt-out
// convention). Gated by the same test env checks so unit tests don't
// pick up a stray interval.
const PAIRING_SWEEP_DEFAULT_MS = 5 * 60_000;
const pairingSweepMs = (() => {
  const raw = process.env.LAMASYNC_PAIRING_SWEEP_MS;
  if (raw === undefined) return PAIRING_SWEEP_DEFAULT_MS;
  if (raw === "0") return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : PAIRING_SWEEP_DEFAULT_MS;
})();

if (
  process.env.LAMASYNC_TEST !== "1" &&
  process.env.NODE_ENV !== "test" &&
  pairingSweepMs > 0
) {
  try {
    const deleted = sweepExpiredPairingSessions();
    if (deleted > 0) {
      console.log(`[pairing] swept ${deleted} expired session row(s) at startup`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pairing] startup sweep failed: ${msg}`);
  }

  const pairingSweepTimer = setInterval(() => {
    try {
      sweepExpiredPairingSessions();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[pairing] sweep failed: ${msg}`);
    }
  }, pairingSweepMs);
  pairingSweepTimer.unref?.();
}

// LAMA-296 stage 1: reconcile abandoned upload staging on boot + daily
// (mirrors the pairing-sweep opt-out convention: LAMASYNC_MOBILE_SWEEP_MS=0
// disables the timer; the reconcile also re-seeds the staging usage counter).
const MOBILE_SWEEP_DEFAULT_MS = 24 * 60 * 60 * 1000;
const mobileSweepMs = (() => {
  const raw = process.env.LAMASYNC_MOBILE_SWEEP_MS;
  if (raw === undefined) return MOBILE_SWEEP_DEFAULT_MS;
  if (raw === "0") return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : MOBILE_SWEEP_DEFAULT_MS;
})();

if (
  process.env.LAMASYNC_TEST !== "1" &&
  process.env.NODE_ENV !== "test" &&
  mobileSweepMs > 0
) {
  try {
    const reconciled = reconcileAbandonedMobileUploads();
    if (reconciled > 0) {
      console.log(`[mobile-uploads] reconciled ${reconciled} abandoned upload(s) at startup`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mobile-uploads] startup reconcile failed: ${msg}`);
  }

  const mobileSweepTimer = setInterval(() => {
    try {
      reconcileAbandonedMobileUploads();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mobile-uploads] sweep failed: ${msg}`);
    }
  }, mobileSweepMs);
  mobileSweepTimer.unref?.();
}
