import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Host } from "@lamasync/core";
import { api } from "../api.ts";
import { AddHostGuide } from "../components/AddHostGuide.tsx";
import { EditableHostname } from "../components/EditableHostname.tsx";
import { useWebSocket } from "../hooks/useWebSocket.ts";

function formatTimestamp(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : "—";
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

export function Hosts() {
  const [items, setItems] = useState<Host[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  // LAMA-225: transient banner on host.renamed WebSocket events.
  const [renamedBanner, setRenamedBanner] = useState<string | null>(null);
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

  useEffect(() => {
    if (event && event.kind === "host_renamed") {
      setRenamedBanner(`host renamed: ${event.oldId} → ${event.hostname}`);
      void refresh();
    }
  }, [event, refresh]);

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Hosts</h1>
        <span className="muted">{items ? `${items.length} registered` : "loading…"}</span>
        <button
          type="button"
          className="action primary"
          onClick={() => setShowGuide((s) => !s)}
        >
          {showGuide ? "Hide guide" : "Add host"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
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

      {(showGuide || (items !== null && items.length === 0)) && <AddHostGuide />}

      {!items ? (
        <div className="empty-row">Loading…</div>
      ) : items.length === 0 ? (
        <div className="empty-row">No hosts registered yet</div>
      ) : (
        <div className="host-list">
          {items.map((h) => (
            <Link className="host-card" key={h.id} to={`/hosts/${encodeURIComponent(h.id)}`}>
              <div className="host-card-head">
                <EditableHostname host={h} onRenamed={() => void refresh()} />
                <span className={`badge badge-${h.status}`}>{h.status}</span>
              </div>
              <div className="host-card-meta">
                <span className="muted">ID {h.id}</span>
                <span className="tailnet-ip">
                  {h.tailnetIp ? <code>{h.tailnetIp}</code> : <span className="muted">tailnet —</span>}
                  {h.tailnetIp ? <CopyButton value={h.tailnetIp} label="tailnet IP" /> : null}
                </span>
                {h.lanIp ? <code>lan {h.lanIp}</code> : null}
              </div>
              <div className="host-card-meta">
                <span className="muted">Last seen {formatTimestamp(h.lastSeen)}</span>
                <span>
                  v{h.version ?? "—"}
                  {h.updateAvailable ? (
                    <span className="badge badge-update">update</span>
                  ) : null}
                </span>
                <span className="muted">
                  rev <code>{h.configRevision ?? 0}</code>
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
