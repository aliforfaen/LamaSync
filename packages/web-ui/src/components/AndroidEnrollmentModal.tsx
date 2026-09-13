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
// LAMA-337: the same modal serves the per-device "Reconnect QR" action. In
// that mode it asks for a reconnect enrollment targeted at an EXISTING
// registration (POST /mobile/registrations/:hostId/reconnect-enrollment): the
// QR payload is byte-identical in shape, and exchanging it rotates the
// device's credentials in place — same host id, same inboxes, same upload
// history, previous session signed out. Creating the QR is inert, so the
// copy says plainly that closing the window or letting it expire changes
// nothing. Revoke stays on the panel row (this modal never destroys a device
// in reconnect mode).
//
// Copy is explicit about what the QR grants: FULL web administration of the
// fleet (same powers as this desktop session) plus a separate native
// identity for the Android app.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./Modal.tsx";
import { InlineError } from "./InlineError.tsx";
import { api, errorText } from "../api.ts";
import { startReconnectEnrollment } from "../mobile-registrations.ts";
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

/** What an existing registration looks like to the reconnect flow. */
export interface ReconnectTarget {
  hostId: string;
  displayName: string;
}

export interface AndroidEnrollmentModalProps {
  onClose: () => void;
  /** LAMA-337: reconnect an existing registration instead of pairing a new
   *  one. Omitted → the regular "Add Android device" flow. */
  reconnect?: ReconnectTarget;
  /** Called once when a reconnect QR is claimed, so the panel can refresh the
   *  device projection without waiting for the modal to close. */
  onReconnected?: () => void;
}

const reconnectServices = {
  createReconnect: (hostId: string) => api.createMobileReconnectEnrollment(hostId),
};

export function AndroidEnrollmentModal({
  onClose,
  reconnect,
  onReconnected,
}: AndroidEnrollmentModalProps) {
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
  // A reconnect QR is claimed once: tell the panel exactly once, then let the
  // card keep rendering the connected state.
  const reconnectedNotified = useRef(false);

  /** Create a fresh enrollment (initial open + regenerate). For a pairing QR
   *  the server transactionally revokes any other still-pending pairing QR;
   *  for a reconnect QR it supersedes only this device's earlier pending
   *  reconnect QR. */
  const create = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setActionError(null);
    try {
      let created: MobileEnrollmentCreateResponse | null;
      if (reconnect) {
        // The helper turns a failure into text; a failed reconnect request
        // creates no QR and leaves the device exactly as it was.
        const result = await startReconnectEnrollment(reconnectServices, reconnect.hostId);
        if (result.error !== null) {
          if (mounted.current) setError(result.error);
          return;
        }
        created = result.enrollment;
      } else {
        created = await api.createMobileEnrollment({ webAdmin: true, clientType: "android" });
      }
      if (created === null || !mounted.current) return;
      enrollmentIdRef.current = created.enrollmentId;
      setEnrollment(created);
      setStatus(null); // restart polling against the new enrollment
      setRevokePending(null);
      setNow(Date.now());
      // A regenerated reconnect QR is a fresh claim: let it notify the panel too.
      reconnectedNotified.current = false;
    } catch (err) {
      if (mounted.current) setError(errorText(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [reconnect]);

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
  // LAMA-337: reconnect mode reuses the whole card; only the copy and the
  // revoke affordance differ.
  const reconnectTarget = reconnect ?? null;
  const reconnecting = reconnectTarget !== null;
  // LAMA-337 review: the enrollment's lifecycle and the DEVICE's access are
  // two different things. An expired QR, or one superseded by a newer QR,
  // leaves a perfectly working registration behind, so the card must not call
  // that "access revoked"; only the registration's own revokedAt does.
  const outcome = enrollmentCardState({
    status: effectiveStatus,
    expiredLocally,
    host,
  });

  // Tell the panel once when the device has claimed a reconnect QR, so the
  // device row (last-seen, app version, display name) refreshes immediately.
  useEffect(() => {
    if (!reconnecting || status?.status !== "used" || reconnectedNotified.current) return;
    reconnectedNotified.current = true;
    onReconnected?.();
  }, [reconnecting, status, onReconnected]);

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
    <Modal title={enrollmentModalTitle(reconnectTarget)} onClose={onClose}>
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
          <EnrollmentNotice reconnect={reconnectTarget} />

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
                {reconnecting
                  ? "On the phone: open the LamaSync Android app and scan this QR on the device you are reconnecting."
                  : "On the phone: open the LamaSync Android app and scan this QR."}
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
              {outcome === "paired" && host ? (
                <div className="pairing-claimed">
                  <span className="badge badge-success">
                    {reconnecting ? "device reconnected" : "device paired"}
                  </span>
                  <span className="muted">
                    {reconnecting
                      ? `${host.displayName} is back on its existing identity. Its credentials were rotated and its previous session was signed out.`
                      : `${host.displayName} is connected. This enrollment has been used — you're all set.`}
                  </span>
                </div>
              ) : (
                <EnrollmentOutcomeNotice
                  state={outcome}
                  reconnect={reconnectTarget}
                  host={host}
                />
              )}

              {host ? <PairedDeviceDetails host={host} /> : null}

              <p className="muted">{enrollmentOutcomeCopy(outcome, reconnecting)}</p>
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
              {/* Revoke stays on the device row in reconnect mode: this card
                  exists to restore the identity, not to destroy it. */}
              {!reconnecting && outcome === "paired" && host ? (
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
                  {busy ? "Generating…" : reconnecting ? "New reconnect QR" : "Generate new QR"}
                </button>
              )}
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  );
}

/** Modal title for each mode (exported so the copy is covered by tests). */
export function enrollmentModalTitle(reconnect: ReconnectTarget | null): string {
  return reconnect ? "Reconnect Android device" : "Add Android device";
}

/**
 * Where an enrollment card has ended up. Two of these are about the QR and two
 * are about the DEVICE — the distinction the LAMA-337 review caught: an expired
 * or superseded QR leaves a live registration untouched, so it must never be
 * reported as revoked access.
 *
 *   pending        the QR is on screen, waiting for a scan
 *   paired         claimed, and the registration is live
 *   qr-expired     the QR expired (or locally did) before a scan — nothing changed
 *   qr-superseded  the QR was voided (a newer QR replaced it) — nothing changed
 *   device-revoked the REGISTRATION's access was revoked (or the registration
 *                  is gone entirely)
 */
export type EnrollmentCardState =
  | "pending"
  | "paired"
  | "qr-expired"
  | "qr-superseded"
  | "device-revoked";

/**
 * Classify the card from server truth. `host.revokedAt` is the ONLY signal that
 * means the device lost access; the enrollment's own revoked/expired status
 * says something about the QR, not about the phone.
 */
export function enrollmentCardState(opts: {
  status: MobileEnrollmentStatus;
  expiredLocally: boolean;
  host: MobilePairedHostSummary | null;
}): EnrollmentCardState {
  if (opts.status === "pending") return opts.expiredLocally ? "qr-expired" : "pending";
  if (opts.status === "expired") return "qr-expired";
  if ((opts.host?.revokedAt ?? null) !== null) return "device-revoked";
  if (opts.status === "used") {
    // Used with no registration row left (the host was deleted) — the device
    // really is gone, so this is a device-level outcome, not a QR one.
    return opts.host === null ? "device-revoked" : "paired";
  }
  // A revoked enrollment row whose device is still live: this QR was voided.
  return "qr-superseded";
}

/**
 * Terminal-state notice for the card. A QR-level outcome is explicitly
 * harmless ("the device is unchanged"), while a device-level one says the
 * registration can no longer sign in. Presentational + exported so both modes'
 * copy is tested without a DOM.
 */
export function EnrollmentOutcomeNotice({
  state,
  reconnect,
  host,
}: {
  state: EnrollmentCardState;
  reconnect: ReconnectTarget | null;
  host: MobilePairedHostSummary | null;
}) {
  if (state === "pending" || state === "paired") return null;
  if (state === "device-revoked") {
    return (
      <div className="android-notice android-notice--revoked" role="status">
        <strong>Access revoked.</strong>{" "}
        {host
          ? `${host.displayName} (${host.hostId}) can no longer sign in or reach the fleet.`
          : "This device is no longer registered on the fleet."}
      </div>
    );
  }
  const expired = state === "qr-expired";
  return (
    <div className="android-notice" role="status">
      <strong>
        {expired ? "This QR expired before a phone scanned it." : "This QR is no longer valid."}
      </strong>{" "}
      {reconnect
        ? "The device is unchanged and still works — show a new reconnect QR when you want to rotate its credentials."
        : "No device was paired, and nothing else changed."}
    </div>
  );
}

/**
 * The guidance line under a terminal card. Kept in sync with the notice above:
 * only `device-revoked` talks about losing access, and the QR-level outcomes
 * always state that the device keeps working (reconnect) or that nothing was
 * paired (new installation).
 */
export function enrollmentOutcomeCopy(state: EnrollmentCardState, reconnect: boolean): string {
  switch (state) {
    case "paired":
      return reconnect
        ? "The device keeps its inboxes and upload history. The old session — on that phone or anywhere else — no longer signs in."
        : "Revoking cuts the phone's full web administration AND its native identity immediately. The app must re-pair with a new QR before it can sign in again.";
    case "device-revoked":
      return reconnect
        ? "This device's access was revoked, so reconnecting it is not offered — pair it again with a fresh pairing QR to restore access."
        : "Pair the device again with a fresh QR to restore access.";
    case "qr-expired":
      return reconnect
        ? "The phone keeps signing in with its current credentials until you show and scan a new reconnect QR."
        : "No device was paired. Generate a new QR when you are ready to pair one.";
    case "qr-superseded":
      return reconnect
        ? "The phone keeps signing in with its current credentials. This QR was replaced by a newer one, so show the newest QR instead."
        : "This QR was replaced by a newer one — show the newest QR instead. A still-pending older QR is voided the moment you generate a new one.";
    case "pending":
      return "";
  }
}

/**
 * What scanning the QR will do, stated plainly (LAMA-296: it grants real
 * authority). A reconnect QR grants nothing new — it rotates the credentials
 * of the device that already holds them — so its copy says exactly that, plus
 * the two facts an operator needs: the device keeps its identity/inboxes/
 * history, and creating the QR is inert.
 *
 * Exported as a presentational component so both modes' copy is tested
 * without a DOM (the same react-dom/server convention as the device table).
 */
export function EnrollmentNotice({ reconnect }: { reconnect: ReconnectTarget | null }) {
  if (reconnect) {
    return (
      <div className="android-notice" role="note">
        <strong>Scanning rotates this device's credentials.</strong>{" "}
        <strong>{reconnect.displayName}</strong> keeps its device id ({" "}
        <code>{reconnect.hostId}</code>), its upload inboxes and its upload
        history — and the phone's previous session is signed out the moment the
        new credentials arrive. Its authority is unchanged. Nothing happens
        until a phone scans this QR: closing this window or letting it expire
        changes nothing.
      </div>
    );
  }
  return (
    <div className="android-notice" role="note">
      <strong>Scanning grants FULL web administration.</strong> The paired
      phone manages this entire fleet (devices, folders, storage, access keys)
      exactly like this desktop session — no second login — and receives its
      own separate native identity for the Android app. Only scan this QR from
      the phone you are pairing.
    </div>
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
