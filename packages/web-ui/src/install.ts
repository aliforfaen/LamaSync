// LAMA-329 phase 7: whether "install this app" can be offered, and what to say.
//
// Chrome fires `beforeinstallprompt` only when the manifest, the service worker
// and the icons all satisfy it, so the prompt's presence is the real signal —
// there is no way to ask "is this installable?" directly. Everything else here
// exists to avoid offering an install that cannot happen (already installed,
// inside the Android companion, or on a plain-HTTP origin where service workers
// are unavailable in the first place).

export type InstallState = "installed" | "installable" | "unavailable";

export interface InstallFacts {
  /** `display-mode: standalone` — already running as an installed app. */
  standalone: boolean;
  /** True inside the Android companion's WebView. */
  embeddedShell: boolean;
  /** A captured `beforeinstallprompt` event is waiting to be used. */
  promptAvailable: boolean;
  /** `window.isSecureContext`. */
  secureContext: boolean;
}

export function installStateFrom(facts: InstallFacts): InstallState {
  if (facts.standalone) return "installed";
  // The companion already IS the installed app; offering to install a second
  // copy into Chrome from inside it would be nonsense.
  if (facts.embeddedShell) return "unavailable";
  if (!facts.secureContext) return "unavailable";
  return facts.promptAvailable ? "installable" : "unavailable";
}

export const INSTALL_COPY: Record<InstallState, { title: string; detail: string }> = {
  installed: {
    title: "Installed",
    detail: "LamaSync is running as an installed app.",
  },
  installable: {
    title: "Install LamaSync",
    detail:
      "Adds LamaSync to your home screen and opens it without browser chrome. The app shell is cached so it can start offline; fleet data is always read live.",
  },
  unavailable: {
    title: "Install from the browser menu",
    detail:
      "This browser has not offered an install prompt. Use its own menu (on Android Chrome: ⋮ → Add to Home screen) after signing in. Installation needs HTTPS.",
  },
};
