import { NavLink } from "react-router-dom";
import { useState } from "react";
import { clearApiKey } from "../api.ts";
import {
  applyTheme,
  loadThemeChoice,
  saveThemeChoice,
  type ThemeChoice,
} from "../theme.ts";
import {
  IconActivity,
  IconConflict,
  IconDotfile,
  IconFolder,
  IconHome,
  IconHost,
  IconNotification,
  IconSearch,
  IconStorage,
} from "./icons.tsx";

const ORDER: ThemeChoice[] = ["dark", "light", "system"];
const LABELS: Record<ThemeChoice, string> = {
  dark: "Dark",
  light: "Light",
  system: "System",
};

export function Nav() {
  const [theme, setTheme] = useState<ThemeChoice>(loadThemeChoice());

  function cycleTheme() {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
    saveThemeChoice(next);
    applyTheme(next);
    setTheme(next);
  }

  return (
    <nav className="nav">
      <span className="brand">
        LAMA<span className="brand-accent">SYNC</span>
      </span>
      <NavLink to="/" end>
        <IconHome /> Dashboard
      </NavLink>
      <NavLink to="/hosts">
        <IconHost /> Hosts
      </NavLink>
      <NavLink to="/folders">
        <IconFolder /> Folders
      </NavLink>
      <NavLink to="/backends">
        <IconStorage /> Backends
      </NavLink>
      <NavLink to="/dotfiles">
        <IconDotfile /> Dotfiles
      </NavLink>
      <NavLink to="/conflicts">
        <IconConflict /> Conflicts
      </NavLink>
      <NavLink to="/operations">
        <IconActivity /> Operations
      </NavLink>
      <NavLink to="/data">
        <IconSearch /> Data
      </NavLink>
      <NavLink to="/admin">
        <IconNotification /> Admin
      </NavLink>
      <a
        href="/swagger"
        target="_blank"
        rel="noopener noreferrer"
      >
        API docs ↗
      </a>
      <button
        type="button"
        className="action theme-toggle"
        onClick={cycleTheme}
        aria-label="Toggle theme"
      >
        {LABELS[theme]}
      </button>
      <button
        type="button"
        className="action"
        onClick={() => {
          clearApiKey();
          window.location.hash = "#/login";
          window.location.reload();
        }}
      >
        Sign out
      </button>
    </nav>
  );
}
