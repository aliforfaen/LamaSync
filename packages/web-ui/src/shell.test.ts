// LAMA-329 — the embedded display-mode signal.
//
// The signal may only ever change presentation, so what is worth pinning down
// here is that it stays narrow and predictable: it resolves from a query or
// from stored session state, tolerates garbage, and never invents a third
// mode. That it is not consulted by any authorization path is structural — no
// API module imports this one.

import { describe, expect, it } from "bun:test";
import {
  EMBEDDED_SHELL_VALUE,
  SHELL_PARAM,
  resolveShellMode,
} from "./shell.ts";

describe("shell mode resolution", () => {
  it("resolves the companion's signal from the query", () => {
    expect(resolveShellMode(`?${SHELL_PARAM}=${EMBEDDED_SHELL_VALUE}`, null)).toBe("embedded");
  });

  it("carries the mode across hash navigation via stored session state", () => {
    // HashRouter navigation changes location.hash only; the search string is
    // gone, so the stored value has to win.
    expect(resolveShellMode("", "embedded")).toBe("embedded");
    expect(resolveShellMode("", "browser")).toBe("browser");
  });

  it("lets a fresh explicit signal override stale stored state", () => {
    // A desktop browser that previously loaded the embedded URL must not stay
    // "embedded" one the parameter is gone... and an explicit non-android
    // value must actively demote a stored "embedded".
    expect(resolveShellMode(`?${SHELL_PARAM}=browser`, "embedded")).toBe("browser");
  });

  it("defaults to the browser when nothing is signalled", () => {
    expect(resolveShellMode("", null)).toBe("browser");
    expect(resolveShellMode("?tab=hosts", null)).toBe("browser");
  });

  it("ignores malformed or unknown values instead of throwing", () => {
    expect(resolveShellMode("?lamasyncShell", null)).toBe("browser");
    expect(resolveShellMode(`?${SHELL_PARAM}=`, "embedded")).toBe("browser");
    expect(resolveShellMode("#/hosts", null)).toBe("browser");
  });

  it("never reads a signal out of the fragment", () => {
    // The SPA is hash-routed, so the fragment holds our own routing state and
    // must never be able to smuggle the display-mode signal in.
    expect(resolveShellMode("#/hosts?lamasyncShell=android", null)).toBe("browser");
    expect(resolveShellMode(`?${SHELL_PARAM}=android#/hosts`, null)).toBe("embedded");
  });

  it("finds the signal among other query parameters", () => {
    expect(resolveShellMode(`?a=1&${SHELL_PARAM}=${EMBEDDED_SHELL_VALUE}&b=2`, null)).toBe(
      "embedded",
    );
  });

  it("only ever yields the two presentation modes", () => {
    // A nonsense value must not become a third mode string that some later
    // `=== "embedded"` check would silently mis-handle.
    expect(resolveShellMode(`?${SHELL_PARAM}=sneaky`, null)).toBe("browser");
  });
});
