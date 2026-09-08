// LAMA-325: pure, deterministic snapshot-retention policy + evaluator.
//
// Design contract (LAMA-313 / LAMA-325):
//   - calendar buckets are anchored in an explicit timezone (default UTC)
//   - the representative per bucket is the NEWEST SUCCESSFUL snapshot
//     (deterministic tie-break by id)
//   - at least one successful snapshot is ALWAYS kept
//   - pins/holds and unfinished/unexpired rollback artifacts override every
//     rule (protected by guards)
//   - "Smart retention" is a preset that EXPANDS into visible normalized
//     rules (never an opaque label); consumers store the expanded rules
//   - policies are disabled/null by default — a disabled policy never
//     deletes (conservative migration)
//   - unknown sizes are surfaced as unavailable accounting, never guessed
//
// This module is pure: no fs, no DB, no clocks beyond an explicit `now`
// input, so every acceptance case is a plain unit test.

export type RetentionRule =
  | { kind: "keepLast"; count: number }
  | { kind: "keepAge"; maxAgeMs: number }
  | {
      kind: "calendar";
      unit: "daily" | "weekly" | "monthly" | "yearly";
      /** Keep the newest successful snapshot in each of the last `count`
       *  buckets (e.g. count 7 daily = keep 1 per UTC day for 7 days). */
      count: number;
    };

export interface RetentionPolicy {
  /** Explicit on/off. Disabled/null policies retain everything. */
  enabled: boolean;
  /** Expanded normalized rules (Smart presets are expanded before store). */
  rules: RetentionRule[];
  /** Always true in practice; kept explicit for conservative callers. */
  keepAtLeastOne?: boolean;
}

/** One snapshot fed to the evaluator. */
export interface RetentionSnapshotDescriptor {
  /** Stable identity (app snapshot id / restic snapshot id). */
  id: string;
  /** Epoch ms capture time. */
  timestamp: number;
  sizeBytes?: number | null;
  /** Holds/pins: retention must never delete these. */
  pinned?: boolean;
  /** Rollback artifact (unfinished or unexpired rollback window): never
   *  pruned before its operation finalizes and the window expires. */
  rollback?: boolean;
  /** Capture succeeded (restic exit 0 / verified integrity). */
  successful: boolean;
  /** Host/scope identifier (used by fold adapters only). */
  hostId?: string | null;
}

export type RetentionAction = "keep" | "delete";

export interface RetentionDecision {
  id: string;
  action: RetentionAction;
  /**
   * Single human-readable reason. Precedence: guard (pinned/rollback) →
   * safety keep (future/bad timestamp) → keep-at-least-one → rule match
   * (bucket/keepLast/keepAge) → not covered by any rule.
   */
  reason: string;
  /** "guard" = safety override, "policy" = a normal rule decision. */
  kind: "guard" | "policy";
}

export interface RetentionEvaluation {
  /** Epoch ms used for bucketing (caller's `now`; UTC anchoring). */
  now: number;
  timezone: string;
  decisions: RetentionDecision[];
  keptCount: number;
  deleteCount: number;
  /** Bytes that WOULD be reclaimed; only snapshots with known size count. */
  reclaimableBytes: number;
  /** Deleting snapshots whose size is unknown (reclaim accounting gap). */
  unknownSizeCount: number;
  /** Snapshots held by guards (pinned/rollback) — surfaced as exceptions. */
  guardCount: number;
  /** Snapshots retained by the keep-at-least-one guarantee. */
  keptByGuarantee: number;
}

export interface RetentionEvaluationInput {
  snapshots: RetentionSnapshotDescriptor[];
  policy: RetentionPolicy;
  /** Explicit now for deterministic bucketing; defaults to Date.now(). */
  now?: number;
  /** Calendar anchoring timezone (IANA name; default UTC). */
  timezone?: string;
}

export interface SmartRetentionPresetInput {
  daily?: number;
  weekly?: number;
  monthly?: number;
  yearly?: number;
}

/** The common Duplicati-style smart scheme as visible, normalized rules. */
export const SMART_RETENTION_DEFAULTS: Required<SmartRetentionPresetInput> = {
  daily: 7,
  weekly: 4,
  monthly: 12,
  yearly: 2,
};

export function smartRetentionRules(
  input: SmartRetentionPresetInput = {},
): RetentionRule[] {
  const { daily, weekly, monthly, yearly } = { ...SMART_RETENTION_DEFAULTS, ...input };
  const rules: RetentionRule[] = [];
  if (daily > 0) rules.push({ kind: "calendar", unit: "daily", count: daily });
  if (weekly > 0) rules.push({ kind: "calendar", unit: "weekly", count: weekly });
  if (monthly > 0) rules.push({ kind: "calendar", unit: "monthly", count: monthly });
  if (yearly > 0) rules.push({ kind: "calendar", unit: "yearly", count: yearly });
  return rules;
}

export function smartRetentionPolicy(
  input: SmartRetentionPresetInput = {},
): RetentionPolicy {
  return { enabled: true, rules: smartRetentionRules(input), keepAtLeastOne: true };
}

/** Plain-language summary of a policy (UX: explain the trade-off). */
export function describePolicy(policy: RetentionPolicy): string {
  if (!policy.enabled || policy.rules.length === 0) {
    return "Retention disabled — every snapshot is kept forever.";
  }
  const parts = policy.rules.map((rule) => {
    switch (rule.kind) {
      case "keepLast":
        return `the latest ${rule.count} snapshot${rule.count === 1 ? "" : "s"}`;
      case "keepAge":
        return `snapshots younger than ${humanDuration(rule.maxAgeMs)}`;
      case "calendar":
        return `1 per ${rule.unit.slice(0, -2)} for ${rule.count} ${rule.unit}${
          rule.count === 1 ? "" : "s"
        }`;
    }
  });
  return `Keep ${parts.join(", ")}${policy.keepAtLeastOne !== false ? "; always keep at least one snapshot" : ""}.`;
}

function humanDuration(ms: number): string {
  const days = Math.round(ms / 86_400_000);
  if (days >= 360 && days % 360 === 0) {
    const years = days / 360;
    return `${years} year${years === 1 ? "" : "s"}`;
  }
  if (days >= 90 && days % 30 === 0) {
    const months = days / 30;
    return `${months} month${months === 1 ? "" : "s"}`;
  }
  return `${days} day${days === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Calendar bucket keys (timezone-anchored) + rolling window.
// ---------------------------------------------------------------------------

export type CalendarUnit = "daily" | "weekly" | "monthly" | "yearly";

/** Public bucket key for a timestamp (UTC anchored unless `timezone` is
 *  passed) — used by tests to pin calendar boundaries (e.g. ISO weeks). */
export function calendarBucketKey(unit: CalendarUnit, ts: number, timezone = "UTC"): string {
  return bucketKeyOf(unit, ts, timezone).key;
}

interface BucketKey {
  unit: CalendarUnit;
  key: string;
}

function bucketKeyOf(unit: CalendarUnit, ts: number, timezone: string): BucketKey {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(ts));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(part("year"));
  const month = Number(part("month"));
  const day = Number(part("day"));
  const weekday = part("weekday");

  switch (unit) {
    case "daily":
      return { unit, key: `${year}-${pad(month)}-${pad(day)}` };
    case "monthly":
      return { unit, key: `${year}-${pad(month)}` };
    case "yearly":
      return { unit, key: `${year}` };
    case "weekly": {
      // Correct ISO 8601 Monday-first week, anchored across year boundaries:
      // week N of year Y starts on the Monday on/before Jan 4 of Y; a date's
      // week is the one containing its THURSDAY, so late-December dates can
      // belong to week 1 of the NEXT year and never to a fake "W00".
      // (The naive day-of-year/7 split produces 2026-W00 / 2025-W52 splits.)
      const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday); // 0..6 Mon-first
      const isoDow = dow + 1; // ISO 1..7 (Mon=1)
      const ms = Date.UTC(year, month - 1, day);
      const thursdayMs = ms + (4 - isoDow) * 86_400_000; // the week's Thursday
      const tYear = new Date(thursdayMs).getUTCFullYear();
      // ISO weekday of Jan 4 of that year, derived mod-7 from the weekday
      // we already know (exact calendar-day arithmetic).
      const jan4Ms = Date.UTC(tYear, 0, 4);
      const delta = Math.round((jan4Ms - ms) / 86_400_000);
      const jan4Dow = ((isoDow - 1 + ((delta % 7) + 7) % 7) % 7) + 1;
      const mondayWeek1 = jan4Ms - (jan4Dow - 1) * 86_400_000; // Monday on/before Jan 4
      const week = 1 + Math.floor((thursdayMs - 3 * 86_400_000 - mondayWeek1) / (7 * 86_400_000));
      return { unit, key: `${tYear}-W${pad(Math.min(53, Math.max(1, week)))}` };
    }
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Keys of the last `count` buckets ending at `now` (dedup-safe calendar
 *  stepping: months/years step from the 1st to avoid day-overflow drift). */
function recentBucketKeys(
  unit: CalendarUnit,
  count: number,
  now: number,
  timezone: string,
): Set<string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const yy = Number(part("year"));
  const mm = Number(part("month"));
  const dd = Number(part("day"));
  const keys = new Set<string>();
  for (let k = 0; k < count; k += 1) {
    const baseTs =
      unit === "daily"
        ? Date.UTC(yy, mm - 1, dd - k)
        : unit === "weekly"
          ? Date.UTC(yy, mm - 1, dd - 7 * k)
          : unit === "monthly"
            ? Date.UTC(yy, mm - 1 - k, 1)
            : Date.UTC(yy - k, 0, 1);
    keys.add(bucketKeyOf(unit, baseTs, timezone).key);
  }
  return keys;
}

const KEEP_AT_LEAST_ONE_REASON = "newest successful snapshot (always keep at least one)";
const SAFETY_TIMESTAMP_REASON =
  "future or unreadable timestamp — kept for safety";

// ---------------------------------------------------------------------------
// Evaluator.
// ---------------------------------------------------------------------------

export function evaluateRetention(input: RetentionEvaluationInput): RetentionEvaluation {
  const now = input.now ?? Date.now();
  const timezone = input.timezone ?? "UTC";
  const policy = input.policy;

  const snapshots = [...input.snapshots].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const decisions = new Map<string, RetentionDecision>();
  const kept = new Set<string>();
  const keepReasons = new Map<string, string>();

  // Guards run first: pinned/hold + rollback artifacts override every rule.
  let guardCount = 0;
  for (const s of snapshots) {
    if (s.pinned || s.rollback) {
      decisions.set(s.id, {
        id: s.id,
        action: "keep",
        reason: s.pinned
          ? "pinned / on hold"
          : "rollback artifact — kept until the rollback window expires",
        kind: "guard",
      });
      kept.add(s.id);
      guardCount += 1;
    }
  }

  if (!policy.enabled) {
    // Conservative migration: disabled/null policy keeps everything.
    for (const s of snapshots) {
      if (!decisions.has(s.id)) {
        decisions.set(s.id, {
          id: s.id,
          action: "keep",
          reason: "retention disabled",
          kind: "policy",
        });
      }
    }
    return summarize(decisions, snapshots, now, timezone, guardCount, 0);
  }

  // Safety: future/bad timestamps are never delete candidates — the data
  // looks newer than the policy window and must not be discarded on a
  // clock anomaly.
  for (const s of snapshots) {
    if (!decisions.has(s.id) && (!isFinite(s.timestamp) || s.timestamp > now)) {
      decisions.set(s.id, {
        id: s.id,
        action: "keep",
        reason: SAFETY_TIMESTAMP_REASON,
        kind: "guard",
      });
      kept.add(s.id);
      guardCount += 1;
    }
  }

  // keepAge: snapshots newer than the window are kept outright.
  for (const rule of policy.rules) {
    if (rule.kind !== "keepAge" || !isFinite(rule.maxAgeMs)) continue;
    const cutoff = now - rule.maxAgeMs;
    for (const s of snapshots) {
      if (!kept.has(s.id) && isFinite(s.timestamp) && s.timestamp >= cutoff) {
        kept.add(s.id);
        keepReasons.set(s.id, `within ${humanDuration(rule.maxAgeMs)} age window`);
      }
    }
  }

  // keepLast N: the N most recent successful snapshots with real (non-
  // future) timestamps — anomalous timestamps never consume the quota
  // meant for genuinely recent captures.
  const keepLastRule = policy.rules.find((r) => r.kind === "keepLast");
  if (keepLastRule && keepLastRule.kind === "keepLast" && keepLastRule.count > 0) {
    const successful = snapshots.filter(
      (s) => s.successful && isFinite(s.timestamp) && s.timestamp <= now,
    );
    for (const s of successful.slice(-keepLastRule.count)) {
      if (!kept.has(s.id)) {
        kept.add(s.id);
        keepReasons.set(s.id, `keep last ${keepLastRule.count}`);
      }
    }
  }

  // Calendar rules: newest successful snapshot per recent bucket
  // (deterministic: ascending order + later snapshots replace).
  for (const rule of policy.rules) {
    if (rule.kind !== "calendar" || rule.count <= 0) continue;
    const window = recentBucketKeys(rule.unit, rule.count, now, timezone);
    const perBucket = new Map<string, RetentionSnapshotDescriptor>();
    for (const s of snapshots) {
      if (!s.successful) continue;
      if (!isFinite(s.timestamp) || s.timestamp > now) continue;
      const key = bucketKeyOf(rule.unit, s.timestamp, timezone).key;
      if (!window.has(key)) continue;
      const current = perBucket.get(key);
      if (!current || s.timestamp >= current.timestamp) {
        perBucket.set(key, s);
      }
    }
    for (const [bucket, rep] of perBucket) {
      if (!kept.has(rep.id)) {
        kept.add(rep.id);
        const label =
          rule.unit === "daily"
            ? `daily bucket ${bucket}`
            : rule.unit === "weekly"
              ? `weekly bucket ${bucket}`
              : rule.unit === "monthly"
                ? `monthly bucket ${bucket}`
                : `yearly bucket ${bucket}`;
        keepReasons.set(rep.id, `newest successful snapshot of ${label}`);
      }
    }
  }

  // Mandatory final snapshot: at least one successful snapshot with a
  // real timestamp is always kept even when no rule covers any of them.
  let keptByGuarantee = 0;
  const successful = snapshots.filter(
    (s) => s.successful && isFinite(s.timestamp) && s.timestamp <= now,
  );
  if (successful.length > 0 && !successful.some((s) => kept.has(s.id))) {
    const newest = successful[successful.length - 1]!; // ascending order
    kept.add(newest.id);
    keepReasons.set(newest.id, KEEP_AT_LEAST_ONE_REASON);
    keptByGuarantee = 1;
  }

  for (const s of snapshots) {
    if (decisions.has(s.id)) continue;
    if (kept.has(s.id)) {
      decisions.set(s.id, {
        id: s.id,
        action: "keep",
        reason: keepReasons.get(s.id) ?? "kept by policy",
        kind: "policy",
      });
    } else {
      decisions.set(s.id, {
        id: s.id,
        action: "delete",
        reason: "not covered by any retention rule",
        kind: "policy",
      });
    }
  }

  return summarize(decisions, snapshots, now, timezone, guardCount, keptByGuarantee);
}

function summarize(
  decisions: Map<string, RetentionDecision>,
  snapshots: RetentionSnapshotDescriptor[],
  now: number,
  timezone: string,
  guardCount: number,
  keptByGuarantee: number,
): RetentionEvaluation {
  const byId = new Map(snapshots.map((s) => [s.id, s]));
  let deleteCount = 0;
  let reclaimableBytes = 0;
  let unknownSizeCount = 0;
  for (const d of decisions.values()) {
    if (d.action !== "delete") continue;
    deleteCount += 1;
    const snap = byId.get(d.id);
    if (snap && snap.sizeBytes !== null && snap.sizeBytes !== undefined) {
      reclaimableBytes += snap.sizeBytes;
    } else {
      unknownSizeCount += 1;
    }
  }
  const keptCount = decisions.size - deleteCount;
  return {
    now,
    timezone,
    decisions: [...decisions.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    keptCount,
    deleteCount,
    reclaimableBytes,
    unknownSizeCount,
    guardCount,
    keptByGuarantee,
  };
}