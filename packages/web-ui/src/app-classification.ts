// LAMA-315 stage 2 — read-only review surfaces for path classification.
//
// Every helper here answers exactly one question: "what does *this* capture
// spec actually say?" Nothing derives a class from the current template or
// protection, nothing consumes a class to change capture or exclusion, and
// `unknown` stays unknown. A snapshot summary is therefore always built from
// the snapshot's own frozen `capturedSpec`, and a protection summary from the
// protection's frozen enrollment `captureSpec` — never from the template the
// operator may edit afterwards.

import type {
  ApplicationProtection,
  ApplicationSnapshot,
  CaptureSpec,
  CaptureSpecPath,
  PathClassification,
} from "@lamasync/core";
import type { OSKey } from "./presets.ts";

/** Display labels for the taxonomy. Shared by the template editor and the
 *  review surfaces so a class is called the same thing everywhere. */
export const CLASS_LABEL: Record<PathClassification, string> = {
  portable_config: "Portable config",
  machine_state: "Machine state",
  cache: "Cache",
  secrets: "Secrets",
  custom: "Custom",
  unknown: "Unknown",
};

/** Review order: `secrets` first so credentials are never missed, `unknown`
 *  last but always present so nothing is silently dropped. */
export const CLASS_ORDER: readonly PathClassification[] = [
  "secrets",
  "portable_config",
  "machine_state",
  "cache",
  "custom",
  "unknown",
];

/** Runtime guard for JSON that predates the typed contract: an entry carrying
 *  an unrecognized class is reviewed as `unknown`, never rendered as a class
 *  the taxonomy does not have. */
function isPathClassification(value: unknown): value is PathClassification {
  return CLASS_ORDER.some((known) => known === value);
}

/** Coarse label for a stored `suggested` confidence number. Matches the
 *  classifier's documented high/medium/low (0.9/0.6/0.3). */
export function confidenceLabel(confidence: number | null | undefined): string {
  if (confidence === null || confidence === undefined) return "";
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.45) return "medium";
  return "low";
}

/** Where an entry's class came from. Rendered, never inferred: a legacy row
 *  that stores a real class with no provenance is "unrecorded", not
 *  "confirmed by the operator". */
export type ProvenanceKind = "manual" | "suggested" | "unrecorded";

export interface Provenance {
  kind: ProvenanceKind;
  label: string;
}

/** Truthful provenance text for one entry. */
export function provenanceOf(entry: CaptureSpecPath): Provenance {
  const classification = isPathClassification(entry.classification)
    ? entry.classification
    : "unknown";
  const source = entry.classificationSource ?? "default";
  if (source === "manual") {
    return { kind: "manual", label: "Confirmed by operator" };
  }
  if (source === "suggested") {
    const level = confidenceLabel(entry.confidence);
    return {
      kind: "suggested",
      label: level
        ? `Suggested (${level} confidence) — not yet confirmed`
        : "Suggested — not yet confirmed",
    };
  }
  return {
    kind: "unrecorded",
    label: classification === "unknown" ? "Not classified" : "Source not recorded",
  };
}

/** Visual weight for a class hint. `critical` is reserved for the
 *  conspicuous `secrets` treatment; everything else is a quiet note, so an
 *  included cache path never reads as an error. */
export type HintTone = "critical" | "note";

/** Read-only guidance per class. None of these is an instruction to exclude
 *  anything — exclusion stays an explicit operator action. */
const CLASS_HINT: Record<PathClassification, string> = {
  secrets:
    "Backup-eligible and never auto-excluded — restore or migrate these deliberately.",
  portable_config: "Portable settings — safe to keep backing up and to migrate.",
  machine_state:
    "Machine-specific state — safe to back up; review before restoring onto a different host.",
  cache:
    "Regenerable — losing it costs rebuild time, never correctness. Still captured as configured.",
  custom: "Operator-assigned class — captured exactly as configured.",
  unknown: "Not classified — shown as unknown rather than guessed.",
};

const HINT_TONE: Record<PathClassification, HintTone> = {
  secrets: "critical",
  portable_config: "note",
  machine_state: "note",
  cache: "note",
  custom: "note",
  unknown: "note",
};

export interface PathReview {
  /** OS bucket this path was declared in. */
  os: OSKey;
  path: string;
  classification: PathClassification;
  /** Deterministic archive member root recorded on a snapshot entry; null
   *  when the spec carries none (template and enrollment specs never do). */
  archivePath: string | null;
  rationale: string | null;
  provenance: ProvenanceKind;
  provenanceLabel: string;
  /** Present only for a pending (`suggested`) classification. */
  confidence: number | null;
}

export interface ClassificationGroup {
  classification: PathClassification;
  label: string;
  hint: string;
  hintTone: HintTone;
  entries: PathReview[];
}

export interface CaptureSpecReview {
  groups: ClassificationGroup[];
  /** Raw exclude patterns exactly as stored, in order. */
  excludes: string[];
  totalPaths: number;
  countByClass: Record<PathClassification, number>;
  /** True when any captured path is classed `secrets`. */
  hasSecrets: boolean;
  /** True when a `cache`-classed path is still included in capture. */
  hasIncludedCache: boolean;
}

/** The capture contract stores excludes as raw pattern strings
 *  (`CaptureSpec.excludes: string[]`) with no class, rationale, or provenance
 *  field. Review surfaces therefore list the patterns verbatim and must not
 *  invent an association. Associating an exclude with a classification needs
 *  a contract/data change (a later stage), not a render-time guess. */
export const EXCLUDES_CLASSIFICATION_GAP =
  "Excludes are stored as raw patterns — the capture contract records no classification or rationale for them.";

const OS_KEYS: readonly OSKey[] = ["linux", "macos", "windows"];

function reviewEntry(os: OSKey, entry: CaptureSpecPath): PathReview {
  const classification = isPathClassification(entry.classification)
    ? entry.classification
    : "unknown";
  const provenance = provenanceOf(entry);
  return {
    os,
    path: entry.path,
    classification,
    archivePath: entry.archivePath ?? null,
    rationale: entry.rationale ?? null,
    provenance: provenance.kind,
    provenanceLabel: provenance.label,
    // Confidence is meaningful only for a value the recommender placed and
    // the operator has not confirmed; a confirmed class drops it by design.
    confidence: provenance.kind === "suggested" ? entry.confidence ?? null : null,
  };
}

/** Group every declared path in a spec by its own recorded class.
 *
 *  Reads only the spec it is given. Callers pass the spec that owns the
 *  facts: a snapshot's `capturedSpec`, a protection's frozen `captureSpec`,
 *  or a template's editable `paths`. */
export function reviewCaptureSpec(spec: CaptureSpec | null | undefined): CaptureSpecReview {
  const countByClass: Record<PathClassification, number> = {
    portable_config: 0,
    machine_state: 0,
    cache: 0,
    secrets: 0,
    custom: 0,
    unknown: 0,
  };

  const buckets = new Map<PathClassification, PathReview[]>();
  let totalPaths = 0;

  for (const os of OS_KEYS) {
    for (const entry of spec?.paths?.[os] ?? []) {
      const review = reviewEntry(os, entry);
      totalPaths += 1;
      countByClass[review.classification] += 1;
      const bucket = buckets.get(review.classification) ?? [];
      bucket.push(review);
      buckets.set(review.classification, bucket);
    }
  }

  const groups: ClassificationGroup[] = [];
  for (const classification of CLASS_ORDER) {
    const entries = buckets.get(classification);
    if (!entries || entries.length === 0) continue;
    groups.push({
      classification,
      label: CLASS_LABEL[classification],
      hint: CLASS_HINT[classification],
      hintTone: HINT_TONE[classification],
      entries,
    });
  }

  return {
    groups,
    excludes: [...(spec?.excludes ?? [])],
    totalPaths,
    countByClass,
    hasSecrets: countByClass.secrets > 0,
    hasIncludedCache: countByClass.cache > 0,
  };
}

/** The only correct source for a snapshot summary: the snapshot's own frozen
 *  `capturedSpec`. Deliberately takes the snapshot — not a protection or a
 *  template — so editing today's template cannot reinterpret an old snapshot. */
export function snapshotCaptureReview(
  snapshot: Pick<ApplicationSnapshot, "capturedSpec">,
): CaptureSpecReview {
  return reviewCaptureSpec(snapshot.capturedSpec);
}

/** The frozen enrollment spec of a protection (`captureSpec`, copied at
 *  enrollment and never mutated by template edits) — as opposed to the
 *  template's current editable `paths`. */
export function protectionCaptureReview(
  protection: Pick<ApplicationProtection, "captureSpec">,
): CaptureSpecReview {
  return reviewCaptureSpec(protection.captureSpec);
}

/** One-line counts sentence for a review, e.g.
 *  "4 paths · 1 secrets · 2 cache · 1 unknown". Classes with no entries are
 *  omitted; `unknown` always appears when it has entries so it stays visible. */
export function reviewCountsSentence(review: CaptureSpecReview): string {
  const parts = [`${review.totalPaths} path${review.totalPaths === 1 ? "" : "s"}`];
  for (const classification of CLASS_ORDER) {
    const count = review.countByClass[classification];
    if (count > 0) parts.push(`${count} ${CLASS_LABEL[classification].toLowerCase()}`);
  }
  return parts.join(" · ");
}
