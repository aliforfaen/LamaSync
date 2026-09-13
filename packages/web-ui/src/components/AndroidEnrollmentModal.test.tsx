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
import type { MobilePairedHostSummary } from "@lamasync/core";
import {
  EnrollmentNotice,
  EnrollmentOutcomeNotice,
  enrollmentCardState,
  enrollmentModalTitle,
  enrollmentOutcomeCopy,
} from "./AndroidEnrollmentModal.tsx";

function renderNotice(reconnect: { hostId: string; displayName: string } | null): string {
  return renderToStaticMarkup(<EnrollmentNotice reconnect={reconnect} />);
}

function host(over: Partial<MobilePairedHostSummary> = {}): MobilePairedHostSummary {
  return {
    hostId: "host-pixel-9",
    displayName: "Pixel 9",
    clientType: "android",
    appVersion: "2.0.0",
    createdAt: 1_784_000_000_000,
    lastSeenAt: 1_784_000_100_000,
    revokedAt: null,
    ...over,
  };
}

const RECONNECT = { hostId: "host-pixel-9", displayName: "Pixel 9" };

function renderOutcome(
  state: ReturnType<typeof enrollmentCardState>,
  reconnect: { hostId: string; displayName: string } | null,
  h: MobilePairedHostSummary | null,
): string {
  return renderToStaticMarkup(
    <EnrollmentOutcomeNotice state={state} reconnect={reconnect} host={h} />,
  );
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

// ---------------------------------------------------------------------------
// LAMA-337 review: enrollment lifecycle vs DEVICE access
// ---------------------------------------------------------------------------
describe("enrollmentCardState — QR outcomes never mean lost access", () => {
  it("a pending QR is pending until it locally expires", () => {
    expect(enrollmentCardState({ status: "pending", expiredLocally: false, host: null })).toBe(
      "pending",
    );
    expect(enrollmentCardState({ status: "pending", expiredLocally: true, host: null })).toBe(
      "qr-expired",
    );
  });

  it("an expired enrollment is a QR outcome, whatever the device is doing", () => {
    expect(enrollmentCardState({ status: "expired", expiredLocally: false, host: null })).toBe(
      "qr-expired",
    );
    // Even for a reconnect QR whose device is live (host is null while pending
    // or expired, but the classification must not depend on that).
    expect(enrollmentCardState({ status: "expired", expiredLocally: false, host: host() })).toBe(
      "qr-expired",
    );
  });

  it("a used enrollment is paired only while the registration is live", () => {
    expect(enrollmentCardState({ status: "used", expiredLocally: false, host: host() })).toBe(
      "paired",
    );
    // The device was revoked after it paired: that IS lost access.
    expect(
      enrollmentCardState({
        status: "used",
        expiredLocally: false,
        host: host({ revokedAt: 1_784_000_200_000 }),
      }),
    ).toBe("device-revoked");
    // …and so is a used enrollment whose registration no longer exists.
    expect(enrollmentCardState({ status: "used", expiredLocally: false, host: null })).toBe(
      "device-revoked",
    );
  });

  it("a revoked ENROLLMENT with a live device is superseded, not revoked access", () => {
    expect(enrollmentCardState({ status: "revoked", expiredLocally: false, host: host() })).toBe(
      "qr-superseded",
    );
    expect(enrollmentCardState({ status: "revoked", expiredLocally: false, host: null })).toBe(
      "qr-superseded",
    );
    // …unless the device itself was revoked (a device revoke also revokes the
    // enrollment rows it produced).
    expect(
      enrollmentCardState({
        status: "revoked",
        expiredLocally: false,
        host: host({ revokedAt: 1_784_000_200_000 }),
      }),
    ).toBe("device-revoked");
  });
});

describe("terminal card copy — reconnect", () => {
  it("an expired reconnect QR says the device is unchanged", () => {
    const state = enrollmentCardState({ status: "expired", expiredLocally: false, host: null });
    const html = renderOutcome(state, RECONNECT, null);
    expect(html).toContain("This QR expired before a phone scanned it");
    expect(html).toContain("The device is unchanged and still works");
    // The old bug: QR outcomes were rendered as revoked access.
    expect(html).not.toContain("Access revoked");
    expect(html).not.toContain("can no longer sign in");
    expect(enrollmentOutcomeCopy(state, true)).toContain("keeps signing in with its current credentials");
    expect(enrollmentOutcomeCopy(state, true)).not.toContain("re-pair");
  });
  it("a superseded reconnect QR (newer QR shown) says the device is unchanged", () => {
    const state = enrollmentCardState({ status: "revoked", expiredLocally: false, host: host() });
    const html = renderOutcome(state, RECONNECT, host());
    expect(html).toContain("This QR is no longer valid");
    expect(html).toContain("The device is unchanged and still works");
    expect(html).not.toContain("Access revoked");
    expect(html).not.toContain("can no longer sign in");
    expect(enrollmentOutcomeCopy(state, true)).toContain("replaced by a newer one");
  });

  it("only a revoked registration is reported as revoked access", () => {
    const state = enrollmentCardState({
      status: "used",
      expiredLocally: false,
      host: host({ revokedAt: 1_784_000_200_000 }),
    });
    const html = renderOutcome(state, RECONNECT, host({ revokedAt: 1_784_000_200_000 }));
    expect(html).toContain("Access revoked");
    expect(html).toContain("Pixel 9");
    expect(html).toContain("can no longer sign in");
    // Reconnect is not offered for a revoked device; the copy says what to do.
    expect(enrollmentOutcomeCopy(state, true)).toContain("pair it again with a fresh pairing QR");
  });

  it("a paired card never renders a terminal notice", () => {
    expect(renderOutcome("paired", RECONNECT, host())).toBe("");
    expect(renderOutcome("pending", RECONNECT, null)).toBe("");
  });
});

describe("terminal card copy — pairing (audited for the same conflation)", () => {
  it("an expired pairing QR never claims revoked access", () => {
    const state = enrollmentCardState({ status: "expired", expiredLocally: false, host: null });
    const html = renderOutcome(state, null, null);
    expect(html).toContain("This QR expired before a phone scanned it");
    expect(html).toContain("No device was paired");
    expect(html).not.toContain("Access revoked");
    expect(html).not.toContain("can no longer sign in");
    expect(enrollmentOutcomeCopy(state, false)).toContain("No device was paired");
  });

  it("a superseded pairing QR never claims revoked access", () => {
    const state = enrollmentCardState({ status: "revoked", expiredLocally: false, host: null });
    const html = renderOutcome(state, null, null);
    expect(html).toContain("This QR is no longer valid");
    expect(html).not.toContain("Access revoked");
    expect(enrollmentOutcomeCopy(state, false)).toContain("show the newest QR instead");
  });

  it("a revoked registration still reads as revoked access", () => {
    const revokedHost = host({ revokedAt: 1_784_000_200_000 });
    const state = enrollmentCardState({
      status: "used",
      expiredLocally: false,
      host: revokedHost,
    });
    const html = renderOutcome(state, null, revokedHost);
    expect(html).toContain("Access revoked");
    expect(html).toContain("can no longer sign in");
    expect(enrollmentOutcomeCopy(state, false)).toContain("Pair the device again with a fresh QR");
  });
});
