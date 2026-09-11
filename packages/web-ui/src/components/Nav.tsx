import { NavLink } from "react-router-dom";
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
  IconSettingsFilled,
  IconShieldFilled,
  IconStorageFilled,
} from "./icons.tsx";
import { BrandLockup } from "./BrandLockup.tsx";
import { ShellActions } from "./ShellActions.tsx";

export interface NavItem {
  to: string;
  icon: JSX.Element;
  text: string;
  end?: boolean;
  /** User-facing synonyms matched by the LAMA-270 command palette only;
   *  the rendered rail ignores this field. */
  keywords?: string;
  /**
   * LAMA-329 phase 3: reachable in ONE tap from the phone's bottom tab bar.
   * Everything else is two taps (More, then the destination). The bottom bar
   * is a fixed four slots, so this flag — not a second hand-maintained list —
   * decides the split, and `quickItems()`/`moreGroups()` keep it honest.
   */
  quick?: boolean;
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
 *
 * LAMA-329 phase 3 extends that single-source rule to the phone: the bottom
 * tab bar and More sheet are derived from this list rather than declared
 * separately, so a new destination is added in exactly one place.
 */
export const GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      {
        to: "/",
        icon: <IconHomeFilled />,
        text: "Dashboard",
        end: true,
        keywords: "home overview",
        quick: true,
      },
    ],
  },
  {
    label: "Sync",
    items: [
      {
        to: "/hosts",
        icon: <IconHostFilled />,
        text: "Devices",
        keywords: "hosts fleet machines pair",
        quick: true,
      },
      {
        to: "/folders",
        icon: <IconFolderFilled />,
        text: "Managed folders",
        keywords: "sync mount folders",
        quick: true,
      },
      { to: "/conflicts", icon: <IconConflictFilled />, text: "Conflicts", keywords: "merge resolve" },
    ],
  },
  {
    label: "Protection",
    items: [
      {
        to: "/backups",
        icon: <IconShieldFilled />,
        text: "Backups",
        keywords: "protected folders backup verification recovery",
        quick: true,
      },
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
      {
        to: "/settings",
        icon: <IconSettingsFilled />,
        text: "Settings",
        keywords: "preferences theme install appearance",
      },
      { to: "/admin", icon: <IconNotificationFilled />, text: "Admin", keywords: "settings server" },
    ],
  },
];

/** Every destination, flattened in rendered order. */
export function allItems(): NavItem[] {
  return GROUPS.flatMap((group) => group.items);
}

/**
 * The four destinations the phone's bottom tab bar shows. Order follows
 * GROUPS, so the bar reads the same way the rail does.
 *
 * Chosen as the fleet's day-to-day loop: see the state of things (Dashboard),
 * the two objects a person actually syncs (Devices, Managed folders), and
 * whether protection ran (Backups). Conflicts, storage destinations, recovery
 * browsing, apps, Activity and Admin are each one tap further into More.
 */
export function quickItems(): NavItem[] {
  return allItems().filter((item) => item.quick === true);
}

/**
 * Everything the phone reaches through the More sheet, with its group labels
 * intact so the sheet keeps the rail's information architecture. Empty groups
 * are dropped rather than rendered as a stray heading.
 */
export function moreGroups(): NavGroup[] {
  return GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.quick !== true),
  })).filter((group) => group.items.length > 0);
}

/**
 * Whether `pathname` belongs to the destination at `to`.
 *
 * Needed because the More control is not a link: it has to light up when the
 * current route lives inside the sheet. NavLink cannot answer that for a
 * group of routes, and a naive `startsWith` would make `/hosts` swallow
 * `/hosts-archive`-style siblings, hence the `to + "/"` boundary.
 */
export function routeIsActive(to: string, pathname: string): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** Whether any More-sheet destination matches the current route. */
export function moreRoutesActive(pathname: string): boolean {
  return moreGroups().some((group) =>
    group.items.some((item) => routeIsActive(item.to, pathname)),
  );
}

/**
 * The grouped rail.
 *
 * LAMA-329 phase 3 replaced the below-900px off-canvas drawer with two
 * permanent surfaces: a compact rail from 640px up, and the bottom tab bar
 * below that. The drawer is gone deliberately — "always visible" removes a
 * state (open/closed/backdrop), and with it the class of bug where back
 * navigation and the drawer disagree about where the user is.
 */
export function Nav() {
  return (
    <>
      {/* Brand bar. Only rendered below 640px, where the rail is absent. */}
      <div className="topbar">
        <BrandLockup />
      </div>
      <nav className="rail" aria-label="Product navigation">
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
          <ShellActions variant="rail" />
        </div>
      </nav>
    </>
  );
}
