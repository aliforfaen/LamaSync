// LAMA-234: Admin "Access keys" panel.
//
// - Table of managed keys: label, type, bound device, created, last used,
//   status, masked fingerprint. Normal responses never carry secrets.
// - Create admin key: label → reveal modal with a copy affordance; the
//   secret exists only in component state and is cleared on close.
// - Reveal: explanatory confirmation first (the secret is only recoverable
//   this way), then a no-store modal; cleared on close.
// - Revoke: destructive confirmation with an optional reason; the device
//   receives 401 until re-paired.
// - Migration panel: registered hosts with a device-key binding vs hosts
//   flagged "not enrolled yet" (heuristic — the master key carries no
//   caller identity, so absence is not proof of what a host uses).
// - GET /auth/me: if the browser holds a device key, admin sections are
//   hidden with an explanatory banner instead of a wall of 401s.

import { useEffect, useState } from "react";
import type { ApiKeySummary, AuthMeResponse } from "@lamasync/core";
import { api, errorText } from "../api.ts";
import { ConfirmDialog, Modal } from "./Modal.tsx";
import {
  apiKeyKindLabel,
  apiKeyStatus,
  apiKeyStatusBadge,
  hostEnrollment,
  maskFingerprint,
} from "../access-keys.ts";

export function AccessKeysPanel() {
  const [credential, setCredential] = useState<AuthMeResponse | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [hosts, setHosts] = useState<Array<{ id: string; hostname: string }>>([]);
  const [hostsError, setHostsError] = useState<string | null>(null);

  // Create-admin-key form state.
  const [createName, setCreateName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // The raw secret shown after creation. Lives ONLY here, in component
  // state, and is cleared on close — never persisted anywhere.
  const [createdSecret, setCreatedSecret] = useState<{
    name: string;
    secret: string;
  } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Reveal flow: confirmation target → revealed secret (state-only).
  const [revealTarget, setRevealTarget] = useState<ApiKeySummary | null>(null);
  const [revealBusy, setRevealBusy] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<{
    id: string;
    name: string;
    secret: string;
  } | null>(null);

  // Revoke flow with optional reason.
  const [revokeTarget, setRevokeTarget] = useState<ApiKeySummary | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function loadData(): Promise<void> {
    const problems: string[] = [];
    try {
      setCredential(await api.authMe());
      setCredentialError(null);
    } catch (err) {
      problems.push(`credential: ${errorText(err)}`);
    }
    try {
      setKeys(await api.listApiKeys());
      setKeysError(null);
    } catch (err) {
      problems.push(`keys: ${errorText(err)}`);
    } finally {
      setKeysLoading(false);
    }
    try {
      setHosts(await api.listHosts());
      setHostsError(null);
    } catch (err) {
      problems.push(`hosts: ${errorText(err)}`);
    }
    setKeysError(problems.length > 0 ? problems.join(" — ") : null);
  }

  useEffect(() => {
    void loadData();
  }, []);

  async function onCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const name = createName.trim();
    if (name.length === 0) {
      setCreateError("name is required");
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    setActionError(null);
    try {
      const created = await api.createApiKey(name);
      setCreatedSecret({ name: created.key.name, secret: created.secret });
      setCreateName("");
      const fresh = await api.listApiKeys();
      setKeys(fresh);
    } catch (err) {
      setCreateError(errorText(err));
    } finally {
      setCreateBusy(false);
    }
  }

  function requestCreateSecretClose(): void {
    // Secret lives only in state; dropping the modal clears it.
    setCreatedSecret(null);
    setCopiedId(null);
  }

  function requestReveal(key: ApiKeySummary): void {
    if (key.revokedAt) return; // revoked keys cannot be revealed usefully
    setRevealTarget(key);
  }

  async function confirmReveal(): Promise<void> {
    if (!revealTarget) return;
    const target = revealTarget;
    setRevealTarget(null);
    setRevealBusy(true);
    setActionError(null);
    try {
      const result = await api.revealApiKey(target.id);
      setRevealedSecret({ id: target.id, name: target.name, secret: result.secret });
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setRevealBusy(false);
    }
  }

  function closeRevealedSecret(): void {
    // Same contract as creation: clear the raw secret from state on close.
    setRevealedSecret(null);
    setCopiedId(null);
  }

  async function confirmRevoke(): Promise<void> {
    if (!revokeTarget) return;
    const target = revokeTarget;
    setRevokeTarget(null);
    setRevokeBusy(true);
    setActionError(null);
    try {
      await api.revokeApiKey(target.id, revokeReason.trim() || undefined);
      setRevokeReason("");
      const fresh = await api.listApiKeys();
      setKeys(fresh);
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setRevokeBusy(false);
    }
  }

  async function copyText(text: string, key: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(key);
    } catch {
      setCopiedId("failed");
    }
  }

  // Device keys are confined to their own control-plane calls; admin
  // surfaces (including this panel) would 401. Hide them gracefully.
  if (credential?.kind === "device") {
    return (
      <section className="section">
        <h2>Access keys</h2>
        <p className="muted">
          This browser is authenticated with a <strong>device</strong> key
          (host {credential.hostId ?? "unknown"}), which has no key-management
          access. Use the master or an admin key to manage access keys.
        </p>
      </section>
    );
  }

  const enrollment = hostEnrollment(keys, hosts);

  return (
    <>
      <section className="section">
        <div className="toolbar">
          <h2>Access keys</h2>
          <button type="button" className="action" onClick={() => void loadData()}>
            Refresh
          </button>
        </div>
        {credential?.kind === "admin" ? (
          <p className="muted">
            Active credential: <strong>admin key</strong>{" "}
            {credential.name ? `“${credential.name}”` : ""}. The master key is
            deliberately never listed here or revealable.
          </p>
        ) : null}
        {keysError && <div className="error">{keysError}</div>}
        <form className="form" onSubmit={(e) => void onCreate(e)}>
          <label>
            Create an admin key
            <input
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="e.g. Admin laptop"
              maxLength={64}
            />
          </label>
          <div className="actions">
            <button type="submit" className="action primary" disabled={createBusy}>
              {createBusy ? "Creating…" : "Create admin key"}
            </button>
          </div>
          {createError && <div className="error">{createError}</div>}
        </form>
        <table className="data">
          <thead>
            <tr>
              <th>Label</th>
              <th>Type</th>
              <th>Bound device</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th>Fingerprint</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keysLoading && keys.length === 0 ? (
              <tr aria-busy="true">
                <td colSpan={8}><div className="skel skel-line" /></td>
              </tr>
            ) : keys.length === 0 ? (
              <tr className="empty-row">
                <td colSpan={8}>
                  No managed keys yet. Paired devices mint device keys
                  automatically; create an admin key for laptops / humans.
                </td>
              </tr>
            ) : (
              keys.map((key) => {
                const status = apiKeyStatus(key);
                const forHost = key.hostId
                  ? hosts.find((h) => h.id === key.hostId)
                  : undefined;
                return (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td>
                      <span className={`badge ${key.kind === "device" ? "badge-started" : "badge-success"}`}>
                        {apiKeyKindLabel(key.kind)}
                      </span>
                    </td>
                    <td>
                      {key.hostId ? (
                        <>
                          <code>{key.hostId}</code>
                          {forHost ? (
                            <span className="muted"> ({forHost.hostname})</span>
                          ) : null}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{new Date(key.createdAt).toLocaleString()}</td>
                    <td>
                      {key.lastUsedAt
                        ? new Date(key.lastUsedAt).toLocaleString()
                        : <span className="muted">never</span>}
                    </td>
                    <td>
                      <span className={`badge ${apiKeyStatusBadge(status)}`}>
                        {status === "revoked" ? "revoked" : "active"}
                      </span>
                    </td>
                    <td>
                      <code className="muted">{maskFingerprint(key.fingerprint)}</code>
                    </td>
                    <td>
                      {status === "active" && (
                        <button
                          type="button"
                          className="action"
                          disabled={revealBusy}
                          onClick={() => requestReveal(key)}
                        >
                          Reveal
                        </button>
                      )}
                      <button
                        type="button"
                        className="action"
                        disabled={revokeBusy}
                        onClick={() => setRevokeTarget(key)}
                      >
                        {status === "revoked" ? "Revoked" : "Revoke"}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        {actionError && <div className="error">{actionError}</div>}
      </section>

      <section className="section">
        <h2>Migration</h2>
        <p className="muted">
          Hosts with a managed device-key binding below are enrolled with
          their own credential. Hosts flagged <em>not enrolled yet</em> may
          still be using the shared master key — this is a heuristic, not
          proof, because the master key carries no caller identity.
        </p>
        {hostsError && <div className="error">{hostsError}</div>}
        {hosts.length === 0 ? (
          <p className="muted">No hosts registered.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Host</th>
                <th>Managed device key</th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((host) => {
                const enrolled = enrollment.get(host.id) === true;
                return (
                  <tr key={host.id}>
                    <td>
                      <code>{host.id}</code>
                      <span className="muted"> ({host.hostname})</span>
                    </td>
                    <td>
                      <span className={`badge ${enrolled ? "badge-success" : "badge-conflict"}`}>
                        {enrolled ? "enrolled" : "not enrolled yet"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {createdSecret && (
        <Modal
          title="Admin key created"
          onClose={requestCreateSecretClose}
          footer={
            <>
              <button
                type="button"
                className="action"
                onClick={() => void copyText(createdSecret.secret, `create-${createdSecret.name}`)}
              >
                {copiedId === `create-${createdSecret.name}` ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                className="action primary"
                onClick={requestCreateSecretClose}
              >
                Done
              </button>
            </>
          }
        >
          <p className="muted">
            “{createdSecret.name}” — this is the only time the raw key is
            shown. Store it now; treat it like a password.
          </p>
          <p>
            <code className="secret-line">{createdSecret.secret}</code>
          </p>
        </Modal>
      )}

      {revealTarget && (
        <ConfirmDialog
          title="Reveal secret?"
          danger
          confirmLabel="Reveal"
          message={
            <>
              The raw secret for “{revealTarget.name}” will be shown once.
              It is only recoverable again via another explicit reveal, and
              remains valid until revoked.
            </>
          }
          onConfirm={() => void confirmReveal()}
          onCancel={() => setRevealTarget(null)}
        />
      )}

      {revealedSecret && (
        <Modal
          title="Revealed secret"
          onClose={closeRevealedSecret}
          footer={
            <>
              <button
                type="button"
                className="action"
                onClick={() => void copyText(revealedSecret.secret, revealedSecret.id)}
              >
                {copiedId === revealedSecret.id ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                className="action primary"
                onClick={closeRevealedSecret}
              >
                Done
              </button>
            </>
          }
        >
          <p className="muted">
            “{revealedSecret.name}” — kept in memory only; closing this dialog
            clears it from this page.
          </p>
          <p>
            <code className="secret-line">{revealedSecret.secret}</code>
          </p>
        </Modal>
      )}

      {revokeTarget && (
        <ConfirmDialog
          title="Revoke key?"
          danger
          confirmLabel="Revoke"
          message={
            <>
              <p className="muted">
                Revoking “{revokeTarget.name}” immediately returns 401 to
                everything using it. A revoked device must be re-paired to
                rejoin the fleet. This is not reversible.
              </p>
              <input
                type="text"
                value={revokeReason}
                onChange={(e) => setRevokeReason(e.target.value)}
                placeholder="Reason (optional, kept for audit)"
                maxLength={200}
              />
            </>
          }
          onConfirm={() => void confirmRevoke()}
          onCancel={() => {
            setRevokeTarget(null);
            setRevokeReason("");
          }}
        />
      )}
    </>
  );
}