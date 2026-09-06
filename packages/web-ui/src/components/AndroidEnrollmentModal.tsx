// LAMA-296: "Add Android device" modal — the desktop Android-enrollment flow.
//
// Issues a fresh enrollment (POST /api/v1/mobile/enrollments with the
// explicit webAdmin grant), renders a QR encoding the versioned JSON payload
// (case preserved — never the CLI pairing uppercase path), counts down to
// expiry, and polls GET /api/v1/mobile/enrollments/:id so the card flips to
// the paired-device state the moment the phone exchanges the QR. Polling
// stops at a terminal state (used/expired/revoked) on a modest interval —
// no tight loop. Regenerating creates a new enrollment and the server
// transactionally revokes any still-pending previous one. A paired device
// can be revoked from here (POST /mobile/registrations/:hostId/revoke),
// which cuts both its native identity and its full web-administration
// session.
//
// Copy is explicit about what the QR grants: FULL web administration of the
// fleet (same powers as this desktop session) plus a separate native
// identity for the Android app.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./Modal.tsx";
import { InlineError } from "./InlineError.tsx";
import { api, errorText } from "../api.ts";
import type {
  MobileEnrollmentCreateResponse,
  MobileEnrollmentStatus,
  MobileEnrollmentStatusResponse,
  MobilePairedHostSummary,
} from "@lamasync/core";
import {
  androidEnrollmentPayloadError,
  androidEnrollmentQrSvg,
  formatCountdown,
  secondsUntilEpochMs,
} from "../pairing.ts";

const POLL_MS = 10_000; // status poll while the card is open and pending

export function AndroidEnrollmentModal({ onClose }: { onClose: () => void }) {
  // The current enrollment (the QR being shown). `expiresAt`/`expiresInSeconds`
  // come from the create response; the status poll then tracks server truth.
  const [enrollment, setEnrollment] = useState<MobileEnrollmentCreateResponse | null>(null);
  const [status, setStatus] = useState<MobileEnrollmentStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [revokePending, setRevokePending] = useState<MobilePairedHostSummary | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const mounted = useRef(true);
  // Mirror of the enrollment currently on screen; poll responses from a
  // superseded (regenerated) QR must never overwrite the new one.
  const enrollmentIdRef = useRef<string | null>(null);

  /** Create a fresh enrollment (initial open + regenerate). The server
   *  transactionally revokes any other still-pending enrollment. */
  const create = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setActionError(null);
    try {
      const created = await api.createMobileEnrollment({
        webAdmin: true,
        clientType: "android",
      });
      if (!mounted.current) return;
      enrollmentIdRef.current = created.enrollmentId;
      setEnrollment(created);
      setStatus(null); // restart polling against the new enrollment
      setRevokePending(null);
      setNow(Date.now());
    } catch (err) {
      if (mounted.current) setError(errorText(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void create();
    return () => {
      mounted.current = false;
    };
  }, [create]);

  const effectiveStatus: MobileEnrollmentStatus = status?.status ?? "pending";
  const terminal = status !== null && status.status !== "pending";

  // ---- countdown tick: re-render every second while awaiting a scan ----
  useEffect(() => {
    if (!enrollment || terminal) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [enrollment, terminal]);

  // ---- poll enrollment status while pending (modest interval, stops at a
  // ---- terminal state; transient poll failures are ignored) ----
  useEffect(() => {
    if (!enrollment || terminal) return;
    const currentId = enrollment.enrollmentId;
    const tick = async (): Promise<void> => {
      try {
        const result = await api.getMobileEnrollment(currentId);
        if (!mounted.current || enrollmentIdRef.current !== currentId) return;
        setStatus(result);
      } catch {
        // transient poll failure — the next tick catches a real terminal state
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => window.clearInterval(id);
  }, [enrollment, terminal]);

  const qrPayloadError = useMemo(() => {
    if (!enrollment) return null;
    return androidEnrollmentPayloadError({
      kind: "lamasync.android.enroll",
      version: 1,
      serverOrigin: enrollment.serverOrigin,
      enrollmentId: enrollment.enrollmentId,
      secret: enrollment.secret,
    });
  }, [enrollment]);

  const qrSvg = useMemo(() => {
    if (!enrollment || qrPayloadError !== null) return "";
    return androidEnrollmentQrSvg({
      kind: "lamasync.android.enroll",
      version: 1,
      serverOrigin: enrollment.serverOrigin,
      enrollmentId: enrollment.enrollmentId,
      secret: enrollment.secret,
    });
  }, [enrollment, qrPayloadError]);

  const expiresEpochMs = status?.expiresAt ?? enrollment?.expiresAt ?? 0;
  const remaining = terminal
    ? 0
    : secondsUntilEpochMs(expiresEpochMs, now);
  const expiredLocally = effectiveStatus === "pending" && remaining <= 0;

  const host = status?.host ?? null;
  const revoked = status?.status === "revoked" || (host?.revokedAt ?? null) !== null;

  async function confirmRevoke(): Promise<void> {
    if (!revokePending || !enrollment) return;
    const target = revokePending;
    setRevokePending(null);
    setRevokeBusy(true);
    setActionError(null);
    try {
      await api.revokeMobileRegistration(
        target.hostId,
        "Revoked from the desktop web UI",
      );
      if (!mounted.current) return;
      // Refresh status: the server flips this enrollment to revoked and
      // stamps the host's revokedAt for the audit view.
      const fresh = await api.getMobileEnrollment(enrollment.enrollmentId);
      if (mounted.current) setStatus(fresh);
    } catch (err) {
      if (mounted.current) setActionError(errorText(err));
    } finally {
      if (mounted.current) setRevokeBusy(false);
    }
  }

  return (
    <Modal title="Add Android device" onClose={onClose}>
      {!enrollment && busy ? (
        <div className="pairing-loading" aria-busy="true">
          <div className="skel skel-line" />
          <div className="skel skel-line" />
        </div>
      ) : !enrollment && error ? (
        <>
          <InlineError message={error} onRetry={() => void create()} retryLabel="retry" />
          <div className="modal-actions">
            <button type="button" className="action" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : enrollment ? (
        <div className="pairing-card">
          {/* The QR grants real authority — say so, plainly. */}
          <div className="android-notice" role="note">
            <strong>Scanning grants FULL web administration.</strong> The
            paired phone manages this entire fleet (devices, folders, storage,
            access keys) exactly like this desktop session — no second login —
            and receives its own separate native identity for the Android app.
            Only scan this QR from the phone you are pairing.
          </div>

          {error ? <div className="error">{error}</div> : null}

          {qrPayloadError !== null ? (
            <InlineError
              message={qrPayloadError}
              onRetry={() => void create()}
              retryLabel="new QR"
            />
          ) : !terminal && !revoked ? (
            <>
              <p className="muted">
                On the phone: open the LamaSync Android app and scan this QR.
              </p>
              <div className="pairing-qr">
                <span dangerouslySetInnerHTML={{ __html: qrSvg }} aria-hidden="true" />
              </div>

              <div className="pairing-status">
                <span className={`badge ${statusBadgeClass(effectiveStatus, false)}`}>
                  {statusLabel(effectiveStatus, false)}
                </span>
                {expiredLocally ? (
                  <span className="error">This QR expired — generate a new one.</span>
                ) : (
                  <span className="pairing-countdown mono">
                    expires in {formatCountdown(remaining)}
                  </span>
                )}
              </div>

              <p className="muted android-meta">
                Fleet <code>{enrollment.serverOrigin}</code> · Enrollment{" "}
                <code>{enrollment.enrollmentId}</code>
              </p>
            </>
          ) : (
            <>
              {effectiveStatus === "used" && !revoked && host ? (
                <div className="pairing-claimed">
                  <span className="badge badge-success">device paired</span>
                  <span className="muted">
                    {host.displayName} is connected. This enrollment has been
                    used — you're all set.
                  </span>
                </div>
              ) : (
                <div className="android-notice android-notice--revoked" role="status">
                  <strong>Access revoked.</strong>{" "}
                  {host
                    ? `${host.displayName} (${host.hostId}) can no longer sign in or reach the fleet.`
                    : "This enrollment can no longer be used."}
                  {effectiveStatus === "expired" || expiredLocally
                    ? " The QR expired before a phone scanned it."
                    : ""}
                </div>
              )}

              {host ? <PairedDeviceDetails host={host} /> : null}

              {effectiveStatus === "used" && !revoked ? (
                <p className="muted">
                  Revoking cuts the phone’s full web administration AND its
                  native identity immediately. The app must re-pair with a new
                  QR before it can sign in again.
                </p>
              ) : (
                <p className="muted">
                  Pair the device again with a fresh QR. Any still-pending
                  older QR is voided the moment you generate one.
                </p>
              )}
            </>
          )}

          {actionError ? <div className="error">{actionError}</div> : null}

          {revokePending ? (
            <div className="android-notice android-notice--revoked">
              <strong>
                Revoke {revokePending.displayName} (<code>{revokePending.hostId}</code>)?
              </strong>{" "}
              This immediately cuts its full web administration and native
              identity — including any live session — and cannot be undone
              from the device. Pair it again with a fresh QR to restore
              access.
              <div className="actions">
                <button
                  type="button"
                  className="action"
                  disabled={revokeBusy}
                  onClick={() => setRevokePending(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="action danger"
                  disabled={revokeBusy}
                  onClick={() => void confirmRevoke()}
                >
                  {revokeBusy ? "Revoking…" : "Revoke access"}
                </button>
              </div>
            </div>
          ) : (
            <div className="modal-actions">
              <button type="button" className="action" onClick={onClose}>
                Close
              </button>
              {effectiveStatus === "used" && !revoked && host ? (
                <button
                  type="button"
                  className="action danger"
                  disabled={revokeBusy}
                  onClick={() => setRevokePending(host)}
                >
                  {revokeBusy ? "Revoking…" : "Revoke access"}
                </button>
              ) : (
                <button
                  type="button"
                  className="action primary"
                  disabled={busy}
                  onClick={() => void create()}
                >
                  {busy ? "Generating…" : "Generate new QR"}
                </button>
              )}
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  );
}

/** Identity summary for a paired device, from the enrollment status read. */
function PairedDeviceDetails({ host }: { host: MobilePairedHostSummary }) {
  const paired = new Date(host.createdAt).toLocaleString();
  const lastSeen =
    host.lastSeenAt === null ? "never checked in" : new Date(host.lastSeenAt).toLocaleString();
  return (
    <dl className="paired-device">
      <div>
        <dt>Device</dt>
        <dd>
          <strong>{host.displayName}</strong> <code>{host.hostId}</code>
        </dd>
      </div>
      <div>
        <dt>App</dt>
        <dd>
          {host.clientType} · version {host.appVersion}
        </dd>
      </div>
      <div>
        <dt>Paired</dt>
        <dd>{paired}</dd>
      </div>
      <div>
        <dt>Last seen</dt>
        <dd>{lastSeen}</dd>
      </div>
      {host.revokedAt !== null ? (
        <div>
          <dt>Revoked</dt>
          <dd>{new Date(host.revokedAt).toLocaleString()}</dd>
        </div>
      ) : null}
    </dl>
  );
}

/** Map a status (+revocation flag) to the badge variant used across the UI. */
function statusBadgeClass(status: MobileEnrollmentStatus, revoked: boolean): string {
  if (status === "pending") return "badge-started";
  if (status === "used" && !revoked) return "badge-success";
  return "badge-failed";
}

/** Map a status (+revocation flag) to a human, glossary-safe label. */
function statusLabel(status: MobileEnrollmentStatus, revoked: boolean): string {
  switch (status) {
    case "pending":
      return "Waiting for scan";
    case "used":
      return revoked ? "Access revoked" : "Device paired";
    case "expired":
      return "QR expired";
    case "revoked":
      return "Access revoked";
  }
}
