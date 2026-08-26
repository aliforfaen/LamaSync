// LAMA-262: "Pair a device" modal. Issues a fresh short-lived pairing code
// (POST /pairing), renders it large + copyable and as a QR SVG (the code
// string — the CLI takes the code, not a URL), counts down to expiry, and
// polls GET /pairing/:code so the card flips to a "claimed" state the moment
// a device exchanges it. Esc / backdrop close via the shared Modal a11y.
//
// Deliberate exception to the no-new-deps house style: `qrcode-generator`
// (~56 KB, zero transitive deps, MIT) is the single small dependency pulled
// purely for QR matrix generation + SVG output. We do not hand-roll QR math.
//
// Reduced-motion safe: nothing here animates; the countdown re-renders once
// per second via a setInterval.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./Modal.tsx";
import { InlineError } from "./InlineError.tsx";
import { api, errorText } from "../api.ts";
import type { PairingSessionStatus } from "@lamasync/core";
import {
  formatCountdown,
  isPending,
  qrSvg,
  secondsUntil,
  statusLabel,
} from "../pairing.ts";

const POLL_MS = 10_000; // status poll while the card is open and pending

function PairingModal({ onClose }: { onClose: () => void }) {
  // The active session. `expiresAt` (ISO) comes from the status poll when it
  // exists; before the first poll we fall back to `createdAt + TTL`.
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [status, setStatus] = useState<PairingSessionStatus>("pending");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const pollTimer = useRef<number | null>(null);
  const mounted = useRef(true);

  // ---- create / regenerate a session ----
  const create = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const session = await api.createPairingSession();
      setCode(session.code);
      // expiresAt is only on the status poll; seed a local estimate now and
      // let the first poll correct it.
      setExpiresAt(new Date(Date.now() + session.expiresInSeconds * 1000).toISOString());
      setStatus("pending");
      setNow(Date.now());
    } catch (err) {
      setError(errorText(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void create();
    return () => {
      mounted.current = false;
      if (pollTimer.current !== null) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [create]);

  // ---- countdown tick: re-render every second while pending ----
  useEffect(() => {
    if (status !== "pending") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [status]);

  // ---- poll status while the card is open and pending ----
  useEffect(() => {
    if (status !== "pending" || !code) return;
    const tick = async (): Promise<void> => {
      try {
        const result = await api.lookupPairingSession(code);
        if (!mounted.current) return;
        setStatus(result.status);
        setExpiresAt(result.expiresAt);
      } catch {
        // transient poll failure — ignore; the next tick (or countdown to
        // zero) will catch a real terminal state.
      }
    };
    void tick();
    pollTimer.current = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      if (pollTimer.current !== null) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [status, code]);

  // ---- copy the code to the clipboard ----
  async function copyCode(): Promise<void> {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy — select the code and copy manually.");
    }
  }

  const remaining = expiresAt ? secondsUntil(expiresAt, new Date(now)) : 0;
  const qr = useMemo(() => (code ? qrSvg(code) : ""), [code]);
  const expired = status === "pending" && remaining <= 0;

  return (
    <Modal title="Pair a device" onClose={onClose}>
      {busy && !code ? (
        <div className="pairing-loading" aria-busy="true">
          <div className="skel skel-line" />
          <div className="skel skel-line" />
        </div>
      ) : error && !code ? (
        <InlineError message={error} onRetry={() => void create()} />
      ) : code ? (
        <div className="pairing-card">
          <p className="muted">
            On the new device run:{" "}
            <code>lamasync register</code>
          </p>

          {expired ? (
            <div className="error">This code has expired. Generate a new one.</div>
          ) : status === "used" ? (
            <div className="pairing-claimed">
              <span className="badge badge-success">device paired</span>
              <span className="muted">This code has been used. You're all set.</span>
            </div>
          ) : (
            <>
              <div className="pairing-code-row">
                <code className="pairing-code mono">{code}</code>
                <button
                  type="button"
                  className="action"
                  onClick={() => void copyCode()}
                >
                  {copied ? "Copied ✓" : "Copy"}
                </button>
              </div>

              <div className="pairing-qr">
                {/* The QR encodes the code string the user types, not a URL. */}
                <span dangerouslySetInnerHTML={{ __html: qr }} aria-hidden="true" />
              </div>

              <div className="pairing-status">
                <span className={`badge ${statusBadgeClass(status)}`}>
                  {statusLabel(status)}
                </span>
                {isPending(status) ? (
                  <span className="pairing-countdown mono">
                    expires in {formatCountdown(remaining)}
                  </span>
                ) : null}
              </div>
            </>
          )}

          {error ? <div className="error">{error}</div> : null}

          <div className="modal-actions">
            <button type="button" className="action" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="action primary"
              disabled={busy}
              onClick={() => void create()}
            >
              {busy ? "Generating…" : "Re-generate"}
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

/** Map a session status to the badge variant used across the UI. */
function statusBadgeClass(status: PairingSessionStatus): string {
  switch (status) {
    case "pending":
      return "badge-started";
    case "used":
      return "badge-success";
    case "expired":
      return "badge-failed";
  }
}

export { PairingModal };
