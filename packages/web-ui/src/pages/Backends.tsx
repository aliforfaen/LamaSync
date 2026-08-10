import { useCallback, useEffect, useState } from "react";
import type { Backend, S3Provider } from "@lamasync/core";
import { api, errorText } from "../api.ts";
import { ConfirmDialog } from "../components/Modal.tsx";
import { BACKEND_KIND_HINTS } from "../concepts.ts";

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
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [showResticPassword, setShowResticPassword] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // UX workstream 4: styled delete confirmation.
  const [deleteTarget, setDeleteTarget] = useState<BackendRow | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setItems(await api.listBackends());
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
        setNotice("Backend updated");
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
        setNotice("Backend created");
      }
      setForm(EMPTY_FORM);
      setEditingId(null);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(b: BackendRow): void {
    setEditingId(b.id);
    setForm(backendToForm(b));
    setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
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
      setNotice(`Backend '${b.name}' deleted`);
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

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Backends</h1>
        <span className="muted">
          {items ? `${items.length} configured` : "loading…"}
        </span>
      </div>
      {error && <div className="error">{error}</div>}
      {notice && <div className="all-quiet">{notice}</div>}

      <section className="section">
        <h2>{editingId ? `Edit backend: ${form.name}` : "Add backend"}</h2>
        <form className="form" onSubmit={onSubmit}>
          <div className="form-row">
            <label>
              Name
              <input
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
                    <button
                      type="button"
                      className="action"
                      onClick={() => {
                        setForm(EMPTY_FORM);
                        setEditingId(null);
                      }}
                    >
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
                  <button
                    type="button"
                    className="action"
                    onClick={() => {
                      setForm(EMPTY_FORM);
                      setEditingId(null);
                    }}
                  >
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
              {form.kind} backends are reserved for future use — no extra fields yet.
            </p>
          )}
          <button type="submit" className="action primary" disabled={busy}>
            {busy ? "Saving…" : editingId ? "Save changes" : "Create backend"}
          </button>
        </form>
      </section>

      <section className="section">
        <h2>Configured backends</h2>
        {!items ? (
          <div className="empty-row">Loading…</div>
        ) : items.length === 0 ? (
          <div className="empty-row">
            No backends yet. Create one above, then point S3 folders at it —
            the folder form only asks for the bucket name.
          </div>
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
                      <button type="button" className="action danger" onClick={() => void onDelete(b)}>
                        Delete
                      </button>
                    </div>
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

      {deleteTarget && (
        <ConfirmDialog
          title="Delete backend"
          danger
          confirmLabel="Delete"
          message={`Delete backend "${deleteTarget.name}"?${
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
