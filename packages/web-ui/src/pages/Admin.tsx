import { useEffect, useState } from "react";
import type { NotificationEvent, NotificationSeverity } from "@lamasync/core";
import { api } from "../api.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

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

  useEffect(() => {
    void refreshNotifications();
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
