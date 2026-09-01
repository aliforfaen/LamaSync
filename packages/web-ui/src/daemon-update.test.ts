// LAMA-299: tests for the Host-detail Software-section state helpers.
import { describe, expect, test } from "bun:test";
import type { QueuedAction } from "@lamasync/core";
import {
  daemonUpdateUiState,
  latestRemoteUpdateAction,
  parseInstalledVersion,
  remoteUpdateFollowUp,
} from "./daemon-update.ts";

function action(over: Partial<QueuedAction> = {}): QueuedAction {
  return {
    id: "a1",
    hostId: "h1",
    type: "update_daemon",
    payload: null,
    status: "pending",
    createdAt: 1,
    takenAt: null,
    completedAt: null,
    result: null,
    ...over,
  };
}

describe("daemonUpdateUiState", () => {
  test("ready when online, current daemon, newer release", () => {
    const s = daemonUpdateUiState({ status: "online", version: "0.3.6" }, "0.3.7", false);
    expect(s).toMatchObject({ kind: "ready", installed: "0.3.6", latest: "0.3.7" });
  });

  test("offline host → disabled with message", () => {
    const s = daemonUpdateUiState({ status: "offline", version: "0.3.6" }, "0.3.7", false);
    expect(s.kind).toBe("offline");
  });

  test("unversioned host → manual instruction, never a job", () => {
    const s = daemonUpdateUiState({ status: "online", version: null }, "0.3.7", false);
    expect(s.kind).toBe("no-version");
  });

  test("pre-capability daemon → manual bootstrap instruction", () => {
    const s = daemonUpdateUiState({ status: "online", version: "0.3.5" }, "0.3.7", false);
    expect(s.kind).toBe("daemon-too-old");
    if (s.kind === "daemon-too-old") {
      expect(s.message).toContain("lamasyncd --update");
      expect(s.minVersion).toBe("0.3.6");
    }
  });

  test("no update → already at latest", () => {
    const s = daemonUpdateUiState({ status: "online", version: "0.3.7" }, "0.3.7", false);
    expect(s.kind).toBe("no-update");
  });

  test("missing release info → retry hint", () => {
    const s = daemonUpdateUiState({ status: "online", version: "0.3.6" }, null, false);
    expect(s.kind).toBe("no-release-info");
  });

  test("in-flight action takes precedence (no duplicate pending requests)", () => {
    const s = daemonUpdateUiState({ status: "offline", version: "0.3.4" }, "0.3.7", true);
    expect(s.kind).toBe("in-flight");
  });
});

describe("latestRemoteUpdateAction", () => {
  test("returns the newest update_daemon action only", () => {
    const rows = [
      action({ id: "old", createdAt: 1 }),
      action({ id: "sync", type: "trigger_sync", createdAt: 5 }),
      action({ id: "new", createdAt: 9 }),
    ];
    expect(latestRemoteUpdateAction(rows)?.id).toBe("new");
    expect(latestRemoteUpdateAction([])).toBeNull();
  });
});

describe("remoteUpdateFollowUp", () => {
  test("queued / claimed states", () => {
    expect(remoteUpdateFollowUp(action({ status: "pending" }), "0.3.6")?.kind).toBe("queued");
    expect(remoteUpdateFollowUp(action({ status: "taken" }), "0.3.6")?.kind).toBe("claimed");
  });

  test("failed surfaces the device result", () => {
    const f = remoteUpdateFollowUp(action({ status: "failed", result: "replace: download failed" }), "0.3.6");
    expect(f).toMatchObject({ kind: "failed", message: "replace: download failed" });
  });

  test("done + old reported version → awaiting heartbeat", () => {
    const f = remoteUpdateFollowUp(
      action({ status: "done", result: "installed v0.3.7; service restart requested" }),
      "0.3.6",
    );
    expect(f?.kind).toBe("awaiting-heartbeat");
  });

  test("done + matching heartbeat → updated", () => {
    const f = remoteUpdateFollowUp(
      action({ status: "done", result: "installed v0.3.7; service restart requested" }),
      "0.3.7",
    );
    expect(f?.kind).toBe("updated");
  });

  test("done with no install (already current) → updated", () => {
    const f = remoteUpdateFollowUp(action({ status: "done", result: "already at v0.3.6" }), "0.3.6");
    expect(f?.kind).toBe("updated");
  });

  test("null action → null", () => {
    expect(remoteUpdateFollowUp(null, "0.3.6")).toBeNull();
  });
});

describe("parseInstalledVersion", () => {
  test("reads the target version from ack results", () => {
    expect(parseInstalledVersion("installed v1.2.3; service restart requested")).toBe("1.2.3");
    expect(parseInstalledVersion("already at v0.3.6")).toBeNull();
  });
});
