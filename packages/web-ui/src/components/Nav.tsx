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

/**
 * LAMA-275 grouped left navigation (approved D2). Routes are unchanged —
 * only labels and grouping follow docs/terminology.md:
 *   /hosts → Devices · /folders → Synced folders · /backends → Storage
 *   destinations · /dotfiles → App settings · /operations → Activity.
 */
const GROUPS: { label: string; items: { to: string; icon: JSX.Element; text: string; end?: boolean }[] }[] = [
  {
    label: "Overview",
    items: [{ to: "/", icon: <IconHome />, text: "Dashboard", end: true }],
  },
  {
    label: "Sync",
    items: [
      { to: "/hosts", icon: <IconHost />, text: "Devices" },
      { to: "/folders", icon: <IconFolder />, text: "Synced folders" },
      { to: "/conflicts", icon: <IconConflict />, text: "Conflicts" },
    ],
  },
  {
    label: "Apps",
    items: [{ to: "/dotfiles", icon: <IconDotfile />, text: "App settings" }],
  },
  {
    label: "Storage & tools",
    items: [
      { to: "/backends", icon: <IconStorage />, text: "Storage" },
      { to: "/data", icon: <IconSearch />, text: "Data browser" },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/operations", icon: <IconActivity />, text: "Activity" },
      { to: "/admin", icon: <IconNotification />, text: "Admin" },
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
        <span className="brand">
          LAMA<span className="brand-accent">SYNC</span>
        </span>
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
        <span className="brand rail-brand">
          LAMA<span className="brand-accent">SYNC</span>
        </span>
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
