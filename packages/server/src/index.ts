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
import { VERSION } from "@lamasync/core";
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
   .listen({ port, hostname: "0.0.0.0" });

export type App = typeof app;

console.log(`LamaSync server v${VERSION} listening on http://${app.server!.hostname}:${app.server!.port}`);
console.log(`Swagger UI: http://${app.server!.hostname}:${app.server!.port}/swagger`);
console.log(`WebSocket:  ws://${app.server!.hostname}:${app.server!.port}/api/v1/ws (subprotocol: lamasync-auth, <base64(apiKey)>)`);

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