// LAMA-296 finding 6: pure helpers for the Admin "Android devices" panel —
// the persistent paired-device listing with revoke. Kept free of React so
// the projection mapping and the load/revoke/refresh orchestration are
// unit-testable without a DOM (repo convention, see access-keys.ts).
//
// LAMA-337 adds the reconnect flow helper: the panel's per-device "Reconnect
// QR" action asks the server for a one-time enrollment targeted at that
// EXISTING registration. The QR itself is rendered by the enrollment modal
// from the returned response — nothing here handles a secret beyond passing
// the response through.
//
// The panel reads the admin-only projection GET /api/v1/mobile/registrations
// (bare MobileRegistrationSummary[] — most recent first, revoked rows
// included) and revokes through the existing POST
// /api/v1/mobile/registrations/:hostId/revoke. The projection deliberately
// carries no secret hashes, grants, or enrollment ids — this module never
// deals with any of those either.

import type {
  MobileEnrollmentCreateResponse,
  MobileRegistrationSummary,
  MobileUploadDestination,
} from "@lamasync/core";

/**
 * Audit reason recorded server-side on every revoke initiated from this
 * panel (matches the enrollment modal's own revoke copy so desktop revokes
 * share one provenance string).
 */
export const DEVICE_REVOKE_REASON = "Revoked from the desktop web UI";

export type MobileRegistrationStatus = "active" | "revoked";

/** Active unless the server stamped a revocation instant on the row. */
export function mobileRegistrationStatus(
  reg: { revokedAt: number | null },
): MobileRegistrationStatus {
  return reg.revokedAt !== null && reg.revokedAt > 0 ? "revoked" : "active";
}

/** Badge class name for a registration status cell. */
export function mobileRegistrationBadgeClass(
  status: MobileRegistrationStatus,
): string {
  return status === "revoked" ? "badge-failed" : "badge-success";
}

/** Human label for a registration status cell. */
export function mobileRegistrationLabel(status: MobileRegistrationStatus): string {
  return status === "revoked" ? "revoked" : "active";
}

/** The remote calls the panel needs. Injected so bun:test can script the
 *  exact production handlers without a DOM or a live server. */
export interface MobileDevicesServices {
  /** GET /api/v1/mobile/registrations — fresh projection rows. */
  list(): Promise<MobileRegistrationSummary[]>;
  /** POST /api/v1/mobile/registrations/:hostId/revoke. */
  revoke(hostId: string, reason: string): Promise<unknown>;
  /** POST /api/v1/mobile/registrations/:hostId/reconnect-enrollment (admin,
   *  LAMA-337) — one-time QR inputs targeted at the existing registration. */
  createReconnect(hostId: string): Promise<MobileEnrollmentCreateResponse>;
  /** GET /api/v1/mobile/registrations/:hostId/destinations (admin, stage 1). */
  listDestinations(hostId: string): Promise<MobileUploadDestination[]>;
  /** POST /api/v1/mobile/registrations/:hostId/destinations (admin, stage 1). */
  createDestination(hostId: string, label: string, slug?: string, folderId?: string | null): Promise<MobileUploadDestination>;
  /** POST /api/v1/mobile/registrations/:hostId/destinations/:id/revoke (admin, stage 1). */
  revokeDestination(hostId: string, id: string): Promise<unknown>;
  updateDestination?(hostId: string, id: string, folderId: string | null): Promise<MobileUploadDestination>;
}

/** Result of one flow step: fresh rows on success, human error text on
 *  failure (the component renders it inline). */
export interface MobileRegistrationsResult {
  rows: MobileRegistrationSummary[] | null;
  error: string | null;
}

/** Load the projection. Returns rows on success (possibly an empty list —
 *  the empty state is a valid list, not an error). */
export async function loadMobileRegistrations(
  services: Pick<MobileDevicesServices, "list">,
): Promise<MobileRegistrationsResult> {
  try {
    return { rows: await services.list(), error: null };
  } catch (err) {
    return {
      rows: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The panel's revoke action: revoke the registration whose row the admin
 * confirmed, then reload the projection so the fresh list renders (the row
 * flips to revoked without a manual refresh). Uses only the row's hostId —
 * no enrollment id or QR state is involved, which is what makes revoke work
 * long after the enrollment modal was closed or the page was reloaded.
 */
export async function revokeDeviceAndReload(
  services: MobileDevicesServices,
  hostId: string,
  reason: string,
): Promise<MobileRegistrationsResult> {
  try {
    await services.revoke(hostId, reason);
  } catch (err) {
    return {
      rows: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return loadMobileRegistrations(services);
}

// ---------------------------------------------------------------------------
// LAMA-337 — reconnect QR
// ---------------------------------------------------------------------------

/** The one call the reconnect flow needs (narrow, so the modal can inject it
 *  and bun:test can drive it without a DOM). */
export interface MobileReconnectServices {
  createReconnect(hostId: string): Promise<MobileEnrollmentCreateResponse>;
}

/** Result of one reconnect-QR request: the QR inputs on success, human error
 *  text on failure (the modal renders it inline and offers a retry). */
export interface MobileReconnectResult {
  enrollment: MobileEnrollmentCreateResponse | null;
  error: string | null;
}

/**
 * Ask for a reconnect QR for an existing device. A failure here changes
 * nothing on either side — the device keeps working with the credentials it
 * already has (that is the point of creating, not consuming, the QR).
 */
export async function startReconnectEnrollment(
  services: MobileReconnectServices,
  hostId: string,
): Promise<MobileReconnectResult> {
  try {
    return { enrollment: await services.createReconnect(hostId), error: null };
  } catch (err) {
    return {
      enrollment: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Stage 1 — per-device upload destinations (the authenticated desktop setup
// surface for the permitted mobile inbox). A registration has NO upload
// access until an operator creates a destination here; the phone's picker
// reads only its own active destinations. All paths are server-computed
// (Mobile/<hostId>/<slug>), so the label is the only free-form input.
// ---------------------------------------------------------------------------

/** Result of a destination step: fresh rows or human error text. */
export interface MobileDestinationsResult {
  destinations: MobileUploadDestination[] | null;
  error: string | null;
}

/** Load one registration's destinations (active + revoked for the admin UI). */
export async function loadDestinationsForDevice(
  services: Pick<MobileDevicesServices, "listDestinations">,
  hostId: string,
): Promise<MobileDestinationsResult> {
  try {
    return { destinations: await services.listDestinations(hostId), error: null };
  } catch (err) {
    return {
      destinations: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Create a labeled inbox for a device, then fetch the fresh destination list. */
export async function createDestinationAndReload(
  services: MobileDevicesServices,
  hostId: string,
  label: string,
  slug?: string,
  folderId?: string | null,
): Promise<MobileDestinationsResult> {
  try {
    await services.createDestination(hostId, label, slug, folderId);
  } catch (err) {
    return {
      destinations: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return loadDestinationsForDevice(services, hostId);
}

/** Revoke one destination (idempotent), then fetch the fresh list. */
export async function revokeDestinationAndReload(
  services: MobileDevicesServices,
  hostId: string,
  id: string,
): Promise<MobileDestinationsResult> {
  try {
    await services.revokeDestination(hostId, id);
  } catch (err) {
    return {
      destinations: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return loadDestinationsForDevice(services, hostId);
}

export async function updateDestinationAndReload(
  services: MobileDevicesServices,
  hostId: string,
  id: string,
  folderId: string | null,
): Promise<MobileDestinationsResult> {
  if (!services.updateDestination) {
    return { destinations: null, error: "Destination editing is unavailable" };
  }
  try {
    await services.updateDestination(hostId, id, folderId);
  } catch (err) {
    return { destinations: null, error: err instanceof Error ? err.message : String(err) };
  }
  return loadDestinationsForDevice(services, hostId);
}
