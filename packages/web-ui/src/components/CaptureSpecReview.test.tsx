// LAMA-315 stage 2 — the read-only review renderer.
//
// Repo convention: bun:test + react-dom/server static markup (no jsdom, no
// @testing-library). The component is presentational, so a static render is
// the whole contract: which class owns a path, how conspicuous it is, what
// provenance/archive/rationale text reaches the operator, and that a missing
// fact is shown as missing rather than filled in.

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CaptureSpec, CaptureSpecPath } from "@lamasync/core";
import { reviewCaptureSpec } from "../app-classification.ts";
import { CaptureSpecReview } from "./CaptureSpecReview.tsx";

function entry(over: Partial<CaptureSpecPath> & { path: string }): CaptureSpecPath {
  return { classification: "unknown", ...over };
}

function spec(linux: CaptureSpecPath[], excludes: string[] = []): CaptureSpec {
  return { paths: { linux }, excludes, notes: null };
}

function render(s: CaptureSpec, props: Partial<Parameters<typeof CaptureSpecReview>[0]> = {}): string {
  return renderToStaticMarkup(
    <CaptureSpecReview review={reviewCaptureSpec(s)} archiveMapping="full" {...props} />,
  );
}

describe("CaptureSpecReview rendering", () => {
  it("keeps the secrets entry conspicuous and backup-eligible, never an error", () => {
    const markup = render(
      spec([
        entry({
          path: "~/.ssh",
          classification: "secrets",
          classificationSource: "manual",
          rationale: "Identity material.",
        }),
      ]),
    );
    // The row and its hint carry the critical treatment.
    expect(markup).toContain("spec-entry classify-row-secrets");
    expect(markup).toContain("spec-hint spec-hint-critical");
    expect(markup).toContain("Backup-eligible and never auto-excluded");
    expect(markup).toContain("Confirmed by operator");
    expect(markup).toContain("Identity material.");
    // Nothing frames the path as a mistake or tells the operator to drop it.
    expect(markup).not.toMatch(/should be excluded|must be excluded/i);
  });

  it("keeps an included cache path a quiet regenerable note", () => {
    const markup = render(
      spec([entry({ path: "~/.cache", classification: "cache", classificationSource: "manual" })]),
    );
    expect(markup).toContain("Regenerable");
    // The cache hint must not borrow the critical tone.
    expect(markup).toContain('<p class="spec-hint">');
    expect(markup).not.toContain("spec-hint spec-hint-critical");
    expect(markup).not.toContain("classify-row-secrets");
  });

  it("renders unknown as unknown instead of guessing a class", () => {
    const markup = render(spec([entry({ path: "~/uncommon" })]));
    expect(markup).toContain(">Unknown<");
    expect(markup).toContain("Not classified");
    expect(markup).toContain("Not classified</span>");
    // No other class badge is produced for it.
    expect(markup).not.toContain("classify-badge-cache");
    expect(markup).not.toContain("classify-badge-secrets");
  });

  it("shows the archive member mapping and the provenance of each entry", () => {
    const markup = render(
      spec([
        entry({
          path: "~/.config/nvim",
          classification: "portable_config",
          classificationSource: "suggested",
          confidence: 0.9,
          archivePath: "home/.config/nvim",
        }),
      ]),
    );
    expect(markup).toContain("home/.config/nvim");
    expect(markup).toContain("Suggested (high confidence) — not yet confirmed");
  });

  it("reports a missing archive mapping as missing, and only when asked", () => {
    const withMapping = render(spec([entry({ path: "~/x" })]));
    expect(withMapping).toContain("archive path not recorded");

    const withoutMapping = render(spec([entry({ path: "~/x" })]), { archiveMapping: "none" });
    expect(withoutMapping).not.toContain("archive path not recorded");
  });

  it("lists excludes verbatim and documents the missing classification", () => {
    const markup = render(spec([entry({ path: "~/.config/nvim" })], ["**/node_modules", "*.log"]));
    expect(markup).toContain("Configured excludes (2)");
    expect(markup).toContain("**/node_modules");
    expect(markup).toContain("*.log");
    expect(markup).toContain("the capture contract records no classification");
  });

  it("omits the excludes block entirely when the spec has none", () => {
    const markup = render(spec([entry({ path: "~/.config/nvim" })]));
    expect(markup).not.toContain("Configured excludes");
  });

  it("names the OS bucket on request and stays quiet otherwise", () => {
    const review = reviewCaptureSpec({
      paths: { linux: [entry({ path: "~/.config/nvim" })], macos: [entry({ path: "~/.config/nvim" })] },
      excludes: [],
      notes: null,
    });
    const tagged = renderToStaticMarkup(<CaptureSpecReview review={review} showOs />);
    expect(tagged).toContain(">Linux<");
    expect(tagged).toContain(">macOS<");
    const untagged = renderToStaticMarkup(<CaptureSpecReview review={review} />);
    expect(untagged).not.toContain(">Linux<");
  });

  it("uses the caller's empty text for a spec with no paths", () => {
    const markup = render(spec([]), { emptyText: "Nothing was captured." });
    expect(markup).toContain("Nothing was captured.");
  });

  it("renders a caller-supplied subtitle so the source spec is never implied", () => {
    const markup = render(spec([entry({ path: "~/x" })]), {
      title: "Captured paths",
      subtitle: "Frozen when this snapshot was uploaded.",
    });
    expect(markup).toContain("Captured paths");
    expect(markup).toContain("Frozen when this snapshot was uploaded.");
  });
});
