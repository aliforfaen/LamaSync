// LAMA-329 phase 5: the browser settings surface.
//
// The plan asks for "native device settings plus browser-only /settings", and
// for the ownership of every preference to be documented. The native screen
// shipped in phase 2 and owns device-side settings; this one owns what only the
// browser can change and shows the ownership table so the boundary is visible
// rather than folklore.
//
// It deliberately does NOT offer settings that belong to another layer:
// pull-to-refresh, camera-protection constraints and appearance-on-device live
// in the companion, and the embedded shell already has a native Settings screen.
// Offering them here would create a second control for one value.

import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader.tsx";
import { installStateFrom, INSTALL_COPY, type InstallState } from "../install.ts";
import { PREFERENCES, type PreferenceScope } from "../preferences.ts";
import { isEmbeddedShell } from "../shell.ts";
import {
  applyTheme,
  loadThemeChoice,
  saveThemeChoice,
  type ThemeChoice,
} from "../theme.ts";
import { connectivityFrom } from "../connectivity.ts";
import { useWebSocket } from "../hooks/useWebSocket.ts";

const THEME_CHOICES: Array<{ value: ThemeChoice; label: string }> = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "Match system" },
];

const SCOPE_LABEL: Record<PreferenceScope, string> = {
  web: "This browser",
  native: "The device app",
  server: "The server",
};

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
      window.matchMedia("(display-mode: standalone)").matches,
    embeddedShell: isEmbeddedShell(),
    promptAvailable,
    secureContext: typeof window !== "undefined" && window.isSecureContext,
  };
}

export function Settings() {
  const [theme, setTheme] = useState<ThemeChoice>(() => loadThemeChoice());
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
        purpose="Appearance and installation for this browser. Device-side settings live in the LamaSync app."
      />

      <section className="section">
        <h2>Appearance</h2>
        <div className="settings-row">
          {/* A radio group, not a cycling button: three states need to be
              visible at once, and the rail's cycle button stays as the shortcut. */}
          <div className="settings-choice" role="radiogroup" aria-label="Theme">
            {THEME_CHOICES.map((choice) => (
              <label key={choice.value} className="settings-choice-option">
                <input
                  type="radio"
                  name="theme"
                  value={choice.value}
                  checked={theme === choice.value}
                  onChange={() => chooseTheme(choice.value)}
                />
                {choice.label}
              </label>
            ))}
          </div>
          <p className="muted">
            Stored in this browser profile. The LamaSync app keeps its own
            appearance setting, so the two can differ on purpose.
          </p>
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
