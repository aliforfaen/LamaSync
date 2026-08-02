import { useEffect, useState } from "react";
import type {
  NotificationChannel,
  NotificationEvent,
  NotificationSeverity,
} from "@lamasync/core";
import { api } from "../api.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVERITY_LEVELS: NotificationSeverity[] = ["critical", "default", "info"];

function severityBadgeClass(severity: NotificationSeverity): string {
  switch (severity) {
    case "critical":
      return "badge-failed";
    case "default":
      return "badge-conflict";
    case "info":
      return "badge-started";
  }
}

function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.length > 1
      ? `${parsed.protocol}//${parsed.host}…`
      : `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "•".repeat(Math.min(url.length, 12));
  }
}

interface ChannelTestResult {
  channelId: string;
  delivered: boolean;
}

export function Admin() {
  const [days, setDays] = useState("30");
  const [pruneResult, setPruneResult] = useState<string | null>(null);
  const [pruneError, setPruneError] = useState<string | null>(null);
  const [pruneBusy, setPruneBusy] = useState(false);
  const [notifications, setNotifications] = useState<NotificationEvent[]>([]);
  const [notificationsLoading, setNotificationsLoading] = useState(true);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationResult, setNotificationResult] =
    useState<NotificationEvent | null>(null);
  const [notificationError, setNotificationError] = useState<string | null>(null);

  // LAMA-221: channel configuration state.
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [testBusyId, setTestBusyId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ChannelTestResult | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addKind, setAddKind] = useState<"ntfy" | "webhook">("ntfy");
  const [addName, setAddName] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [addSeverities, setAddSeverities] = useState<NotificationSeverity[]>([
    "critical",
    "default",
    "info",
  ]);
  const [addBusy, setAddBusy] = useState(false);

  async function refreshNotifications(): Promise<void> {
    setNotificationsLoading(true);
    try {
      setNotifications(await api.listNotifications(20));
    } catch (err) {
      setNotificationError(err instanceof Error ? err.message : String(err));
    } finally {
      setNotificationsLoading(false);
    }
  }

  async function refreshChannels(): Promise<void> {
    setChannelsLoading(true);
    try {
      setChannels(await api.listNotificationChannels());
      setChannelsError(null);
    } catch (err) {
      setChannelsError(err instanceof Error ? err.message : String(err));
    } finally {
      setChannelsLoading(false);
    }
  }

  useEffect(() => {
    void refreshNotifications();
    void refreshChannels();
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPruneBusy(true);
    setPruneError(null);
    setPruneResult(null);
    try {
      const parsed = Number.parseInt(days, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error("days must be a non-negative integer");
      }
      const res = await api.pruneOperations(parsed * DAY_MS);
      setPruneResult(
        `Deleted ${res.deleted} operation_log entries older than ${days} day(s)`,
      );
    } catch (err) {
      setPruneError(err instanceof Error ? err.message : String(err));
    } finally {
      setPruneBusy(false);
    }
  }

  async function onTestNotification(): Promise<void> {
    setNotificationBusy(true);
    setNotificationError(null);
    setNotificationResult(null);
    try {
      const event = await api.sendTestNotification();
      setNotificationResult(event);
      setNotifications((current) => [event, ...current].slice(0, 20));
    } catch (err) {
      setNotificationError(err instanceof Error ? err.message : String(err));
    } finally {
      setNotificationBusy(false);
    }
  }

  // ---- LAMA-221 channel handlers ----

  function toggleReveal(channelId: string): void {
    setRevealedIds((current) => {
      const next = new Set(current);
      if (next.has(channelId)) {
        next.delete(channelId);
      } else {
        next.add(channelId);
      }
      return next;
    });
  }

  function startEdit(channel: NotificationChannel): void {
    setEditingId(channel.id);
    setEditName(channel.name);
    setEditUrl(channel.url);
    setEditError(null);
  }

  async function onSaveEdit(channelId: string): Promise<void> {
    setEditError(null);
    try {
      if (editName.trim().length === 0) throw new Error("name must not be empty");
      if (editUrl.trim().length === 0) throw new Error("url must not be empty");
      const updated = await api.updateNotificationChannel(channelId, {
        name: editName.trim(),
        url: editUrl.trim(),
      });
      setChannels((current) =>
        current.map((channel) => (channel.id === updated.id ? updated : channel)),
      );
      setEditingId(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onToggleSeverity(
    channel: NotificationChannel,
    level: NotificationSeverity,
  ): Promise<void> {
    const next = channel.severities.includes(level)
      ? channel.severities.filter((s) => s !== level)
      : [...channel.severities, level];
    if (next.length === 0) return;
    try {
      const updated = await api.updateNotificationChannel(channel.id, {
        severities: next,
      });
      setChannels((current) =>
        current.map((c) => (c.id === updated.id ? updated : c)),
      );
    } catch (err) {
      setChannelsError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onToggleEnabled(channel: NotificationChannel): Promise<void> {
    try {
      const updated = await api.updateNotificationChannel(channel.id, {
        enabled: !channel.enabled,
      });
      setChannels((current) =>
        current.map((c) => (c.id === updated.id ? updated : c)),
      );
    } catch (err) {
      setChannelsError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onTestChannel(channelId: string): Promise<void> {
    setTestBusyId(channelId);
    setTestResult(null);
    try {
      const result = await api.testNotificationChannel(channelId);
      setTestResult({ channelId: result.channelId, delivered: result.delivered });
    } catch (err) {
      setChannelsError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestBusyId(null);
    }
  }

  async function onDeleteChannel(channel: NotificationChannel): Promise<void> {
    if (!window.confirm(`Delete channel "${channel.name}"?`)) return;
    try {
      await api.deleteNotificationChannel(channel.id);
      setChannels((current) => current.filter((c) => c.id !== channel.id));
    } catch (err) {
      setChannelsError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleAddSeverity(level: NotificationSeverity): void {
    setAddSeverities((current) =>
      current.includes(level)
        ? current.filter((s) => s !== level)
        : [...current, level],
    );
  }

  async function onAddChannel(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setAddBusy(true);
    setChannelsError(null);
    try {
      if (addName.trim().length === 0) throw new Error("name must not be empty");
      if (addUrl.trim().length === 0) throw new Error("url must not be empty");
      if (addSeverities.length === 0) {
        throw new Error("select at least one severity");
      }
      const created = await api.createNotificationChannel({
        kind: addKind,
        name: addName.trim(),
        url: addUrl.trim(),
        severities: addSeverities,
      });
      setChannels((current) => [...current, created]);
      setShowAddForm(false);
      setAddName("");
      setAddUrl("");
      setAddSeverities(["critical", "default", "info"]);
    } catch (err) {
      setChannelsError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Admin</h1>
      </div>

      <section className="section">
        <h2>Operation log retention</h2>
        <form className="form" onSubmit={onSubmit}>
          <label>
            Days to keep (older entries will be deleted)
            <input
              type="number"
              min="0"
              required
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </label>
          <div className="actions">
            <button
              type="submit"
              className="action primary"
              disabled={pruneBusy}
            >
              {pruneBusy ? "Pruning…" : "Prune"}
            </button>
          </div>
          {pruneResult && <div className="muted">{pruneResult}</div>}
          {pruneError && <div className="error">{pruneError}</div>}
        </form>
      </section>

      <section className="section">
        <div className="toolbar">
          <h2>Channels</h2>
          <button
            type="button"
            className="action"
            onClick={() => setShowAddForm((visible) => !visible)}
          >
            {showAddForm ? "Cancel" : "Add channel"}
          </button>
        </div>
        {channelsError && <div className="error">{channelsError}</div>}
        {testResult && (
          <div className={testResult.delivered ? "muted" : "error"}>
            Test {testResult.delivered ? "delivered" : "failed"} — last delivery
            status updated.
          </div>
        )}
        {showAddForm && (
          <form className="form" onSubmit={(e) => void onAddChannel(e)}>
            <label>
              Kind
              <select
                value={addKind}
                onChange={(e) =>
                  setAddKind(e.target.value === "webhook" ? "webhook" : "ntfy")
                }
              >
                <option value="ntfy">ntfy</option>
                <option value="webhook">Webhook</option>
              </select>
            </label>
            <label>
              Name
              <input
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="e.g. ntfy-alerts"
              />
            </label>
            <label>
              URL
              <input
                value={addUrl}
                onChange={(e) => setAddUrl(e.target.value)}
                placeholder="https://ntfy.sh/lamasync-alerts"
              />
            </label>
            <div>
              <span className="muted">Deliver for severities:</span>{" "}
              {SEVERITY_LEVELS.map((level) => (
                <label key={level}>
                  <input
                    type="checkbox"
                    checked={addSeverities.includes(level)}
                    onChange={() => toggleAddSeverity(level)}
                  />
                  {level}
                </label>
              ))}
            </div>
            <div className="actions">
              <button
                type="submit"
                className="action primary"
                disabled={addBusy}
              >
                {addBusy ? "Saving…" : "Save channel"}
              </button>
            </div>
          </form>
        )}
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>URL</th>
              <th>Severities</th>
              <th>Enabled</th>
              <th>Last delivery</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {channelsLoading && channels.length === 0 ? (
              <tr className="empty-row">
                <td colSpan={7}>Loading channels…</td>
              </tr>
            ) : channels.length === 0 ? (
              <tr className="empty-row">
                <td colSpan={7}>
                  No channels configured. Add one to receive notifications.
                </td>
              </tr>
            ) : (
              channels.map((channel) => (
                <tr key={channel.id}>
                  <td>
                    {editingId === channel.id ? (
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                      />
                    ) : (
                      channel.name
                    )}
                  </td>
                  <td>
                    <span className="badge badge-started">{channel.kind}</span>
                  </td>
                  <td>
                    {editingId === channel.id ? (
                      <input
                        value={editUrl}
                        onChange={(e) => setEditUrl(e.target.value)}
                      />
                    ) : (
                      <span className="muted">
                        {revealedIds.has(channel.id)
                          ? channel.url
                          : maskUrl(channel.url)}
                      </span>
                    )}
                    {editingId !== channel.id && (
                      <button
                        type="button"
                        className="action"
                        onClick={() => toggleReveal(channel.id)}
                      >
                        {revealedIds.has(channel.id) ? "Hide" : "Show"}
                      </button>
                    )}
                  </td>
                  <td>
                    {editingId === channel.id ? null : (
                      SEVERITY_LEVELS.map((level) => (
                        <label key={level}>
                          <input
                            type="checkbox"
                            checked={channel.severities.includes(level)}
                            onChange={() =>
                              void onToggleSeverity(channel, level)
                            }
                          />
                          {level}
                        </label>
                      ))
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="action"
                      onClick={() => void onToggleEnabled(channel)}
                    >
                      {channel.enabled ? "On" : "Off"}
                    </button>
                  </td>
                  <td className="muted">
                    {channel.lastDeliveryStatus ? (
                      <span
                        className={`badge ${
                          channel.lastDeliveryStatus === "success"
                            ? "badge-success"
                            : "badge-failed"
                        }`}
                      >
                        {channel.lastDeliveryStatus}
                      </span>
                    ) : (
                      "—"
                    )}
                    {channel.lastDeliveryAt
                      ? ` ${new Date(channel.lastDeliveryAt).toLocaleString()}`
                      : ""}
                  </td>
                  <td>
                    {editingId === channel.id ? (
                      <>
                        <button
                          type="button"
                          className="action primary"
                          onClick={() => void onSaveEdit(channel.id)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="action"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="action"
                          disabled={testBusyId === channel.id}
                          onClick={() => void onTestChannel(channel.id)}
                        >
                          {testBusyId === channel.id ? "Testing…" : "Test"}
                        </button>
                        <button
                          type="button"
                          className="action"
                          onClick={() => startEdit(channel)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="action"
                          onClick={() => void onDeleteChannel(channel)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {editError && <div className="error">{editError}</div>}
      </section>

      <section className="section">
        <div className="toolbar">
          <h2>Notifications</h2>
          <button
            type="button"
            className="action primary"
            disabled={notificationBusy}
            onClick={() => void onTestNotification()}
          >
            {notificationBusy ? "Sending…" : "Send test notification"}
          </button>
        </div>
        {notificationResult && (
          <div className="muted">
            Recorded {notificationResult.type} at{" "}
            {new Date(notificationResult.createdAt).toLocaleString()}:{" "}
            {notificationResult.message}
          </div>
        )}
        {notificationError && <div className="error">{notificationError}</div>}
        <table className="data">
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Severity</th>
              <th>Message</th>
              <th>Delivery</th>
            </tr>
          </thead>
          <tbody>
            {notificationsLoading && notifications.length === 0 ? (
              <tr className="empty-row">
                <td colSpan={5}>Loading notifications…</td>
              </tr>
            ) : notifications.length === 0 ? (
              <tr className="empty-row">
                <td colSpan={5}>No notifications recorded.</td>
              </tr>
            ) : (
              notifications.map((event) => (
                <tr key={event.id}>
                  <td>{new Date(event.createdAt).toLocaleString()}</td>
                  <td>{event.type}</td>
                  <td>
                    <span className={`badge ${severityBadgeClass(event.severity)}`}>
                      {event.severity}
                    </span>
                  </td>
                  <td>{event.message}</td>
                  <td>
                    <span
                      className={`badge ${
                        event.ntfyDelivered ? "badge-success" : "badge-unknown"
                      }`}
                    >
                      ntfy {event.ntfyDelivered ? "sent" : "not sent"}
                    </span>{" "}
                    <span
                      className={`badge ${
                        event.webhookDelivered ? "badge-success" : "badge-unknown"
                      }`}
                    >
                      webhook {event.webhookDelivered ? "sent" : "not sent"}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
