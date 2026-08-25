import { describe, expect, it } from "bun:test";
import type { OperationLog } from "@lamasync/core";
import { operationSentence } from "./operation-sentence.ts";

// Fixed "now" so relative-time output is deterministic.
const NOW = new Date("2026-08-24T12:00:00Z").getTime();

function op(overrides: Partial<OperationLog>): OperationLog {
  return {
    id: 1,
    timestamp: NOW - 2 * 3_600_000, // 2h ago
    hostId: "host-cachy",
    folderId: "folder-devconfigs",
    operation: "backup",
    status: "success",
    ...overrides,
  };
}

describe("operationSentence", () => {
  it("builds a full glossary sentence on success", () => {
    const s = operationSentence(
      op({ operation: "backup", status: "success" }),
      {
        folderName: "Dev configs",
        hostName: "cachy",
        backendName: "Exoscale",
        now: new Date(NOW),
      },
    );
    expect(s.text).toBe(
      "Backed up Dev configs from cachy to Exoscale · 2h ago · ok",
    );
    expect(s.verb).toBe("Backed up");
    expect(s.folder).toBe("Dev configs");
    expect(s.from).toBe("cachy");
    expect(s.to).toBe("Exoscale");
    expect(s.statusWord).toBe("ok");
  });

  it("embeds 'failed' in the verb and omits the trailing status word", () => {
    const s = operationSentence(
      op({ operation: "backup", status: "failed" }),
      {
        folderName: "Dev configs",
        hostName: "cachy",
        backendName: "Exoscale",
        now: new Date(NOW),
      },
    );
    expect(s.text).toBe(
      "Backup failed Dev configs from cachy to Exoscale · 2h ago",
    );
    // The structured status word is still available for consumers.
    expect(s.statusWord).toBe("failed");
  });

  it("omits unknown name parts gracefully", () => {
    const s = operationSentence(
      op({ operation: "sync", status: "success" }),
      { folderName: "Docs", now: new Date(NOW) },
    );
    expect(s.text).toBe("Synced Docs · 2h ago · ok");
  });

  it("maps status words for conflict / retry / recovery / started", () => {
    expect(
      operationSentence(op({ status: "conflict" }), { now: new Date(NOW) }).text,
    ).toBe("Backed up · 2h ago · conflict");
    expect(
      operationSentence(op({ status: "retry" }), { now: new Date(NOW) }).text,
    ).toBe("Backed up · 2h ago · retrying");
    expect(
      operationSentence(op({ status: "recovery" }), { now: new Date(NOW) }).text,
    ).toBe("Backed up · 2h ago · recovered");
    expect(
      operationSentence(op({ status: "started" }), { now: new Date(NOW) }).text,
    ).toBe("Backed up · 2h ago · started");
  });

  it("uses correct verbs per operation family", () => {
    expect(operationSentence(op({ operation: "sync" }), { now: new Date(NOW) }).verb).toBe("Synced");
    expect(operationSentence(op({ operation: "bisync" }), { now: new Date(NOW) }).verb).toBe("Synced");
    expect(operationSentence(op({ operation: "restore" }), { now: new Date(NOW) }).verb).toBe("Restored");
    expect(operationSentence(op({ operation: "mount" }), { now: new Date(NOW) }).verb).toBe("Mounted");
    expect(operationSentence(op({ operation: "copy" }), { now: new Date(NOW) }).verb).toBe("Copied");
  });

  it("falls back to a title-cased verb for unknown operations", () => {
    const s = operationSentence(op({ operation: "frobnicate" }), { now: new Date(NOW) });
    expect(s.verb).toBe("Frobnicated");
    expect(s.text).toBe("Frobnicated · 2h ago · ok");
  });

  it("renders relative time across buckets", () => {
    expect(
      operationSentence(op({ timestamp: NOW - 30_000 }), { now: new Date(NOW) }).timeAgo,
    ).toBe("just now");
    expect(
      operationSentence(op({ timestamp: NOW - 5 * 60_000 }), { now: new Date(NOW) }).timeAgo,
    ).toBe("5m ago");
    expect(
      operationSentence(op({ timestamp: NOW - 3 * 3_600_000 }), { now: new Date(NOW) }).timeAgo,
    ).toBe("3h ago");
    expect(
      operationSentence(op({ timestamp: NOW - 2 * 86_400_000 }), { now: new Date(NOW) }).timeAgo,
    ).toBe("2d ago");
  });

  it("returns a dash when timestamp is missing", () => {
    expect(
      operationSentence(op({ timestamp: 0 }), { now: new Date(NOW) }).timeAgo,
    ).toBe("—");
  });
});
