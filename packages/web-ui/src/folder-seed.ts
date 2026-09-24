// LAMA-346 — Folders page seed-plan presentation.
//
// Pure helpers so the panel's decisions are unit-testable without a DOM:
// whether a seed transfer should be offered, how the space reservation reads,
// which phase a job is in and how the execution-availability verdict is
// worded. The vocabulary itself lives in @lamasync/core/folder-seed — one
// contract shared by the daemon, the server and this UI.

import {
  formatSeedBytes,
  recommendSeed,
  seedPlanPrerequisites,
  seedProgressFraction,
  SEED_RECOMMENDATION_FILE_THRESHOLD,
  SEED_SOURCE_MEASUREMENT_MAX_AGE_MS,
  type SeedJob,
  type SeedJobPhaseOrTerminal,
  type SeedPlan,
  type SeedPlanValidity,
  type SeedPrerequisite,
} from "@lamasync/core/folder-seed";
import type { FolderHealthRecord } from "@lamasync/core/folder-health";

export type SeedTone = "ok" | "warn" | "bad" | "info";

/** Should the "large initial transfer" panel be offered at all? */
export function shouldOfferSeed(
  record: Pick<FolderHealthRecord, "facts">,
): boolean {
  if (record.facts.effectiveType !== "sync") return false;
  return record.facts.measurement !== null;
}

/** The recommendation sentence for this device's latest measurement. */
export function seedRecommendationSentence(
  record: Pick<FolderHealthRecord, "facts">,
): string {
  const measurement = record.facts.measurement;
  if (measurement === null) {
    return (
      `This device has not measured the folder yet, so LamaSync cannot tell how large a first transfer would be. ` +
      `Above ${SEED_RECOMMENDATION_FILE_THRESHOLD.toLocaleString("en-US")} entries a one-time seed transfer is recommended; ` +
      `choose Check this device now to measure it.`
    );
  }
  return recommendSeed({
    fileCount: measurement.pathCount,
    totalBytes: measurement.totalBytes,
  }).reason;
}

export function seedRecommended(record: Pick<FolderHealthRecord, "facts">): boolean {
  const measurement = record.facts.measurement;
  if (measurement === null) return false;
  return recommendSeed({ fileCount: measurement.pathCount, totalBytes: measurement.totalBytes }).recommended;
}

/** Space reservation wording — always the plan's own computed message. */
export function seedSpaceSentence(plan: Pick<SeedPlan, "space">): string {
  return plan.space.message;
}

/**
 * The source-authority sentence. The source device is the operator's explicit
 * choice, so the panel shows the choice and whether it was usable — it never
 * quietly substitutes another device.
 */
export function seedSourceAuthoritySentence(plan: Pick<SeedPlan, "sourceAuthority">): string {
  return plan.sourceAuthority.message;
}

/**
 * The filter-universe sentence: the archive must be built from exactly the
 * universe the following sync baseline uses.
 */
export function seedFilterUniverseSentence(plan: Pick<SeedPlan, "filterUniverse">): string {
  return plan.filterUniverse.message;
}

/** Every prerequisite of the plan, so the panel can list what is missing. */
export function seedPrerequisites(
  plan: Pick<
    SeedPlan,
    "sourceAuthority" | "filterUniverse" | "stagingPolicy" | "archive" | "space" | "target"
  >,
): SeedPrerequisite[] {
  return seedPlanPrerequisites(plan);
}

export interface SeedSourceCandidate {
  hostId: string;
  /** The device has reported a deep measurement. */
  measured: boolean;
  /** That measurement is within the freshness budget. */
  fresh: boolean;
  fileCount: number;
  totalBytes: number;
  /** Ready-to-render label for the picker. */
  label: string;
}

/**
 * The devices an operator may name as the source: every other assignment of
 * the folder, with its own measurement. The target is never offered (a device
 * cannot seed itself) and the target's own measurement is never reused as the
 * source — that would seed the empty destination with itself.
 */
export function seedSourceCandidates(
  records: readonly Pick<FolderHealthRecord, "hostId" | "facts">[],
  targetHostId: string,
  now: number,
): SeedSourceCandidate[] {
  const candidates: SeedSourceCandidate[] = [];
  for (const record of records) {
    if (record.hostId === targetHostId) continue;
    const measurement = record.facts.measurement;
    const ageMs = measurement === null ? null : Math.max(0, now - measurement.measuredAt);
    const fresh = ageMs !== null && ageMs <= SEED_SOURCE_MEASUREMENT_MAX_AGE_MS;
    const fileCount = measurement?.pathCount ?? 0;
    const totalBytes = measurement?.totalBytes ?? 0;
    candidates.push({
      hostId: record.hostId,
      measured: measurement !== null,
      fresh,
      fileCount,
      totalBytes,
      label:
        measurement === null
          ? `${record.hostId} — not measured yet`
          : `${record.hostId} — ${fileCount.toLocaleString("en-US")} entries (${formatSeedBytes(totalBytes)})` +
            (fresh ? "" : " — measurement is stale"),
    });
  }
  candidates.sort((a, b) => {
    const usableA = a.measured && a.fresh ? 1 : 0;
    const usableB = b.measured && b.fresh ? 1 : 0;
    if (usableA !== usableB) return usableB - usableA;
    if (a.totalBytes !== b.totalBytes) return b.totalBytes - a.totalBytes;
    return a.hostId.localeCompare(b.hostId);
  });
  return candidates;
}

/**
 * Why the currently selected source cannot be used, or null when it can.
 * The panel refuses to prepare a plan without a usable, explicit choice —
 * there is no "pick one for me".
 */
export function seedSourceSelectionError(
  candidates: readonly SeedSourceCandidate[],
  selectedHostId: string | null,
): string | null {
  if (selectedHostId === null || selectedHostId.length === 0) {
    return "Choose the device that holds the data. LamaSync never picks the source for you.";
  }
  const candidate = candidates.find((c) => c.hostId === selectedHostId) ?? null;
  if (candidate === null) {
    return "That device is not assigned to this folder, so it cannot be the source.";
  }
  if (!candidate.measured) {
    return `${candidate.hostId} has not measured this folder yet. Open the folder on that device and choose Check this device now.`;
  }
  if (!candidate.fresh) {
    return `${candidate.hostId}'s measurement is stale. Refresh it (Check this device now on that device) so the reserved space matches the tree.`;
  }
  if (candidate.fileCount === 0) {
    return `${candidate.hostId} currently measures this folder as empty, so there is nothing to seed.`;
  }
  return null;
}

export function seedSpaceTone(plan: Pick<SeedPlan, "space">): SeedTone {
  return plan.space.ok ? "ok" : "bad";
}

/**
 * Archive format wording. Never claims the target has tooling it has not
 * reported: `toolingReady === false` is stated as "not verified yet".
 */
export function seedArchiveSentence(
  plan: Pick<SeedPlan, "archive">,
): string {
  const label = plan.archive.format === "tar.zstd" ? "tar + zstd" : "tar + gzip";
  const parts: string[] = [`Archive format: ${label}.`];
  if (!plan.archive.toolingReady) {
    parts.push(
      "This device has not reported that it has the tools to build and unpack this archive, so the plan is not runnable yet — run Check this device now.",
    );
  } else if (plan.archive.fallback) {
    parts.push(plan.archive.choiceReason);
  }
  return parts.join(" ");
}

/** Staging wording — the sibling rule, in plain language. */
export function seedStagingSentence(plan: Pick<SeedPlan, "stagingPolicy">): string {
  return plan.stagingPolicy.message;
}

/**
 * Whether the plan may run, and why not. The execution verdict from the server
 * is always shown; a non-runnable plan says exactly what is missing, from the
 * plan's own prerequisite list rather than a single boolean.
 */
export function seedRunnableVerdict(
  plan: Pick<
    SeedPlan,
    "execution" | "space" | "archive" | "stagingPolicy" | "sourceAuthority" | "filterUniverse"
  >,
  validity: Pick<SeedPlanValidity, "valid" | "message"> | null,
): { runnable: boolean; message: string } {
  if (!plan.execution.available) {
    return { runnable: false, message: plan.execution.reason };
  }
  if (validity !== null && !validity.valid) {
    return { runnable: false, message: validity.message };
  }
  return { runnable: true, message: "This seed plan is ready to run." };
}

/** The unmet prerequisites, in the order they gate execution. */
export function seedUnmetPrerequisites(
  plan: Pick<
    SeedPlan,
    "sourceAuthority" | "filterUniverse" | "stagingPolicy" | "archive" | "space" | "target"
  >,
): SeedPrerequisite[] {
  return seedPrerequisites(plan).filter((item) => !item.ok);
}

/** Plain-language phase labels. Never rclone vocabulary. */
export function seedPhaseLabel(phase: SeedJobPhaseOrTerminal): string {
  switch (phase) {
    case "preflight":
      return "Checking the plan";
    case "measuring_source":
      return "Measuring the source";
    case "archiving_source":
      return "Building the archive";
    case "uploading_archive":
      return "Uploading the archive to temporary seed space";
    case "downloading_archive":
      return "Downloading the archive";
    case "verifying_archive":
      return "Verifying the archive";
    case "extracting_target":
      return "Unpacking beside the target";
    case "verifying_target":
      return "Verifying every file";
    case "publishing":
      return "Publishing with one atomic rename";
    case "baseline_validation":
      return "Validating the sync baseline";
    case "completed":
      return "Finished";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

export function seedJobTone(status: SeedJob["status"]): SeedTone {
  switch (status) {
    case "completed":
      return "ok";
    case "running":
      return "info";
    case "planned":
      return "info";
    case "failed":
      return "bad";
    case "cancelled":
      return "warn";
  }
}

/** Phase + bounded counters + percentage only when a total is known. */
export function seedProgressSentence(job: Pick<SeedJob, "phase" | "progress" | "status">): string {
  const label = seedPhaseLabel(job.phase);
  const fraction = seedProgressFraction(job.progress);
  const parts: string[] = [label];
  const p = job.progress;
  if (p.bytesTotal !== null && p.bytesTotal > 0) {
    parts.push(`${formatSeedBytes(p.bytesDone)} of ${formatSeedBytes(p.bytesTotal)}`);
  } else if (p.bytesDone > 0) {
    parts.push(`${formatSeedBytes(p.bytesDone)} so far`);
  }
  if (p.entriesTotal !== null && p.entriesTotal > 0) {
    parts.push(`${p.entriesDone.toLocaleString("en-US")} of ${p.entriesTotal.toLocaleString("en-US")} entries`);
  } else if (p.entriesDone > 0) {
    parts.push(`${p.entriesDone.toLocaleString("en-US")} entries so far`);
  }
  if (fraction !== null) parts.push(`${Math.round(fraction * 100)}%`);
  return parts.join(" · ");
}

/** Fraction 0..1 for a progress bar, or null when honestly unknown. */
export function seedProgressPercent(job: Pick<SeedJob, "progress">): number | null {
  const fraction = seedProgressFraction(job.progress);
  return fraction === null ? null : Math.round(fraction * 100);
}

/**
 * The single sentence shown when a seed plan exists but cannot run yet.
 *
 * The gate is the operator's SEED PILOT, not a missing feature: the transport
 * exists, but it has never run between two real machines, so nothing is opened
 * fleet-wide. The sentence therefore names what the operator can DO about it.
 */
export function seedUnavailableHelp(): string {
  return (
    "Seeding runs only inside the operator's seed pilot, which authorizes ONE folder and ONE " +
    "source/target pair at a time and requires the temporary seed space to be probed first. " +
    "Preparing a plan is safe and read-only: it names the source device, checks that the archive would be " +
    "built from the folder's effective ignore rules, checks that the target is empty, its free space and its " +
    "archive tools, and shows exactly what would be reserved. " +
    "Sync with an existing baseline is untouched and keeps its fixed timeout; a FIRST sync with no baseline yet is " +
    "supervised by the progress-aware stall budget, so a large first transfer is no longer killed at 10 minutes " +
    "while it is still moving data."
  );
}

export interface SeedGlossaryEntry {
  term: string;
  plain: string;
}

/** Additions to the folder-health glossary, shown in the seed panel. */
export const SEED_GLOSSARY: readonly SeedGlossaryEntry[] = [
  {
    term: "Seed transfer",
    plain:
      "A one-time shortcut for the first copy of a very large folder: the source is packed into a single archive, the new device unpacks it beside the destination, and only then does normal sync take over. It avoids copying hundreds of thousands of files one at a time.",
  },
  {
    term: "Staging directory",
    plain:
      "A temporary directory created next to the destination — in the same parent directory, never inside it — where the archive is unpacked and checked. It is renamed into place in one step, so a half-finished seed is never visible to sync.",
  },
  {
    term: "Archive format (tar + zstd / tar + gzip)",
    plain:
      "How the folder is packed. zstd is faster and smaller and is used when the device has it; gzip is the compatible fallback. Both are verified with a checksum before anything is unpacked.",
  },
  {
    term: "Effective filter universe",
    plain:
      "The paths this folder's ignore rules actually sync: its lamasyncignore patterns, the ignore-git-metadata option, and respect-gitignore. A seed archives exactly that set — not the raw folder — or the following sync would not agree with what was published. Anything the rules exclude is never even measured, and the archive is handed only that set.",
  },
  {
    term: "Source device",
    plain:
      "The device that already holds the data. You name it explicitly when you prepare a plan; LamaSync never guesses it from which folder happens to be largest.",
  },
  {
    term: "Progress-aware timeout",
    plain:
      "A sync that already has a saved baseline keeps its exact fixed timeout, unchanged. A FIRST transfer with no baseline yet — the case that used to be killed at 10 minutes while it was still moving data — now keeps running while it makes measurable progress, and is stopped when it genuinely stalls or hits the 6-hour ceiling.",
  },
];
