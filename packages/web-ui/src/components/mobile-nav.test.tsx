// LAMA-329 phase 3: the phone navigation surface.
//
// Repo convention: bun:test + react-dom/server static markup, no jsdom and no
// @testing-library (see Confetti.test.tsx / MobileDevicesPanel.test.tsx).
// Effects do not run under a static render, so the tests target rendered
// structure and pure selectors rather than interaction.
//
// The acceptance gate these tests exist for: "every existing web route remains
// reachable on phone in at most two navigation actions". That is a partition
// property of GROUPS, so it is asserted as one rather than checked by eye.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Nav, allItems, moreGroups, moreRoutesActive, quickItems, routeIsActive } from "./Nav.tsx";
import { MobileTabBar, MoreSheet } from "./MobileTabBar.tsx";

/**
 * Renders inside a router context. react-router's `<Link>` uses
 * `useLayoutEffect`, which React's server renderer warns about by design — the
 * warning is expected for every SSR router test and would otherwise bury the
 * real output, so only that message is filtered for the duration of the render
 * while every other console.error still surfaces.
 */
function renderInRouter(node: React.ReactElement, path = "/"): string {
  const original = console.error;
  console.error = (...args: unknown[]) => {
    if (
      typeof args[0] === "string" &&
      args[0].includes("useLayoutEffect does nothing on the server")
    ) {
      return;
    }
    original(...args);
  };
  try {
    return renderToStaticMarkup(
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>,
    );
  } finally {
    console.error = original;
  }
}

describe("mobile navigation partition (LAMA-329 phase 3)", () => {
  it("splits every destination exactly once between the tab bar and More", () => {
    const quick = quickItems();
    const more = moreGroups().flatMap((group) => group.items);
    const routes = allItems().map((item) => item.to);

    // No route may be dropped (unreachable) or duplicated (two entries that
    // can disagree about their active state).
    expect([...quick, ...more].map((item) => item.to).sort()).toEqual([...routes].sort());
    expect(new Set([...quick, ...more].map((item) => item.to)).size).toBe(routes.length);
  });

  it("keeps the phone's one-tap set at the four slots the bar has", () => {
    // The bar is a fixed four-destination grid plus More; a fifth would
    // squeeze the labels off a 360px screen.
    expect(quickItems().map((item) => item.to)).toEqual([
      "/",
      "/hosts",
      "/folders",
      "/backups",
    ]);
  });

  it("reaches every remaining route in exactly two actions", () => {
    // One action to open More, one to pick the destination.
    const quickRoutes = new Set(quickItems().map((item) => item.to));
    for (const item of allItems()) {
      if (quickRoutes.has(item.to)) continue;
      const inSheet = moreGroups().some((group) =>
        group.items.some((candidate) => candidate.to === item.to),
      );
      expect(inSheet).toBe(true);
    }
  });

  it("keeps the rail's group labels in the sheet and drops empty groups", () => {
    const labels = moreGroups().map((group) => group.label);
    expect(labels).toEqual(["Sync", "Protection", "Apps", "Activity", "System"]);
    // "Overview" holds only the Dashboard, which is in the bar.
    expect(labels).not.toContain("Overview");
    for (const group of moreGroups()) expect(group.items.length).toBeGreaterThan(0);
  });
});

describe("routeIsActive", () => {
  it("treats the dashboard as an exact match only", () => {
    expect(routeIsActive("/", "/")).toBe(true);
    // Every route starts with "/", so a prefix match here would mark the
    // Dashboard active everywhere.
    expect(routeIsActive("/", "/hosts")).toBe(false);
  });

  it("marks a destination active on its nested detail routes", () => {
    expect(routeIsActive("/hosts", "/hosts")).toBe(true);
    expect(routeIsActive("/hosts", "/hosts/host-pixel-9")).toBe(true);
  });

  it("does not let a destination swallow a longer sibling path", () => {
    // "/apps/backups" must not light up for "/apps/templates".
    expect(routeIsActive("/apps/backups", "/apps/templates")).toBe(false);
    expect(routeIsActive("/apps/backups", "/apps/backups/42")).toBe(true);
  });

  it("reports the More control active only for routes inside the sheet", () => {
    expect(moreRoutesActive("/operations")).toBe(true);
    expect(moreRoutesActive("/conflicts")).toBe(true);
    // One-tap destinations must not also light up the More control.
    expect(moreRoutesActive("/")).toBe(false);
    expect(moreRoutesActive("/hosts")).toBe(false);
    expect(moreRoutesActive("/backups")).toBe(false);
  });
});

describe("MobileTabBar", () => {
  it("renders the four destinations plus a More control", () => {
    const html = renderInRouter(<MobileTabBar />, "/");

    for (const route of ["/", "/hosts", "/folders", "/backups"]) {
      expect(html).toContain(`href="${route}"`);
    }
    expect(html).toContain('aria-label="Primary destinations"');
    expect(html).toContain("More");
    // The trigger must announce that it opens a dialog, not a menu.
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-controls="mobile-more-sheet"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("marks the current destination active", () => {
    const html = renderInRouter(<MobileTabBar />, "/hosts");
    expect(html).toContain('aria-current="page"');
    // Devices is the active tab; More must not also claim the current route.
    expect(html).not.toContain("mobile-tabbar-more active");
  });

  it("marks More active when the current route lives inside the sheet", () => {
    // /operations is not a tab, so the user needs to see where they are.
    const html = renderInRouter(<MobileTabBar />, "/operations");
    expect(html).toContain("mobile-tabbar-more active");
    expect(html).toContain('aria-expanded="false"');
  });

  it("does not render the sheet until it is opened", () => {
    const html = renderInRouter(<MobileTabBar />, "/");
    expect(html).not.toContain("mobile-sheet");
    expect(html).not.toContain("sheet-backdrop");
  });
});

describe("MoreSheet", () => {
  it("is a labelled modal dialog with every non-tab destination", () => {
    const html = renderInRouter(<MoreSheet groups={moreGroups()} onClose={() => {}} />);

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="More destinations"');
    expect(html).toContain('aria-label="Close more destinations"');

    for (const item of moreGroups().flatMap((group) => group.items)) {
      expect(html).toContain(`href="${item.to}"`);
    }
  });

  it("carries the shell actions the hidden rail footer would have held", () => {
    const html = renderInRouter(<MoreSheet groups={moreGroups()} onClose={() => {}} />);

    // Below 640px the rail is display:none, so sign-out and the theme cycle
    // only exist here: if they vanish the phone has no way out of a session.
    expect(html).toContain("Sign out");
    expect(html).toContain("Theme:");
    expect(html).toContain('href="/swagger"');
    expect(html).toContain("mobile-sheet-actions");
  });
});

describe("every navigation destination resolves to a real route", () => {
  // The nav is derived from GROUPS, but the route table lives in App.tsx. A
  // destination without a route would render the `*` fallback and redirect to
  // the Dashboard, which reads as "the tab is broken" rather than "the route
  // is missing". Reading the table keeps the two in step without duplicating
  // the paths into a second list that could itself drift.
  const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  const declared = new Set(
    [...appSource.matchAll(/<Route\s+path="([^"]+)"/g)].map((match) => match[1]),
  );

  it("declares a route for every GROUPS destination", () => {
    for (const item of allItems()) {
      expect(declared.has(item.to)).toBe(true);
    }
  });

  it("has no destination pointing at the not-found fallback", () => {
    for (const item of allItems()) {
      expect(item.to).not.toBe("*");
    }
  });
});

describe("Nav rail", () => {
  it("still renders every destination and the shell actions", () => {
    const html = renderInRouter(<Nav />);

    for (const item of allItems()) {
      expect(html).toContain(item.text);
    }
    expect(html).toContain("Sign out");
    expect(html).toContain('href="/swagger"');
  });

  it("has no drawer left to open", () => {
    // Phase 3 removed the off-canvas drawer: a state that could disagree with
    // back navigation. These classes must not come back.
    const html = renderInRouter(<Nav />);
    expect(html).not.toContain("topbar-menu");
    expect(html).not.toContain("rail-open");
    expect(html).not.toContain("rail-backdrop");
    expect(html).not.toContain("Open navigation");
  });
});
