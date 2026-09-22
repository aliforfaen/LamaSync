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
  seedProgressFraction,
  SEED_RECOMMENDATION_FILE_THRESHOLD,
  type SeedJob,
  type SeedJobPhaseOrTerminal,
  type SeedPlan,
  type SeedPlanValidity,
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
 * is always shown; a non-runnable plan says exactly what is missing.
 */
export function seedRunnableVerdict(
  plan: Pick<SeedPlan, "execution" | "space" | "archive" | "stagingPolicy">,
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

/** The single sentence shown when a seed plan exists but cannot run yet. */
export function seedUnavailableHelp(): string {
  return (
    "Seeding is not switched on yet. Preparing a plan is safe and read-only: it measures the folder, " +
    "checks the target's free space and archive tools, and shows exactly what would be reserved. " +
    "Ordinary sync is unaffected and still works for this folder."
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
      "A temporary directory created next to the destination — never inside it — where the archive is unpacked and checked. It is renamed into place in one step, so a half-finished seed is never visible to sync.",
  },
  {
    term: "Archive format (tar + zstd / tar + gzip)",
    plain:
      "How the folder is packed. zstd is faster and smaller and is used when the device has it; gzip is the compatible fallback. Both are verified with a checksum before anything is unpacked.",
  },
  {
    term: "Progress-aware timeout",
    plain:
      "Large first transfers used to be killed at a fixed 10 minutes even while they were still moving data. A seed stage now keeps running while it keeps making measurable progress, and is stopped when it genuinely stalls.",
  },
];
