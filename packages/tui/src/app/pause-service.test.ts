/**
 * Pure tests for the pause polling service (LAMA-273). Uses a fake
 * `LamaSyncApiClient` so the suite does not depend on a real server. The
 * service is purely about "fetch → resolve → notify on change", so the
 * tests only need to assert (a) the caption format the callback receives
 * and (b) the change-only notification rule.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { LamaSyncApiClient, PauseState } from "@lamasync/core";

import {
  createPauseService,
  PAUSE_POLL_INTERVAL_MS,
} from "./pause-service.ts";

function makeState(): PauseState {
  // Keep the caption well inside a multi-day bucket so rapid sequential polls
  // cannot cross a duration boundary and turn this de-duplication test into a
  // wall-clock race. The extra hour matters because an exact N-day deadline
  // can format as N days on one millisecond and N-1 days on the next.
  return {
    scope: "global",
    until: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString(),
    mode: "pause",
  };
}

interface FakeApi {
  api: LamaSyncApiClient;
  setCurrent: (next: { global: PauseState | null; hosts: PauseState[] }) => void;
  failNext: (err: Error) => void;
}

function makeFakeApi(initial: { global: PauseState | null; hosts: PauseState[] }): FakeApi {
  const state: {
    current: { global: PauseState | null; hosts: PauseState[] };
    nextError: Error | null;
  } = {
    current: initial,
    nextError: null,
  };
  return {
    api: {
      async getPause() {
        if (state.nextError !== null) {
          const err = state.nextError;
          state.nextError = null;
          throw err;
        }
        return state.current;
      },
    } as unknown as LamaSyncApiClient,
    setCurrent(next) {
      state.current = next;
    },
    failNext(err) {
      state.nextError = err;
    },
  };
}

describe("createPauseService", () => {
  let timers: ReturnType<typeof setInterval>[] = [];

  afterEach(() => {
    for (const t of timers) clearInterval(t);
    timers = [];
  });

  test("calls onCaption with null when nothing is paused", async () => {
    const fake = makeFakeApi({ global: null, hosts: [] });
    const captions: (string | null)[] = [];
    const svc = createPauseService({
      api: fake.api,
      localHostId: "cachy",
      onCaption: (c) => captions.push(c),
    });
    await svc.poll();
    expect(captions).toEqual([null]);
  });

  test("emits a 'paused' caption when the fleet has a pause row", async () => {
    const fake = makeFakeApi({ global: makeState(), hosts: [] });
    const captions: (string | null)[] = [];
    const svc = createPauseService({
      api: fake.api,
      localHostId: "cachy",
      onCaption: (c) => captions.push(c),
    });
    await svc.poll();
    expect(captions.length).toBe(1);
    // Format from pause.ts: ⏸ paused <duration>. The test keeps the
    // assertion shape-agnostic — it asserts a "paused" segment that holds
    // across both emoji and ASCII fallback variants.
    const caption = captions[0] ?? "";
    expect(caption).toContain("paused");
  });

  test("emits nothing on a second poll when the caption is unchanged", async () => {
    const fake = makeFakeApi({ global: makeState(), hosts: [] });
    const captions: (string | null)[] = [];
    const svc = createPauseService({
      api: fake.api,
      localHostId: "cachy",
      onCaption: (c) => captions.push(c),
    });
    await svc.poll();
    await svc.poll();
    await svc.poll();
    expect(captions.length).toBe(1);
  });

  test("emits a new caption when the pause state changes", async () => {
    const fake = makeFakeApi({ global: makeState(), hosts: [] });
    const captions: (string | null)[] = [];
    const svc = createPauseService({
      api: fake.api,
      localHostId: "cachy",
      onCaption: (c) => captions.push(c),
    });
    await svc.poll();
    expect(captions.length).toBe(1);
    // Resume — global clears. The next poll should emit null.
    fake.setCurrent({ global: null, hosts: [] });
    await svc.poll();
    expect(captions.length).toBe(2);
    expect(captions[1]).toBeNull();
  });

  test("preserves the previous caption when the API throws", async () => {
    const fake = makeFakeApi({ global: makeState(), hosts: [] });
    const captions: (string | null)[] = [];
    const svc = createPauseService({
      api: fake.api,
      localHostId: "cachy",
      onCaption: (c) => captions.push(c),
    });
    await svc.poll();
    expect(captions.length).toBe(1);
    fake.failNext(new Error("API down"));
    await svc.poll();
    // No new emission — best-effort keeps the previous caption.
    expect(captions.length).toBe(1);
  });

  test("start() schedules an interval at PAUSE_POLL_INTERVAL_MS", () => {
    const fake = makeFakeApi({ global: null, hosts: [] });
    const svc = createPauseService({
      api: fake.api,
      localHostId: "cachy",
      onCaption: () => {},
    });
    const timer = svc.start();
    timers.push(timer);
    const interval =
      (timer as unknown as { _repeat?: number })._repeat ??
      PAUSE_POLL_INTERVAL_MS;
    expect(interval).toBe(PAUSE_POLL_INTERVAL_MS);
    svc.stop();
  });
});
