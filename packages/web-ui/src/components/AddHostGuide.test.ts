// LAMA-323/326 correction: the AddHostGuide onboarding copy must emit the
// canonical `--with-cli` install flag. The interactive TUI is gone, so the
// deprecated `--with-tui` alias must never appear in the copy-paste command.
// Pure-function test (no jsdom/DOM, repo convention: bun:test + react-dom/server).

import { describe, expect, it } from "bun:test";
import { buildInstallCommand } from "./AddHostGuide.tsx";

describe("AddHostGuide buildInstallCommand", () => {
  it("installs the local-first CLI (`--with-cli`) for the fleet", () => {
    const cmd = buildInstallCommand("http://lamasync.test:8080", "lmsk.abcdef12");

    expect(cmd).toContain("bash -s --");
    expect(cmd).toContain("--server-url http://lamasync.test:8080");
    expect(cmd).toContain("--api-key lmsk.abcdef12");
    expect(cmd).toContain("--with-cli");
  });

  it("never emits the deprecated `--with-tui` alias", () => {
    const cmd = buildInstallCommand("http://lamasync.test:8080", "lmsk.abcdef12");

    expect(cmd).not.toContain("--with-tui");
    expect(cmd).not.toContain("terminal UI");
  });
});
