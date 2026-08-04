import { useEffect, useState } from "react";
import type { OperationLog, OperationStatus } from "@lamasync/core";
import { api } from "../api.ts";

const PAGE_SIZE = 50;

const STATUS_FILTERS: { label: string; value: OperationStatus | "" }[] = [
  { label: "All", value: "" },
  { label: "Started", value: "started" },
  { label: "Success", value: "success" },
  { label: "Failed", value: "failed" },
  { label: "Conflict", value: "conflict" },
  { label: "Recovery", value: "recovery" },
  { label: "Retry", value: "retry" },
];

function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

export function Operations() {
  const [items, setItems] = useState<OperationLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<OperationStatus | "">("");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load(nextOffset: number, nextStatus: OperationStatus | ""): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Ask for one extra row to know whether a next page exists; the
      // server caps limit at 500, so PAGE_SIZE stays well within bounds.
      const rows = await api.listOperations({
        limit: PAGE_SIZE + 1,
        offset: nextOffset,
        status: nextStatus || undefined,
      });
      setItems(rows.slice(0, PAGE_SIZE));
      setHasMore(rows.length > PAGE_SIZE);
      setOffset(nextOffset);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load(0, "");
  }, []);

  function onStatusChange(e: React.ChangeEvent<HTMLSelectElement>): void {
    const value = e.target.value as OperationStatus | "";
    setStatus(value);
    void load(0, value);
  }

  function nextPage(): void {
    void load(offset + PAGE_SIZE, status);
  }

  function prevPage(): void {
    void load(Math.max(0, offset - PAGE_SIZE), status);
  }

  const pageStart = items ? offset + 1 : 0;
  const pageEnd = items ? offset + items.length : 0;

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Operations</h1>
        <label className="scope-filter">
          Status
          <select value={status} onChange={onStatusChange}>
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="action" onClick={() => void load(offset, status)} disabled={busy}>
          Refresh
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <table className="data">
        <thead>
          <tr>
            <th>Time</th>
            <th>Host</th>
            <th>Operation</th>
            <th>Status</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {!items ? (
            <tr className="empty-row">
              <td colSpan={5}>Loading…</td>
            </tr>
          ) : items.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={5}>
                {status ? `No ${status} operations` : "No operations recorded"}
              </td>
            </tr>
          ) : (
            items.map((op) => (
              <tr key={String(op.id)}>
                <td>{formatTimestamp(op.timestamp)}</td>
                <td className="muted">{op.hostId}</td>
                <td>{op.operation}</td>
                <td>
                  <span className={`badge badge-${op.status}`}>{op.status}</span>
                </td>
                <td className="muted">{op.summary ?? "—"}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div className="pagination">
        <span className="muted">
          {items && items.length > 0 ? `${pageStart}–${pageEnd}` : "0"}
        </span>
        <button
          type="button"
          className="action"
          onClick={prevPage}
          disabled={busy || offset === 0}
        >
          ‹ Prev
        </button>
        <button
          type="button"
          className="action"
          onClick={nextPage}
          disabled={busy || !hasMore}
        >
          Next ›
        </button>
      </div>
    </div>
  );
}
