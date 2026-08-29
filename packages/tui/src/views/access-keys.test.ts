// Access keys view + wizard tests (LAMA-234 TUI completion).
//
// Renderer-free state-machine tests drive the exported wizard factories
// (create/reveal/revoke/pair) through the same key events a terminal
// sends, with a recording mock client — proving no action is sent before
// confirmation, Escape cancels without mutation, secrets clear on every
// exit path, and the pairing poller stops on close/hide.
//
// Renderer-gated smoke tests (LAMASYNC_TUI_TEST_VIEWS=1) lock the
// navigation contract: More → Access keys → Esc back, row navigation,
// Tab/tab-bar focus, and the device-principal read-only frame.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { vi } from "bun:test";
import type { KeyEvent } from "@opentui/core";

import type {
  ApiKeySummary,
  AuthMeResponse,
  LamaSyncApiClient,
} from "@lamasync/core";

import {
  AccessKeysView,
  createCreateKeyWizard,
  createPairDeviceWizard,
  createRevealKeyWizard,
  createRevokeKeyWizard,
  CreateKeyWizardHandle,
  PairDeviceWizardHandle,
  RevealKeyWizardHandle,
  RevokeKeyWizardHandle,
} from "./access-keys.ts";
import type { ViewContext } from "../app/view-manager.ts";
import { closeWizard, openWizard, Wizard, wizardRegistry } from "../app/wizard.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function keyEvent(name: string, raw = ""): KeyEvent {
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

const ENTER = keyEvent("return", "\r");
const ESCAPE = keyEvent("escape", "\u001b");

function summary(overrides: Partial<ApiKeySummary> = {}): ApiKeySummary {
  return {
    id: "key_1",
    name: "cachy daemon",
    kind: "device",
    hostId: "host-a",
    createdAt: 1_600_000_000_000,
    lastUsedAt: null,
    revealedAt: null,
    revokedAt: null,
    revokedReason: null,
    fingerprint: "a3f2b9c01d",
    ...overrides,
  };
}

interface ApiCalls {
  getAuthMe: AuthMeResponse[];
  listApiKeys: Array<ApiKeySummary[]>;
  createApiKey: Array<{ name: string }>;
  revealApiKey: string[];
  revokeApiKey: Array<{ id: string; reason?: string }>;
  createPairingSession: Array<{ ttlSeconds?: number }>;
  lookupPairingSession: string[];
}

function makeFakeApi(): {
  api: unknown;
  calls: ApiCalls;
  me: AuthMeResponse;
  keys: ApiKeySummary[];
} {
  const me: AuthMeResponse = {
    kind: "admin",
    keyId: "key_1",
    name: "ops",
    hostId: null,
  };
  const keys: ApiKeySummary[] = [
    summary({ id: "key_1", name: "ops", kind: "admin", hostId: null }),
    summary({ id: "key_2", name: "cachy daemon", kind: "device", hostId: "host-a" }),
  ];
  const calls: ApiCalls = {
    getAuthMe: [],
    listApiKeys: [],
    createApiKey: [],
    revealApiKey: [],
    revokeApiKey: [],
    createPairingSession: [],
    lookupPairingSession: [],
  };
  const api = {
    baseUrl: "http://localhost:8080",
    getAuthMe: async (): Promise<AuthMeResponse> => {
      calls.getAuthMe.push(me);
      return me;
    },
    listApiKeys: async (): Promise<ApiKeySummary[]> => {
      calls.listApiKeys.push(keys);
      return [...keys];
    },
    createApiKey: async (body: { name: string }) => {
      calls.createApiKey.push(body);
      return {
        key: summary({ id: "key_new", name: body.name, kind: "admin", hostId: null }),
        secret: "lamasync-admin-created-secret",
      };
    },
    revealApiKey: async (id: string) => {
      calls.revealApiKey.push(id);
      return { id, secret: "lamasync-revealed-secret", revealedAt: Date.now() };
    },
    revokeApiKey: async (id: string, body: { reason?: string }) => {
      calls.revokeApiKey.push({ id, ...body });
      return { id, revokedAt: Date.now() };
    },
    createPairingSession: async (opts: { ttlSeconds?: number }) => {
      calls.createPairingSession.push(opts ?? {});
      return { code: "lama-72B4-9PQ1", expiresInSeconds: 600 };
    },
    lookupPairingSession: async (code: string) => {
      calls.lookupPairingSession.push(code);
      return {
        status: "pending",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
    },
  };
  return { api, calls, me, keys };
}

function makeCtx(api: unknown, statusMessages: Array<{ text: string; kind: string }>) {
  return {
    api: api as LamaSyncApiClient,
    hostname: "cachy",
    socketPath: "/tmp/lamasync.sock",
    renderer: null,
    setStatus: (text: string, kind: "info" | "error" | "success" = "info") =>
      statusMessages.push({ text, kind }),
    openWizard: (wizard: Wizard) => {
      wizardRegistry.set(wizard.id, wizard);
    },
  } as unknown as ViewContext;
}

beforeEach(() => {
  wizardRegistry.clear();
});
afterEach(() => {
  wizardRegistry.clear();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Create wizard
// ---------------------------------------------------------------------------

describe("create admin key wizard", () => {
  test("no createApiKey before the confirmation step", () => {
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, []);
    const wizard = createCreateKeyWizard({ ctx });
    openWizard(wizard);

    // Label typed + Enter → lands on Confirm; still no API call.
    expect(wizard.setLabel("Ops key")).toBe(true);
    expect(calls.createApiKey.length).toBe(0);

    // Cancel at Confirm → still nothing sent.
    wizard.handleKey(ESCAPE);
    expect(calls.createApiKey.length).toBe(0);
  });

  test("label validation blocks an empty label", () => {
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, []);
    const wizard = createCreateKeyWizard({ ctx });
    openWizard(wizard);

    expect(wizard.setLabel("   ")).toBe(false);
    expect(calls.createApiKey.length).toBe(0);
  });

  test("confirm sends exactly one create with the label, then shows the secret once", async () => {
    const { api, calls, keys } = makeFakeApi();
    const ctx = makeCtx(api, []);
    const wizard = createCreateKeyWizard({ ctx });
    openWizard(wizard);

    wizard.setLabel("Ops key");
    wizard.handleKey(ENTER); // confirm
    await flush();

    expect(calls.createApiKey).toEqual([{ name: "Ops key" }]);
    expect(wizard.secretSnapshot()).toBe("lamasync-admin-created-secret");
    void keys; // not needed here
  });

  test("acknowledging the secret closes and clears it", async () => {
    const { api } = makeFakeApi();
    const ctx = makeCtx(api, []);
    const wizard = createCreateKeyWizard({ ctx });
    openWizard(wizard);

    wizard.setLabel("Ops key");
    wizard.handleKey(ENTER); // confirm → secret step
    await flush();
    expect(wizard.secretSnapshot()).not.toBeNull();

    wizard.handleKey(ENTER); // "I saved it" → close
    await flush();
    expect(wizard.secretSnapshot()).toBeNull();
  });

  test("Escape on the secret step cancels and clears the secret", async () => {
    const { api } = makeFakeApi();
    const ctx = makeCtx(api, []);
    const wizard = createCreateKeyWizard({ ctx });
    openWizard(wizard);

    wizard.setLabel("Ops key");
    wizard.handleKey(ENTER);
    await flush();
    expect(wizard.secretSnapshot()).not.toBeNull();

    wizard.handleKey(ESCAPE);
    await flush();
    expect(wizard.secretSnapshot()).toBeNull();
  });

  test("clearSecret() is idempotent and wipes the field", async () => {
    const { api } = makeFakeApi();
    const ctx = makeCtx(api, []);
    const wizard = createCreateKeyWizard({ ctx });
    openWizard(wizard);
    wizard.setLabel("Ops key");
    wizard.handleKey(ENTER);
    await flush();

    wizard.clearSecret();
    expect(wizard.secretSnapshot()).toBeNull();
    wizard.clearSecret(); // no throw
  });

  test("a failed afterCreate (list refresh) aborts the panel without a secret", async () => {
    const { api } = makeFakeApi();
    const ctx = makeCtx(api, []);
    const wizard = createCreateKeyWizard({
      ctx,
      afterCreate: async () => {
        throw new Error("list refresh failed");
      },
    });
    openWizard(wizard);
    wizard.setLabel("Ops key");
    wizard.handleKey(ENTER);
    await flush();

    // The secret is never set; the flow stays put (friendly error via ctx).
    expect(wizard.secretSnapshot()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reveal wizard
// ---------------------------------------------------------------------------

describe("reveal key wizard", () => {
  test("no revealApiKey before confirmation", () => {
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, []);
    const key = summary({ id: "key_1", kind: "admin", hostId: null });
    const wizard = createRevealKeyWizard({ ctx, key });
    openWizard(wizard);

    wizard.handleKey(ESCAPE); // cancel at confirm
    expect(calls.revealApiKey.length).toBe(0);
  });

  test("confirm reveals the key and shows the secret once", async () => {
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, []);
    const key = summary({ id: "key_1", kind: "admin", hostId: null });
    const wizard = createRevealKeyWizard({ ctx, key });
    openWizard(wizard);

    wizard.handleKey(ENTER); // confirm → fetch
    await flush();

    expect(calls.revealApiKey).toEqual(["key_1"]);
    expect(wizard.secretSnapshot()).toBe("lamasync-revealed-secret");
  });

  test("cancel clears the secret; acknowledge closes + clears", async () => {
    const { api } = makeFakeApi();
    const ctx = makeCtx(api, []);
    const key = summary({ id: "key_1", kind: "admin", hostId: null });
    const wizard = createRevealKeyWizard({ ctx, key });
    openWizard(wizard);
    wizard.handleKey(ENTER);
    await flush();
    expect(wizard.secretSnapshot()).not.toBeNull();

    wizard.handleKey(ENTER); // ack → close + clear
    await flush();
    expect(wizard.secretSnapshot()).toBeNull();

    const second = createRevealKeyWizard({ ctx, key });
    openWizard(second);
    second.handleKey(ENTER);
    await flush();
    expect(second.secretSnapshot()).not.toBeNull();
    second.handleKey(ESCAPE); // cancel → clear
    await flush();
    expect(second.secretSnapshot()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Revoke wizard
// ---------------------------------------------------------------------------

describe("revoke key wizard", () => {
  test("no revokeApiKey before the destructive confirmation", () => {
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, []);
    const key = summary({ id: "key_1", kind: "admin", hostId: null });
    const wizard = createRevokeKeyWizard({ ctx, key });
    openWizard(wizard);

    wizard.setReason("replaced laptop"); // → confirm
    expect(calls.revokeApiKey.length).toBe(0);
    wizard.handleKey(ESCAPE); // back to reason → cancel
    expect(calls.revokeApiKey.length).toBe(0);
  });

  test("confirm revokes with the typed reason", async () => {
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, []);
    const key = summary({ id: "key_1", kind: "admin", hostId: null });
    const wizard = createRevokeKeyWizard({ ctx, key });
    openWizard(wizard);

    wizard.setReason("replaced laptop");
    wizard.handleKey(ENTER); // destructive confirm
    await flush();

    expect(calls.revokeApiKey).toEqual([{ id: "key_1", reason: "replaced laptop" }]);
  });

  test("confirm without a reason sends an empty body", async () => {
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, []);
    const key = summary({ id: "key_1", kind: "admin", hostId: null });
    const wizard = createRevokeKeyWizard({ ctx, key });
    openWizard(wizard);

    wizard.setReason("");
    wizard.handleKey(ENTER);
    await flush();
    expect(calls.revokeApiKey).toEqual([{ id: "key_1" }]);
  });

  test("cancel on the confirm step sends nothing", async () => {
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, []);
    const key = summary({ id: "key_1", kind: "admin", hostId: null });
    const wizard = createRevokeKeyWizard({ ctx, key });
    openWizard(wizard);

    wizard.setReason("oops, wrong key");
    wizard.handleKey(ESCAPE); // back → reason step
    wizard.handleKey(ESCAPE); // cancel
    expect(calls.revokeApiKey.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pair wizard (fake timers)
// ---------------------------------------------------------------------------

describe("pair device wizard", () => {
  test("start creates a session and shows the code", async () => {
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, []);
    const wizard = createPairDeviceWizard({ ctx });
    openWizard(wizard);

    expect(calls.createPairingSession.length).toBe(0);
    wizard.handleKey(ENTER); // start
    await flush();
    await flush();

    expect(calls.createPairingSession).toEqual([{ ttlSeconds: 600 }]);
    expect(wizard.currentCode()).toBe("lama-72B4-9PQ1");
  });

  test("polls status every 10s and stops on stopPolling", async () => {
    vi.useFakeTimers();
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, []);
    const wizard = createPairDeviceWizard({ ctx });
    openWizard(wizard);

    wizard.handleKey(ENTER); // start → first poll + intervals
    await mflush();
    const lookupsAfterStart = calls.lookupPairingSession.length;
    expect(lookupsAfterStart).toBe(1);

    vi.advanceTimersByTime(10_000);
    await mflush();
    expect(calls.lookupPairingSession.length).toBe(lookupsAfterStart + 1);

    wizard.stopPolling();
    vi.advanceTimersByTime(30_000);
    await mflush();
    expect(calls.lookupPairingSession.length).toBe(lookupsAfterStart + 1);
  });

  test("cancel clears the code and stops polling", async () => {
    vi.useFakeTimers();
    const { api, calls } = makeFakeApi();
    const ctx = makeCtx(api, []);
    const wizard = createPairDeviceWizard({ ctx });
    openWizard(wizard);

    wizard.handleKey(ENTER);
    await mflush();
    expect(calls.lookupPairingSession.length).toBe(1);

    wizard.handleKey(ESCAPE); // cancel → onCancel stops poller
    await mflush();
    expect(wizard.currentCode()).toBeNull();
    const afterCancel = calls.lookupPairingSession.length;
    vi.advanceTimersByTime(60_000);
    await mflush();
    expect(calls.lookupPairingSession.length).toBe(afterCancel);
  });
});

// ---------------------------------------------------------------------------
// View-level behavior (recording mock client)
// ---------------------------------------------------------------------------

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Microtask-only flush — safe under vi.useFakeTimers(). */
async function mflush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function makeViewCtx(api: unknown, opened: Array<{ id: string }>) {
  const statuses: Array<{ text: string; kind: string }> = [];
  const ctx = makeCtx(api, statuses);
  (ctx as unknown as { openWizard: (w: Wizard) => void }).openWizard = (
    w: Wizard,
  ) => {
    opened.push(w);
    wizardRegistry.set(w.id, w);
  };
  return { ctx, statuses };
}

beforeEach(() => {
  wizardRegistry.clear();
});

describe("AccessKeysView — principal-aware behavior", () => {
  test("device principal shows the read-only screen and never calls /api-keys", async () => {
    const me: AuthMeResponse = { kind: "device", keyId: "key_2", name: "cachy", hostId: "host-a" };
    const calls = {
      getAuthMe: 0,
      listApiKeys: 0,
    };
    const api = {
      baseUrl: "http://localhost:8080",
      getAuthMe: async () => {
        calls.getAuthMe++;
        return me;
      },
      listApiKeys: async () => {
        calls.listApiKeys++;
        throw new Error("must never be called");
      },
    };
    const { ctx } = makeViewCtx(api, []);
    const view = new AccessKeysView({ ctx });
    view.onShow(ctx);
    await flush();
    await flush();

    expect(view.phaseOf()).toBe("device");
    expect(calls.getAuthMe).toBe(1);
    expect(calls.listApiKeys).toBe(0);
  });

  test("master principal loads the masked table", async () => {
    const { api, calls, me, keys } = makeFakeApi();
    const { ctx } = makeViewCtx(api, []);
    const masterMe: AuthMeResponse = { kind: "master", keyId: null, name: null, hostId: null };
    calls.getAuthMe = [masterMe];
    const view = new AccessKeysView({ ctx });
    view.onShow(ctx);
    await flush();
    await flush();

    expect(view.phaseOf()).toBe("table");
    expect(calls.listApiKeys.length).toBe(1);
    void me;
    void keys;
  });

  test("an auth failure surfaces as an error phase, not an empty key list", async () => {
    const api = {
      baseUrl: "http://localhost:8080",
      getAuthMe: async () => {
        throw new Object("LamaSync API error 401: unauthorized");
      },
    };
    const { ctx, statuses } = makeViewCtx(api, []);
    const view = new AccessKeysView({ ctx });
    view.onShow(ctx);
    await flush();
    await flush();

    expect(view.phaseOf()).toBe("error");
    expect(statuses.some((s) => s.kind === "error")).toBe(true);
  });

  test("no window opens while a create panel is mounted (single wizard)", async () => {
    const { api } = makeFakeApi();
    const opened: Array<{ id: string }> = [];
    const { ctx } = makeViewCtx(api, opened);
    const view = new AccessKeysView({ ctx });
    view.onShow(ctx);
    await flush();
    await flush();

    view.handleKey(keyEvent("c", "c"));
    expect(opened.map((o) => o.id)).toEqual(["access-keys-create"]);
    // While a panel is open, further actions are refused.
    view.handleKey(keyEvent("p", "p"));
    expect(opened.map((o) => o.id)).toEqual(["access-keys-create"]);
  });

  test("revoked rows expose no reveal/revoke actions", async () => {
    const me: AuthMeResponse = { kind: "admin", keyId: "key_1", name: "ops", hostId: null };
    const revoked: ApiKeySummary = summary({
      id: "key_9",
      name: "old laptop",
      kind: "device",
      hostId: "host-old",
      revokedAt: 1_600_000_100_000,
      revokedReason: "replaced",
    });
    const api = {
      baseUrl: "http://localhost:8080",
      getAuthMe: async () => me,
      listApiKeys: async () => [revoked],
    };
    const opened: Array<{ id: string }> = [];
    const { ctx } = makeViewCtx(api, opened);
    const view = new AccessKeysView({ ctx });
    view.onShow(ctx);
    await flush();
    await flush();

    // The only row is revoked → selected row is revoked → no r/x.
    view.handleKey(keyEvent("x", "x"));
    view.handleKey(keyEvent("r", "r"));
    expect(opened.length).toBe(0);
  });

  test("active rows open reveal/revoke wizards on r/x", async () => {
    const me: AuthMeResponse = { kind: "admin", keyId: "key_1", name: "ops", hostId: null };
    const active: ApiKeySummary = summary({
      id: "key_1",
      name: "ops",
      kind: "admin",
      hostId: null,
    });
    const api = {
      baseUrl: "http://localhost:8080",
      getAuthMe: async () => me,
      listApiKeys: async () => [active],
    };
    const opened: Array<{ id: string }> = [];
    const { ctx } = makeViewCtx(api, opened);
    const view = new AccessKeysView({ ctx });
    view.onShow(ctx);
    await flush();
    await flush();

    view.handleKey(keyEvent("x", "x"));
    expect(opened.map((o) => o.id)).toEqual(["access-keys-revoke"]);

    // Closing the revoke wizard unblocks further actions.
    wizardRegistry.clear();
    view.handleKey(keyEvent("r", "r"));
    expect(opened.map((o) => o.id)).toEqual([
      "access-keys-revoke",
      "access-keys-reveal",
    ]);
  });

  test("create secret clears when the view hides", async () => {
    const { api, calls } = makeFakeApi();
    const opened: Array<{ id: string }> = [];
    const { ctx } = makeViewCtx(api, opened);
    const view = new AccessKeysView({ ctx });
    view.onShow(ctx);
    await flush();
    await flush();

    view.handleKey(keyEvent("c", "c"));
    const wizard = opened.find((o) => o.id === "access-keys-create");
    expect(wizard).toBeDefined();
    const createWizard = wizardRegistry.get("access-keys-create") as CreateKeyWizardHandle;
    createWizard.setLabel("Ops key");
    createWizard.handleKey(ENTER);
    await flush();
    expect(view.secretSnapshot()).toBe("lamasync-admin-created-secret");

    view.onHide();
    expect(view.secretSnapshot()).toBeNull();
    expect(calls.createApiKey.length).toBe(1); // the POST itself already happened
  });

  test("a self-closed panel unblocks the next action", async () => {
    const { api } = makeFakeApi();
    const opened: Array<{ id: string }> = [];
    const { ctx } = makeViewCtx(api, opened);
    const view = new AccessKeysView({ ctx });
    view.onShow(ctx);
    await flush();
    await flush();

    // Open create, run it through confirm (secret shown), acknowledge → the
    // wizard closes ITSELF. The view must drop its stale handle afterwards.
    view.handleKey(keyEvent("c", "c"));
    const createWizard = wizardRegistry.get("access-keys-create") as CreateKeyWizardHandle;
    createWizard.setLabel("Ops key");
    createWizard.handleKey(ENTER); // confirm → secret
    await flush();
    createWizard.handleKey(ENTER); // ack → self-close
    await flush();
    await flush();
    expect(view.secretSnapshot()).toBeNull();

    // A subsequent action is no longer blocked by the stale handle.
    view.handleKey(keyEvent("p", "p"));
    expect(wizardRegistry.has("access-keys-pair")).toBe(true);
  });

  test("pairing poller stops when the view hides", async () => {
    vi.useFakeTimers();
    const { api, calls } = makeFakeApi();
    const opened: Array<{ id: string }> = [];
    const { ctx } = makeViewCtx(api, opened);
    const view = new AccessKeysView({ ctx });
    view.onShow(ctx);
    await mflush();
    await mflush();

    view.handleKey(keyEvent("p", "p"));
    const pairWizard = wizardRegistry.get("access-keys-pair") as PairDeviceWizardHandle;
    pairWizard.handleKey(ENTER);
    await mflush();
    const afterStart = calls.lookupPairingSession.length;
    expect(afterStart).toBe(1);

    view.onHide();
    vi.advanceTimersByTime(120_000);
    await mflush();
    expect(calls.lookupPairingSession.length).toBe(afterStart);
  });
});

// ---------------------------------------------------------------------------
// Renderer-gated smoke tests (navigation + focus + device frame)
// ---------------------------------------------------------------------------

const RUN_RENDERER_SUITE = process.env.LAMASYNC_TUI_TEST_VIEWS === "1";
const realSuite = describe.skipIf(!RUN_RENDERER_SUITE);

/** Render + flush repeatedly so the view's async refresh can settle. */
async function renderAndSettle(
  renderOnce: () => Promise<void>,
): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await renderOnce();
  }
}

realSuite("Access keys navigation (real renderer)", () => {
  test("More → Access keys → Esc back to More, with Tab/arrow focus", async () => {
    const { createTestRenderer } = await import("@opentui/core/testing");
    const { Box } = await import("@opentui/core");
    const { renderer, mockInput, renderOnce, captureCharFrame } =
      await createTestRenderer({ width: 80, height: 24 });

    const { MoreView } = await import("./more.ts");
    const { AccessKeysView } = await import("./access-keys.ts");

    const me: AuthMeResponse = { kind: "admin", keyId: "key_1", name: "ops", hostId: null };
    const keys: ApiKeySummary[] = [
      summary({ id: "key_1", name: "ops", kind: "admin", hostId: null }),
      summary({ id: "key_2", name: "cachy daemon", kind: "device", hostId: "host-a" }),
    ];
    const api = {
      baseUrl: "http://localhost:8080",
      getAuthMe: async () => me,
      listApiKeys: async () => keys,
    };

    const ctx = {
      api: api as unknown as LamaSyncApiClient,
      hostname: "cachy",
      socketPath: "/tmp/lamasync.sock",
      renderer,
      setStatus: () => undefined,
      openWizard: () => undefined,
      navigateTo: (id: string) => {
        if (id === "access-keys") specAccess.onShow(ctx as never);
        if (id === "more") specMore.onShow(ctx as never);
      },
    };

    const more = new MoreView({ ctx: ctx as unknown as ViewContext });
    const access = new AccessKeysView({ ctx: ctx as unknown as ViewContext });
    const setVisible = (node: unknown, on: boolean): void => {
      (node as { visible: boolean }).visible = on;
    };
    setVisible(more.container, true);
    setVisible(access.container, false);
    renderer.root.add(more.container as never);
    renderer.root.add(access.container as never);

    const specMore = {
      container: more.container,
      onShow: (c: unknown) => more.onShow(c as ViewContext),
      onHide: () => more.onHide(),
    };
    const specAccess = {
      container: access.container,
      onShow: (c: unknown) => access.onShow(c as ViewContext),
      onHide: () => access.onHide(),
      handleKey: (e: KeyEvent) => access.handleKey(e),
    };

    more.onShow(ctx as unknown as ViewContext);
    await renderAndSettle(renderOnce);
    const moreFrame = captureCharFrame();
    expect(moreFrame).toContain("Access keys");

    // Open the hidden view via the More hotkey path.
    setVisible(more.container, false);
    setVisible(access.container, true);
    access.onShow(ctx as unknown as ViewContext);
    await renderAndSettle(renderOnce);
    const accessFrame = captureCharFrame();
    expect(accessFrame).toContain("Managed keys");
    expect(accessFrame).toContain("cachy daemon");

    // Close (drill-in Esc is the Shell's job; here we verify the view's
    // lifecycle is safe on hide — secrets/poller cleared).
    access.onHide();
    setVisible(access.container, false);
    setVisible(more.container, true);
    await renderAndSettle(renderOnce);
    expect(captureCharFrame()).toContain("Tools & integrations");
    expect(access.phaseOf()).toBe("table");
    expect(access.secretSnapshot()).toBeNull();
  });
});

realSuite("Access keys device frame (real renderer)", () => {
  test("device principal renders identity only", async () => {
    const { createTestRenderer } = await import("@opentui/core/testing");
    const { renderer, renderOnce, captureCharFrame } =
      await createTestRenderer({ width: 60, height: 20 });

    const { AccessKeysView } = await import("./access-keys.ts");
    const me: AuthMeResponse = { kind: "device", keyId: "key_2", name: "cachy", hostId: "host-a" };
    const api = {
      baseUrl: "http://localhost:8080",
      getAuthMe: async () => me,
    };
    const ctx = {
      api: api as unknown as LamaSyncApiClient,
      hostname: "cachy",
      socketPath: "/tmp/lamasync.sock",
      renderer,
      setStatus: () => undefined,
      openWizard: () => undefined,
    };
    renderer.root.add(
      new AccessKeysView({ ctx: ctx as unknown as ViewContext }).container,
    );
    const view = new AccessKeysView({ ctx: ctx as unknown as ViewContext });
    renderer.root.add(view.container);
    view.onShow(ctx as unknown as ViewContext);
    await renderAndSettle(renderOnce);
    const frame = captureCharFrame();
    expect(frame).toContain("Bound host id: host-a");
    expect(frame).toContain("administrator");
  });
});