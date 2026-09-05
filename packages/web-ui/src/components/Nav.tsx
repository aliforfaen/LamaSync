import { NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import { clearApiKey } from "../api.ts";
import {
  applyTheme,
  loadThemeChoice,
  saveThemeChoice,
  type ThemeChoice,
} from "../theme.ts";
import {
  IconActivityFilled,
  IconConflictFilled,
  IconDotfileFilled,
  IconFolderFilled,
  IconHomeFilled,
  IconHostFilled,
  IconNotificationFilled,
  IconPresetsFilled,
  IconSearchFilled,
  IconShieldFilled,
  IconStorageFilled,
} from "./icons.tsx";
import { BrandLockup } from "./BrandLockup.tsx";

const ORDER: ThemeChoice[] = ["dark", "light", "system"];
const LABELS: Record<ThemeChoice, string> = {
  dark: "Dark",
  light: "Light",
  system: "System",
};

export interface NavItem {
  to: string;
  icon: JSX.Element;
  text: string;
  end?: boolean;
  /** User-facing synonyms matched by the LAMA-270 command palette only;
   *  the rendered rail ignores this field. */
  keywords?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * LAMA-275 grouped left navigation (approved D2). Single source of truth for
 * the rail rendered below AND the LAMA-270 command palette, so the two can
 * never drift. Labels and grouping follow docs/terminology.md:
 *   /hosts → Devices · /folders → Managed folders · /backends → Storage
 *   destinations · /apps/templates → App templates · /apps/backups → App
 *   backups · /operations → Activity.
 */
export const GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [{ to: "/", icon: <IconHomeFilled />, text: "Dashboard", end: true, keywords: "home overview" }],
  },
  {
    label: "Sync",
    items: [
      { to: "/hosts", icon: <IconHostFilled />, text: "Devices", keywords: "hosts fleet machines pair" },
      { to: "/folders", icon: <IconFolderFilled />, text: "Managed folders", keywords: "sync mount folders" },
      { to: "/conflicts", icon: <IconConflictFilled />, text: "Conflicts", keywords: "merge resolve" },
    ],
  },
  {
    label: "Protection",
    items: [
      { to: "/backups", icon: <IconShieldFilled />, text: "Backups", keywords: "protected folders backup verification recovery" },
      { to: "/backends", icon: <IconStorageFilled />, text: "Storage destinations", keywords: "backends storage recovery backups" },
      { to: "/data", icon: <IconSearchFilled />, text: "Browse recovery data", keywords: "browse files snapshots" },
    ],
  },
  {
    label: "Apps",
    items: [
      { to: "/apps/backups", icon: <IconDotfileFilled />, text: "App backups", keywords: "backup protection snapshots upload download" },
      { to: "/apps/templates", icon: <IconPresetsFilled />, text: "App templates", keywords: "vscode neovim zsh firefox git tmux settings template enroll protect" },
    ],
  },
  {
    label: "Activity",
    items: [
      { to: "/operations", icon: <IconActivityFilled />, text: "Activity", keywords: "operations log history" },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/admin", icon: <IconNotificationFilled />, text: "Admin", keywords: "settings server" },
    ],
  },
];

export function Nav() {
  const [theme, setTheme] = useState<ThemeChoice>(loadThemeChoice());
  // Drawer state for small screens (<900px): the rail becomes off-canvas.
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the drawer whenever the route changes so navigation feels done.
  useEffect(() => {
    const close = () => setDrawerOpen(false);
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, []);

  function cycleTheme() {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
    saveThemeChoice(next);
    applyTheme(next);
    setTheme(next);
  }

  function signOut() {
    clearApiKey();
    window.location.hash = "#/login";
    window.location.reload();
  }

  return (
    <>
      {/* Slim top bar rendered only below 900px (see CSS). */}
      <div className="topbar">
        <button
          type="button"
          className="topbar-menu"
          aria-label={drawerOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((open) => !open)}
        >
          {drawerOpen ? "✕" : "☰"}
        </button>
        <BrandLockup />
      </div>
      {drawerOpen && (
        <button
          type="button"
          className="rail-backdrop"
          aria-label="Close navigation"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <nav className={`rail${drawerOpen ? " rail-open" : ""}`} aria-label="Product navigation">
        <BrandLockup className="rail-brand" />
        <div className="rail-groups">
          {GROUPS.map((group) => (
            <div className="rail-group" key={group.label}>
              <div className="rail-group-label">{group.label}</div>
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end}>
                  {item.icon} {item.text}
                </NavLink>
              ))}
            </div>
          ))}
        </div>
        <div className="rail-footer">
          <a href="/swagger" target="_blank" rel="noopener noreferrer">
            API docs ↗
          </a>
          <button
            type="button"
            className="action theme-toggle"
            onClick={cycleTheme}
            aria-label={`Theme: ${LABELS[theme]} (click to cycle)`}
            title={`Theme: ${LABELS[theme]} — click to switch to ${LABELS[ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]]}`}
          >
            Theme: {LABELS[theme]}
          </button>
          <button type="button" className="action" onClick={signOut}>
            Sign out
          </button>
        </div>
      </nav>
    </>
  );
}
