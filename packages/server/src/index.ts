import { Elysia } from "elysia";
import swagger from "@elysiajs/swagger";
import { getAuthPlugin } from "./auth.ts";
import { healthRoutes } from "./routes/health.ts";
import { hostsRoutes } from "./routes/hosts.ts";
import { configRoutes } from "./routes/config.ts";
import { foldersRoutes } from "./routes/folders.ts";
import { dotfilesRoutes } from "./routes/dotfiles.ts";
import { reportRoutes } from "./routes/report.ts";
import { sharesRoutes } from "./routes/shares.ts";
import { adminRoutes, pruneOperationLog } from "./routes/admin.ts";
import { resticRoutes } from "./routes/restic.ts";
import { conflictsRoutes } from "./routes/conflicts.ts";
import { operationsRoutes } from "./routes/operations.ts";
import { releaseRoutes } from "./routes/release.ts";
import { actionsRoutes } from "./routes/actions.ts";
import { notificationsRoutes } from "./routes/notifications.ts";
import { browseRoutes } from "./routes/browse.ts";
import { backendsRoutes } from "./routes/backends.ts";
import { webUiRoutes } from "./routes/web-ui.ts";
import { startNotificationSweep, seedChannelsFromEnv } from "./notifications.ts";
import { db } from "./db.ts";
import { VERSION, type ErrorResponse } from "@lamasync/core";
import { wsRoutes } from "./ws.ts";

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


// LAMA-221: first boot with legacy env vars (LAMASYNC_NTFY_URL /
// LAMASYNC_LAMADB_WEBHOOK_URL) seeds the notification_channels table once;
// later config is managed from the Admin page and survives restarts.
seedChannelsFromEnv(db);

const app = new Elysia()
  .use(
    swagger({
      documentation: {
        info: {
          title: "LamaSync API",
          version: "0.2.0",
          description:
            "LamaSync server: fleet registration, configuration distribution, folder management, dotfile storage, and operation reporting.",
        },
        tags: [
          { name: "Health", description: "Fleet status" },
          { name: "Hosts", description: "Registration and heartbeat" },
          { name: "Config", description: "Host configuration distribution" },
          { name: "Folders", description: "Folder and assignment management" },
          { name: "Dotfiles", description: "Dotfile version storage" },
          {
            name: "Operations",
            description: "Job reporting and log queries",
          },
          { name: "Admin", description: "Destructive admin operations" },
          { name: "Restic", description: "Restic snapshot and restore jobs" },
          { name: "Conflicts", description: "Manual sync conflict queue" },
          {
            name: "Actions",
            description: "Queued actions (control plane → daemon)",
          },
          {
            name: "Notifications",
            description: "Durable notification history and delivery tests",
          },
          {
            name: "Data Browser",
            description: "Read-only browsing of local backups, S3 folders, and restic snapshots",
          },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              description: "Pre-shared API key (env LAMASYNC_API_KEY)",
            },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    }),
  )
  .use(webUiRoutes)
  .use(wsRoutes)
  .use(getAuthPlugin())
  .use(healthRoutes)
  .use(hostsRoutes)
  .use(configRoutes)
  .use(foldersRoutes)
  .use(dotfilesRoutes)
  .use(reportRoutes)
  .use(sharesRoutes)
  .use(adminRoutes)
  .use(resticRoutes)
  .use(conflictsRoutes)
  .use(operationsRoutes)
  .use(releaseRoutes)
  .use(actionsRoutes)
  .use(notificationsRoutes)
  .use(backendsRoutes)
  .use(browseRoutes)
  .onError(({ code, error, set }): ErrorResponse => {
    if (code === "VALIDATION") {
      set.status = 422;
      return { error: error instanceof Error ? error.message : String(error) };
    }
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "not_found" };
    }
    console.error("[server] unhandled error:", error);
    set.status = 500;
    return { error: "internal_server_error" };
  })
  .listen({ port, hostname: "0.0.0.0" });

export type App = typeof app;

console.log(`LamaSync server v${VERSION} listening on http://${app.server!.hostname}:${app.server!.port}`);
console.log(`Swagger UI: http://${app.server!.hostname}:${app.server!.port}/swagger`);
console.log(`WebSocket:  ws://${app.server!.hostname}:${app.server!.port}/api/v1/ws (subprotocol: lamasync-auth, <base64(apiKey)>)`);

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