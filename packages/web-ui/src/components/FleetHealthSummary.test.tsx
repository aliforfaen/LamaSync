// LAMA-345 follow-up — the Dashboard fleet-health card, pinned by static
// markup (repo convention: bun:test + react-dom/server, no jsdom).

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { FleetHealthSummary } from "@lamasync/core/fleet-health";
import { FleetHealthSummaryCard } from "./FleetHealthSummary.tsx";

function item(over: Partial<FleetHealthSummary["buckets"]["needsIntervention"]["items"][number]> = {}) {
  return {
    kind: "folder" as const,
    id: "f1",
    hostId: "dev-vm",
    hostName: "dev-vm",
    title: "Projects on dev-vm",
    detail: "The ignore set changed.",
    tone: "danger" as const,
    href: "/folders?folder=f1&host=dev-vm",
    action: "resync",
    ...over,
  };
}

function summary(over: Partial<FleetHealthSummary> = {}): FleetHealthSummary {
  const base: FleetHealthSummary = {
    generatedAt: Date.now() - 30_000,
    headline: "One thing needs your attention now.",
    buckets: {
      needsIntervention: { total: 1, items: [item()], truncated: 0 },
      checkWhenOnline: { total: 0, items: [], truncated: 0 },
      healthy: { total: 0, items: [], truncated: 0 },
      unknownOrStale: { total: 0, items: [], truncated: 0 },
    },
    healthy: { folders: 3, hosts: 2 },
    updatesActionable: 0,
    updatesNotEvaluated: 1,
  };
  return { ...base, ...over };
}

function render(s: FleetHealthSummary): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <FleetHealthSummaryCard summary={s} now={Date.now()} />
    </MemoryRouter>,
  );
}

describe("FleetHealthSummaryCard", () => {
  test("shows the server's verdict and every populated bucket", () => {
    const html = render(
      summary({
        buckets: {
          needsIntervention: { total: 1, items: [item()], truncated: 0 },
          checkWhenOnline: {
            total: 2,
            items: [item({ kind: "host", id: "lap", title: "laptop", tone: "info", detail: "This device sleeps by design; nothing to do while it is away.", href: "/hosts/lap", action: null })],
            truncated: 1,
          },
          healthy: { total: 0, items: [], truncated: 0 },
          unknownOrStale: { total: 1, items: [item({ kind: "host", id: "ghost", title: "ghost", detail: "Registered but has never reported in.", href: "/hosts/ghost", tone: "info", action: null })], truncated: 0 },
        },
      }),
    );
    expect(html).toContain("Fleet health");
    expect(html).toContain("One thing needs your attention now.");
    expect(html).toContain("Needs attention now");
    expect(html).toContain("Check when next online");
    expect(html).toContain("Not heard from");
    expect(html).toContain("Projects on dev-vm");
    expect(html).toContain("The ignore set changed.");
    expect(html).toContain("and 1 more");
    expect(html).toContain("3 folders and 2 devices healthy");
  });

  test("healthy counts read as one calm line, never a list of rows", () => {
    const html = render(
      summary({
        headline: "Everything LamaSync manages looks healthy.",
        healthy: { folders: 5, hosts: 2 },
        buckets: {
          needsIntervention: { total: 0, items: [], truncated: 0 },
          checkWhenOnline: { total: 0, items: [], truncated: 0 },
          healthy: { total: 5, items: [], truncated: 0 },
          unknownOrStale: { total: 0, items: [], truncated: 0 },
        },
      }),
    );
    expect(html).toContain("5 folders and 2 devices healthy. Nothing needs attention.");
    expect(html).not.toContain("Needs attention now");
    expect(html).not.toContain("fleet-health-items");
  });

  test("an empty fleet says so instead of rendering an empty list", () => {
    const html = render(
      summary({
        headline: "Nothing is set up yet.",
        buckets: {
          needsIntervention: { total: 0, items: [], truncated: 0 },
          checkWhenOnline: { total: 0, items: [], truncated: 0 },
          healthy: { total: 0, items: [], truncated: 0 },
          unknownOrStale: { total: 0, items: [], truncated: 0 },
        },
        healthy: { folders: 0, hosts: 0 },
      }),
    );
    expect(html).toContain("Nothing is set up yet.");
  });

  test("every item links somewhere and explains its own source", () => {
    const html = render(summary());
    expect(html).toContain('href="/folders?folder=f1&amp;host=dev-vm"');
    expect(html).toContain("Technical details");
    expect(html).toContain("Link: /folders");
  });

  test("the urgent rule is disclosed in plain language", () => {
    const html = render(summary());
    expect(html).toContain("What counts as urgent?");
    expect(html).toContain("always-on machine (server or NAS) that is genuinely missing");
    expect(html).toContain("never shown as urgent on its own");
    expect(html).toContain("not the same as broken");
    expect(html).toContain("checked in at or after the release was published");
  });

  test("the verdict is announced politely and the counts are read out", () => {
    const html = render(
      summary({
        buckets: {
          needsIntervention: { total: 1, items: [item()], truncated: 0 },
          checkWhenOnline: { total: 2, items: [], truncated: 0 },
          healthy: { total: 5, items: [], truncated: 0 },
          unknownOrStale: { total: 3, items: [], truncated: 0 },
        },
        healthy: { folders: 5, hosts: 2 },
      }),
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-labelledby="fleet-health-heading"');
    expect(html).toContain(
      "Fleet health: 1 needing attention now, 2 to check when next online, 3 not heard from, 5 folders and 2 devices healthy.",
    );
  });

  test("a stale-derived summary still shows when it was derived", () => {
    const html = render(summary({ generatedAt: Date.now() - 3 * 3_600_000 }));
    expect(html).toContain("checked 3 h ago");
  });
});
