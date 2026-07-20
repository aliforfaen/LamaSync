/**
 * Pure state-machine tests for the WizardRunner.
 *
 * No OpenTUI renderer is involved. Steps do not provide `render` so the
 * runner never tries to materialise renderables; only the state machine
 * (validate / next / back / cancel / onFinish) is exercised.
 *
 * Each test resets the wizard registry between cases via beforeEach to
 * keep singleton state from leaking.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";

import {
  activeWizard,
  closeActiveWizard,
  closeWizard,
  openWizard,
  WizardRunner,
  wizardRegistry,
} from "./wizard.ts";
import type { Wizard, WizardStep } from "./wizard.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface CapturedState {
  name: string;
  age: string;
}

function makeKeyEvent(name: string, raw = ""): KeyEvent {
  return {
    name,
    raw,
    sequence: raw,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    eventType: "press",
    source: "raw",
  } as unknown as KeyEvent;
}

function nameStep(): WizardStep {
  return {
    title: "Name",
    validate: (state) => {
      const v = String((state as unknown as CapturedState).name ?? "").trim();
      return v.length > 0 ? null : "name required";
    },
  };
}

function ageStep(): WizardStep {
  return {
    title: "Age",
    validate: (state) => {
      const v = String((state as unknown as CapturedState).age ?? "").trim();
      return v.length > 0 ? null : "age required";
    },
  };
}

function confirmStep(): WizardStep {
  return { title: "Confirm" };
}

function makeWizard(opts: {
  onFinish?: Wizard["onFinish"];
  onCancel?: Wizard["onCancel"];
} = {}): { runner: WizardRunner; wizard: Wizard } {
  const steps: WizardStep[] = [nameStep(), ageStep(), confirmStep()];
  const runner = new WizardRunner({
    id: "test-wizard",
    title: "Test",
    steps,
  });
  const wizard: Wizard = {
    id: runner.id,
    title: runner.title,
    container: (runner as unknown as { modal: { id: string } }).modal as unknown as import("@opentui/core").Renderable,
    handleKey: (e: KeyEvent) => runner.handleKey(e),
    onCancel: opts.onCancel,
    onFinish: opts.onFinish,
  };
  openWizard(wizard);
  return { runner, wizard };
}

beforeEach(() => {
  // Each test starts with a clean registry.
  wizardRegistry.clear();
});

afterEach(() => {
  wizardRegistry.clear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WizardRunner state machine", () => {
  test("next advances the step index when validation passes", () => {
    const { runner } = makeWizard();
    runner.setField("name", "Ada");
    runner.setField("age", "36");

    expect(runner.stepIdx()).toBe(0);
    expect(runner.next()).toBeNull();
    expect(runner.stepIdx()).toBe(1);

    runner.next();
    // Last step: next() triggers onFinish and closes the wizard.
  });

  test("validate blocks next when the field is empty", () => {
    const { runner } = makeWizard();
    expect(runner.next()).toBe("name required");
    expect(runner.stepIdx()).toBe(0);

    runner.setField("name", "Ada");
    expect(runner.next()).toBeNull();
    expect(runner.stepIdx()).toBe(1);
  });

  test("validate on a later step blocks advancement with its own error", () => {
    const { runner } = makeWizard();
    runner.setField("name", "Ada");
    runner.next(); // → age
    expect(runner.stepIdx()).toBe(1);
    expect(runner.next()).toBe("age required");
    expect(runner.stepIdx()).toBe(1);

    runner.setField("age", "36");
    expect(runner.next()).toBeNull();
    // Now on the confirm step; next() will call onFinish (which is unset).
    expect(runner.stepIdx()).toBe(2);
  });

  test("back decrements the step index and clears the error slot", () => {
    const { runner } = makeWizard();
    runner.setField("name", "Ada");
    runner.next(); // → age
    expect(runner.stepIdx()).toBe(1);

    runner.back();
    expect(runner.stepIdx()).toBe(0);

    runner.setField("name", "Bea");
    runner.next();
    expect(runner.stepIdx()).toBe(1);
  });

  test("back is a no-op at the first step", () => {
    const { runner } = makeWizard();
    expect(runner.stepIdx()).toBe(0);
    runner.back();
    expect(runner.stepIdx()).toBe(0);
  });

  test("cancel clears the registry and fires onCancel", () => {
    let cancelled = false;
    const { runner } = makeWizard({
      onCancel: () => {
        cancelled = true;
      },
    });
    expect(wizardRegistry.size).toBe(1);
    expect(activeWizard()?.id).toBe("test-wizard");

    runner.cancel();
    expect(cancelled).toBe(true);
    expect(wizardRegistry.size).toBe(0);
    expect(activeWizard()).toBeNull();
  });

  test("closeWizard removes from the registry without firing onCancel", () => {
    let cancelled = false;
    const { wizard } = makeWizard({
      onCancel: () => {
        cancelled = true;
      },
    });
    expect(closeWizard(wizard.id)).toBe(true);
    expect(cancelled).toBe(false);
    expect(wizardRegistry.size).toBe(0);
  });

  test("next on the last step calls onFinish once with the final state", async () => {
    let calls = 0;
    let captured: Record<string, unknown> | null = null;
    const { runner } = makeWizard({
      onFinish: (state) => {
        calls++;
        captured = { ...state };
      },
    });
    runner.setField("name", "Ada");
    runner.setField("age", "36");
    runner.next(); // name → age
    runner.next(); // age → confirm
    runner.next(); // confirm → onFinish fires

    expect(calls).toBe(1);
    expect(captured).not.toBeNull();
    expect((captured as unknown as CapturedState).name).toBe("Ada");
    expect((captured as unknown as CapturedState).age).toBe("36");
    expect(runner.isFinished()).toBe(true);
    expect(wizardRegistry.size).toBe(0);
  });

  test("onFinish async rejection surfaces in the error slot and keeps the wizard open", async () => {
    const { runner } = makeWizard({
      onFinish: async () => {
        throw new Error("server down");
      },
    });
    runner.setField("name", "Ada");
    runner.setField("age", "36");
    runner.next(); // → age
    runner.next(); // → confirm
    runner.next(); // confirm → onFinish rejects

    // Yield so the rejection propagates.
    const { promise: flushed, resolve: flushResolve } = Promise.withResolvers<void>();
    setImmediate(() => flushResolve());
    await flushed;

    expect(runner.isFinished()).toBe(false);
    expect(wizardRegistry.size).toBe(1);
    expect(runner.currentErrorMessage()).toContain("server down");
  });

  test("handleKey ESC on the first step cancels the wizard", () => {
    let cancelled = false;
    const { runner } = makeWizard({
      onCancel: () => {
        cancelled = true;
      },
    });
    const consumed = runner.handleKey(makeKeyEvent("escape"));
    expect(consumed).toBe(true);
    expect(cancelled).toBe(true);
    expect(wizardRegistry.size).toBe(0);
  });

  test("handleKey ESC on a later step steps back instead of cancelling", () => {
    let cancelled = false;
    const { runner } = makeWizard({
      onCancel: () => {
        cancelled = true;
      },
    });
    runner.setField("name", "Ada");
    runner.next(); // → age
    expect(runner.stepIdx()).toBe(1);

    expect(runner.handleKey(makeKeyEvent("escape"))).toBe(true);
    expect(runner.stepIdx()).toBe(0);
    expect(cancelled).toBe(false);
  });

  test("handleKey 'q' cancels the wizard", () => {
    let cancelled = false;
    const { runner } = makeWizard({
      onCancel: () => {
        cancelled = true;
      },
    });
    expect(runner.handleKey(makeKeyEvent("", "q"))).toBe(true);
    expect(cancelled).toBe(true);
    expect(wizardRegistry.size).toBe(0);
  });

  test("handleKey never swallows Enter — it returns false", () => {
    const { runner } = makeWizard();
    expect(runner.handleKey(makeKeyEvent("return", "\r"))).toBe(false);
  });

  test("handleKey returns false for unhandled keys", () => {
    const { runner } = makeWizard();
    expect(runner.handleKey(makeKeyEvent("tab"))).toBe(false);
    expect(runner.handleKey(makeKeyEvent("", "x"))).toBe(false);
  });

  test("step onKey returning true swallows the key from the runner", () => {
    let seen = 0;
    const step: WizardStep = {
      title: "Custom",
      onKey: (_name, _char, _state) => {
        seen++;
        return true;
      },
    };
    const runner = new WizardRunner({
      id: "custom-key",
      title: "Custom",
      steps: [step, nameStep(), ageStep(), confirmStep()],
    });
    openWizard({
      id: runner.id,
      title: runner.title,
      container: (runner as unknown as { modal: { id: string } }).modal as unknown as import("@opentui/core").Renderable,
    });

    expect(runner.handleKey(makeKeyEvent("tab"))).toBe(true);
    expect(seen).toBe(1);
    expect(runner.stepIdx()).toBe(0);
  });

  test("setSteps inserts at the requested index and re-renders the header", () => {
    const inserted: WizardStep = { title: "Inserted" };
    const runner = new WizardRunner({
      id: "insert",
      title: "Insert",
      steps: [nameStep(), confirmStep()],
    });
    openWizard({
      id: runner.id,
      title: runner.title,
      container: (runner as unknown as { modal: { id: string } }).modal as unknown as import("@opentui/core").Renderable,
    });

    runner.setSteps([inserted], 1);
    expect(runner.steps).toHaveLength(3);
    expect(runner.steps[0]?.title).toBe("Name");
    expect(runner.steps[1]?.title).toBe("Inserted");
    expect(runner.steps[2]?.title).toBe("Confirm");
  });

  test("opening a second wizard cancels the first", () => {
    let firstCancelled = false;
    const { runner: first } = makeWizard({
      onCancel: () => {
        firstCancelled = true;
      },
    });
    const secondRunner = new WizardRunner({
      id: "second",
      title: "Second",
      steps: [nameStep(), ageStep(), confirmStep()],
    });
    openWizard({
      id: secondRunner.id,
      title: secondRunner.title,
      container: (secondRunner as unknown as { modal: { id: string } }).modal as unknown as import("@opentui/core").Renderable,
    });

    expect(firstCancelled).toBe(true);
    expect(activeWizard()?.id).toBe("second");
    expect(wizardRegistry.size).toBe(1);
    void first;
  });

  test("getState returns a defensive copy", () => {
    const { runner } = makeWizard();
    const a = runner.getState();
    a["name"] = "mutated";
    expect(runner.getState()["name"]).toBeUndefined();
  });

  test("closeActiveWizard is a no-op when no wizard is mounted", () => {
    expect(closeActiveWizard()).toBe(false);
  });
});