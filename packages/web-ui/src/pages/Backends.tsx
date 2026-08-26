import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "../components/PageHeader.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import type { Backend, Folder, FolderSize, S3Provider, StorageReport } from "@lamasync/core";
import { api, errorText } from "../api.ts";
import { ConfirmDialog } from "../components/Modal.tsx";
import { InlineError } from "../components/InlineError.tsx";
import { Donut } from "../components/Donut.tsx";
import { Sparkline } from "../components/Sparkline.tsx";
import { formatBytes } from "../format-bytes.ts";
import { BACKEND_KIND_HINTS } from "../concepts.ts";
import {
  PROVE_NEEDS_RESTIC,
  isRestic,
  proveResultText,
} from "../backup-health.ts";
import type {
  DrillHistory,
  DrillResult,
} from "../api.ts";
import { formatTimeAgo } from "../relative-time.ts";

const PROVIDERS: Array<{ value: S3Provider; label: string }> = [
  { value: "other", label: "Other / S3-compatible" },
  { value: "exoscale", label: "Exoscale" },
  { value: "aws", label: "AWS" },
];

const KINDS = ["s3", "local", "nfs", "restic"];

interface BackendRow extends Backend {
  folderCount?: number;
}

interface FormState {
  name: string;
  kind: string;
  s3Provider: S3Provider;
  s3Endpoint: string;
  s3Region: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  localPath: string;
  resticRepository: string;
  resticPassword: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  kind: "s3",
  s3Provider: "other",
  s3Endpoint: "",
  s3Region: "",
  s3AccessKeyId: "",
  s3SecretAccessKey: "",
  localPath: "",
  resticRepository: "",
  resticPassword: "",
};

function backendToForm(b: Backend): FormState {
  return {
    name: b.name,
    kind: b.kind,
    s3Provider: b.s3Provider ?? "other",
    s3Endpoint: b.s3Endpoint ?? "",
    s3Region: b.s3Region ?? "",
    s3AccessKeyId: b.s3AccessKeyId ?? "",
    s3SecretAccessKey: "",
    localPath: b.localPath ?? "",
    resticRepository: b.resticRepository ?? "",
    resticPassword: "",
  };
}

/**
 * UX workstream 4: client-side checks that mirror the server's validation
 * (endpoint URL, absolute server path, required restic repo) so bad input is
 * caught before a round-trip. Returns the first error message or null.
 */
function validateForm(form: FormState): string | null {
  if (form.name.trim() === "") return "name is required";
  if (form.kind === "s3") {
    const endpoint = form.s3Endpoint.trim();
    if (endpoint === "") return "s3 endpoint is required";
    if (/\s/.test(endpoint)) return "s3 endpoint must not contain spaces";
    // Bare hostnames are accepted (placeholder suggests both forms); a
    // scheme, when present, must be http or https.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(endpoint)) {
      if (!/^https?:\/\//.test(endpoint)) {
        return "s3 endpoint must use http(s) — got an unsupported scheme";
      }
    }
    if (form.s3AccessKeyId.trim() === "") return "s3 access key id is required";
  } else if (form.kind === "local" || form.kind === "nfs") {
    if (!form.localPath.trim().startsWith("/")) {
      return "server path must be an absolute path (starts with /)";
    }
  } else if (form.kind === "restic") {
    if (form.resticRepository.trim() === "") return "restic repository is required";
  }
  return null;
}

export function Backends() {
  const [items, setItems] = useState<BackendRow[] | null>(null);
  // LAMA-269: data for the per-destination donut + growth sparkline.
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderSizes, setFolderSizes] = useState<Record<string, FolderSize>>({});
  const [storageHistory, setStorageHistory] = useState<
    Record<string, Array<{ measuredAt: number; bytes: number | null }>>
  >({});
  const [storageReport, setStorageReport] = useState<StorageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // P-A: auxiliary stats fetches (sizes / history / report / drills) are
  // best-effort — a failure must not collapse into a misleading
  // "Not measured yet" / "No fire drills yet" state, so it surfaces as an
  // inline caption with a retry instead.
  const [auxError, setAuxError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  // LAMA-266: "Prove it" + fire-drill buttons per restic destination. Busy
  // tracks which backend is mid-run (one at a time); resultLines hold the
  // inline status text per backend id.
  const [healthBusy, setHealthBusy] = useState<string | null>(null);
  const [healthResults, setHealthResults] = useState<Record<string, string>>({});
  const [drills, setDrills] = useState<DrillHistory["drills"] | null>(null);
  // LAMA-238: in-form connection test for an unsaved backend config.
  const [formTesting, setFormTesting] = useState(false);
  const [formTestResult, setFormTestResult] = useState<{
    ok: boolean;
    detail?: string;
  } | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [showResticPassword, setShowResticPassword] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // UX workstream 4: styled delete confirmation.
  const [deleteTarget, setDeleteTarget] = useState<BackendRow | null>(null);
  // LAMA-271: the empty-state CTA scrolls to (and focuses) the existing
  // add-storage-destination form at the top of the page.
  const formRef = useRef<HTMLElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    setAuxError(null);
    try {
      const [backendList, folderList, sizes, history, report, drillHistory] =
        await Promise.all([
          api.listBackends(),
          api.listFolders().catch(() => {
            setAuxError("Some details couldn't load — showing what we have.");
            return [] as Folder[];
          }),
          api.folderSizes().catch(() => {
            setAuxError("Some details couldn't load — showing what we have.");
            return {} as Record<string, FolderSize>;
          }),
          api.storageHistory().catch(() => {
            setAuxError("Some details couldn't load — showing what we have.");
            return { backends: {} };
          }),
          api.storageReport().catch(() => {
            setAuxError("Some details couldn't load — showing what we have.");
            return null;
          }),
          api.listHealthDrills(10).catch(() => {
            setAuxError("Some details couldn't load — showing what we have.");
            return { drills: [] };
          }),
        ]);
      setItems(backendList);
      setFolders(folderList);
      setFolderSizes(sizes);
      setStorageHistory(history.backends);
      setStorageReport(report);
      setDrills(drillHistory.drills);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    // UX workstream 4: client-side validation before the round-trip.
    const validationError = validateForm(form);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (editingId) {
        await api.updateBackend(editingId, {
          name: form.name,
          s3Provider: form.s3Provider,
          s3Endpoint: form.s3Endpoint,
          s3Region: form.s3Region,
          s3AccessKeyId: form.s3AccessKeyId,
          s3SecretAccessKey: form.s3SecretAccessKey || undefined,
          localPath: form.localPath || undefined,
          resticRepository: form.resticRepository || undefined,
          resticPassword: form.resticPassword || undefined,
        });
        setNotice("Storage destination updated");
      } else {
        await api.createBackend({
          name: form.name,
          kind: form.kind as Backend["kind"],
          s3Provider: form.s3Provider,
          s3Endpoint: form.s3Endpoint,
          s3Region: form.s3Region,
          s3AccessKeyId: form.s3AccessKeyId,
          s3SecretAccessKey: form.s3SecretAccessKey,
          localPath: form.localPath,
          resticRepository: form.resticRepository,
          resticPassword: form.resticPassword,
        });
        setNotice("Storage destination created");
      }
      setForm(EMPTY_FORM);
      setEditingId(null);
      setFormTestResult(null);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  // LAMA-238: test the form's current values against the server without
  // saving. Write-only fields fall back to the stored secret/password when
  // editing an existing backend, so an edit that leaves them untouched
  // still exercises the real config.
  async function onTestForm(): Promise<void> {
    if (busy || formTesting) return;
    const validationError = validateForm(form);
    if (validationError) {
      setError(validationError);
      setFormTestResult(null);
      return;
    }
    // The browser only enforces `required` on submit, not on a plain
    // button click — mirror the server's create-side checks here.
    if (!editingId && form.kind === "s3" && form.s3SecretAccessKey.trim() === "") {
      setError("s3 secret access key is required");
      setFormTestResult(null);
      return;
    }
    if (!editingId && form.kind === "restic" && form.resticPassword.trim() === "") {
      setError("restic password is required");
      setFormTestResult(null);
      return;
    }
    setFormTesting(true);
    setError(null);
    setFormTestResult(null);
    try {
      const res = await api.testBackendDraft({
        kind: form.kind,
        backendId: editingId ?? undefined,
        s3Provider: form.s3Provider,
        s3Endpoint: form.s3Endpoint,
        s3Region: form.s3Region,
        s3AccessKeyId: form.s3AccessKeyId,
        s3SecretAccessKey: form.s3SecretAccessKey || undefined,
        localPath: form.localPath || undefined,
        resticRepository: form.resticRepository || undefined,
        resticPassword: form.resticPassword || undefined,
      });
      setFormTestResult(res);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setFormTesting(false);
    }
  }

  function startEdit(b: BackendRow): void {
    setEditingId(b.id);
    setForm(backendToForm(b));
    setError(null);
    setFormTestResult(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEdit(): void {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setError(null);
    setFormTestResult(null);
  }

  async function onDelete(b: BackendRow): Promise<void> {
    setDeleteTarget(b);
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) return;
    const b = deleteTarget;
    setDeleteTarget(null);
    try {
      await api.deleteBackend(b.id);
      setNotice(`Storage destination '${b.name}' deleted`);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function onTest(b: BackendRow): Promise<void> {
    setTestingId(b.id);
    setError(null);
    try {
      const res = await api.testBackend(b.id);
      setTestResult((prev) => ({
        ...prev,
        [b.id]: res.ok ? "✓ connection ok" : `✗ ${res.detail ?? "failed"}`,
      }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setTestingId(null);
    }
  }

  // LAMA-266: "Prove it" — restore one random file from the destination's
  // latest restic snapshot and diff it. On success we refresh backends so
  // the lastProveAt/lastProveOk columns drive the Dashboard badge.
  async function onProve(b: BackendRow): Promise<void> {
    if (healthBusy) return;
    setHealthBusy(b.id);
    setError(null);
    try {
      const res = await api.proveBackend(b.id);
      setHealthResults((prev) => ({
        ...prev,
        [b.id]: proveResultText({
          kind: "prove",
          ok: res.ok,
          file: res.file,
          durationMs: res.durationMs,
          detail: res.detail,
        }),
      }));
      await refresh();
    } catch (err) {
      setHealthResults((prev) => ({
        ...prev,
        [b.id]: `✗ Prove failed: ${errorText(err)}`,
      }));
    } finally {
      setHealthBusy(null);
    }
  }

  // LAMA-266: fire drill — liveness probe + prove-it restore + audit row.
  // Result writes through to the drills history (refreshed here) and the
  // backend's lastProveAt/_ok columns.
  async function onDrill(b: BackendRow): Promise<void> {
    if (healthBusy) return;
    setHealthBusy(b.id);
    setError(null);
    try {
      const res: DrillResult = await api.runDrill(b.id);
      setHealthResults((prev) => ({
        ...prev,
        [b.id]: proveResultText({
          kind: "drill",
          ok: res.ok,
          file: res.file,
          durationMs: res.durationMs,
          detail: res.detail,
        }),
      }));
      await refresh();
    } catch (err) {
      setHealthResults((prev) => ({
        ...prev,
        [b.id]: `✗ Fire drill failed: ${errorText(err)}`,
      }));
    } finally {
      setHealthBusy(null);
    }
  }

  // LAMA-266: clear the inline status once the user has read it (keeps the
  // Actions cell from growing stale lines after edits).
  function dismissHealth(b: BackendRow): void {
    setHealthResults((prev) => {
      const next = { ...prev };
      delete next[b.id];
      return next;
    });
  }

  // LAMA-269: per-destination storage picture. The donut composes the
  // destination from its folders (sized via /folders/sizes); the sparkline
  // plots the destination's total growth from /stats/storage/history. When
  // nothing has been measured we show an explicit state rather than a fake
  // zero (non-S3 backends are never measurable server-side).
  function renderStorageCell(b: BackendRow) {
    const destFolders = folders.filter((f) => f.backendId === b.id);
    const slices = destFolders
      .map((f) => ({ label: f.name, value: folderSizes[f.id]?.bytes ?? 0 }))
      .filter((s) => s.value > 0);
    const measured = destFolders.some((f) => folderSizes[f.id]?.bytes != null);
    const historyPts = (storageHistory[b.id] ?? [])
      .map((p) => p.bytes)
      .filter((v): v is number => v != null);
    if (!measured && historyPts.length === 0) {
      return <span className="muted">Not measured yet</span>;
    }
    const reportBytes =
      storageReport?.backends.find((x) => x.backendId === b.id)?.bytes ?? null;
    const center = reportBytes ?? slices.reduce((acc, s) => acc + s.value, 0);
    return (
      <div className="storage-cell">
        <Donut
          data={slices}
          size={56}
          thickness={9}
          centerLabel={formatBytes(center)}
          ariaLabel={`${b.name} storage breakdown`}
        />
        <Sparkline
          data={historyPts}
          width={96}
          height={28}
          ariaLabel={`${b.name} storage growth`}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title="Storage destinations" purpose="Where your data lives — S3 buckets, local disks, NFS mounts, and restic repositories." />
<div className="toolbar">
        <span className="muted">
          {items ? `${items.length} configured` : "loading…"}
        </span>
      </div>
      {error && (
        <InlineError message={error} onRetry={() => void refresh()} />
      )}
      {auxError ? (
        <InlineError message={auxError} onRetry={() => void refresh()} />
      ) : null}
      {notice && <div className="all-quiet">{notice}</div>}

      <section className="section" ref={formRef}>
        <h2>{editingId ? `Edit destination: ${form.name}` : "Add storage destination"}</h2>
        <form className="form" onSubmit={onSubmit}>
          <div className="form-row">
            <label>
              Name
              <input
                ref={nameInputRef}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="e.g. Prod R2, cold-archive"
                required
              />
            </label>
            <label>
              Kind
              <select value={form.kind} onChange={(e) => set("kind", e.target.value)}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {form.kind === "s3" ? (
            <>
              <div className="form-row">
                <label>
                  Provider
                  <select
                    value={form.s3Provider}
                    onChange={(e) => set("s3Provider", e.target.value as S3Provider)}
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Endpoint
                  <input
                    value={form.s3Endpoint}
                    onChange={(e) => set("s3Endpoint", e.target.value)}
                    placeholder="sos-zone.exo.io or https://…"
                    required={form.kind === "s3"}
                  />
                </label>
              </div>
              <div className="form-row">
                <label>
                  Region
                  <input
                    value={form.s3Region}
                    onChange={(e) => set("s3Region", e.target.value)}
                    placeholder="us-east-1 (AWS only)"
                  />
                </label>
                <label>
                  Access key ID
                  <input
                    value={form.s3AccessKeyId}
                    onChange={(e) => set("s3AccessKeyId", e.target.value)}
                    autoComplete="off"
                    required={form.kind === "s3"}
                  />
                </label>
              </div>
              <div className="form-row">
                <label>
                  Secret access key
                  <input
                    type="password"
                    value={form.s3SecretAccessKey}
                    onChange={(e) => set("s3SecretAccessKey", e.target.value)}
                    autoComplete="new-password"
                    placeholder={editingId ? "leave blank to keep the stored secret" : ""}
                    required={!editingId}
                  />
                </label>
                {editingId ? (
                  <label>
                    &nbsp;
                    <button type="button" className="action" onClick={cancelEdit}>
                      Cancel edit
                    </button>
                  </label>
                ) : null}
              </div>
            </>
          ) : form.kind === "local" || form.kind === "nfs" ? (
            <>
              <div className="form-row">
                <label>
                  Server path
                  <input
                    value={form.localPath}
                    onChange={(e) => set("localPath", e.target.value)}
                    placeholder="/mnt/disk1 or /srv/nfs/home"
                    required
                  />
                </label>
                <label>
                  &nbsp;
                  <button type="button" className="action" onClick={cancelEdit}>
                    Cancel edit
                  </button>
                </label>
              </div>
              <p className="muted">{BACKEND_KIND_HINTS[form.kind]}</p>
            </>
          ) : form.kind === "restic" ? (
            <>
              <div className="form-row">
                <label>
                  Repository
                  <input
                    value={form.resticRepository}
                    onChange={(e) => set("resticRepository", e.target.value)}
                    placeholder="s3:endpoint/bucket or /srv/restic-repo"
                    required
                  />
                </label>
                <label>
                  Password
                  <span className="tailnet-ip">
                    <input
                      type={showResticPassword ? "text" : "password"}
                      value={form.resticPassword}
                      onChange={(e) => set("resticPassword", e.target.value)}
                      autoComplete="new-password"
                      placeholder={editingId ? "leave blank to keep the stored password" : ""}
                      required={!editingId}
                    />
                    <button
                      type="button"
                      className="copy-btn"
                      onClick={() => setShowResticPassword((v) => !v)}
                      title={showResticPassword ? "Hide password" : "Show password"}
                      aria-label={showResticPassword ? "Hide password" : "Show password"}
                    >
                      {showResticPassword ? "🙈" : "👁"}
                    </button>
                  </span>
                </label>
              </div>
              {editingId ? (
                <p className="muted">
                  Password stored: {form.resticPassword === "" ? "kept as-is on save" : "will be replaced on save"}
                </p>
              ) : null}
              <p className="muted">
                {BACKEND_KIND_HINTS.restic} Per-assignment overrides keep working.
              </p>
            </>
          ) : (
            <p className="muted">
              {form.kind} destinations are reserved for future use — no extra fields yet.
            </p>
          )}
          <div className="form-row actions-row">
            <button type="submit" className="action primary" disabled={busy || formTesting}>
              {busy ? "Saving…" : editingId ? "Save changes" : "Create destination"}
            </button>
            <button
              type="button"
              className="action"
              disabled={busy || formTesting}
              onClick={() => void onTestForm()}
              title="Check connectivity against the server before saving"
            >
              {formTesting ? "Testing…" : "Test connection"}
            </button>
          </div>
          {formTestResult ? (
            <div
              className={formTestResult.ok ? "all-quiet" : "error"}
              role={formTestResult.ok ? "status" : "alert"}
            >
              {formTestResult.ok ? "✓ " : "✗ "}
              {formTestResult.detail ?? (formTestResult.ok ? "connection ok" : "connection failed")}
            </div>
          ) : null}
        </form>
      </section>

      <section className="section">
        <h2>Configured destinations</h2>
        {!items ? (
          <div className="skel skel-line" aria-busy="true" />
        ) : items.length === 0 ? (
          <EmptyState
            variant="storage"
            glyph="llama-sit"
            title="No storage destinations yet"
            how="Add where your data lives — S3 buckets, local disks, NFS exports, or a restic repository."
            ctaLabel="Add a storage destination"
            onCta={() => {
              formRef.current?.scrollIntoView({ block: "start" });
              nameInputRef.current?.focus();
            }}
            steps={[
              "Pick a kind: S3, local, NFS, or restic",
              "Enter the connection details",
              "Test it — then point folders at it",
            ]}
            timeNote="takes 30s"
          />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Provider</th>
                <th>Endpoint</th>
                <th>Access key</th>
                <th>Secret</th>
                <th>Folders</th>
                <th>Storage</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((b) => (
                <tr key={b.id}>
                  <td>
                    <strong>{b.name}</strong>
                  </td>
                  <td>
                    <span className={`badge badge-${b.kind}`}>{b.kind}</span>
                  </td>
                  <td>{b.kind === "s3" ? (b.s3Provider ?? "—") : "—"}</td>
                  <td className="muted">
                    {b.kind === "local" || b.kind === "nfs" ? (
                      <code title={`server path (${b.kind})`}>{b.localPath ?? "—"}</code>
                    ) : b.kind === "restic" ? (
                      <code title="restic repository">{b.resticRepository ?? "—"}</code>
                    ) : (
                      <code>{b.s3Endpoint ?? "—"}</code>
                    )}
                  </td>
                  <td>
                    {b.kind === "s3" && b.s3AccessKeyId ? (
                      <span className="tailnet-ip">
                        <code>
                          {revealed[b.id]
                            ? b.s3AccessKeyId
                            : `${b.s3AccessKeyId.slice(0, 4)}…${b.s3AccessKeyId.slice(-4)}`}
                        </code>
                        <button
                          type="button"
                          className="copy-btn"
                          title="Show access key"
                          aria-label="Show access key"
                          onClick={() =>
                            setRevealed((prev) => ({ ...prev, [b.id]: !prev[b.id] }))
                          }
                        >
                          {revealed[b.id] ? "🙈" : "👁"}
                        </button>
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    {b.kind === "s3" ? (
                      b.hasSecret ? <span className="badge badge-ok">✓</span> : <span className="muted">—</span>
                    ) : b.kind === "restic" ? (
                      b.hasResticPassword ? <span className="badge badge-ok">✓</span> : <span className="muted">—</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{b.folderCount ?? 0}</td>
                  <td>{renderStorageCell(b)}</td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="action" onClick={() => startEdit(b)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="action"
                        disabled={testingId === b.id}
                        onClick={() => void onTest(b)}
                      >
                        {testingId === b.id ? "Testing…" : "Test"}
                      </button>
                      {isRestic(b.kind) ? (
                        <>
                          <button
                            type="button"
                            className="action"
                            disabled={healthBusy !== null}
                            onClick={() => void onProve(b)}
                          >
                            {healthBusy === b.id ? "Proving…" : "Prove it"}
                          </button>
                          <button
                            type="button"
                            className="action"
                            disabled={healthBusy !== null}
                            onClick={() => void onDrill(b)}
                          >
                            {healthBusy === b.id ? "Drilling…" : "Run fire drill"}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="action"
                          disabled
                          title={PROVE_NEEDS_RESTIC}
                          aria-label={`Prove it — ${PROVE_NEEDS_RESTIC}`}
                        >
                          Prove it
                        </button>
                      )}
                      <button type="button" className="action danger" onClick={() => void onDelete(b)}>
                        Delete
                      </button>
                    </div>
                    {healthResults[b.id] ? (
                      <div className="row-actions health-result">
                        <span
                          className={healthResults[b.id].startsWith("✓") ? "all-quiet-inline" : "error-inline"}
                          role={healthResults[b.id].startsWith("✓") ? "status" : "alert"}
                        >
                          {healthResults[b.id]}
                        </span>
                        <button
                          type="button"
                          className="copy-btn"
                          title="Dismiss"
                          aria-label="Dismiss result"
                          onClick={() => dismissHealth(b)}
                        >
                          ✕
                        </button>
                      </div>
                    ) : null}
                    {testResult[b.id] ? (
                      <div className="muted">{testResult[b.id]}</div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2>Backup fire-drill history</h2>
        {drills === null ? (
          <div className="skel skel-line" aria-busy="true" />
        ) : drills.length === 0 ? (
          <p className="muted">
            No fire drills yet — run one from a restic destination's row above
            to prove restores work end to end.
          </p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Destination</th>
                <th>Type</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {drills.map((d) => (
                <tr key={d.id}>
                  <td>{formatTimeAgo(new Date(d.ranAt).getTime())}</td>
                  <td>
                    <strong>{d.backendName}</strong>
                  </td>
                  <td className="muted">{d.kind === "drill" ? "fire drill" : "prove"}</td>
                  <td>
                    <span className={`badge ${d.ok ? "badge-success" : "badge-failed"}`}>
                      {d.ok ? "ok" : "failed"}
                    </span>
                    {d.detail ? (
                      <span className="muted" title={d.detail}>
                        {" "}
                        · {d.detail}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {deleteTarget && (
        <ConfirmDialog
          title="Delete storage destination"
          danger
          confirmLabel="Delete"
          message={`Delete storage destination "${deleteTarget.name}"?${
            (deleteTarget.folderCount ?? 0) > 0
              ? ` It is used by ${deleteTarget.folderCount} folder(s) — the server will refuse while it is.`
              : ""
          }`}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
