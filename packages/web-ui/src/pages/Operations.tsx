import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader.tsx";
import { useSearchParams } from "react-router-dom";
import type { Folder, Host, LockInfo, OperationLog, OperationStatus } from "@lamasync/core";
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
  const [searchParams] = useSearchParams();
  const [items, setItems] = useState<OperationLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<OperationStatus | "">("");
  // LAMA-198: host filter + read-only active-locks panel. UX workstream 4:
  // folder filter + ?folderId=/?hostId= URL preselect so History links on
  // folder rows land pre-filtered.
  const [hosts, setHosts] = useState<Host[]>([]);
  const [hostFilter, setHostFilter] = useState("");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderFilter, setFolderFilter] = useState("");
  const [locks, setLocks] = useState<LockInfo[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);

  async function loadLocks(): Promise<void> {
    try {
      const [lockList, hostList, folderList] = await Promise.all([
        api.listLocks(),
        api.listHosts().catch(() => [] as Host[]),
        api.listFolders().catch(() => [] as Folder[]),
      ]);
      setLocks(lockList);
      setHosts(hostList);
      setFolders(folderList);
    } catch {
      // Locks are best-effort; a failure must not break the log view.
      setLocks([]);
    }
  }

  async function load(
    nextOffset: number,
    nextStatus: OperationStatus | "",
    nextHost: string,
    nextFolder: string,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Ask for one extra row to know whether a next page exists; the
      // server caps limit at 500, so PAGE_SIZE stays well within bounds.
      const rows = await api.listOperations({
        limit: PAGE_SIZE + 1,
        offset: nextOffset,
        status: nextStatus || undefined,
        hostId: nextHost || undefined,
        folderId: nextFolder || undefined,
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
    // UX workstream 4: read ?folderId=/?hostId= once so History links land
    // pre-filtered.
    const folderId = searchParams.get("folderId") ?? "";
    const hostId = searchParams.get("hostId") ?? "";
    setFolderFilter(folderId);
    setHostFilter(hostId);
    void load(0, "", hostId, folderId);
    void loadLocks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onStatusChange(e: React.ChangeEvent<HTMLSelectElement>): void {
    const value = e.target.value as OperationStatus | "";
    setStatus(value);
    void load(0, value, hostFilter, folderFilter);
  }

  function onHostFilterChange(e: React.ChangeEvent<HTMLSelectElement>): void {
    const value = e.target.value;
    setHostFilter(value);
    void load(0, status, value, folderFilter);
  }

  function onFolderFilterChange(e: React.ChangeEvent<HTMLSelectElement>): void {
    const value = e.target.value;
    setFolderFilter(value);
    void load(0, status, hostFilter, value);
  }

  function nextPage(): void {
    void load(offset + PAGE_SIZE, status, hostFilter, folderFilter);
  }

  function prevPage(): void {
    void load(Math.max(0, offset - PAGE_SIZE), status, hostFilter, folderFilter);
  }

  function folderLabel(id: string): string {
    return folders.find((f) => f.id === id)?.name ?? id;
  }

  function lockLabel(hostId: string): string {
    return hosts.find((h) => h.id === hostId)?.hostname ?? hostId;
  }

  const pageStart = items ? offset + 1 : 0;
  const pageEnd = items ? offset + items.length : 0;

  return (
    <div className="page">
      <PageHeader title="Activity" purpose="Recent sync and backup activity across your fleet, including locks and results." />
<div className="toolbar">
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
        <label className="scope-filter">
          Device
          <select value={hostFilter} onChange={onHostFilterChange}>
            <option value="">All devices</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.hostname}
              </option>
            ))}
          </select>
        </label>
        <label className="scope-filter">
          Folder
          <select value={folderFilter} onChange={onFolderFilterChange}>
            <option value="">All folders</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="action"
          onClick={() => {
            void load(offset, status, hostFilter, folderFilter);
            void loadLocks();
          }}
          disabled={busy}
        >
          Refresh
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      <section className="section">
        <h2>Active locks</h2>
        {locks === null ? (
          <div className="skel skel-line" aria-busy="true" />
        ) : locks.length === 0 ? (
          <div className="empty-row">No active folder locks</div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Folder</th>
                <th>Device</th>
                <th>Acquired at</th>
                <th>TTL</th>
              </tr>
            </thead>
            <tbody>
              {locks.map((lock) => (
                <tr key={`${lock.folderId}:${lock.lockedBy}`}>
                  <td><code>{lock.folderId}</code></td>
                  <td className="muted">{lockLabel(lock.lockedBy)}</td>
                  <td className="mono muted">{formatTimestamp(lock.lockedAt)}</td>
                  <td className="num mono muted">{Math.round(lock.lockTtl / 60)} min</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <table className="data">
        <thead>
          <tr>
            <th>Time</th>
            <th>Device</th>
            <th>Folder</th>
            <th>Operation</th>
            <th>Status</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {!items ? (
            <tr aria-busy="true">
              <td colSpan={6}><div className="skel skel-line" /></td>
            </tr>
          ) : items.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={6}>
                {status
                  ? `No ${status} operations`
                  : "No operations yet — every sync and backup the daemons run is logged here."}
              </td>
            </tr>
          ) : (
            items.map((op) => (
              <tr key={String(op.id)}>
                <td className="mono">{formatTimestamp(op.timestamp)}</td>
                <td className="mono muted">{op.hostId}</td>
                <td className="muted">{op.folderId ? folderLabel(op.folderId) : "—"}</td>
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
