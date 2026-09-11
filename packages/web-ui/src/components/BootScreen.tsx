// LAMA-329 phase 6: the app's boot state.
//
// The plan asks for the llama boot/empty/error/success states to be wired with
// reduced-motion gates. Empty, error and success already exist (`EmptyState`,
// `InlineError`, `Confetti`); this closes the missing one. `Llama`'s "nap" pose
// was exported in LAMA-274 and explicitly left unwired ("reserved for a FUTURE
// loading slot") — this is that slot.
//
// Two accessibility rules: the state is announced through `role="status"` so a
// screen reader hears it without the visual, and the motion is decoration only —
// under `prefers-reduced-motion` the pose is static rather than absent.

import { Llama } from "./Llama.tsx";

export function BootScreen() {
  return (
    <div className="login-page">
      <div className="login-card boot-card" role="status">
        <Llama className="boot-llama" pose="nap" size={56} />
        <p className="muted boot-status">Checking session…</p>
      </div>
    </div>
  );
}
