// LAMA-329 phase 5: the browser settings surface.
//
// The plan asks for "native device settings plus browser-only /settings", and
// for the ownership of every preference to be documented. The native screen
// shipped in phase 2 and owns device-side settings; this one owns what only the
// browser can change. The plan names the list explicitly — theme, density,
// reduced-motion override (default system), command-palette help, install and
// session sign-out — and shows the ownership table so the boundary is visible
// rather than folklore.
//
// It deliberately does NOT offer settings that belong to another layer:
// pull-to-refresh, camera-protection constraints and appearance-on-device live
// in the companion, and the embedded shell already has a native Settings screen.
// Offering them here would create a second control for one value.

import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader.tsx";
import {
  COMMAND_PALETTE_SHORTCUT,
  requestCommandPalette,
} from "../components/CommandPalette.tsx";
import { installStateFrom, INSTALL_COPY, type InstallState } from "../install.ts";
import { PREFERENCES, type PreferenceScope } from "../preferences.ts";
import { isEmbeddedShell } from "../shell.ts";
import {
  applyTheme,
  loadThemeChoice,
  saveThemeChoice,
  type ThemeChoice,
} from "../theme.ts";
import {
  applyDensity,
  loadDensityChoice,
  saveDensityChoice,
  type DensityChoice,
} from "../density.ts";
import {
  applyMotion,
  loadMotionChoice,
  saveMotionChoice,
  type MotionChoice,
} from "../motion.ts";
import { performSignOut, SIGN_OUT_FAILED_MESSAGE } from "../sign-out.ts";
import { connectivityFrom } from "../connectivity.ts";
import { useWebSocket } from "../hooks/useWebSocket.ts";

const THEME_CHOICES: Array<{ value: ThemeChoice; label: string }> = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "Match system" },
];

const DENSITY_CHOICES: Array<{ value: DensityChoice; label: string }> = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

const MOTION_CHOICES: Array<{ value: MotionChoice; label: string }> = [
  { value: "system", label: "Match system" },
  { value: "reduce", label: "Reduce motion" },
  { value: "full", label: "Allow motion" },
];

const SCOPE_LABEL: Record<PreferenceScope, string> = {
  web: "This browser",
  native: "The device app",
  server: "The server",
};

/**
 * A visible radio group. Three preference rows on this page use the same shape
 * — a radio group rather than a cycling button, because a cycling control hides
 * two of three states and offers no way to see the default.
 */
function ChoiceGroup<T extends string>({
  name,
  legend,
  options,
  value,
  onChange,
}: {
  name: string;
  legend: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="settings-choice" role="radiogroup" aria-label={legend}>
      {options.map((option) => (
        <label key={option.value} className="settings-choice-option">
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

/**
 * The captured `beforeinstallprompt` event.
 *
 * Chrome only fires it when the manifest, service worker and icons all satisfy
 * its install criteria, so its presence is the only real answer to "can this be
 * installed?". It can fire before the Settings screen mounts, hence a module
 * level slot rather than component state.
 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

let capturedInstallPrompt: InstallPromptEvent | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    capturedInstallPrompt = event as InstallPromptEvent;
  });
}

function currentInstallFacts(promptAvailable: boolean) {
  return {
    standalone:
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches,
    embeddedShell: isEmbeddedShell(),
    promptAvailable,
    secureContext: typeof window !== "undefined" && window.isSecureContext === true,
  };
}

export function Settings() {
  const [theme, setTheme] = useState<ThemeChoice>(() => loadThemeChoice());
  const [density, setDensity] = useState<DensityChoice>(() => loadDensityChoice());
  const [motion, setMotion] = useState<MotionChoice>(() => loadMotionChoice());
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [installState, setInstallState] = useState<InstallState>(() =>
    installStateFrom(currentInstallFacts(capturedInstallPrompt !== null)),
  );
  const { state: socket } = useWebSocket();

  // The prompt can arrive after mount (Chrome fires it when it is satisfied),
  // and `display-mode` changes if the user installs while this tab is open.
  useEffect(() => {
    const refresh = () => setInstallState(installStateFrom(currentInstallFacts(capturedInstallPrompt !== null)));
    window.addEventListener("beforeinstallprompt", refresh);
    window.addEventListener("appinstalled", refresh);
    const query = window.matchMedia("(display-mode: standalone)");
    query.addEventListener("change", refresh);
    return () => {
      window.removeEventListener("beforeinstallprompt", refresh);
      window.removeEventListener("appinstalled", refresh);
      query.removeEventListener("change", refresh);
    };
  }, []);

  function chooseTheme(next: ThemeChoice) {
    saveThemeChoice(next);
    applyTheme(next);
    setTheme(next);
  }

  function chooseDensity(next: DensityChoice) {
    saveDensityChoice(next);
    applyDensity(next);
    setDensity(next);
  }

  function chooseMotion(next: MotionChoice) {
    saveMotionChoice(next);
    applyMotion(next);
    setMotion(next);
  }

  async function signOut() {
    setSignOutError(null);
    const result = await performSignOut();
    if (result === "failed") {
      setSignOutError(SIGN_OUT_FAILED_MESSAGE);
      return;
    }
    window.location.hash = "#/login";
    window.location.reload();
  }

  async function install() {
    const prompt = capturedInstallPrompt;
    if (prompt === null) return;
    await prompt.prompt();
    // A prompt can only be used once; the browser fires a fresh one if the
    // user dismisses it and the app is still installable.
    capturedInstallPrompt = null;
    setInstallState(installStateFrom(currentInstallFacts(false)));
  }

  const connectivity = connectivityFrom({
    browserOnline: typeof navigator === "undefined" ? true : navigator.onLine,
    socket,
    requestFailed: false,
  });
  const installCopy = INSTALL_COPY[installState];

  return (
    <div className="page">
      <PageHeader
        title="Settings"
        purpose="Appearance, density, motion and installation for this browser. Device-side settings live in the LamaSync app."
      />

      <section className="section">
        <h2>Appearance</h2>
        <div className="settings-row">
          <ChoiceGroup
            name="theme"
            legend="Theme"
            options={THEME_CHOICES}
            value={theme}
            onChange={chooseTheme}
          />
          <p className="muted">
            Stored in this browser profile. The LamaSync app keeps its own
            appearance setting, so the two can differ on purpose.
          </p>
        </div>
      </section>

      <section className="section">
        <h2>Density and motion</h2>
        <div className="settings-row">
          <ChoiceGroup
            name="density"
            legend="Density"
            options={DENSITY_CHOICES}
            value={density}
            onChange={chooseDensity}
          />
          <p className="muted">
            Compact tightens page gutters, section spacing, table cells and
            device cards. Type sizes do not change, so data stays as readable as
            it was.
          </p>
        </div>
        <div className="settings-row">
          <ChoiceGroup
            name="motion"
            legend="Motion"
            options={MOTION_CHOICES}
            value={motion}
            onChange={chooseMotion}
          />
          <p className="muted">
            Defaults to the system setting. “Reduce motion” suppresses
            animations here even when the system allows them; “Allow motion”
            restores them when the system asks for reduced motion.
          </p>
        </div>
      </section>

      <section className="section">
        <h2>Command palette</h2>
        <div className="settings-row">
          <p className="muted">
            Press <kbd>{COMMAND_PALETTE_SHORTCUT}</kbd> anywhere in LamaSync to
            search every destination and common action. Type to filter, arrow
            keys to move, Enter to open, Esc to close.
          </p>
          <button
            type="button"
            className="action"
            onClick={() => requestCommandPalette()}
          >
            Open the command palette
          </button>
        </div>
      </section>

      <section className="section">
        <h2>Install</h2>
        <div className="settings-row">
          <strong>{installCopy.title}</strong>
          <p className="muted">{installCopy.detail}</p>
          {installState === "installable" ? (
            <button type="button" className="action primary" onClick={() => void install()}>
              Install LamaSync
            </button>
          ) : null}
        </div>
      </section>

      <section className="section">
        <h2>Connection</h2>
        <div className="settings-row">
          <p className="muted">
            {connectivity.label} — {connectivity.detail}
          </p>
        </div>
      </section>

      <section className="section">
        <h2>Session</h2>
        <div className="settings-row">
          <p className="muted">
            Signing out ends the session on the server first, then clears this
            browser. A local-only clear would sign straight back in on reload,
            because the session cookie is not readable from JavaScript.
          </p>
          <button type="button" className="action" onClick={() => void signOut()}>
            Sign out
          </button>
          {signOutError ? (
            <p className="muted" role="alert">
              {signOutError}
            </p>
          ) : null}
        </div>
      </section>

      <section className="section">
        <h2>Where each setting lives</h2>
        <p className="muted">
          LamaSync keeps preferences in three layers. This table is the contract:
          one store per preference, so a change made in one place cannot be
          silently overridden somewhere else.
        </p>
        <table className="data data-list data-preferences">
          <thead>
            <tr>
              <th>Setting</th>
              <th>Stored in</th>
              <th>Layer</th>
              <th>Changed from</th>
            </tr>
          </thead>
          <tbody>
            {PREFERENCES.map((preference) => (
              <tr key={preference.id}>
                <td>
                  <strong>{preference.label}</strong>
                </td>
                <td className="mono">{preference.owner}</td>
                <td className="muted">{SCOPE_LABEL[preference.scope]}</td>
                <td className="muted">
                  {preference.editedIn}
                  <br />
                  <small className="muted">{preference.notes}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
