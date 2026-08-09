// Integration test for the first-run setup wizard (WS3 review): drives the
// real wizard through OpenTUI's test renderer with mock keys. Guards the
// OpenTUI 0.1.107 pitfalls found in review:
//   - Input submits via an "enter" event (onSubmit never fires on Input)
//   - step bodies must be realized + focused, or typing lands nowhere
//   - the outgoing step's focused widget must be blurred, or it keeps
//     eating keys after removal
//   - typing q / ? / [ into a focused Input must not cancel the wizard

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, createMockKeys, KeyCodes } from "@opentui/core/testing";
import { Box } from "@opentui/core";
import type { CliRenderer, Renderable } from "@opentui/core";

import { closeActiveWizard } from "../app/wizard.ts";
import { createSetupWizard } from "./setup.ts";
import type { SetupConfig, SetupOutcome } from "./setup.ts";

describe("first-run setup wizard (test renderer)", () => {
  let renderer: CliRenderer | null = null;

  afterEach(() => {
    closeActiveWizard();
    renderer?.destroy();
    renderer = null;
  });

  test("full flow: type through every step, Enter advances, config written", async () => {
    const created = await createTestRenderer({ width: 100, height: 30 });
    renderer = created.renderer;
    const keys = createMockKeys(renderer);

    const overlay = Box({ flexDirection: "column", flexGrow: 1 }) as unknown as Renderable;
    renderer.root.add(overlay);

    let written: SetupConfig | null = null;
    let outcome: SetupOutcome | null = null;
    const { wizard, runner } = createSetupWizard({
      renderer,
      writeConfig: (cfg) => {
        written = cfg;
      },
      onDone: (o) => {
        outcome = o;
      },
      defaultHostname: "testhost",
    });
    const { openWizard } = await import("../app/wizard.ts");
    openWizard(wizard);
    runner.setOverlayHost(overlay);
    renderer.start();

    // Mirrors runSetupFlow's handler.
    renderer.keyInput.on("keypress", (e) => {
      if (wizard.handleKey?.(e) === true) e.preventDefault();
    });

    expect(runner.stepIdx()).toBe(0);

    // Step 1: server URL (prefilled — typing appends; we just check it lands).
    await keys.typeText("//edited");
    await keys.pressKey(KeyCodes.RETURN);
    expect(runner.stepIdx()).toBe(1);
    expect(String(runner.getState()["serverUrl"])).toContain("//edited");

    // Step 2: API key — chars that double as wizard/global keys must type.
    await keys.typeText("key-with-q?[123");
    await keys.pressKey(KeyCodes.RETURN);
    expect(runner.stepIdx()).toBe(2);
    expect(runner.getState()["apiKey"]).toBe("key-with-q?[123");

    // Step 3: hostname (prefilled) → Enter to confirm step.
    await keys.pressKey(KeyCodes.RETURN);
    expect(runner.stepIdx()).toBe(3);

    // Confirm step: Enter writes the config and resolves the flow.
    await keys.pressKey(KeyCodes.RETURN);
    await new Promise((r) => setTimeout(r, 50));
    // Assigned inside the wizard's callbacks — TS can't track that.
    expect(outcome as SetupOutcome | null).toBe("saved");
    expect(written).not.toBeNull();
    expect((written as unknown as SetupConfig).apiKey).toBe("key-with-q?[123");
    expect((written as unknown as SetupConfig).hostname).toBe("testhost");
  }, 15_000);
});
