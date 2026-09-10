import { useState } from "react";
import {
  applyTheme,
  loadThemeChoice,
  saveThemeChoice,
  type ThemeChoice,
} from "../theme.ts";
import { performSignOut, SIGN_OUT_FAILED_MESSAGE } from "../sign-out.ts";

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
 * component owns them so the pair cannot drift — and sign-out itself now lives
 * in `../sign-out.ts`, shared with the Settings page, because the LAMA-296
 * server-first ordering is not something a second copy should be trusted with.
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
    const result = await performSignOut();
    if (result === "failed") {
      setSignOutError(SIGN_OUT_FAILED_MESSAGE);
      return;
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
