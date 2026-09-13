// LAMA-337: Android-enrollment modal copy, per mode — SSR static markup of the
// presentational notice/title (repo convention: no jsdom; bun:test +
// react-dom/server, see MobileDevicesPanel.test.tsx).
//
// The QR payload, countdown and status labels are shared with the pairing flow
// and covered in pairing.test.ts; what differs by mode is the copy an operator
// reads before scanning, which is what this file pins: a reconnect QR rotates
// the credentials of the device that already holds them, keeps its identity,
// and is inert until scanned.
//
// The create/poll orchestration (startReconnectEnrollment) is covered
// DOM-free in mobile-registrations.test.ts, and the wire shape of the
// reconnect route in api-auth.test.ts.

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EnrollmentNotice, enrollmentModalTitle } from "./AndroidEnrollmentModal.tsx";

function renderNotice(reconnect: { hostId: string; displayName: string } | null): string {
  return renderToStaticMarkup(<EnrollmentNotice reconnect={reconnect} />);
}

describe("AndroidEnrollmentModal — reconnect mode copy", () => {
  it("titles the card by mode", () => {
    expect(enrollmentModalTitle(null)).toBe("Add Android device");
    expect(
      enrollmentModalTitle({ hostId: "host-pixel-9", displayName: "Pixel 9" }),
    ).toBe("Reconnect Android device");
  });

  it("says a reconnect QR rotates credentials, keeps identity, and is inert", () => {
    const html = renderNotice({ hostId: "host-pixel-9", displayName: "Pixel 9" });
    // React escapes the apostrophe in “device’s” as &#x27; in static markup.
    expect(html).toContain("Scanning rotates this device&#x27;s credentials");
    // The device it belongs to is named, with its stable host id.
    expect(html).toContain("Pixel 9");
    expect(html).toContain("host-pixel-9");
    expect(html).toContain("keeps its device id");
    expect(html).toContain("upload inboxes");
    expect(html).toContain("upload history");
    expect(html).toContain("previous session is signed out");
    // Creating the QR changes nothing, and it grants nothing new.
    expect(html).toContain("Nothing happens until a phone scans this QR");
    expect(html).toContain("letting it expire changes nothing");
    expect(html).toContain("Its authority is unchanged");
    // Never the pairing claim: the device already has that authority.
    expect(html).not.toContain("FULL web administration");
    // No secret material can appear here — the notice only takes identity.
    expect(html).not.toContain("secret");
    expect(html).not.toContain("nativeToken");
    expect(html).not.toContain("webGrant");
  });

  it("keeps the pairing warning for a new installation", () => {
    const html = renderNotice(null);
    expect(html).toContain("Scanning grants FULL web administration");
    expect(html).toContain("separate native identity");
    expect(html).toContain("Only scan this QR from the phone you are pairing");
    // No reconnect wording leaks into the pairing flow.
    expect(html).not.toContain("rotates this device's credentials");
    expect(html).not.toContain("Nothing happens until a phone scans");
  });
});
