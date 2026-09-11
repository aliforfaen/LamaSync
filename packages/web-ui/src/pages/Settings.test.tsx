// LAMA-329 phase 5 review fix: the browser Settings route must carry every
// browser-only preference the plan lists — theme, density, the reduced-motion
// override (default system), command-palette help, install and session
// sign-out — not just theme/install/connection.
//
// Repo convention: bun:test + react-dom/server static markup, no jsdom (see
// mobile-nav.test.tsx). Effects do not run under a static render, so these
// tests assert the rendered contract: every control exists, is labelled, and is
// discoverable.

import { afterEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Settings } from "./Settings.tsx";
import {
  COMMAND_PALETTE_EVENT,
  COMMAND_PALETTE_SHORTCUT,
  requestCommandPalette,
} from "../components/CommandPalette.tsx";

const html = renderToStaticMarkup(<Settings />);

describe("Settings — browser-only controls (LAMA-329 phase 5)", () => {
  it("offers the theme choice as a visible radio group", () => {
    expect(html).toContain('name="theme"');
    expect(html).toContain("Match system");
  });

  it("offers density, defaulting to comfortable", () => {
    expect(html).toContain("Density and motion");
    expect(html).toContain('name="density"');
    expect(html).toContain("Comfortable");
    expect(html).toContain("Compact");
  });

  it("offers the reduced-motion override with the system default", () => {
    expect(html).toContain('name="motion"');
    // Three states, so the default is visible rather than implied by a cycle.
    expect(html).toContain("Reduce motion");
    expect(html).toContain("Allow motion");
    expect(html).toContain("Defaults to the system setting");
  });

  it("documents the command palette and can open it", () => {
    expect(html).toContain(COMMAND_PALETTE_SHORTCUT);
    expect(html).toContain("Open the command palette");
  });

  it("keeps install and session sign-out on the page", () => {
    expect(html).toContain("Install");
    expect(html).toContain("Sign out");
  });

  it("does not grow a second control for a device-side preference", () => {
    // The ownership table mentions these on purpose; the page must not render a
    // control that would compete with the companion's own screen.
    expect(html).not.toContain("<h2>Camera protection</h2>");
    expect(html).not.toContain("<h2>Transfers</h2>");
    expect(html).not.toContain("<h2>Notifications</h2>");
  });

  it("renders the ownership table with the new browser stores", () => {
    expect(html).toContain("Where each setting lives");
    expect(html).toContain("lamasync-density");
    expect(html).toContain("lamasync-motion");
  });
});

describe("requestCommandPalette", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const hadWindow = "window" in globalThis;

  afterEach(() => {
    if (hadWindow) {
      (globalThis as { window?: unknown }).window = originalWindow;
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("asks the mounted palette to open through one explicit event", () => {
    const dispatched: Event[] = [];
    (globalThis as { window?: unknown }).window = {
      dispatchEvent: (event: Event) => {
        dispatched.push(event);
        return true;
      },
    };

    requestCommandPalette();
    expect(dispatched.map((event) => event.type)).toEqual([COMMAND_PALETTE_EVENT]);
  });
});
