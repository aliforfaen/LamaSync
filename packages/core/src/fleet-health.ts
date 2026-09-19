// LAMA-345 follow-up — fleet health aggregation and update evaluation.
//
// Dependency-free and pure on purpose: the Dashboard, the `/health` route, the
// Hosts/HostDetail pages and the offline/update notification sweeps must all
// agree, so the rules live in exactly one place and are unit-testable without
// a database, a clock or a network.
//
// Two independent concerns:
//
//   1. `deriveUpdateStatus` — is an "update available" claim supported by
//      EVIDENCE? A device that has been offline since before a release existed
//      cannot have declined to install it. Saying "update available" there is
//      a lie the operator learns to ignore, so it is suppressed in favour of a
//      neutral "not evaluated".
//
//   2. `deriveFleetHealth` — bucket managed-folder health and device state into
//      four actionable groups, where RED means data risk or a genuinely missing
//      always-on machine and never merely "a phone is asleep".

import type { HostClass, HostStatus } from "./types.ts";
import type { FolderHealthReason, FolderHealthState } from "./folder-health.ts";
import { isNewer } from "./version-compare.ts";

// ---------------------------------------------------------------------------
// Host-class policy (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Always-on classes. Only these going away is a real fleet risk: a laptop,
 * phone, tablet or desktop is EXPECTED to sleep, so its offline state is at
 * most an informational note.
 *
 * Shared with the notification sweeps so the dashboard, the notifications and
 * the host lists cannot drift apart.
 */
export function isAlwaysOnClass(hostClass: HostClass | null | undefined): boolean {
  return hostClass === "server" || hostClass === "nas";
}

/** True when an offline/degraded state is merely expected for this class. */
export function isExpectedToSleepClass(hostClass: HostClass | null | undefined): boolean {
  return !isAlwaysOnClass(hostClass);
}

// ---------------------------------------------------------------------------
// Update evaluation
// ---------------------------------------------------------------------------

/**
 * What the fleet actually knows about a device's version.
 *
 *   current        checked in at/after the release and is on (or ahead of) it
 *   available      checked in at/after the release and reports an older version
 *   not_evaluated  could not be judged: no release info, or the device has not
 *                  been heard from since before the release was published
 *   unknown        the device has never reported a version at all
 */
export type UpdateStatusKind = "current" | "available" | "not_evaluated" | "unknown";

export type UpdateStatusReason =
  | "current"
  | "newer_release"
  | "no_release_info"
  | "release_time_unknown"
  | "never_seen"
  | "no_version_reported"
  | "checked_before_release";

export interface UpdateStatus {
  kind: UpdateStatusKind;
  reason: UpdateStatusReason;
  /** Plain-language sentence; safe to show verbatim. */
  label: string;
  currentVersion: string | null;
  releaseVersion: string | null;
  releasePublishedAt: number | null;
  /** True only for `kind: "available"` — the one case worth nagging about. */
  actionable: boolean;
}

/**
 * Parse the release timestamp into epoch ms, or null when it is missing or
 * unreadable. Accepts an ISO-8601 string (what GitHub returns), an epoch-ms
 * number, and an epoch-ms string — the last purely so a caller that stringifies
 * a numeric timestamp cannot silently degrade an update verdict into
 * "unknown time".
 */
export function parseReleaseTimestamp(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^\d{10,}$/.test(trimmed)) {
    const numeric = Number.parseInt(trimmed, 10);
    return Number.isFinite(numeric) ? numeric : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Evaluate whether this device's version is worth flagging, under the rule
 * that an update warning requires evidence: the device must have checked in
 * **at or after** the release became available.
 *
 * `lastSeen === publishedAt` counts as eligible — the boundary is inclusive,
 * because a device that checked in in the same instant the release appeared
 * could already have been offered it.
 */
export function deriveUpdateStatus(input: {
  currentVersion: string | null | undefined;
  lastSeen: number | null | undefined;
  releaseVersion: string | null | undefined;
  releasePublishedAt: string | number | null | undefined;
}): UpdateStatus {
  const currentVersion =
    typeof input.currentVersion === "string" && input.currentVersion.trim().length > 0
      ? input.currentVersion.trim()
      : null;
  const releaseVersion =
    typeof input.releaseVersion === "string" && input.releaseVersion.trim().length > 0
      ? input.releaseVersion.trim()
      : null;
  const releasePublishedAt = parseReleaseTimestamp(input.releasePublishedAt);
  const lastSeen =
    typeof input.lastSeen === "number" && Number.isFinite(input.lastSeen)
      ? input.lastSeen
      : null;

  const base = { currentVersion, releaseVersion, releasePublishedAt };

  if (releaseVersion === null) {
    return {
      ...base,
      kind: "unknown",
      reason: "no_release_info",
      // Without a release to compare against there is nothing to evaluate.
      label: "Update not evaluated — no release information is available.",
      actionable: false,
    };
  }
  if (lastSeen === null) {
    return {
      ...base,
      kind: "not_evaluated",
      reason: "never_seen",
      label: "Update not evaluated — this device has not reported in yet.",
      actionable: false,
    };
  }
  if (releasePublishedAt !== null && lastSeen < releasePublishedAt) {
    return {
      ...base,
      kind: "not_evaluated",
      reason: "checked_before_release",
      label: `Update not evaluated — this device has not been heard from since before ${releaseVersion} was released.`,
      actionable: false,
    };
  }
  if (releasePublishedAt === null) {
    // A release exists but its publication time is unknown, so the evidence
    // rule cannot be satisfied. Refuse to nag rather than guess.
    return {
      ...base,
      kind: "not_evaluated",
      reason: "release_time_unknown",
      label: `Update not evaluated — the release time for ${releaseVersion} is unknown.`,
      actionable: false,
    };
  }
  if (currentVersion === null) {
    return {
      ...base,
      kind: "unknown",
      reason: "no_version_reported",
      label: "Update not evaluated — this device has not reported a version.",
      actionable: false,
    };
  }
  if (isNewer(currentVersion, releaseVersion)) {
    return {
      ...base,
      kind: "available",
      reason: "newer_release",
      label: `Update to ${releaseVersion} available (running ${currentVersion}).`,
      actionable: true,
    };
  }
  return {
    ...base,
    kind: "current",
    reason: "current",
    label: `Up to date (running ${currentVersion}).`,
    actionable: false,
  };
}

// ---------------------------------------------------------------------------
// Fleet summary
// ---------------------------------------------------------------------------

export type FleetHealthBucketKey =
  | "needsIntervention"
  | "checkWhenOnline"
  | "healthy"
  | "unknownOrStale";

export const FLEET_HEALTH_BUCKET_KEYS: readonly FleetHealthBucketKey[] = [
  "needsIntervention",
  "checkWhenOnline",
  "healthy",
  "unknownOrStale",
];

export type FleetHealthTone = "danger" | "warning" | "info";

export type FleetHealthItemKind = "folder" | "host" | "update";

export interface FleetHealthItem {
  kind: FleetHealthItemKind;
  /** Folder id for `folder`/`update` items, host id otherwise. */
  id: string;
  hostId: string | null;
  hostName: string | null;
  /** Short headline, e.g. "Projects on dev-vm". */
  title: string;
  /** Plain-language consequence / what to do. */
  detail: string;
  tone: FleetHealthTone;
  /** Router target the UI links to. */
  href: string;
  /** Health-card action the item points at, when one applies. */
  action: string | null;
}

export interface FleetHealthBucket {
  /** How many things fall in this bucket (items may be truncated). */
  total: number;
  items: FleetHealthItem[];
  /** `total - items.length` when the item list was capped. */
  truncated: number;
}

export interface FleetHealthHostInput {
  id: string;
  hostname: string;
  hostClass: HostClass;
  status: HostStatus;
  lastSeen: number | null;
  updateStatus: UpdateStatus;
}

export interface FleetHealthFolderInput {
  folderId: string;
  folderName: string;
  hostId: string;
  hostName: string;
  hostClass: HostClass;
  hostStatus: HostStatus;
  hostLastSeen: number | null;
  state: FolderHealthState;
  reasons: readonly FolderHealthReason[];
  stale: boolean;
}

export interface FleetHealthSummary {
  generatedAt: number;
  /** Plain-language one-liner for the dashboard hero/detail. */
  headline: string;
  buckets: Record<FleetHealthBucketKey, FleetHealthBucket>;
  /** Green counts render as one calm line rather than a list. */
  healthy: { folders: number; hosts: number };
  /** How many devices have a genuinely actionable update. */
  updatesActionable: number;
  /** Devices whose update status could not be judged (offline-before-release…). */
  updatesNotEvaluated: number;
}

export const FLEET_HEALTH_ITEM_LIMIT = 6;

const STATES_NEEDING_INTERVENTION: ReadonlySet<FolderHealthState> = new Set<FolderHealthState>([
  "unsafe",
  "resync_required",
  "blocked",
]);

/** Worst-first ordering inside a bucket, so a truncated list keeps the worst. */
const STATE_SEVERITY: Readonly<Record<FolderHealthState, number>> = {
  unsafe: 6,
  resync_required: 5,
  blocked: 4,
  recoverable: 3,
  new_host: 2,
  unknown: 1,
  busy: 0,
  healthy: 0,
};

function hostIsDown(status: HostStatus): boolean {
  return status === "offline" || status === "degraded";
}

/**
 * A bucket entry plus its ordering weight. The weight is internal: it carries
 * the real severity (an `unsafe` folder outranks a `blocked` one) so a
 * truncated list keeps the worst items rather than the first alphabetical
 * ones.
 */
interface WeightedItem {
  item: FleetHealthItem;
  weight: number;
}

function folderItem(
  input: FleetHealthFolderInput,
  tone: FleetHealthTone,
  detail: string,
): WeightedItem {
  const first = input.reasons[0] ?? null;
  return {
    weight: STATE_SEVERITY[input.state],
    item: {
      kind: "folder",
      id: input.folderId,
      hostId: input.hostId,
      hostName: input.hostName,
      title: `${input.folderName} on ${input.hostName}`,
      detail,
      tone,
      href: `/folders?folder=${encodeURIComponent(input.folderId)}&host=${encodeURIComponent(input.hostId)}`,
      action: first?.action ?? null,
    },
  };
}

function hostEntry(
  host: FleetHealthHostInput,
  detail: string,
  tone: FleetHealthTone,
  weight: number,
  kind: FleetHealthItemKind = "host",
): WeightedItem {
  return {
    weight,
    item: {
      kind,
      id: host.id,
      hostId: host.id,
      hostName: host.hostname,
      title: host.hostname,
      detail,
      tone,
      href: `/hosts/${encodeURIComponent(host.id)}`,
      action: null,
    },
  };
}

function relativeAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/**
 * Aggregate device state and managed-folder health into four buckets.
 *
 * Precedence per folder assignment (first match wins):
 *   1. no report yet, or a report older than the staleness budget → unknown/stale
 *   2. the device is not currently online → check when online
 *   3. unsafe / resync-required / blocked → needs intervention
 *   4. never initialised or interrupted → check when online
 *   5. otherwise healthy
 *
 * Per host:
 *   - never seen → unknown/stale
 *   - always-on and down → needs intervention (this is the one "red" host case)
 *   - sleeps by design and down → check when online (informational)
 *   - online → healthy
 *
 * A host already in `needsIntervention` suppresses its own folder items: one
 * root cause must not be counted twice.
 */
export function deriveFleetHealth(input: {
  hosts: readonly FleetHealthHostInput[];
  folders: readonly FleetHealthFolderInput[];
  now: number;
  itemLimit?: number;
}): FleetHealthSummary {
  const limit = Math.max(1, input.itemLimit ?? FLEET_HEALTH_ITEM_LIMIT);
  const now = input.now;

  const needsIntervention: WeightedItem[] = [];
  const checkWhenOnline: WeightedItem[] = [];
  const unknownOrStale: WeightedItem[] = [];
  const updatesAvailable: WeightedItem[] = [];

  let healthyFolders = 0;
  let healthyHosts = 0;
  let updatesNotEvaluated = 0;
  let updatesActionable = 0;
  /** Hosts already flagged red, so their folders are not double-reported. */
  const suppressedHostIds = new Set<string>();
  /**
   * Hosts that have never reported in. Their folders' "not heard from" rows
   * would repeat the same root cause, so the device row speaks for them.
   */
  const unheardHostIds = new Set<string>();
  /**
   * Host id → the yellow entry that already speaks for it. One device must
   * never occupy two rows in the same bucket, so an available update is merged
   * into the existing entry instead of being listed again.
   */
  const yellowByHost = new Map<string, WeightedItem>();

  for (const host of input.hosts) {
    const down = hostIsDown(host.status);
    if (host.lastSeen === null && host.status !== "online") {
      unheardHostIds.add(host.id);
      unknownOrStale.push(
        hostEntry(host, "Registered but has never reported in.", "info", 2),
      );
    } else if (isAlwaysOnClass(host.hostClass) && down) {
      suppressedHostIds.add(host.id);
      const age =
        host.lastSeen === null ? null : relativeAge(Math.max(0, now - host.lastSeen));
      needsIntervention.push(
        hostEntry(
          host,
          age === null
            ? "An always-on machine with no recent contact."
            : `An always-on machine, last heard from ${age} ago.`,
          "danger",
          5,
        ),
      );
    } else if (isExpectedToSleepClass(host.hostClass) && down) {
      // Explicitly informational: a phone or laptop being asleep is normal.
      const entry = hostEntry(
        host,
        "This device sleeps by design; nothing to do while it is away.",
        "info",
        2,
      );
      checkWhenOnline.push(entry);
      yellowByHost.set(host.id, entry);
    } else if (host.status === "online") {
      healthyHosts += 1;
    } else {
      unknownOrStale.push(hostEntry(host, "This device's status is not known yet.", "info", 1));
    }

    if (host.updateStatus.actionable) {
      updatesActionable += 1;
      // An update for a machine that is simply MISSING is moot (and would be a
      // second row for one root cause); for a device that already has a yellow
      // entry, merge the sentence into that entry.
      if (!suppressedHostIds.has(host.id)) {
        const existing = yellowByHost.get(host.id);
        if (existing) {
          existing.weight = Math.max(existing.weight, 3);
          if (!existing.item.detail.includes("update")) {
            existing.item.detail = `${existing.item.detail} ${host.updateStatus.label}`;
          }
        } else {
          // Its own kind so the UI can group "updates ready to install" apart
          // from devices that are simply asleep.
          const entry = hostEntry(host, host.updateStatus.label, "warning", 1, "update");
          updatesAvailable.push(entry);
          yellowByHost.set(host.id, entry);
        }
      }
    } else if (
      host.updateStatus.kind === "not_evaluated" ||
      host.updateStatus.reason === "no_version_reported"
    ) {
      updatesNotEvaluated += 1;
    }
  }

  for (const folder of input.folders) {
    // One root cause, one entry: a red or never-seen device already explains
    // its own folders.
    if (suppressedHostIds.has(folder.hostId)) continue;
    if (unheardHostIds.has(folder.hostId)) continue;
    const down = hostIsDown(folder.hostStatus);
    const neverReported = folder.state === "unknown";
    // An old report, or a device that has never reported at all, means the
    // state we hold cannot be trusted as "now" — distinct from "broken".
    const stale = folder.stale || folder.hostLastSeen === null;
    const first = folder.reasons[0] ?? null;
    if (neverReported) {
      unknownOrStale.push(
        folderItem(folder, "info", "This device has not reported folder health yet."),
      );
      continue;
    }
    if (stale) {
      unknownOrStale.push(
        folderItem(
          folder,
          "info",
          "The last health report is old — the state below may have changed.",
        ),
      );
      continue;
    }
    if (down) {
      checkWhenOnline.push(
        folderItem(
          folder,
          "warning",
          first ? `${first.message} This device is not online right now.` : "This device is not online right now.",
        ),
      );
      continue;
    }
    if (STATES_NEEDING_INTERVENTION.has(folder.state)) {
      needsIntervention.push(
        folderItem(folder, "danger", first ? first.message : "This folder needs attention."),
      );
      continue;
    }
    if (folder.state === "new_host" || folder.state === "recoverable") {
      checkWhenOnline.push(
        folderItem(
          folder,
          "warning",
          first ? first.message : "This folder has work to finish.",
        ),
      );
      continue;
    }
    healthyFolders += 1;
  }

  const bySeverity = (a: WeightedItem, b: WeightedItem): number => {
    if (a.weight !== b.weight) return b.weight - a.weight;
    return a.item.title.localeCompare(b.item.title);
  };
  needsIntervention.sort(bySeverity);
  // One ordering for the yellow bucket: real work first, then devices that are
  // simply asleep, then the mildest follow-up (an available update).
  const checkWhenOnlineSorted = [...checkWhenOnline, ...updatesAvailable].sort(bySeverity);
  unknownOrStale.sort(bySeverity);

  const bucket = (items: WeightedItem[]): FleetHealthBucket => ({
    total: items.length,
    items: items.slice(0, limit).map((entry) => entry.item),
    truncated: Math.max(0, items.length - limit),
  });

  const buckets: Record<FleetHealthBucketKey, FleetHealthBucket> = {
    needsIntervention: bucket(needsIntervention),
    checkWhenOnline: bucket(checkWhenOnlineSorted),
    healthy: { total: healthyFolders + healthyHosts, items: [], truncated: 0 },
    unknownOrStale: bucket(unknownOrStale),
  };

  return {
    generatedAt: now,
    headline: fleetHeadline(buckets, healthyFolders, healthyHosts),
    buckets,
    healthy: { folders: healthyFolders, hosts: healthyHosts },
    updatesActionable,
    updatesNotEvaluated,
  };
}

/**
 * One calm sentence. Deliberately does not repeat the device/folder totals the
 * dashboard already shows elsewhere — it states the VERDICT only.
 */
export function fleetHeadline(
  buckets: Record<FleetHealthBucketKey, Pick<FleetHealthBucket, "total">>,
  folders = 0,
  hosts = 0,
): string {
  const red = buckets.needsIntervention.total;
  const yellow = buckets.checkWhenOnline.total;
  const unknown = buckets.unknownOrStale.total;
  const healthyTotal = folders + hosts;
  if (red > 0) {
    return red === 1
      ? "One thing needs your attention now."
      : `${red} things need your attention now.`;
  }
  if (yellow > 0) {
    return "Nothing urgent — a few things to look at when convenient.";
  }
  if (unknown > 0) {
    return "Nothing looks wrong; some devices have not reported in yet.";
  }
  if (healthyTotal === 0) {
    return "Nothing is set up yet.";
  }
  return "Everything LamaSync manages looks healthy.";
}

/** Plain-language bucket descriptions, shared by the UI and the docs. */
export const FLEET_HEALTH_BUCKET_COPY: Readonly<
  Record<FleetHealthBucketKey, { title: string; plain: string }>
> = {
  needsIntervention: {
    title: "Needs attention now",
    plain:
      "Something is unsafe or an always-on machine is missing. These are the only things LamaSync marks as urgent.",
  },
  checkWhenOnline: {
    title: "Check when next online",
    plain:
      "Work to finish, devices that are asleep, or updates ready to install. A laptop, phone or tablet being away is normal and never urgent.",
  },
  healthy: {
    title: "Healthy",
    plain: "These folders have a usable sync record and their last sync agreed.",
  },
  unknownOrStale: {
    title: "Not heard from",
    plain:
      "No recent report, so LamaSync does not know. This is not the same as broken — it just has not been checked.",
  },
};
