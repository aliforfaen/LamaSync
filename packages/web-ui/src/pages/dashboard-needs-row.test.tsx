// LAMA-345 follow-up — the Dashboard's in-page urgent row.
//
// Regression this guards: that row used to be a router Link to
// `/#fleet-health-heading`. Under HashRouter the href became
// `/#/#fleet-health-heading` and the route changed instead of scrolling, so the
// Fleet health heading stayed ~600px below the viewport. The row must stay a
// real button (no navigation) and the Fleet health section must stay a
// focusable landmark that the button targets.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsRowScrollAction } from "./Dashboard.tsx";
import { FLEET_HEALTH_SECTION_ID } from "../scroll-to-section.ts";
import { FleetHealthSummaryCard } from "../components/FleetHealthSummary.tsx";
import { MemoryRouter } from "react-router-dom";
import type { FleetHealthSummary } from "@lamasync/core/fleet-health";

function emptySummary(): FleetHealthSummary {
  return {
    generatedAt: Date.now(),
    headline: "Everything LamaSync manages looks healthy.",
    buckets: {
      needsIntervention: { total: 0, items: [], truncated: 0 },
      checkWhenOnline: { total: 0, items: [], truncated: 0 },
      healthy: { total: 0, items: [], truncated: 0 },
      unknownOrStale: { total: 0, items: [], truncated: 0 },
    },
    healthy: { folders: 1, hosts: 1 },
    updatesActionable: 0,
    updatesNotEvaluated: 0,
  };
}

describe("Dashboard urgent row → Fleet health", () => {
  test("renders a button, never a link or an href", () => {
    const html = renderToStaticMarkup(
      <NeedsRowScrollAction
        tone="critical"
        label="2 folders or devices needing attention"
        detail="Folder health and missing always-on machines — see Fleet health below."
        targetId={FLEET_HEALTH_SECTION_ID}
      />,
    );
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    // The old bug in one assertion: no anchor and no fragment href.
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href");
    expect(html).not.toContain("#fleet-health-heading");
  });

  test("keeps the established row styling and its accessible name", () => {
    const html = renderToStaticMarkup(
      <NeedsRowScrollAction
        tone="critical"
        label="2 folders or devices needing attention"
        detail="Folder health and missing always-on machines — see Fleet health below."
        targetId={FLEET_HEALTH_SECTION_ID}
      />,
    );
    expect(html).toContain("needs-row needs-row--critical needs-row--action");
    expect(html).toContain("<strong>2 folders or devices needing attention</strong>");
    expect(html).toContain("see Fleet health below");
    // The decorative mark and arrow stay out of the accessible name.
    expect(html).toContain('aria-hidden="true"');
  });

  test("the Fleet health section is a focusable, labelled target", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FleetHealthSummaryCard summary={emptySummary()} now={Date.now()} />
      </MemoryRouter>,
    );
    expect(html).toContain(`id="${FLEET_HEALTH_SECTION_ID}"`);
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-labelledby="fleet-health-heading"');
    expect(html).toContain('id="fleet-health-heading"');
  });
});
