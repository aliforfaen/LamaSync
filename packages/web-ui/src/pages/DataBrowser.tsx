import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../components/PageHeader.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Link } from "react-router-dom";
import type {
  BrowseEntry,
  BrowseJob,
  BrowseRef,
  BrowseResponse,
  Folder,
  FolderSnapshot,
  Host,
  ResticRestoreJob,
  ResticSnapshot,
} from "@lamasync/core";
import { api, errorText } from "../api.ts";
import {
  moveChipFocus,
  snapshotCaptionLabel,
  snapshotChipLabel,
  sortSnapshotsChronological,
} from "../snapshot-history.ts";
import { ConfirmDialog, Modal, PromptDialog } from "../components/Modal.tsx";
import { InlineError } from "../components/InlineError.tsx";
import { useOverlayA11y } from "../hooks/useOverlayA11y.ts";
import { IconFolder, IconStorage } from "../components/icons.tsx";
import {
  TEXT_PREVIEW_MAX_BYTES,
  extensionOf,
  previewKindForName,
  sniffPreviewKind,
  truncateText,
  type PreviewKind,
} from "../file-preview.ts";
import { isValidUploadPath, normalizeUploadPath } from "../upload-path.ts";

type Tab = "local" | "s3" | "restic";

interface S3PickerState {
  folderId: string;
  path: string;
}

/** The current directory context of a tab, lifted for the write toolbar. */
interface TabContext {
  ref: BrowseRef;
  reload: () => void;
  // LAMA-259: true when the context is a backup folder being browsed in
  // snapshot mode — the write toolbar must offer no edit ops, ever.
  readOnly?: boolean;
  // LAMA-260: present when this context supports server-side folder uploads
  // (a writable s3 / local / nfs folder, not restic/sftp or snapshot mode).
  // The Data Browser uses it to choose the folder-scoped upload flow.
  uploadFolderId?: string;
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
  // WS5 P4: true while a listing fetch is in flight (drives skeleton rows).
  loading: boolean;
  path: string;
  onNavigate: (path: string) => void;
  ownerLabel?: string;
  // LAMA-226: multi-select for copy/move.
  selection?: Set<string>;
  onToggleSelect?: (name: string) => void;
  onRename?: (name: string) => void;
  // UX workstream 4: per-file download.
  onDownload?: (name: string) => void;
  // LAMA-260: per-file content preview (image/text) when writable. Receives
  // the whole entry so the caller can classify by size.
  onPreview?: (entry: BrowseEntry) => void;
  // LAMA-271: empty-directory teaching CTA (opens an existing flow such as
  // the upload picker). Omitted → message-only empty state.
  emptyCtaLabel?: string;
  emptyCta?: () => void;
}

function EntriesTable({ response, loading, path, onNavigate, ownerLabel, selection, onToggleSelect, onRename, onDownload, onPreview, emptyCtaLabel, emptyCta }: EntriesTableProps) {
  const parent = parentPath(path);
  const selectable = Boolean(selection && onToggleSelect);
  const hasActions = Boolean(onRename || onDownload || onPreview);
  const sorted = useMemo(() => {
    const entries = response?.entries ?? [];
    const dirs = entries.filter((e) => e.type === "dir");
    const files = entries.filter((e) => e.type === "file");
    return [
      ...dirs.sort((a, b) => a.name.localeCompare(b.name)),
      ...files.sort((a, b) => a.name.localeCompare(b.name)),
    ];
  }, [response?.entries]);

  if (!response) {
    if (!loading) return null;
    return (
      <div className="browser-skel" aria-busy="true">
        <div className="skel skel-line" />
        <div className="skel skel-line" />
        <div className="skel skel-line" />
        <div className="skel skel-line" />
      </div>
    );
  }
  if (response.entries.length === 0) {
    return (
      <EmptyState
        variant="data"
        title="This directory is empty"
        how={
          emptyCta
            ? "Add something to browse — upload a file or create a folder here."
            : "Nothing has been added to this location yet."
        }
        ctaLabel={emptyCtaLabel ?? "Upload a file"}
        onCta={emptyCta}
        steps={
          emptyCta
            ? [
                "Pick a file to upload",
                "It lands in this directory",
                "Rename, move, or download it anytime",
              ]
            : undefined
        }
        timeNote={emptyCta ? "takes 30s" : undefined}
      />
    );
  }

  return (
    // P-A fix: a scroll container keeps the wide data table from blowing the
    // page width on narrow viewports (~375px) and from fighting the off-canvas
    // rail's negative translate. The wrapper is width:100% inside the rail's
    // content column; the table keeps a min-width so columns don't crush.
    <div className="browser-table-scroll">
      <table className="data browser-table">
      <thead>
        <tr>
          {selectable && <th />}
          <th>Name</th>
          <th>Type</th>
          <th>Size</th>
          <th>Modified</th>
          {ownerLabel && <th>{ownerLabel}</th>}
          {hasActions && <th />}
        </tr>
      </thead>
      <tbody>
        {parent !== null && (
          <tr className="browser-parent">
            <td colSpan={selectable ? 6 : hasActions ? 6 : ownerLabel ? 5 : 4}>
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
            <td className="num mono">{formatBytes(entry.size)}</td>
            <td className="mono">{formatTimestamp(entry.mtime)}</td>
            {ownerLabel && (
              <td>
                {entry.folderId ? <span className="mono muted">{entry.folderId}</span> : "—"}
              </td>
            )}
            {hasActions && (
              <td>
                {onPreview && entry.type === "file" && previewKindForName(entry.name, entry.size) !== null && (
                  <button
                    type="button"
                    className="action"
                    onClick={() => onPreview(entry)}
                  >
                    Preview
                  </button>
                )}
                {onDownload && entry.type === "file" && (
                  <button
                    type="button"
                    className="action"
                    onClick={() => onDownload(entry.name)}
                  >
                    Download
                  </button>
                )}
                {onRename && (
                  <button type="button" className="action" onClick={() => onRename(entry.name)}>
                    Rename
                  </button>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

/** Generic browser that lists a ref and reports its context upward. */
function RefBrowser({
  // Named `browseRef`, not `ref`: React <19 strips `ref` from function
  // component props, so it would always arrive as undefined.
  browseRef: ref,
  onContext,
  selection,
  onToggleSelect,
  onRename,
  onDownload,
  onPreview,
  emptyCtaLabel,
  emptyCta,
}: {
  browseRef: BrowseRef;
  onContext: (ctx: TabContext) => void;
  selection?: Set<string>;
  onToggleSelect?: (name: string) => void;
  onRename?: (name: string) => void;
  onDownload?: (name: string) => void;
  onPreview?: (entry: BrowseEntry) => void;
  emptyCtaLabel?: string;
  emptyCta?: () => void;
}) {
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bump, setBump] = useState(0);

  // Phase 1 (WS6): key effects on primitives (kind/path/folderId) instead of
  // the `ref` object, and stabilize reload. Without this, a parent that
  // passes a fresh `browseRef` literal on every render cancels every fetch
  // before `setLoading(false)` lands → skeleton sticks forever.
  const refKind = ref.kind;
  const refPath = ref.path;
  const refFolderId = ref.kind === "s3" ? ref.folderId : undefined;

  const reload = useCallback(() => setBump((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    const load = refKind === "s3"
      ? api.browseS3(refFolderId ?? "", refPath)
      : api.browseLocal(refPath);
    load
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoading(false);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refKind, refPath, refFolderId, bump]);

  // Report context upward only when the ref signature actually changes; the
  // caller's identity may churn every render even when the value doesn't.
  const lastReportedRef = useRef<BrowseRef | null>(null);
  useEffect(() => {
    const prev = lastReportedRef.current;
    if (
      prev === null ||
      prev.kind !== refKind ||
      prev.path !== refPath ||
      (prev.kind === "s3" && prev.folderId !== refFolderId)
    ) {
      lastReportedRef.current = { kind: refKind, path: refPath, ...(refKind === "s3" ? { folderId: refFolderId } : {}) };
      onContext({ ref: lastReportedRef.current, reload });
    }
  }, [refKind, refPath, refFolderId, onContext, reload]);

  const navigate = (path: string) => onContext({ ref: { ...ref, path }, reload });

  return (
    <div className="browser-tab">
      <Breadcrumbs path={ref.path} onNavigate={navigate} />
      {error && <InlineError message={error} onRetry={reload} />}
      <EntriesTable
        response={data}
        loading={loading}
        path={ref.path}
        onNavigate={navigate}
        ownerLabel={ref.kind === "s3" ? "Folder" : undefined}
        selection={selection}
        onToggleSelect={onToggleSelect}
        onRename={onRename}
        onDownload={onDownload}
        onPreview={onPreview}
        emptyCtaLabel={emptyCtaLabel}
        emptyCta={emptyCta}
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
  // P-A: a failed folder-list fetch must not silently render an empty S3
  // picker — surface an inline caption + retry instead.
  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [bump, setBump] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFoldersError(null);
    api
      .listFolders()
      .then((res) => {
        if (cancelled) return;
        const s3 = res.filter((f) => f.backend === "s3");
        setS3Folders(s3);
        if (s3.length > 0) setS3FolderId(s3[0].id);
      })
      .catch((err: unknown) => {
        if (!cancelled) setFoldersError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [bump]);

  const ref: BrowseRef = kind === "local" ? { kind: "local", path } : { kind: "s3", folderId: s3FolderId, path };

  const containerRef = useOverlayA11y<HTMLDivElement>({ open: true, onClose });

  return (
    <div ref={containerRef} className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={state.mode === "copy" ? "Copy to…" : "Move to…"}
        onClick={(e) => e.stopPropagation()}
      >
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
          <>
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
            {foldersError ? (
              <InlineError
                message={`Couldn't load destination folders — ${foldersError}`}
                onRetry={() => setBump((n) => n + 1)}
              />
            ) : null}
          </>
        ) : null}
        <RefBrowser
          browseRef={ref}
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
              <td className="mono num">
                {job.totalBytes !== null
                  ? `${formatBytes(job.progressBytes ?? 0)} / ${formatBytes(job.totalBytes)}`
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
  // UX workstream 4: styled dialogs replace native prompt/confirm.
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<string[] | null>(null);
  const [overwrite, setOverwrite] = useState<{
    mode: "copy" | "move";
    source: BrowseRef;
    destination: BrowseRef;
    names: string[];
    conflicts: string[];
  } | null>(null);
  const [uploadConfirm, setUploadConfirm] = useState<File | null>(null);
  const [jobs, setJobs] = useState<BrowseJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  // LAMA-260: file content preview — the ref+name of the file being viewed
  // and the preview kind decided at click time (image vs text).
  const [previewTarget, setPreviewTarget] = useState<{
    ref: BrowseRef;
    name: string;
    kind: PreviewKind;
  } | null>(null);
  // LAMA-260: folder-scoped upload dialog state (folderId + target path).
  const [uploadOpen, setUploadOpen] = useState<{
    folderId: string;
    path: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const jobPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const current = context[tab];
  // LAMA-259: browsing a restic backup folder is read-only — the write
  // toolbar collapses to a note (same treatment as the Restic tab).
  const readOnly = current?.readOnly ?? false;

  const refreshJobs = useCallback(async (): Promise<void> => {
    try {
      setJobs(await api.listBrowseJobs(20));
    } catch {
      // polling is best-effort
    }
  }, []);

  // Phase 1 (WS6): stable identity for the inline literal + callbacks that
  // were re-created on every parent render, which fed an effect-identity
  // loop in <RefBrowser> (cancelled every fetch → skeleton stuck).
  const localBrowseRef = useMemo<BrowseRef>(() => ({ kind: "local", path: "" }), []);
  const reportLocalContext = useCallback(
    (ctx: TabContext) => setContext((prev) => ({ ...prev, local: ctx })),
    [],
  );
  const reportS3Context = useCallback(
    (ctx: TabContext) => setContext((prev) => ({ ...prev, s3: ctx })),
    [],
  );

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
    setRenameTarget(name);
  }

  function confirmRename(to: string): void {
    if (!renameTarget || !current) return;
    // WS5 P5: an unchanged name is a no-op — still close the dialog so it
    // doesn't sit open with no visible effect.
    setRenameTarget(null);
    if (to === renameTarget) return;
    setError(null);
    void api
      .browseRename(current.ref, renameTarget, to)
      .then(() => current.reload())
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  function onMkdir(): void {
    setMkdirOpen(true);
  }

  function confirmMkdir(name: string): void {
    if (!current) return;
    setMkdirOpen(false);
    setError(null);
    void api
      .browseMkdir(current.ref, name)
      .then(() => current.reload())
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  function onDownload(name: string): void {
    if (!current) return;
    setError(null);
    void api
      .browseDownload(current.ref, name)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  // LAMA-260: open the preview modal for a file. The kind was decided at
  // render time (extension + size) so the modal can fetch the right bytes.
  function onPreview(entry: BrowseEntry): void {
    if (!current || entry.type !== "file") return;
    const kind = previewKindForName(entry.name, entry.size);
    if (kind === null) return;
    setPreviewTarget({ ref: current.ref, name: entry.name, kind });
  }

  // LAMA-271: the empty-directory teaching CTA opens the existing upload
  // picker (same flow as the toolbar "Upload" button). For a writable
  // folder-scoped context it opens the folder upload modal instead.
  function openUpload(): void {
    if (current?.uploadFolderId) {
      setUploadOpen({ folderId: current.uploadFolderId, path: current.ref.path });
      return;
    }
    fileInputRef.current?.click();
  }

  function onUpload(file: File | undefined): void {
    if (!file || !current) return;
    // UX workstream 4: confirm overwrite when a same-named entry already
    // exists at the current path.
    void entryExists(current.ref, file.name).then((exists) => {
      if (exists) {
        setUploadConfirm(file);
        return;
      }
      uploadFile(file);
    });
  }

  function uploadFile(file: File): void {
    if (!current) return;
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

  /** Resolve whether an entry with this name exists at a ref's path. */
  async function entryExists(ref: BrowseRef, name: string): Promise<boolean> {
    try {
      const listing =
        ref.kind === "s3"
          ? await api.browseS3(ref.folderId ?? "", ref.path)
          : await api.browseLocal(ref.path);
      return listing.entries.some((e) => e.name === name);
    } catch {
      // Listing failed (unreachable backend etc.) — do not block the op.
      return false;
    }
  }

  async function listExistingNames(
    ref: BrowseRef,
    names: string[],
  ): Promise<string[]> {
    try {
      const listing =
        ref.kind === "s3"
          ? await api.browseS3(ref.folderId ?? "", ref.path)
          : await api.browseLocal(ref.path);
      const present = new Set(listing.entries.map((e) => e.name));
      return names.filter((n) => present.has(n));
    } catch {
      return [];
    }
  }

  function openPicker(mode: "copy" | "move"): void {
    if (!current || selection.size === 0) return;
    setPicker({
      mode,
      source: current.ref,
      names: [...selection],
    });
  }

  function onDeleteSelected(): void {
    if (!current || selection.size === 0) return;
    setDeleteTargets([...selection]);
  }

  function confirmDelete(): void {
    if (!current || !deleteTargets) return;
    const names = deleteTargets;
    setDeleteTargets(null);
    setSelection(new Set());
    setError(null);
    void api
      .browseDelete(current.ref, names)
      .then(() => {
        if (current) current.reload();
        void refreshJobs();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  async function onPickDestination(destination: BrowseRef): Promise<void> {
    if (!picker) return;
    const mode = picker.mode;
    const source = picker.source;
    const names = picker.names;
    setPicker(null);
    setSelection(new Set());
    // UX workstream 4: confirm overwrite when a same-named entry exists at
    // the destination (move and copy both clobber).
    const conflicts = await listExistingNames(destination, names);
    if (conflicts.length > 0) {
      setOverwrite({ mode, source, destination, names, conflicts });
      return;
    }
    runBrowseOp(mode, source, destination, names);
  }

  function runBrowseOp(
    mode: "copy" | "move",
    source: BrowseRef,
    destination: BrowseRef,
    names: string[],
  ): void {
    const call =
      mode === "copy"
        ? api.browseCopy(source, destination, names)
        : api.browseMove(source, destination, names);
    setError(null);
    void call
      .then(() => {
        if (current) current.reload();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  return (
    <div className="page">
      <PageHeader title="Data browser" purpose="Browse and manage files inside storage destinations directly." />
<div className="toolbar">
        <span className="muted">
          {tab === "restic" || readOnly
            ? "Read-only"
            : "Copy / move / rename / upload"}
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
          <IconStorage /> Folders
        </button>
        <button
          type="button"
          className={`action ${tab === "restic" ? "primary" : ""}`}
          onClick={() => setTab("restic")}
        >
          Restic
        </button>
      </div>

      {tab !== "restic" &&
        (readOnly ? (
          <div className="browser-toolbar">
            <span className="muted">
              Backups are read-only — scrub the history above to look back in
              time.
            </span>
          </div>
        ) : (
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
          <button
            type="button"
            className="action danger"
            disabled={selection.size === 0}
            onClick={onDeleteSelected}
          >
            Delete
          </button>
          <button type="button" className="action" onClick={onMkdir}>
            New folder
          </button>
          <button type="button" className="action" onClick={openUpload}>
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
        ))}

      {tab === "local" && (
        <RefBrowser
          browseRef={localBrowseRef}
          onContext={reportLocalContext}
          selection={selection}
          onToggleSelect={toggleSelect}
          onRename={onRename}
          onDownload={onDownload}
          onPreview={onPreview}
          emptyCtaLabel="Upload a file"
          emptyCta={openUpload}
        />
      )}
      {tab === "s3" && <S3Browser onContext={reportS3Context} selection={selection} onToggleSelect={toggleSelect} onRename={onRename} onDownload={onDownload} onPreview={onPreview} emptyCtaLabel="Upload a file" emptyCta={openUpload} />}
      {tab === "restic" && <ResticBrowser />}

      {previewTarget && current && (
        <FilePreviewModal
          target={previewTarget}
          onClose={() => setPreviewTarget(null)}
        />
      )}
      {uploadOpen && (
        <FolderUploadModal
          folderId={uploadOpen.folderId}
          initialPath={uploadOpen.path}
          onClose={() => setUploadOpen(null)}
          onUploaded={() => current?.reload()}
        />
      )}

      {picker && (
        <DestinationPicker
          state={picker}
          onClose={() => setPicker(null)}
          onPick={onPickDestination}
        />
      )}

      {renameTarget && current && (
        <PromptDialog
          title="Rename"
          message={`Rename '${renameTarget}' to:`}
          initialValue={renameTarget}
          confirmLabel="Rename"
          onConfirm={confirmRename}
          onCancel={() => setRenameTarget(null)}
        />
      )}
      {mkdirOpen && current && (
        <PromptDialog
          title="New directory"
          message="Enter a name for the new directory."
          confirmLabel="Create"
          onConfirm={confirmMkdir}
          onCancel={() => setMkdirOpen(false)}
        />
      )}
      {deleteTargets && current && (
        <ConfirmDialog
          title="Delete entries"
          danger
          confirmLabel="Delete"
          message={
            <p className="muted">
              Delete {deleteTargets.length} entr
              {deleteTargets.length === 1 ? "y" : "ies"} permanently?{" "}
              <code>{deleteTargets.join(", ")}</code>
            </p>
          }
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTargets(null)}
        />
      )}
      {overwrite && (
        <ConfirmDialog
          title={`Overwrite at destination`}
          danger
          confirmLabel="Overwrite"
          message={
            <p className="muted">
              The destination already contains{" "}
              <code>{overwrite.conflicts.join(", ")}</code>.{" "}
              {overwrite.mode === "move" ? "Moving" : "Copying"} will
              overwrite these entr{overwrite.conflicts.length === 1 ? "y" : "ies"}.
            </p>
          }
          onConfirm={() => {
            const pending = overwrite;
            setOverwrite(null);
            runBrowseOp(pending.mode, pending.source, pending.destination, pending.names);
          }}
          onCancel={() => setOverwrite(null)}
        />
      )}
      {uploadConfirm && current && (
        <ConfirmDialog
          title="Overwrite file"
          danger
          confirmLabel="Overwrite"
          message={
            <p className="muted">
              <code>{uploadConfirm.name}</code> already exists at this path.
              Upload will overwrite it.
            </p>
          }
          onConfirm={() => {
            const file = uploadConfirm;
            setUploadConfirm(null);
            uploadFile(file);
          }}
          onCancel={() => setUploadConfirm(null)}
        />
      )}

      <JobsPanel jobs={jobs} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// LAMA-260: file preview (image/text) + folder-scoped upload.
// ---------------------------------------------------------------------------

/**
 * Modal that fetches a file's bytes via the browse-download auth flow and
 * renders an image (object URL, max-height box) or text (<pre>, capped with
 * a truncated note). Esc / backdrop close via the shared Modal a11y.
 */
function FilePreviewModal({
  target,
  onClose,
}: {
  target: { ref: BrowseRef; name: string; kind: PreviewKind };
  onClose: () => void;
}) {
  const [text, setText] = useState<{ text: string; truncated: boolean } | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bump, setBump] = useState(0);
  // Resolved kind after sniffing an extension-less file's bytes.
  const [resolvedKind, setResolvedKind] = useState<PreviewKind | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setText(null);
    setImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setResolvedKind(null);
    void api
      .browsePreviewBlob(target.ref, target.name)
      .then(async (nextBlob) => {
        if (cancelled) return;
        const kind =
          target.kind === "text" && extensionOf(target.name) === ""
            ? (sniffPreviewKind(new Uint8Array(await nextBlob.slice(0, 16).arrayBuffer())) ?? null)
            : target.kind;
        if (kind === null) {
          setError("This file doesn't look like previewable text or an image.");
          setLoading(false);
          return;
        }
        setResolvedKind(kind);
        if (kind === "image") {
          setImageUrl(URL.createObjectURL(nextBlob));
        } else {
          const content = await nextBlob.text();
          setText(truncateText(content, TEXT_PREVIEW_MAX_BYTES));
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.ref, target.name, target.kind, bump]);

  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  return (
    <Modal title={`Preview — ${target.name}`} onClose={onClose}>
      {loading ? (
        <div className="browser-skel" aria-busy="true">
          <div className="skel skel-line" />
          <div className="skel skel-line" />
          <div className="skel skel-line" />
        </div>
      ) : error ? (
        <InlineError message={error} onRetry={() => setBump((n) => n + 1)} />
      ) : (
        <div className="file-preview">
          {(resolvedKind ?? target.kind) === "image" && imageUrl ? (
            <div className="file-preview-image">
              <img src={imageUrl} alt={target.name} />
            </div>
          ) : text ? (
            <>
              {text.truncated ? (
                <p className="muted file-preview-truncate-note">
                  Preview truncated at 256 KB — this file is larger.
                </p>
              ) : null}
              <pre className="file-preview-text">{text.text}</pre>
            </>
          ) : (
            <p className="muted">No preview available for this file.</p>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * Modal for the folder-scoped upload (POST /folders/:id/files). Validates the
 * optional target path client-side, disables the submit while busy, and maps
 * the server's 409/413/502 responses to friendly copy.
 */
function FolderUploadModal({
  folderId,
  initialPath,
  onClose,
  onUploaded,
}: {
  folderId: string;
  initialPath: string;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState(initialPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pathValid = isValidUploadPath(path);

  function submit(): void {
    if (!file) return;
    setBusy(true);
    setError(null);
    void api
      .uploadFolderFile(folderId, file, { path: normalizeUploadPath(path) })
      .then(() => {
        onUploaded();
        onClose();
      })
      .catch((err: unknown) => {
        setError(uploadErrorMessage(err));
        setBusy(false);
      });
  }

  return (
    <Modal
      title="Upload to folder"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="action" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="action primary"
            disabled={busy || !file || !pathValid}
            onClick={submit}
          >
            {busy ? "Uploading…" : "Upload"}
          </button>
        </>
      }
    >
      <p className="muted">
        Upload into this storage destination. Files land under{" "}
        <code>{path.trim() || "the root"}</code>.
      </p>
      {error ? <div className="error">{error}</div> : null}
      <label className="form-field">
        <span className="form-label">File</span>
        <input
          type="file"
          onChange={(e) => {
            const picked = e.target.files?.[0] ?? null;
            setFile(picked);
            setError(null);
          }}
        />
      </label>
      <label className="form-field">
        <span className="form-label">Subdirectory (optional)</span>
        <input
          type="text"
          value={path}
          placeholder="e.g. photos/2026"
          onChange={(e) => {
            setPath(e.target.value);
            setError(null);
          }}
        />
        {!pathValid ? (
          <span className="form-error">
            Path can't be absolute or contain "..".
          </span>
        ) : null}
      </label>
    </Modal>
  );
}

/** Map a folder-upload failure to friendly, glossary-safe copy. */
function uploadErrorMessage(err: unknown): string {
  const status = err instanceof Error && "status" in err ? (err as { status?: unknown }).status : undefined;
  if (status === 409) {
    return "This destination doesn't support uploads from here.";
  }
  if (status === 413) {
    return "File too large (limit 100 MB).";
  }
  if (status === 502) {
    return "Upload failed — try again.";
  }
  return err instanceof Error ? err.message : String(err);
}

function S3Browser({
  onContext,
  selection,
  onToggleSelect,
  onRename,
  onDownload,
  onPreview,
  emptyCtaLabel,
  emptyCta,
}: {
  onContext: (ctx: TabContext) => void;
  selection?: Set<string>;
  onToggleSelect?: (name: string) => void;
  onRename?: (name: string) => void;
  onDownload?: (name: string) => void;
  onPreview?: (entry: BrowseEntry) => void;
  emptyCtaLabel?: string;
  emptyCta?: () => void;
}) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [state, setState] = useState<S3PickerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bump, setBump] = useState(0);

  // LAMA-259: the folder picker also offers backup-type folders whose
  // destination is a restic repository — those render the time-travel
  // browser instead of a live listing.
  const selectedFolder = folders.find((f) => f.id === state?.folderId) ?? null;
  const isResticHistory = selectedFolder?.backend === "restic";

  useEffect(() => {
    let cancelled = false;
    api
      .listFolders()
      .then((res) => {
        if (!cancelled) {
          const browseable = res.filter(
            (f) =>
              f.backend === "s3" ||
              (f.type === "backup" && f.backend === "restic"),
          );
          setFolders(browseable);
          if (!state && browseable.length > 0) {
            setState({ folderId: browseable[0].id, path: "" });
          }
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // P-A: `bump` re-runs this fetch for the inline retry button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bump]);

  // Report an s3 context only for live s3 folders; restic backup folders
  // get their read-only context from <SnapshotBrowser> (child effects run
  // before this one, so the write toolbar never sees a stale s3 ref).
  useEffect(() => {
    if (!state || isResticHistory) return;
    const { folderId, path } = state;
    // LAMA-260: live s3 folders are server-writable, so expose the folder id
    // for the folder-scoped upload flow (restic/snapshot mode never reaches
    // this branch and stays read-only).
    onContext({ ref: { kind: "s3", folderId, path }, reload: () => setBump((n) => n + 1), uploadFolderId: folderId });
  }, [state?.folderId, state?.path, isResticHistory, onContext]);

  if (!state) {
    return (
      <div className="browser-tab">
        {error ? (
          <InlineError
            message={`Couldn't load folders — ${error}`}
            onRetry={() => setBump((n) => n + 1)}
          />
        ) : (
          <EmptyState
            variant="data"
            title="No folders to browse"
            how="Create a cloud or backup folder on the Folders page and its contents become browsable here."
            ctaLabel="Go to Folders"
            ctaTo="/folders"
          />
        )}
      </div>
    );
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
              {f.name} ({f.backend === "restic" ? "backup" : f.s3Bucket ?? "no bucket"})
            </option>
          ))}
        </select>
      </div>
      {isResticHistory ? (
        <SnapshotBrowser
          key={state.folderId}
          folderId={state.folderId}
          folderName={selectedFolder?.name ?? state.folderId}
          onContext={onContext}
        />
      ) : (
        <RefBrowser
          key={state.folderId}
          browseRef={{ kind: "s3", folderId: state.folderId, path: state.path }}
          onContext={(ctx) => {
            onContext(ctx);
            setState({ folderId: state.folderId, path: ctx.ref.path });
          }}
          selection={selection}
          onToggleSelect={onToggleSelect}
          onRename={onRename}
          onDownload={onDownload}
          onPreview={onPreview}
          emptyCtaLabel={emptyCtaLabel}
          emptyCta={emptyCta}
        />
      )}
    </div>
  );
}

// LAMA-259: time-travel browsing of one restic backup folder. A "History"
// affordance reveals a horizontal time-scrubber of the folder's snapshots;
// selecting one switches the file listing into snapshot mode (entries come
// from listSnapshotFiles). The default ("live") view is the newest
// snapshot — the current state of the backup. Esc always exits snapshot
// mode back to live; chips are arrow-key navigable (roving tabindex).
function SnapshotBrowser({
  folderId,
  folderName,
  onContext,
}: {
  folderId: string;
  folderName: string;
  onContext: (ctx: TabContext) => void;
}) {
  const [snapshots, setSnapshots] = useState<FolderSnapshot[] | null>(null);
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // null = live view (newest snapshot); a snapshot id = snapshot mode.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bump, setBump] = useState(0);
  // Roving-tabindex chip focus for arrow-key navigation (-1 = none).
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const ordered = useMemo(
    () => sortSnapshotsChronological(snapshots ?? []),
    [snapshots],
  );
  const newest = ordered.length > 0 ? ordered[ordered.length - 1] : null;
  const selected =
    selectedId === null
      ? null
      : ordered.find((s) => s.id === selectedId) ?? null;
  const active = selected ?? newest;
  const inSnapshotMode = selectedId !== null && selected !== null;

  // Load the folder's snapshot history once per folder (and on reload).
  useEffect(() => {
    let cancelled = false;
    setSnapshotsError(null);
    api
      .listFolderSnapshots(folderId)
      .then((res) => {
        if (!cancelled) setSnapshots(res.snapshots);
      })
      .catch((err: unknown) => {
        if (!cancelled) setSnapshotsError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [folderId, bump]);

  // Load the file listing for the active snapshot (live = newest).
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setError(null);
    setLoading(true);
    api
      .listSnapshotFiles(folderId, active.id, path)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoading(false);
          setError(errorText(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [folderId, active?.id, path, bump]);

  // Report the read-only browsing context upward. The ref is
  // informational only (kind "s3" keeps the union happy); writes are
  // gated off by `readOnly`, which the Data Browser checks before
  // rendering any write toolbar.
  const lastReportedRef = useRef<BrowseRef | null>(null);
  useEffect(() => {
    const prev = lastReportedRef.current;
    if (prev === null || prev.folderId !== folderId || prev.path !== path) {
      lastReportedRef.current = { kind: "s3", folderId, path };
      onContext({
        ref: lastReportedRef.current,
        reload: () => setBump((n) => n + 1),
        readOnly: true,
      });
    }
  }, [folderId, path, onContext]);

  function navigate(nextPath: string): void {
    setPath(nextPath);
  }

  function selectSnapshot(s: FolderSnapshot, index: number): void {
    setData(null);
    setSelectedId(s.id);
    setPath("");
    setFocusedIndex(index);
  }

  function exitSnapshotMode(): void {
    setData(null);
    setSelectedId(null);
    setPath("");
  }

  return (
    <div
      className="browser-tab"
      onKeyDown={(e) => {
        // Esc exits snapshot mode back to the live view; when already
        // live it collapses the scrubber instead.
        if (e.key !== "Escape") return;
        if (selectedId !== null) exitSnapshotMode();
        else if (historyOpen) setHistoryOpen(false);
      }}
    >
      {snapshotsError ? (
        <div className="snapshot-history">
          <InlineError
            message={`Couldn't load backup history — ${snapshotsError}`}
            onRetry={() => setBump((n) => n + 1)}
          />
        </div>
      ) : snapshots === null ? (
        <div className="snapshot-history">
          <span className="muted">Loading backup history…</span>
        </div>
      ) : ordered.length === 0 ? (
        <div className="snapshot-history">
          <span className="muted">No backups yet for this folder</span>
        </div>
      ) : (
        <div className="snapshot-history">
          <button
            type="button"
            className={`action ${historyOpen ? "primary" : ""}`}
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            History
          </button>
          {historyOpen && (
            <div
              className="snapshot-scrubber"
              role="group"
              aria-label={`Backup history for ${folderName}`}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  const direction = e.key === "ArrowRight" ? "right" : "left";
                  const next = moveChipFocus(
                    ordered.length,
                    focusedIndex,
                    direction,
                  );
                  setFocusedIndex(next);
                  chipRefs.current[next]?.focus();
                } else if (e.key === "Home") {
                  e.preventDefault();
                  setFocusedIndex(0);
                  chipRefs.current[0]?.focus();
                } else if (e.key === "End") {
                  e.preventDefault();
                  const last = ordered.length - 1;
                  setFocusedIndex(last);
                  chipRefs.current[last]?.focus();
                }
              }}
            >
              {ordered.map((s, index) => {
                const isSelected = s.id === selectedId;
                return (
                  <button
                    key={s.id}
                    type="button"
                    ref={(el) => {
                      chipRefs.current[index] = el;
                    }}
                    className={`action snapshot-chip ${isSelected ? "primary" : ""}`}
                    tabIndex={focusedIndex === index ? 0 : -1}
                    aria-pressed={isSelected}
                    title={`${snapshotCaptionLabel(s.time)}${s.host ? ` · ${s.host}` : ""}`}
                    onClick={() => selectSnapshot(s, index)}
                    onFocus={() => setFocusedIndex(index)}
                  >
                    {snapshotChipLabel(s.time)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {ordered.length > 0 && inSnapshotMode && active && (
        <div className="snapshot-caption">
          <span className="badge badge-restic">snapshot</span>
          <span>
            Viewing <strong>{snapshotCaptionLabel(active.time)}</strong>{" "}
            snapshot{active.host ? (
              <>
                {" "}
                from <code>{active.host}</code>
              </>
            ) : null}
          </span>
          <button type="button" className="action" onClick={exitSnapshotMode}>
            Back to live
          </button>
        </div>
      )}

      {error && (
        <InlineError
          message={`Couldn't load this snapshot's files — ${error}`}
          onRetry={() => setBump((n) => n + 1)}
        />
      )}
      <Breadcrumbs path={path} onNavigate={navigate} />
      {ordered.length > 0 && (
        <EntriesTable
          response={data}
          loading={loading}
          path={path}
          onNavigate={navigate}
        />
      )}
    </div>
  );
}

function ResticBrowser() {
  const [snapshots, setSnapshots] = useState<ResticSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  // UX workstream 4: whole-snapshot restore with optional include patterns.
  const [restoreTarget, setRestoreTarget] = useState<ResticSnapshot | null>(null);
  const [jobs, setJobs] = useState<ResticRestoreJob[]>([]);
  const [jobsError, setJobsError] = useState<string | null>(null);
  // P-A: re-runs the snapshot listing for the inline retry button.
  const [bump, setBump] = useState(0);

  async function loadJobs(): Promise<void> {
    try {
      setJobs(await api.listResticRestoreJobs());
      setJobsError(null);
    } catch (err) {
      setJobsError(err instanceof Error ? err.message : String(err));
    }
  }

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
  }, [bump]);

  // Poll restore jobs while this tab is mounted; the server broadcasts
  // `restic_restore` events, but polling keeps this page self-sufficient.
  useEffect(() => {
    void loadJobs();
    const interval = setInterval(() => void loadJobs(), 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="browser-tab">
      {error && (
        <InlineError
          message={`Couldn't load snapshots — ${error}`}
          onRetry={() => setBump((n) => n + 1)}
        />
      )}
      {snapshots.length === 0 ? (
        error ? null : (
          <EmptyState
            variant="storage"
            title="No backups recorded yet"
            how="Backups run on a schedule from the Folders page — each completed run records a snapshot here."
            ctaLabel="Set up a backup"
            ctaTo="/folders"
            steps={[
              "Create a backup folder on the Folders page",
              "Set it up on a device",
              "The next scheduled run records a snapshot",
            ]}
            timeNote="takes 30s"
          />
        )
      ) : (
      <table className="data">
        <thead>
          <tr>
            <th>Snapshot</th>
            <th>Folder</th>
            <th>Device</th>
            <th>Time</th>
            <th>Paths</th>
            <th>Size</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {snapshots.map((s) => (
            <tr key={s.id}>
              <td>
                <code>{s.snapshotId}</code>
              </td>
              <td>{s.folderId}</td>
              <td>{s.hostId}</td>
              <td>{formatTimestamp(s.timestamp)}</td>
              <td>{s.paths.join(", ")}</td>
              <td>{formatBytes(s.sizeBytes ?? 0)}</td>
              <td>
                <button
                  type="button"
                  className="action"
                  onClick={() => setRestoreTarget(s)}
                >
                  Restore…
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      )}

      <div className="section">
        <h2>Restore jobs</h2>
        {jobsError && <div className="error">{jobsError}</div>}
        {jobs.length === 0 ? (
          <div className="empty-row">
            No restore jobs — restore a snapshot above to queue one for the
            target device's service.
          </div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Status</th>
                <th>Snapshot</th>
                <th>Target device</th>
                <th>Target path</th>
                <th>Created</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    <span className={`badge badge-${job.status}`}>{job.status}</span>
                  </td>
                  <td>
                    <code>{job.snapshotId}</code>
                  </td>
                  <td className="muted">{job.targetHostId}</td>
                  <td className="muted"><code>{job.targetPath}</code></td>
                  <td className="muted">{formatTimestamp(job.createdAt)}</td>
                  <td className="muted">{job.error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {restoreTarget && (
        <RestoreModal
          snapshot={restoreTarget}
          onClose={() => setRestoreTarget(null)}
          onCreated={() => void loadJobs()}
        />
      )}
    </div>
  );
}

function RestoreModal({
  snapshot,
  onClose,
  onCreated,
}: {
  snapshot: ResticSnapshot;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [targetHostId, setTargetHostId] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [includeText, setIncludeText] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // P-A: re-runs the online-device fetch so a failed load has a retry path.
  const [bump, setBump] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api
      .health()
      .then((health) => {
        if (!cancelled) {
          const online = health.hosts.filter((h) => h.status === "online");
          setHosts(online);
          if (online.length > 0) setTargetHostId(online[0].id);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [bump]);

  function submit(): void {
    if (!targetHostId) return;
    const include = includeText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    setBusy(true);
    setSubmitError(null);
    void api
      .createResticRestore({
        snapshotId: snapshot.snapshotId,
        folderId: snapshot.folderId,
        targetHostId,
        targetPath: targetPath.trim() || (snapshot.paths[0] ?? "/"),
        include,
      })
      .then(() => {
        onCreated();
        onClose();
      })
      .catch((err: unknown) => {
        setSubmitError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      });
  }

  const containerRef = useOverlayA11y<HTMLDivElement>({ open: true, onClose });

  return (
    <div ref={containerRef} className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Restore snapshot"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Restore snapshot</h2>
        <p className="muted">
          Snapshot <code>{snapshot.snapshotId}</code> of folder{" "}
          <code>{snapshot.folderId}</code> will be restored by the target
          device's service.
        </p>
        {loadError ? (
          <InlineError
            message={`Couldn't load online devices — ${loadError}`}
            onRetry={() => setBump((n) => n + 1)}
          />
        ) : null}
        {submitError ? <div className="error">{submitError}</div> : null}
        <label className="form-field">
          Target device
          <select
            value={targetHostId}
            onChange={(e) => setTargetHostId(e.target.value)}
          >
            <option value="">Select a device…</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.hostname}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          Target path
          <input
            type="text"
            value={targetPath}
            onChange={(e) => setTargetPath(e.target.value)}
            placeholder={snapshot.paths[0] ?? "/restore"}
          />
        </label>
        <label className="form-field">
          Include patterns (optional, one per line)
          <textarea
            value={includeText}
            onChange={(e) => setIncludeText(e.target.value)}
            placeholder={"*.conf\n.ssh/"}
            rows={3}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="action" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="action primary"
            disabled={busy || !targetHostId}
            onClick={submit}
          >
            {busy ? "Queuing…" : "Restore"}
          </button>
        </div>
      </div>
    </div>
  );
}
