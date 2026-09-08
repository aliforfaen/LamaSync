// LAMA-296 stage 1: scoped mobile upload routes (native bearer + admin).
// Native surface (mobile principal, confined to this + identity/check-in by
// the auth boundary in auth.ts):
//   GET  /api/v1/mobile/destinations            — own active destinations
//   POST /api/v1/mobile/uploads                 — create (idempotency-keyed)
//   PUT  /api/v1/mobile/uploads/:id/chunks      — raw bounded chunk at offset
//   GET  /api/v1/mobile/uploads                 — own history
//   GET  /api/v1/mobile/uploads/:id             — durable state (resume)
//   POST /api/v1/mobile/uploads/:id/finalize    — verify + atomic publish
//   POST /api/v1/mobile/uploads/:id/cancel      — abort before publication
// Admin surface (admin bearer / admin cookie web session):
//   GET  /api/v1/mobile/registrations/:hostId/destinations
//   POST /api/v1/mobile/registrations/:hostId/destinations
//   POST /api/v1/mobile/registrations/:hostId/destinations/:id/revoke
//
// Status codes: 200 ok · 201 created · 400 bad request · 401 revoked/missing
// authority · 403 wrong authority · 404 unknown · 409 conflict (offset,
// collision, busy, stale) · 410 destination revoked · 413 oversized chunk ·
// 422 declared-checksum mismatch · 507 staging full · 500 disk/server error.
// Request bodies carry only destination ids + validated file names — never
// paths, roots, backend credentials, or another host's inbox.

import { Elysia, t } from "elysia";
import { principalOf, requireAdmin } from "../auth.ts";
import {
  appendMobileUploadChunk,
  cancelMobileUpload,
  createMobileUpload,
  createMobileUploadDestination,
  findUploadById,
  finalizeMobileUpload,
  isHexSha256,
  isSafeSegment,
  listDestinationsForRegistration,
  listUploadsForRegistration,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  mobileChunkSizeBytes,
  revokeMobileUploadDestination,
  rowToUpload,
  type ChunkOutcome,
  type MobileUploadRow,
} from "../mobile-uploads.ts";
import { findRegistrationByHostId } from "../mobile-store.ts";
import type { AuthPrincipal, MobileUpload } from "@lamasync/core";

// ---- payload bounds ------------------------------------------------------

const MAX_FILENAME_LENGTH = 200;

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/** True when the principal is a live mobile native principal. */
function isMobileNative(
  principal: AuthPrincipal | null,
): principal is { kind: "mobile"; hostId: string } {
  return principal !== null && principal.kind === "mobile";
}

/** Defensive live-registration re-check (the boundary already resolved the
 *  token; this catches a revocation that landed between resolution and the
 *  handler body). */
function registrationIsLive(hostId: string): boolean {
  const row = findRegistrationByHostId(hostId);
  return row !== null && (row.revoked_at === null || row.revoked_at === 0);
}

class ChunkTooLargeError extends Error {}

/**
 * Read a raw request body into memory with a hard bound. The bound is the
 * negotiated chunk size + 1 so an oversize chunk fails fast without the whole
 * (potentially unbounded) body ever being buffered.
 */
async function readRawBodyBounded(request: Request, maxBytes: number): Promise<Uint8Array> {
  const body = request.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ChunkTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseOffset(header: string | null): number | null {
  if (header === null) return null;
  if (!/^\d{1,15}$/.test(header)) return null;
  const parsed = Number.parseInt(header, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Own-upload access check: returns the row when the mobile principal owns
 *  it and its registration is live, else null (mapped to 404/403/401). */
function ownUpload(principal: { kind: "mobile"; hostId: string }, id: string): MobileUploadRow | null {
  if (!registrationIsLive(principal.hostId)) return null;
  const row = findUploadById(id);
  if (!row) return null;
  if (row.registration_id !== principal.hostId) return null;
  return row;
}

// ---- route plugin --------------------------------------------------------

export const mobileUploadRoutes = new Elysia({ prefix: "/api/v1" })
  // -----------------------------------------------------------------------
  // Native: own authorized destinations (the app's destination picker)
  // -----------------------------------------------------------------------
  .get(
    "/mobile/destinations",
    ({ request, set }) => {
      const principal = principalOf(request);
      if (!isMobileNative(principal)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (!registrationIsLive(principal.hostId)) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      set.headers["cache-control"] = "no-store";
      return { destinations: listDestinationsForRegistration(principal.hostId, false) };
    },
    {
      detail: {
        summary:
          "List the caller's authorized upload destinations (mobile native bearer). Active destinations only — an empty list means an operator has not assigned an inbox to this device yet.",
        tags: ["Mobile"],
        responses: {
          200: { description: "{ destinations: MobileUploadDestination[] }" },
          401: { description: "Missing/invalid/revoked native token" },
          403: { description: "Not a mobile native credential" },
        },
      },
    },
  )
  // -----------------------------------------------------------------------
  // Admin: destination setup for existing paired devices
  // -----------------------------------------------------------------------
  .get(
    "/mobile/registrations/:hostId/destinations",
    ({ request, params, set }) => {
      const admin = requireAdmin({ principal: principalOf(request) });
      if (!admin) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (!findRegistrationByHostId(params.hostId)) {
        set.status = 404;
        return { error: "mobile registration not found" };
      }
      set.headers["cache-control"] = "no-store";
      return { destinations: listDestinationsForRegistration(params.hostId, true) };
    },
    {
      params: t.Object({ hostId: t.String() }),
      detail: {
        summary:
          "List one registration's upload destinations, active + revoked (admin). No secrets.",
        tags: ["Mobile"],
        responses: {
          200: { description: "{ destinations: MobileUploadDestination[] }" },
          401: { description: "Unauthorized" },
          403: { description: "Not an admin credential" },
          404: { description: "Unknown registration" },
        },
      },
    },
  )
  .post(
    "/mobile/registrations/:hostId/destinations",
    ({ request, params, body, set }) => {
      const admin = requireAdmin({ principal: principalOf(request) });
      if (!admin) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (!findRegistrationByHostId(params.hostId)) {
        set.status = 404;
        return { error: "mobile registration not found" };
      }
      const label = boundedString(body.label, 64);
      if (label === null) {
        set.status = 400;
        return { error: "invalid label" };
      }
      let slug: string | null = null;
      if (body.slug !== undefined && body.slug !== null) {
        // Explicit slugs are deliberately strict: single neutral segment
        // (letters/digits/dot/dash/underscore) — never spaces or unicode.
        if (typeof body.slug !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(body.slug)) {
          set.status = 400;
          return { error: "invalid slug" };
        }
        slug = body.slug;
      }
      const outcome = createMobileUploadDestination({
        registrationId: params.hostId,
        label,
        slug,
      });
      switch (outcome.kind) {
        case "ok":
          set.status = 201;
          return { destination: outcome.destination };
        case "invalid_label":
        case "invalid_slug":
          set.status = 400;
          return { error: "invalid destination" };
        case "duplicate":
          set.status = 409;
          return { error: "a destination already exists at that path" };
        case "unknown_registration":
          set.status = 404;
          return { error: "mobile registration not found" };
      }
    },
    {
      params: t.Object({ hostId: t.String() }),
      body: t.Object({
        label: t.String(),
        slug: t.Optional(t.String()),
      }),
      detail: {
        summary:
          "Create an upload destination (inbox) for one registration (admin). The path is always server-computed `Mobile/<hostId>/<slug>`; request bodies can never select arbitrary roots or another host's inbox.",
        tags: ["Mobile"],
        responses: {
          201: { description: "{ destination }" },
          400: { description: "Invalid label/slug" },
          401: { description: "Unauthorized" },
          403: { description: "Not an admin credential" },
          404: { description: "Unknown registration" },
          409: { description: "Duplicate path" },
        },
      },
    },
  )
  .post(
    "/mobile/registrations/:hostId/destinations/:id/revoke",
    ({ request, params, set }) => {
      const admin = requireAdmin({ principal: principalOf(request) });
      if (!admin) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const outcome = revokeMobileUploadDestination(params.hostId, params.id);
      if (outcome.kind === "not_found") {
        set.status = 404;
        return { error: "destination not found" };
      }
      set.status = 200;
      return { id: outcome.id, revokedAt: outcome.revokedAt };
    },
    {
      params: t.Object({ hostId: t.String(), id: t.String() }),
      detail: {
        summary:
          "Revoke an upload destination (admin). Idempotent; in-flight uploads fail at finalize after revocation. The destination must belong to the nested hostId registration — a mismatched parent is a 404, never another device's inbox.",
        tags: ["Mobile"],
        responses: {
          200: { description: "{ id, revokedAt }" },
          401: { description: "Unauthorized" },
          403: { description: "Not an admin credential" },
          404: { description: "Unknown destination" },
        },
      },
    },
  )
  // -----------------------------------------------------------------------
  // Native: create an upload (idempotency-keyed)
  // -----------------------------------------------------------------------
  .post(
    "/mobile/uploads",
    async ({ request, body, set }) => {
      const principal = principalOf(request);
      if (!isMobileNative(principal)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (!registrationIsLive(principal.hostId)) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      const idempotencyKey = request.headers.get("idempotency-key") ?? "";
      if (
        idempotencyKey.length < 8 ||
        idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
        !/^[A-Za-z0-9._-]+$/.test(idempotencyKey)
      ) {
        set.status = 400;
        return { error: "a valid Idempotency-Key header (8-128 chars) is required" };
      }
      const destinationId = boundedString(body.destinationId, 128);
      const fileName = boundedString(body.fileName, MAX_FILENAME_LENGTH);
      if (destinationId === null || fileName === null) {
        set.status = 400;
        return { error: "destinationId and fileName are required" };
      }
      if (!isSafeSegment(fileName)) {
        set.status = 400;
        return { error: "invalid file name" };
      }
      let sizeBytes: number | null = null;
      if (body.sizeBytes !== undefined && body.sizeBytes !== null) {
        if (
          typeof body.sizeBytes !== "number" ||
          !Number.isSafeInteger(body.sizeBytes) ||
          body.sizeBytes < 0
        ) {
          set.status = 400;
          return { error: "invalid sizeBytes" };
        }
        sizeBytes = body.sizeBytes;
      }
      const declaredSha256 = isHexSha256(body.sha256) ? (body.sha256 as string).toLowerCase() : null;
      if (body.sha256 !== undefined && body.sha256 !== null && declaredSha256 === null) {
        set.status = 400;
        return { error: "invalid sha256 (expected 64 hex chars)" };
      }
      const outcome = createMobileUpload({
        registrationId: principal.hostId,
        destinationId,
        fileName,
        sizeBytes,
        sha256: declaredSha256,
        idempotencyKey,
      });
      switch (outcome.kind) {
        case "ok":
          set.status = 201;
          return { upload: outcome.upload };
        case "destination_not_found":
          set.status = 404;
          return { error: "destination not found" };
        case "destination_revoked":
          set.status = 410;
          return { error: "destination revoked" };
        case "unsafe_file_name":
          set.status = 400;
          return { error: "invalid file name" };
        case "collision":
          set.status = 409;
          return { error: "a file with this name already exists at the destination" };
        case "size_over_cap":
          set.status = 413;
          return { error: "file exceeds the maximum upload size" };
      }
    },
    {
      body: t.Object({
        destinationId: t.String(),
        fileName: t.String(),
        sizeBytes: t.Optional(t.Union([t.Number(), t.Null()])),
        sha256: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: {
        summary:
          "Create a resumable mobile upload (native bearer). Idempotency-Key header: retrying creation with the same key returns the same upload; the final file name is reserved at creation. Never buffers the file.",
        tags: ["Mobile"],
        responses: {
          201: { description: "{ upload }" },
          400: { description: "Invalid body, file name, checksum, or missing Idempotency-Key" },
          401: { description: "Missing/invalid/revoked native token" },
          403: { description: "Not a mobile native credential" },
          404: { description: "Unknown destination" },
          409: { description: "Final name collision" },
          410: { description: "Destination revoked" },
          413: { description: "Declared size over the maximum" },
        },
      },
    },
  )
  // -----------------------------------------------------------------------
  // Native: send one bounded raw chunk at the durable offset
  // -----------------------------------------------------------------------
  .put(
    "/mobile/uploads/:id/chunks",
    async ({ request, params, set }) => {
      const principal = principalOf(request);
      if (!isMobileNative(principal)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (!registrationIsLive(principal.hostId)) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      const offset = parseOffset(request.headers.get("x-upload-offset"));
      if (offset === null) {
        set.status = 400;
        return { error: "a valid X-Upload-Offset header is required" };
      }
      const chunkSize = mobileChunkSizeBytes();
      let data: Uint8Array;
      try {
        data = await readRawBodyBounded(request, chunkSize);
      } catch (err) {
        if (err instanceof ChunkTooLargeError) {
          set.status = 413;
          return { error: `chunk exceeds the ${chunkSize} byte limit` };
        }
        throw err;
      }
      const outcome = appendMobileUploadChunk({
        registrationId: principal.hostId,
        uploadId: params.id,
        offset,
        data,
      });
      return chunkResponse(outcome, set);
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary:
          "Write one bounded raw chunk (native bearer). Body is the raw bytes; X-Upload-Offset must equal the server's durable offset. Wrong offsets fail explicitly; concurrent writes to one upload are serialized.",
        tags: ["Mobile"],
        responses: {
          200: { description: "{ upload } with the new offset" },
          400: { description: "Bad offset header or declared-size exceeded" },
          401: { description: "Missing/invalid/revoked native token" },
          403: { description: "Not the upload owner" },
          404: { description: "Unknown upload" },
          409: { description: "Wrong offset, concurrent write, or upload not accepting chunks" },
          413: { description: "Chunk larger than the negotiated limit" },
          507: { description: "Staging space exhausted" },
        },
      },
    },
  )
  // -----------------------------------------------------------------------
  // Native: durable state query (lost-response recovery) + history
  // -----------------------------------------------------------------------
  .get(
    "/mobile/uploads",
    ({ request, set }) => {
      const principal = principalOf(request);
      if (!isMobileNative(principal)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (!registrationIsLive(principal.hostId)) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      set.headers["cache-control"] = "no-store";
      return { uploads: listUploadsForRegistration(principal.hostId) };
    },
    {
      detail: {
        summary:
          "List the caller's upload history, newest first (native bearer). Includes progress, status, errors and receipts.",
        tags: ["Mobile"],
        responses: {
          200: { description: "{ uploads: MobileUpload[] }" },
          401: { description: "Missing/invalid/revoked native token" },
          403: { description: "Not a mobile native credential" },
        },
      },
    },
  )
  .get(
    "/mobile/uploads/:id",
    ({ request, params, set }) => {
      const principal = principalOf(request);
      if (!isMobileNative(principal)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const row = ownUpload(principal, params.id);
      if (row === null) {
        // Distinguish "unknown" from "someone else's" without leaking
        // existence: 404 for both.
        set.status = findUploadById(params.id) === null ? 404 : 403;
        return { error: set.status === 404 ? "upload not found" : "Forbidden" };
      }
      set.headers["cache-control"] = "no-store";
      return { upload: rowToUpload(row) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary:
          "Read one upload's durable state (native bearer, owner only) — the resume/offset query after a lost response.",
        tags: ["Mobile"],
        responses: {
          200: { description: "{ upload }" },
          401: { description: "Missing/invalid/revoked native token" },
          403: { description: "Not the upload owner" },
          404: { description: "Unknown upload" },
        },
      },
    },
  )
  // -----------------------------------------------------------------------
  // Native: finalize (verify → re-authorize → publish → receipt)
  // -----------------------------------------------------------------------
  .post(
    "/mobile/uploads/:id/finalize",
    ({ request, params, set }) => {
      const principal = principalOf(request);
      if (!isMobileNative(principal)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (!registrationIsLive(principal.hostId)) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      const outcome = finalizeMobileUpload({
        registrationId: principal.hostId,
        uploadId: params.id,
      });
      switch (outcome.kind) {
        case "ok":
          set.status = 200;
          return { receipt: outcome.receipt };
        case "not_found":
          set.status = 404;
          return { error: "upload not found" };
        case "unauthorized":
          set.status = 403;
          return { error: "Forbidden" };
        case "not_complete":
          set.status = 409;
          return { error: "upload is not complete — expected size not yet received" };
        case "checksum_mismatch":
          set.status = 422;
          return { error: "checksum mismatch — received content does not match the declared checksum" };
        case "collision":
          set.status = 409;
          return { error: "filename collision — the reserved final name is already taken" };
        case "destination_revoked":
          set.status = 410;
          return { error: "destination revoked" };
        case "registration_revoked":
          set.status = 401;
          return { error: "registration revoked" };
        case "verification_error":
          set.status = 500;
          return { error: "verification or publication failed" };
        case "stale_state":
          set.status = 409;
          return { error: "upload is in a terminal or incompatible state" };
      }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary:
          "Finalize an upload (native bearer): verifies size + SHA-256, re-checks registration + destination grants, publishes atomically under the reserved name and returns the receipt. Idempotent + crash-window safe.",
        tags: ["Mobile"],
        responses: {
          200: { description: "{ receipt }" },
          401: { description: "Missing/invalid/revoked native token, or registration revoked mid-transfer" },
          403: { description: "Not the upload owner" },
          404: { description: "Unknown upload" },
          409: { description: "Not complete, collision, or terminal state" },
          410: { description: "Destination revoked" },
          422: { description: "Declared checksum mismatch" },
        },
      },
    },
  )
  // -----------------------------------------------------------------------
  // Native: cancel (never touches a published final file)
  // -----------------------------------------------------------------------
  .post(
    "/mobile/uploads/:id/cancel",
    ({ request, params, set }) => {
      const principal = principalOf(request);
      if (!isMobileNative(principal)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (!registrationIsLive(principal.hostId)) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      const outcome = cancelMobileUpload({
        registrationId: principal.hostId,
        uploadId: params.id,
      });
      switch (outcome.kind) {
        case "ok":
          set.status = 200;
          return { upload: outcome.upload };
        case "not_found":
          set.status = 404;
          return { error: "upload not found" };
        case "unauthorized":
          set.status = 403;
          return { error: "Forbidden" };
        case "finalized":
          // A completed upload's final file is the durability point — cancel
          // is a no-op returning the stored receipt state.
          set.status = 200;
          const finalized = findUploadById(params.id)!;
          return { upload: rowToUpload(finalized) };
      }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary:
          "Cancel a non-finalized upload (native bearer, owner only): removes server staging and marks it cancelled. A finalized upload's published file is never touched.",
        tags: ["Mobile"],
        responses: {
          200: { description: "{ upload }" },
          401: { description: "Missing/invalid/revoked native token" },
          403: { description: "Not the upload owner" },
          404: { description: "Unknown upload" },
        },
      },
    },
  );

// ---------------------------------------------------------------------------
// Shared mapping (kept out of the plugin body for readability)
// ---------------------------------------------------------------------------

function chunkResponse(
  outcome: ChunkOutcome,
  set: { status?: number | string },
): Pick<{ upload: MobileUpload }, "upload"> | { error: string } {
  switch (outcome.kind) {
    case "ok":
      return { upload: outcome.upload };
    case "not_found":
      set.status = 404;
      return { error: "upload not found" };
    case "unauthorized":
      set.status = 403;
      return { error: "Forbidden" };
    case "bad_offset":
      set.status = 409;
      return { error: "offset does not match the durable offset — query the upload state first" };
    case "stale_state":
      set.status = 409;
      return { error: "upload is not accepting chunks in its current state" };
    case "too_large":
      set.status = 413;
      return { error: "chunk exceeds the negotiated limit" };
    case "exceeds_declared_size":
      set.status = 400;
      return { error: "chunk would exceed the declared total size" };
    case "staging_full":
      set.status = 507;
      return { error: "upload staging space is exhausted" };
    case "disk_error":
      set.status = 500;
      return { error: "staging write failed" };
  }
}