import { useEffect, useState } from "react";
import type { Conflict } from "@lamasync/core";
import { api } from "../api.ts";

type Resolution = "local" | "remote" | "both";

function formatTs(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

export function Conflicts() {
  const [items, setItems] = useState<Conflict[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const list = await api.listConflicts("pending");
      setItems(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

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

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Pending Conflicts</h1>
        <button type="button" className="action" onClick={refresh}>
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
            <th />
          </tr>
        </thead>
        <tbody>
          {!items ? (
            <tr className="empty-row">
              <td colSpan={6}>Loading…</td>
            </tr>
          ) : items.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={6}>No pending conflicts</td>
            </tr>
          ) : (
            items.map((c) => (
              <tr key={c.id}>
                <td>{c.path}</td>
                <td className="muted">{c.hostId}</td>
                <td className="muted">{c.folderId}</td>
                <td className="muted">{formatTs(c.localMtime)}</td>
                <td className="muted">{formatTs(c.remoteMtime)}</td>
                <td className="table-actions table-actions-nowrap">
                  <button
                    type="button"
                    className="action"
                    disabled={busy === c.id}
                    onClick={() => onResolve(c.id, "local")}
                  >
                    Local
                  </button>
                  {" "}
                  <button
                    type="button"
                    className="action"
                    disabled={busy === c.id}
                    onClick={() => onResolve(c.id, "remote")}
                  >
                    Remote
                  </button>
                  {" "}
                  <button
                    type="button"
                    className="action"
                    disabled={busy === c.id}
                    onClick={() => onResolve(c.id, "both")}
                  >
                    Both
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
