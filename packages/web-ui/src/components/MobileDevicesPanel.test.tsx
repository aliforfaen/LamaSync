// LAMA-296 finding 6: Admin "Android devices" panel rendering — SSR static
// markup of the presentational projection table (repo convention: no jsdom /
// @testing-library; bun:test + react-dom/server, see Confetti.test.tsx).
//
// Covers list rendering from the server projection (active + revoked rows,
// with the revoked reason and a Revoke action on active rows only), the
// loading skeleton, and the empty state. The revoke-call wiring + refresh
// and the pair→close→reload→revoke regression live in
// mobile-registrations.test.ts (DOM-free flow-helper tests).

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MobileRegistrationSummary } from "@lamasync/core";
import { MobileDevicesTable } from "./MobileDevicesPanel.tsx";

function reg(over: Partial<MobileRegistrationSummary> = {}): MobileRegistrationSummary {
  return {
    hostId: "host-pixel-9",
    displayName: "Pixel 9",
    clientType: "android",
    appVersion: "1.2.0",
    createdAt: 1_783_999_300_000,
    lastSeenAt: 1_784_000_000_000,
    revokedAt: null,
    revokedReason: null,
    ...over,
  };
}

function renderTable(
  rows: MobileRegistrationSummary[] | null,
  opts: { loading?: boolean; listError?: string | null; actionError?: string | null } = {},
): string {
  return renderToStaticMarkup(
    <MobileDevicesTable
      rows={rows}
      loading={opts.loading ?? rows === null}
      listError={opts.listError ?? null}
      actionError={opts.actionError ?? null}
      revokeBusy={false}
      onRevoke={() => undefined}
    />,
  );
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("MobileDevicesTable — projection row rendering", () => {
  it("renders an active row with device name, host id, app, and a Revoke action", () => {
    const html = renderTable([reg()]);
    expect(html).toContain("Pixel 9");
    expect(html).toContain("host-pixel-9");
    expect(html).toContain("android · version 1.2.0");
    expect(html).toContain("badge-success");
    expect(html).toContain("active");
    // Active rows get the destructive Revoke affordance.
    expect(html).toContain("Revoke");
  });

  it("renders a revoked row with its reason and NO Revoke action", () => {
    const html = renderTable([
      reg({
        hostId: "host-old-phone",
        displayName: "Old phone",
        appVersion: "1.0.0",
        revokedAt: 1_783_800_000_000,
        revokedReason: "Lost device",
      }),
    ]);
    expect(html).toContain("Old phone");
    expect(html).toContain("host-old-phone");
    expect(html).toContain("badge-failed");
    expect(html).toContain("revoked");
    // The recorded reason is visible for audit…
    expect(html).toContain("Lost device");
    // …but a revoked device cannot be revoked again from the row.
    expect(html).not.toContain("Revoke");
  });

  it("renders mixed active + revoked rows with exactly one Revoke action", () => {
    const html = renderTable([
      reg(),
      reg({
        hostId: "host-old-phone",
        displayName: "Old phone",
        revokedAt: 1_783_800_000_000,
        revokedReason: "Lost device",
      }),
    ]);
    expect(html).toContain("Pixel 9");
    expect(html).toContain("Old phone");
    expect(countOccurrences(html, "Revoke")).toBe(1);
    // Never renders secrets/grants — projection fields only.
    expect(html).not.toContain("nativeToken");
    expect(html).not.toContain("webGrant");
    expect(html).not.toContain("enrollmentId");
  });

  it("shows the empty state when no devices are paired yet", () => {
    const html = renderTable([]);
    expect(html).toContain("No Android devices paired yet");
    expect(html).not.toContain("Revoke");
  });

  it("shows a loading skeleton while the first projection read is pending", () => {
    const html = renderTable(null, { loading: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("skel-line");
  });

  it("surfaces a failed first read as an error banner plus guidance", () => {
    const html = renderTable(null, {
      loading: false,
      listError: "Failed to fetch",
    });
    expect(html).toContain("Failed to fetch");
    expect(html).toContain("Could not load paired devices");
  });

  it("shows a revocation error under the table without dropping rows", () => {
    const html = renderTable([reg()], {
      loading: false,
      actionError: "server rejected the revoke",
    });
    expect(html).toContain("Pixel 9");
    expect(html).toContain("server rejected the revoke");
  });
});
