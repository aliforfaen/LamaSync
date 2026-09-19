// LAMA-345 follow-up — fleet health aggregation and the evidence-based update
// verdict.
//
// The update rules exist because "update available" used to be computed from
// `isNewer(hostVersion, latestVersion)` alone: a device that had been switched
// off since before the release existed was still reported as "update
// available", which is a claim the evidence does not support.

import { describe, expect, test } from "bun:test";
import {
  FLEET_HEALTH_BUCKET_COPY,
  FLEET_HEALTH_BUCKET_KEYS,
  deriveFleetHealth,
  deriveUpdateStatus,
  fleetHeadline,
  isAlwaysOnClass,
  isExpectedToSleepClass,
  parseReleaseTimestamp,
  type FleetHealthFolderInput,
  type FleetHealthHostInput,
  type UpdateStatus,
} from "./fleet-health.ts";
import type { FolderHealthReason, FolderHealthState, HostClass, HostStatus } from "./index.ts";

const PUBLISHED_AT = Date.parse("2026-09-10T12:00:00Z");
const RELEASE = "0.3.11";
const OLDER = "0.3.7";

function status(over: Partial<Parameters<typeof deriveUpdateStatus>[0]> = {}): UpdateStatus {
  return deriveUpdateStatus({
    currentVersion: OLDER,
    lastSeen: PUBLISHED_AT + 60_000,
    releaseVersion: RELEASE,
    releasePublishedAt: new Date(PUBLISHED_AT).toISOString(),
    ...over,
  });
}

describe("update evaluation — release boundary", () => {
  test("checked in exactly at publication counts as eligible (inclusive boundary)", () => {
    const at = status({ lastSeen: PUBLISHED_AT, currentVersion: OLDER });
    expect(at.reason).toBe("newer_release");
    expect(at.kind).toBe("available");
    expect(at.actionable).toBe(true);
  });

  test("one millisecond before publication is NOT eligible", () => {
    const before = status({ lastSeen: PUBLISHED_AT - 1, currentVersion: OLDER });
    expect(before.kind).toBe("not_evaluated");
    expect(before.reason).toBe("checked_before_release");
    expect(before.actionable).toBe(false);
    expect(before.label).toContain("not been heard from since before");
  });

  test("one millisecond after publication is eligible", () => {
    expect(status({ lastSeen: PUBLISHED_AT + 1 }).reason).toBe("newer_release");
  });

  test("an epoch-ms release timestamp parses the same as the ISO string", () => {
    expect(
      deriveUpdateStatus({
        currentVersion: OLDER,
        lastSeen: PUBLISHED_AT + 5,
        releaseVersion: RELEASE,
        releasePublishedAt: PUBLISHED_AT,
      }).reason,
    ).toBe("newer_release");
  });
});

describe("update evaluation — the evidence matrix", () => {
  test("offline since before the release is suppressed, not called outdated", () => {
    const s = status({ lastSeen: PUBLISHED_AT - 3 * 24 * 60 * 60_000, currentVersion: OLDER });
    expect(s.kind).toBe("not_evaluated");
    expect(s.actionable).toBe(false);
  });

  test("online after the release and still older IS an actionable update", () => {
    const s = status({ currentVersion: "0.3.7", lastSeen: PUBLISHED_AT + 1_000 });
    expect(s.kind).toBe("available");
    expect(s.label).toContain(RELEASE);
    expect(s.label).toContain("0.3.7");
  });

  test("online after the release on the current version is up to date", () => {
    const s = status({ currentVersion: RELEASE });
    expect(s.kind).toBe("current");
    expect(s.reason).toBe("current");
    expect(s.label).toContain("Up to date");
  });

  test("a device running a NEWER build than the published release is not nagged", () => {
    const s = status({ currentVersion: "0.4.0" });
    expect(s.kind).toBe("current");
    expect(s.actionable).toBe(false);
  });

  test("the current version may carry a leading v", () => {
    expect(status({ currentVersion: `v${RELEASE}` }).kind).toBe("current");
  });

  test("never seen is unknown, not 'outdated'", () => {
    const s = status({ lastSeen: null });
    expect(s.kind).toBe("not_evaluated");
    expect(s.reason).toBe("never_seen");
    expect(s.actionable).toBe(false);
  });

  test("never seen outranks a missing version report", () => {
    const s = status({ lastSeen: null, currentVersion: null });
    expect(s.reason).toBe("never_seen");
  });

  test("no release information evaluates to nothing at all", () => {
    const s = status({ releaseVersion: null, releasePublishedAt: null });
    expect(s.kind).toBe("unknown");
    expect(s.reason).toBe("no_release_info");
    expect(s.actionable).toBe(false);
  });

  test("a release with an unknown publication time refuses to guess", () => {
    const s = status({ releasePublishedAt: null });
    expect(s.kind).toBe("not_evaluated");
    expect(s.reason).toBe("release_time_unknown");
    expect(s.actionable).toBe(false);
  });

  test("an empty or whitespace version is treated as not reported", () => {
    for (const version of [null, undefined, "", "   "]) {
      const s = status({ currentVersion: version });
      expect(s.kind).toBe("unknown");
      expect(s.reason).toBe("no_version_reported");
    }
  });

  test("an unparseable version is not misreported as an available update", () => {
    const s = status({ currentVersion: "not-a-version" });
    expect(s.actionable).toBe(false);
    expect(s.kind).toBe("current");
  });
});

describe("parseReleaseTimestamp", () => {
  test("accepts ISO strings and epoch millis, rejects anything else", () => {
    expect(parseReleaseTimestamp("2026-09-10T12:00:00Z")).toBe(PUBLISHED_AT);
    expect(parseReleaseTimestamp(PUBLISHED_AT)).toBe(PUBLISHED_AT);
    // A stringified epoch must not degrade into "time unknown".
    expect(parseReleaseTimestamp(String(PUBLISHED_AT))).toBe(PUBLISHED_AT);
    expect(parseReleaseTimestamp(null)).toBeNull();
    expect(parseReleaseTimestamp("")).toBeNull();
    expect(parseReleaseTimestamp("whenever")).toBeNull();
    expect(parseReleaseTimestamp(Number.NaN)).toBeNull();
  });
});

describe("host class policy", () => {
  const classes: HostClass[] = ["server", "nas", "desktop", "laptop", "phone", "tablet", "unknown"];

  test("only server and NAS are always-on", () => {
    expect(classes.filter(isAlwaysOnClass)).toEqual(["server", "nas"]);
    expect(classes.filter(isExpectedToSleepClass)).toEqual([
      "desktop",
      "laptop",
      "phone",
      "tablet",
      "unknown",
    ]);
  });

  test("null/undefined classes are never treated as always-on", () => {
    expect(isAlwaysOnClass(null)).toBe(false);
    expect(isAlwaysOnClass(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const NOW = PUBLISHED_AT + 3 * 24 * 60 * 60_000;

function update(over: Partial<Parameters<typeof deriveUpdateStatus>[0]> = {}): UpdateStatus {
  return deriveUpdateStatus({
    currentVersion: RELEASE,
    lastSeen: NOW,
    releaseVersion: RELEASE,
    releasePublishedAt: new Date(PUBLISHED_AT).toISOString(),
    ...over,
  });
}

function host(over: Partial<FleetHealthHostInput> = {}): FleetHealthHostInput {
  return {
    id: "dev-vm",
    hostname: "dev-vm",
    hostClass: "server",
    status: "online",
    lastSeen: NOW,
    updateStatus: update(),
    ...over,
  };
}

function folder(over: Partial<FleetHealthFolderInput> = {}): FleetHealthFolderInput {
  return {
    folderId: "f1",
    folderName: "Projects",
    hostId: "dev-vm",
    hostName: "dev-vm",
    hostClass: "server",
    hostStatus: "online",
    hostLastSeen: NOW,
    state: "healthy" as FolderHealthState,
    reasons: [],
    stale: false,
    ...over,
  };
}

function reason(code: string, action: string | null = null): FolderHealthReason {
  return { code: code as FolderHealthReason["code"], message: `${code} happened`, remediation: "fix it", action: action as FolderHealthReason["action"] };
}

describe("deriveFleetHealth", () => {
  test("an empty fleet reports nothing rather than an empty list of problems", () => {
    const summary = deriveFleetHealth({ hosts: [], folders: [], now: NOW });
    expect(summary.buckets.needsIntervention.total).toBe(0);
    expect(summary.buckets.checkWhenOnline.total).toBe(0);
    expect(summary.buckets.unknownOrStale.total).toBe(0);
    expect(summary.healthy).toEqual({ folders: 0, hosts: 0 });
    expect(summary.headline).toBe("Nothing is set up yet.");
  });

  test("a fully healthy fleet is calm and repeats no counts in the headline", () => {
    const summary = deriveFleetHealth({
      hosts: [host(), host({ id: "nas", hostname: "nas-1", hostClass: "nas" })],
      folders: [folder(), folder({ folderId: "f2", folderName: "Photos" })],
      now: NOW,
    });
    expect(summary.buckets.needsIntervention.total).toBe(0);
    expect(summary.buckets.checkWhenOnline.total).toBe(0);
    expect(summary.healthy).toEqual({ folders: 2, hosts: 2 });
    expect(summary.headline).toBe("Everything LamaSync manages looks healthy.");
    expect(summary.headline).not.toContain("2");
  });

  test("unsafe, resync-required and blocked folder states are the red cases", () => {
    for (const state of ["unsafe", "resync_required", "blocked"] as FolderHealthState[]) {
      const summary = deriveFleetHealth({
        hosts: [host()],
        folders: [folder({ state, reasons: [reason("baseline_error", "resync")] })],
        now: NOW,
      });
      expect(summary.buckets.needsIntervention.total).toBe(1);
      expect(summary.buckets.needsIntervention.items[0]?.tone).toBe("danger");
      expect(summary.buckets.needsIntervention.items[0]?.action).toBe("resync");
    }
  });

  test("an unseeded or interrupted folder is yellow, never red", () => {
    for (const state of ["new_host", "recoverable"] as FolderHealthState[]) {
      const summary = deriveFleetHealth({
        hosts: [host()],
        folders: [folder({ state, reasons: [reason("baseline_missing", "initialize")] })],
        now: NOW,
      });
      expect(summary.buckets.needsIntervention.total).toBe(0);
      expect(summary.buckets.checkWhenOnline.total).toBe(1);
      expect(summary.buckets.checkWhenOnline.items[0]?.tone).toBe("warning");
    }
  });

  test("a missing always-on machine is red", () => {
    for (const hostClass of ["server", "nas"] as HostClass[]) {
      const summary = deriveFleetHealth({
        hosts: [host({ id: "h", hostname: "h", hostClass, status: "offline" })],
        folders: [],
        now: NOW,
      });
      expect(summary.buckets.needsIntervention.total).toBe(1);
      expect(summary.buckets.needsIntervention.items[0]?.detail).toContain("always-on");
    }
  });

  test("a sleeping laptop, phone, tablet, desktop or unknown is never red", () => {
    for (const hostClass of ["laptop", "phone", "tablet", "desktop", "unknown"] as HostClass[]) {
      const summary = deriveFleetHealth({
        hosts: [host({ id: "h", hostname: "h", hostClass, status: "offline", lastSeen: NOW - 60_000 })],
        folders: [],
        now: NOW,
      });
      expect(summary.buckets.needsIntervention.total).toBe(0);
      expect(summary.buckets.checkWhenOnline.total).toBe(1);
      expect(summary.buckets.checkWhenOnline.items[0]?.tone).toBe("info");
      expect(summary.headline).not.toContain("attention now");
    }
  });

  test("degraded always-on is red and degraded sleepy class is not", () => {
    const alwaysOn = deriveFleetHealth({
      hosts: [host({ status: "degraded" })],
      folders: [],
      now: NOW,
    });
    expect(alwaysOn.buckets.needsIntervention.total).toBe(1);
    const sleepy = deriveFleetHealth({
      hosts: [host({ hostClass: "laptop", status: "degraded" })],
      folders: [],
      now: NOW,
    });
    expect(sleepy.buckets.needsIntervention.total).toBe(0);
  });

  test("stale and unknown are distinct from unhealthy", () => {
    const stale = deriveFleetHealth({
      hosts: [host()],
      folders: [folder({ state: "healthy", stale: true })],
      now: NOW,
    });
    expect(stale.buckets.unknownOrStale.total).toBe(1);
    expect(stale.buckets.needsIntervention.total).toBe(0);
    expect(stale.buckets.checkWhenOnline.total).toBe(0);
    // Stale records are not counted healthy either.
    expect(stale.healthy.folders).toBe(0);

    const unknown = deriveFleetHealth({
      hosts: [host()],
      folders: [folder({ state: "unknown" })],
      now: NOW,
    });
    expect(unknown.buckets.unknownOrStale.total).toBe(1);
    expect(unknown.buckets.needsIntervention.total).toBe(0);

    const neverSeenHost = deriveFleetHealth({
      hosts: [host({ id: "new", hostname: "new", status: "unknown", lastSeen: null })],
      folders: [folder({ hostId: "new", hostName: "new", hostStatus: "unknown", hostLastSeen: null })],
      now: NOW,
    });
    // The device row speaks for its own folders — one root cause, one entry.
    expect(neverSeenHost.buckets.unknownOrStale.total).toBe(1);
    expect(neverSeenHost.buckets.unknownOrStale.items[0]?.kind).toBe("host");
    expect(neverSeenHost.buckets.needsIntervention.total).toBe(0);
    expect(neverSeenHost.buckets.checkWhenOnline.total).toBe(0);
  });

  test("a folder on a never-seen device is not listed twice", () => {
    const summary = deriveFleetHealth({
      hosts: [host({ id: "ghost", hostname: "ghost", status: "unknown", lastSeen: null })],
      folders: [
        folder({ hostId: "ghost", hostName: "ghost", hostStatus: "unknown", hostLastSeen: null, state: "unknown" }),
        folder({ folderId: "f2", folderName: "Other", hostId: "ghost", hostName: "ghost", hostStatus: "unknown", hostLastSeen: null, state: "healthy" }),
      ],
      now: NOW,
    });
    expect(summary.buckets.unknownOrStale.total).toBe(1);
    expect(summary.buckets.unknownOrStale.items.map((i) => i.kind)).toEqual(["host"]);
    expect(summary.healthy.folders).toBe(0);
  });

  test("a folder on an offline device waits for the device instead of going red", () => {
    const summary = deriveFleetHealth({
      hosts: [host({ hostClass: "laptop", status: "offline", lastSeen: NOW - 60_000 })],
      folders: [
        folder({
          hostClass: "laptop",
          hostStatus: "offline",
          hostLastSeen: NOW - 60_000,
          state: "resync_required",
          reasons: [reason("filter_changed", "resync")],
        }),
      ],
      now: NOW,
    });
    expect(summary.buckets.needsIntervention.total).toBe(0);
    // The folder (work to do) and the sleeping device, both yellow.
    expect(summary.buckets.checkWhenOnline.total).toBe(2);
    expect(summary.buckets.checkWhenOnline.items[0]?.kind).toBe("folder");
    expect(summary.buckets.checkWhenOnline.items[0]?.detail).toContain("not online right now");
  });

  test("a red host suppresses its own folders so one cause is counted once", () => {
    const summary = deriveFleetHealth({
      hosts: [host({ status: "offline" })],
      folders: [
        folder({ state: "resync_required", reasons: [reason("filter_changed", "resync")] }),
        folder({ folderId: "f2", folderName: "Photos", state: "healthy" }),
      ],
      now: NOW,
    });
    expect(summary.buckets.needsIntervention.total).toBe(1);
    expect(summary.buckets.needsIntervention.items[0]?.kind).toBe("host");
    expect(summary.buckets.checkWhenOnline.total).toBe(0);
    expect(summary.buckets.unknownOrStale.total).toBe(0);
    expect(summary.healthy.folders).toBe(0);
  });

  test("actionable updates land in the yellow bucket with the update's own wording", () => {
    const summary = deriveFleetHealth({
      hosts: [
        host({
          id: "dev-vm",
          hostname: "dev-vm",
          updateStatus: update({ lastSeen: PUBLISHED_AT + 1_000, currentVersion: OLDER }),
        }),
      ],
      folders: [],
      now: NOW,
    });
    expect(summary.updatesActionable).toBe(1);
    expect(summary.buckets.checkWhenOnline.total).toBe(1);
    const item = summary.buckets.checkWhenOnline.items[0]!;
    expect(item.kind).toBe("update");
    expect(item.detail).toContain(RELEASE);
    expect(item.tone).toBe("warning");
  });

  test("one device never occupies two rows in the same bucket", () => {
    const summary = deriveFleetHealth({
      hosts: [
        host({
          id: "lap",
          hostname: "lap",
          hostClass: "laptop",
          status: "offline",
          lastSeen: NOW - 60_000,
          updateStatus: update({ lastSeen: PUBLISHED_AT + 1_000, currentVersion: OLDER }),
        }),
      ],
      folders: [],
      now: NOW,
    });
    // The sleeping-device entry absorbs the update sentence.
    expect(summary.buckets.checkWhenOnline.total).toBe(1);
    expect(summary.buckets.checkWhenOnline.items[0]?.kind).toBe("host");
    expect(summary.buckets.checkWhenOnline.items[0]?.detail).toContain("sleeps by design");
    expect(summary.buckets.checkWhenOnline.items[0]?.detail).toContain("0.3.11");
    // …while the metric still counts the actionable update.
    expect(summary.updatesActionable).toBe(1);
  });

  test("an update for a missing machine is not listed at all", () => {
    const summary = deriveFleetHealth({
      hosts: [
        host({
          id: "nas",
          hostname: "nas",
          hostClass: "nas",
          status: "offline",
          lastSeen: NOW - 60_000,
          updateStatus: update({ lastSeen: PUBLISHED_AT + 1_000, currentVersion: OLDER }),
        }),
      ],
      folders: [],
      now: NOW,
    });
    expect(summary.buckets.needsIntervention.total).toBe(1);
    expect(summary.buckets.needsIntervention.items.map((i) => i.kind)).toEqual(["host"]);
    expect(summary.buckets.checkWhenOnline.total).toBe(0);
    // The metric is still honest about it being behind.
    expect(summary.updatesActionable).toBe(1);
  });

  test("an online host behind the release gets its own update row", () => {
    const summary = deriveFleetHealth({
      hosts: [
        host({
          id: "srv",
          hostname: "srv",
          updateStatus: update({ lastSeen: PUBLISHED_AT + 1_000, currentVersion: OLDER }),
        }),
      ],
      folders: [],
      now: NOW,
    });
    expect(summary.buckets.checkWhenOnline.total).toBe(1);
    expect(summary.buckets.checkWhenOnline.items[0]?.kind).toBe("update");
    expect(summary.healthy.hosts).toBe(1);
  });

  test("an update that cannot be evaluated is counted separately and never nagged", () => {
    const summary = deriveFleetHealth({
      hosts: [
        host({
          updateStatus: update({ lastSeen: PUBLISHED_AT - 60_000, currentVersion: OLDER }),
        }),
      ],
      folders: [],
      now: NOW,
    });
    expect(summary.updatesActionable).toBe(0);
    expect(summary.updatesNotEvaluated).toBe(1);
    expect(summary.buckets.checkWhenOnline.total).toBe(0);
    expect(summary.headline).not.toContain("attention now");
  });

  test("a mixed fleet buckets every state exactly once", () => {
    const summary = deriveFleetHealth({
      hosts: [
        host({ id: "srv", hostname: "srv", hostClass: "server", status: "online" }),
        host({ id: "nas", hostname: "nas", hostClass: "nas", status: "offline", lastSeen: NOW - 3_600_000 }),
        host({ id: "lap", hostname: "lap", hostClass: "laptop", status: "offline", lastSeen: NOW - 7_200_000 }),
        host({ id: "phone", hostname: "phone", hostClass: "phone", status: "online" }),
        host({ id: "ghost", hostname: "ghost", hostClass: "desktop", status: "unknown", lastSeen: null }),
      ],
      folders: [
        folder({ folderId: "ok", folderName: "Ok", hostId: "srv", hostName: "srv", state: "healthy" }),
        folder({ folderId: "busy", folderName: "Busy", hostId: "srv", hostName: "srv", state: "busy" }),
        folder({
          folderId: "risk",
          folderName: "Risk",
          hostId: "srv",
          hostName: "srv",
          state: "unsafe",
          reasons: [reason("baseline_error", "resync")],
        }),
        folder({ folderId: "new", folderName: "New", hostId: "phone", hostName: "phone", hostClass: "phone", hostStatus: "online", state: "new_host", reasons: [reason("baseline_missing", "initialize")] }),
        folder({ folderId: "gold", folderName: "Gold", hostId: "ghost", hostName: "ghost", hostClass: "desktop", hostStatus: "unknown", hostLastSeen: null, state: "unknown" }),
      ],
      now: NOW,
    });

    expect(summary.buckets.needsIntervention.total).toBe(2); // nas + unsafe folder
    // The sleeping laptop and the phone's unseeded folder.
    expect(summary.buckets.checkWhenOnline.total).toBe(2);
    expect(summary.healthy.folders).toBe(2); // ok + busy
    expect(summary.healthy.hosts).toBe(2); // srv + phone
    // ghost host only: its folder row is suppressed (one root cause).
    expect(summary.buckets.unknownOrStale.total).toBe(1);
    expect(summary.headline).toBe("2 things need your attention now.");

    // Every reported item carries a link and a plain-language detail.
    for (const key of FLEET_HEALTH_BUCKET_KEYS) {
      for (const item of summary.buckets[key].items) {
        expect(item.href.startsWith("/")).toBe(true);
        expect(item.detail.length).toBeGreaterThan(10);
        expect(item.title.length).toBeGreaterThan(0);
      }
    }
  });

  test("item lists are bounded while the totals stay exact", () => {
    const folders = Array.from({ length: 9 }, (_, i) =>
      folder({
        folderId: `f${i}`,
        folderName: `Folder ${i}`,
        state: "unsafe",
        reasons: [reason("baseline_error", "resync")],
      }),
    );
    const summary = deriveFleetHealth({ hosts: [host()], folders, now: NOW, itemLimit: 3 });
    expect(summary.buckets.needsIntervention.total).toBe(9);
    expect(summary.buckets.needsIntervention.items.length).toBe(3);
    expect(summary.buckets.needsIntervention.truncated).toBe(6);
  });

  test("truncation keeps the worst items, not the alphabetical ones", () => {
    const summary = deriveFleetHealth({
      hosts: [host()],
      folders: [
        folder({ folderId: "a", folderName: "A", state: "blocked" }),
        folder({ folderId: "b", folderName: "B", state: "resync_required" }),
        folder({ folderId: "c", folderName: "C", state: "unsafe" }),
      ],
      now: NOW,
      itemLimit: 1,
    });
    expect(summary.buckets.needsIntervention.items[0]?.title).toContain("C");
  });
});

describe("fleetHeadline", () => {
  const bucket = (total: number) => ({ total });

  test("red outranks everything and never scolds about a sleeping phone", () => {
    expect(
      fleetHeadline(
        {
          needsIntervention: bucket(1),
          checkWhenOnline: bucket(0),
          healthy: bucket(0),
          unknownOrStale: bucket(0),
        },
        4,
        4,
      ),
    ).toBe("One thing needs your attention now.");
    expect(
      fleetHeadline(
        {
          needsIntervention: bucket(0),
          checkWhenOnline: bucket(1),
          healthy: bucket(0),
          unknownOrStale: bucket(0),
        },
        4,
        4,
      ),
    ).toContain("Nothing urgent");
  });

  test("unknown/stale is described as unverified, not as a problem", () => {
    const line = fleetHeadline(
      {
        needsIntervention: bucket(0),
        checkWhenOnline: bucket(0),
        healthy: bucket(0),
        unknownOrStale: bucket(2),
      },
      1,
      1,
    );
    expect(line).toContain("not reported in yet");
    expect(line).toContain("Nothing looks wrong");
  });
});

describe("bucket copy", () => {
  test("every bucket has plain-language copy and no rclone jargon", () => {
    for (const key of FLEET_HEALTH_BUCKET_KEYS) {
      const copy = FLEET_HEALTH_BUCKET_COPY[key];
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.plain.length).toBeGreaterThan(20);
      expect(copy.plain).not.toContain("--");
      expect(copy.plain).not.toContain("Path 1");
      expect(copy.plain).not.toContain("bisync");
    }
  });

  test("the red bucket is documented as the only urgent one", () => {
    expect(FLEET_HEALTH_BUCKET_COPY.needsIntervention.plain).toContain("only things");
  });

  test("the yellow bucket says a sleeping device is normal", () => {
    expect(FLEET_HEALTH_BUCKET_COPY.checkWhenOnline.plain).toContain("normal");
    expect(FLEET_HEALTH_BUCKET_COPY.checkWhenOnline.plain).toContain("never urgent");
  });
});

describe("status typing sanity", () => {
  test("HostStatus values used by the aggregation are the wire values", () => {
    const statuses: HostStatus[] = ["online", "offline", "degraded", "unknown"];
    expect(statuses.length).toBe(4);
  });
});
