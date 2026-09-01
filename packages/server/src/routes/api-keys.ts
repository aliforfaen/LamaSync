// LAMA-234: managed API-key lifecycle routes (admin surface).
//
//   GET  /api-keys            list masked metadata (never secrets)
//   POST /api-keys            create an admin key; secret returned once
//   POST /api-keys/:id/reveal explicit admin reveal of the encrypted secret
//   POST /api-keys/:id/revoke soft revoke — future requests return 401
//   GET  /auth/me             current credential identity (any principal)
//
// All routes are admin-only except /auth/me, which any authenticated
// principal may call so the Web UI can label the active credential
// (master / admin / device) and hide admin sections for device keys.
// Secret-bearing responses always send Cache-Control: no-store.
//
// Device keys are blocked at the auth boundary (not allowlisted), so the
// guards here run for master/admin only — but they still check requireAdmin
// as defense in depth and to keep the contract explicit.

import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import { apiKeyRowToSummary, insertManagedApiKey, type ApiKeyRow } from "../api-keys.ts";
import { decryptSecret } from "../crypto.ts";
import { principalOf, requireAdmin } from "../auth.ts";
import type { ApiKeySummary, AuthPrincipal } from "@lamasync/core";

let activeDb: Database = defaultDb;

/** Test seam: point this module's DB at an in-memory DB. */
export function __setDb(next: Database): void {
  activeDb = next;
}

// -- shared helpers --------------------------------------------------------

function adminOnly<T extends { status?: unknown }>(set: T, store: unknown): AuthPrincipal | null {
  const principal = requireAdmin({ principal: principalOf(store) });
  if (!principal) {
    set.status = 403;
    return null;
  }
  return principal;
}

function listRows(): ApiKeyRow[] {
  return activeDb
    .query<ApiKeyRow, []>(
      `SELECT id, name, kind, host_id, token_hash, token_enc, created_at,
              last_used_at, revealed_at, revoked_at, revoked_reason
       FROM api_keys
       ORDER BY created_at DESC`,
    )
    .all();
}

function rowById(id: string): ApiKeyRow | null {
  return activeDb
    .query<ApiKeyRow, [string]>(
      `SELECT id, name, kind, host_id, token_hash, token_enc, created_at,
              last_used_at, revealed_at, revoked_at, revoked_reason
       FROM api_keys WHERE id = ?`,
    )
    .get(id) ?? null;
}

// -- routes ----------------------------------------------------------------

export const apiKeysRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/api-keys",
    ({ store, set }) => {
      if (!adminOnly(set, store)) return;
      return listRows().map(apiKeyRowToSummary);
    },
    {
      detail: {
        summary: "List managed API keys (masked metadata, never secrets)",
        tags: ["API Keys"],
        responses: {
          200: { description: "Managed key metadata list" },
          401: { description: "Unauthorized" },
          403: { description: "Device keys cannot manage keys" },
        },
      },
    },
  )
  .post(
    "/api-keys",
    ({ body, store, set }) => {
      if (!adminOnly(set, store)) return;
      const name = (body.name ?? "").trim();
      if (name.length === 0) {
        set.status = 400;
        return { error: "name is required" };
      }
      if (name.length > 64) {
        set.status = 400;
        return { error: "name must be 64 characters or fewer" };
      }
      // LAMA-301: `deploy` keys are the dedicated, narrowly-scoped
      // credential for the LXC-resident deploy agent. They may only
      // claim/progress/complete server-deploy jobs — never enqueue one.
      const kind = body.kind === "deploy" ? "deploy" : "admin";
      let created;
      try {
        created = insertManagedApiKey({ name, kind, hostId: null });
      } catch (err) {
        set.status = 500;
        return {
          error:
            (err as Error).message?.includes("encryption key")
              ? "encryption key unavailable — set LAMASYNC_SECRET_KEY or make the data directory writable"
              : "failed to create API key",
        };
      }
      set.headers["Cache-Control"] = "no-store";
      return {
        key: apiKeyRowToSummary(created.row),
        secret: created.token,
      };
    },
    {
      body: t.Object({
        name: t.String(),
        kind: t.Optional(t.Union([t.Literal("admin"), t.Literal("deploy")])),
      }),
      detail: {
        summary:
          "Create a managed admin API key (secret returned once). kind=deploy mints the narrowly-scoped deploy-agent credential.",
        tags: ["API Keys"],
        responses: {
          200: { description: "Key created with the raw secret (once)" },
          400: { description: "Invalid name" },
          401: { description: "Unauthorized" },
          403: { description: "Device keys cannot manage keys" },
        },
      },
    },
  )
  .post(
    "/api-keys/:id/reveal",
    ({ params, store, set }) => {
      if (!adminOnly(set, store)) return;
      const row = rowById(params.id);
      if (!row) {
        set.status = 404;
        return { error: "API key not found" };
      }
      // Fail closed: never fall back to the legacy plaintext path, and
      // never surface a partially-recovered secret.
      const secret = decryptSecret(row.token_enc);
      if (secret === null || typeof secret !== "string" || secret.length === 0) {
        set.status = 500;
        return {
          error:
            "decryption_failed — the encrypted secret could not be recovered " +
            "(check LAMASYNC_SECRET_KEY / secret.key); refusing to reveal",
        };
      }
      const revealedAt = Date.now();
      activeDb.run("UPDATE api_keys SET revealed_at = ? WHERE id = ?", [revealedAt, row.id]);
      set.headers["Cache-Control"] = "no-store";
      return {
        id: row.id,
        secret,
        revealedAt,
      };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary: "Explicitly reveal a managed key's secret (audited, no-store)",
        tags: ["API Keys"],
        responses: {
          200: { description: "Raw secret revealed" },
          404: { description: "Not found" },
          401: { description: "Unauthorized" },
          403: { description: "Device keys cannot manage keys" },
          500: { description: "Decryption failed (fail closed)" },
        },
      },
    },
  )
  .post(
    "/api-keys/:id/revoke",
    ({ params, body, store, set }) => {
      if (!adminOnly(set, store)) return;
      const row = rowById(params.id);
      if (!row) {
        set.status = 404;
        return { error: "API key not found" };
      }
      const revokedAt = Date.now();
      activeDb.run(
        "UPDATE api_keys SET revoked_at = ?, revoked_reason = ? WHERE id = ?",
        [revokedAt, (body.reason ?? "").trim().slice(0, 200) || null, row.id],
      );
      return { id: row.id, revokedAt };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        reason: t.Optional(t.String()),
      }),
      detail: {
        summary: "Revoke a managed API key (soft; future requests return 401)",
        tags: ["API Keys"],
        responses: {
          200: { description: "Key revoked" },
          404: { description: "Not found" },
          401: { description: "Unauthorized" },
          403: { description: "Device keys cannot manage keys" },
        },
      },
    },
  )
  .get(
    "/auth/me",
    ({ store }) => {
      const principal = principalOf(store) ?? { kind: "master", keyId: null, hostId: null };
      let name: string | null = null;
      if (principal.kind !== "master" && principal.keyId) {
        const row = rowById(principal.keyId);
        name = row?.name ?? null;
      }
      return {
        kind: principal.kind,
        keyId: principal.keyId,
        hostId: principal.hostId,
        name,
      };
    },
    {
      detail: {
        summary: "Identify the current credential (master/admin/device)",
        tags: ["API Keys"],
        responses: {
          200: { description: "Credential identity" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );