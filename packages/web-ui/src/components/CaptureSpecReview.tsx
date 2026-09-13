// LAMA-315 stage 2 — read-only renderer for the classification facts a
// capture spec carries.
//
// Purely presentational: it renders a review built by
// `../app-classification.ts` and never reads a template, protection or
// snapshot itself, so the caller always decides which spec owns the facts.
// Nothing here changes capture, exclusion, restore or daemon behavior.

import {
  EXCLUDES_CLASSIFICATION_GAP,
  reviewCountsSentence,
  type CaptureSpecReview as CaptureSpecReviewModel,
} from "../app-classification.ts";

export interface CaptureSpecReviewProps {
  review: CaptureSpecReviewModel;
  /** Heading; omit when the surrounding surface already states it. */
  title?: string;
  /** Where this spec came from — the provenance of the *review*, e.g.
   *  "Frozen at enrollment; later template edits never change it." */
  subtitle?: string;
  /** Rendered instead of the groups when the spec declares no paths. */
  emptyText?: string;
  /** Tag each entry with its OS bucket (useful for a cross-OS template). */
  showOs?: boolean;
  /** Render the archive-member mapping. Only a snapshot spec carries one by
   *  contract, so template/enrollment reviews leave this off rather than
   *  printing an empty value for every path. */
  archiveMapping?: "full" | "none";
}

const OS_LABEL: Record<string, string> = {
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
};

export function CaptureSpecReview({
  review,
  title,
  subtitle,
  emptyText,
  showOs = false,
  archiveMapping = "none",
}: CaptureSpecReviewProps) {
  return (
    <div className="spec-review">
      {title ? <h4 className="spec-review-title">{title}</h4> : null}
      {subtitle ? <p className="muted spec-review-subtitle">{subtitle}</p> : null}
      {review.totalPaths === 0 ? (
        <p className="muted">{emptyText ?? "No paths recorded in this spec."}</p>
      ) : (
        <>
          <p className="muted spec-review-counts">{reviewCountsSentence(review)}</p>
          {review.groups.map((group) => (
            <div className="spec-group" key={group.classification}>
              <div className="spec-group-head">
                <span className={`badge classify-badge classify-badge-${group.classification}`}>
                  {group.label}
                </span>
                <span className="muted">
                  {group.entries.length} path{group.entries.length === 1 ? "" : "s"}
                </span>
              </div>
              {/* The hint tone carries the weight: `secrets` is the one
                  conspicuous class, while an included cache path stays a
                  quiet note and never reads as an error. */}
              <p className={group.hintTone === "critical" ? "spec-hint spec-hint-critical" : "spec-hint"}>
                {group.hint}
              </p>
              <ul className="spec-entry-list">
                {group.entries.map((entry) => (
                  <li
                    className={entry.classification === "secrets" ? "spec-entry classify-row-secrets" : "spec-entry"}
                    key={`${entry.os}:${entry.path}`}
                  >
                    <code className="classify-path">{entry.path}</code>
                    <div className="classify-meta">
                      {showOs ? <span className="badge spec-os-badge">{OS_LABEL[entry.os] ?? entry.os}</span> : null}
                      <span className="muted spec-provenance">{entry.provenanceLabel}</span>
                      {archiveMapping === "full" ? (
                        entry.archivePath !== null ? (
                          <span className="muted spec-archive">
                            → <code>{entry.archivePath}</code>
                          </span>
                        ) : (
                          <span className="muted spec-archive">archive path not recorded</span>
                        )
                      ) : null}
                      {entry.rationale ? (
                        <span className="muted classify-rationale">{entry.rationale}</span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
      {review.excludes.length > 0 ? (
        <div className="spec-excludes">
          <strong>
            Configured excludes ({review.excludes.length})
          </strong>
          <ul className="spec-entry-list">
            {review.excludes.map((pattern) => (
              <li className="spec-entry" key={pattern}>
                <code className="classify-path">{pattern}</code>
              </li>
            ))}
          </ul>
          <p className="muted spec-excludes-gap">{EXCLUDES_CLASSIFICATION_GAP}</p>
        </div>
      ) : null}
    </div>
  );
}
