// LAMA-273: pause / slow mode — countdown banner shown while a global or
// device-scoped pause is active. Renders the state as text (never color alone)
// plus a Resume button that clears the pause via DELETE. Re-renders every
// minute via the parent's poll; no animation (reduced-motion safe).

import { useEffect, useState } from "react";
import type { PauseState } from "@lamasync/core";
import { pauseBannerText } from "../pause.ts";
import { api, errorText } from "../api.ts";

interface PauseBannerProps {
  /** The active pause for this context (device-effective or global). */
  state: PauseState;
  /** Scope of the Resume action: "global" clears global; "host" clears the
   *  device row (hostId must be provided in that case). */
  scope: "global" | "host";
  hostId?: string;
  /** Called after a successful resume so the parent refreshes. */
  onResumed: () => void;
}

export function PauseBanner({ state, scope, hostId, onResumed }: PauseBannerProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  // Re-render each minute so the countdown stays roughly accurate between
  // 60s polls without requiring an animation.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  async function onResume(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (scope === "host" && hostId) {
        await api.clearHostPause(hostId);
      } else {
        await api.clearPause();
      }
      onResumed();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`pause-banner pause-${state.mode}`} role="status">
      <span className="pause-banner-text">{pauseBannerText(state, now)}</span>
      <span className="pause-banner-actions">
        {error ? <span className="pause-banner-error">{error}</span> : null}
        <button
          type="button"
          className="action"
          disabled={busy}
          onClick={() => void onResume()}
        >
          {busy ? "Resuming…" : "Resume"}
        </button>
      </span>
    </div>
  );
}
