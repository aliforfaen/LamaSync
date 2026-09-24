// LAMA-346 Stage 2f — the seed-pilot panel's decisions, DOM-free.
//
// The panel's two easy-to-get-wrong parts are pure and live here rather than in
// the JSX: what the form sends (an empty choice must be a REFUSAL, never a null
// that widens the authorization) and how the readiness verdict reads (it must
// always name the bucket it is about, so a stale pass is visible as stale).

import { describe, expect, test } from "bun:test";
import {
  seedPilotDraft,
  seedPilotReadinessSentence,
  seedPilotSaveBody,
  seedPilotStatusSentence,
  type SeedPilotDraft,
} from "./SeedPilotPanel.tsx";
import type { SeedPilotView } from "@lamasync/core";

function view(over: Partial<SeedPilotView["config"]> = {}, probe?: { ok: boolean; detail: string | null }): SeedPilotView {
  return {
    config: {
      enabled: true,
      folderId: "f1",
      sourceHostId: "master",
      targetHostId: "dev-vm",
      backendId: "b2-tmp",
      bucket: "lamasync-tmp",
      updatedAt: 1,
      readiness: { state: "ready", bucket: "lamasync-tmp", checkedAt: 1, message: "probe passed" },
      ...over,
    },
    summary: "The seed pilot authorizes f1 (master → dev-vm).",
    options: { folders: [], hosts: [], backends: [] },
    ...(probe === undefined ? {} : { probe }),
  };
}

describe("the pilot form's draft round-trips through the API grammar", () => {
  test("an empty view drafts nothing, and saving it sends nulls rather than empty strings", () => {
    const draft = seedPilotDraft(null);
    expect(draft).toEqual({
      enabled: false,
      folderId: "",
      sourceHostId: "",
      targetHostId: "",
      backendId: "",
      bucket: "",
    });
    expect(seedPilotSaveBody(draft)).toEqual({
      enabled: false,
      folderId: null,
      sourceHostId: null,
      targetHostId: null,
      backendId: null,
      bucket: null,
      confirm: true,
    });
  });

  test("whitespace-only fields are nulls, so a stray space cannot look like a choice", () => {
    const draft: SeedPilotDraft = {
      enabled: true,
      folderId: "  ",
      sourceHostId: " master ",
      targetHostId: "dev-vm",
      backendId: "b2-tmp",
      bucket: "lamasync-tmp",
    };
    const body = seedPilotSaveBody(draft);
    expect(body.folderId).toBeNull();
    expect(body.sourceHostId).toBe("master");
    expect(body.confirm).toBe(true);
  });

  test("a stored config drafts back exactly", () => {
    const draft = seedPilotDraft(view());
    expect(draft.enabled).toBe(true);
    expect(draft.bucket).toBe("lamasync-tmp");
    expect(seedPilotSaveBody(draft).folderId).toBe("f1");
  });
});

describe("the readiness line never overstates the probe", () => {
  test("an unprobed space says so and names the action", () => {
    const sentence = seedPilotReadinessSentence(
      view({ readiness: { state: "unknown", bucket: null, checkedAt: null, message: null } }),
    );
    expect(sentence).toContain("has not been probed");
    expect(sentence).toContain("Test seed space");
  });

  test("a pass names the bucket it was proven against", () => {
    expect(seedPilotReadinessSentence(view())).toContain("lamasync-tmp");
  });

  test("a failure carries the reason and is not softened", () => {
    const sentence = seedPilotReadinessSentence(
      view({ readiness: { state: "failed", bucket: "lamasync-tmp", checkedAt: 2, message: "access denied" } }),
    );
    expect(sentence).toContain("FAILED");
    expect(sentence).toContain("access denied");
  });
});

describe("the header line is the server's own summary", () => {
  test("it never invents a status", () => {
    expect(seedPilotStatusSentence(null)).toBe("Loading…");
    expect(seedPilotStatusSentence(view())).toContain("authorizes");
  });
});
