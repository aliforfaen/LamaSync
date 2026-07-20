/**
 * ViewManager lifecycle tests. By default the file uses a `FakeRenderable`
 * stand-in so `bun test packages/tui/` stays green in CI. Set
 * `LAMASYNC_TUI_TEST_VIEWS=1` to opt in to the real OpenTUI renderer path.
 */

import { describe, expect, test } from "bun:test";

import type { Renderable } from "@opentui/core";

import type { Hotkey, KeyEvent } from "./keymap.ts";
import type { ViewContext, ViewSpec } from "./view-manager.ts";
import { ViewManager } from "./view-manager.ts";

const RUN_REAL_RENDERER = process.env.LAMASYNC_TUI_TEST_VIEWS === "1";

class FakeRenderable {
  visible = true;
  destroyed = false;
  children: FakeRenderable[] = [];
  add(child: FakeRenderable): void {
    this.children.push(child);
  }
  remove(child: FakeRenderable): void {
    this.children = this.children.filter((c) => c !== child);
  }
  destroy(): void {
    this.destroyed = true;
  }
}

function makeCtx(): ViewContext {
  return {
    api: {} as ViewContext["api"],
    hostname: "test-host",
    socketPath: "/tmp/lamasync.sock",
    setStatus: () => {},
    openWizard: () => {},
  };
}

function makeSpec(
  id: ViewSpec["id"],
  title: string,
  container: Renderable,
  opts: {
    onShow?: () => void;
    onHide?: () => void;
    handleKey?: (e: KeyEvent) => boolean;
    hotkeys?: Hotkey[];
  } = {},
): ViewSpec {
  return {
    id,
    title,
    container,
    ctx: makeCtx(),
    hotkeys: opts.hotkeys ?? [],
    onShow: opts.onShow,
    onHide: opts.onHide,
    handleKey: opts.handleKey,
  };
}

function keyEvent(name: string, sequence = ""): KeyEvent {
  return { name, sequence } as unknown as KeyEvent;
}

describe("ViewManager (fake renderer)", () => {
  test("register hides each container", () => {
    const mgr = new ViewManager();
    const a = new FakeRenderable();
    const b = new FakeRenderable();
    a.visible = true;
    b.visible = true;
    mgr.register(makeSpec("local", "Local", a as unknown as Renderable));
    mgr.register(makeSpec("fleet", "Fleet", b as unknown as Renderable));
    expect((a as unknown as { visible: boolean }).visible).toBe(false);
    expect((b as unknown as { visible: boolean }).visible).toBe(false);
  });

  test("show reveals the target and hides the previous", () => {
    const mgr = new ViewManager();
    const a = new FakeRenderable();
    const b = new FakeRenderable();
    mgr.register(makeSpec("local", "Local", a as unknown as Renderable));
    mgr.register(makeSpec("fleet", "Fleet", b as unknown as Renderable));
    mgr.show("local");
    expect((a as unknown as { visible: boolean }).visible).toBe(true);
    expect((b as unknown as { visible: boolean }).visible).toBe(false);
    mgr.show("fleet");
    expect((a as unknown as { visible: boolean }).visible).toBe(false);
    expect((b as unknown as { visible: boolean }).visible).toBe(true);
  });

  test("show calls onShow on the new view and onHide on the previous", () => {
    const mgr = new ViewManager();
    const calls: string[] = [];
    const a = new FakeRenderable();
    const b = new FakeRenderable();
    mgr.register(
      makeSpec("local", "Local", a as unknown as Renderable, {
        onShow: () => calls.push("local.show"),
        onHide: () => calls.push("local.hide"),
      }),
    );
    mgr.register(
      makeSpec("fleet", "Fleet", b as unknown as Renderable, {
        onShow: () => calls.push("fleet.show"),
        onHide: () => calls.push("fleet.hide"),
      }),
    );
    mgr.show("local");
    mgr.show("fleet");
    mgr.show("local");
    expect(calls).toEqual([
      "local.show",
      "local.hide",
      "fleet.show",
      "fleet.hide",
      "local.show",
    ]);
  });

  test("show to unknown id is a no-op when an active view exists", () => {
    const mgr = new ViewManager();
    const a = new FakeRenderable();
    mgr.register(makeSpec("local", "Local", a as unknown as Renderable));
    mgr.show("local");
    expect(() => mgr.show("logs")).not.toThrow();
    expect(mgr.activeId()).toBe("local");
  });

  test("activeId and active throw before any show", () => {
    const mgr = new ViewManager();
    expect(() => mgr.activeId()).toThrow(/no view has been shown yet/);
    expect(() => mgr.active()).toThrow(/no view has been shown yet/);
  });

  test("all returns the registered views in insertion order", () => {
    const mgr = new ViewManager();
    const a = new FakeRenderable();
    const b = new FakeRenderable();
    const c = new FakeRenderable();
    mgr.register(makeSpec("local", "Local", a as unknown as Renderable));
    mgr.register(makeSpec("fleet", "Fleet", b as unknown as Renderable));
    mgr.register(makeSpec("logs", "Logs", c as unknown as Renderable));
    expect(mgr.all().map((v) => v.id)).toEqual(["local", "fleet", "logs"]);
  });

  test("hotkeysFor returns the view's hotkeys", () => {
    const mgr = new ViewManager();
    const a = new FakeRenderable();
    const hks: Hotkey[] = [{ key: "r", label: "refresh", run: () => {} }];
    mgr.register(
      makeSpec("local", "Local", a as unknown as Renderable, {
        hotkeys: hks,
      }),
    );
    expect(mgr.hotkeysFor("local")).toBe(hks);
    expect(mgr.hotkeysFor("fleet")).toEqual([]);
  });

  test("indexOf resolves a registered id and throws otherwise", () => {
    const mgr = new ViewManager();
    const a = new FakeRenderable();
    const b = new FakeRenderable();
    mgr.register(makeSpec("local", "Local", a as unknown as Renderable));
    mgr.register(makeSpec("fleet", "Fleet", b as unknown as Renderable));
    expect(mgr.indexOf("local")).toBe(0);
    expect(mgr.indexOf("fleet")).toBe(1);
    expect(() => mgr.indexOf("logs")).toThrow(/unknown view id 'logs'/);
  });

  test("show to the active id is a no-op for lifecycle hooks", () => {
    const mgr = new ViewManager();
    const calls: string[] = [];
    const a = new FakeRenderable();
    mgr.register(
      makeSpec("local", "Local", a as unknown as Renderable, {
        onShow: () => calls.push("local.show"),
        onHide: () => calls.push("local.hide"),
      }),
    );
    mgr.show("local");
    mgr.show("local");
    expect(calls).toEqual(["local.show"]);
    expect((a as unknown as { visible: boolean }).visible).toBe(true);
  });

  test("handleKey on the active spec is exposed via active()", () => {
    const mgr = new ViewManager();
    const a = new FakeRenderable();
    mgr.register(
      makeSpec("local", "Local", a as unknown as Renderable, {
        handleKey: () => true,
      }),
    );
    mgr.show("local");
    expect(mgr.active().handleKey?.(keyEvent("x"))).toBe(true);
  });
});

// Opt-in suite: real OpenTUI renderer. Gated because the renderer requires a
// native FFI backend that is not always available in CI.
const realSuite = describe.skipIf(!RUN_REAL_RENDERER);

realSuite("ViewManager (real OpenTUI renderer)", () => {
  test("renders a registered view through the real render context", async () => {
    const { createTestRenderer } = await import("@opentui/core/testing");
    const { Box } = await import("@opentui/core");
    const { renderer } = await createTestRenderer({ width: 80, height: 24 });
    const container = Box({ flexDirection: "column" }) as unknown as Renderable;
    const mgr = new ViewManager();
    mgr.register(makeSpec("local", "Local", container));
    mgr.show("local");
    expect(renderer).toBeDefined();
    expect(mgr.activeId()).toBe("local");
  });
});
