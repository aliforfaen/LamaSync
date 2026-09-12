// LAMA-315 stage 2 — focused tests for the read-only classification review
// helpers. The pages render these helpers' output directly, so this file is
// where the display/safety states are pinned: historical immutability,
// secrets conspicuity, cache as a low-key hint, unknown staying unknown, and
// truthful provenance/archive/exclude rendering.

import { describe, expect, test } from "bun:test";
import type {
  ApplicationProtection,
  ApplicationSnapshot,
  CaptureSpec,
  CaptureSpecPath,
  PathClassification,
} from "@lamasync/core";
import {
  CLASS_LABEL,
  CLASS_ORDER,
  EXCLUDES_CLASSIFICATION_GAP,
  confidenceLabel,
  protectionCaptureReview,
  provenanceOf,
  reviewCaptureSpec,
  reviewCountsSentence,
  snapshotCaptureReview,
} from "./app-classification.ts";

function entry(over: Partial<CaptureSpecPath> & { path: string }): CaptureSpecPath {
  return { classification: "unknown", ...over };
}

function spec(linux: CaptureSpecPath[], over: Partial<CaptureSpec> = {}): CaptureSpec {
  return { paths: { linux }, excludes: [], notes: null, ...over };
}

function protectionOf(captureSpec: CaptureSpec): ApplicationProtection {
  return {
    id: "prt-1",
    templateId: "tpl-1",
    templateRevision: 4,
    hostId: "host-1",
    name: "Neovim",
    enabled: true,
    schedule: null,
    destination: "server_archive",
    backendId: null,
    backendName: null,
    s3Bucket: null,
    captureSpec,
    createdAt: 1,
    updatedAt: 1,
  };
}

function snapshotOf(capturedSpec: CaptureSpec, over: Partial<ApplicationSnapshot> = {}): ApplicationSnapshot {
  return {
    id: "snap-1",
    protectionId: "prt-1",
    templateId: "tpl-1",
    templateRevision: 4,
    sourceHostId: "host-1",
    createdAt: 1,
    archivePath: "apps/prt-1/1.tar.gz",
    backendId: null,
    objectKey: null,
    s3Bucket: null,
    archiveFormat: "tar.gz",
    sizeBytes: 1024,
    checksumSha256: null,
    description: null,
    capturedSpec,
    integrityStatus: "verified",
    ...over,
  };
}

describe("taxonomy display labels", () => {
  test("every class has a label and the review order covers the whole union", () => {
    const classes: PathClassification[] = [
      "portable_config",
      "machine_state",
      "cache",
      "secrets",
      "custom",
      "unknown",
    ];
    expect([...CLASS_ORDER].sort()).toEqual([...classes].sort());
    for (const classification of classes) {
      expect(CLASS_LABEL[classification]).toBeTruthy();
    }
  });

  test("confidence labels match the classifier's documented bands", () => {
    expect(confidenceLabel(0.9)).toBe("high");
    expect(confidenceLabel(0.6)).toBe("medium");
    expect(confidenceLabel(0.3)).toBe("low");
    expect(confidenceLabel(null)).toBe("");
    expect(confidenceLabel(undefined)).toBe("");
  });
});

describe("provenance is rendered, never inferred", () => {
  test("an operator confirmation reads as confirmed", () => {
    const provenance = provenanceOf(
      entry({ path: "~/.ssh", classification: "secrets", classificationSource: "manual" }),
    );
    expect(provenance).toEqual({ kind: "manual", label: "Confirmed by operator" });
  });

  test("a pending suggestion names its confidence and stays unconfirmed", () => {
    const provenance = provenanceOf(
      entry({
        path: "~/.cache",
        classification: "cache",
        classificationSource: "suggested",
        confidence: 0.9,
      }),
    );
    expect(provenance.kind).toBe("suggested");
    expect(provenance.label).toBe("Suggested (high confidence) — not yet confirmed");
  });

  test("a suggestion without a recorded confidence still says unconfirmed", () => {
    const provenance = provenanceOf(
      entry({ path: "~/.cache", classification: "cache", classificationSource: "suggested" }),
    );
    expect(provenance.label).toBe("Suggested — not yet confirmed");
  });

  test("the untouched unknown state reads as not classified", () => {
    // Legacy rows normalize to this exact shape (unknown/default).
    expect(provenanceOf(entry({ path: "~/foo" })).label).toBe("Not classified");
  });

  test("a stored class with no provenance is never claimed as a confirmation", () => {
    const provenance = provenanceOf(entry({ path: "~/foo", classification: "cache" }));
    expect(provenance.kind).toBe("unrecorded");
    expect(provenance.label).toBe("Source not recorded");
    expect(provenance.label).not.toMatch(/confirm/i);
  });

  test("confidence is surfaced only for a pending suggestion", () => {
    // A confirmed class drops confidence by design; a legacy row has none.
    const legacy = reviewCaptureSpec(
      spec([entry({ path: "~/foo", classification: "cache", confidence: 0.9 })]),
    );
    expect(legacy.groups[0]?.entries[0]?.confidence).toBeNull();
    const pending = reviewCaptureSpec(
      spec([
        entry({
          path: "~/.cache",
          classification: "cache",
          classificationSource: "suggested",
          confidence: 0.9,
        }),
      ]),
    );
    expect(pending.groups[0]?.entries[0]?.confidence).toBe(0.9);
  });
});

describe("grouping", () => {
  test("groups follow the review order with per-class counts", () => {
    const review = reviewCaptureSpec(
      spec([
        entry({ path: "~/mystery" }),
        entry({ path: "~/.cache", classification: "cache", classificationSource: "manual" }),
        entry({
          path: "~/.ssh",
          classification: "secrets",
          classificationSource: "manual",
        }),
        entry({ path: "~/.config/nvim" }),
      ]),
    );
    expect(review.groups.map((group) => group.classification)).toEqual([
      "secrets",
      "cache",
      "unknown",
    ]);
    expect(review.countByClass.secrets).toBe(1);
    expect(review.countByClass.cache).toBe(1);
    expect(review.countByClass.unknown).toBe(2);
    expect(review.totalPaths).toBe(4);
    expect(reviewCountsSentence(review)).toBe("4 paths · 1 secrets · 1 cache · 2 unknown");
  });

  test("a spec with no paths produces no groups", () => {
    const review = reviewCaptureSpec(spec([]));
    expect(review.groups).toEqual([]);
    expect(review.totalPaths).toBe(0);
    expect(reviewCountsSentence(review)).toBe("0 paths");
  });

  test("an absent spec is not an error", () => {
    expect(reviewCaptureSpec(null).totalPaths).toBe(0);
    expect(reviewCaptureSpec(undefined).groups).toEqual([]);
  });

  test("paths from every OS bucket are reviewed and tagged with their bucket", () => {
    const review = reviewCaptureSpec({
      paths: {
        linux: [entry({ path: "~/.config/nvim" })],
        macos: [entry({ path: "~/.config/nvim" })],
        windows: [entry({ path: "%APPDATA%\\nvim" })],
      },
      excludes: [],
      notes: null,
    });
    const unknown = review.groups.find((group) => group.classification === "unknown");
    expect(unknown?.entries.map((e) => e.os)).toEqual(["linux", "macos", "windows"]);
    expect(review.totalPaths).toBe(3);
  });

  test("rationale and archive mapping are carried through when present", () => {
    const review = reviewCaptureSpec(
      spec([
        entry({
          path: "~/.config/nvim",
          classification: "portable_config",
          rationale: "Explicitly classified by the operator.",
          archivePath: "home/.config/nvim",
          classificationSource: "manual",
        }),
      ]),
    );
    const reviewed = review.groups[0]?.entries[0];
    expect(reviewed?.rationale).toBe("Explicitly classified by the operator.");
    expect(reviewed?.archivePath).toBe("home/.config/nvim");
  });

  test("a spec without an archive mapping reports none rather than inventing one", () => {
    const review = reviewCaptureSpec(spec([entry({ path: "~/.config/nvim" })]));
    expect(review.groups[0]?.entries[0]?.archivePath).toBeNull();
  });
});

describe("safety states", () => {
  test("included secrets are conspicuous and never framed as a mistake", () => {
    const review = reviewCaptureSpec(
      spec([
        entry({
          path: "~/.ssh",
          classification: "secrets",
          classificationSource: "manual",
        }),
      ]),
    );
    const secrets = review.groups.find((group) => group.classification === "secrets");
    expect(review.hasSecrets).toBe(true);
    expect(secrets?.hintTone).toBe("critical");
    expect(secrets?.hint).toContain("never auto-excluded");
    // Never an instruction to remove the path, and never an error verdict.
    expect(secrets?.hint).not.toMatch(/should be excluded|must be excluded|remove|error/i);
    // A secrets class is not cache, so the regenerable hint must not leak in.
    expect(secrets?.hint).not.toContain("Regenerable");
  });

  test("an included cache path is a quiet regenerable note, not an error", () => {
    const review = reviewCaptureSpec(
      spec([entry({ path: "~/.cache", classification: "cache", classificationSource: "manual" })]),
    );
    const cache = review.groups.find((group) => group.classification === "cache");
    expect(review.hasIncludedCache).toBe(true);
    expect(cache?.hintTone).toBe("note");
    expect(cache?.hint).toContain("Regenerable");
    expect(cache?.hint).not.toMatch(/should be excluded|must be excluded|error/i);
  });

  test("unknown stays unknown and is never guessed into another class", () => {
    const review = reviewCaptureSpec(
      spec([entry({ path: "~/some/uncommon/layout", classification: "unknown" })]),
    );
    expect(review.groups).toHaveLength(1);
    expect(review.groups[0]?.classification).toBe("unknown");
    expect(review.groups[0]?.label).toBe("Unknown");
    expect(review.groups[0]?.hint).toContain("Not classified");
    expect(review.countByClass.cache).toBe(0);
    expect(review.countByClass.secrets).toBe(0);
  });

  test("a class the taxonomy never had is reviewed as unknown, not rendered verbatim", () => {
    // Malformed legacy JSON is the only way a value outside the union reaches
    // the UI; it must not become a label, and it must not be assumed classed.
    const malformedEntry = entry({ path: "~/x" });
    Reflect.set(malformedEntry, "classification", "totally_new_class");
    const malformed = spec([malformedEntry]);
    const review = reviewCaptureSpec(malformed);
    expect(review.groups.map((group) => group.classification)).toEqual(["unknown"]);
    expect(review.countByClass.unknown).toBe(1);
    expect(review.groups[0]?.entries[0]?.provenanceLabel).toBe("Not classified");
  });

  test("a raw-path template with no annotations still reviews every path", () => {
    // The manual-template guarantee: nothing is added or dropped by review.
    const review = reviewCaptureSpec(spec([entry({ path: "~/odd" }), entry({ path: "~/odder" })]));
    expect(review.totalPaths).toBe(2);
    expect(review.groups[0]?.entries.map((e) => e.path)).toEqual(["~/odd", "~/odder"]);
  });
});

describe("historical immutability", () => {
  test("a snapshot summary uses the snapshot's own frozen spec, not today's template", () => {
    const frozen = spec(
      [
        entry({
          path: "~/.config/nvim",
          classification: "portable_config",
          classificationSource: "manual",
          archivePath: "home/.config/nvim",
        }),
      ],
      { excludes: ["**/node_modules"] },
    );
    const todayTemplatePaths = spec([
      entry({
        path: "~/.config/nvim",
        classification: "cache",
        classificationSource: "suggested",
        confidence: 0.6,
      }),
    ]);

    const fromSnapshot = snapshotCaptureReview(snapshotOf(frozen));
    expect(fromSnapshot.countByClass.portable_config).toBe(1);
    expect(fromSnapshot.countByClass.cache).toBe(0);
    expect(fromSnapshot.groups[0]?.entries[0]?.archivePath).toBe("home/.config/nvim");
    expect(fromSnapshot.groups[0]?.entries[0]?.provenanceLabel).toBe("Confirmed by operator");
    expect(fromSnapshot.excludes).toEqual(["**/node_modules"]);

    // The current template genuinely disagrees — and the snapshot review does
    // not follow it. Editing the template cannot reinterpret history.
    const fromTemplate = reviewCaptureSpec(todayTemplatePaths);
    expect(fromTemplate.countByClass.cache).toBe(1);
    expect(fromTemplate.countByClass.portable_config).toBe(0);
    expect(fromSnapshot.groups[0]?.classification).not.toBe(fromTemplate.groups[0]?.classification);
  });

  test("two snapshots of one protection keep their own captured classes", () => {
    const before = snapshotCaptureReview(
      snapshotOf(spec([entry({ path: "~/.cache", classification: "unknown" })]), { id: "snap-a" }),
    );
    const after = snapshotCaptureReview(
      snapshotOf(
        spec([
          entry({ path: "~/.cache", classification: "cache", classificationSource: "manual" }),
        ]),
        { id: "snap-b" },
      ),
    );
    expect(before.countByClass.unknown).toBe(1);
    expect(before.countByClass.cache).toBe(0);
    expect(after.countByClass.cache).toBe(1);
    expect(after.countByClass.unknown).toBe(0);
  });

  test("a protection summary uses its frozen enrollment spec, not the editable template", () => {
    const frozenAtEnrollment = spec([
      entry({ path: "~/.ssh", classification: "secrets", classificationSource: "manual" }),
    ]);
    const templateToday = spec([entry({ path: "~/.ssh", classification: "portable_config" })]);

    const fromProtection = protectionCaptureReview(protectionOf(frozenAtEnrollment));
    expect(fromProtection.hasSecrets).toBe(true);
    expect(fromProtection.countByClass.portable_config).toBe(0);

    // The same path in today's template is a different class; the protection
    // review keeps the frozen one.
    const fromTemplate = reviewCaptureSpec(templateToday);
    expect(fromTemplate.countByClass.portable_config).toBe(1);
    expect(fromProtection.countByClass.secrets).toBe(1);
  });
});

describe("excludes", () => {
  test("excludes are listed verbatim and the missing classification is documented", () => {
    const review = reviewCaptureSpec(
      spec([entry({ path: "~/.config/nvim" })], { excludes: ["**/node_modules", "*.log"] }),
    );
    expect(review.excludes).toEqual(["**/node_modules", "*.log"]);
    // No class is fabricated for an exclude: the path counts stay path-only.
    expect(review.totalPaths).toBe(1);
    expect(EXCLUDES_CLASSIFICATION_GAP).toContain("no classification");
    for (const group of review.groups) {
      expect(group.entries.some((e) => e.path === "**/node_modules")).toBe(false);
    }
  });

  test("a spec with no excludes reports none", () => {
    expect(reviewCaptureSpec(spec([entry({ path: "~/.config/nvim" })])).excludes).toEqual([]);
  });
});
