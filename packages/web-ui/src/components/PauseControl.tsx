// LAMA-273: pause / slow mode — control entry point. An unobtrusive "Pause…"
// button opens a small modal to set a global or device-scoped pause window:
// duration preset (1h / 4h / Until I resume), mode (Pause / Slow), and an
// optional bandwidth cap for slow mode (validated client-side with the same
// regex the server enforces). Confirm POSTs to the matching endpoint, then the
// parent refreshes so the banner appears.

import { useState } from "react";
import type { PauseMode } from "@lamasync/core";
import { Modal } from "./Modal.tsx";
import { api, errorText } from "../api.ts";
import {
  UNTIL_RESUME_MS,
  presetUntil,
  validateBwlimit,
} from "../pause.ts";

type DurationPreset = "1h" | "4h" | "until-resume";

const PRESETS: { key: DurationPreset; label: string; ms: number }[] = [
  { key: "1h", label: "1 hour", ms: 3600_000 },
  { key: "4h", label: "4 hours", ms: 4 * 3600_000 },
  { key: "until-resume", label: "Until I resume", ms: UNTIL_RESUME_MS },
];

interface PauseControlProps {
  /** "global" pauses the whole fleet; "host" pauses one device (hostId
   *  required in that case). */
  scope: "global" | "host";
  hostId?: string;
  /** Device label for copy ("this device"); falls back to "this device". */
  deviceName?: string;
  /** Whether a pause is currently active for this context (drives the
   *  button label/title). */
  active: boolean;
  /** Called after a successful set so the parent refreshes the banner. */
  onChanged: () => void;
}

export function PauseControl({
  scope,
  hostId,
  deviceName,
  active,
  onChanged,
}: PauseControlProps) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<DurationPreset>("1h");
  const [mode, setMode] = useState<PauseMode>("pause");
  const [bwlimit, setBwlimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeLabel = scope === "host" ? "this device" : "All devices";
  const bwlimitValid = validateBwlimit(bwlimit);
  const confirmDisabled = busy || (mode === "slow" && !bwlimitValid);

  function openModal(): void {
    setPreset("1h");
    setMode("pause");
    setBwlimit("");
    setError(null);
    setOpen(true);
  }

  async function onConfirm(): Promise<void> {
    if (confirmDisabled) return;
    setBusy(true);
    setError(null);
    const presetRow = PRESETS.find((p) => p.key === preset) ?? PRESETS[0];
    const until = presetUntil(presetRow.ms);
    const body = {
      until,
      mode,
      bwlimit: mode === "slow" ? bwlimit.trim() || null : null,
    };
    try {
      if (scope === "host" && hostId) {
        await api.setHostPause(hostId, body);
      } else {
        await api.setPause(body);
      }
      setOpen(false);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="action"
        onClick={openModal}
        title={active ? "Change the active pause" : "Pause syncing"}
      >
        Pause…
      </button>
      {open ? (
        <Modal
          title={scope === "host" ? `Pause ${deviceName ?? "this device"}` : "Pause all syncs"}
          onClose={() => setOpen(false)}
          footer={
            <>
              <button type="button" className="action" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="action primary"
                disabled={confirmDisabled}
                onClick={() => void onConfirm()}
              >
                {busy ? "Pausing…" : "Pause now"}
              </button>
            </>
          }
        >
          {error ? <div className="error">{error}</div> : null}
          <p className="muted">
            {scopeLabel} will stop syncing for the chosen window. Slow mode
            keeps syncing but caps bandwidth.
          </p>

          <div className="form-field">
            <span className="form-label">Duration</span>
            <div className="pause-presets" role="radiogroup" aria-label="Duration">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  role="radio"
                  aria-checked={preset === p.key}
                  className={`pause-chip ${preset === p.key ? "pause-chip-active" : ""}`}
                  onClick={() => setPreset(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="form-field">
            <span className="form-label">Mode</span>
            <div className="pause-presets" role="radiogroup" aria-label="Mode">
              {(["pause", "slow"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  className={`pause-chip ${mode === m ? "pause-chip-active" : ""}`}
                  onClick={() => setMode(m)}
                >
                  {m === "pause" ? "Pause" : "Slow mode"}
                </button>
              ))}
            </div>
          </div>

          {mode === "slow" ? (
            <div className="form-field">
              <label className="form-label" htmlFor="pause-bwlimit">
                Bandwidth cap <span className="muted">(optional)</span>
              </label>
              <input
                id="pause-bwlimit"
                type="text"
                value={bwlimit}
                placeholder="e.g. 1M or 512K"
                onChange={(e) => setBwlimit(e.target.value)}
              />
              {!bwlimitValid && bwlimit.length > 0 ? (
                <span className="form-error">Use a size like "1M" or "512K"</span>
              ) : null}
            </div>
          ) : null}
        </Modal>
      ) : null}
    </>
  );
}
