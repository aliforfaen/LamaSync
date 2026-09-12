// LAMA-273: pause / slow mode — control entry point. The button's icon and
// action always describe the LIVE state (LAMA-334): when syncing is running it
// offers "Pause" and opens the window picker; when a window is up it offers
// "Resume" and clears it immediately, with a second, compact affordance for
// changing the window instead. A request in flight says which transition is
// running; an unavailable control says why.
//
// The window picker itself is unchanged: duration preset (1h / 4h / Until I
// resume), mode (Pause / Slow), and an optional bandwidth cap for slow mode
// (validated client-side with the same regex the server enforces). Confirm
// POSTs to the matching endpoint, then the parent refreshes.

import { useState } from "react";
import type { PauseMode, PauseState } from "@lamasync/core";
import { Modal } from "./Modal.tsx";
import { IconPauseFilled, IconPlayFilled } from "./icons.tsx";
import { api, errorText } from "../api.ts";
import {
  UNTIL_RESUME_MS,
  pauseControlState,
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
  /** The active window for this scope, or null while syncing runs. */
  state: PauseState | null;
  /** Why the control cannot act (server unreachable, device offline). */
  unavailableReason?: string | null;
  /** Called after a successful change so the parent refreshes. */
  onChanged: () => void;
}

export function PauseControl({
  scope,
  hostId,
  deviceName,
  state,
  unavailableReason = null,
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
  const control = pauseControlState({ state, busy, unavailableReason });

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

  async function onResume(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (scope === "host" && hostId) {
        await api.clearHostPause(hostId);
      } else {
        await api.clearPause();
      }
      onChanged();
    } catch (err) {
      // The window is still in effect server-side; the control keeps saying
      // so and the message explains why the resume did not take.
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="pause-control">
      <button
        type="button"
        className={`action pause-control-main${control.active ? " pause-control-active" : ""}`}
        onClick={control.action === "resume" ? () => void onResume() : openModal}
        disabled={control.disabled}
        aria-label={control.ariaLabel}
        title={control.title}
      >
        {control.active ? (
          <IconPlayFilled className="pause-control-icon" />
        ) : (
          <IconPauseFilled className="pause-control-icon" />
        )}
        <span>{control.label}</span>
      </button>
      {control.active ? (
        // Changing the window is a second intent, so it is a second control —
        // folding it into the Resume button is how "Resume" used to be
        // unreachable while a pause was on.
        <button
          type="button"
          className="action pause-control-change"
          onClick={openModal}
          disabled={busy}
          aria-label={
            control.slow ? "Change the slow-mode window" : "Change the pause window"
          }
          title={control.slow ? "Change the slow-mode window" : "Change the pause window"}
        >
          <span aria-hidden="true">⋯</span>
        </button>
      ) : null}
      {error ? (
        <span className="pause-control-error" role="alert">
          {error}
        </span>
      ) : null}
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
                {busy ? "Pausing…" : state === null ? "Pause now" : "Update window"}
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
    </span>
  );
}
