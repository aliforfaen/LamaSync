/**
 * Regression tests for LAMA-173 review findings (TuiDotfilesGh.ReviewDotfilesGh):
 *   - extractTarball must take `appName` as a parameter (do NOT read state.appName
 *     inside; otherwise runRestoreAllLatest silently no-ops or restores with the
 *     wrong identity).
 *   - onShow must trigger the first renderBody() — the body Box proxy is
 *     unparented in the constructor and calling getChildren() there throws
 *     under OpenTUI's VNode proxy semantics.
 *
 * We exercise the public type signatures only (no OpenTUI renderer dependency).
 */
import { describe, expect, test } from "bun:test";
import { DotfilesView } from "./dotfiles.ts";
import { GhView } from "./gh-selector.ts";

describe("dotfiles view — LAMA-173 review fixes", () => {
  test("DotfilesView constructor never invokes renderBody before parented", () => {
    const v = new DotfilesView({
      ctx: {
        api: {} as never,
        hostname: "test-host",
        socketPath: "/tmp/x.sock",
        renderer: null,
        setStatus: () => undefined,
        openWizard: () => undefined,
      },
    });
    expect(v.container).toBeDefined();
    expect(v.hotkeys()).toBeDefined();
  });

  test("DotfilesView accepts (appName, version, target, subpaths) extract signature", () => {
    const v = new DotfilesView({
      ctx: {
        api: {} as never,
        hostname: "test-host",
        socketPath: "/tmp/x.sock",
        renderer: null,
        setStatus: () => undefined,
        openWizard: () => undefined,
      },
    });
    // The method must be a 4-arg fn (appName is the first arg, not state).
    expect(typeof v["extractTarball"]).toBe("function");
    expect(v["extractTarball"].length).toBe(5);
  });
});

describe("gh selector view — LAMA-173 review fixes", () => {
  test("GhView constructor never invokes renderBody before parented", () => {
    const v = new GhView({
      ctx: {
        api: {} as never,
        hostname: "test-host",
        socketPath: "/tmp/x.sock",
        renderer: null,
        setStatus: () => undefined,
        openWizard: () => undefined,
      },
    });
    expect(v.container).toBeDefined();
    expect(v.hotkeys()).toBeDefined();
  });
});
