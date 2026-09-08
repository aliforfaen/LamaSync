// LAMA-API-AUDIT: the Elysia app composition (swagger metadata + route
// plugins + error boundary) lives here so tests can build the real app
// (and inspect its generated OpenAPI) without booting the listener or the
// boot-time timers. `index.ts` stays the boot entry point: it handles
// flags/env, calls `createServerApp().listen(...)`, and owns the sweeps.
//
// The swagger `documentation` block is the machine metadata for every
// client (Swagger UI, /swagger/json consumers, the agent skill). Two rules:
//   1. `info.version` must track `VERSION` from @lamasync/core — never a
//      hard-coded string.
//   2. Every operation `tags` value must be declared exactly once below,
//      and `info.description` must describe the current surface.

import { Elysia } from "elysia";
import swagger from "@elysiajs/swagger";
import { getAuthPlugin } from "./auth.ts";
import { healthRoutes } from "./routes/health.ts";
import { hostsRoutes } from "./routes/hosts.ts";
import { configRoutes } from "./routes/config.ts";
import { foldersRoutes } from "./routes/folders.ts";
import { appsRoutes } from "./routes/apps.ts";
import { retentionRoutes } from "./routes/retention.ts";
import { reportRoutes } from "./routes/report.ts";
import { sharesRoutes } from "./routes/shares.ts";
import { adminRoutes } from "./routes/admin.ts";
import { resticRoutes } from "./routes/restic.ts";
import { conflictsRoutes } from "./routes/conflicts.ts";
import { operationsRoutes } from "./routes/operations.ts";
import { releaseRoutes } from "./routes/release.ts";
import { actionsRoutes } from "./routes/actions.ts";
import { notificationsRoutes } from "./routes/notifications.ts";
import { browseRoutes } from "./routes/browse.ts";
import { folderSnapshotsRoutes } from "./routes/snapshots.ts";
import { folderFileRoutes } from "./routes/folder-files.ts";
import { backendsRoutes } from "./routes/backends.ts";
import { statsRoutes } from "./routes/stats.ts";
import { healthDrillRoutes } from "./routes/health-drill.ts";
import { demoRoutes } from "./routes/demo.ts";
import { pauseRoutes } from "./routes/pause.ts";
import { pairingRoutes } from "./routes/pairing.ts";
import { apiKeysRoutes } from "./routes/api-keys.ts";
import { serverDeployRoutes } from "./routes/server-deploys.ts";
import { backupLegacyRoutes } from "./routes/backup-legacy.ts";
import { mobileRoutes } from "./routes/mobile.ts";
import { mobileUploadRoutes } from "./routes/mobile-uploads.ts";
import { webUiRoutes } from "./routes/web-ui.ts";
import { VERSION, type ErrorResponse } from "@lamasync/core";
import { wsRoutes } from "./ws.ts";

export function createServerApp() {
  return new Elysia()
    .use(
      swagger({
        documentation: {
          info: {
            title: "LamaSync API",
            version: VERSION,
            description:
              "LamaSync server: fleet registration, configuration distribution, folder and backend management, application captures, mobile device onboarding and uploads, shares, and operation reporting.",
          },
          tags: [
            {
              name: "Actions",
              description: "Queued actions (control plane → daemon)",
            },
            { name: "Admin", description: "Destructive admin operations" },
            {
              name: "API Keys",
              description:
                "Managed credential administration and identity discovery (LAMA-234)",
            },
            {
              name: "Apps",
              description: "Application templates, protections, and snapshots",
            },
            {
              name: "Backends",
              description:
                "Reusable storage backends and health verification",
            },
            {
              name: "Backups",
              description: "Legacy backup data maintenance (LAMA-294)",
            },
            { name: "Config", description: "Host configuration distribution" },
            { name: "Conflicts", description: "Manual sync conflict queue" },
            {
              name: "Data Browser",
              description:
                "Browsing and explicit file operations across local backups, S3 folders, and restic snapshots",
            },
            {
              name: "Demo",
              description: "Demo-mode fleet seeding and deletion",
            },
            {
              name: "Folders",
              description: "Folder and assignment management",
            },
            {
              name: "Health",
              description:
                "Fleet status, backup prove-it, and monthly fire drills",
            },
            {
              name: "Hosts",
              description: "Registration and heartbeat",
            },
            {
              name: "Mobile",
              description:
                "LAMA-296 Android-companion endpoints — enrollment, exchange, web-session bootstrap, native identity, check-in, revocation, and uploads.",
            },
            {
              name: "Notifications",
              description:
                "Durable notification history and delivery channels",
            },
            {
              name: "Operations",
              description: "Job reporting and log queries",
            },
            {
              name: "Pairing",
              description:
                "LAMA-262 pairing-session endpoints — admin issues short codes, devices exchange them for a host-bound device API key.",
            },
            {
              name: "Pause",
              description:
                "LAMA-273 pause/slow mode toggle (global + per-device)",
            },
            {
              name: "Release",
              description:
                "Release metadata proxy for client self-update checks",
            },
            {
              name: "Restic",
              description: "Restic snapshot and restore jobs",
            },
            {
              name: "Retention",
              description:
                "LAMA-325 snapshot retention policies, read-only previews, and confirmed execution (app protections + restic folders)",
            },
            {
              name: "Server Deploys",
              description:
                "LAMA-301 production server deploy agent jobs (peek/claim/progress/complete)",
            },
            {
              name: "Shares",
              description: "NFS/SMB share catalog",
            },
            {
              name: "Stats",
              description: "Storage usage reports",
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
    .use(appsRoutes)
    .use(retentionRoutes)
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
    .use(statsRoutes)
    .use(demoRoutes)
    .use(browseRoutes)
    .use(folderSnapshotsRoutes)
    .use(folderFileRoutes)
    .use(pauseRoutes)
    .use(pairingRoutes)
    .use(apiKeysRoutes)
    .use(serverDeployRoutes)
    .use(healthDrillRoutes)
    .use(backupLegacyRoutes)
    .use(mobileRoutes)
    .use(mobileUploadRoutes)
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
    });
}

export type App = ReturnType<typeof createServerApp>;
