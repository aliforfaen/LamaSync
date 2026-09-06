// LAMA-296 finding 6: the persistent "Android devices" Admin panel.
//
// Before this panel, the ONLY desktop caller of revokeMobileRegistration was
// the enrollment modal, which knows just the current QR's paired host —
// closing or reloading the page discarded that state, and reopening created
// a fresh QR, so existing registrations had no durable revoke surface (the
// offline-disconnect "revoke from desktop" instruction was unusable through
// the intended UI).
//
// This section instead reads the admin-only projection
// GET /api/v1/mobile/registrations on every mount/refresh (most recent
// first, revoked rows included — the projection carries no secrets, grants,
// hashes, or enrollment ids) and revokes through the existing
// POST /api/v1/mobile/registrations/:hostId/revoke. It lives directly on the
// Admin page, so it survives modal close and page reload, and a revoke only
// needs the row's hostId — never the enrollment id or a fresh QR.
//
// The interactive behavior lives in exported flow helpers / a presentational
// table so bun:test drives the exact production handlers DOM-free (repo
// convention — see pages/apps.test.ts and access-keys.ts).

import { useEffect, useState } from "react";
import type { MobileRegistrationSummary } from "@lamasync/core";
import { api, type AuthMeInfo } from "../api.ts";
import { ConfirmDialog } from "./Modal.tsx";
import { AndroidEnrollmentModal } from "./AndroidEnrollmentModal.tsx";
import {
  DEVICE_REVOKE_REASON,
  loadMobileRegistrations,
  mobileRegistrationBadgeClass,
  mobileRegistrationLabel,
  mobileRegistrationStatus,
  revokeDeviceAndReload,
  type MobileDevicesServices,
} from "../mobile-registrations.ts";

/** The live API client, shaped for the DOM-free flow helpers. */
const mobileDevicesServices: MobileDevicesServices = {
  list: () => api.listMobileRegistrations(),
  revoke: (hostId, reason) => api.revokeMobileRegistration(hostId, reason),
};

export function MobileDevicesPanel() {
  // Credential kind gates the admin surface: device keys cannot manage
  // mobile registrations (server 401/403) — show why instead of errors.
  const [credential, setCredential] = useState<AuthMeInfo | null>(null);
  // `rows === null` = nothing loaded yet (first load pending or failed).
  const [rows, setRows] = useState<MobileRegistrationSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<MobileRegistrationSummary | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showEnrollment, setShowEnrollment] = useState(false);

  /** (Re)load the projection. On failure the current rows stay put and the
   *  error banner explains why; on success rows are replaced and the banner
   *  clears. */
  async function refresh(): Promise<void> {
    const result = await loadMobileRegistrations(mobileDevicesServices);
    if (result.error !== null) {
      setListError(result.error);
    } else {
      setRows(result.rows);
      setListError(null);
    }
  }

  useEffect(() => {
    // Identity probe lets a device-key browser render an explanation instead
    // of a wall of 403s (same pattern as AccessKeysPanel). Independent of
    // the list call: a failure in one must not blank the other.
    void api
      .authMe()
      .then((me) => setCredential(me))
      .catch(() => undefined);
    void refresh();
  }, []);

  /** Called when the enrollment modal closes: re-sync the list so a phone
   *  paired (or revoked) inside the modal shows up immediately. */
  async function onEnrollmentClose(): Promise<void> {
    setShowEnrollment(false);
    await refresh();
  }

  async function confirmRevoke(): Promise<void> {
    if (!revokeTarget) return;
    const target = revokeTarget;
    setRevokeTarget(null);
    setRevokeBusy(true);
    setActionError(null);
    try {
      // Revoke, then reload the projection so the row flips to revoked
      // without a manual refresh (revoke → refresh is the flow contract).
      const result = await revokeDeviceAndReload(
        mobileDevicesServices,
        target.hostId,
        DEVICE_REVOKE_REASON,
      );
      if (result.error !== null) {
        setActionError(result.error);
      } else {
        setRows(result.rows);
        setListError(null);
      }
    } finally {
      setRevokeBusy(false);
    }
  }

  // Device-key browsers have no mobile-management access; render the same
  // style of explanation the access-keys panel uses instead of error walls.
  if (credential?.kind === "device") {
    return (
      <section className="section">
        <h2>Android devices</h2>
        <p className="muted">
          This browser is authenticated with a <strong>device</strong> key
          (host {credential.hostId ?? "unknown"}), which has no
          mobile-registration management access. Use the master or an admin
          key to pair and manage Android devices.
        </p>
      </section>
    );
  }

  return (
    <section className="section">
      <div className="toolbar">
        <h2>Android devices</h2>
        <button type="button" className="action" disabled={revokeBusy} onClick={() => void refresh()}>
          Refresh
        </button>
        <button
          type="button"
          className="action primary"
          onClick={() => setShowEnrollment(true)}
        >
          Add Android device
        </button>
      </div>
      <p className="muted">
        LAMA-296: pair the Android app by QR. Scanning grants that phone{" "}
        <strong>full web administration</strong> of this fleet (no second
        login) plus a separate native identity — one enrollment serves both
        surfaces, and revoking the device cuts both. Paired devices stay
        listed here (most recent first, revoked included) even after this
        page reloads or the pairing modal closes — revoke any of them at any
        time, without the original QR or its enrollment id. Requires an HTTPS
        front door; legacy HTTP/tailnet CLI pairing is unchanged.
      </p>

      <MobileDevicesTable
        rows={rows}
        loading={rows === null && listError === null}
        listError={listError}
        actionError={actionError}
        revokeBusy={revokeBusy}
        onRevoke={(reg) => setRevokeTarget(reg)}
      />

      {revokeTarget ? (
        <ConfirmDialog
          title="Revoke Android device?"
          danger
          confirmLabel="Revoke access"
          message={
            <>
              <p className="muted">
                Revoking <strong>{revokeTarget.displayName}</strong> (
                <code>{revokeTarget.hostId}</code>) immediately cuts its full
                web administration AND its native identity — including any
                live session — and cannot be undone from the device. Pair it
                again with a fresh QR to restore access.
              </p>
              <p className="muted">
                The reason “{DEVICE_REVOKE_REASON}” is recorded for audit.
              </p>
            </>
          }
          onConfirm={() => void confirmRevoke()}
          onCancel={() => setRevokeTarget(null)}
        />
      ) : null}

      {showEnrollment ? (
        <AndroidEnrollmentModal onClose={() => void onEnrollmentClose()} />
      ) : null}
    </section>
  );
}

/**
 * Presentational table for the projection rows. Exported so SSR tests can
 * render active + revoked fixtures, the loading skeleton, and the empty
 * state without a DOM. Never displays secrets, grants, or enrollment ids —
 * the projection itself is the only data source.
 */
export function MobileDevicesTable({
  rows,
  loading,
  listError,
  actionError,
  revokeBusy,
  onRevoke,
}: {
  rows: MobileRegistrationSummary[] | null;
  loading: boolean;
  listError: string | null;
  actionError: string | null;
  revokeBusy: boolean;
  onRevoke: (reg: MobileRegistrationSummary) => void;
}) {
  return (
    <>
      {listError ? <div className="error">{listError}</div> : null}
      <table className="data">
        <thead>
          <tr>
            <th>Device</th>
            <th>App</th>
            <th>Paired</th>
            <th>Last seen</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr aria-busy="true">
              <td colSpan={6}><div className="skel skel-line" /></td>
            </tr>
          ) : rows === null ? (
            // First load failed: the error banner above carries the reason;
            // the Refresh button retries.
            <tr className="empty-row">
              <td colSpan={6}>
                Could not load paired devices. Check the error above and try
                Refresh.
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={6}>
                No Android devices paired yet. Pair one with “Add Android
                device” — it appears here once the phone scans the QR and
                stays listed across reloads.
              </td>
            </tr>
          ) : (
            rows.map((reg) => {
              const status = mobileRegistrationStatus(reg);
              return (
                <tr key={reg.hostId}>
                  <td>
                    <strong>{reg.displayName}</strong>{" "}
                    <code>{reg.hostId}</code>
                  </td>
                  <td>
                    {reg.clientType} · version {reg.appVersion}
                  </td>
                  <td>{new Date(reg.createdAt).toLocaleString()}</td>
                  <td>
                    {reg.lastSeenAt === null ? (
                      <span className="muted">never checked in</span>
                    ) : (
                      new Date(reg.lastSeenAt).toLocaleString()
                    )}
                  </td>
                  <td>
                    <span
                      className={`badge ${mobileRegistrationBadgeClass(status)}`}
                    >
                      {mobileRegistrationLabel(status)}
                    </span>
                    {status === "revoked" && reg.revokedReason ? (
                      <div className="muted">{reg.revokedReason}</div>
                    ) : null}
                  </td>
                  <td>
                    {status === "active" ? (
                      <button
                        type="button"
                        className="action"
                        disabled={revokeBusy}
                        onClick={() => onRevoke(reg)}
                      >
                        {revokeBusy ? "Revoking…" : "Revoke"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
      {actionError ? <div className="error">{actionError}</div> : null}
    </>
  );
}
