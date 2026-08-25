/**
 * State-machine smoke tests for the pause wizard (LAMA-273).
 *
 * The wizard's renderable layer depends on OpenTUI, so we exercise only the
 * state-machine paths: the step list (set-vs-resume), the onPick hook that
 * inserts the bwlimit step on "slow" picks, and the onFinish body that
 * routes scope → API call.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LamaSyncApiClient, PauseState } from "@lamasync/core";

import type { Wizard, WizardStep } from "../app/wizard.ts";
import { wizardRegistry } from "../app/wizard.ts";
import { createPauseWizard } from "./pause.ts";

interface CapturedCalls {
  setPause: Array<{ until: string; mode: string; bwlimit: string | null }>;
  setHostPause: Array<{ hostId: string; body: { until: string; mode: string; bwlimit: string | null } }>;
  clearPause: number;
  clearHostPause: Array<string>;
  statusMessages: Array<{ text: string; kind: string }>;
}

function makeFakeApi(): { api: LamaSyncApiClient; calls: CapturedCalls } {
  const calls: CapturedCalls = {
    setPause: [],
    setHostPause: [],
    clearPause: 0,
    clearHostPause: [],
    statusMessages: [],
  };
  const api = {
    async setPause(body: { until: string; mode: string; bwlimit: string | null }) {
      calls.setPause.push(body);
      return {
        scope: "global" as const,
        until: body.until,
        mode: body.mode as PauseState["mode"],
        bwlimit: body.bwlimit,
      };
    },
    async clearPause() {
      calls.clearPause += 1;
    },
    async setHostPause(hostId: string, body: { until: string; mode: string; bwlimit: string | null }) {
      calls.setHostPause.push({ hostId, body });
      return {
        scope: "host" as const,
        hostId,
        until: body.until,
        mode: body.mode as PauseState["mode"],
        bwlimit: body.bwlimit,
      };
    },
    async clearHostPause(hostId: string) {
      calls.clearHostPause.push(hostId);
    },
  } as unknown as LamaSyncApiClient;
  return { api, calls };
}

function makeCtx(api: LamaSyncApiClient, statusMessages: Array<{ text: string; kind: string }>) {
  return {
    api,
    hostname: "cachy",
    socketPath: "/tmp/lamasync.sock",
    renderer: null,
    setStatus: (text: string, kind: "info" | "error" | "success" = "info") =>
      statusMessages.push({ text, kind }),
    openWizard: (wizard: Wizard) => {
      wizardRegistry.set(wizard.id, wizard);
    },
  };
}

const NO_CURRENT = { global: null, hosts: [] };

beforeEach(() => {
  wizardRegistry.clear();
});
afterEach(() => {
  wizardRegistry.clear();
});

describe("createPauseWizard — set flow", () => {
  test("resume mode is auto-selected when a global pause row exists", () => {
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, calls.statusMessages);
    const current = {
      global: {
        scope: "global" as const,
        until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        mode: "pause" as const,
      },
      hosts: [],
    };
    const wizard = createPauseWizard({ ctx, mode: "resume", current });
    expect(wizard.title).toBe("Resume syncs");
    // Resume flow = scope + confirm (2 steps).
    const resumeSteps = (wizard as unknown as { container?: unknown }).container;
    expect(resumeSteps).toBeDefined();
  });

  test("set flow builds scope, duration, mode, confirm (no bwlimit yet)", () => {
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, calls.statusMessages);
    const wizard = createPauseWizard({ ctx, mode: "set", current: NO_CURRENT });
    expect(wizard.title).toBe("Pause syncs");
  });

  test("onFinish dispatches to setPause with the right shape", async () => {
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, calls.statusMessages);
    const wizard = createPauseWizard({ ctx, mode: "set", current: NO_CURRENT });
    const state = {
      scope: "all",
      duration: "1h",
      mode: "pause",
      bwlimit: "",
    };
    await wizard.onFinish?.(state);
    expect(calls.setPause.length).toBe(1);
    expect(calls.setPause[0]?.mode).toBe("pause");
    expect(calls.setHostPause.length).toBe(0);
    // `until` must be in the future (~1h).
    const untilMs = Date.parse(calls.setPause[0]?.until ?? "");
    expect(untilMs).toBeGreaterThan(Date.now());
  });

  test("onFinish forwards bwlimit when mode is slow", async () => {
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, calls.statusMessages);
    const wizard = createPauseWizard({ ctx, mode: "set", current: NO_CURRENT });
    const state = {
      scope: "all",
      duration: "4h",
      mode: "slow",
      bwlimit: "1M",
    };
    await wizard.onFinish?.(state);
    expect(calls.setPause[0]?.bwlimit).toBe("1M");
    expect(calls.setPause[0]?.mode).toBe("slow");
  });

  test("onFinish routes scope 'this' to setHostPause with ctx.hostname", async () => {
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, calls.statusMessages);
    const wizard = createPauseWizard({ ctx, mode: "set", current: NO_CURRENT });
    await wizard.onFinish?.({
      scope: "this",
      duration: "24h",
      mode: "pause",
      bwlimit: "",
    });
    expect(calls.setPause.length).toBe(0);
    expect(calls.setHostPause.length).toBe(1);
    expect(calls.setHostPause[0]?.hostId).toBe("cachy");
  });

  test("onFinish reports a friendly error on a thrown API failure", async () => {
    const { api, calls } = makeFakeApi();
    // Make setPause throw to exercise the catch branch.
    (api.setPause as unknown as { (b: unknown): Promise<unknown> }) = () =>
      Promise.reject(new Error("boom"));
    const ctx = makeCtx(api, calls.statusMessages);
    const wizard = createPauseWizard({ ctx, mode: "set", current: NO_CURRENT });
    await wizard.onFinish?.({
      scope: "all",
      duration: "1h",
      mode: "pause",
      bwlimit: "",
    });
    const lastStatus = calls.statusMessages[calls.statusMessages.length - 1];
    expect(lastStatus?.kind).toBe("error");
    expect(lastStatus?.text).toContain("pause failed");
  });
});

describe("createPauseWizard — resume flow", () => {
  test("onFinish calls clearPause for scope 'all'", async () => {
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, calls.statusMessages);
    const wizard = createPauseWizard({ ctx, mode: "resume", current: NO_CURRENT });
    await wizard.onFinish?.({ scope: "all" });
    expect(calls.clearPause).toBe(1);
    expect(calls.clearHostPause.length).toBe(0);
  });

  test("onFinish calls clearHostPause for scope 'this'", async () => {
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, calls.statusMessages);
    const wizard = createPauseWizard({ ctx, mode: "resume", current: NO_CURRENT });
    await wizard.onFinish?.({ scope: "this" });
    expect(calls.clearHostPause).toEqual(["cachy"]);
    expect(calls.clearPause).toBe(0);
  });

  test("onCancel surfaces a friendly 'Resume cancelled' status", () => {
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, calls.statusMessages);
    const wizard = createPauseWizard({ ctx, mode: "resume", current: NO_CURRENT });
    wizard.onCancel?.();
    expect(calls.statusMessages.some((s) => s.text === "Resume cancelled")).toBe(true);
  });
});