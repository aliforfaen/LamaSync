import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "../components/PageHeader.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Link } from "react-router-dom";
import type { Host, OperationLog } from "@lamasync/core";
import { api } from "../api.ts";
import { AddHostGuide } from "../components/AddHostGuide.tsx";
import { EditableHostname } from "../components/EditableHostname.tsx";
import { ConfirmDialog } from "../components/Modal.tsx";
import { InlineError } from "../components/InlineError.tsx";
import { useWebSocket } from "../hooks/useWebSocket.ts";
import { formatTimeAgo } from "../relative-time.ts";
import { formatBytes } from "../format-bytes.ts";

// LAMA-272: device cards, not a host table. The page renders the same
// `GET /api/v1/health` payload as a responsive card grid — CSS device glyph,
// hostname, status dot + explicit text (never color alone), a derived
// "last backup …ago" line, and a click-through to the existing HostDetail
// page. No new endpoints or wire fields were added.

/** Friendly status labels — the dot carries the color, the text carries the
 * meaning (accessibility: never signal status by color alone). */
const STATUS_LABELS: Record<Host["status"], string> = {
  online: "Online",
  offline: "Offline",
  degraded: "Degraded",
  unknown: "Unknown",
};

/**
 * LAMA-272: "last backup" comes from the per-host operations feed — there
 * is no dedicated stats endpoint (the issue says note it instead). Backup-
 * class operations are `backup` (folder type backup) and `dotfile` (app
 * settings backups per docs/terminology.md); `dotfile-restore` is a restore
 * and does not count. The feed is newest-first, so a successful run wins,
 * then any finished run; when nothing matches the card omits the line.
 */
function lastBackupFrom(ops: OperationLog[]): OperationLog | null {
  const backups = ops.filter(
    (op) => op.operation === "backup" || op.operation === "dotfile",
  );
  return (
    backups.find((op) => op.status === "success") ??
    backups.find((op) => op.status !== "started") ??
    null
  );
}

/** Best-effort clipboard copy with an execCommand fallback. Resolves to
 * false when neither path is available. */
async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-btn"
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      onClick={(e) => {
        // The card is a Link; copying must not trigger navigation.
        e.preventDefault();
        e.stopPropagation();
        void copyText(value).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}

interface DeviceCardProps {
  host: Host;
  /** Newest backup-class operation for this device, or null (line omitted). */
  lastBackup: OperationLog | null;
  deleting: boolean;
  onDelete: (h: Host) => void;
  onRenamed: () => void;
}

/**
 * LAMA-272: one fleet device. The whole card is a Link (router push, deep-
 * link safe) so it opens the existing HostDetail page. Interactive children
 * (rename, copy, remove) preventDefault + stopPropagation so they never
 * trigger navigation.
 */
function DeviceCard({ host, lastBackup, deleting, onDelete, onRenamed }: DeviceCardProps) {
  return (
    <Link className="host-card" to={`/hosts/${encodeURIComponent(host.id)}`}>
      <div className="host-card-head">
        <span className="device-card-glyph" aria-hidden="true" />
        <div className="host-card-title">
          <EditableHostname host={host} onRenamed={onRenamed} />
          <span className={`host-status host-status--${host.status}`}>
            <span className="host-status-dot" aria-hidden="true" />
            {STATUS_LABELS[host.status]}
          </span>
        </div>
        <button
          type="button"
          className="action danger host-delete-btn"
          aria-label={`Remove device ${host.hostname}`}
          title="Remove device (removes its folder setups, app settings, history)"
          onClick={(e) => {
            // The card is a Link; removing must not navigate.
            e.preventDefault();
            e.stopPropagation();
            onDelete(host);
          }}
          disabled={deleting}
        >
          {deleting ? "…" : "Remove"}
        </button>
      </div>
      {lastBackup ? (
        <div className="host-card-last-backup">
          <span className="host-card-label">Last backup</span>
          <span>{formatTimeAgo(lastBackup.timestamp)}</span>
        </div>
      ) : null}
      <div className="host-card-meta">
        <span className="tailnet-ip">
          {host.tailnetIp ? (
            <>
              <code>{host.tailnetIp}</code>
              <CopyButton value={host.tailnetIp} label="tailnet IP" />
            </>
          ) : (
            <span className="muted">tailnet —</span>
          )}
        </span>
        {host.status !== "online" ? (
          <span className="muted">Last seen {formatTimeAgo(host.lastSeen)}</span>
        ) : null}
        <span>
          v{host.version ?? "—"}
          {host.updateAvailable ? (
            <span className="badge badge-update">update</span>
          ) : null}
        </span>
        {host.os ? (
          <span title="Operating system">{host.os}</span>
        ) : null}
        {host.storageUsedBytes != null ? (
          <span title="Storage used on this device">
            {formatBytes(host.storageUsedBytes)} used
          </span>
        ) : null}
      </div>
    </Link>
  );
}

export function Hosts() {
  const [items, setItems] = useState<Host[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  // LAMA-225: transient banner on host.renamed WebSocket events.
  const [renamedBanner, setRenamedBanner] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deletingHost, setDeletingHost] = useState<Host | null>(null);
  // LAMA-272: per-device "last backup" derived from each host's operations
  // feed. A null entry (fetch failed or no backup ever) omits the line.
  const [lastBackups, setLastBackups] = useState<ReadonlyMap<string, OperationLog | null>>(
    new Map(),
  );
  // LAMA-271: the empty-state CTA scrolls to the existing AddHostGuide flow.
  const guideRef = useRef<HTMLDivElement | null>(null);
  const { event } = useWebSocket();

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setItems(await api.listHosts());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .listHosts()
      .then((list) => {
        if (cancelled) return;
        setItems(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // LAMA-272: derive "last backup" per device from the operations feed
  // (same data source HostDetail uses). Runs whenever the fleet list
  // changes; per-device failures are swallowed so the card omits the line
  // gracefully instead of blocking the grid.
  useEffect(() => {
    if (!items || items.length === 0) {
      setLastBackups(new Map());
      return;
    }
    let cancelled = false;
    void Promise.all(
      items.map(async (h) => {
        try {
          const ops = await api.listOperationsForHost(h.id, 50);
          return { hostId: h.id, last: lastBackupFrom(ops) };
        } catch {
          return { hostId: h.id, last: null };
        }
      }),
    ).then((rows) => {
      if (cancelled) return;
      setLastBackups(new Map(rows.map((r) => [r.hostId, r.last])));
    });
    return () => {
      cancelled = true;
    };
  }, [items]);

  useEffect(() => {
    if (event && event.kind === "host_renamed") {
      setRenamedBanner(`device renamed: ${event.oldId} → ${event.hostname}`);
      void refresh();
    }
  }, [event, refresh]);

  // LAMA-198: decommission a host. The server cascades assignments,
  // dotfile manifests, and history — the daemon on that machine will just
  // re-register unless it's stopped/uninstalled first.
  async function onDelete(h: Host): Promise<void> {
    setDeletingHost(h);
  }

  async function confirmDeleteHost(): Promise<void> {
    if (!deletingHost) return;
    const h = deletingHost;
    setDeletingHost(null);
    setDeletingId(h.id);
    setError(null);
    try {
      await api.deleteHost(h.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="page">
      <PageHeader title="Devices" purpose="The machines running LamaSync — register new ones, check status, and manage each device." />
<div className="toolbar">
        <span className="muted">{items ? `${items.length} registered` : "loading…"}</span>
        <button
          type="button"
          className="action primary"
          onClick={() => setShowGuide((s) => !s)}
        >
          {showGuide ? "Hide guide" : "Add device"}
        </button>
      </div>
      {error && (
        <InlineError
          message={`Couldn't load devices — ${error}`}
          onRetry={() => void refresh()}
        />
      )}
      {renamedBanner ? (
        <div className="banner">
          <span>{renamedBanner}</span>
          <button
            type="button"
            className="banner-close"
            aria-label="Dismiss"
            onClick={() => setRenamedBanner(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      <div ref={guideRef}>
        {(showGuide || (items !== null && items.length === 0)) && <AddHostGuide />}
      </div>

      {!items ? (
        <div className="host-list" aria-busy="true">
          <div className="skel skel-card" />
          <div className="skel skel-card" />
          <div className="skel skel-card" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          variant="devices"
          title="Pair your first device"
          how="Run one command on another machine and it registers with this server automatically."
          ctaLabel="Open the setup guide"
          onCta={() => {
            guideRef.current?.scrollIntoView({ block: "start" });
          }}
          steps={[
            "Install the service on the new machine",
            "Point it at this server with your API key",
            "It appears here within a minute",
          ]}
          timeNote="takes 30s"
        />
      ) : (
        <div className="host-list">
          {items.map((h) => (
            <DeviceCard
              key={h.id}
              host={h}
              lastBackup={lastBackups.get(h.id) ?? null}
              deleting={deletingId === h.id}
              onDelete={(host) => void onDelete(host)}
              onRenamed={() => void refresh()}
            />
          ))}
        </div>
      )}

      {deletingHost && (
        <ConfirmDialog
          title="Remove device"
          danger
          confirmLabel="Delete"
          message={
            <>
              Remove device “{deletingHost.hostname}” ({deletingHost.id})?
              <br />
              <br />
              This removes its folder setups, app settings backups, and
              history. Stop/uninstall the LamaSync service on that machine
              too, or it will re-register.
            </>
          }
          onConfirm={() => void confirmDeleteHost()}
          onCancel={() => setDeletingHost(null)}
        />
      )}
    </div>
  );
}