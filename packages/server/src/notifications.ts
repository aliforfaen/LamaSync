import type { Database } from "bun:sqlite";
import {
  isNewer,
  type Host,
  type HostStatus,
  type NotificationChannel,
  type NotificationChannelKind,
  type NotificationEvent,
  type NotificationSeverity,
  type NotificationType,
} from "@lamasync/core";
import { db as defaultDb } from "./db.ts";
import { getCachedLatestVersion } from "./release-cache.ts";
import { broadcast } from "./ws.ts";

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const CONFLICT_COOLDOWN_MS = 15 * 60 * 1000;
const SUCCESS_COOLDOWN_MS = 30 * 60 * 1000;
const HOST_STALE_AFTER_MS = 90 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

// LAMA-221: every notification channel's severities, used as the fallback
// when a stored severities JSON is unparseable.
const ALL_SEVERITIES: NotificationSeverity[] = ["critical", "default", "info"];

const SEVERITY_SET = new Set<string>(ALL_SEVERITIES);

interface ChannelRow {
  id: string;
  kind: string;
  name: string;
  url: string;
  enabled: number;
  severities: string;
  last_delivery_status: string | null;
  last_delivery_at: number | null;
  created_at: number;
}

function channelKind(value: string): NotificationChannelKind | null {
  return value === "ntfy" || value === "webhook" ? value : null;
}

/** Parse the stored severities JSON allowlist; malformed data degrades to
 *  every severity rather than silently dropping deliveries. */
export function parseSeverities(raw: string | null): NotificationSeverity[] {
  if (!raw) return [...ALL_SEVERITIES];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...ALL_SEVERITIES];
    const severities = parsed.filter(
      (item): item is NotificationSeverity =>
        typeof item === "string" && SEVERITY_SET.has(item),
    );
    return severities.length > 0 ? severities : [...ALL_SEVERITIES];
  } catch {
    return [...ALL_SEVERITIES];
  }
}

function rowToChannel(row: ChannelRow): NotificationChannel | null {
  const kind = channelKind(row.kind);
  if (kind === null) return null;
  return {
    id: row.id,
    kind,
    name: row.name,
    url: row.url,
    enabled: row.enabled === 1,
    severities: parseSeverities(row.severities),
    lastDeliveryStatus: row.last_delivery_status === "success" || row.last_delivery_status === "failed"
      ? row.last_delivery_status
      : null,
    lastDeliveryAt: row.last_delivery_at,
    createdAt: row.created_at,
  };
}

const CHANNEL_SELECT =
  "SELECT id, kind, name, url, enabled, severities, last_delivery_status, last_delivery_at, created_at FROM notification_channels";

export function listChannels(database: Database): NotificationChannel[] {
  const rows = database
    .query<ChannelRow, []>(`${CHANNEL_SELECT} ORDER BY created_at ASC`)
    .all();
  const channels: NotificationChannel[] = [];
  for (const row of rows) {
    const channel = rowToChannel(row);
    if (channel) channels.push(channel);
  }
  return channels;
}

export function getChannel(
  database: Database,
  channelId: string,
): NotificationChannel | null {
  const row = database
    .query<ChannelRow, [string]>(`${CHANNEL_SELECT} WHERE id = ?`)
    .get(channelId);
  return row ? rowToChannel(row) : null;
}

function listEnabledChannels(database: Database): NotificationChannel[] {
  return listChannels(database).filter((channel) => channel.enabled);
}

function updateChannelDelivery(
  database: Database,
  channelId: string,
  status: "success" | "failed",
): void {
  try {
    database.run(
      `UPDATE notification_channels
       SET last_delivery_status = ?, last_delivery_at = ?
       WHERE id = ?`,
      [status, Date.now(), channelId],
    );
  } catch (error) {
    console.error(
      `[notifications] failed to record delivery for ${channelId}: ${errorMessage(error)}`,
    );
  }
}

export interface NotificationInput {
  type: NotificationType;
  message: string;
  hostId?: string | null;
  folderId?: string | null;
  payload?: Record<string, unknown> | null;
}

interface NotificationState {
  lastEmittedAt?: number;
  lastFailureAt?: number;
  failureCount?: number;
  edge?: "online" | "offline" | "available" | "unavailable";
}

interface HostRow {
  id: string;
  hostname: string;
  tailnet_ip: string | null;
  last_seen: number | null;
  status: string | null;
  lan_ip: string | null;
  version: string | null;
  config_revision: number | null;
}

const HOST_SELECT =
  "SELECT id, hostname, tailnet_ip, last_seen, status, lan_ip, version, config_revision FROM hosts";

let activeDb: Database = defaultDb;
const notificationState = new Map<string, NotificationState>();

/** Test seam shared by notification routes and routes that emit events. */
export function __setDb(next: Database): void {
  activeDb = next;
}

/** Cooldowns are intentionally process-local; restarting resets them. */
export function __resetNotificationStateForTests(): void {
  notificationState.clear();
}

export function severityForType(type: NotificationType): NotificationSeverity {
  switch (type) {
    case "restore_failed":
    case "host_offline":
      return "critical";
    case "operation_failed":
    case "conflict_pending":
    case "update_available":
    case "test":
      return "default";
    case "restore_done":
    case "operation_success":
    case "host_online":
      return "info";
  }
}

function stateKey(
  type: NotificationType | "host_state",
  hostId?: string | null,
  folderId?: string | null,
): string {
  return `${type}|${hostId ?? ""}|${folderId ?? ""}`;
}

function withinWindow(
  now: number,
  previous: number | undefined,
  windowMs: number,
): boolean {
  return previous !== undefined && now >= previous && now - previous < windowMs;
}

function isBackupFailure(input: NotificationInput): boolean {
  const operation = input.payload?.operation;
  if (typeof operation === "string") return operation === "backup";
  if (!input.folderId) return false;
  try {
    const folder = activeDb
      .query<{ type: string }, [string]>("SELECT type FROM folders WHERE id = ?")
      .get(input.folderId);
    return folder?.type === "backup";
  } catch {
    return false;
  }
}

function decideSeverity(
  input: NotificationInput,
  now: number,
): NotificationSeverity | null {
  if (input.type === "operation_success") {
    // A success breaks the consecutive-failure chain even when the success
    // digest itself is cooldown-suppressed.
    notificationState.delete(
      stateKey("operation_failed", input.hostId, input.folderId),
    );
    const key = stateKey("operation_success", input.hostId, null);
    const state = notificationState.get(key) ?? {};
    if (withinWindow(now, state.lastEmittedAt, SUCCESS_COOLDOWN_MS)) {
      return null;
    }
    state.lastEmittedAt = now;
    notificationState.set(key, state);
    return "info";
  }

  if (input.type === "operation_failed") {
    const key = stateKey(input.type, input.hostId, input.folderId);
    const state = notificationState.get(key) ?? {};
    const consecutive = withinWindow(now, state.lastFailureAt, FAILURE_WINDOW_MS);
    state.failureCount = consecutive ? (state.failureCount ?? 1) + 1 : 1;
    state.lastFailureAt = now;

    if (state.failureCount === 1) {
      state.lastEmittedAt = now;
      notificationState.set(key, state);
      return "default";
    }

    const backupFailure = isBackupFailure(input);
    // The first repeated backup failure inside the window escalates
    // immediately even though the first warning is still cooling down.
    if (state.failureCount === 2 && backupFailure) {
      state.lastEmittedAt = now;
      notificationState.set(key, state);
      return "critical";
    }

    if (withinWindow(now, state.lastEmittedAt, FAILURE_WINDOW_MS)) {
      notificationState.set(key, state);
      return null;
    }

    state.lastEmittedAt = now;
    notificationState.set(key, state);
    return backupFailure ? "critical" : "default";
  }

  if (input.type === "conflict_pending") {
    const key = stateKey(input.type, input.hostId, input.folderId);
    const state = notificationState.get(key) ?? {};
    if (withinWindow(now, state.lastEmittedAt, CONFLICT_COOLDOWN_MS)) {
      return null;
    }
    state.lastEmittedAt = now;
    notificationState.set(key, state);
    return "default";
  }

  if (input.type === "host_offline" || input.type === "host_online") {
    if (!input.hostId) return severityForType(input.type);
    const key = stateKey("host_state", input.hostId, null);
    const state = notificationState.get(key) ?? {};
    const nextEdge = input.type === "host_offline" ? "offline" : "online";
    if (state.edge === nextEdge) return null;
    state.edge = nextEdge;
    state.lastEmittedAt = now;
    notificationState.set(key, state);
    return severityForType(input.type);
  }

  if (input.type === "update_available") {
    if (!input.hostId) return "default";
    const key = stateKey(input.type, input.hostId, null);
    const state = notificationState.get(key) ?? {};
    if (state.edge === "available") return null;
    state.edge = "available";
    state.lastEmittedAt = now;
    notificationState.set(key, state);
    return "default";
  }

  // Restore completion/failure and test events intentionally have no cooldown.
  return severityForType(input.type);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deliveryTag(severity: NotificationSeverity): string {
  switch (severity) {
    case "critical":
      return "rotating_light";
    case "default":
      return "warning";
    case "info":
      return "information_source";
  }
}

function topicFromUrl(rawUrl: string): string | null {
  try {
    const pathname = new URL(rawUrl).pathname;
    const segments = pathname.split("/").filter((segment) => segment.length > 0);
    const topic = segments[segments.length - 1];
    return topic ? decodeURIComponent(topic) : null;
  } catch (error) {
    console.error(
      `[notifications] invalid LAMASYNC_NTFY_URL: ${errorMessage(error)}`,
    );
    return null;
  }
}

function markDelivered(
  database: Database,
  eventId: string,
  column: "ntfy_delivered" | "webhook_delivered",
): void {
  try {
    database.run(
      `UPDATE notification_events SET ${column} = 1 WHERE id = ?`,
      [eventId],
    );
  } catch (error) {
    console.error(
      `[notifications] failed to mark ${column} for ${eventId}: ${errorMessage(error)}`,
    );
  }
}

async function postJson(
  target: string,
  body: Record<string, unknown>,
  targetName: string,
): Promise<boolean> {
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error(
        `[notifications] ${targetName} delivery failed with HTTP ${response.status}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error(
      `[notifications] ${targetName} delivery failed: ${errorMessage(error)}`,
    );
    return false;
  }
}

/** Deliver a single event through one channel (severity filtering is the
 *  caller's job — the per-channel test path bypasses it). Returns whether
 *  the upstream accepted the POST, and records the channel's delivery state. */
async function deliverToChannel(
  channel: NotificationChannel,
  event: NotificationEvent,
  database: Database,
): Promise<boolean> {
  let delivered = false;
  if (channel.kind === "ntfy") {
    const topic = topicFromUrl(channel.url);
    if (topic) {
      delivered = await postJson(
        channel.url,
        {
          topic,
          title: `LamaSync: ${event.type.replaceAll("_", " ")}`,
          message: event.message,
          tags: [deliveryTag(event.severity)],
        },
        channel.name,
      );
    }
  } else {
    delivered = await postJson(
      channel.url,
      {
        type: event.type,
        severity: event.severity,
        message: event.message,
        hostId: event.hostId ?? null,
        folderId: event.folderId ?? null,
        createdAt: event.createdAt,
      },
      channel.name,
    );
  }
  updateChannelDelivery(database, channel.id, delivered ? "success" : "failed");
  return delivered;
}

function scheduleDeliveries(event: NotificationEvent, database: Database): void {
  for (const channel of listEnabledChannels(database)) {
    if (!channel.severities.includes(event.severity)) continue;
    void deliverToChannel(channel, event, database).then((delivered) => {
      if (delivered) {
        markDelivered(
          database,
          event.id,
          channel.kind === "ntfy" ? "ntfy_delivered" : "webhook_delivered",
        );
      }
    });
  }
}

/**
 * LAMA-221: seed the channels table from the legacy env vars on first boot.
 * Only runs when the table is empty so restarts never duplicate channels.
 * The ntfy seed keeps the historic info-suppression behavior by defaulting
 * to ["critical","default"]; the LamaDB webhook seed delivers everything.
 */
export function seedChannelsFromEnv(database: Database): void {
  const { count } = database
    .query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM notification_channels",
    )
    .get() ?? { count: 0 };
  if (count > 0) return;

  const now = Date.now();
  const ntfyUrl = process.env.LAMASYNC_NTFY_URL;
  if (ntfyUrl) {
    database.run(
      `INSERT INTO notification_channels
         (id, kind, name, url, enabled, severities, created_at)
       VALUES (?, 'ntfy', 'ntfy', ?, 1, ?, ?)`,
      [crypto.randomUUID(), ntfyUrl, JSON.stringify(["critical", "default"]), now],
    );
  }
  const webhookUrl = process.env.LAMASYNC_LAMADB_WEBHOOK_URL;
  if (webhookUrl) {
    database.run(
      `INSERT INTO notification_channels
         (id, kind, name, url, enabled, severities, created_at)
       VALUES (?, 'webhook', 'LamaDB webhook', ?, 1, ?, ?)`,
      [crypto.randomUUID(), webhookUrl, JSON.stringify(ALL_SEVERITIES), now],
    );
  }
}

/** Deliver a test event through a single named channel (used by the Admin
 *  per-channel Test button). Returns null when the channel is unknown.
 *  The event is still recorded so the Admin feed shows it. */
export async function deliverTestToChannel(
  database: Database,
  channelId: string,
): Promise<{ delivered: boolean; status: "success" | "failed" } | null> {
  const channel = getChannel(database, channelId);
  if (!channel) return null;
  const event: NotificationEvent = {
    id: crypto.randomUUID(),
    type: "test",
    severity: "default",
    message: "Test notification from Admin UI",
    hostId: null,
    folderId: null,
    payload: null,
    createdAt: Date.now(),
    ntfyDelivered: false,
    webhookDelivered: false,
  };
  database.run(
    `INSERT INTO notification_events
       (id, type, severity, message, host_id, folder_id, payload, created_at,
        ntfy_delivered, webhook_delivered)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    [
      event.id,
      event.type,
      event.severity,
      event.message,
      null,
      null,
      null,
      event.createdAt,
    ],
  );
  const delivered = await deliverToChannel(channel, event, database);
  if (delivered) {
    markDelivered(
      database,
      event.id,
      channel.kind === "ntfy" ? "ntfy_delivered" : "webhook_delivered",
    );
  }
  return { delivered, status: delivered ? "success" : "failed" };
}

/** Validate an outgoing channel before create/update. Returns an error
 *  message, or null when the channel is valid. Exported for route reuse. */
export function validateChannelInput(input: {
  kind?: unknown;
  name?: unknown;
  url?: unknown;
  enabled?: unknown;
  severities?: unknown;
}): string | null {
  if (typeof input.kind === "string" && channelKind(input.kind) === null) {
    return "kind must be 'ntfy' or 'webhook'";
  }
  if (typeof input.name === "string" && input.name.trim().length === 0) {
    return "name must not be empty";
  }
  if (typeof input.url === "string") {
    try {
      const parsed = new URL(input.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "url must be an http(s) URL";
      }
    } catch {
      return "url must be a valid URL";
    }
  }
  if (typeof input.enabled !== "undefined" && typeof input.enabled !== "boolean") {
    return "enabled must be a boolean";
  }
  if (typeof input.severities !== "undefined") {
    if (!Array.isArray(input.severities)) return "severities must be an array";
    if (input.severities.length === 0) return "severities must not be empty";
    const invalid = input.severities.some(
      (item) => typeof item !== "string" || !SEVERITY_SET.has(item),
    );
    if (invalid) return "severities contains an invalid level";
  }
  return null;
}

/** Inputs accepted by create/update. Elysia validates the wire shape first;
 *  applyChannelInput trusts the concrete types it receives. */
export interface ChannelInput {
  kind?: NotificationChannelKind;
  name?: string;
  url?: string;
  enabled?: boolean;
  severities?: NotificationSeverity[];
}

/** Map a validated channel body (create or update) into a DB column set. */
export function applyChannelInput(
  database: Database,
  channelId: string,
  input: ChannelInput,
  created: boolean,
): NotificationChannel | null {
  const now = Date.now();
  if (created) {
    const kind = input.kind ?? "ntfy";
    const name = (input.name ?? "").trim();
    const url = (input.url ?? "").trim();
    const severities =
      input.severities !== undefined && input.severities.length > 0
        ? input.severities
        : [...ALL_SEVERITIES];
    database.run(
      `INSERT INTO notification_channels
         (id, kind, name, url, enabled, severities, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        channelId,
        kind,
        name,
        url,
        input.enabled === false ? 0 : 1,
        JSON.stringify(severities),
        now,
      ],
    );
  } else {
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (input.kind !== undefined) {
      sets.push("kind = ?");
      params.push(input.kind);
    }
    if (input.name !== undefined) {
      sets.push("name = ?");
      params.push(input.name.trim());
    }
    if (input.url !== undefined) {
      sets.push("url = ?");
      params.push(input.url.trim());
    }
    if (input.enabled !== undefined) {
      sets.push("enabled = ?");
      params.push(input.enabled ? 1 : 0);
    }
    if (input.severities !== undefined) {
      sets.push("severities = ?");
      params.push(JSON.stringify(input.severities));
    }
    if (sets.length === 0) return getChannel(database, channelId);
    params.push(channelId);
    database.run(`UPDATE notification_channels SET ${sets.join(", ")} WHERE id = ?`, params);
  }
  return getChannel(database, channelId);
}

/**
 * Record and fan out an event, returning the created row or `null` when the
 * event was cooldown-suppressed or persistence failed. Delivery is always
 * asynchronous and can never reject into a request handler.
 */
export function emitNotificationEvent(
  input: NotificationInput,
): NotificationEvent | null {
  try {
    const now = Date.now();
    const severity = decideSeverity(input, now);
    if (severity === null) return null;

    const event: NotificationEvent = {
      id: crypto.randomUUID(),
      type: input.type,
      severity,
      message: input.message,
      hostId: input.hostId ?? null,
      folderId: input.folderId ?? null,
      payload: input.payload ?? null,
      createdAt: now,
      ntfyDelivered: false,
      webhookDelivered: false,
    };
    const database = activeDb;
    database.run(
      `INSERT INTO notification_events
         (id, type, severity, message, host_id, folder_id, payload, created_at,
          ntfy_delivered, webhook_delivered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      [
        event.id,
        event.type,
        event.severity,
        event.message,
        event.hostId ?? null,
        event.folderId ?? null,
        event.payload === null ? null : JSON.stringify(event.payload),
        event.createdAt,
      ],
    );
    scheduleDeliveries(event, database);
    return event;
  } catch (error) {
    console.error(
      `[notifications] failed to emit ${input.type}: ${errorMessage(error)}`,
    );
    return null;
  }
}

/** True when an event was recorded; false when suppressed or persistence failed. */
export function emitNotification(input: NotificationInput): boolean {
  return emitNotificationEvent(input) !== null;
}

function hostStatus(value: string | null): HostStatus {
  switch (value) {
    case "online":
    case "offline":
    case "degraded":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function rowToHost(row: HostRow, latestVersion: string | null): Host {
  const version = row.version;
  const updateAvailable =
    typeof version === "string" && version.length > 0 && latestVersion !== null
      ? isNewer(version, latestVersion)
      : false;
  return {
    id: row.id,
    hostname: row.hostname,
    tailnetIp: row.tailnet_ip,
    lanIp: row.lan_ip,
    lastSeen: row.last_seen,
    status: hostStatus(row.status),
    version,
    updateAvailable,
    configRevision: row.config_revision ?? 0,
  };
}

function shouldEmitUpdateAvailable(hostId: string, available: boolean): boolean {
  const key = stateKey("update_available", hostId, null);
  const state = notificationState.get(key) ?? {};
  if (!available) {
    state.edge = "unavailable";
    notificationState.set(key, state);
    return false;
  }
  return state.edge !== "available";
}

/** Execute one staleness/update-availability pass. Exported for deterministic tests. */
export async function runNotificationSweep(now = Date.now()): Promise<void> {
  try {
    const cutoff = now - HOST_STALE_AFTER_MS;
    const staleRows = activeDb
      .query<HostRow, [number]>(
        `${HOST_SELECT}
         WHERE last_seen IS NOT NULL
           AND (status IS NULL OR status != 'offline')
           AND last_seen < ?`,
      )
      .all(cutoff);

    let latestVersion: string | null = null;
    try {
      latestVersion = await getCachedLatestVersion();
    } catch (error) {
      console.error(
        `[notifications] release lookup during sweep failed: ${errorMessage(error)}`,
      );
    }

    for (const stale of staleRows) {
      const result = activeDb.run(
        `UPDATE hosts SET status = 'offline'
         WHERE id = ?
           AND last_seen IS NOT NULL
           AND (status IS NULL OR status != 'offline')
           AND last_seen < ?`,
        [stale.id, cutoff],
      );
      if (result.changes === 0) continue;

      const row = activeDb
        .query<HostRow, [string]>(`${HOST_SELECT} WHERE id = ?`)
        .get(stale.id);
      if (!row) continue;
      const host = rowToHost(row, latestVersion);
      broadcast({ kind: "host", host });
      emitNotification({
        type: "host_offline",
        hostId: row.id,
        message: `Host ${row.hostname} is offline`,
        payload: { lastSeen: row.last_seen },
      });
    }

    const hosts = activeDb.query<HostRow, []>(HOST_SELECT).all();
    for (const row of hosts) {
      const host = rowToHost(row, latestVersion);
      const available =
        row.version !== null &&
        row.version.length > 0 &&
        host.updateAvailable === true;
      if (!shouldEmitUpdateAvailable(row.id, available)) continue;
      emitNotification({
        type: "update_available",
        hostId: row.id,
        message: `Update available for ${row.hostname}`,
        payload: { currentVersion: row.version, latestVersion },
      });
    }
  } catch (error) {
    console.error(`[notifications] sweep failed: ${errorMessage(error)}`);
  }
}

/** Start an immediate pass followed by one pass every 60 seconds. */
export function startNotificationSweep(): ReturnType<typeof setInterval> {
  void runNotificationSweep();
  const timer = setInterval(() => {
    void runNotificationSweep();
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
