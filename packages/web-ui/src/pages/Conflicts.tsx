import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader.tsx";
import { Link } from "react-router-dom";
import type { Conflict, Folder, Host } from "@lamasync/core";
import { api } from "../api.ts";
import { ConfirmDialog } from "../components/Modal.tsx";
import { formatBytes } from "../format-bytes.ts";

type Resolution = "local" | "remote" | "both";

type ConflictTab = "pending" | "resolved" | "all";

const TABS: { value: ConflictTab; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
];

function formatTs(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

/** Text hint for which side is newer — never signalled by colour alone. */
function newerSide(c: Conflict): string | null {
  if (c.localMtime == null || c.remoteMtime == null || c.localMtime === c.remoteMtime) {
    return null;
  }
  return c.localMtime > c.remoteMtime
    ? "Newer on this device"
    : "Newer on destination";
}

interface ConflictCardProps {
  c: Conflict;
  hostName: (id: string) => string;
  folderName: (id: string) => string;
  busy: string | null;
  onResolve: (id: string, resolution: Resolution) => void;
}

function ConflictCard({ c, hostName, folderName, busy, onResolve }: ConflictCardProps) {
  const resolved = c.status === "resolved";
  const winnerLabel =
    c.resolution === "local"
      ? "Kept local"
      : c.resolution === "remote"
        ? "Kept remote"
        : c.resolution === "both"
          ? "Kept both"
          : null;
  const newer = newerSide(c);

  return (
    <article className={`conflict-card${resolved ? " conflict-card--resolved" : ""}`}>
      <header className="conflict-card-head">
        <div className="conflict-card-title">
          <strong className="conflict-path">{c.path}</strong>
          <span className="muted conflict-meta">
            <Link to={`/hosts/${encodeURIComponent(c.hostId)}`}>{hostName(c.hostId)}</Link>
            {" · "}
            <Link to="/folders">{folderName(c.folderId)}</Link>
          </span>
        </div>
        <span className={`badge badge-${resolved ? "ok" : "failed"}`}>{c.status}</span>
      </header>

      <div className="conflict-sides">
        <div className="conflict-side">
          <h4>
            This device
            {resolved && c.resolution === "local" ? (
              <span className="conflict-kept">kept</span>
            ) : null}
          </h4>
          <dl className="conflict-dl">
            <dt>Size</dt>
            <dd>{formatBytes(c.localSizeBytes)}</dd>
            <dt>Modified</dt>
            <dd className="mono">{formatTs(c.localMtime)}</dd>
          </dl>
          {!resolved && newer === "Newer on this device" ? (
            <span className="conflict-note">{newer}</span>
          ) : null}
        </div>

        <div className="conflict-side">
          <h4>
            Destination
            {resolved && c.resolution === "remote" ? (
              <span className="conflict-kept">kept</span>
            ) : null}
          </h4>
          <dl className="conflict-dl">
            <dt>Size</dt>
            <dd>{formatBytes(c.remoteSizeBytes)}</dd>
            <dt>Modified</dt>
            <dd className="mono">{formatTs(c.remoteMtime)}</dd>
          </dl>
          {!resolved && newer === "Newer on destination" ? (
            <span className="conflict-note">{newer}</span>
          ) : null}
        </div>
      </div>

      <footer className="conflict-card-foot">
        {resolved ? (
          <span className="muted">
            {winnerLabel ?? "Resolved"} · {formatTs(c.resolvedAt)}
          </span>
        ) : (
          <>
            <span className="muted conflict-pending-note">Both sides changed — choose what to keep.</span>
            <div className="conflict-actions">
              <button
                type="button"
                className="action"
                disabled={busy === c.id}
                onClick={() => onResolve(c.id, "local")}
              >
                Keep local
              </button>
              <button
                type="button"
                className="action"
                disabled={busy === c.id}
                onClick={() => onResolve(c.id, "remote")}
              >
                Keep remote
              </button>
              <button
                type="button"
                className="action"
                disabled={busy === c.id}
                onClick={() => onResolve(c.id, "both")}
              >
                Keep both
              </button>
            </div>
          </>
        )}
      </footer>
    </article>
  );
}

export function Conflicts() {
  const [items, setItems] = useState<Conflict[] | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tab, setTab] = useState<ConflictTab>("pending");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; resolution: Resolution; message: string } | null>(null);

  async function refresh() {
    setError(null);
    try {
      const [list, hostList, folderList] = await Promise.all([
        api.listConflicts(tab === "all" ? "" : tab),
        api.listHosts().catch(() => [] as Host[]),
        api.listFolders().catch(() => [] as Folder[]),
      ]);
      setItems(list);
      setHosts(hostList);
      setFolders(folderList);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  function requestResolve(id: string, resolution: Resolution) {
    const message =
      resolution === "local"
        ? "Keep the version on this device?"
        : resolution === "remote"
          ? "Keep the version on the destination?"
          : "Keep both versions?";
    setPending({ id, resolution, message });
  }

  async function onResolve(id: string, resolution: Resolution) {
    setBusy(id);
    setError(null);
    try {
      await api.resolveConflict(id, resolution);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function hostName(hostId: string): string {
    return hosts.find((h) => h.id === hostId)?.hostname ?? hostId;
  }

  function folderName(folderId: string): string {
    return folders.find((f) => f.id === folderId)?.name ?? folderId;
  }

  return (
    <div className="page">
      <PageHeader title="Conflicts" purpose="When both sides changed, decide what to keep." />
      <div className="toolbar">
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={tab === t.value}
              className={`tab${tab === t.value ? " tab-active" : ""}`}
              onClick={() => setTab(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button type="button" className="action" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      {!items ? (
        <div className="skel skel-line" aria-busy="true" />
      ) : items.length === 0 ? (
        <div className="empty-row">
          {tab === "pending"
            ? "No pending conflicts — they appear when both sides changed the same file under the manual strategy."
            : tab === "resolved"
              ? "No resolved conflicts"
              : "No conflicts recorded"}
        </div>
      ) : (
        <div className="conflict-grid">
          {items.map((c) => (
            <ConflictCard
              key={c.id}
              c={c}
              hostName={hostName}
              folderName={folderName}
              busy={busy}
              onResolve={(id, resolution) => requestResolve(id, resolution)}
            />
          ))}
        </div>
      )}

      {pending && (
        <ConfirmDialog
          title="Resolve conflict"
          message={pending.message}
          onConfirm={() => {
            const p = pending;
            setPending(null);
            void onResolve(p.id, p.resolution);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
