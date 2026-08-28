/**
 * Renderer smoke tests behind `LAMASYNC_TUI_TEST_VIEWS=1`.
 *
 * The env gate exists because the renderer-bound suite (real OpenTUI FFI)
 * is not always available in CI; the pure-helper suite below is gated on
 * the same env var per `docs/cleanup-2026-08-18.md` item #16 so the
 * shell's compose contract is locked only when the harness is up. CI does
 * NOT set the env var; a developer running `LAMASYNC_TUI_TEST_VIEWS=1 bun
 * test packages/tui/` opt-in locally exercises both the pure-helper and
 * the renderer-bound suites.
 *
 *   - P-B item #16 (docs/cleanup-2026-08-18.md): renderer smoke tests
 *     locking the main shell / view contracts.
 *   - LAMA-273: pause/slow indicator rides the status line. The Shell
 *     composes the final text from `lastBaseLine` + `pauseIndicator` via a
 *     private zero-arg seam (`composeStatusLine()`); we exercise it
 *     through the public surface (`setStatus` + `setPauseIndicator`) and
 *     assert against the resulting `statusText.content`. The renderer
 *     suite additionally mounts the shell against the real OpenTUI FFI
 *     to catch layout regressions.
 *
 * Why we drive the public surface: `composeStatusLine()` is `private`,
 * takes zero args, and reads `lastBaseLine` + `pauseIndicator` from
 * `this`. The public surface flow also covers `setStatus` /
 * `setPauseIndicator` (which call the seam after mutating those fields)
 * — which is the contract LAMA-273 actually ships. Per the polish brief
 * we cannot modify `app/shell.ts` to extract a pure helper.
 *
 * Note: `TextRenderable.content` is an OpenTUI `StyledText`, not a string.
 * The text content lives in `chunks[].text`; that's what the assertions
 * below read.
 */

import { describe, expect, test } from "bun:test";

import { Box, instantiate } from "@opentui/core";
import type { Renderable } from "@opentui/core";

import { Shell } from "./shell.ts";
import type { ViewContext, ViewSpec } from "./view-manager.ts";

const RUN_RENDERER_SUITE = process.env.LAMASYNC_TUI_TEST_VIEWS === "1";

interface ShellHandles {
  readonly shell: Shell;
  readonly text: () => string;
  readonly dispose: () => void;
}

/** Pull the rendered string out of the OpenTUI StyledText wrapper. */
function readText(content: unknown): string {
  const chunks = (content as { chunks: Array<{ text?: string }> }).chunks;
  if (!Array.isArray(chunks)) return String(content);
  return chunks.map((c) => c.text ?? "").join("");
}

/**
 * Construct a Shell with the minimum deps the public compose path needs.
 * We never call `start()`, so the views iterator and startView are never
 * dereferenced — both can be empty stubs. The renderer is required
 * because the Shell constructor calls `instantiate(...)` on the status
 * Text node, but neither `setStatus` nor `setPauseIndicator` depend on
 * the renderer beyond that.
 */
async function makeShell(): Promise<ShellHandles> {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const created = await createTestRenderer({ width: 80, height: 24 });
  const ctx = {
    api: {} as never,
    hostname: "test-host",
    socketPath: "/tmp/lamasync.sock",
    renderer: created.renderer,
    setStatus: () => undefined,
    openWizard: () => undefined,
  };
  const shell = new Shell({
    renderer: created.renderer,
    ctxByView: ctx,
    views: () => [],
    startView: "local",
  });
  const statusText = (shell as unknown as { statusText: { content: unknown } })
    .statusText;
  return {
    shell,
    text: () => readText(statusText.content),
    dispose: () => created.renderer.destroy(),
  };
}

interface NavigationShellHandles {
  readonly shell: Shell;
  readonly tabBar: {
    focused: boolean;
    getSelectedIndex: () => number;
    selectCurrent: () => void;
  };
  readonly containers: Renderable[];
  readonly dispose: () => void;
}

async function makeNavigationShell(): Promise<NavigationShellHandles> {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const created = await createTestRenderer({ width: 80, height: 24 });
  const ctx: ViewContext = {
    api: {} as never,
    hostname: "test-host",
    socketPath: "/tmp/lamasync.sock",
    renderer: created.renderer,
    setStatus: () => undefined,
    openWizard: () => undefined,
  };
  const containers = ["local", "fleet", "logs"].map(() => {
    const container = instantiate(
      created.renderer,
      Box({ flexDirection: "column" }),
    ) as Renderable;
    container.focusable = true;
    return container;
  });
  const specs: ViewSpec[] = containers.map((container, index) => ({
    id: (["local", "fleet", "logs"] as const)[index]!,
    title: (["Local", "Fleet", "Activity"] as const)[index]!,
    container,
    ctx,
    hotkeys: [],
  }));
  const shell = new Shell({
    renderer: created.renderer,
    ctxByView: ctx,
    views: () => specs,
    startView: "local",
  });
  shell.start();
  const tabBar = (shell as unknown as {
    tabBar: {
      focused: boolean;
      getSelectedIndex: () => number;
      selectCurrent: () => void;
    };
  }).tabBar;
  return {
    shell,
    tabBar,
    containers,
    dispose: () => created.renderer.destroy(),
  };
}

function navigationKey(name: string, sequence = "") {
  return { name, sequence, preventDefault() {} } as never;
}

describe("Shell status-line composition (pure seam — LAMA-273)", () => {
  test("default hint is the base line when nothing has been mutated", async () => {
    const { text, dispose } = await makeShell();
    try {
      // Constructor initializes lastBaseLine = DEFAULT_HINT and
      // pauseIndicator = null; the very first paint carries that verbatim.
      expect(text()).toBe("[Tab] tabs   [ / ] views   [?] help   [q] quit");
    } finally {
      dispose();
    }
  });

  test("setStatus replaces the base line verbatim when no pause indicator is set", async () => {
    const { shell, text, dispose } = await makeShell();
    try {
      shell.setStatus("sync complete", "success");
      expect(text()).toBe("[ok] sync complete");
    } finally {
      dispose();
    }
  });

  test("setPauseIndicator appends a pause indicator separated by three spaces", async () => {
    const { shell, text, dispose } = await makeShell();
    try {
      shell.setStatus("hello", "info");
      shell.setPauseIndicator("paused 42m");
      expect(text()).toBe("[i] hello   paused 42m");
    } finally {
      dispose();
    }
  });

  test("transient message from setStatus wins over the default hint", async () => {
    const { shell, text, dispose } = await makeShell();
    try {
      shell.setStatus("sync complete", "success");
      shell.setPauseIndicator("paused 5m");
      expect(text()).toBe("[ok] sync complete   paused 5m");
    } finally {
      dispose();
    }
  });

  test("clearStatus restores the default hint and keeps the pause indicator", async () => {
    const { shell, text, dispose } = await makeShell();
    try {
      shell.setStatus("temp", "info");
      shell.setPauseIndicator("paused 5m");
      shell.clearStatus();
      // The indicator survives a clearStatus() — pause is a persistent
      // affordance; only the transient message resets.
      expect(text()).toBe("[Tab] tabs   [ / ] views   [?] help   [q] quit   paused 5m");
    } finally {
      dispose();
    }
  });

  test("setPauseIndicator('') normalizes to no indicator (LAMA-273 contract)", async () => {
    const { shell, text, dispose } = await makeShell();
    try {
      shell.setPauseIndicator("paused 1m");
      shell.setPauseIndicator("");
      // Empty string is treated as "clear" by setPauseIndicator's
      // normalizer — the status line returns to the bare base line.
      expect(text()).toBe("[Tab] tabs   [ / ] views   [?] help   [q] quit");
    } finally {
      dispose();
    }
  });
});

// Renderer-bound suite: opt-in only. The existing view-manager test file
// documents why (OpenTUI 0.1.107's native FFI backend is not available in
// every CI image).
const realSuite = describe.skipIf(!RUN_RENDERER_SUITE);

realSuite("Shell status-line rendering (real OpenTUI renderer)", () => {
  test("Tab focuses the tab bar and arrows move its selection", async () => {
    const { shell, tabBar, containers, dispose } = await makeNavigationShell();
    try {
      containers[0]!.focus();
      expect(shell.dispatchKey(navigationKey("tab", "\t"))).toBe(true);
      expect(tabBar.focused).toBe(true);

      expect(shell.dispatchKey(navigationKey("right"))).toBe(true);
      expect(tabBar.getSelectedIndex()).toBe(1);
      expect(shell.getManager().activeId()).toBe("local");
    } finally {
      dispose();
    }
  });

  test("Tab returns focus to the active view and Enter selects the highlighted tab", async () => {
    const { shell, tabBar, containers, dispose } = await makeNavigationShell();
    try {
      containers[0]!.focus();
      shell.dispatchKey(navigationKey("tab", "\t"));
      shell.dispatchKey(navigationKey("right"));
      tabBar.selectCurrent();
      expect(shell.getManager().activeId()).toBe("fleet");

      shell.dispatchKey(navigationKey("tab", "\t"));
      expect(tabBar.focused).toBe(false);
      expect(containers[1]!.focused).toBe(true);
    } finally {
      dispose();
    }
  });

  test("global view switching blurs the old view control", async () => {
    const { shell, containers, dispose } = await makeNavigationShell();
    try {
      containers[0]!.focus();
      shell.dispatchKey(navigationKey("rightbracket", "]"));
      expect(shell.getManager().activeId()).toBe("fleet");
      expect(containers[0]!.focused).toBe(false);
      expect(containers[1]!.focused).toBe(true);
    } finally {
      dispose();
    }
  });

  test("status text reflects the base line + pause indicator after setPauseIndicator", async () => {
    const { createTestRenderer } = await import("@opentui/core/testing");
    const created = await createTestRenderer({ width: 120, height: 24 });
    const ctx = {
      api: {} as never,
      hostname: "test-host",
      socketPath: "/tmp/lamasync.sock",
      renderer: created.renderer,
      setStatus: () => undefined,
      openWizard: () => undefined,
    };
    const shell = new Shell({
      renderer: created.renderer,
      ctxByView: ctx,
      views: () => [],
      startView: "local",
    });
    try {
      // Public surface: setPauseIndicator is the entry point that LAMA-273
      // users actually call. The assertion is that the statusText content
      // contains both segments — the renderer test catches it the moment
      // a future refactor garbles the status bar. Note: setStatus prefixes
      // its input with `[i] ` (info kind), so the base line ends up as
      // `[i] [i] hello` — we mirror that here so the assertion locks the
      // real contract, not a stripped-down variant.
      shell.setStatus("[i] hello", "info");
      shell.setPauseIndicator("paused 10m");
      const statusText = (
        shell as unknown as { statusText: { content: unknown } }
      ).statusText;
      expect(readText(statusText.content)).toBe(
        "[i] [i] hello   paused 10m",
      );
      // Renderer alive — createTestRenderer returned the CliRenderer we
      // built the shell against.
      expect(created.renderer).toBeDefined();
    } finally {
      created.renderer.destroy();
    }
  });
});
