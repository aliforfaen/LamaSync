/**
 * Regression tests for LAMA-173 review findings (TuiDotfilesGh.ReviewDotfilesGh):
 *   - extractTarball takes `appName` as a parameter (do NOT read state.appName
 *     inside; the selected snapshot must always retain its explicit identity).
 *   - onShow must trigger the first renderBody() — the body Box proxy is
 *     unparented in the constructor and calling getChildren() there throws
 *     under OpenTUI's VNode proxy semantics.
 *
 * We exercise the public type signatures only (no OpenTUI renderer dependency).
 */
import { describe, expect, test } from "bun:test";
import { DotfilesView, preservingExtractArgs } from "./dotfiles.ts";
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
    expect(v["extractTarball"].length).toBe(4);
  });

  test("legacy single-app restore preserves target files", () => {
    expect(
      preservingExtractArgs("/tmp/snapshot.tar.gz", "/target", ["settings.json"]),
    ).toEqual([
      "tar",
      "xzf",
      "--skip-old-files",
      "/tmp/snapshot.tar.gz",
      "-C",
      "/target",
      "settings.json",
    ]);
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
