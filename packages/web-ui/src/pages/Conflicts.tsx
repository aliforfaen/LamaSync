import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Conflict, Folder, Host } from "@lamasync/core";
import { api } from "../api.ts";
import { ConfirmDialog } from "../components/Modal.tsx";

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
        ? "Resolve conflict using the local version?"
        : resolution === "remote"
          ? "Resolve conflict using the remote version?"
          : "Resolve conflict by keeping both versions?";
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
      <div className="toolbar">
        <h1>Conflicts</h1>
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
      <table className="data">
        <thead>
          <tr>
            <th>Path</th>
            <th>Host</th>
            <th>Folder</th>
            <th>Local mtime</th>
            <th>Remote mtime</th>
            <th>Status</th>
            {tab !== "pending" ? <th>Resolution</th> : null}
            <th />
          </tr>
        </thead>
        <tbody>
          {!items ? (
            <tr aria-busy="true">
              <td colSpan={tab !== "pending" ? 8 : 7}><div className="skel skel-line" /></td>
            </tr>
          ) : items.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={tab !== "pending" ? 8 : 7}>
                {tab === "pending"
                  ? "No pending conflicts — they appear when both sides changed the same file under the manual strategy."
                  : tab === "resolved"
                    ? "No resolved conflicts"
                    : "No conflicts recorded"}
              </td>
            </tr>
          ) : (
            items.map((c) => (
              <tr key={c.id}>
                <td>{c.path}</td>
                <td className="muted">
                  <Link to={`/hosts/${encodeURIComponent(c.hostId)}`}>
                    {hostName(c.hostId)}
                  </Link>
                </td>
                <td className="muted">
                  <Link to="/folders">{folderName(c.folderId)}</Link>
                </td>
                <td className="muted">{formatTs(c.localMtime)}</td>
                <td className="muted">{formatTs(c.remoteMtime)}</td>
                <td>
                  <span className={`badge badge-${c.status === "resolved" ? "ok" : "failed"}`}>
                    {c.status}
                  </span>
                </td>
                {tab !== "pending" ? (
                  <td className="muted">
                    {c.status === "resolved" ? (
                      <>
                        {c.resolution ?? "—"}
                        {c.resolvedAt ? ` · ${formatTs(c.resolvedAt)}` : ""}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                ) : null}
                <td className="table-actions table-actions-nowrap">
                  {c.status === "pending" ? (
                    <>
                      <button
                        type="button"
                        className="action"
                        disabled={busy === c.id}
                        onClick={() => requestResolve(c.id, "local")}
                      >
                        Local
                      </button>
                      {" "}
                      <button
                        type="button"
                        className="action"
                        disabled={busy === c.id}
                        onClick={() => requestResolve(c.id, "remote")}
                      >
                        Remote
                      </button>
                      {" "}
                      <button
                        type="button"
                        className="action"
                        disabled={busy === c.id}
                        onClick={() => requestResolve(c.id, "both")}
                      >
                        Both
                      </button>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

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
