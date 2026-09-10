import { useState } from "react";
import { clearApiKey, getAuthMode, sessionLogout } from "../api.ts";
import {
  applyTheme,
  loadThemeChoice,
  saveThemeChoice,
  type ThemeChoice,
} from "../theme.ts";

const ORDER: ThemeChoice[] = ["dark", "light", "system"];
const LABELS: Record<ThemeChoice, string> = {
  dark: "Dark",
  light: "Light",
  system: "System",
};

export interface ShellActionsProps {
  /** Which surface hosts the actions; the sheet stacks them wider. */
  variant: "rail" | "sheet";
}

/**
 * LAMA-329 phase 3: the shell's own actions — API docs, theme cycle and
 * sign-out.
 *
 * Below 640px the rail is replaced by the bottom tab bar, so these controls
 * lose their home. They move into the phone's More sheet instead, which means
 * two surfaces render them at once (one of them always `display: none`). One
 * component owns them so the pair cannot drift: sign-out in particular is
 * load-bearing — LAMA-296 requires the server-side session invalidation to run
 * before any local clear, and a second copy would be a place to get that
 * wrong.
 */
export function ShellActions({ variant }: ShellActionsProps) {
  const [theme, setTheme] = useState<ThemeChoice>(() => loadThemeChoice());
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const nextTheme = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];

  function cycleTheme() {
    saveThemeChoice(nextTheme);
    applyTheme(nextTheme);
    setTheme(nextTheme);
  }

  async function signOut() {
    setSignOutError(null);
    if (getAuthMode() === "session") {
      // LAMA-296: cookie sessions can't be cleared client-side (HttpOnly),
      // so sign-out MUST invalidate the session server-side first — a local
      // clear alone would log straight back in on reload.
      const result = await sessionLogout();
      if (result === "failed") {
        setSignOutError(
          "Couldn't sign out — the server didn't confirm. The session is still active; try again when connected.",
        );
        return;
      }
    } else {
      clearApiKey();
    }
    window.location.hash = "#/login";
    window.location.reload();
  }

  return (
    <div className={`shell-actions shell-actions--${variant}`}>
      <a href="/swagger" target="_blank" rel="noopener noreferrer">
        API docs ↗
      </a>
      <button
        type="button"
        className="action theme-toggle"
        onClick={cycleTheme}
        aria-label={`Theme: ${LABELS[theme]} (click to cycle)`}
        title={`Theme: ${LABELS[theme]} — click to switch to ${LABELS[nextTheme]}`}
      >
        Theme: {LABELS[theme]}
      </button>
      {signOutError ? (
        <span className="muted" role="alert">
          {signOutError}
        </span>
      ) : null}
      <button type="button" className="action" onClick={() => void signOut()}>
        Sign out
      </button>
    </div>
  );
}
