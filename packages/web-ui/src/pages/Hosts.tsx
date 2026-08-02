import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Host } from "@lamasync/core";
import { api } from "../api.ts";
import { AddHostGuide } from "../components/AddHostGuide.tsx";

function formatTimestamp(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

export function Hosts() {
  const [items, setItems] = useState<Host[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);

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
                <strong>{h.hostname}</strong>
                <span className={`badge badge-${h.status}`}>{h.status}</span>
              </div>
              <div className="host-card-meta">
                <span className="muted">ID {h.id}</span>
                {h.tailnetIp ? <code>{h.tailnetIp}</code> : null}
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