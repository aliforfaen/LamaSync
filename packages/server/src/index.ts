import { Elysia } from "elysia";
import swagger from "@elysiajs/swagger";
import { authPlugin } from "./auth.ts";
import { healthRoutes } from "./routes/health.ts";
import { hostsRoutes } from "./routes/hosts.ts";
import { configRoutes } from "./routes/config.ts";
import { foldersRoutes } from "./routes/folders.ts";
import { dotfilesRoutes } from "./routes/dotfiles.ts";
import { operationsRoutes } from "./routes/operations.ts";
import { reportRoutes } from "./routes/report.ts";
import { adminRoutes } from "./routes/admin.ts";
import { wsRoutes } from "./ws.ts";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);

const app = new Elysia()
  .use(
    swagger({
      documentation: {
        info: {
          title: "LamaSync API",
          version: "0.1.0",
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
  .use(authPlugin)
  .use(healthRoutes)
  .use(hostsRoutes)
  .use(configRoutes)
  .use(foldersRoutes)
  .use(dotfilesRoutes)
  .use(operationsRoutes)
  .use(reportRoutes)
  .use(adminRoutes)
  .listen({ port, hostname: "0.0.0.0" });

export type App = typeof app;

console.log(`LamaSync server listening on http://${app.server!.hostname}:${app.server!.port}`);
console.log(`Swagger UI: http://${app.server!.hostname}:${app.server!.port}/swagger`);
console.log(`WebSocket:  ws://${app.server!.hostname}:${app.server!.port}/api/v1/ws?apiKey=...`);
