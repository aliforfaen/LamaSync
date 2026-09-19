// LAMA-345 follow-up — the Dashboard fleet-health summary.
//
// One card that answers "does anything need me right now?" without repeating
// the dashboard's existing device/folder/operation counts. The heavy lifting is
// server-side (`@lamasync/core/fleet-health` via `GET /health`), so this
// component is presentational: buckets, plain language, links and an optional
// technical-details disclosure.

import { Link } from "react-router-dom";
import type { FleetHealthSummary } from "@lamasync/core/fleet-health";
import { FLEET_HEALTH_SECTION_ID } from "../scroll-to-section.ts";
import {
  bucketPlain,
  bucketTitle,
  bucketTone,
  generatedAgo,
  healthySentence,
  itemKindLabel,
  itemTechnicalDetail,
  summaryAriaLabel,
  truncatedCaption,
  visibleBuckets,
} from "../fleet-health.ts";

export interface FleetHealthSummaryProps {
  summary: FleetHealthSummary;
  /** Test seam for the "generated N ago" caption. */
  now?: number;
  /** Optional: the card is rendered without its own heading inside a section. */
  headingLevel?: 2 | 3;
}

export function FleetHealthSummaryCard({
  summary,
  now,
  headingLevel = 2,
}: FleetHealthSummaryProps) {
  const buckets = visibleBuckets(summary);
  const healthy = healthySentence(summary);
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    // `id` + `tabIndex={-1}` make this a focusable landmark. The Dashboard's
    // "needs attention" row is a button that scrolls and focuses it — a
    // fragment link would not work under HashRouter. Focus lands here and the
    // accessible name comes from the heading below.
    <section
      id={FLEET_HEALTH_SECTION_ID}
      tabIndex={-1}
      className="section fleet-health-summary"
      aria-labelledby="fleet-health-heading"
    >
      <div className="section-head">
        <Heading id="fleet-health-heading">Fleet health</Heading>
        <span className="muted fleet-health-generated">
          checked {generatedAgo(summary.generatedAt, now)}
        </span>
      </div>

      <p className="fleet-health-headline" role="status" aria-live="polite">
        {summary.headline}
      </p>
      <p className="visually-hidden">{summaryAriaLabel(summary)}</p>

      {buckets.length === 0 ? (
        <p className="muted">
          {healthy ? `${healthy}. Nothing needs attention.` : "Nothing is set up yet."}
        </p>
      ) : (
        <ul className="fleet-health-buckets">
          {buckets.map((key) => {
            const bucket = summary.buckets[key];
            const tone = bucketTone(key);
            const more = truncatedCaption(bucket);
            return (
              <li key={key} className={`fleet-health-bucket fleet-health-bucket--${tone}`}>
                <div className="fleet-health-bucket-head">
                  <span className={`badge folder-health-state--${tone}`}>{bucketTitle(key)}</span>
                  <span className="fleet-health-bucket-count">{bucket.total}</span>
                </div>
                <p className="muted fleet-health-bucket-plain">{bucketPlain(key)}</p>
                <ul className="fleet-health-items">
                  {bucket.items.map((item) => (
                    <li key={`${item.kind}-${item.id}`} className="fleet-health-item">
                      <Link to={item.href} className="fleet-health-item-link">
                        <span className="fleet-health-item-kind">{itemKindLabel(item)}</span>
                        <span className="fleet-health-item-title">{item.title}</span>
                      </Link>
                      <span className="muted fleet-health-item-detail">{item.detail}</span>
                      <details className="folder-health-technical">
                        <summary>Technical details</summary>
                        <ul>
                          {itemTechnicalDetail(item).map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                      </details>
                    </li>
                  ))}
                </ul>
                {more ? <p className="muted fleet-health-more">{more}</p> : null}
              </li>
            );
          })}
        </ul>
      )}

      {healthy ? <p className="fleet-health-healthy">{healthy}</p> : null}

      <details className="folder-health-technical fleet-health-rules">
        <summary>What counts as urgent?</summary>
        <ul>
          <li>
            Red means data risk (an unusable or unverifiable sync record) or an
            always-on machine (server or NAS) that is genuinely missing.
          </li>
          <li>
            A laptop, phone, tablet or desktop being offline is normal, so it is
            never shown as urgent on its own.
          </li>
          <li>
            &ldquo;Not heard from&rdquo; means no recent report — that is not the
            same as broken, and LamaSync does not guess.
          </li>
          <li>
            An update is only reported when the device checked in at or after the
            release was published and still reports an older version.
          </li>
        </ul>
      </details>
    </section>
  );
}
