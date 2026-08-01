import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { BrowseEntry, BrowseResponse, Folder, ResticSnapshot } from "@lamasync/core";
import { api } from "../api.ts";
import { IconFolder, IconStorage } from "../components/icons.tsx";

type Tab = "local" | "s3" | "restic";

interface S3PickerState {
  folderId: string;
  path: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatTimestamp(ts: number): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

function parentPath(path: string): string | null {
  const trimmed = path.replace(/\/$/, "");
  if (trimmed === "") return null;
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? "" : trimmed.slice(0, idx);
}

function breadcrumbParts(path: string): string[] {
  if (!path) return [];
  return path.replace(/\/$/, "").split("/").filter(Boolean);
}

function Breadcrumbs({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  const parts = breadcrumbParts(path);
  return (
    <div className="browser-breadcrumb">
      <button type="button" className="action breadcrumb-root" onClick={() => onNavigate("")}>
        root
      </button>
      {parts.map((part, index) => {
        const target = parts.slice(0, index + 1).join("/");
        return (
          <span key={target} className="breadcrumb-segment">
            <span className="breadcrumb-separator">/</span>
            <button type="button" className="action breadcrumb-part" onClick={() => onNavigate(`${target}/`)}>
              {part}
            </button>
          </span>
        );
      })}
    </div>
  );
}

interface EntriesTableProps {
  response: BrowseResponse | null;
  path: string;
  onNavigate: (path: string) => void;
  ownerLabel?: string;
}

function EntriesTable({ response, path, onNavigate, ownerLabel }: EntriesTableProps) {
  const parent = parentPath(path);
  const sorted = useMemo(() => {
    const entries = response?.entries ?? [];
    const dirs = entries.filter((e) => e.type === "dir");
    const files = entries.filter((e) => e.type === "file");
    return [
      ...dirs.sort((a, b) => a.name.localeCompare(b.name)),
      ...files.sort((a, b) => a.name.localeCompare(b.name)),
    ];
  }, [response?.entries]);

  if (!response) return null;
  if (response.entries.length === 0) {
    return <div className="empty-row">This directory is empty</div>;
  }

  return (
    <table className="data browser-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Size</th>
          <th>Modified</th>
          {ownerLabel && <th>{ownerLabel}</th>}
        </tr>
      </thead>
      <tbody>
        {parent !== null && (
          <tr className="browser-parent">
            <td colSpan={ownerLabel ? 5 : 4}>
              <button type="button" className="action" onClick={() => onNavigate(parent === "" ? "" : `${parent}/`)}>
                ../ parent
              </button>
            </td>
          </tr>
        )}
        {sorted.map((entry) => (
          <tr key={entry.name} className="browser-row">
            <td>
              {entry.type === "dir" ? (
                <button
                  type="button"
                  className="browser-dir-name"
                  onClick={() => onNavigate(path === "" ? `${entry.name}/` : `${path}${entry.name}/`)}
                >
                  <IconFolder /> {entry.name}
                </button>
              ) : (
                <span className="browser-file-name">{entry.name}</span>
              )}
            </td>
            <td>{entry.type === "dir" ? "directory" : "file"}</td>
            <td>{formatBytes(entry.size)}</td>
            <td>{formatTimestamp(entry.mtime)}</td>
            {ownerLabel && (
              <td>
                {entry.folderId ? <span className="muted">{entry.folderId}</span> : "—"}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LocalBrowser() {
  const [path, setPath] = useState("");
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .browseLocal(path)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div className="browser-tab">
      <Breadcrumbs path={path} onNavigate={setPath} />
      {error && <div className="error">{error}</div>}
      <EntriesTable response={data} path={path} onNavigate={setPath} ownerLabel="Folder" />
    </div>
  );
}

function S3Browser() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [state, setState] = useState<S3PickerState | null>(null);
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listFolders()
      .then((res) => {
        if (!cancelled) {
          const s3 = res.filter((f) => f.backend === "s3");
          setFolders(s3);
          if (!state && s3.length > 0) {
            setState({ folderId: s3[0].id, path: "" });
          }
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    let cancelled = false;
    setError(null);
    api
      .browseS3(state.folderId, state.path)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [state]);

  return (
    <div className="browser-tab">
      <div className="toolbar">
        <select
          className="browser-select"
          value={state?.folderId ?? ""}
          onChange={(e) => {
            // Switching folder resets the prefix and drops stale entries
            // from the previous folder until the new listing arrives.
            setData(null);
            setState({ folderId: e.target.value, path: "" });
          }}
        >
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} ({f.s3Bucket ?? "no bucket"})
            </option>
          ))}
        </select>
      </div>
      {folders.length === 0 && !error && <div className="empty-row">No S3 folders configured</div>}
      {state && (
        <>
          <Breadcrumbs path={state.path} onNavigate={(path) => setState({ ...state, path })} />
          {error && <div className="error">{error}</div>}
          <EntriesTable
            response={data}
            path={state.path}
            onNavigate={(path) => setState({ ...state, path })}
            ownerLabel="Folder"
          />
        </>
      )}
    </div>
  );
}

function ResticBrowser() {
  const [snapshots, setSnapshots] = useState<ResticSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .browseRestic()
      .then((res) => {
        if (!cancelled) setSnapshots(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="browser-tab">
      {error && <div className="error">{error}</div>}
      <table className="data">
        <thead>
          <tr>
            <th>Snapshot</th>
            <th>Folder</th>
            <th>Host</th>
            <th>Time</th>
            <th>Paths</th>
            <th>Size</th>
          </tr>
        </thead>
        <tbody>
          {snapshots.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={6}>No restic snapshots recorded</td>
            </tr>
          ) : (
            snapshots.map((s) => (
              <tr key={s.id}>
                <td>
                  <code>{s.snapshotId}</code>
                </td>
                <td>{s.folderId}</td>
                <td>{s.hostId}</td>
                <td>{formatTimestamp(s.timestamp)}</td>
                <td>{s.paths.join(", ")}</td>
                <td>{formatBytes(s.sizeBytes ?? 0)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function DataBrowser() {
  const [tab, setTab] = useState<Tab>("local");

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Data Browser</h1>
        <span className="muted browser-readonly">Read-only view</span>
      </div>

      <div className="browser-tabs">
        <button
          type="button"
          className={`action ${tab === "local" ? "primary" : ""}`}
          onClick={() => setTab("local")}
        >
          <IconFolder /> Local
        </button>
        <button
          type="button"
          className={`action ${tab === "s3" ? "primary" : ""}`}
          onClick={() => setTab("s3")}
        >
          <IconStorage /> S3
        </button>
        <button
          type="button"
          className={`action ${tab === "restic" ? "primary" : ""}`}
          onClick={() => setTab("restic")}
        >
          Restic
        </button>
      </div>

      {tab === "local" && <LocalBrowser />}
      {tab === "s3" && <S3Browser />}
      {tab === "restic" && <ResticBrowser />}
    </div>
  );
}
