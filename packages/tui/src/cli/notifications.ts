/**
 * `lamasync notifications list|channels|test` (LAMA-231).
 *
 * The notification delivery table (channels) and event history (list) are
 * both read-only here; create/update/delete of channels stays in the REST
 * API surface (the skill's `reference/api.md`) until Phase D.
 */

import type {
  NotificationChannel,
  NotificationEvent,
} from "@lamasync/core";

import { flagString } from "./args.ts";
import { wrapApiError } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { printJson, printTable } from "./output.ts";

export async function runList(ctx: CliContext): Promise<void> {
  const { client, json } = ctx;
  let events: NotificationEvent[];
  try {
    events = await client.client.listNotifications();
  } catch (err) {
    throw wrapApiError(err, "notifications list");
  }
  if (json) {
    printJson(events);
    return;
  }
  printTable(
    [
      { header: "WHEN", key: "whenLabel" },
      { header: "TYPE", key: "type" },
      { header: "SEVERITY", key: "severity" },
      { header: "DELIVERED", key: "delivered" },
      { header: "MESSAGE", key: "message" },
    ],
    events.map((e: NotificationEvent) => ({
      whenLabel: new Date(e.createdAt).toISOString(),
      type: e.type,
      severity: e.severity,
      delivered: `${e.ntfyDelivered ? "ntfy " : ""}${e.webhookDelivered ? "webhook" : ""}`.trim() || "—",
      message: e.message,
    })),
  );
}

export async function runChannels(ctx: CliContext): Promise<void> {
  const { client, json } = ctx;
  let channels: NotificationChannel[];
  try {
    channels = await client.client.listNotificationChannels();
  } catch (err) {
    throw wrapApiError(err, "notifications channels");
  }
  if (json) {
    printJson(channels);
    return;
  }
  printTable(
    [
      { header: "NAME", key: "name" },
      { header: "KIND", key: "kind" },
      { header: "ENABLED", key: "enabled" },
      { header: "URL", key: "url" },
      { header: "SEVERITIES", key: "severities" },
      { header: "LAST DELIVERY", key: "lastLabel" },
      { header: "ID", key: "id" },
    ],
    channels.map((c: NotificationChannel) => ({
      name: c.name,
      kind: c.kind,
      enabled: c.enabled ? "yes" : "no",
      url: c.url,
      severities: (c.severities ?? []).join(", "),
      lastLabel: c.lastDeliveryAt
        ? `${c.lastDeliveryStatus} @ ${new Date(c.lastDeliveryAt).toISOString()}`
        : "—",
      id: c.id,
    })),
  );
}

export async function runTest(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const channelId = flagString(flags, "channel");
  // POST /api/v1/notifications/test — with --channel the server delivers
  // through only that channel and answers {channelId, delivered, status};
  // without it the call records a test event and fans out to all channels.
  let result: Awaited<ReturnType<typeof client.client.testNotification>>;
  try {
    result = await client.client.testNotification(channelId ?? undefined);
  } catch (err) {
    throw wrapApiError(err, "notifications test");
  }
  if (json) {
    printJson(result);
    return;
  }
  if ("channelId" in result) {
    console.log(
      `test via channel ${result.channelId}: ${result.status} (delivered: ${result.delivered ? "yes" : "no"})`,
    );
  } else {
    console.log(`test notification recorded (event ${result.id})`);
  }
}
