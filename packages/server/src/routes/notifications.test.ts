import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

process.env.LAMASYNC_API_KEY =
  process.env.LAMASYNC_API_KEY ?? "notifications-test-key";
process.env.LAMASYNC_DATA_DIR =
  process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-notifications-test-data";

const { getAuthPlugin } = await import("../auth.ts");
const {
  __resetNotificationStateForTests,
  emitNotification,
  runNotificationSweep,
} = await import("../notifications.ts");
const { __setCachedLatestVersionForTests } = await import("../release-cache.ts");
const { __setDb, notificationsRoutes } = await import("./notifications.ts");

let db: Database;
let app: { handle(request: Request): Response | Promise<Response> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("expected an object response");
  return body;
}

async function responseObjects(
  response: Response,
): Promise<Array<Record<string, unknown>>> {
  const body: unknown = await response.json();
  if (!Array.isArray(body) || !body.every(isRecord)) {
    throw new Error("expected an array response");
  }
  return body;
}

beforeEach(() => {
  delete process.env.LAMASYNC_NTFY_URL;
  delete process.env.LAMASYNC_LAMADB_WEBHOOK_URL;
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // Migrations are intentionally idempotent for pre-existing schemas.
    }
  }
  __resetNotificationStateForTests();
  __setCachedLatestVersionForTests("0.2.3");
  __setDb(db);
  app = new Elysia().use(getAuthPlugin()).use(notificationsRoutes);
});

afterEach(() => {
  __resetNotificationStateForTests();
  db.close();
});

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${process.env.LAMASYNC_API_KEY}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${path}`, { ...init, headers });
}

describe("notification event router", () => {
  test("records an event and honors the per-folder conflict cooldown", () => {
    const first = emitNotification({
      type: "conflict_pending",
      hostId: "host-a",
      folderId: "folder-a",
      message: "Conflict pending",
      payload: { path: "notes.txt" },
    });
    const duplicate = emitNotification({
      type: "conflict_pending",
      hostId: "host-a",
      folderId: "folder-a",
      message: "Conflict still pending",
      payload: { path: "other.txt" },
    });

    expect(first).toBe(true);
    expect(duplicate).toBe(false);
    const rows = db
      .query<
        { type: string; severity: string; payload: string | null },
        []
      >("SELECT type, severity, payload FROM notification_events")
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("conflict_pending");
    expect(rows[0]?.severity).toBe("default");
    expect(rows[0]?.payload).toBe('{"path":"notes.txt"}');
  });

  test("escalates the second consecutive failure and resets after success", () => {
    expect(
      emitNotification({
        type: "operation_failed",
        hostId: "host-a",
        folderId: "folder-a",
        message: "Backup failed",
        payload: { operation: "backup" },
      }),
    ).toBe(true);
    expect(
      emitNotification({
        type: "operation_failed",
        hostId: "host-a",
        folderId: "folder-a",
        message: "Backup failed again",
        payload: { operation: "backup" },
      }),
    ).toBe(true);
    expect(
      emitNotification({
        type: "operation_failed",
        hostId: "host-a",
        folderId: "folder-a",
        message: "Backup failed a third time",
        payload: { operation: "backup" },
      }),
    ).toBe(false);

    emitNotification({
      type: "operation_success",
      hostId: "host-a",
      folderId: "folder-a",
      message: "Backup recovered",
    });
    expect(
      emitNotification({
        type: "operation_failed",
        hostId: "host-a",
        folderId: "folder-a",
        message: "Backup failed after recovery",
        payload: { operation: "backup" },
      }),
    ).toBe(true);

    const severities = db
      .query<{ severity: string }, []>(
        "SELECT severity FROM notification_events WHERE type = 'operation_failed' ORDER BY rowid",
      )
      .all()
      .map((row) => row.severity);
    expect(severities).toEqual(["default", "critical", "default"]);
  });

  test("delivers critical/default to ntfy and every severity to the LamaDB webhook", async () => {
    const deliveries: Array<{
      path: string;
      body: Record<string, unknown>;
    }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(incoming) {
        const parsed: unknown = await incoming.json();
        if (!isRecord(parsed)) return new Response("invalid", { status: 400 });
        deliveries.push({ path: new URL(incoming.url).pathname, body: parsed });
        return new Response(null, { status: 204 });
      },
    });

    try {
      process.env.LAMASYNC_NTFY_URL =
        `http://127.0.0.1:${server.port}/lamasync-test`;
      process.env.LAMASYNC_LAMADB_WEBHOOK_URL =
        `http://127.0.0.1:${server.port}/webhook`;

      emitNotification({ type: "restore_failed", message: "critical event" });
      emitNotification({ type: "test", message: "default event" });
      emitNotification({ type: "restore_done", message: "info event" });

      let rows: Array<{
        type: string;
        ntfy_delivered: number | null;
        webhook_delivered: number | null;
      }> = [];
      for (let attempt = 0; attempt < 50; attempt += 1) {
        rows = db
          .query<
            {
              type: string;
              ntfy_delivered: number | null;
              webhook_delivered: number | null;
            },
            []
          >(
            `SELECT type, ntfy_delivered, webhook_delivered
             FROM notification_events ORDER BY rowid`,
          )
          .all();
        if (
          rows.length === 3 &&
          rows[0]?.ntfy_delivered === 1 &&
          rows[0]?.webhook_delivered === 1 &&
          rows[1]?.ntfy_delivered === 1 &&
          rows[1]?.webhook_delivered === 1 &&
          rows[2]?.webhook_delivered === 1
        ) {
          break;
        }
        await Bun.sleep(2);
      }

      expect(rows).toEqual([
        { type: "restore_failed", ntfy_delivered: 1, webhook_delivered: 1 },
        { type: "test", ntfy_delivered: 1, webhook_delivered: 1 },
        { type: "restore_done", ntfy_delivered: 0, webhook_delivered: 1 },
      ]);
      expect(deliveries.map((delivery) => delivery.path).sort()).toEqual([
        "/lamasync-test",
        "/lamasync-test",
        "/webhook",
        "/webhook",
        "/webhook",
      ]);
      const criticalNtfy = deliveries.find(
        (delivery) =>
          delivery.path === "/lamasync-test" &&
          delivery.body.message === "critical event",
      );
      expect(criticalNtfy?.body.topic).toBe("lamasync-test");
      expect(criticalNtfy?.body.tags).toEqual(["rotating_light"]);
      const defaultNtfy = deliveries.find(
        (delivery) =>
          delivery.path === "/lamasync-test" &&
          delivery.body.message === "default event",
      );
      expect(defaultNtfy?.body.tags).toEqual(["warning"]);
      const webhook = deliveries.find(
        (delivery) =>
          delivery.path === "/webhook" && delivery.body.severity === "info",
      );
      expect(webhook?.body.type).toBe("restore_done");
      expect(webhook?.body.message).toBe("info event");
    } finally {
      delete process.env.LAMASYNC_NTFY_URL;
      delete process.env.LAMASYNC_LAMADB_WEBHOOK_URL;
      server.stop(true);
    }
  });
});

describe("notification routes", () => {
  test("POST /notifications/test records and returns a test event without delivery config", async () => {
    const response = await app.handle(
      request("/api/v1/notifications/test", { method: "POST" }),
    );
    expect(response.status).toBe(201);
    const body = await responseObject(response);
    expect(body.type).toBe("test");
    expect(body.severity).toBe("default");
    expect(body.message).toBe("Test notification from Admin UI");
    expect(body.ntfyDelivered).toBe(false);
    expect(body.webhookDelivered).toBe(false);

    const count = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM notification_events WHERE type = 'test'",
      )
      .get();
    expect(count?.count).toBe(1);
  });

  test("GET /notifications returns newest events first", async () => {
    emitNotification({ type: "test", message: "first" });
    emitNotification({ type: "test", message: "second" });

    const response = await app.handle(
      request("/api/v1/notifications?limit=20"),
    );
    expect(response.status).toBe(200);
    const body = await responseObjects(response);
    expect(body.map((event) => event.message)).toEqual(["second", "first"]);
  });
});

describe("host staleness sweep", () => {
  test("marks a stale host offline and emits the edge only once", async () => {
    const now = 1_800_000_000_000;
    db.run(
      `INSERT INTO hosts (id, hostname, last_seen, status)
       VALUES (?, ?, ?, ?)`,
      ["host-stale", "stale-box", now - 91_000, "online"],
    );

    await runNotificationSweep(now);
    const host = db
      .query<{ status: string | null }, [string]>(
        "SELECT status FROM hosts WHERE id = ?",
      )
      .get("host-stale");
    expect(host?.status).toBe("offline");

    await runNotificationSweep(now + 60_000);
    const events = db
      .query<{ type: string }, []>(
        "SELECT type FROM notification_events WHERE host_id = 'host-stale'",
      )
      .all();
    expect(events.map((event) => event.type)).toEqual(["host_offline"]);
  });

  test("emits update_available only on false-to-true edges", async () => {
    const now = 1_800_000_000_000;
    db.run(
      `INSERT INTO hosts (id, hostname, last_seen, status, version)
       VALUES (?, ?, ?, ?, ?)`,
      ["host-old", "old-box", now, "online", "0.1.0"],
    );

    await runNotificationSweep(now);
    await runNotificationSweep(now + 60_000);
    let events = db
      .query<{ type: string }, []>(
        "SELECT type FROM notification_events WHERE host_id = 'host-old'",
      )
      .all();
    expect(events.map((event) => event.type)).toEqual(["update_available"]);

    db.run("UPDATE hosts SET version = '0.2.3', last_seen = ? WHERE id = 'host-old'", [
      now + 120_000,
    ]);
    await runNotificationSweep(now + 120_000);
    db.run("UPDATE hosts SET version = '0.1.0', last_seen = ? WHERE id = 'host-old'", [
      now + 180_000,
    ]);
    await runNotificationSweep(now + 180_000);

    events = db
      .query<{ type: string }, []>(
        "SELECT type FROM notification_events WHERE host_id = 'host-old'",
      )
      .all();
    expect(events.map((event) => event.type)).toEqual([
      "update_available",
      "update_available",
    ]);
  });
});
