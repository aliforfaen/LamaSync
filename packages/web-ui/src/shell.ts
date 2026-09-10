/**
 * LAMA-329 — the embedded display-mode signal (web half).
 *
 * The Android companion loads the SPA inside its hardened WebView and adds
 * `?lamasyncShell=android` to the initial document URL. This module consumes
 * that signal ONCE into session state and exposes it to the UI.
 *
 * Two rules make this safe and useful:
 *
 *  1. **Presentation only.** The mode never reaches an API call, never lands in
 *     a request header and is never consulted by any authorization path. A
 *     user who types the parameter into a desktop browser gets a browser tab
 *     that believes it is embedded and nothing more.
 *  2. **Consume once.** We are hash-routed, so the parameter is present on the
 *     first load and gone from every client-side navigation afterwards — as
 *     well as from deep links the companion pushes later
 *     (`SessionViewModel.navigateWebTo`). The value is therefore persisted to
 *     `sessionStorage` for the life of the tab and mirrored onto
 *     `<html data-shell="...">` so stylesheets can branch without any JS.
 */

export type ShellMode = "embedded" | "browser";

/** Query parameter name. Mirrored by Android's `WebShellSignal.PARAM`. */
export const SHELL_PARAM = "lamasyncShell";

/** The only value the companion sends. */
export const EMBEDDED_SHELL_VALUE = "android";

const STORAGE_KEY = "lamasync-shell";
const EMBEDDED: ShellMode = "embedded";
const BROWSER: ShellMode = "browser";

/**
 * Pure resolution of the effective mode.
 *
 * A fresh explicit signal always wins (so re-loading the embedded URL in a
 * browser tab that was previously a plain browser is not sticky), and a stored
 * value carries the mode across hash navigations and deep links.
 */
export function resolveShellMode(search: string, stored: string | null): ShellMode {
  const fromQuery = shellModeFromQuery(search);
  if (fromQuery !== null) {
    return fromQuery;
  }
  return stored === EMBEDDED ? EMBEDDED : BROWSER;
}

/** `null` when the query carries no explicit signal at all. */
function shellModeFromQuery(search: string): ShellMode | null {
  // Callers pass `location.search`, which never contains the fragment — but
  // stripping it costs nothing and keeps this honest if a caller ever passes
  // something href-shaped (the Android half of the contract does the same).
  const withoutFragment = search.split("#", 1)[0];
  const query = withoutFragment.startsWith("?") ? withoutFragment.slice(1) : withoutFragment;
  if (query.length === 0) {
    return null;
  }
  for (const pair of query.split("&")) {
    const separator = pair.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const name = decodeURIComponent(pair.slice(0, separator));
    const value = decodeURIComponent(pair.slice(separator + 1));
    if (name !== SHELL_PARAM) {
      continue;
    }
    return value === EMBEDDED_SHELL_VALUE ? EMBEDDED : BROWSER;
  }
  return null;
}

/**
 * Reads the signal, persists it for the tab and mirrors it onto the document
 * element. Returns the effective mode; call it once at boot.
 */
export function consumeShellSignal(): ShellMode {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return BROWSER;
  }
  let stored: string | null = null;
  try {
    stored = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Private-mode / blocked storage: the mode still resolves for this load.
    stored = null;
  }
  const mode = resolveShellMode(window.location.search, stored);
  try {
    window.sessionStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Non-fatal by design: presentation state only.
  }
  document.documentElement.dataset.shell = mode;
  return mode;
}

/**
 * The mode for the current tab, without touching storage. Falls back to the
 * `<html data-shell>` value written by {@link consumeShellSignal} so a
 * component can branch without threading the value through props.
 */
export function currentShellMode(): ShellMode {
  if (typeof document === "undefined") {
    return BROWSER;
  }
  return document.documentElement.dataset.shell === EMBEDDED ? EMBEDDED : BROWSER;
}

/** True when the SPA is running inside the Android companion's WebView. */
export function isEmbeddedShell(): boolean {
  return currentShellMode() === EMBEDDED;
}
