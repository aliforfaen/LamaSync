/**
 * View-shape smoke tests behind `LAMASYNC_TUI_TEST_VIEWS=1`.
 *
 * Locks the contract of LocalView's first paint: the title bar carries the
 * hostname, the empty-state copy renders when there are no folders, and the
 * global hotkey footer is always visible. Foundation per `docs/cleanup
 * -2026-08-18.md` item #16 ("Renderer smoke tests behind
 * `LAMASYNC_TUI_TEST_VIEWS`"); CI does NOT set the env var.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { createTestRenderer } from "@opentui/core/testing";
import type { CliRenderer } from "@opentui/core";

import type { LamaSyncApiClient } from "@lamasync/core";

import { LocalView } from "./local.ts";
import type { ViewContext } from "../app/view-manager.ts";

const RUN_RENDERER_SUITE = process.env.LAMASYNC_TUI_TEST_VIEWS === "1";
const realSuite = describe.skipIf(!RUN_RENDERER_SUITE);

function makeCtx(hostname: string, renderer: CliRenderer): ViewContext {
  return {
    api: {} as LamaSyncApiClient,
    hostname,
    socketPath: "/tmp/lamasync.sock",
    renderer,
    setStatus: () => undefined,
    openWizard: () => undefined,
  };
}

realSuite("LocalView first-paint shape", () => {
  let renderer: CliRenderer | null = null;

  afterEach(() => {
    renderer?.destroy();
    renderer = null;
  });

  test("empty-state: body includes the hostname heading and the 'No folders' copy", async () => {
    const created = await createTestRenderer({ width: 120, height: 30 });
    renderer = created.renderer;
    const view = new LocalView({ renderer });
    // Mount the view's container under the renderer root so the layout
    // reaches the frame buffer; without this the renderer is empty and
    // `captureCharFrame` returns "".
    renderer.root.add(view.container);
    view.onShow(makeCtx("test-host", renderer));
    await created.renderOnce();
    // The frame string contains the visible text from every Text renderable
    // laid out by OpenTUI. The heading + empty-state copy are guaranteed
    // by the LocalView contract (LAMA-276 chrome); asserting on them keeps
    // a future refactor from accidentally swapping the strings.
    const frame = created.captureCharFrame();
    expect(frame).toContain("This device");
    expect(frame).toContain("test-host");
    expect(frame).toContain("No folders set up on this device yet");
  });

  test("hotkeys() exposes the foundational single-device action surface", () => {
    // Hotkeys drive the global footer AND the dispatcher — this assertion
    // is a shape lock for `lamasync-tui`'s onboarding help. Pure function,
    // included here for completeness even though it doesn't need the
    // renderer.
    const view = new LocalView({ renderer: null });
    const keys = view.hotkeys().map((h) => h.key);
    expect(keys).toEqual(
      expect.arrayContaining(["1", "2", "3", "p", "s", "n", "w"]),
    );
  });
});
