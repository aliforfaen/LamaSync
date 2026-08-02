import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  BrowseEntry,
  BrowseJob,
  BrowseRef,
  BrowseResponse,
  Folder,
  ResticSnapshot,
} from "@lamasync/core";
import { api } from "../api.ts";
import { IconFolder, IconStorage } from "../components/icons.tsx";

type Tab = "local" | "s3" | "restic";

interface S3PickerState {
  folderId: string;
  path: string;
}

/** The current directory context of a tab, lifted for the write toolbar. */
interface TabContext {
  ref: BrowseRef;
  reload: () => void;
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
  // LAMA-226: multi-select for copy/move.
  selection?: Set<string>;
  onToggleSelect?: (name: string) => void;
  onRename?: (name: string) => void;
}

function EntriesTable({ response, path, onNavigate, ownerLabel, selection, onToggleSelect, onRename }: EntriesTableProps) {
  const parent = parentPath(path);
  const selectable = Boolean(selection && onToggleSelect);
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
          {selectable && <th />}
          <th>Name</th>
          <th>Type</th>
          <th>Size</th>
          <th>Modified</th>
          {ownerLabel && <th>{ownerLabel}</th>}
          {onRename && <th />}
        </tr>
      </thead>
      <tbody>
        {parent !== null && (
          <tr className="browser-parent">
            <td colSpan={selectable ? 6 : onRename ? 6 : ownerLabel ? 5 : 4}>
              <button type="button" className="action" onClick={() => onNavigate(parent === "" ? "" : `${parent}/`)}>
                ../ parent
              </button>
            </td>
          </tr>
        )}
        {sorted.map((entry) => (
          <tr key={entry.name} className="browser-row">
            {selectable && (
              <td>
                <input
                  type="checkbox"
                  checked={selection!.has(entry.name)}
                  onChange={() => onToggleSelect!(entry.name)}
                  aria-label={`Select ${entry.name}`}
                />
              </td>
            )}
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
            {onRename && (
              <td>
                <button type="button" className="action" onClick={() => onRename(entry.name)}>
                  Rename
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Generic browser that lists a ref and reports its context upward. */
function RefBrowser({
  ref,
  onContext,
  selection,
  onToggleSelect,
  onRename,
}: {
  ref: BrowseRef;
  onContext: (ctx: TabContext) => void;
  selection?: Set<string>;
  onToggleSelect?: (name: string) => void;
  onRename?: (name: string) => void;
}) {
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bump, setBump] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const load = ref.kind === "s3"
      ? api.browseS3(ref.folderId ?? "", ref.path)
      : api.browseLocal(ref.path);
    load
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [ref, bump]);

  useEffect(() => {
    onContext({
      ref,
      reload: () => setBump((n) => n + 1),
    });
  }, [ref, onContext]);

  const navigate = (path: string) => onContext({ ref: { ...ref, path }, reload: () => setBump((n) => n + 1) });

  return (
    <div className="browser-tab">
      <Breadcrumbs path={ref.path} onNavigate={navigate} />
      {error && <div className="error">{error}</div>}
      <EntriesTable
        response={data}
        path={ref.path}
        onNavigate={navigate}
        ownerLabel={ref.kind === "s3" ? "Folder" : undefined}
        selection={selection}
        onToggleSelect={onToggleSelect}
        onRename={onRename}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// LAMA-226: write operations
// ---------------------------------------------------------------------------

interface PickerState {
  mode: "copy" | "move";
  source: BrowseRef;
  names: string[];
}

function DestinationPicker({
  state,
  onClose,
  onPick,
}: {
  state: PickerState;
  onClose: () => void;
  onPick: (destination: BrowseRef) => void;
}) {
  const [kind, setKind] = useState<"local" | "s3">("local");
  const [s3Folders, setS3Folders] = useState<Folder[]>([]);
  const [s3FolderId, setS3FolderId] = useState("");
  const [path, setPath] = useState("");

  useEffect(() => {
    api
      .listFolders()
      .then((res) => {
        const s3 = res.filter((f) => f.backend === "s3");
        setS3Folders(s3);
        if (s3.length > 0) setS3FolderId(s3[0].id);
      })
      .catch(() => {
        // ignore
      });
  }, []);

  const ref: BrowseRef = kind === "local" ? { kind: "local", path } : { kind: "s3", folderId: s3FolderId, path };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{state.mode === "copy" ? "Copy to…" : "Move to…"}</h2>
        <p className="muted">
          {state.names.length} entr{state.names.length === 1 ? "y" : "ies"} from{" "}
          <code>{state.source.path}</code>
        </p>
        <div className="browser-tabs">
          <button type="button" className={`action ${kind === "local" ? "primary" : ""}`} onClick={() => setKind("local")}>
            Local
          </button>
          <button type="button" className={`action ${kind === "s3" ? "primary" : ""}`} onClick={() => setKind("s3")}>
            S3
          </button>
        </div>
        {kind === "s3" ? (
          <select
            className="browser-select"
            value={s3FolderId}
            onChange={(e) => setS3FolderId(e.target.value)}
          >
            {s3Folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({f.s3Bucket ?? "no bucket"})
              </option>
            ))}
          </select>
        ) : null}
        <RefBrowser
          ref={ref}
          onContext={(ctx) => setPath(ctx.ref.path)}
        />
        <div className="modal-actions">
          <button type="button" className="action" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="action primary"
            disabled={kind === "s3" && !s3FolderId}
            onClick={() => onPick({ kind, folderId: kind === "s3" ? s3FolderId : null, path })}
          >
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}

function JobsPanel({ jobs }: { jobs: BrowseJob[] }) {
  if (jobs.length === 0) return null;
  return (
    <div className="section">
      <h2>Recent operations</h2>
      <table className="data">
        <thead>
          <tr>
            <th>Op</th>
            <th>Source</th>
            <th>Destination</th>
            <th>Progress</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {jobs.slice(0, 8).map((job) => (
            <tr key={job.id}>
              <td>
                <span className={`badge badge-${job.status}`}>{job.operation}</span>
              </td>
              <td className="muted">{job.source}</td>
              <td className="muted">{job.destination}</td>
              <td className="muted">
                {job.totalBytes !== null
                  ? `${job.progressBytes ?? 0}/${job.totalBytes}`
                  : "—"}
              </td>
              <td>
                <span className={`badge badge-${job.status}`}>{job.status}</span>
                {job.error ? <div className="muted" title={job.error}>{job.error}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DataBrowser() {
  const [tab, setTab] = useState<Tab>("local");
  const [context, setContext] = useState<Record<Tab, TabContext | null>>({
    local: null,
    s3: null,
    restic: null,
  });
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [jobs, setJobs] = useState<BrowseJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const jobPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const current = context[tab];

  const refreshJobs = useCallback(async (): Promise<void> => {
    try {
      setJobs(await api.listBrowseJobs(20));
    } catch {
      // polling is best-effort
    }
  }, []);

  useEffect(() => {
    void refreshJobs();
    jobPollRef.current = setInterval(() => {
      void refreshJobs();
    }, 2000);
    return () => {
      if (jobPollRef.current) clearInterval(jobPollRef.current);
    };
  }, [refreshJobs]);

  function toggleSelect(name: string): void {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function onRename(name: string): void {
    const to = window.prompt(`Rename '${name}' to:`, name);
    if (!to || to === name || !current) return;
    setError(null);
    void api
      .browseRename(current.ref, name, to)
      .then(() => current.reload())
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  function onMkdir(): void {
    const name = window.prompt("New directory name:", "");
    if (!name || !current) return;
    setError(null);
    void api
      .browseMkdir(current.ref, name)
      .then(() => current.reload())
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  function onUpload(file: File | undefined): void {
    if (!file || !current) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result ?? "").split(",").pop() ?? "";
      setError(null);
      void api
        .browseUpload(current.ref, file.name, base64)
        .then(() => current.reload())
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    };
    reader.readAsDataURL(file);
  }

  function openPicker(mode: "copy" | "move"): void {
    if (!current || selection.size === 0) return;
    setPicker({
      mode,
      source: current.ref,
      names: [...selection],
    });
  }

  function onPickDestination(destination: BrowseRef): void {
    if (!picker) return;
    const call =
      picker.mode === "copy"
        ? api.browseCopy(picker.source, destination, picker.names)
        : api.browseMove(picker.source, destination, picker.names);
    setPicker(null);
    setSelection(new Set());
    setError(null);
    void call
      .then(() => {
        if (current) current.reload();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Data Browser</h1>
        <span className="muted">
          {tab === "restic" ? "Read-only" : "Copy / move / rename / upload"}
        </span>
      </div>
      {error && <div className="error">{error}</div>}

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

      {tab !== "restic" ? (
        <div className="browser-toolbar">
          <button
            type="button"
            className="action"
            disabled={selection.size === 0}
            onClick={() => openPicker("copy")}
          >
            Copy to…
          </button>
          <button
            type="button"
            className="action"
            disabled={selection.size === 0}
            onClick={() => openPicker("move")}
          >
            Move to…
          </button>
          <button type="button" className="action" onClick={onMkdir}>
            New folder
          </button>
          <button type="button" className="action" onClick={() => fileInputRef.current?.click()}>
            Upload
          </button>
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: "none" }}
            onChange={(e) => {
              onUpload(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {selection.size > 0 ? (
            <span className="muted">
              {selection.size} selected ·{" "}
              <button
                type="button"
                className="action"
                onClick={() => setSelection(new Set())}
              >
                clear
              </button>
            </span>
          ) : null}
        </div>
      ) : null}

      {tab === "local" && (
        <RefBrowser
          ref={{ kind: "local", path: "" }}
          onContext={(ctx) => setContext((prev) => ({ ...prev, local: ctx }))}
          selection={selection}
          onToggleSelect={toggleSelect}
          onRename={onRename}
        />
      )}
      {tab === "s3" && <S3Browser onContext={(ctx) => setContext((prev) => ({ ...prev, s3: ctx }))} selection={selection} onToggleSelect={toggleSelect} onRename={onRename} />}
      {tab === "restic" && <ResticBrowser />}

      {picker && (
        <DestinationPicker
          state={picker}
          onClose={() => setPicker(null)}
          onPick={onPickDestination}
        />
      )}

      <JobsPanel jobs={jobs} />
    </div>
  );
}

function S3Browser({
  onContext,
  selection,
  onToggleSelect,
  onRename,
}: {
  onContext: (ctx: TabContext) => void;
  selection?: Set<string>;
  onToggleSelect?: (name: string) => void;
  onRename?: (name: string) => void;
}) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [state, setState] = useState<S3PickerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bump, setBump] = useState(0);

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
    onContext({ ref: { kind: "s3", folderId: state.folderId, path: state.path }, reload: () => setBump((n) => n + 1) });
  }, [state, onContext]);

  if (!state) {
    return <div className="browser-tab">{error ? <div className="error">{error}</div> : <div className="empty-row">No S3 folders configured</div>}</div>;
  }

  return (
    <div className="browser-tab">
      <div className="toolbar">
        <select
          className="browser-select"
          value={state.folderId}
          onChange={(e) => {
            setState({ folderId: e.target.value, path: "" });
            setError(null);
          }}
        >
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} ({f.s3Bucket ?? "no bucket"})
            </option>
          ))}
        </select>
      </div>
      <RefBrowser
        key={state.folderId}
        ref={{ kind: "s3", folderId: state.folderId, path: state.path }}
        onContext={(ctx) => {
          onContext(ctx);
          setState({ folderId: state.folderId, path: ctx.ref.path });
        }}
        selection={selection}
        onToggleSelect={onToggleSelect}
        onRename={onRename}
      />
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
